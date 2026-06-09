/**
 * src/core/brain.ts — the Adaptive Confidence Brain pure core
 * (vision-brain §1 + §3, Phase 1: codebase-scrape only).
 *
 * Today the engine does ONE pass: `planEngagement` picks an ordered action list,
 * renders it as advisory prompt text, and hands the whole turn to ONE provider
 * run — it never RE-measures confidence after investigating, and never decides
 * again. This module supplies the two PURE pieces the bounded loop in
 * `orchestrate.ts` needs to turn that one-shot policy into an iterative one:
 *
 *   - `assessConfidence(frame, signals)` → a 3-tuple `{understanding, groundedness,
 *     stakes}` composed ENTIRELY from signals already in scope — `IntentFrame`
 *     confidence/source, the engagement predicates (`isAmbiguous`, `isInvestigable`,
 *     `hasGenuineFork`), and `classification.risk`/`isIrreversible`. NO new model
 *     call, NO fabrication: a skipped/failed extraction yields the honest rules
 *     prior and is treated as "investigate", never "assume high" (vision-brain §1).
 *
 *   - `decideNextMove(conf, signals, plan, state)` → the per-iteration policy that
 *     picks `answer | investigate | reflect_confirm | ask`. The LOOP is the new
 *     part; the per-iteration POLICY reuses `planEngagement` (passed in as `plan`)
 *     and the engagement predicates verbatim (vision-brain §3).
 *
 * PURE: no I/O, no time, no randomness, no model call (`test/arch/guards.ts`).
 * Total + fail-soft: a malformed/absent frame degrades to the fast-path or to
 * "investigate if investigable, else answer"; it never throws.
 *
 * SCOPE (Phase 1): only the `'codebase'` investigation kind is enabled here. The
 * `'web'` and `'brainstorm'` kinds (vision-brain §2b/§2c, Phases 2/3) are NOT
 * emitted — `decideNextMove` never returns them.
 */

import type { QuestionSet } from './types.js';
import type { IntentFrame } from './intent.js';
import type { EngagementPlan, EngagementSignals } from './engagement.js';
import {
  isTrivial,
  isAmbiguous,
  isInvestigable,
  hasGenuineFork,
  isIrreversible,
  realForks,
  scopeScore,
  PLAN_T,
} from './engagement.js';

// ---------------------------------------------------------------------------
// Confidence model (vision-brain §1) — the PURE 3-tuple
// ---------------------------------------------------------------------------

/** Understanding confidence: did we understand the GOAL? (not correctness of work). */
export type Understanding = 'high' | 'medium' | 'low';

/** Have we actually read the relevant code/facts for THIS request yet? */
export type Groundedness = 'unread' | 'grounded';

/** When is low confidence DANGEROUS — high risk / irreversible. */
type Stakes = 'low' | 'high';

/**
 * The brain's per-turn confidence, composed PURE from signals already in scope.
 * `understanding` + `stakes` are read directly from the existing predicates;
 * `groundedness` is the ONE genuinely-new bit of state the loop tracks (it flips
 * to `grounded` after an investigation round runs — see `decideNextMove`).
 */
export interface Confidence {
  readonly understanding: Understanding;
  readonly groundedness: Groundedness;
  readonly stakes: Stakes;
}

/**
 * Compose the confidence 3-tuple. PURE; never throws.
 *
 * understanding:
 *   - The frame's own `confidence`, lowered to at most `medium` whenever the turn
 *     is ambiguous (a real fork, or a non-high confidence) — `isAmbiguous`.
 *   - HONESTY (vision-brain §1, the hard rule): a `skipped`/`rules-fallback` frame
 *     is a tier PRIOR, not a measurement. On a NON-trivial turn we never read it as
 *     `high` — the best it can be is `medium` (so the loop treats unmeasured
 *     understanding as a reason to investigate, never to "assume high"). On a
 *     trivial turn the prior stands (the fast-path short-circuits before any loop).
 *
 * stakes: `high` when risk is high/critical OR the task is irreversible.
 *
 * groundedness: caller supplies the loop's running state (`'unread'` on the first
 * assessment, `'grounded'` after a round). When omitted (a one-shot assess) it
 * defaults to `'unread'`.
 */
export function assessConfidence(
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
  groundedness: Groundedness = 'unread',
): Confidence {
  const stakes: Stakes =
    signals.classification.risk === 'high' ||
    signals.classification.risk === 'critical' ||
    isIrreversible(signals.task)
      ? 'high'
      : 'low';

  // Raw extractor confidence (or the rules prior). Default to 'medium' when a
  // frame is absent — never assume 'high' without a real measurement.
  const raw: Understanding = frame?.confidence ?? 'medium';
  const measured = frame !== undefined && frame.source === 'model';
  const trivial = isTrivial(signals);

  let understanding: Understanding = raw;
  // Ambiguity caps a 'high' raw confidence down to 'medium' — a real fork or a
  // non-high frame means we are not fully sure of the goal.
  if (understanding === 'high' && isAmbiguous(signals)) {
    understanding = 'medium';
  }
  // Honesty floor: an UNMEASURED (skipped/rules-fallback) frame on a non-trivial
  // turn can never read as 'high' — its 'confidence' is a tier prior, not a
  // measurement. The trivial fast-path short-circuits before the loop, so its
  // prior is left intact (it never reaches an investigation decision).
  if (!measured && !trivial && understanding === 'high') {
    understanding = 'medium';
  }

  return { understanding, groundedness, stakes };
}

/**
 * GENUINE ambiguity — the parity-preserving discriminator (vision-brain §1
 * honesty rule). `isAmbiguous` (engagement.ts) treats ANY non-high confidence as
 * ambiguous, INCLUDING the rules tier PRIOR (a skipped/failed extraction is
 * `medium`/`low` by tier, not by measurement). The brain must NOT loop on a bare
 * prior — that would gate every substantial/risky turn. So "genuinely ambiguous"
 * requires a REAL signal: an actual fork in the frame, OR a MODEL-MEASURED non-high
 * confidence. An unmeasured (skipped/rules-fallback) frame with no fork is NOT
 * genuinely ambiguous — the turn proceeds exactly as today. PURE.
 */
export function genuinelyAmbiguous(
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
): boolean {
  if (realForks(signals) > 0) return true;
  if (frame !== undefined && frame.source === 'model' && frame.confidence !== 'high') return true;
  return false;
}

/**
 * The pure "too low to act" predicate (vision-brain §1) — used ONLY for the
 * INVESTIGATE gate. CALIBRATION (the owner's #1 fast-path requirement): a
 * codebase-scrape round must fire ONLY when understanding is genuinely **LOW** —
 * NOT on a model-measured **medium**. A medium-confidence ordinary actionable
 * build turn proceeds exactly as today (prefer-assume + the prompt-level
 * INVESTIGATE_CONTEXT advice), incurring ZERO extra extractor call/latency.
 *
 * So "too low to act" = understanding is `low` AND that low is GENUINE (a real
 * fork or a measured non-high confidence — never a bare tier prior). A `medium`
 * or `high` understanding, or a merely-unmeasured `low` prior, is NOT too low.
 * PURE.
 */
export function confidenceTooLowToAct(
  conf: Confidence,
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
): boolean {
  return conf.understanding === 'low' && genuinelyAmbiguous(frame, signals);
}

/**
 * A SUBSTANTIAL / big-scope build where proposing a plan is genuinely valuable
 * (vision-brain §3 — the reflect_confirm trigger). Reuses the existing scope
 * signals verbatim: `plan.planFirst` (engagement.ts sets it when scope clears the
 * bias-shifted PLAN_T bar AND route.plan is honored) OR a raw `scopeScore` at/over
 * PLAN_T (a multi-clause / manager-tier / large turn). This is the ONLY thing —
 * besides genuine low-understanding ambiguity — that earns a plan proposal; a
 * small, clearly-understood task (even an irreversible one) is NOT substantial and
 * flows straight through. PURE.
 */
function substantialBuild(signals: EngagementSignals, plan: EngagementPlan): boolean {
  return plan.planFirst || scopeScore(signals) >= PLAN_T;
}

// ---------------------------------------------------------------------------
// The adaptive control loop (vision-brain §3) — the PURE per-iteration policy
// ---------------------------------------------------------------------------

/** Phase 1 enables ONLY the codebase scrape; web/brainstorm are Phases 2/3. */
type InvestigationKind = 'codebase';

/** The brain's running loop state (the impure loop in orchestrate owns it). */
export interface BrainLoopState {
  /** Investigation rounds run so far this turn. */
  readonly rounds: number;
  /** Current groundedness — flips to 'grounded' after the first round. */
  readonly groundedness: Groundedness;
  /** True for a `direct` posture: deep-dive rounds are opt-out (mirrors forkBudget). */
  readonly optedOutOfDeepDive: boolean;
  /** Max rounds for this turn (2 default; 3 collaborative — vision-brain §5). */
  readonly maxRounds: number;
}

/**
 * The grounded source a `push_back` was fired from (master-judgment §2.2). Always
 * a REAL, nameable signal — never a vibe. The third source (a judgment-poll SPLIT)
 * is a LATER gated phase; the union leaves a clean extension point for it but this
 * phase emits only the two free sources.
 */
type PushBackSource =
  /** A correctness / irreversibility RED FLAG (reuses the existing stakes signal). */
  | 'red_flag'
  /** A LEARNED-TASTE VIOLATION (the planned default contradicts the taste playbook). */
  | 'taste_violation';
// FUTURE (gated phase): | 'poll_split' — a cross-vendor judgment-poll SPLIT/LEAN
// against the user's stated approach. Add the source + a `reason` builder for it
// when the plural poll ships; the `push_back` move + recording site already accept it.

/**
 * The brain's per-iteration decision. The LOOP picks one of these each round; the
 * impure loop in orchestrate executes it.
 *   - `answer`         — confident enough; run today's single sequential pass.
 *   - `investigate`    — too low + investigable + budget → run a codebase-scrape
 *                        round, narrate it, then RE-ASSESS (vision-brain §3 step 3).
 *   - `reflect_confirm`— investigated but still a judgment call / high stakes:
 *                        reflect a grounded plan and confirm before acting.
 *   - `ask`            — a GENUINE non-investigable fork the code can't settle.
 *   - `push_back`      — the FREE judgment layer (master-judgment §2): a single,
 *                        grounded, falsifiable CHALLENGE with a NAMED cause and a
 *                        concrete recommendation, then it yields to the user. Fires
 *                        ONLY under the narrow grounded-reason gate (§2.2); silence
 *                        is correct when no real reason exists. Flag-gated OFF.
 */
export type BrainMove =
  | { readonly kind: 'answer' }
  | { readonly kind: 'investigate'; readonly tool: InvestigationKind; readonly narration: string }
  | { readonly kind: 'reflect_confirm' }
  | { readonly kind: 'ask'; readonly questions: QuestionSet }
  | {
      readonly kind: 'push_back';
      readonly source: PushBackSource;
      /** The specific, nameable reason surfaced to the user (never vague). */
      readonly reason: string;
      /** The concrete recommendation the partner is making. */
      readonly recommendation: string;
      /** The deterministic challenge QuestionSet (sibling of reflect_confirm). */
      readonly questions: QuestionSet;
    };

/** Default round budgets (vision-brain §5). */
export const MAX_ROUNDS_DEFAULT = 2;
export const MAX_ROUNDS_COLLABORATIVE = 3;

/**
 * Honest, non-fabricated narration for a Phase-1 codebase round (vision-brain §3).
 * HONESTY (the prompt's hard rule): Phase 1 does NOT read new files — it re-checks
 * the goal against the already-in-context static repo-map and re-runs the intent
 * extractor. The narration must reflect EXACTLY that and never imply a file read
 * that didn't happen. (The deeper targeted Read/Grep pass is Phase 2.)
 */
export const CODEBASE_NARRATION = 'Factoring in the project layout…';

// ---------------------------------------------------------------------------
// THE FREE JUDGMENT LAYER (master-judgment §2) — the `push_back` grounded gate
// ---------------------------------------------------------------------------

/**
 * The judgment context the caller threads in so the (otherwise pure) policy can
 * evaluate the `push_back` grounded-reason gate. BACKWARD-COMPATIBLE: every field
 * is optional and the whole argument is optional, so every existing caller/test
 * (which passes nothing) is byte-for-byte unchanged. `enabled` is the flag
 * (`judgmentEnabled`); when false/absent the policy NEVER offers `push_back` and
 * the ask calibration is unchanged — the OFF-GUARANTEE.
 */
export interface JudgmentContext {
  /** The flag (src/core/judgment-flag.ts). DEFAULT false → push_back never fires. */
  readonly enabled: boolean;
  /**
   * The distilled LEARNED-TASTE playbook lines (`<subject>: <the call>` strings,
   * from core/taste.ts `distillTaste`). Used ONLY to detect a taste VIOLATION —
   * the planned default contradicts a recorded high-support call. Absent/empty →
   * the taste-violation source can never fire (no fabricated violation).
   */
  readonly tasteLines?: readonly string[];
}

/** The push_back challenge question id (lets the wiring layer detect + record it). */
const PUSHBACK_ID = 'push_back';
/** Cap on the surfaced push_back prompt (matches REFLECT_PROMPT_CAP below). */
const PUSHBACK_PROMPT_CAP = 700;

/**
 * Detect a LEARNED-TASTE VIOLATION (master-judgment §2.2 source 2 / §4.3.3): the
 * frame's planned default for a genuine fork CONTRADICTS a recorded taste line.
 *
 * GROUNDED + NAMEABLE, never fabricated. A taste line is `"<subject>: <the call>"`
 * (taste.ts render). A violation requires BOTH:
 *   - the playbook records a concrete call the user keeps making, AND
 *   - the frame intends to do the OPPOSITE — i.e. the planned default (a fork's
 *     `assumeIfUnasked`) matches the violated approach while an ALTERNATIVE option
 *     on that same fork matches the user's recorded call.
 * We match on the recorded CALL token appearing in a fork OPTION the partner did
 * NOT pick as the default, while the default differs from it. This is deliberately
 * conservative: if we cannot point at the specific fork + the specific recorded
 * call the default departs from, we return null (silence). Pure; never throws.
 *
 * Returns the {recorded, planned} pair so the caller can name BOTH halves
 * ("you've preferred X here; this would do Y") — a real, checkable reason.
 */
export function detectTasteViolation(
  frame: IntentFrame | undefined,
  tasteLines: readonly string[] | undefined,
): { readonly recorded: string; readonly planned: string } | null {
  try {
    if (frame === undefined) return null;
    const lines = tasteLines ?? [];
    if (lines.length === 0) return null;
    const forks = frame.forks ?? [];
    if (forks.length === 0) return null;

    // The recorded CALLS the user keeps making (the part after "subject: ").
    const recordedCalls = lines
      .map((l) => {
        const i = l.indexOf(':');
        const call = (i >= 0 ? l.slice(i + 1) : l).trim();
        return call;
      })
      .filter((c) => c.length >= 3);
    if (recordedCalls.length === 0) return null;

    for (const fork of forks) {
      const planned = fork.assumeIfUnasked?.trim();
      if (planned === undefined || planned.length === 0) continue;
      const options = (fork.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);

      for (const recorded of recordedCalls) {
        // The default does NOT already honour the recorded call …
        if (overlaps(planned, recorded)) continue;
        // … AND an ALTERNATIVE option on this same fork DOES match it (so the
        // partner had the user's preferred approach available and skipped it).
        const altMatches = options.some((o) => o !== planned && overlaps(o, recorded));
        if (altMatches) {
          return { recorded, planned };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Conservative directional token-overlap: does `text` express the `call`? Pure. */
function overlaps(text: string, call: string): boolean {
  const t = text.toLowerCase();
  const c = call.toLowerCase();
  if (t.includes(c) || c.includes(t)) return true;
  const callToks = new Set(
    c
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
  if (callToks.size === 0) return false;
  const textToks = new Set(
    t
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4),
  );
  let inter = 0;
  for (const w of callToks) if (textToks.has(w)) inter++;
  // Require a MAJORITY of the (content) call tokens to appear — conservative, so a
  // single incidental shared word never trips a fabricated "violation".
  return inter / callToks.size >= 0.5;
}

/**
 * The grounded-reason detector for `push_back` (master-judgment §2.2). PURE, total,
 * never throws. Returns the move payload (source + a NAMED reason + a concrete
 * recommendation + the challenge QuestionSet) ONLY when a real, checkable reason
 * exists; otherwise null (silence is correct — the honesty non-negotiable).
 *
 * It fires only on a SUBSTANTIAL turn and ONLY from a real source, in priority:
 *   1) RED FLAG — the action is irreversible (the existing `isIrreversible`
 *      reversibility signal) AND understanding is NOT high (so there is genuine
 *      uncertainty making the irreversible action risky). A clearly-understood
 *      irreversible task is NOT pushed back on (it flows straight through today and
 *      must keep doing so) — push_back requires the irreversibility to COINCIDE
 *      with an uncertain goal, the real "about to do the hard-to-undo thing without
 *      being sure" case. We name the specific irreversible action + recommend a
 *      reversible/staged check first.
 *   2) TASTE VIOLATION — `detectTasteViolation` found a fork whose planned default
 *      departs from a recorded user call (a real, nameable departure).
 *
 * The recommendation is built from REAL frame/signal content; it never invents a
 * filename or an approach the frame did not carry. When neither source grounds out,
 * returns null and the partner proceeds silently.
 */
function detectPushBack(
  conf: Confidence,
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
  plan: EngagementPlan,
  judgment: JudgmentContext,
): Extract<BrainMove, { kind: 'push_back' }> | null {
  // Narrow gate clause 1: only substantial turns (never on small clear work).
  if (!substantialBuild(signals, plan)) return null;

  // ---- Source 1: correctness / irreversibility RED FLAG ----------------------
  // Reuse the EXISTING reversibility signal (engagement.ts isIrreversible) + the
  // EXISTING understanding tuple — invent NO new detector. Fire ONLY when the
  // hard-to-undo action coincides with a non-high understanding (genuine doubt).
  if (isIrreversible(signals.task) && conf.understanding !== 'high') {
    const action = signals.task.trim();
    const reason = `this looks irreversible / hard to undo, and I'm not fully certain of the goal yet`;
    const recommendation = `do a reversible dry-run / staged check first, then commit`;
    return {
      kind: 'push_back',
      source: 'red_flag',
      reason,
      recommendation,
      questions: buildPushBack(reason, recommendation, action),
    };
  }

  // ---- Source 2: LEARNED-TASTE VIOLATION -------------------------------------
  // ONLY when the flag-on caller supplied playbook lines AND a concrete departure
  // is detectable. Never fabricated: `detectTasteViolation` returns null unless it
  // can point at the specific recorded call the planned default departs from.
  const violation = detectTasteViolation(frame, judgment.tasteLines);
  if (violation !== null) {
    const reason = `you've consistently preferred "${violation.recorded}" here, but this would do "${violation.planned}"`;
    const recommendation = `go with "${violation.recorded}" (your usual call)`;
    return {
      kind: 'push_back',
      source: 'taste_violation',
      reason,
      recommendation,
      questions: buildPushBack(reason, recommendation, frame?.goal?.trim() ?? signals.task),
    };
  }

  return null;
}

/**
 * Build the deterministic `push_back` QuestionSet (sibling of buildReflectConfirm).
 * It surfaces the SPECIFIC reason + the recommendation, then yields to the user as
 * a sharp, one-tap, correctable challenge: `[Do it your way] · [Go with my call] ·
 * [Explain]`, `allowFreeText` so the user can re-ground it. NEVER vague hedging:
 * the prompt always carries the named cause. PURE; never throws.
 *
 * Option order makes the user's ORIGINAL ask the easy default (an override, never a
 * block): "Do it your way" first. The partner's recommendation is the second
 * option. So a push_back that the user ignores costs them one tap to proceed
 * exactly as they asked.
 */
export function buildPushBack(reason: string, recommendation: string, subject: string): QuestionSet {
  const subj = (subject ?? '').trim();
  const head = subj.length > 0 ? `On ${subj}: ` : '';
  const prompt = `${head}before I build — ${reason}. I'd ${recommendation}. Want me to do that, or proceed as you asked?`.slice(
    0,
    PUSHBACK_PROMPT_CAP,
  );
  return {
    questions: [
      {
        id: PUSHBACK_ID,
        prompt,
        options: [
          { label: 'Do it my way' },
          { label: 'Go with your call' },
          { label: 'Explain' },
        ],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  };
}

/**
 * Whether an answered question is the `push_back` challenge (so the wiring layer
 * records pushback_accept/pushback_reject, not a fork_choice). Pure; never throws.
 */
export function isPushBackQuestionSet(qs: QuestionSet | undefined): boolean {
  try {
    return qs?.questions?.[0]?.id === PUSHBACK_ID;
  } catch {
    return false;
  }
}

/**
 * Classify the user's answer to a `push_back` as ACCEPT (they took the partner's
 * recommendation) or REJECT (they stuck with their original ask), for the taste
 * ledger (master-judgment §4.2). Returns 'accept' | 'reject' | null (null = an
 * ambiguous free-text answer we don't record, erring toward not learning a
 * fabricated signal). Pure; never throws.
 *
 * The deterministic options are `Do it my way` (reject) / `Go with your call`
 * (accept) / `Explain` (neither — null). A free-text answer is null (we record only
 * the unambiguous structured calls — the honesty floor).
 */
export function classifyPushBackAnswer(answer: string): 'accept' | 'reject' | null {
  try {
    const a = (answer ?? '').trim().toLowerCase();
    if (a.length === 0) return null;
    if (a === 'go with your call') return 'accept';
    if (a === 'do it my way') return 'reject';
    return null; // 'Explain' or any free-text → not an unambiguous taste signal
  } catch {
    return null;
  }
}

/**
 * The per-iteration policy (vision-brain §3 `decideNextMove`). PURE, total, never
 * throws. Reuses `planEngagement` (passed in as `plan`) and the engagement
 * predicates verbatim — the LOOP (in orchestrate) is the only new control flow.
 *
 * Precedence (mirrors the doc's decision diagram, top-down — RECALIBRATED so the
 * common turn stays fast and the confirm gate never nags):
 *   0) trivial fast-path → answer (never loops — the hard fast-path guard).
 *   1) genuine non-investigable fork → ask (a real judgment call always wins),
 *      but ONLY when the plan actually voiced an ask (asks>0 + a derivable
 *      QuestionSet) — otherwise the assumption is stated and we proceed.
 *   2) genuinely-LOW understanding + investigable + budget left + still unread →
 *      investigate (KEEP GOING — the owner's core ask). Phase 1: codebase only.
 *      NOTE: a model-measured **medium** does NOT reach here — a medium build turn
 *      proceeds straight to `answer`, ZERO extra extractor call/latency.
 *   3) a genuine JUDGMENT CALL worth a plan → reflect_confirm. Fires ONLY when
 *      (understanding === 'low' AND genuinely ambiguous) OR a SUBSTANTIAL/big-scope
 *      build (`substantialBuild`). It does NOT fire merely because a task is
 *      high-stakes/irreversible when it is otherwise clearly understood ("delete
 *      the unused import" → just do it). Small, clearly-understood tasks ALWAYS
 *      flow straight through.
 *   4) otherwise → answer (the common, fast path).
 *
 * The `deriveAsk` thunk lets the caller supply the SAME `deriveAskFromForks`
 * QuestionSet the terminal-ask seam already uses, without this pure module
 * importing the (impure-adjacent) derivation site — keeping the policy testable.
 */
export function decideNextMove(
  conf: Confidence,
  frame: IntentFrame | undefined,
  signals: EngagementSignals,
  plan: EngagementPlan,
  state: BrainLoopState,
  deriveAsk: () => QuestionSet | null,
  // OPTIONAL + default-disabled: the FREE judgment layer context (master-judgment
  // §2). BACKWARD-COMPATIBLE — every existing caller/test passes nothing, so the
  // policy is byte-for-byte unchanged. When `judgment.enabled` is false/absent the
  // new `push_back` arm is NEVER reached (the OFF-GUARANTEE).
  judgment: JudgmentContext = { enabled: false },
): BrainMove {
  // 0) TRIVIAL FAST-PATH — unchanged from today; NEVER loops, NEVER investigates.
  //    This is the hard fast-path guard: a greeting / quick question / trivial
  //    turn short-circuits here with zero extra rounds, latency, or cost. (push_back
  //    is gated on `substantialBuild`, so a trivial/medium turn never reaches it.)
  if (isTrivial(signals)) return { kind: 'answer' };

  // 1) GENUINE NON-INVESTIGABLE FORK always wins — a real judgment call (vision/
  //    preference/external decision the code can't answer). Only reached when the
  //    plan actually budgeted an ask AND a concrete QuestionSet is derivable;
  //    otherwise the engine states the assumption and proceeds (prefer-assume).
  if (hasGenuineFork(signals) && plan.asks > 0) {
    const questions = deriveAsk();
    if (questions !== null) return { kind: 'ask', questions };
  }

  const tooLow = confidenceTooLowToAct(conf, frame, signals);

  // 2) GENUINELY-LOW understanding + INVESTIGABLE + budget left + still unread →
  //    KEEP GOING (the owner's core ask). Phase 1: only the codebase-scrape round.
  //    `confidenceTooLowToAct` is now `understanding === 'low'` (not medium), so an
  //    ordinary medium-confidence build turn NEVER triggers a scrape — it falls
  //    through to step 4 (answer) with zero extra cost. groundedness === 'unread'
  //    prevents a second identical read (after a round it flips to 'grounded').
  if (
    tooLow &&
    conf.groundedness === 'unread' &&
    state.rounds < state.maxRounds &&
    !state.optedOutOfDeepDive &&
    isInvestigable(signals)
  ) {
    return { kind: 'investigate', tool: 'codebase', narration: CODEBASE_NARRATION };
  }

  // 2.5) THE FREE JUDGMENT LAYER — `push_back` (master-judgment §2). ADDITIVE, RARE,
  //      flag-gated OFF. It fires ONLY when the layer is enabled AND there is a
  //      grounded, NAMEABLE reason (a correctness/irreversibility RED FLAG, or a
  //      LEARNED-TASTE VIOLATION) — `detectPushBack` returns null otherwise, so
  //      SILENCE is the default and the existing arms below run UNCHANGED. It sits
  //      AFTER the genuine-fork ask (a real fork the user must answer wins) and AFTER
  //      the investigation budget (we ground first, THEN form a view to push back
  //      with), and it pre-empts the reflect_confirm/answer arms only with a real
  //      cause. When the flag is off OR no reason grounds out, this is a no-op and
  //      `decideNextMove` returns BYTE-FOR-BYTE today's move.
  if (judgment.enabled) {
    const pushBack = detectPushBack(conf, frame, signals, plan, judgment);
    if (pushBack !== null) return pushBack;
  }

  // 3) A genuine JUDGMENT CALL worth a plan → reflect a grounded plan and confirm.
  //    Fires ONLY on (genuinely-LOW understanding) OR a SUBSTANTIAL/big-scope build
  //    THAT WE ACTUALLY MEASURED. It does NOT fire merely because the task is
  //    high-stakes/irreversible when it is otherwise clearly understood — a small
  //    clear "delete the unused import" / "delete the dead /legacy route" just runs
  //    (the prefer-assume default).
  //
  //    HONESTY (vision-brain §1): the substantial arm requires a MODEL-MEASURED
  //    frame. We never propose a plan we never understood — an unmeasured
  //    (skipped/rules-fallback) substantial turn has no real goal to reflect, so it
  //    flows straight through to the provider exactly as today (no fabricated
  //    confirm). The low-understanding arm (`tooLow`) is already measured-gated by
  //    `genuinelyAmbiguous`. Reached when grounded, non-investigable, budget out, or
  //    a measured substantial build worth a plan.
  const frameMeasured = frame !== undefined && frame.source === 'model';
  if (tooLow || (frameMeasured && substantialBuild(signals, plan))) {
    return { kind: 'reflect_confirm' };
  }

  // 4) CONFIDENT ENOUGH / ordinary actionable turn → run today's path. A
  //    medium-confidence build, a clearly-understood irreversible task, and a
  //    high-confidence turn all land here — straight through, no confirm gate.
  return { kind: 'answer' };
}

/**
 * Resolve the per-turn round budget from the partner posture. `collaborative`
 * earns one extra round (3); everyone else gets the default (2). PURE.
 */
export function maxRoundsFor(style: 'direct' | 'balanced' | 'collaborative' | undefined): number {
  return style === 'collaborative' ? MAX_ROUNDS_COLLABORATIVE : MAX_ROUNDS_DEFAULT;
}

// ---------------------------------------------------------------------------
// reflect_confirm proposal (vision-brain §3 / partner-doc §3) — a DETERMINISTIC
// confirm built from the now-grounded frame. ZERO model call, ZERO fabrication:
// every line is the real `IntentFrame.goal`/`doneWhen` the extractor produced.
// ---------------------------------------------------------------------------

const REFLECT_CONFIRM_ID = 'plan_confirm';
const REFLECT_PROMPT_CAP = 700;
const MAX_PLAN_STEPS = 4;

/**
 * PHASE 4 — map the brain's `Confidence` tuple to ONE honest, word-based line
 * (research §4 / Devin's surfaced confidence). NO fabricated number/percentage
 * (the honesty-lint guard forbids them); just an honest phrase derived from the
 * SAME tuple `decideNextMove` already computed. Re-measured after a codebase round
 * (groundedness flips), so the line legitimately rises after investigation.
 *
 * The mapping is deterministic and total:
 *   - low understanding         → "still forming a view — let me confirm the shape first"
 *   - medium, not yet grounded  → "fairly confident I understand this"
 *   - medium, grounded          → "confident I understand this after checking the layout"
 *   - high                      → "confident I understand what you want"
 * High stakes appends an honest caution. PURE; never throws.
 */
export function confidenceLine(conf: Confidence | undefined): string {
  if (conf === undefined) return '';
  let base: string;
  if (conf.understanding === 'low') {
    base = 'Still forming a view — let me confirm the shape before I build';
  } else if (conf.understanding === 'high') {
    base = 'Confident I understand what you want';
  } else if (conf.groundedness === 'grounded') {
    base = 'Confident I understand this after checking the project layout';
  } else {
    base = 'Fairly confident I understand this';
  }
  if (conf.stakes === 'high') {
    base += "; flagging that this is high-stakes, so I'll confirm first";
  }
  return base;
}

/**
 * PHASE 2 — derive a grounded, per-area mini-PLAN (2–4 steps) from the frame +
 * repo-map, for the proactive reflect_confirm proposal (research §5 / Copilot
 * Workspace's per-file plan, Cursor's editable plan). HONESTY (the arch guard's
 * groundedness rule): steps are built ONLY from REAL frame content (constraints,
 * the resolved fork defaults, doneWhen) — never a fabricated filename or step. When
 * the frame carries no plannable substance, returns `[]` and the caller falls back
 * to the simpler honest goal/doneWhen proposal. PURE; never throws.
 *
 * `grounded` toggles the phrasing precision: when a codebase round actually ran
 * (groundedness === 'grounded') the plan may reference the repo areas the extractor
 * named in its fork options; otherwise it stays method-level and generic.
 */
function derivePlanSteps(frame: IntentFrame, grounded: boolean): string[] {
  const steps: string[] = [];

  // 1) The resolved DEFAULT for each genuine fork — "assuming X (say so for Y)".
  //    This is the proactive "I picked a lane" move: we state the chosen approach
  //    rather than ask, and invite a correction. Only forks with a real default
  //    contribute (no fabrication).
  for (const fork of frame.forks ?? []) {
    const def = fork.assumeIfUnasked?.trim();
    if (def !== undefined && def.length > 0) {
      const alt = (fork.options ?? [])
        .map((o) => o.trim())
        .find((o) => o.length > 0 && o !== def);
      steps.push(alt !== undefined ? `Go with ${def} (say so if you'd rather ${alt})` : `Go with ${def}`);
    }
    if (steps.length >= MAX_PLAN_STEPS) break;
  }

  // 2) Honor each hard constraint as an explicit plan step (real, frame-sourced).
  if (steps.length < MAX_PLAN_STEPS) {
    for (const c of frame.constraints ?? []) {
      const ct = c.trim();
      if (ct.length > 0) steps.push(`Respect: ${ct}`);
      if (steps.length >= MAX_PLAN_STEPS) break;
    }
  }

  // 3) Close on the success criterion when one was inferred.
  const doneWhen = frame.doneWhen?.trim();
  if (steps.length < MAX_PLAN_STEPS && doneWhen !== undefined && doneWhen.length > 0) {
    steps.push(`Verify it's done: ${doneWhen}`);
  }

  // The `grounded` flag is reserved for repo-area phrasing; today the frame's own
  // fork options already carry the repo-grounded references (intent.ts grounds them
  // when a map was present), so no extra fabrication is introduced either way.
  void grounded;
  return steps.slice(0, MAX_PLAN_STEPS);
}

/** Options accepted by {@link buildReflectConfirm} — all optional + backward-compatible. */
export interface ReflectConfirmOptions {
  /** The brain's confidence tuple, surfaced as ONE honest line (Phase 4). */
  readonly conf?: Confidence;
  /** Whether a codebase round ran — sharpens the plan's grounded phrasing (Phase 2). */
  readonly grounded?: boolean;
}

/**
 * Build a deterministic, PROACTIVE `reflect_confirm` QuestionSet from the (grounded)
 * frame (Phase 2 + Phase 4). Instead of a hesitant goal-echo, it reads as a senior
 * proposal: an honest confidence line, the goal, a 2–4-step per-area PLAN with the
 * chosen default for each fork, and "Go?" — with `[Go] · [Edit] · [No]` options and
 * `allowFreeText` so an Edit carries the user's correction (the editable-artifact
 * seam). It NEVER fabricates a plan it didn't derive: when the frame has no plannable
 * substance it falls back to the simpler honest goal/doneWhen proposal. Returns
 * `null` when there is no usable goal to reflect (the caller then falls through to
 * `answer`). PURE; never throws.
 *
 * Backward-compatible: callers passing only the frame get the proactive proposal
 * without a confidence line (the existing brain.test fixtures).
 */
export function buildReflectConfirm(
  frame: IntentFrame | undefined,
  opts: ReflectConfirmOptions = {},
): QuestionSet | null {
  const goal = frame?.goal?.trim();
  if (frame === undefined || goal === undefined || goal.length === 0) return null;

  const lines: string[] = [];

  // PHASE 4 — surface the honest confidence line first, when supplied.
  const confLine = confidenceLine(opts.conf);
  if (confLine.length > 0) lines.push(`${confLine}.`);

  // PHASE 2 — a grounded mini-plan when the frame has plannable substance, phrased
  // proactively ("I'm aligned — here's my plan: 1) … 2) …. Go?"). Otherwise the
  // honest simpler proposal (goal + doneWhen).
  const steps = derivePlanSteps(frame, opts.grounded === true);
  if (steps.length > 0) {
    lines.push(`I'm aligned on ${goal}. Here's my plan:`);
    steps.forEach((step, i) => lines.push(`${i + 1}) ${step}.`));
    lines.push('Go?');
  } else {
    lines.push(`Here's what I understand you want: ${goal}.`);
    const doneWhen = frame.doneWhen?.trim();
    if (doneWhen !== undefined && doneWhen.length > 0) {
      lines.push(`I'll treat it as done when: ${doneWhen}.`);
    }
    lines.push('Want me to go ahead?');
  }
  const prompt = lines.join(' ').slice(0, REFLECT_PROMPT_CAP);

  return {
    questions: [
      {
        id: REFLECT_CONFIRM_ID,
        prompt,
        options: [{ label: 'Go' }, { label: 'Edit' }, { label: 'No' }],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  };
}

/**
 * Whether a codebase round actually EARNED its keep (vision-brain §5 stop
 * condition): a round must RAISE understanding or flip an investigable gap to
 * grounded, or the loop stops. We compare the pre-round and post-round
 * understanding; `grounded` itself is the floor (the loop never re-reads the same
 * code because groundedness flips). Returns true when understanding strictly
 * improved (low→medium/high or medium→high). PURE.
 */
export function understandingImproved(before: Understanding, after: Understanding): boolean {
  const rank: Record<Understanding, number> = { low: 0, medium: 1, high: 2 };
  return rank[after] > rank[before];
}
