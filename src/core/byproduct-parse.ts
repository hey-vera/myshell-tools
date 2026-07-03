/**
 * src/core/byproduct-parse.ts — robust parse-from-text fallback for the
 * structured byproduct (IntentFrame) emitted by the model as part of its
 * normal reply (redesign Phase 0, capability-normalization slice).
 *
 * PROBLEM IT SOLVES:
 *   Providers differ in how reliably they return clean structured output.  The
 *   primary parser (`parseIntentFrame` in intent.ts) already handles prose
 *   around a JSON object.  But some providers — or the same provider under
 *   quota pressure — may wrap the JSON in a markdown fenced block, emit partial
 *   JSON missing required fields, or fall back to key-value prose.  When the
 *   primary parse returns null, this module gives one more chance.
 *
 * DESIGN CONSTRAINTS (from docs/one-chat-redesign-plan.md):
 *   - PURELY ADDITIVE: the fallback only ever activates after the primary
 *     parse has already returned null.  A clean parse path is byte-identical
 *     to today — this module is never called on a success path.
 *   - PROMOTED to unconditional: the caller always invokes the fallback after
 *     the primary `parseIntentFrame` returns null.
 *   - PURE: no I/O, no time, no randomness (the `test/arch/guards.test.ts`
 *     purity guard).  All functions are pure over string / data inputs.
 *   - NEVER FABRICATES: on any ambiguity or partial signal the field is omitted
 *     (not guessed), matching the "unknown-is-absent" invariant.
 *
 * WHAT THE FALLBACK HANDLES (each extraction strategy is tried in order):
 *   1. Fenced JSON blocks (```json...```, ```...```): very common habit even
 *      when the prompt says "JSON only".
 *   2. Partial JSON — an object with a `goal` but missing `confidence`: treat
 *      confidence as 'low' (the safest default) so the frame is valid.
 *   3. Key-marker prose: lines like "goal: ..." or "Goal: ..." when the model
 *      slipped into plain text.  Extracts only `goal` (the one required field)
 *      and a coarse confidence guess from context words.
 *
 * PROVIDER CAPABILITY DESCRIPTOR:
 *   `providerStructuredOutputCapability(provider)` returns a small fact about
 *   how reliably each provider emits clean structured output, so callers can
 *   decide how aggressively to try the fallback.  This is a pure, declarative
 *   fact — NOT a routing signal, and NOT a ModelCapability (it is about the
 *   CLI's OUTPUT FORMAT, not the model's intelligence).
 *
 * DOES NOT TOUCH (out of scope for this slice):
 *   - orchestrate.ts routing logic or mode-levels.ts
 *   - The Auto brain or goal staging
 *   - Provider request/response format (port.ts) — this is a post-hoc TEXT
 *     parser, not a wire-format change
 */

import type { IntentFrame, IntentConfidence } from './intent.js';
import { parseIntentFrame, capIntentFrame } from './intent.js';
import type { ProviderId } from '../providers/port.js';

// ---------------------------------------------------------------------------
// Provider structured-output capability descriptor — declarative, pure
// ---------------------------------------------------------------------------

/**
 * How reliably a provider's CLI returns clean, non-fenced JSON when prompted
 * for structured output.
 *
 *   'clean'   — reliably emits the JSON object with no wrapper/fence (Claude
 *               Code with `-p --output-format stream-json`, Codex with JSON mode).
 *   'fenced'  — commonly wraps the JSON in a markdown fence (```json…```) even
 *               when asked not to (observed with some opencode model combos and
 *               Grok in certain modes).
 *   'prose'   — may slip into key-value prose or partial JSON; the fallback is
 *               most important here.
 *   'unknown' — no grounded observation; treat as 'fenced' to be safe.
 *
 * IMPORTANT: this is a FACT about the CLI's _output format_, NOT about the
 * model's intelligence.  It is NOT a routing signal and NEVER enters
 * route()/scoreModel() or any model-selection logic (the "non-routable facts"
 * principle from model-capabilities.ts §6).  It is consulted only by this
 * module's fallback strategies.
 */
export type StructuredOutputCapability = 'clean' | 'fenced' | 'prose' | 'unknown';

/**
 * A capability descriptor summarising how a provider delivers structured
 * byproduct.  Purely declarative; returned by
 * `providerStructuredOutputCapability`.
 */
export interface ProviderByproductCapability {
  readonly provider: ProviderId;
  /**
   * How reliably this provider CLI returns clean JSON when asked for structured
   * output.  See `StructuredOutputCapability` for the vocabulary.
   */
  readonly structuredOutput: StructuredOutputCapability;
  /**
   * Human-readable note explaining the grounding for the capability fact.
   * Kept deliberately terse — this is not documentation for the user.
   */
  readonly note: string;
}

/**
 * Returns the declarative structured-output capability descriptor for a
 * provider.  PURE, no I/O; unknown providers return `'unknown'`.
 *
 * Facts are grounded in observed CLI behaviour; absent observation → 'unknown'.
 * They are NEVER guessed from brand/reputation.
 */
export function providerStructuredOutputCapability(
  provider: ProviderId,
): ProviderByproductCapability {
  switch (provider) {
    case 'claude':
      return {
        provider,
        structuredOutput: 'clean',
        note:
          'claude -p --output-format stream-json delivers the result text as-is; ' +
          'with a JSON-only prompt the CLI reliably returns bare JSON in the result field.',
      };
    case 'codex':
      return {
        provider,
        structuredOutput: 'clean',
        note:
          'codex exec with a JSON-only prompt reliably returns bare JSON; ' +
          'the CLI streams JSONL and the final text is the accumulated prose output.',
      };
    case 'opencode':
      return {
        provider,
        structuredOutput: 'fenced',
        note:
          'opencode is a meta-provider; the underlying model may wrap JSON in a ' +
          'markdown fence despite a JSON-only prompt — the fenced fallback applies.',
      };
    case 'grok':
      return {
        provider,
        structuredOutput: 'fenced',
        note:
          'Grok may produce fenced JSON blocks in some modes; the fenced fallback ' +
          'is a safe hedge until grounded observations narrow this further.',
      };
  }
}

// ---------------------------------------------------------------------------
// Strategy 1 — extract from a fenced code block
// ---------------------------------------------------------------------------

/**
 * Extract the content of the LAST markdown fenced block (```…``` or
 * ```lang…```) in `text`.  Returns the fence's inner text (stripped of the
 * fence markers and language tag), or `null` if no fence is found.  PURE;
 * never throws.
 *
 * Handles:
 *   - ` ```json\n{...}\n``` ` — the common "json" language tag
 *   - ` ```\n{...}\n``` ` — a fence with no language tag
 *   - Any other language tag (e.g. ` ```javascript `) — extracted regardless
 *   - Backtick count ≥ 3 (3 is standard; some models emit 4)
 */
export function extractFencedContent(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Match ALL fenced blocks and return the last one's inner content.
  // Pattern: one or more ``` then optional lang tag then newline then content
  // then closing ``` on its own line.
  const FENCE_RE = /`{3,}[a-zA-Z0-9]*\n([\s\S]*?)\n`{3,}/g;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const inner = m[1];
    if (inner !== undefined && inner.trim().length > 0) {
      lastMatch = inner.trim();
    }
  }
  return lastMatch;
}

// ---------------------------------------------------------------------------
// Strategy 2 — partial JSON: `goal` present but `confidence` absent/invalid
// ---------------------------------------------------------------------------

/**
 * Attempt to parse `text` as a partial JSON object that carries at least a
 * `goal` field.  If `confidence` is absent or invalid it defaults to `'low'`
 * (the safest value — the frame is still usable, just honest about uncertainty).
 *
 * Returns a VALID `IntentFrame` (run through `capIntentFrame`), or `null` if
 * `goal` is absent or the text cannot be parsed as JSON at all.  PURE; never
 * throws.
 *
 * This is intentionally a SECONDARY strategy: it adds `confidence: 'low'`
 * when missing (a safe invention), which `parseIntentFrame` refuses to do
 * (it requires confidence to be a valid enum).  That difference is why this
 * lives in the fallback, not in the primary parser.
 */
export function parsePartialIntentFrame(text: string): IntentFrame | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  // First try the primary parser — if it works, use it (no mutation).
  const primary = parseIntentFrame(text);
  if (primary !== null) return primary;

  // Try to find a JSON object in the text.
  let obj: Record<string, unknown> | null = null;
  try {
    // Quick check: does the whole text parse as JSON?
    const parsed: unknown = JSON.parse(text.trim());
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      obj = parsed as Record<string, unknown>;
    }
  } catch {
    // Not a bare JSON object — try to extract one from the text
    obj = extractLastJsonObjectPermissive(text);
  }

  if (obj === null) return null;

  const goal = typeof obj['goal'] === 'string' ? obj['goal'].trim() : '';
  if (goal.length === 0) return null;

  // Confidence: use the model's value if it looks valid, else 'low'.
  const VALID_CONFIDENCE = new Set<IntentConfidence>(['high', 'medium', 'low']);
  const rawConf = obj['confidence'];
  const confidence: IntentConfidence =
    typeof rawConf === 'string' && VALID_CONFIDENCE.has(rawConf as IntentConfidence)
      ? (rawConf as IntentConfidence)
      : 'low';

  // Synthesize a frame with what we have and cap it.
  const partial: { -readonly [K in keyof IntentFrame]?: IntentFrame[K] } = {
    version: 1,
    goal,
    confidence,
    source: 'model',
  };

  // Carry over any optional fields that happen to be present.
  if (typeof obj['kind'] === 'string' && obj['kind'].length > 0) {
    partial.kind = obj['kind'];
  }
  if (typeof obj['doneWhen'] === 'string' && obj['doneWhen'].length > 0) {
    partial.doneWhen = obj['doneWhen'];
  }
  if (Array.isArray(obj['constraints']) && (obj['constraints'] as unknown[]).length > 0) {
    partial.constraints = obj['constraints'] as string[];
  }
  if (Array.isArray(obj['nonGoals']) && (obj['nonGoals'] as unknown[]).length > 0) {
    partial.nonGoals = obj['nonGoals'] as string[];
  }
  if (Array.isArray(obj['forks']) && (obj['forks'] as unknown[]).length > 0) {
    // Cast through `readonly IntentFork[]` (the non-undefined union member) to
    // satisfy exactOptionalPropertyTypes: the mutable partial has `forks?:
    // readonly IntentFork[]` so we assign the non-undefined type directly.
    partial.forks = obj['forks'] as readonly import('./intent.js').IntentFork[];
  }
  if (typeof obj['routeTier'] === 'string') {
    // Same pattern: assign the non-undefined union member (Tier).
    partial.routeTier = obj['routeTier'] as import('./types.js').Tier;
  }
  if (typeof obj['routePlan'] === 'boolean') {
    partial.routePlan = obj['routePlan'];
  }

  return capIntentFrame(partial as IntentFrame);
}

/**
 * More permissive than `extractLastJsonObject` in intent.ts: also tolerates
 * trailing commas (the most common partial-JSON corruption) by stripping them
 * before parse.  Returns the LAST parsed object or null.  PURE; never throws.
 */
function extractLastJsonObjectPermissive(text: string): Record<string, unknown> | null {
  const end = text.lastIndexOf('}');
  if (end === -1) return null;

  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
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
      if (depth === 0) {
        let candidate = text.slice(i, end + 1);
        // Strip trailing commas before `}` or `]` (common LLM mistake).
        candidate = candidate.replace(/,(\s*[}\]])/g, '$1');
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 3 — key-marker prose extraction
// ---------------------------------------------------------------------------

/**
 * Extract a `goal` (the sole required field) from prose when the model
 * completely abandoned JSON.  Looks for lines matching common marker patterns
 * like "goal: ..." or "Goal: ..." or "**Goal**: ...".  Returns an
 * `IntentFrame` with only the goal and `confidence: 'low'`, or `null` if no
 * goal line is found.  PURE; never throws.
 *
 * This strategy is deliberately minimal: it only extracts `goal` because that
 * is the one field we can reliably locate from a prose label.  Other fields
 * (kind, constraints, etc.) are NOT guessed from prose — that would be
 * fabrication.
 */
export function parseProseIntentMarkers(text: string): IntentFrame | null {
  if (typeof text !== 'string' || text.length === 0) return null;

  const lines = text.split(/\r?\n/);

  // Patterns that reliably mark the goal line (case-insensitive):
  //   "goal: ..." / "Goal: ..." / "**Goal**: ..." / "- goal: ..."
  const GOAL_RE =
    /^(?:\s*[-*]\s*)?(?:\*{1,2})?goal(?:\*{1,2})?(?:\s*[:—-]\s*)(.+)/i;

  let goal = '';
  for (const line of lines) {
    const m = GOAL_RE.exec(line);
    if (m !== null && m[1] !== undefined) {
      goal = m[1].trim();
      if (goal.length > 0) break;
    }
  }

  if (goal.length === 0) return null;

  return capIntentFrame({
    version: 1,
    goal,
    confidence: 'low',
    source: 'model',
  });
}

// ---------------------------------------------------------------------------
// Public entry point — ordered fallback chain
// ---------------------------------------------------------------------------

/**
 * The ADDITIVE parse-from-text fallback for `IntentFrame` extraction.
 *
 * Calling contract:
 *   - Call this ONLY when `parseIntentFrame(text)` already returned `null`.
 *   - On a non-null primary parse this function must NOT be called (the
 *     flag gate in the caller enforces this).
 *   - Returns `null` when all strategies fail — the caller then uses the
 *     existing `rulesIntentFrame` deterministic fallback, unchanged.
 *   - Source on every returned frame is `'model'` — the text came from the
 *     model, even if we had to reconstruct it partially.
 *
 * Strategy order (cheapest / most reliable first):
 *   1. Fenced block: strip the fence, run the primary parser on the inner
 *      text (which is likely clean JSON), then the partial parser.
 *   2. Partial JSON: run the partial parser on the full text.
 *   3. Prose markers: extract `goal` from marker lines.
 *
 * PURE; never throws.
 */
export function parseFallbackIntentFrame(text: string | undefined): IntentFrame | null {
  if (text === undefined || text.trim().length === 0) return null;

  // Strategy 1: fenced block → try primary then partial on inner content.
  const fenced = extractFencedContent(text);
  if (fenced !== null) {
    const fromFencePrimary = parseIntentFrame(fenced);
    if (fromFencePrimary !== null) return fromFencePrimary;
    const fromFencePartial = parsePartialIntentFrame(fenced);
    if (fromFencePartial !== null) return fromFencePartial;
  }

  // Strategy 2: partial JSON in the full text (may have correct structure
  // but missing `confidence`).
  const fromPartial = parsePartialIntentFrame(text);
  if (fromPartial !== null) return fromPartial;

  // Strategy 3: prose key-value markers.
  return parseProseIntentMarkers(text);
}
