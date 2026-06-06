/**
 * src/core/turn-directive.ts — the Adaptive Partner Engine v2 control plane
 * (adaptive-partner-v2-5.6.md §2.1, §2.2 A1/A2, §3). STAGE 1 ONLY.
 *
 * The v1 `EngagementPlan` (engagement.ts) is advisory: it is rendered as prompt
 * TEXT (`renderEngagementBlock`) the model may ignore, and stale resumed history
 * can few-shot the old generic "are you fixing / adding / polishing /
 * integrating?" order-taker menu back into the answer. This module promotes the
 * plan from advice to an ENFORCED, orchestrator-owned contract by compiling a
 * minimal {@link TurnDirective} that `orchestrate` consumes BEFORE the provider
 * run (a zero-token terminal ask) and AFTER it (a generic-menu output validator
 * with a one-retry repair).
 *
 * STAGE 1 SCOPE (the keystone): only three directive fields are populated —
 *   - `terminalQuestion` (the pre-provider `ask_user`, A1),
 *   - `outputValidators` (just `reject_generic_open_menu`, A2),
 *   - `historyPolicy` (quarantine prior generic-menu assistant prose, §3).
 * The later-stage fields (requiredBeforeAnswer / workState / escalationBudget /
 * vision triage) are deliberately NOT built here.
 *
 * PURE: no I/O, no time, no randomness (`test/arch/guards.ts`). `compileTurnDirective`
 * is a pure consumer of an already-computed `EngagementPlan` + `IntentFrame` — it
 * adds NO model call. Fail-soft: malformed inputs degrade to a normal directive
 * with no terminal ask, never throw.
 */

import type { QuestionSet } from './types.js';
import type { IntentFrame } from './intent.js';
import type { EngagementPlan, EngagementSignals } from './engagement.js';
import { deriveAskFromForks, hasGenuineFork } from './engagement.js';

// ---------------------------------------------------------------------------
// Shapes (§2.1) — STAGE 1 minimal subset
// ---------------------------------------------------------------------------

/** Stage-1 output validators. Only the generic-open-menu rejector is built now. */
export type OutputValidator = { readonly kind: 'reject_generic_open_menu' };

/** History replay disposition for the NEXT turn (§3). */
export interface HistoryPolicy {
  readonly replayMode: 'normal' | 'summarize_only' | 'quarantine_assistant_prose';
  readonly reasons: readonly string[];
}

/**
 * The orchestrator-owned, compiled per-turn contract (§2.1). STAGE 1 carries only
 * the three enforced fields plus the small amount of context the validator needs
 * to fire correctly (whether a repo is present / INVESTIGATE_CONTEXT was planned —
 * so normal brainstorming is never over-blocked).
 */
export interface TurnDirective {
  readonly version: 1;
  /**
   * When set, `orchestrate` emits this structured ask BEFORE any provider run and
   * returns (zero provider attempts, zero tokens). The model never gets a chance
   * to ignore a planned terminal ask. Sourced from `deriveAskFromForks` so the
   * existing `QuestionSet` UI renders unchanged.
   */
  readonly terminalQuestion?: QuestionSet;
  /** Validators applied to the model's FINAL prose after a provider run. */
  readonly outputValidators: readonly OutputValidator[];
  /** How the NEXT turn should treat prior history (quarantine of poisoned prose). */
  readonly historyPolicy: HistoryPolicy;
  /**
   * True when the engagement plan included INVESTIGATE_CONTEXT or the environment
   * indicates a repo is present. The `reject_generic_open_menu` validator fires
   * ONLY when this is true, so plain brainstorming / option-listing on a non-repo
   * turn is never blocked (§2.2 A2 guard).
   */
  readonly repoOriented: boolean;
}

/** Inputs to {@link compileTurnDirective}. PURE — no model call, no I/O. */
export interface CompileDirectiveInput {
  readonly frame: IntentFrame | undefined;
  readonly plan: EngagementPlan;
  readonly signals: EngagementSignals;
  /**
   * True when the deterministic ENVIRONMENT/repo-map block indicates a repo is
   * present in cwd (deps.environmentContext was rendered). Used only to widen the
   * generic-menu validator's firing condition; absent → treated as no repo.
   */
  readonly repoPresent?: boolean;
  /**
   * Prior conversation assistant entries, oldest-first, for the history-policy
   * decision. Each is `{ role, content }`; only assistant prose is inspected.
   */
  readonly priorAssistantTexts?: readonly string[];
}

// ---------------------------------------------------------------------------
// Generic-open-menu detection over FINAL PROSE (§2.2 A2)
// ---------------------------------------------------------------------------

/**
 * The generic task-category question lexicon — the order-taker opener. Mirrors the
 * spirit of engagement.ts `GENERIC_MENU_QUESTION_LEXICON` but tuned for prose
 * (full sentences a model writes), not a fork's short `question` field.
 */
const GENERIC_PROSE_QUESTION_LEXICON: readonly RegExp[] = [
  /\bwhat (are|do) you (trying to |want to )?(do|work on|build|fix|tackle|achieve)\b/i,
  /\bwhich (task|direction|area|kind|type|option|approach) (would|do) you\b/i,
  /\bwhich (of these|one)\b.*\?/i,
  /\bwhich (kind|type|sort) of (task|work|change)\b/i,
  /\b(what|which) kind of task is this\b/i,
  /\bare you (trying to |looking to )?(fix|add|polish|integrat|debug|refactor|build)/i,
  /\bwhat (kind|type|sort) of (task|work|change)\b/i,
  /\bwhat would you like (me )?to (do|focus on|work on|tackle|start with)\b/i,
  /\bwhere (would|do) you (want|like) (me )?to (start|begin)\b/i,
];

/**
 * The broad task-category verbs. ≥2 distinct categories paired with a generic
 * question is the exact failure mode (fix / add / polish / integrate / debug /
 * refactor). Matched against the whole prose, not a single option string.
 */
const GENERIC_CATEGORY_LEXICON: readonly RegExp[] = [
  /\bfix(ing)?\b/i,
  /\badd(ing)?\b/i,
  /\bpolish(ing)?\b/i,
  /\bintegrat(e|ing|ion)\b/i,
  /\bdebug(ging)?\b/i,
  /\brefactor(ing)?\b/i,
  /\bbuild(ing)?\b/i,
  /\bimprov(e|ing|ement)\b/i,
];

/**
 * Detect a generic task-category menu in final prose. PURE; never throws.
 *
 * Fires when the text contains a generic "what/which task are you trying to do"
 * style question AND lists ≥2 distinct broad task-category verbs as the options.
 * This is intentionally narrow: it targets the order-taker menu, not a normal
 * answer that happens to mention "fix" or "add" once, and not a grounded
 * recommendation. A question mark must be present (it is a MENU, an ask).
 */
export function detectGenericOpenMenu(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (!text.includes('?')) return false;

  const asksGeneric = GENERIC_PROSE_QUESTION_LEXICON.some((re) => re.test(text));
  if (!asksGeneric) return false;

  // Count DISTINCT broad categories mentioned. ≥2 = a menu, not a single verb.
  let categories = 0;
  for (const re of GENERIC_CATEGORY_LEXICON) {
    if (re.test(text)) categories++;
    if (categories >= 2) break;
  }
  return categories >= 2;
}

// ---------------------------------------------------------------------------
// Output validation (§2.2 A2)
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  readonly kind: 'generic_open_menu' | 'ungrounded_recommendation' | 'missing_required_question';
  readonly severity: 'repair' | 'retry' | 'fail';
  readonly reason: string;
}

/**
 * Validate the model's final prose against the directive's output validators.
 * Returns the FIRST failure, or `null` when the prose passes. PURE; never throws.
 *
 * STAGE 1 implements ONLY `reject_generic_open_menu`: it fires when the prose is a
 * generic task-category menu AND the directive is `repoOriented` (a repo is
 * present or INVESTIGATE_CONTEXT was planned) — so normal brainstorming / legit
 * option lists on a non-repo turn are NOT blocked.
 */
export function validateTurnOutput(
  text: string,
  directive: TurnDirective,
): ValidationFailure | null {
  if (directive === null || typeof directive !== 'object') return null;
  for (const validator of directive.outputValidators) {
    if (validator.kind === 'reject_generic_open_menu') {
      if (!directive.repoOriented) continue;
      if (detectGenericOpenMenu(text)) {
        return {
          kind: 'generic_open_menu',
          severity: 'repair',
          reason:
            'The answer is a generic task-category menu (fix/add/polish/integrate). ' +
            'A repo is present or investigation was planned — orient and recommend instead of interrogating.',
        };
      }
    }
  }
  return null;
}

/**
 * The manager-style repair feedback appended to the ONE retry when the generic-
 * menu validator fires (§2.2 A2). Plain text injected as `managerNotes` so it
 * rides the existing attempt loop and provider machinery — NOT a second always-on
 * call. Exported so orchestrate and tests share one string.
 */
export const GENERIC_MENU_REPAIR_NOTE =
  'The previous answer asked a generic task-category menu (e.g. "are you fixing, ' +
  'adding, polishing, or integrating?"). Do not ask that. Use the ENVIRONMENT block ' +
  'and the task to orient, state what you can verify, and recommend the concrete next ' +
  'step. If the referenced project is not in the current working directory, say so ' +
  'explicitly and ask for the repo path.';

// ---------------------------------------------------------------------------
// History policy (§3) — quarantine prior generic-menu assistant prose
// ---------------------------------------------------------------------------

/**
 * Decide the history replay policy for the NEXT turn. PURE; never throws.
 *
 * STAGE 1: when any prior ASSISTANT turn is itself a generic open menu, switch to
 * `quarantine_assistant_prose` so that poisoned prose does not few-shot the new
 * turn back into the order-taker behavior. Otherwise `normal`. User entries are
 * never affected by this signal.
 */
export function decideHistoryPolicy(
  priorAssistantTexts: readonly string[] | undefined,
): HistoryPolicy {
  if (!Array.isArray(priorAssistantTexts) || priorAssistantTexts.length === 0) {
    return { replayMode: 'normal', reasons: [] };
  }
  const poisoned = priorAssistantTexts.some(
    (t) => typeof t === 'string' && detectGenericOpenMenu(t),
  );
  if (poisoned) {
    return {
      replayMode: 'quarantine_assistant_prose',
      reasons: ['prior assistant turn contained a generic open menu'],
    };
  }
  return { replayMode: 'normal', reasons: [] };
}

// ---------------------------------------------------------------------------
// compileTurnDirective (§2.1) — the pure compiler
// ---------------------------------------------------------------------------

/**
 * Compile a STAGE-1 {@link TurnDirective} from an already-computed
 * {@link EngagementPlan} + {@link IntentFrame} + signals. PURE; adds NO model
 * call (rides the one gated intent pass). Fail-soft: malformed inputs yield a
 * normal directive with no terminal ask.
 *
 * `terminalQuestion` is set ONLY when ALL hold (§2.2 A1 guardrails):
 *   - `plan.actions` includes `ASK_CLARIFYING` (planEngagement chose to ask),
 *   - `plan.asks > 0` (the fork budget allows a question),
 *   - `hasGenuineFork(signals)` is true (a real non-investigable fork exists),
 *   - the fork is NOT an investigable generic fork (`isInvestigable` → investigate,
 *     never interrogate), and
 *   - `deriveAskFromForks(frame, plan)` returns a non-null QuestionSet.
 * ASK_CAP=1 is honored transitively via `deriveAskFromForks`.
 */
export function compileTurnDirective(input: CompileDirectiveInput): TurnDirective {
  const { frame, plan, signals } = input;

  const repoOriented =
    input.repoPresent === true ||
    (plan !== undefined && Array.isArray(plan.actions) && plan.actions.includes('INVESTIGATE_CONTEXT'));

  const outputValidators: readonly OutputValidator[] = [{ kind: 'reject_generic_open_menu' }];
  const historyPolicy = decideHistoryPolicy(input.priorAssistantTexts);

  // Fail-soft base directive (no terminal ask).
  const base: TurnDirective = {
    version: 1,
    outputValidators,
    historyPolicy,
    repoOriented,
  };

  if (plan === undefined || plan === null || !Array.isArray(plan.actions)) {
    return base;
  }

  const wantsAsk = plan.actions.includes('ASK_CLARIFYING') && plan.asks > 0;
  if (!wantsAsk) return base;

  // Only a GENUINE, non-investigable fork earns a pre-provider terminal ask. An
  // investigable ambiguity must be resolved by looking at the code, not by
  // interrogating the user — route those to investigation (no terminal ask).
  // hasGenuineFork already filters out investigable generic-menu forks: an
  // investigable ambiguity (e.g. a fix/add/polish menu the codebase could resolve)
  // returns false here, so it is routed to investigation, not a terminal ask. Only
  // a real vision/preference/external-decision fork reaches the ask below.
  if (!hasGenuineFork(signals)) return base;

  const terminalQuestion = deriveAskFromForks(frame, plan);
  if (terminalQuestion === null) return base;

  return { ...base, terminalQuestion };
}
