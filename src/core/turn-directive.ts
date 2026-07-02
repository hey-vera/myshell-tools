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
import { deriveAskFromForks, hasGenuineFork, isTrivial } from './engagement.js';
import type { WorkStateSnapshot } from './work-state.js';
import type { EvidenceNeed, SemanticTaskKind } from './semantic-preflight.js';
import type { EvidenceReceiptV1 } from './evidence-investigation.js';
import { isLegacyEngineEntry } from './engine-version.js';
import {
  triageVision,
  hasMigrationConcern,
  hasInvestigateConcern,
  firstDiscussFork,
  type VisionTriageItem,
} from './vision-triage.js';

// ---------------------------------------------------------------------------
// Shapes (§2.1) — STAGE 1 minimal subset
// ---------------------------------------------------------------------------

/**
 * Output validators applied to the model's FINAL prose (§2.2 A2, §2.6 E).
 *   - `reject_generic_open_menu`        — STAGE 1: the order-taker fix/add/polish/
 *                                         integrate menu (fires only when repoOriented).
 *   - `require_grounded_recommendation` — STAGE 5 (AP2-E, §2.6 E): on a SUBSTANTIAL
 *                                         decision/recommendation-shaped turn the
 *                                         answer must include a recommendation OR a
 *                                         clear next step, grounded in at least one
 *                                         {@link RecommendationGrounding}. Fires only
 *                                         when the directive is `substantial`; tiny
 *                                         factual/lookup turns are EXEMPT.
 */
type OutputValidator =
  | { readonly kind: 'reject_generic_open_menu' }
  | { readonly kind: 'require_grounded_recommendation' }
  | { readonly kind: 'require_observed_grounding' };

/**
 * The kinds of grounding that make a recommendation honest (§2.6 E). A substantial
 * turn's recommendation must be backed by at LEAST one of these — a referenced file
 * path/symbol, a repo/environment fact, an explicit stated assumption, an external
 * source, or an honest "I cannot see the requested repo / not enough context". This
 * is the NOTION; {@link detectGrounding} maps prose onto it. We never FABRICATE a
 * grounding — detection is over what the model actually wrote.
 */
export type RecommendationGrounding =
  | { readonly kind: 'file_evidence'; readonly paths: readonly string[] }
  | { readonly kind: 'repo_orientation'; readonly facts: readonly string[] }
  | { readonly kind: 'stated_assumption'; readonly assumptions: readonly string[] }
  | { readonly kind: 'external_source'; readonly sources: readonly string[] }
  | { readonly kind: 'not_enough_context'; readonly missing: string };

/**
 * A preliminary action the orchestrator REQUIRES before (or carries into) the
 * answer (doc §2.1). STAGE 3 populates only `vision_triage` (the other variants —
 * orient_repo / investigate_context / web_research / plan_first — are reserved for
 * later stages and not built here). The `vision_triage` action carries the
 * decomposed {@link VisionTriageItem}s plus the pre-computed routing facts derived
 * from them, so `orchestrate` can route per disposition without re-deriving:
 *   - `migrationNeedsArchitectureTier`: a MIGRATE_REARCHITECT item is present →
 *     the turn should run at LEAST IC (often manager when scope/risk warrants),
 *     ALWAYS via the existing `authorizeTier` gate (never a bypass). The flag is a
 *     REQUEST; whether manager actually opens is decided by `authorizeTier` /
 *     `admitManager` in orchestrate, bounded by free-plan / never-auto policy.
 *   - `requiresInvestigation`: an INVESTIGATE_THEN_PROPOSE item is present → the
 *     answer must return findings + a proposed plan, not a generic question.
 */
type RequiredPreAnswerAction = {
  readonly kind: 'vision_triage';
  readonly items: readonly VisionTriageItem[];
  readonly migrationNeedsArchitectureTier: boolean;
  readonly requiresInvestigation: boolean;
};

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
  /**
   * Preliminary actions the orchestrator requires before/at the answer (doc §2.1).
   * STAGE 3 carries the `vision_triage` action when the vision decomposes into ≥1
   * meaningful part (a non-trivial multi-part vision, a migration concern, an
   * investigate-first part, or a genuine fork). Empty on a plain single-claim turn
   * so nothing is rendered and behaviour is unchanged.
   */
  readonly requiredBeforeAnswer: readonly RequiredPreAnswerAction[];
  /** Validators applied to the model's FINAL prose after a provider run. */
  readonly outputValidators: readonly OutputValidator[];
  /** How the NEXT turn should treat prior history (quarantine of poisoned prose). */
  readonly historyPolicy: HistoryPolicy;
  /**
   * Truthful work-state for this turn (AP2-B §2.3 B): objective + evidence-backed
   * done + model-stated next + blocked, derived from accepted prior turns'
   * `workTrace`. Present only when a resumed/continuing chat has a trusted trace;
   * absent otherwise (truthful or absent). The directive carries it so a resumed
   * chat KNOWS what was last done + the next honest step — the model never re-asks
   * "what are we doing?" or repeats completed work.
   */
  readonly workState?: WorkStateSnapshot;
  /**
   * True when the engagement plan included INVESTIGATE_CONTEXT or the environment
   * indicates a repo is present. The `reject_generic_open_menu` validator fires
   * ONLY when this is true, so plain brainstorming / option-listing on a non-repo
   * turn is never blocked (§2.2 A2 guard).
   */
  readonly repoOriented: boolean;
  /**
   * STAGE 5 (AP2-E, §2.6 E) — true when this is a SUBSTANTIAL,
   * decision/recommendation-shaped turn (NOT a tiny factual/lookup turn). The
   * `require_grounded_recommendation` validator fires ONLY when this is true, so a
   * latency-sensitive trivial turn ("what is 2+2", "how many files") is never
   * gated. See {@link decideSubstantial} for the heuristic.
   */
  readonly substantial: boolean;
  /**
   * Audit rank 9 — the ENFORCED investigation directive. Set only when the
   * required-investigation flag is ON; omitted otherwise (byte-identical OFF path).
   * `'local'` means a bounded read-only retrieval must run before execution when the
   * confidence brain did not already ground the turn; `'web'` is reserved for a later
   * slice; `'none'` means no enforced retrieval this turn.
   */
  readonly requiredInvestigation?: 'local' | 'web' | 'none';
  readonly evidenceObligations?: readonly EvidenceNeed[];
  readonly evidenceReceipts?: readonly EvidenceReceiptV1[];
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
   * decision (Stage 1, text axis only). Each is the assistant prose string; only
   * assistant prose is inspected. Superseded by {@link priorAssistant} when the
   * caller has the engine-version marker (Stage 6); kept for backward compatibility.
   */
  readonly priorAssistantTexts?: readonly string[];
  /**
   * Prior conversation assistant entries WITH their persisted engine-behavior
   * version marker (AP2-F / Stage 6), oldest-first. When present this is used for
   * the history-policy decision instead of {@link priorAssistantTexts}, so the
   * quarantine can fire on the VERSION axis (pre-fix prose) as well as the text
   * axis (an obvious menu). undefined → fall back to the text-only form.
   */
  readonly priorAssistant?: readonly PriorAssistantTurn[];
  /**
   * Truthful work-state derived from accepted prior turns' `workTrace` (AP2-B
   * §2.3 B). Threaded onto the compiled directive unchanged so the turn knows
   * what was last done + the next honest step. undefined → no work-state.
   */
  readonly workState?: WorkStateSnapshot;
  /**
   * STAGE 3 (doc §2.4 C) — the existing `authorizeTier` gate, injected as a pure
   * predicate the compiler may consult to decide whether a MIGRATE_REARCHITECT
   * concern can be ROUTED at the manager tier. The compiler NEVER opens manager
   * itself; it only records `migrationNeedsArchitectureTier` (≥ IC always; manager
   * only when this predicate returns true). When absent, the compiler still
   * records the architecture-note request but does NOT claim manager — orchestrate's
   * own `admitManager`/`authorizeTier` remains the sole authority that opens
   * manager, bounded by free-plan / never-auto policy. This keeps the gate
   * un-bypassable: the flag is a REQUEST, the policy gate is the DECISION.
   */
  readonly canAuthorizeManagerForMigration?: () => boolean;
  /**
   * Audit rank 9 — when TRUE the compiler derives and sets `requiredInvestigation`
   * on the directive. When absent/false the field is OMITTED so the OFF path is
   * byte-identical to today.
   */
  readonly requiredInvestigationEnabled?: boolean;
  readonly evidenceObligations?: readonly EvidenceNeed[];
  readonly evidenceReceipts?: readonly EvidenceReceiptV1[];
  readonly semanticTaskKind?: SemanticTaskKind;
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
// Grounded-recommendation detection over FINAL PROSE (§2.6 E, AP2-E)
// ---------------------------------------------------------------------------

/**
 * "Substantial" decision/recommendation-shaped signal lexicon over the TASK text.
 * A turn is substantial when the user is asking for a judgment, a comparison, a
 * decision, a plan, an evaluation, or a "should we X or Y" fork — the class of turn
 * where a bare options list / waffle is the failure mode. NOT a tiny factual lookup.
 */
const DECISION_TASK_LEXICON: readonly RegExp[] = [
  /\bshould (we|i|it|you)\b/i,
  /\b(which|what) (is|would be|'s)? ?(the )?(best|better|right|preferred|recommended)\b/i,
  /\b\w[\w\s./+-]{0,40}\bor\b[\w\s./+-]{0,40}\?/i, // "X or Y?" forks
  /\b(recommend|recommendation|advise|advice|opinion|propose|proposal|suggest)\b/i,
  /\b(decide|decision|choose|pick|evaluate|assess|compare|trade-?offs?|pros and cons)\b/i,
  /\b(plan|strategy|approach|architecture|design)\b.*\b(for|to|of)\b/i,
  /\b(move|migrate|port|rewrite|switch|rearchitect)\b/i,
  /\bworth (it|doing|the)\b/i,
];

/**
 * A recommendation / clear next-step signal — what the model SHOULD produce on a
 * substantial turn. Either an explicit recommendation verb or a stated next step.
 */
const RECOMMENDATION_LEXICON: readonly RegExp[] = [
  /\bi (recommend|suggest|advise|propose|would (recommend|suggest|go with|keep|pick|choose|start))\b/i,
  /\b(my recommendation|my advice|my suggestion|recommended (approach|option|path|default)|the recommendation is)\b/i,
  /\b(go with|stick with|stay (on|with|in)|keep (it|this)|move to|switch to|don't|do not) /i,
  /\b(the (best|right|default) (option|choice|path|approach|answer) is)\b/i,
  /\b(next step|the next step|i'd start|start (by|with)|first,? )\b/i,
  /\b(default to|lean toward|leaning toward|the call is|bottom line)\b/i,
];

/**
 * A bare options-list / waffle: an enumeration of choices with NO recommendation.
 * Two distinct shapes: an explicit "here are (some|the) options / a few options"
 * opener, OR ≥3 enumerated bullet/numbered items that read as parallel choices.
 */
const OPTIONS_OPENER_LEXICON: readonly RegExp[] = [
  /\bhere are (some|a few|the|several|your)? ?(options|choices|approaches|alternatives|paths|ways)\b/i,
  /\b(some|a few|several) (options|choices|approaches|alternatives|paths)\b.*:/i,
  /\b(you (could|can|might)|we (could|can|might))\b.*\b(or|alternatively)\b/i,
  /\b(option (a|b|c|1|2|3)|approach (1|2|3|a|b|c))\b/i,
];

/**
 * Honest "I cannot see the repo / not enough context" lexicon — a VALID grounding
 * (the `not_enough_context` notion). When the model truthfully says it cannot see
 * the requested repo or lacks context AND names what it needs, the turn passes.
 */
const HONEST_NO_CONTEXT_LEXICON: readonly RegExp[] = [
  /\b(i (can('?t| ?not)|cannot|don'?t)) (see|find|access|locate)\b.*\b(repo|repository|project|file|directory|folder|codebase|code|path|context)\b/i,
  /\b(not enough|insufficient|lacking|missing|no) (context|information|repo|repository|access|visibility)\b/i,
  /\b(the (requested |referenced )?(repo|repository|project)) (is not|isn'?t|was not) (visible|present|here|in (the )?(cwd|current))/i,
  /\b(point (me|the tool) (at|to)|share|provide|tell me) the (repo|repository|path|directory|file)\b/i,
  /\b(i don'?t have (enough )?(context|access|visibility))\b/i,
];

/**
 * Grounding lexicons mapped onto the {@link RecommendationGrounding} notion. Each
 * entry is "does the prose contain this kind of grounding". PURE; never throws.
 */
// A referenced file path / symbol: `src/foo.ts`, `foo/bar.js:12`, `path/to/x.py`.
const FILE_PATH_RE =
  /\b[\w./-]*[\w-]\/[\w./-]*\.[a-z]{1,5}\b|\b[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|c|cpp|h|json|md|yml|yaml|toml|sh)\b(?::\d+)?/i;
// An explicit stated assumption.
const ASSUMPTION_RE = /\b(assum(e|ing|ption)|i'?ll assume|i am assuming|presum(e|ing)|taking it that|if we assume)\b/i;
// An external source: a URL, a docs/spec/RFC reference, "according to".
const EXTERNAL_SOURCE_RE =
  /\bhttps?:\/\/\S+|\b(according to|per the|the (docs?|documentation|spec|specification|rfc|changelog|release notes))\b|\b(benchmark|published|upstream)\b/i;
// A repo/environment fact: a concrete observation about the code/env the model saw.
const REPO_FACT_RE =
  /\b(the (codebase|repo|repository|project|code) (uses|has|is|contains|relies on|depends on|targets)|i (see|found|noticed|inspected|looked at|checked|read)|currently (uses|on)|there (is|are) \d+ |in (this|the) (repo|project|codebase)|the (existing|current) (code|implementation|module|setup|stack|config|tests?|build))\b/i;

/** Detect a recommendation / clear next step in the prose. PURE. */
export function detectRecommendation(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return RECOMMENDATION_LEXICON.some((re) => re.test(text));
}

/** Detect a bare options-list / waffle (enumerated choices, no recommendation). PURE. */
export function detectBareOptionsList(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (OPTIONS_OPENER_LEXICON.some((re) => re.test(text))) return true;
  // ≥3 enumerated bullet / numbered items that read as parallel choices.
  const bullets = (text.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length;
  return bullets >= 3;
}

/** Detect an honest "can't see the repo / not enough context". PURE. */
export function detectHonestNoContext(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return HONEST_NO_CONTEXT_LEXICON.some((re) => re.test(text));
}

/**
 * Detect whether the prose is grounded in at least one {@link RecommendationGrounding}.
 * Returns the FIRST grounding found, or `null` when none is present. PURE; never
 * fabricates — detection is over what the model actually wrote.
 */
export function detectGrounding(text: string): RecommendationGrounding | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  // not_enough_context — the honest "I can't see the repo" escape hatch is itself
  // a valid grounding (§2.6 E). Check first: it is the truthful fallback shape.
  if (detectHonestNoContext(text)) {
    return { kind: 'not_enough_context', missing: 'repo/context not visible' };
  }
  const fileMatch = text.match(FILE_PATH_RE);
  if (fileMatch !== null) {
    return { kind: 'file_evidence', paths: [fileMatch[0]] };
  }
  if (REPO_FACT_RE.test(text)) {
    return { kind: 'repo_orientation', facts: ['stated repo/environment fact'] };
  }
  if (EXTERNAL_SOURCE_RE.test(text)) {
    return { kind: 'external_source', sources: ['cited external source'] };
  }
  if (ASSUMPTION_RE.test(text)) {
    return { kind: 'stated_assumption', assumptions: ['explicit stated assumption'] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output validation (§2.2 A2)
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  readonly kind:
    | 'generic_open_menu'
    | 'ungrounded_recommendation'
    | 'missing_required_question'
    | 'unobserved_grounding';
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
    if (validator.kind === 'require_grounded_recommendation') {
      // STAGE 5 (§2.6 E): fires ONLY on a substantial decision/recommendation turn.
      // Tiny factual/lookup turns are EXEMPT — never gated (latency + no nagging).
      if (!directive.substantial) continue;
      const failure = checkGroundedRecommendation(text);
      if (failure !== null) return failure;
    }
    if (validator.kind === 'require_observed_grounding') {
      const failure = checkObservedGrounding(text, directive.evidenceReceipts ?? [], directive.evidenceObligations ?? []);
      if (failure !== null) return failure;
    }
  }
  return null;
}

/**
 * The grounded-recommendation rule over final prose (§2.6 E). PURE; never throws.
 * On a substantial turn the answer FAILS when:
 *   - it is a bare options list / waffle with NO recommendation or next step; OR
 *   - it has a recommendation/next step but NO grounding (no file evidence, repo
 *     fact, stated assumption, external source, or honest "can't see the repo").
 * An honest "I cannot see the requested repo / not enough context" is itself a
 * valid grounding (detectGrounding returns `not_enough_context`), so such an
 * answer PASSES. Returns the failure, or `null` when the answer is acceptable.
 */
function hasUnverifiedSentence(text: string): boolean {
  return /(?:^|[.!?]\s+)Unverified:/m.test(text.trim());
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:\d+$/, '').toLowerCase();
}

function observedLocalPaths(receipts: readonly EvidenceReceiptV1[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.kind !== 'local-code' || receipt.status !== 'obtained') continue;
    for (const path of receipt.pathsRead) out.add(normalizePath(path));
  }
  return out;
}

function sourceTextObserved(text: string, receipts: readonly EvidenceReceiptV1[]): boolean {
  const lower = text.toLowerCase();
  for (const receipt of receipts) {
    if (receipt.kind !== 'external-source' || receipt.status !== 'obtained') continue;
    const source = receipt.sourceText.trim();
    if (source.length === 0) continue;
    const urls = source.match(/https?:\/\/\S+/gi) ?? [];
    if (urls.some((url) => lower.includes(url.toLowerCase()))) return true;
    const phrases = source
      .split(/[.;\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 16)
      .slice(0, 8);
    if (phrases.some((phrase) => lower.includes(phrase.toLowerCase()))) return true;
  }
  return false;
}

function unmetEvidenceKind(obligations: readonly EvidenceNeed[]): Set<'local-code' | 'external-source'> {
  const out = new Set<'local-code' | 'external-source'>();
  for (const o of obligations) {
    if (o.kind === 'local-code') out.add('local-code');
    if (o.kind === 'external-source') out.add('external-source');
  }
  return out;
}

function checkObservedGrounding(
  text: string,
  receipts: readonly EvidenceReceiptV1[],
  obligations: readonly EvidenceNeed[] = [],
): ValidationFailure | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (hasUnverifiedSentence(text)) return null;

  const paths = (text.match(FILE_PATH_RE) ?? []).filter(
    (path): path is string =>
      typeof path === 'string' &&
      (path.includes('/') || /\.[a-z]{1,5}(?::\d+)?$/i.test(path)),
  );
  if (paths.length > 0) {
    const observed = observedLocalPaths(receipts);
    const invented = paths.find((path) => !observed.has(normalizePath(path)));
    if (invented !== undefined) {
      return {
        kind: 'unobserved_grounding',
        severity: 'repair',
        reason:
          `The answer referenced ${invented}, but that path was not present in the observed read receipt. ` +
          'Use only observed evidence or label the claim with "Unverified:".',
      };
    }
  }

  const codebaseClaim =
    REPO_FACT_RE.test(text) ||
    /\b(i (read|inspected|checked|opened|found)|the (repo|repository|codebase|project|code) (uses|has|contains|defines|imports|depends))\b/i.test(text);
  if (codebaseClaim && paths.length === 0 && receipts.some((r) => r.kind === 'local-code')) {
    return {
      kind: 'unobserved_grounding',
      severity: 'repair',
      reason:
        'The answer made a codebase factual claim without naming a path from the observed read receipt. ' +
        'Reference an observed path or label the claim with "Unverified:".',
    };
  }

  const externalClaim = EXTERNAL_SOURCE_RE.test(text) || /\b(current|latest|today|as of|now available)\b/i.test(text);
  if (
    externalClaim &&
    receipts.some((r) => r.kind === 'external-source') &&
    !sourceTextObserved(text, receipts)
  ) {
    return {
      kind: 'unobserved_grounding',
      severity: 'repair',
      reason:
        'The answer made a current external claim without citing text or a reference from the obtained web receipt. ' +
        'Cite observed source text or label the claim with "Unverified:".',
    };
  }

  // When evidence was expected (obligations > 0) but no receipts collected,
  // any codebase or external factual claim MUST be labelled Unverified:
  if (receipts.length === 0 && obligations.length > 0) {
    const unmet = unmetEvidenceKind(obligations);
    if (unmet.has('local-code') && (paths.length > 0 || codebaseClaim)) {
      return {
        kind: 'unobserved_grounding',
        severity: 'repair',
        reason:
          'The answer made a codebase factual claim without observed evidence. ' +
          'Label the claim with "Unverified:" or obtain a local read receipt before answering.',
      };
    }
    if (unmet.has('external-source') && externalClaim) {
      return {
        kind: 'unobserved_grounding',
        severity: 'repair',
        reason:
          'The answer made a current external claim without observed evidence. ' +
          'Label the claim with "Unverified:" or obtain a web search receipt before answering.',
      };
    }
  }

  return null;
}

function checkGroundedRecommendation(text: string): ValidationFailure | null {
  const grounding = detectGrounding(text);
  // An honest no-context answer is fully acceptable on its own (it states the
  // missing context AND the next step — point the tool at the repo).
  if (grounding !== null && grounding.kind === 'not_enough_context') return null;

  const hasRecommendation = detectRecommendation(text);

  // Bare options list / waffle with no recommendation → fail (the order-taker
  // failure mode in recommendation clothing).
  if (!hasRecommendation && detectBareOptionsList(text)) {
    return {
      kind: 'ungrounded_recommendation',
      severity: 'repair',
      reason:
        'A substantial decision turn returned an options list with no recommendation. ' +
        'Inspect the context, recommend a default, and state what would change the decision.',
    };
  }

  // No recommendation AND no grounding → fail (waffle without a stance).
  if (!hasRecommendation && grounding === null) {
    return {
      kind: 'ungrounded_recommendation',
      severity: 'repair',
      reason:
        'A substantial decision turn produced neither a grounded recommendation nor an ' +
        'honest "I cannot see the repo / not enough context". Orient and take a stance.',
    };
  }

  // A recommendation with NO grounding → fail (an opinion floating free of evidence).
  if (hasRecommendation && grounding === null) {
    return {
      kind: 'ungrounded_recommendation',
      severity: 'repair',
      reason:
        'The recommendation is not grounded in any file evidence, repo/environment fact, ' +
        'stated assumption, external source, or an honest "not enough context".',
    };
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

/**
 * The repair feedback appended to the shared ONE retry when the
 * `require_grounded_recommendation` validator fires (§2.6 E). Plain text injected
 * as `managerNotes` so it rides the SAME attempt loop and shares the single
 * validator-repair budget with the generic-menu note — never a second metered
 * call. Exported so orchestrate and tests share one string.
 */
export const GROUNDED_RECOMMENDATION_REPAIR_NOTE =
  'The previous answer was a substantial decision but gave an options list / waffle ' +
  'with no clear recommendation, or a recommendation with no grounding. Inspect the ' +
  'available repo/context, recommend a DEFAULT, and ground it in at least one of: a ' +
  'referenced file path/symbol, a repo/environment fact, an explicit stated assumption, ' +
  'or a cited source. Then state WHAT WOULD CHANGE the decision, and ask only a genuine ' +
  'fork if one remains. If you cannot see the requested repo, say so and name what you ' +
  'need — do not fabricate grounding.';

/**
 * The DETERMINISTIC truthful fallback appended ONLY when, after the one retry, the
 * answer still lacks a groundable recommendation (§2.6 E). It is appended ONLY when
 * it is LITERALLY true — i.e. no recommendation could be grounded from the output;
 * see {@link shouldAppendGroundedFallback}. Never fabricates grounding.
 */
export const GROUNDED_RECOMMENDATION_FALLBACK =
  'I cannot ground a recommendation from the current output; the next step is to point ' +
  'the tool at the correct repo or narrow the task.';

/**
 * Decide whether the deterministic truthful fallback (§2.6 E) may be appended to a
 * final answer. PURE; never throws. It is truthful ONLY when the answer is still
 * ungrounded on a substantial turn AND it is not already an honest "I cannot see
 * the repo" (which would make the fallback redundant). Returns false for any
 * non-substantial directive or an answer that already grounds a recommendation —
 * the fallback is appended ONLY when literally nothing could be grounded.
 */
export function shouldAppendGroundedFallback(text: string, directive: TurnDirective): boolean {
  if (directive === null || typeof directive !== 'object') return false;
  if (directive.substantial !== true) return false;
  if (!directive.outputValidators.some((v) => v.kind === 'require_grounded_recommendation')) {
    return false;
  }
  if (typeof text !== 'string') return false;
  // Already an honest no-context answer → fallback would be redundant (and the
  // validator already passes), so do not append.
  if (detectHonestNoContext(text)) return false;
  // Append ONLY when the answer is still ungrounded — i.e. the validator still
  // fails. This is the "no recommendation could be grounded" truth condition.
  return checkGroundedRecommendation(text) !== null;
}

// ---------------------------------------------------------------------------
// History policy (§3) — quarantine prior generic-menu assistant prose
// ---------------------------------------------------------------------------

/**
 * A prior assistant turn for the history-policy decision (AP2-F / Stage 6). Carries
 * the prose PLUS the persisted engine-behavior version marker, so the policy can
 * quarantine pre-fix prose on TWO independent axes: an obvious generic menu (text),
 * OR an entry written by a pre-fix engine (version absent/below current) even when
 * its text is not an obvious menu (§3 "predate the engine version that introduced
 * enforced asks"). PURE shape; no I/O.
 */
export interface PriorAssistantTurn {
  readonly content: string;
  /** The persisted `engineBehaviorVersion`; absent → legacy/pre-fix entry. */
  readonly engineBehaviorVersion?: number;
}

/**
 * Decide the history replay policy for the NEXT turn. PURE; never throws.
 *
 * QUARANTINE TRIGGERS (§3):
 *   1. TEXT axis (Stage 1): a prior ASSISTANT turn is itself a generic open menu.
 *      This is the primary, self-sufficient poisoning signal.
 *   2. VERSION axis (AP2-F / Stage 6): a prior ASSISTANT turn PREDATES the engine
 *      version that introduced enforced asks — its `engineBehaviorVersion` marker is
 *      absent or below the current {@link ENGINE_BEHAVIOR_VERSION}.
 *
 * The version axis is a WIDENER, NOT a standalone trigger: it only fires WHEN the
 * conversation already shows a poisoning signal (the text axis flagged a generic
 * menu somewhere in the pre-fix period). In that case the WHOLE pre-fix period is
 * suspect, so legacy-version assistant prose — even prose that is not itself an
 * obvious menu — is also quarantined (it predates the fix and may few-shot the old
 * behavior). A conversation of purely-clean LEGACY prose with NO menu anywhere stays
 * `normal`: a missing marker alone never quarantines a clean transcript, so existing
 * resumed chats keep their continuity (backward-compatible). The orchestrate replay
 * filter applies the SAME two-axis rule per entry, so what is decided here matches
 * what is dropped there.
 *
 * BACKWARD-COMPATIBLE OVERLOADS:
 *   - `decideHistoryPolicy(string[])` — the Stage-1 text-only form (callers/tests
 *     with no version info). Text axis only; the version axis cannot apply (no
 *     markers) — byte-for-byte the original Stage-1 behavior.
 *   - `decideHistoryPolicy(PriorAssistantTurn[])` — the Stage-6 form carrying the
 *     marker; the version axis widens the quarantine when the text axis fired.
 */
export function decideHistoryPolicy(
  priorAssistant: readonly string[] | readonly PriorAssistantTurn[] | undefined,
): HistoryPolicy {
  if (!Array.isArray(priorAssistant) || priorAssistant.length === 0) {
    return { replayMode: 'normal', reasons: [] };
  }

  // TEXT axis — the primary poisoning signal (an obvious generic menu anywhere).
  const menuPoisoned = priorAssistant.some((entry) => {
    const content = typeof entry === 'string' ? entry : entry?.content;
    return typeof content === 'string' && detectGenericOpenMenu(content);
  });

  // VERSION axis — only meaningful in the object form, and only WIDENS the
  // quarantine: it requires the text axis to have already flagged poisoning. A
  // missing marker on otherwise-clean prose never quarantines on its own.
  const hasLegacyProse =
    menuPoisoned &&
    priorAssistant.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.content === 'string' &&
        entry.content.trim().length > 0 &&
        !detectGenericOpenMenu(entry.content) &&
        isLegacyEngineEntry(entry.engineBehaviorVersion),
    );

  if (menuPoisoned) {
    const reasons = ['prior assistant turn contained a generic open menu'];
    if (hasLegacyProse) {
      reasons.push('pre-fix transcript period: legacy assistant prose also quarantined');
    }
    return { replayMode: 'quarantine_assistant_prose', reasons };
  }
  return { replayMode: 'normal', reasons: [] };
}

// ---------------------------------------------------------------------------
// "Substantial" decision-turn predicate (§2.6 E, AP2-E)
// ---------------------------------------------------------------------------

/**
 * Decide whether the turn is SUBSTANTIAL — a decision/recommendation-shaped turn on
 * which {@link OutputValidator} `require_grounded_recommendation` should fire. PURE;
 * never throws.
 *
 * A turn is substantial when it is NOT a tiny factual/lookup turn AND it is
 * genuinely DECISION/RECOMMENDATION-shaped — NOT a plain implementation turn. We
 * keep this NARROW (the §6 over-blocking risk): a normal "implement X" turn that
 * merely plans first must NOT be gated. Concretely it is substantial when ANY hold:
 *   - vision triage carried a MIGRATE_REARCHITECT, INVESTIGATE_THEN_PROPOSE, or a
 *     genuine DISCUSS fork (the §2.4 C dispositions that need an opinion); or
 *   - the task itself reads as a decision ("should we X or Y", "which is better",
 *     "recommend / migrate / rewrite …", "X or Y?").
 * It is NEVER substantial when {@link isTrivial} (the same population the intent gate
 * skips) — a tiny "what is 2+2 / how many files" turn is EXEMPT (latency, no nagging).
 *
 * We deliberately do NOT key off engagement ACTIONS (DISCUSS_OPTIONS / PLAN_FIRST /
 * REFLECT_VISION): those also fire on ordinary high-risk implementation work — the
 * irreversible+ambiguous SAFETY FLOOR adds DISCUSS_OPTIONS to "implement the payment
 * handler" — and gating those would over-fire the validator (doc §6 over-blocking
 * risk). A turn is substantial because it is a genuine DECISION, surfaced by the
 * vision-triage disposition or the decision-shaped task text, not because a
 * thoroughness rung happened to be selected.
 */
function decideSubstantial(input: {
  readonly plan: EngagementPlan;
  readonly signals: EngagementSignals;
  readonly migration: boolean;
  readonly investigate: boolean;
  readonly discussFork: boolean;
}): boolean {
  const { signals, migration, investigate, discussFork } = input;
  if (signals === null || typeof signals !== 'object') return false;
  // Tiny factual/lookup/trivial turns are EXEMPT — never gated.
  if (isTrivial(signals)) return false;

  // Vision-triage dispositions that need an opinion (§2.4 C).
  if (migration || investigate || discussFork) return true;

  // A decision/recommendation-shaped task.
  const task = typeof signals.task === 'string' ? signals.task : '';
  const decisionShaped = DECISION_TASK_LEXICON.some((re) => re.test(task));
  if (decisionShaped) return true;

  return false;
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
 *
 * STAGE 3 (doc §2.4 C) — vision triage. The vision is decomposed (PURELY, no model
 * call) into {@link VisionTriageItem}s via {@link triageVision}. When the result is
 * a meaningful multi-part vision (≥2 items) OR carries a migration / investigate /
 * genuine-fork concern, a `vision_triage` {@link RequiredPreAnswerAction} is added
 * to `requiredBeforeAnswer`, carrying the items + the routing facts:
 *   - SOLID                   → proceed (rendered as "state interpretation + proceed").
 *   - DISCUSS (genuine fork)  → the FIRST such fork seeds `terminalQuestion` via the
 *                               EXISTING fork machinery (`deriveAskFromForks`,
 *                               ASK_CAP, `hasGenuineFork`); never a generic menu.
 *   - MIGRATE_REARCHITECT     → `migrationNeedsArchitectureTier`: ≥ IC always; the
 *                               manager bump is requested ONLY when the injected
 *                               `canAuthorizeManagerForMigration()` (the existing
 *                               `authorizeTier`/`admitManager` gate) returns true —
 *                               so the policy gate is never bypassed.
 *   - INVESTIGATE_THEN_PROPOSE→ `requiresInvestigation`: the answer must return
 *                               findings + a plan, not a generic question.
 */

/**
 * Derive the rank-9 enforced investigation directive. PURE; never throws.
 * Returns `'local'` ONLY when the engagement plan explicitly schedules an
 * `INVESTIGATE_CONTEXT` action AND a repo is present (`repoPresent`). `'web'` is
 * reserved for a later slice and is never derived here.
 */
export function deriveRequiredInvestigation(
  plan: EngagementPlan,
  repoPresent: boolean,
): 'local' | 'none' {
  if (repoPresent && Array.isArray(plan.actions) && plan.actions.includes('INVESTIGATE_CONTEXT')) {
    return 'local';
  }
  return 'none';
}

export function compileTurnDirective(input: CompileDirectiveInput): TurnDirective {
  const { frame, plan, signals } = input;

  const repoOriented =
    input.repoPresent === true ||
    (plan !== undefined && Array.isArray(plan.actions) && plan.actions.includes('INVESTIGATE_CONTEXT'));

  // Prefer the version-aware Stage-6 form when the caller provided it (both the
  // text and version quarantine axes apply); otherwise fall back to the Stage-1
  // text-only form. Backward-compatible: a caller passing only `priorAssistantTexts`
  // behaves exactly as before.
  const historyPolicy = decideHistoryPolicy(
    input.priorAssistant !== undefined ? input.priorAssistant : input.priorAssistantTexts,
  );

  // STAGE 3 — vision triage (PURE, no model call). Decompose the vision and decide
  // whether to carry a `vision_triage` directive action. We surface it only for a
  // genuinely multi-part vision OR when a migration / investigate / genuine-fork
  // concern is present, so a plain single-claim turn renders nothing (unchanged).
  const triageItems = triageVision({
    signals,
    ...(input.repoPresent !== undefined ? { repoPresent: input.repoPresent } : {}),
  });
  const migration = hasMigrationConcern(triageItems);
  const investigate = hasInvestigateConcern(triageItems);
  const discussFork = firstDiscussFork(triageItems);
  const multiPart = triageItems.length >= 2;
  const carriesTriage = multiPart || migration || investigate || discussFork !== undefined;

  // MIGRATE bounded by authorizeTier: the architecture-note request is always
  // recorded (≥ IC), but the manager bump is requested ONLY when the injected
  // policy gate admits it. Absent gate → never request manager (request stays at
  // the IC floor). The compiler NEVER opens a tier itself.
  const migrationNeedsArchitectureTier =
    migration &&
    typeof input.canAuthorizeManagerForMigration === 'function' &&
    input.canAuthorizeManagerForMigration() === true;

  // STAGE 5 (§2.6 E, AP2-E) — decide whether this is a SUBSTANTIAL
  // decision/recommendation turn. The `require_grounded_recommendation` validator
  // is added ONLY when so; tiny factual/lookup turns stay EXEMPT (never gated).
  const substantial =
    plan !== undefined && plan !== null && Array.isArray(plan.actions)
      ? decideSubstantial({
          plan,
          signals,
          migration,
          investigate,
          discussFork: discussFork !== undefined,
        })
      : false;

  const outputValidators: readonly OutputValidator[] = substantial
    ? [{ kind: 'reject_generic_open_menu' }, { kind: 'require_grounded_recommendation' }]
    : [{ kind: 'reject_generic_open_menu' }];
  const requiresObservedGrounding =
    input.semanticTaskKind === 'lookup' ||
    input.semanticTaskKind === 'analysis' ||
    input.semanticTaskKind === 'decision';
  const outputValidatorsWithObserved: readonly OutputValidator[] = requiresObservedGrounding
    ? [...outputValidators, { kind: 'require_observed_grounding' }]
    : outputValidators;

  const requiredBeforeAnswer: readonly RequiredPreAnswerAction[] = carriesTriage
    ? [
        {
          kind: 'vision_triage',
          items: triageItems,
          migrationNeedsArchitectureTier,
          requiresInvestigation: investigate,
        },
      ]
    : [];

  // Fail-soft base directive (no terminal ask). The truthful work-state (AP2-B
  // §2.3 B) rides through unchanged when present so the turn knows what was last
  // done + the next honest step.
  const base: TurnDirective = {
    version: 1,
    requiredBeforeAnswer,
    outputValidators: outputValidatorsWithObserved,
    historyPolicy,
    repoOriented,
    substantial,
    ...(input.workState !== undefined ? { workState: input.workState } : {}),
    ...(input.requiredInvestigationEnabled === true
      ? { requiredInvestigation: deriveRequiredInvestigation(plan, input.repoPresent === true) }
      : {}),
    ...(input.evidenceObligations !== undefined ? { evidenceObligations: input.evidenceObligations } : {}),
    ...(input.evidenceReceipts !== undefined ? { evidenceReceipts: input.evidenceReceipts } : {}),
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
