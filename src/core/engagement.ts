/**
 * src/core/engagement.ts — the Adaptive Partner Engine (APE) pure core
 * (adaptive-partner-engine-5.5.md §3–§7).
 *
 * `planEngagement(signals) → EngagementPlan` is the judgment layer: a PURE,
 * total, table-testable function that chooses an ORDERED subset of a closed
 * action set at a bounded depth, over the signals myshell already computes (the
 * `IntentFrame`, `{tier,risk}`, `route.plan`, a `partnerStyle`-derived bias, and
 * memory). It adds NO model call — it rides the intent engine's single gated call
 * (the frame already captures the model's judgment as forks/confidence/kind).
 *
 * The discipline (APE §5 efficiency guardrails):
 *   - EXECUTE_NOW is the default; thoroughness is opt-in per signal-threshold.
 *   - A trivial fast-path returns `[EXECUTE_NOW] depth:0` BEFORE any reasoning —
 *     zero overhead, instant.
 *   - The SAFETY FLOOR (irreversible + ambiguous → always a discuss/ask, even for
 *     a `direct` bias) dominates the bias; the fast-path dominates the bias the
 *     other way (a `collaborative` "what time is it?" stays instant).
 *   - Ask at most once (ASK_CAP = 1); prefer stated assumptions over questions.
 *   - Don't investigate the re-derivable / research the known (SMART boundary).
 *   - Bounded depth ∈ {0,1,2}; depth 2 is rare by construction.
 *
 * PURE: no I/O, no time, no randomness (`test/arch/guards.ts`). Fail-soft: an
 * absent/garbage frame degrades to the fast-path or `[EXECUTE_NOW]`; it never
 * throws and always returns a non-empty `actions[]`.
 */

import type { Classification, Question, QuestionSet } from './types.js';
import type { IntentFrame } from './intent.js';
import type { WorkContract } from './work-contract.js';
import { capContract } from './work-contract.js';

// ---------------------------------------------------------------------------
// Shapes (§3.4)
// ---------------------------------------------------------------------------

export type EngagementAction =
  | 'EXECUTE_NOW'
  | 'REFLECT_VISION'
  | 'ASK_CLARIFYING'
  | 'PLAN_FIRST'
  | 'INVESTIGATE_CONTEXT'
  | 'WEB_RESEARCH'
  | 'DISCUSS_OPTIONS'
  | 'ESCALATE_DEPTH';

export interface EngagementPlan {
  readonly version: 1;
  /** Ordered actions for this turn (always non-empty; EXECUTE_NOW if nothing else). */
  readonly actions: readonly EngagementAction[];
  /** How many forks to voice as ask_user (0 → state all as assumptions). ≤ ASK_CAP. */
  readonly asks: number;
  /** Depth budget: 0 = fast-path, 1 = normal, 2 = deep. */
  readonly depth: 0 | 1 | 2;
  /** Whether route.plan should be honored as PLAN_FIRST this turn. */
  readonly planFirst: boolean;
  /** Whether to lower the escalation bar / admit a panel this turn. */
  readonly escalate: boolean;
  /** Provenance for transparency + tests. */
  readonly source: 'policy' | 'fast-path' | 'fail-soft';
}

export interface EngagementSignals {
  /** From the intent engine; may be absent (skipped/failed). */
  readonly frame?: IntentFrame;
  /** {tier, risk} — always present. */
  readonly classification: Classification;
  /** RouteDecision.plan — the latent hook APE finally consumes. */
  readonly routePlan: boolean;
  /** From partnerStyle: direct=-1, balanced=0, collaborative=+1. */
  readonly engagementBias: -1 | 0 | 1;
  /** Derived from injected memory prefs (optional). */
  readonly memoryBias?: -1 | 0 | 1;
  /** The raw task, for the reversibility/vision lexicons. */
  readonly task: string;
}

/** At most one clarifying question-turn before acting (§5.3 guardrail). */
export const ASK_CAP = 1;

/**
 * Canonical action precedence (§4.1): a senior pro gathers what's knowable, then
 * reflects, then plans, then discusses/asks the residual fork, then executes.
 */
const ACTION_ORDER: readonly EngagementAction[] = [
  'INVESTIGATE_CONTEXT',
  'WEB_RESEARCH',
  'REFLECT_VISION',
  'PLAN_FIRST',
  'DISCUSS_OPTIONS',
  'ASK_CLARIFYING',
  'EXECUTE_NOW',
];

// ---------------------------------------------------------------------------
// Pure heuristics (§3.4) — no model, no I/O
// ---------------------------------------------------------------------------

/**
 * Conservative-broad irreversibility lexicon (§5.6). False-positive = one extra
 * confirm (recoverable); false-negative = acted irreversibly (not) — so we err
 * broad on the irreversible side. Matched as whole words against the task.
 */
const IRREVERSIBLE_LEXICON: readonly RegExp[] = [
  /\bdeploy(ed|ing|ment)?\b/i,
  /\bdelet(e|ed|ing|ion)\b/i,
  /\brm\b|\brm -rf\b/i,
  /\bsend(ing)?\b/i,
  /\bmigrat(e|ed|ing|ion)\b/i,
  /\bpay(ing|ment)?\b|\bcharge\b/i,
  /\bpublish(ed|ing)?\b/i,
  /\bforce[- ]?push\b/i,
  /\bdrop (table|database|db)\b/i,
  /\bproduction\b|\bprod\b/i,
  /\brelease\b/i,
  /\boverwrit(e|ing)\b/i,
  /\btruncat(e|ing)\b/i,
];

/** Vision-phrase lexicon (§3.2) — "as I envisioned", "feel like", etc. */
const VISION_LEXICON: readonly RegExp[] = [
  /\bas I (envisioned|imagined|pictured|want(ed)?)\b/i,
  /\bfeel(s)? like\b/i,
  /\blook and feel\b/i,
  /\bvibe\b|\baesthetic\b/i,
  /\bthe way I (want|imagine|see it)\b/i,
  /\bmy vision\b/i,
];

/** Kinds where reflecting the user's vision is worth a one-line acknowledgement. */
const VISION_KINDS: ReadonlySet<string> = new Set(['writing', 'design', 'product', 'planning']);

export function isIrreversible(task: string): boolean {
  return IRREVERSIBLE_LEXICON.some((re) => re.test(task));
}

export function hasVisionPhrase(task: string): boolean {
  return VISION_LEXICON.some((re) => re.test(task));
}

/** Number of GENUINE forks in the frame (drives ask/discuss). */
export function realForks(s: EngagementSignals): number {
  return s.frame?.forks?.length ?? 0;
}

/** Whether the turn is ambiguous: low/medium confidence OR a real fork exists. */
export function isAmbiguous(s: EngagementSignals): boolean {
  if (realForks(s) > 0) return true;
  const c = s.frame?.confidence;
  return c !== undefined && c !== 'high';
}

/**
 * The trivial fast-path predicate (§5.2): worker tier, no fork, low risk, short,
 * single-clause. The SAME population the intent gate skips — so the two stay
 * consistent. When true, the policy returns instantly with zero overhead.
 */
export function isTrivial(s: EngagementSignals): boolean {
  if (s.classification.tier !== 'worker') return false;
  if (s.classification.risk !== 'low') return false;
  if (s.routePlan) return false;
  if (realForks(s) > 0) return false;
  if (isIrreversible(s.task)) return false;
  const t = s.task.trim();
  if (t.length === 0) return false;
  if (t.length >= 180) return false;
  const clauses = (t.match(/[,;]| and | then |\n/gi) ?? []).length;
  return clauses < 2;
}

/** Scope/horizon score (§3.2) → PLAN_FIRST. route.plan + manager + multi-clause. */
export function scopeScore(s: EngagementSignals): number {
  let score = 0;
  if (s.routePlan) score += 2;
  if (s.classification.tier === 'manager') score += 2;
  if (s.task.trim().length >= 200) score += 1;
  const clauses = (s.task.match(/[,;]| and | then |\n/gi) ?? []).length;
  if (clauses >= 3) score += 1;
  return score;
}

/**
 * SMART knowledge-boundary (§5.5, research #2): a request to investigate the
 * codebase is warranted only when the answer is NOT cheaply re-derivable in the
 * turn anyway. We approximate "needs context" by an explicit inspect/understand
 * signal — never reflexively. Coding/ops work that references existing files.
 */
export function needsContext(s: EngagementSignals): number {
  const t = s.task;
  // Explicit "look at / inspect / understand the existing" signals only.
  const explicit =
    /\b(inspect|investigate|look at|review the existing|understand (the|how)|trace|audit|read the (code|file))\b/i.test(
      t,
    );
  const codeKind = s.frame?.kind === 'coding' || s.frame?.kind === 'ops';
  const referencesExisting = /\b(existing|current|the codebase|this (repo|project|module|file))\b/i.test(t);
  let score = 0;
  if (explicit) score += 2;
  if (codeKind && referencesExisting) score += 2;
  return score;
}

/**
 * INVESTIGATE-BEFORE-INTERROGATE (live-found friction): when the turn is
 * ambiguous about the CODEBASE/TASK details, a partner with code access should
 * investigate first rather than interrogate the user about what the code would
 * answer. This is a BROADER signal than `needsContext` (which gates an explicit
 * inspect request): it fires whenever the turn plausibly concerns code in the
 * working directory — a coding/ops kind, or any reference to an existing
 * file/repo/module/project/page/feature/area. Investigable ambiguity is resolved
 * by looking, NOT by an ASK; only genuine non-investigable forks (vision /
 * preference / external decision) earn a question. PURE.
 */
export function isInvestigable(s: EngagementSignals): boolean {
  if (needsContext(s) > 0) return true;
  // Building something genuinely NEW from scratch is NOT investigable — there is
  // no existing code to read; the decisions are real forks for the user.
  if (/\b(new|from scratch|greenfield|set up (a|the|my)? ?(new )?project|scaffold|bootstrap)\b/i.test(s.task)) {
    return false;
  }
  const codeKind = s.frame?.kind === 'coding' || s.frame?.kind === 'ops';
  // A reference to EXISTING code/area in the working directory: an explicit
  // "existing/current/codebase/this repo" signal, OR a concrete in-place artifact
  // noun (page, feed, component, endpoint, dashboard, …) the workspace already
  // contains. Matched loosely so "the socials page" / "make the feed real" both
  // count as investigable, but a from-scratch build (handled above) does not.
  const referencesExistingArea =
    /\b(existing|current|the codebase|this (repo|project|module|file))\b/i.test(s.task) ||
    /\b(page|feed|feature|component|endpoint|route|screen|dashboard|frontend|backend|the (app|site|website|ui|api|module|file|code))\b/i.test(
      s.task,
    );
  return codeKind || referencesExistingArea;
}

/**
 * Whether a fork is a GENUINE non-investigable fork — one a partner cannot
 * resolve by reading the code, so a question is warranted: the user's vision,
 * priorities, preferences, or a decision external to the codebase. Forks that are
 * about discoverable code details are NOT genuine here (investigate instead).
 * Heuristic over the fork's question text. PURE.
 */
const NON_INVESTIGABLE_FORK_LEXICON: readonly RegExp[] = [
  /\b(prefer|preference|want|would you like|which (do|would) you)\b/i,
  /\b(vision|priorit(y|ies)|goal|audience|tone|style|brand|aesthetic|look and feel)\b/i,
  /\b(budget|deadline|timeline|scope|tradeoff|trade-off)\b/i,
  /\b(should we|do you want|are you ok|is it ok|go ahead|approve)\b/i,
];

/**
 * Generic task-category menus are not genuine forks. They are the exact
 * order-taker failure mode: "are you fixing / adding / polishing / integrating?"
 * A partner should inspect the repo/context and recommend the concrete next step
 * instead of asking the user to classify the work with broad verbs.
 */
const GENERIC_MENU_QUESTION_LEXICON: readonly RegExp[] = [
  /\b(actual )?(blocker|next step|next move)\b/i,
  /\bwhat (are|do) you (trying to )?(do|work on|fix|build)\b/i,
  /\bare you\b/i,
  /\bwhich (task|direction|area|kind|type)\b/i,
];

const GENERIC_MENU_OPTION_LEXICON: readonly RegExp[] = [
  /\bfix(ing)?( something)?( broken)?\b/i,
  /\badd(ing)? (a )?(new )?feature\b/i,
  /\bpolish(ing)? (the )?(layout|ux|ui|design)\b/i,
  /\bintegrat(e|ing) (the )?(backend|api|backend api)\b/i,
  /\bdebug(ging)?\b/i,
  /\brefactor(ing)?\b/i,
];

function isGenericOpenMenuFork(fork: { readonly question: string; readonly options?: readonly string[] }): boolean {
  return isGenericOpenMenuForkText(fork.question, fork.options);
}

/**
 * Generic-open-menu detection over a fork's QUESTION + OPTIONS as plain values
 * (the order-taker "are you fixing / adding / polishing / integrating?" failure
 * mode). Exported so vision-triage can reuse the EXACT same predicate without
 * reaching into engagement internals — one source of truth for "this fork is a
 * generic menu, not a genuine fork". PURE; never throws.
 */
export function isGenericOpenMenuForkText(
  question: string,
  options?: readonly string[],
): boolean {
  const q = typeof question === 'string' ? question : '';
  const questionLooksGeneric = GENERIC_MENU_QUESTION_LEXICON.some((re) => re.test(q));
  const opts = options ?? [];
  const genericOptions = opts.filter((o) => GENERIC_MENU_OPTION_LEXICON.some((re) => re.test(o))).length;
  return questionLooksGeneric && genericOptions >= Math.min(2, opts.length || 2);
}

export function hasGenuineFork(s: EngagementSignals): boolean {
  const forks = s.frame?.forks;
  if (forks === undefined || forks.length === 0) return false;
  // A fork is genuine (worth asking) when its text reads as a vision/preference/
  // external decision — OR when the turn is plainly NOT investigable (no code to
  // look at), so the user is the only source of the answer.
  if (!isInvestigable(s)) return true;
  return forks.some(
    (f) =>
      !isGenericOpenMenuFork(f) &&
      NON_INVESTIGABLE_FORK_LEXICON.some((re) => re.test(f.question)),
  );
}

/**
 * SMART knowledge-boundary for external research (§5.5): web research is
 * warranted only when the answer is plainly NOT knowable from the model's
 * training — an explicit "latest / current / look up / recent" signal. Never
 * research the known.
 */
export function needsExternal(s: EngagementSignals): number {
  const t = s.task;
  const explicit =
    /\b(latest|current|today'?s|recent(ly)?|look up|search (the )?web|up to date|as of (now|today)|news)\b/i.test(
      t,
    );
  const researchKind = s.frame?.kind === 'research';
  let score = 0;
  if (explicit) score += 2;
  if (researchKind && explicit) score += 1;
  // rank-8 (default-OFF): the model's freshness judgment is ADDITIVE. Gated at the
  // SOURCE — orchestrate STRIPS `externalFreshness` from the frame copy it feeds into
  // EngagementSignals when the riskSignals flag is OFF (orchestrate.ts), so on the OFF
  // path `s.frame?.externalFreshness` is always undefined and this branch is DEAD →
  // byte-identical to the pre-rank-8 score. When ON: 'required' adds +2 (enough to
  // reach RESEARCH_T=2 unaided), 'helpful' adds +1 (strictly below the bar, so it can
  // never trigger web research alone — only nudges a borderline turn), 'none'/absent 0.
  const freshness = s.frame?.externalFreshness;
  if (freshness === 'required') score += 2;
  else if (freshness === 'helpful') score += 1;
  return score;
}

/**
 * The per-bias fork budget (§5.4): default 0 asks (prefer stated assumptions);
 * a `collaborative` bias permits up to ASK_CAP. Always clamped to ASK_CAP.
 */
export function forkBudget(engagementBias: -1 | 0 | 1, memoryBias: -1 | 0 | 1): number {
  const lean = engagementBias + memoryBias;
  // direct / balanced lean ≤ 0 → 0 asks (state assumptions); collaborative → 1.
  const raw = lean > 0 ? ASK_CAP : 0;
  return Math.max(0, Math.min(ASK_CAP, raw));
}

// ---------------------------------------------------------------------------
// Thresholds (base bars; bias LOWERS them — §3.4 step 3)
// ---------------------------------------------------------------------------

export const PLAN_T = 2;
const INVEST_T = 2;
const RESEARCH_T = 2;

/** A bias-shifted threshold: bias lowers the bar (`collaborative` reaches sooner). */
function threshold(base: number, engagementBias: -1 | 0 | 1, memoryBias: -1 | 0 | 1): number {
  return base - engagementBias - memoryBias;
}

// ---------------------------------------------------------------------------
// planEngagement — the pure decision (§3.4)
// ---------------------------------------------------------------------------

/**
 * Compute the per-turn {@link EngagementPlan}. PURE, total, never throws, always
 * returns a non-empty `actions[]`. The ordered cascade:
 *
 *   1. FAST-PATH — trivial → `[EXECUTE_NOW] depth:0` (zero overhead, beats bias).
 *   2. SAFETY FLOOR — irreversible + ambiguous → DISCUSS_OPTIONS + ≤1 ask, even
 *      at `direct` bias (the floor dominates the bias).
 *   3. THOROUGHNESS LADDER — each rung opt-in behind its own bias-shifted bar.
 *   4. DEPTH — clamp(1 + scope/stakes bumps − (direct ? 1 : 0), 0, 2).
 *   5. Always end with EXECUTE_NOW unless terminal (asks > 0 ⇒ wait).
 */
export function planEngagement(s: EngagementSignals): EngagementPlan {
  // Defensive: a malformed signal object degrades to fail-soft EXECUTE_NOW.
  if (s === null || typeof s !== 'object' || typeof s.task !== 'string' || s.classification === undefined) {
    return {
      version: 1,
      actions: ['EXECUTE_NOW'],
      asks: 0,
      depth: 1,
      planFirst: false,
      escalate: false,
      source: 'fail-soft',
    };
  }

  const memoryBias: -1 | 0 | 1 = s.memoryBias ?? 0;

  // 1) FAST-PATH — beats the bias both ways.
  if (isTrivial(s)) {
    return {
      version: 1,
      actions: ['EXECUTE_NOW'],
      asks: 0,
      depth: 0,
      planFirst: false,
      escalate: false,
      source: 'fast-path',
    };
  }

  const selected = new Set<EngagementAction>();
  let asks = 0;
  let planFirst = false;
  let escalate = false;

  const highStakes = s.classification.risk === 'high' || s.classification.risk === 'critical';
  const irreversible = isIrreversible(s.task) || highStakes;
  const ambiguous = isAmbiguous(s);

  // 2) SAFETY FLOOR — stakes/reversibility dominate the bias.
  if (irreversible && ambiguous) {
    selected.add('DISCUSS_OPTIONS');
    asks = Math.min(realForks(s), ASK_CAP); // at most one, even here
  }

  // 3) THOROUGHNESS LADDER — each rung opt-in behind its own bias-shifted bar.
  if (scopeScore(s) >= threshold(PLAN_T, s.engagementBias, memoryBias)) {
    planFirst = s.routePlan;
    selected.add('PLAN_FIRST');
  }
  if (needsContext(s) >= threshold(INVEST_T, s.engagementBias, memoryBias)) {
    selected.add('INVESTIGATE_CONTEXT');
  }
  // INVESTIGATE-BEFORE-INTERROGATE: when there is a genuine FORK that the
  // CODEBASE could resolve (an investigable fork), the partner investigates FIRST
  // rather than interrogating the user about a discoverable detail. ACTION_ORDER
  // already places INVESTIGATE_CONTEXT before ASK_CLARIFYING, and the fork block
  // (below) routes such forks here instead of to an ASK — reducing asks, never
  // adding a model call. We trigger only on an actual fork being redirected, so a
  // plain ambiguous turn with no fork keeps its prior silent fast/normal path.
  if (realForks(s) > 0 && isInvestigable(s) && !hasGenuineFork(s) && !irreversible) {
    selected.add('INVESTIGATE_CONTEXT');
  }
  if (needsExternal(s) >= threshold(RESEARCH_T, s.engagementBias, memoryBias)) {
    selected.add('WEB_RESEARCH');
  }
  if (hasVisionPhrase(s.task) || (s.frame?.kind !== undefined && VISION_KINDS.has(s.frame.kind))) {
    selected.add('REFLECT_VISION');
  }

  // Forks → ask the residual (within the safety-floor cap) or state assumptions.
  // INVESTIGATE-BEFORE-INTERROGATE: only a GENUINE non-investigable fork (vision /
  // preference / external decision the code cannot answer) earns a question. A
  // fork about discoverable code details is resolved by INVESTIGATE_CONTEXT +
  // stated assumptions, never by interrogating the user. The safety floor above
  // still governs irreversible+ambiguous turns regardless.
  if (realForks(s) > 0 && hasGenuineFork(s)) {
    const budget = forkBudget(s.engagementBias, memoryBias);
    asks = Math.max(asks, Math.min(budget, ASK_CAP));
    if (asks > 0) selected.add('ASK_CLARIFYING');
    // asks === 0 → state assumptions in the prompt (prefer-assume default); the
    // INTENT block already carries assumeIfUnasked. No action added.
  }
  // An investigable (non-genuine) fork is handled by INVESTIGATE_CONTEXT above —
  // the partner looks instead of asking, and states its assumption in the INTENT
  // block. No ASK is added for it.

  if (highStakes && ambiguous) escalate = true;

  // 4) DEPTH — bounded {0,1,2}. depth 2 only when stakes ∧ scope ∧ ambiguity.
  let depthN = 1;
  const deep = highStakes && scopeScore(s) >= PLAN_T && ambiguous;
  if (deep) depthN = 2;
  if (s.engagementBias === -1 && !irreversible) depthN -= 1;
  const depth: 0 | 1 | 2 = depthN <= 0 ? 0 : depthN >= 2 ? 2 : 1;

  // 5) ALWAYS execute unless the turn is terminal on an ask.
  if (asks === 0) selected.add('EXECUTE_NOW');

  // Order by canonical precedence (§4.1).
  const actions = ACTION_ORDER.filter((a) => selected.has(a));
  const finalActions: readonly EngagementAction[] = actions.length > 0 ? actions : ['EXECUTE_NOW'];

  return {
    version: 1,
    actions: finalActions,
    asks,
    depth,
    planFirst,
    escalate,
    source: 'policy',
  };
}

// ---------------------------------------------------------------------------
// Work-contract seeding (§6.3) — seed objective/vision from the frame; roadmap
// only when planFirst. PURE; reuses capContract (caps/render unchanged).
// ---------------------------------------------------------------------------

/**
 * Seed a {@link WorkContract} from the intent frame + engagement plan (§6.3),
 * replacing the verbatim `capContract({ objective: task })` seed. `objective` ←
 * `frame.goal`; `vision` ← `frame.doneWhen` (or the constraints when there's no
 * doneWhen); a `roadmap` placeholder is seeded ONLY when `plan.planFirst` (so a
 * non-plan turn doesn't fabricate a roadmap). A low-confidence frame still yields
 * a safe, capped contract. Returns `undefined` when there is no usable goal (the
 * caller then falls back to its prior seed). PURE; never throws.
 */
export function seedFromIntentAndPlan(
  frame: IntentFrame | undefined,
  plan: EngagementPlan | undefined,
  fallbackTask: string,
): WorkContract | undefined {
  const goal = frame?.goal?.trim();
  const objective = goal !== undefined && goal.length > 0 ? goal : fallbackTask.trim();
  if (objective.length === 0) return undefined;

  const seed: { -readonly [K in keyof WorkContract]?: WorkContract[K] } = {
    version: 1,
    objective,
  };

  const doneWhen = frame?.doneWhen?.trim();
  if (doneWhen !== undefined && doneWhen.length > 0) {
    seed.vision = doneWhen;
  } else if (frame?.constraints !== undefined && frame.constraints.length > 0) {
    seed.vision = `Respect: ${frame.constraints.join('; ')}`;
  }

  if (plan?.planFirst === true) {
    // A single pending roadmap anchor — the model fills the steps in-turn. We do
    // not fabricate sub-steps; the anchor just signals plan-then-act.
    seed.roadmap = [{ id: 'R1', text: objective, status: 'pending' }];
  }

  return capContract(seed as WorkContract);
}

// ---------------------------------------------------------------------------
// ask_user derivation (§6.2) — turn the frame's forks into a QuestionSet
// ---------------------------------------------------------------------------

/**
 * Derive an ask_user {@link QuestionSet} from the frame's forks, bounded by the
 * plan's `asks` budget (≤ ASK_CAP). Used when planEngagement selects
 * ASK_CLARIFYING, to seed the existing ask_user flow with the SPECIFIC fork. A
 * fork's `id` is reused as the Question id (intent doc §5.4). Returns `null` when
 * there is nothing to ask (asks === 0 or no usable fork). PURE; never throws.
 *
 * NOTE: the model normally emits its own `ask_user` block; this derivation is the
 * structured fallback so a planned fork is never silently dropped. orchestrate
 * only uses it when the model did NOT already ask.
 */
export function deriveAskFromForks(
  frame: IntentFrame | undefined,
  plan: EngagementPlan | undefined,
): QuestionSet | null {
  if (frame === undefined || plan === undefined) return null;
  if (plan.asks <= 0) return null;
  const forks = frame.forks;
  if (forks === undefined || forks.length === 0) return null;

  const budget = Math.min(plan.asks, ASK_CAP, forks.length);
  const questions: Question[] = [];
  for (const fork of forks) {
    if (questions.length >= budget) break;
    if (fork === undefined) continue;
    const promptText = fork.question.trim();
    if (promptText.length === 0) continue;
    // PHASE 1b — REJECT a shallow/generic order-taker menu ("are you fixing /
    // adding / polishing / integrating?"). A generic fork is NOT a senior-grade
    // architectural choice; we skip it and proceed on the stated assumption rather
    // than surface a vacuous question. Same predicate the vision-triage uses — one
    // source of truth for "this fork is a generic menu, not a genuine fork".
    if (isGenericOpenMenuForkText(fork.question, fork.options)) continue;

    // Carry the REAL competing approaches as the selectable options. The extractor
    // already phrases each as "<approach> — <one-line tradeoff>" and orders them
    // best-first (intent.ts solution-space prompt), so option 1 is the recommended
    // default — we tag it so the multiple-choice ask reads as a senior proposal,
    // not a bare list. NO fabrication: every label is the extractor's own text.
    const rawOptions = (fork.options ?? [])
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
      .slice(0, 4);
    const recommended =
      fork.assumeIfUnasked !== undefined && fork.assumeIfUnasked.trim().length > 0
        ? fork.assumeIfUnasked.trim()
        : rawOptions[0];
    const options = rawOptions.map((label, i) => {
      // Mark the recommended approach (matches the stated default, or option 1).
      const isRec =
        recommended !== undefined &&
        (label === recommended || (i === 0 && !rawOptions.includes(recommended)));
      return isRec ? { label, description: 'recommended' } : { label };
    });
    questions.push({
      id: fork.id,
      prompt: promptText,
      options,
      multiSelect: false,
      allowFreeText: true,
    });
  }
  if (questions.length === 0) return null;
  return { questions };
}

// ---------------------------------------------------------------------------
// The ENGAGEMENT block renderer (§6.4) — pre-rendered string for the prompt seam
// ---------------------------------------------------------------------------

/** Human instruction for each visible action, in canonical order. */
const ACTION_INSTRUCTION: Partial<Record<EngagementAction, string>> = {
  INVESTIGATE_CONTEXT:
    'First inspect ONLY the relevant existing files/code you need; then state what you found and recommend the concrete next step.',
  WEB_RESEARCH:
    'Look up the specific current facts you need (only what you genuinely cannot know), then proceed.',
  REFLECT_VISION:
    'Reflect the goal in ONE short line so the user can correct you, then proceed — do not parrot the request.',
  PLAN_FIRST: 'Produce a short plan/roadmap, then act on it — do not over-plan small work.',
  DISCUSS_OPTIONS:
    'Present the 2–4 genuinely-different WAYS to build this — each naming the REAL files/components it would touch (from the repo map; never invent one) plus a one-line tradeoff — and recommend one before an irreversible step. No generic "fix/add/polish" menus.',
  ASK_CLARIFYING:
    'If a genuine fork remains, ask it ONCE as a multiple-choice between the concrete repo-grounded approaches (each with its tradeoff) and mark your recommended default; otherwise state your assumption and proceed.',
};

/**
 * Render the pre-rendered ENGAGEMENT block for the prompt seam
 * (`assembleContextBlocks`). Per the locked APE default (master plan §APE):
 * surfaced ONLY when the plan produces a VISIBLE action (REFLECT_VISION,
 * DISCUSS_OPTIONS, ASK_CLARIFYING, PLAN_FIRST, INVESTIGATE_CONTEXT, WEB_RESEARCH)
 * — the silent mechanics (depth, escalation, a bare EXECUTE_NOW, fast-path)
 * render nothing (''). Ordered by canonical precedence (§4.1). PURE.
 */
export function renderEngagementBlock(plan: EngagementPlan | undefined): string {
  if (plan === undefined) return '';
  if (plan.source === 'fast-path') return '';

  const visible = ACTION_ORDER.filter(
    (a) => a !== 'EXECUTE_NOW' && a !== 'ESCALATE_DEPTH' && plan.actions.includes(a),
  );
  if (visible.length === 0) return '';

  const lines: string[] = [
    'ENGAGEMENT (how to approach this turn — follow in order, stay efficient):',
  ];
  for (const action of visible) {
    const instr = ACTION_INSTRUCTION[action];
    if (instr !== undefined) lines.push(`- ${instr}`);
  }
  return lines.join('\n');
}
