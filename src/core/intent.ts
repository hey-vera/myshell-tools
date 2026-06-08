/**
 * src/core/intent.ts — the PURE intent-frame core (intent-engine-5.5.md §3, §5).
 *
 * An `IntentFrame` is the small, typed representation of what the user is
 * actually trying to achieve this turn — goal, scope, constraints, the 1–3
 * genuine forks, what "done" looks like, and a confidence. It is the shared
 * artifact every downstream consumer (persona reflection, ask_user, work-contract
 * seed, engagement policy) reads, replacing the ad-hoc "{tier, risk} + a prose
 * hope" understanding the system had before.
 *
 * This module is PURE: no I/O, no time, no randomness (the `test/arch/guards.ts`
 * purity guard). The model call that *populates* a frame on substantial turns
 * lives in the injected `IntentExtractor` port, realized by the thin composer
 * `makeIntentExtractor` in `src/core/intent-extractor.ts` — a near-twin of
 * `route-classifier.ts`. On every other turn the frame comes from the
 * deterministic `rulesIntentFrame`. The discipline mirrors `router.ts` exactly:
 * the gate skips the call on clear/cheap turns, the parser returns `null` on any
 * shape violation, and every failure falls back to rules — never a hang, never a
 * blocked turn.
 */

import type { Classification, Tier } from './types.js';

// ---------------------------------------------------------------------------
// The frame shape (§3)
// ---------------------------------------------------------------------------

/** How sure the extractor is that it understood the user's actual goal. */
export type IntentConfidence = 'high' | 'medium' | 'low';

/** A single genuine decision fork: different answers materially change the result. */
export interface IntentFork {
  /** Stable key, reusable as an ask_user question id. */
  readonly id: string;
  /** The fork, in plain language. */
  readonly question: string;
  /** 2–4 candidate answers when enumerable. */
  readonly options?: readonly string[];
  /** The default to STATE-and-proceed when unasked (research #4). */
  readonly assumeIfUnasked?: string;
}

export interface IntentFrame {
  readonly version: 1;
  /** The user's intended OUTCOME in one line — free text, NOT a closed class. */
  readonly goal: string;
  /** Kind of work, for posture/routing nudges. Open vocab, lowercased. */
  readonly kind?: string;
  /** What is explicitly OUT of scope / a non-goal, when the user signaled one. */
  readonly nonGoals?: readonly string[];
  /** Hard constraints the work must respect (max ~3). */
  readonly constraints?: readonly string[];
  /** Genuine forks worth a question OR a stated assumption (max ~3). */
  readonly forks?: readonly IntentFork[];
  /** What "done" looks like — the success criterion, when one is inferable. */
  readonly doneWhen?: string;
  /** Extractor's confidence it understood the GOAL (not correctness of the work). */
  readonly confidence: IntentConfidence;
  /** Provenance for transparency + tests. */
  readonly source: 'model' | 'rules-fallback' | 'skipped';
}

/**
 * Token usage of an extraction run (tokens-not-dollars contract). Typed inline
 * (structurally identical to providers/port `Usage`) to keep intent.ts a PURE
 * leaf module with no provider import.
 */
export interface IntentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * What an {@link IntentExtractor} resolves to. Backward-compatible UNION: a bare
 * `IntentFrame | null` (every existing caller/mock), OR an object carrying the
 * frame plus the REAL measured token `usage` of the extraction run (the brain's
 * codebase-scrape round threads this onto its `tier-done` — tokens-not-dollars,
 * never a hardcoded 0). Normalize with {@link normalizeExtraction}.
 */
export type IntentExtraction =
  | IntentFrame
  | null
  | { readonly frame: IntentFrame | null; readonly usage?: IntentUsage };

/**
 * The injected port (mirrors `ModelClassifier`, `router.ts:59-62`). Given a task,
 * returns a parsed frame (optionally with usage), or `null` on ANY failure (no
 * extractor, parse error, timeout, garbled output). Never throws — the caller
 * falls back to rules.
 */
export type IntentExtractor = (
  task: string,
  signal: AbortSignal,
) => Promise<IntentExtraction>;

/**
 * Normalize an {@link IntentExtraction} to `{ frame, usage }`. Accepts the bare
 * `IntentFrame | null` legacy shape (usage undefined) or the richer object shape.
 * PURE; never throws.
 */
export function normalizeExtraction(
  r: IntentExtraction,
): { frame: IntentFrame | null; usage?: IntentUsage } {
  if (r === null) return { frame: null };
  if ('frame' in r) return r.usage !== undefined ? { frame: r.frame, usage: r.usage } : { frame: r.frame };
  return { frame: r };
}

// ---------------------------------------------------------------------------
// Caps (mirror work-contract.ts) — defensive, never throw
// ---------------------------------------------------------------------------

const GOAL_LIMIT = 240;
const LIST_ITEM_LIMIT = 160;
const DONE_LIMIT = 240;
const KIND_LIMIT = 32;
const FORK_QUESTION_LIMIT = 160;
const FORK_OPTION_LIMIT = 120;
const FORK_ASSUME_LIMIT = 160;
const FORK_ID_LIMIT = 48;
const MAX_LIST = 3;
const MAX_FORKS = 3;
const MAX_OPTIONS = 4;

const VALID_CONFIDENCE: ReadonlySet<string> = new Set<IntentConfidence>([
  'high',
  'medium',
  'low',
]);

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function capText(value: unknown, limit: number): string {
  return safeString(value).trim().slice(0, limit);
}

function capStringList(value: unknown, limit: number, maxItems: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const s = capText(raw, limit);
    if (s.length > 0) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function capFork(value: unknown, index: number): IntentFork | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const question = capText(raw['question'], FORK_QUESTION_LIMIT);
  if (question.length === 0) return null;
  const idRaw = capText(raw['id'], FORK_ID_LIMIT);
  const id = idRaw.length > 0 ? idRaw : `F${index + 1}`;
  const options = capStringList(raw['options'], FORK_OPTION_LIMIT, MAX_OPTIONS);
  const assume = capText(raw['assumeIfUnasked'], FORK_ASSUME_LIMIT);
  const fork: {
    -readonly [K in keyof IntentFork]?: IntentFork[K];
  } = { id, question };
  if (options.length > 0) fork.options = options;
  if (assume.length > 0) fork.assumeIfUnasked = assume;
  return fork as IntentFork;
}

function capForks(value: unknown): readonly IntentFork[] {
  if (!Array.isArray(value)) return [];
  const out: IntentFork[] = [];
  for (let i = 0; i < value.length && out.length < MAX_FORKS; i++) {
    const fork = capFork(value[i], out.length);
    if (fork !== null) out.push(fork);
  }
  return out;
}

/**
 * Return a deterministic, capped copy of a frame. Defensive at runtime — never
 * throws on malformed values. Twin of `capContract` (`work-contract.ts:84`).
 * The `source` is preserved when valid; otherwise treated as a model frame.
 */
export function capIntentFrame(frame: IntentFrame): IntentFrame {
  const rawValue = frame as unknown;
  const raw =
    rawValue !== null && typeof rawValue === 'object'
      ? (rawValue as Record<string, unknown>)
      : {};

  const goal = capText(raw['goal'], GOAL_LIMIT);
  const confidenceRaw = raw['confidence'];
  const confidence: IntentConfidence =
    typeof confidenceRaw === 'string' && VALID_CONFIDENCE.has(confidenceRaw)
      ? (confidenceRaw as IntentConfidence)
      : 'low';
  const sourceRaw = raw['source'];
  const source: IntentFrame['source'] =
    sourceRaw === 'model' || sourceRaw === 'rules-fallback' || sourceRaw === 'skipped'
      ? sourceRaw
      : 'model';

  const kind = capText(raw['kind'], KIND_LIMIT).toLowerCase();
  const nonGoals = capStringList(raw['nonGoals'], LIST_ITEM_LIMIT, MAX_LIST);
  const constraints = capStringList(raw['constraints'], LIST_ITEM_LIMIT, MAX_LIST);
  const forks = capForks(raw['forks']);
  const doneWhen = capText(raw['doneWhen'], DONE_LIMIT);

  const out: { -readonly [K in keyof IntentFrame]?: IntentFrame[K] } = {
    version: 1,
    goal,
    confidence,
    source,
  };
  if (kind.length > 0) out.kind = kind;
  if (nonGoals.length > 0) out.nonGoals = nonGoals;
  if (constraints.length > 0) out.constraints = constraints;
  if (forks.length > 0) out.forks = forks;
  if (doneWhen.length > 0) out.doneWhen = doneWhen;
  return out as IntentFrame;
}

// ---------------------------------------------------------------------------
// The extractor prompt + parser (mirror router.ts buildRouterPrompt/parseModelRoute)
// ---------------------------------------------------------------------------

/**
 * Build the one-shot intent-extraction prompt. Deliberately small and read-only:
 * the extractor model only buckets understanding, it never does the work. The
 * strict JSON-only instruction keeps {@link parseIntentFrame} robust.
 */
export function buildIntentPrompt(task: string): string {
  return [
    'You extract the INTENT of a user message for a CLI work assistant. Read the',
    'message and produce a small structured frame of what the user is actually',
    'trying to achieve. Do NOT do the work or answer the message.',
    '',
    'Fill these fields (omit any you genuinely cannot infer — do NOT invent):',
    '  goal       — the intended OUTCOME in one line (free text, required).',
    '  kind       — one lowercase word: coding | writing | research | ops | planning | design | other.',
    '  constraints— up to 3 hard limits the work must respect (e.g. "Node 22", "no paid APIs").',
    '  nonGoals   — up to 3 things explicitly OUT of scope, when the user signaled one.',
    '  doneWhen   — what "done" looks like, when inferable.',
    '  forks      — up to 3 GENUINE decision forks whose different answers would',
    '               MATERIALLY change the result. For each: a short question, 2-4',
    '               options when enumerable, and assumeIfUnasked (the reasonable',
    '               default to state and proceed on if not asked). Do NOT list minor',
    '               uncertainties — only real forks.',
    '  confidence — high | medium | low: how sure you are you understood the GOAL.',
    '',
    'Reply with ONLY a JSON object, nothing else:',
    '{"goal":"...","kind":"coding","constraints":[],"nonGoals":[],"doneWhen":"",',
    ' "forks":[{"id":"F1","question":"...","options":["a","b"],"assumeIfUnasked":"a"}],',
    ' "confidence":"medium"}',
    '',
    `Message: ${task}`,
  ].join('\n');
}

/**
 * Parse an extractor-model reply into a capped {@link IntentFrame}, or `null` if
 * it can't be trusted. Tolerant of prose around the JSON (extracts the last
 * balanced `{...}` span) but strict about the SHAPE: a non-empty `goal` and a
 * valid `confidence` enum are required; oversized lists are CAPPED not rejected;
 * extra keys are ignored. Never throws on garbage. Mirrors `parseModelRoute`.
 */
export function parseIntentFrame(text: string | undefined): IntentFrame | null {
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
  const goal = capText(obj['goal'], GOAL_LIMIT);
  if (goal.length === 0) return null;

  const confidence = obj['confidence'];
  if (typeof confidence !== 'string' || !VALID_CONFIDENCE.has(confidence)) return null;

  return capIntentFrame({
    version: 1,
    goal,
    kind: capText(obj['kind'], KIND_LIMIT),
    nonGoals: capStringList(obj['nonGoals'], LIST_ITEM_LIMIT, MAX_LIST),
    constraints: capStringList(obj['constraints'], LIST_ITEM_LIMIT, MAX_LIST),
    forks: capForks(obj['forks']),
    doneWhen: capText(obj['doneWhen'], DONE_LIMIT),
    confidence: confidence as IntentConfidence,
    source: 'model',
  });
}

/**
 * Return the substring of the last balanced top-level `{...}` object in `text`,
 * or `null`. Brace-aware over double-quoted strings so a brace inside a field
 * can't fool the matcher. Copied in spirit from `router.ts` (kept local to keep
 * the module self-contained and the parser identical in discipline).
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
// Deterministic rules fallback (§5.5) — pure, never a model call
// ---------------------------------------------------------------------------

/** Open-vocab kind nudges from cheap keyword scans (deterministic). */
const KIND_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(write|writing|draft|essay|blog|copy|prose|article|email)\b/i, 'writing'],
  [/\b(research|investigate|compare|survey|find out|look up)\b/i, 'research'],
  [/\b(deploy|migrate|ops|server|infra|provision|rollout|pipeline|ci|cd)\b/i, 'ops'],
  [/\b(plan|roadmap|strategy|architecture|design the|approach)\b/i, 'planning'],
  [/\b(design|ui|ux|layout|look and feel|feel like|aesthetic|theme)\b/i, 'design'],
  [/\b(code|build|implement|fix|refactor|debug|function|class|api|bug|test)\b/i, 'coding'],
];

/** Infer a coarse kind from the task text. Pure; returns '' when no hint fires. */
function inferKind(task: string): string {
  for (const [re, kind] of KIND_HINTS) {
    if (re.test(task)) return kind;
  }
  return '';
}

/** First sentence/line of the task, capped — a deterministic goal placeholder. */
function deriveGoal(task: string): string {
  const trimmed = task.trim();
  if (trimmed.length === 0) return '';
  // First line, then first sentence within it.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  const firstSentence = firstLine.split(/(?<=[.!?])\s/, 1)[0] ?? firstLine;
  return firstSentence.slice(0, GOAL_LIMIT);
}

function confidenceForTier(tier: Tier): IntentConfidence {
  // The rules frame never claims to have *understood* the goal: worker turns are
  // usually clear (the goal IS the task), manager turns are usually fuzzy.
  switch (tier) {
    case 'worker':
      return 'medium';
    case 'manager':
      return 'low';
    case 'ic':
    default:
      return 'low';
  }
}

/**
 * Build a deterministic {@link IntentFrame} from the raw task + classification —
 * the fail-soft fallback used whenever the model extractor is skipped, absent, or
 * fails. PURE: no model call, no I/O. `source` is `'rules-fallback'` by default;
 * callers may pass `'skipped'` for the gate-skip path. Never throws.
 *
 * @param task           - The raw user message.
 * @param classification - The {tier, risk} from `classify`/`decideRoute`.
 * @param source         - Provenance ('rules-fallback' on failure, 'skipped' on gate-skip).
 */
export function rulesIntentFrame(
  task: string,
  classification: Classification,
  source: 'rules-fallback' | 'skipped' = 'rules-fallback',
): IntentFrame {
  const goal = deriveGoal(task);
  const kind = inferKind(task);
  const out: { -readonly [K in keyof IntentFrame]?: IntentFrame[K] } = {
    version: 1,
    goal,
    confidence: confidenceForTier(classification.tier),
    source,
  };
  if (kind.length > 0) out.kind = kind;
  return capIntentFrame(out as IntentFrame);
}

// ---------------------------------------------------------------------------
// The gate (§5.2) — when the model pass runs vs. is skipped. PURE.
// ---------------------------------------------------------------------------

/**
 * A cheap length+structure heuristic for "substantial / multi-clause" — the same
 * spirit as the partner doc's substantial-task test. NOT a model call. A turn is
 * non-trivial when it is long enough OR has multiple clauses (commas / "and" /
 * "then" / newlines / bullet markers).
 */
function isMultiClauseOrLong(task: string): boolean {
  const t = task.trim();
  if (t.length >= 180) return true;
  const clauseMarkers = (t.match(/[,;]| and | then |\n|^\s*[-*]\s/gim) ?? []).length;
  return clauseMarkers >= 2;
}

import type { PartnerStyle } from './prompt-context.js';

export interface ShouldExtractIntentInput {
  readonly task: string;
  readonly classification: Classification;
  readonly routePlan: boolean;
  readonly partnerStyle?: PartnerStyle;
  /** Whether an `IntentExtractor` is actually wired this turn. */
  readonly hasExtractor: boolean;
}

/**
 * The pure gate — the intent analogue of `hasTierEvidence` (`classify.ts:278`).
 * Returns true ONLY when the turn is substantial or ambiguous enough that a frame
 * earns its keep, AND an extractor is wired. Clear/cheap turns return false and
 * stay instant (zero added model call). Mirrors the router's free-fast-path
 * discipline (`router.ts:207`). PURE; never throws.
 *
 * Runs when ANY of: `routePlan` (the router judged a plan would help), the tier
 * is `manager`, the task is multi-clause/long, or the user opted into
 * `collaborative` alignment. Never runs on a `direct` non-substantial turn (the
 * user opted OUT of alignment overhead), and never runs without an extractor.
 */
export function shouldExtractIntent(input: ShouldExtractIntentInput): boolean {
  if (!input.hasExtractor) return false;
  if (input.task.trim().length === 0) return false;

  const substantial =
    input.routePlan ||
    input.classification.tier === 'manager' ||
    isMultiClauseOrLong(input.task);

  if (input.partnerStyle === 'collaborative') {
    // Opted into more alignment — run on any non-trivial turn. A truly trivial
    // turn (worker tier, no plan, short, single-clause) still skips, so "what
    // time is it?" stays instant even for collaborative users.
    return substantial || input.classification.tier !== 'worker';
  }
  if (input.partnerStyle === 'direct' && !substantial) {
    // Opted out of alignment overhead on non-substantial turns.
    return false;
  }
  return substantial;
}

// ---------------------------------------------------------------------------
// The INTENT block renderer (§5.4) — pre-rendered string for the prompt seam
// ---------------------------------------------------------------------------

/**
 * Render the pre-rendered INTENT block for the prompt seam
 * (`assembleContextBlocks`). Returns '' for an empty/goalless frame so a vacuous
 * frame injects nothing (byte-identical to no-frame). Shows the goal + scope +
 * doneWhen as the model's *current understanding to reflect briefly, not parrot*.
 * PURE string builder.
 */
export function renderIntentBlock(frame: IntentFrame | undefined): string {
  if (frame === undefined) return '';
  const goal = frame.goal.trim();
  if (goal.length === 0) return '';

  const lines: string[] = [
    'INTENT (your current understanding — reflect briefly in one line, do not parrot):',
    `- Goal: ${goal}`,
  ];
  if (frame.kind !== undefined && frame.kind.length > 0) {
    lines.push(`- Kind: ${frame.kind}`);
  }
  if (frame.constraints !== undefined && frame.constraints.length > 0) {
    lines.push(`- Constraints: ${frame.constraints.join('; ')}`);
  }
  if (frame.nonGoals !== undefined && frame.nonGoals.length > 0) {
    lines.push(`- Out of scope: ${frame.nonGoals.join('; ')}`);
  }
  if (frame.doneWhen !== undefined && frame.doneWhen.length > 0) {
    lines.push(`- Done when: ${frame.doneWhen}`);
  }
  if (frame.forks !== undefined && frame.forks.length > 0) {
    lines.push('- Open forks (state your assumption and proceed unless told to ask):');
    for (const fork of frame.forks) {
      const assume =
        fork.assumeIfUnasked !== undefined && fork.assumeIfUnasked.length > 0
          ? ` — assume: ${fork.assumeIfUnasked}`
          : '';
      lines.push(`  - ${fork.question}${assume}`);
    }
  }
  return lines.join('\n');
}
