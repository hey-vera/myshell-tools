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

import type { Tier, Risk } from './types.js';
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

/** Pull just the `risk: …` clause out of a classify() rationale, for reuse. */
function riskClause(rationale: string): string {
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
  opts: { readonly classifier?: ModelClassifier; readonly signal: AbortSignal },
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
    suggestion = await opts.classifier(task, opts.signal);
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
