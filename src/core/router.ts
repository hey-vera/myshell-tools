/**
 * src/core/router.ts — the model-brained front door.
 *
 * The deterministic classifier (core/classify.ts) is a keyword matcher: fast and
 * free, but blind to complexity it has no keyword for. Its real failure mode is a
 * genuinely hard request phrased without a trigger word — it silently defaults to
 * the `ic` tier. This module fixes exactly that case, and ONLY that case.
 *
 * decideRoute() runs the rules first. When the rules had real keyword evidence
 * (hasTierEvidence === true) it trusts them — no model call, no latency, no cost.
 * When the rules had NO evidence (the ambiguous default), and a model classifier
 * is wired, it asks the cheap model to read the message and pick a tier (and flag
 * whether a plan-first pass would help). Any failure — no classifier, parse
 * error, timeout, invalid tier — falls straight back to the rules. The model can
 * raise or lower the tier, but it can NEVER downgrade the deterministic RISK: a
 * security-critical task stays critical even if the router model is wrong.
 *
 * Purity: no I/O, no time, no randomness. The model call is an injected port
 * (ModelClassifier), so this module stays a pure, fully-testable decision.
 *
 * Honesty Contract: no fabricated confidence numbers. The rationale names whether
 * the decision came from rules or the model, and why.
 */

import type { Tier, Risk, Classification } from './types.js';
import type { LedgerStage } from './types.js';
import type { TurnCallBudget } from './turn-call-budget.js';
import { classify, hasTierEvidence } from './classify.js';


// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The resolved routing decision for one turn. */
export interface RouteDecision {
  readonly tier: Tier;
  readonly risk: Risk;
  /**
   * True when the task is complex/multi-step enough that proposing a short plan
   * before acting would help. Computed here; consumed by plan-first mode
   * (Phase C). Always false on the rules path (the rules don't reason about it).
   */
  readonly plan: boolean;
  readonly rationale: string;
  /** Where the tier choice came from — for transparency and tests. */
  readonly source: 'rules' | 'model';
}

/** A tier/plan suggestion parsed from the router model's reply. */
export interface ModelRouteSuggestion {
  readonly tier: Tier;
  readonly plan: boolean;
  readonly reason: string;
}

/**
 * A model-backed classification seam. Given a task it returns a parsed
 * suggestion, or `null` on ANY failure (no model available, timed out, garbled
 * output). Injected by the infra layer so core stays pure and testable.
 */
export type ModelClassifier = (
  task: string,
  signal: AbortSignal,
  opts?: { readonly stage?: LedgerStage; readonly intentVersionId?: string; readonly turnCallBudget?: TurnCallBudget },
) => Promise<ModelRouteSuggestion | null>;

// ---------------------------------------------------------------------------
// Prompt for the router model (kept tiny — this runs on the cheapest tier)
// ---------------------------------------------------------------------------

/**
 * Build the one-shot routing prompt. Deliberately small: the router model only
 * has to pick a bucket, not do the work. The strict JSON-only instruction keeps
 * {@link parseModelRoute} robust.
 */
export function buildRouterPrompt(task: string): string {
  return [
    'You are a routing classifier for a CLI coding assistant. Read the user',
    'message and decide how much firepower it needs. Do NOT answer it.',
    '',
    'Pick the CHEAPEST tier that fits — escalate only on clear evidence, never',
    'just because the message is vague, casual, or short:',
    '  "worker"  — DEFAULT. Simple questions, explanations, lookups, summaries,',
    '              and any casual / conversational / unclear / chit-chat message.',
    '              No file changes.',
    '  "ic"      — a concrete implementation, edit, debug, or refactor task in one',
    '              area (the user clearly wants something built or changed).',
    '  "manager" — ONLY clearly high-level technical work: architecture, audits,',
    '              multi-system or cross-cutting design, comparing approaches, or',
    '              high-stakes planning. Do NOT choose manager merely because the',
    '              scope is vague — vague or chatty messages are "worker".',
    'plan: true only if the task is genuinely complex / multi-step enough that a',
    '  short plan before acting would help; otherwise false.',
    '',
    'Reply with ONLY a JSON object on a single line, nothing else:',
    '{"tier":"worker","plan":false,"reason":"<8 words max>"}',
    '',
    `Message: ${task}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parser — extract + validate the model's JSON reply
// ---------------------------------------------------------------------------

const VALID_TIERS: ReadonlySet<string> = new Set<Tier>(['worker', 'ic', 'manager']);

/**
 * Parse a router-model reply into a {@link ModelRouteSuggestion}, or return
 * `null` if it can't be trusted. Tolerant of prose around the JSON (extracts the
 * last balanced `{...}` span), but strict about the SHAPE: tier must be a real
 * tier, plan must be a boolean, reason must be a non-empty string. Never throws.
 */
export function parseModelRoute(text: string | undefined): ModelRouteSuggestion | null {
  if (text === undefined) return null;
  const json = extractLastJsonObject(text);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const tier = obj['tier'];
  const plan = obj['plan'];
  const reason = obj['reason'];

  if (typeof tier !== 'string' || !VALID_TIERS.has(tier)) return null;
  if (typeof plan !== 'boolean') return null;
  if (typeof reason !== 'string' || reason.trim().length === 0) return null;

  return { tier: tier as Tier, plan, reason: reason.trim() };
}

/**
 * Return the substring of the last balanced top-level `{...}` object in `text`,
 * or `null` if there isn't one. Scans from the end for a `}` and walks back to
 * its matching `{`, ignoring braces inside double-quoted strings (with escape
 * handling) so a brace in `reason` can't fool the matcher.
 */
function extractLastJsonObject(text: string): string | null {
  const end = text.lastIndexOf('}');
  if (end === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      // Walking backwards: a backslash BEFORE this char escapes it.
      if (ch === '"' && text[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Pull just the `risk: …` clause out of a classify() rationale, for reuse.
 * Exported so the unified preflight (`combineRoute`) can build a rationale that
 * is byte-structurally identical to `decideRoute`'s model branch (rank-7).
 */
export function riskClause(rationale: string): string {
  const idx = rationale.indexOf('risk:');
  return idx === -1 ? rationale : rationale.slice(idx);
}

/**
 * Decide how to route one turn.
 *
 * Fast path (free, instant): no classifier wired, OR the rules had real keyword
 * evidence → use the deterministic classification as-is.
 *
 * Model path: the rules had NO evidence (ambiguous default) → ask the injected
 * classifier. On any failure it falls back to rules. The model sets tier + plan;
 * the deterministic RISK is always preserved (never downgraded by the model).
 *
 * Never throws — a thrown classifier is caught and treated as a null suggestion.
 *
 * @param task - The raw user message.
 * @param opts - `classifier` (optional model seam) and the abort `signal`.
 */
export async function decideRoute(
  task: string,
  opts: { readonly classifier?: ModelClassifier; readonly signal: AbortSignal; readonly intentVersionId?: string; readonly turnCallBudget?: TurnCallBudget },
): Promise<RouteDecision> {
  const base = classify(task);

  // Fast path — deterministic rules are trusted whenever they had evidence (or
  // there's no model to consult). Zero model cost on the overwhelming majority
  // of turns.
  if (opts.classifier === undefined || hasTierEvidence(task)) {
    return { tier: base.tier, risk: base.risk, plan: false, rationale: base.rationale, source: 'rules' };
  }

  // Ambiguous turn — consult the cheap model, but degrade gracefully.
  let suggestion: ModelRouteSuggestion | null = null;
  try {
    suggestion = await opts.classifier(task, opts.signal, {
      stage: 'route',
      ...(opts.intentVersionId !== undefined ? { intentVersionId: opts.intentVersionId } : {}),
      ...(opts.turnCallBudget !== undefined ? { turnCallBudget: opts.turnCallBudget } : {}),
    });
  } catch {
    suggestion = null;
  }
  if (suggestion === null) {
    return { tier: base.tier, risk: base.risk, plan: false, rationale: base.rationale, source: 'rules' };
  }

  return {
    tier: suggestion.tier,
    risk: base.risk, // deterministic risk is authoritative — never model-downgraded
    plan: suggestion.plan,
    rationale: `tier: ${suggestion.tier} (model router: ${suggestion.reason}); ${riskClause(base.rationale)}`,
    source: 'model',
  };
}

// ---------------------------------------------------------------------------
// Rank-7 — unified preflight (pure helpers; default-off, NOT wired here)
//
// These collapse the router's tier/plan judgment into the intent extractor's
// single model round-trip on the affected turn class (ambiguous + substantial),
// removing one serial worker-tier call. They are PURE and live here — router.ts
// is the preflight's natural home and is already widely imported — so the new
// logic satisfies the no-orphan arch guard + knip WITHOUT a new orphan module
// and WITHOUT any premature live wiring (the orchestrate/menu wiring is deferred
// to later slices). DESIGN-RANK7 §A.3 / §B. Default-off: nothing calls these yet,
// so the tree is byte-identical.
// ---------------------------------------------------------------------------

/** Env values treated as an explicit opt-IN for MYSHELL_UNIFY_PREFLIGHT. */
const UNIFY_ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether THE UNIFIED PREFLIGHT (rank-7) is enabled. DEFAULT FALSE — mirrors
 * `judgment-flag.ts` exactly. Returns true ONLY when explicitly opted in:
 * `MYSHELL_UNIFY_PREFLIGHT` is one of '1'/'true'/'on'/'yes' (trimmed, case-insensitive)
 * OR `config.experimentalUnifyPreflight === true`. Any other value (including absent,
 * '0', 'false', '', garbage) → false. Never throws.
 */
export function preflightUnifyEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalUnifyPreflight?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_UNIFY_PREFLIGHT'];
    if (typeof raw === 'string' && UNIFY_ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalUnifyPreflight === true) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Decide whether INTENT-DERIVED RISK SIGNALS (rank-8) are enabled. DEFAULT FALSE —
 * verbatim mirror of `preflightUnifyEnabled`. Returns true ONLY when explicitly
 * opted in: `MYSHELL_RISK_SIGNALS` is one of '1'/'true'/'on'/'yes' (trimmed,
 * case-insensitive) OR `config.experimentalRiskSignals === true`. Any other value
 * (including absent, '0', 'false', '', garbage) → false. Never throws.
 */
export function preflightRiskSignalsEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalRiskSignals?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_RISK_SIGNALS'];
    if (typeof raw === 'string' && UNIFY_ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalRiskSignals === true) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Decide whether the ENFORCED LOCAL-INVESTIGATION DIRECTIVE (rank-9) is enabled.
 * DEFAULT FALSE — verbatim mirror of `preflightRiskSignalsEnabled`. Returns true
 * ONLY when explicitly opted in: `MYSHELL_REQUIRED_INVESTIGATION` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR
 * `config.experimentalRequiredInvestigation === true`. Any other value
 * (including absent, '0', 'false', '', garbage) → false. Never throws.
 */
export function preflightRequiredInvestigationEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalRequiredInvestigation?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_REQUIRED_INVESTIGATION'];
    if (typeof raw === 'string' && UNIFY_ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalRequiredInvestigation === true) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Decide whether the AGGREGATE PREFLIGHT-OVERHEAD GUARD (audit rank 10) is
 * enabled. DEFAULT FALSE — verbatim mirror of `preflightRequiredInvestigationEnabled`.
 * Returns true ONLY when explicitly opted in: `MYSHELL_PREFLIGHT_GUARD` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR
 * `config.experimentalPreflightGuard === true`. Any other value (including absent,
 * '0', 'false', '', garbage) → false. Never throws.
 */
export function preflightOverheadGuardEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalPreflightGuard?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_PREFLIGHT_GUARD'];
    if (typeof raw === 'string' && UNIFY_ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalPreflightGuard === true) return true;
    return false;
  } catch {
    return false;
  }
}

/** Inputs to the unified-preflight predicate — all already-computed booleans. */
export interface UnifiedPreflightInput {
  /** `preflightUnifyEnabled(env, config)` — the rank-7 gate. */
  readonly gateOn: boolean;
  /** Whether the intent pass is ALREADY scheduled this turn (today's `runIntent`). */
  readonly runIntentScheduled: boolean;
  /** Whether an intent extractor is wired this turn. */
  readonly hasExtractor: boolean;
}

/**
 * The §A.1 predicate: the unified path applies IFF the gate is on AND the intent
 * pass was already going to run this turn AND an extractor is wired. A thin pure
 * combiner over already-computed booleans — so the unified path can only ever
 * REMOVE the router call from a turn that was already making the intent call; it
 * never adds work. PURE; trivially testable. (DESIGN-RANK7 §A.1 / §A.3.)
 */
export function unifiedPreflightApplies(input: UnifiedPreflightInput): boolean {
  return input.gateOn && input.runIntentScheduled && input.hasExtractor;
}

/**
 * The MONOTONIC combine (DESIGN-RANK7 §B): fuse the deterministic classification
 * with the route hints the intent extractor produced, into the existing
 * {@link RouteDecision} shape. Byte-structurally identical to `decideRoute`'s
 * model branch above.
 *
 *  - `tier`     — the model's hint when present (it may RAISE the firepower tier),
 *                 else the deterministic tier. Same latitude `decideRoute` gives
 *                 the dedicated router.
 *  - `risk`     — `det.risk` ALWAYS. The deterministic risk floor is authoritative
 *                 and is NEVER model-driven and NEVER lowered. There is no
 *                 `routeRisk` hint at all.
 *  - `plan`     — the model's `routePlan` hint, else `false` (mirrors the rules
 *                 default + `decideRoute`'s fallback).
 *  - `source`   — `'model'` when a tier hint was present, else `'rules'`.
 *
 * With NO hints (absent/invalid) this returns exactly what `decideRoute` returns on
 * its rules/fallback path, so fail-soft ties the no-unify behavior, never worse.
 */
export function combineRoute(
  det: Classification,
  hints: { readonly routeTier?: Tier; readonly routePlan?: boolean },
): RouteDecision {
  const modelTier = hints.routeTier;
  return {
    tier: modelTier ?? det.tier, // model may set/raise tier; absent → deterministic
    risk: det.risk, // DETERMINISTIC RISK — authoritative, never model-driven
    plan: hints.routePlan ?? false, // mirrors the rules default false
    rationale:
      modelTier !== undefined
        ? `tier: ${modelTier} (intent preflight); ${riskClause(det.rationale)}`
        : det.rationale,
    source: modelTier !== undefined ? 'model' : 'rules',
  };
}

/** Severity rank for Risk — the SAME priority cascade classify() uses
 *  (critical > high > medium > low). Higher = more severe. */
const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * MONOTONIC risk combine (rank-8). The deterministic keyword risk is a HARD FLOOR:
 * the model's intent-derived signals may RAISE risk above it, NEVER lower it.
 * Absent/invalid hints (already omitted by capIntentFrame) → no effect, returns the
 * deterministic risk unchanged. Mirrors combineRoute's risk-lock discipline,
 * extended so the model can raise on genuine evidence. PURE; never throws.
 */
export function combineRisk(
  deterministicRisk: Risk,
  hints: { readonly operationRisk?: Risk; readonly blastRadius?: Risk },
): Risk {
  let rank = RISK_RANK[deterministicRisk];
  const op = hints.operationRisk;
  const blast = hints.blastRadius;
  if (op !== undefined) rank = Math.max(rank, RISK_RANK[op]);
  if (blast !== undefined) rank = Math.max(rank, RISK_RANK[blast]);
  const order: readonly Risk[] = ['low', 'medium', 'high', 'critical'];
  return order[rank] ?? deterministicRisk;
}
