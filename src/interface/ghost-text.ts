/**
 * src/interface/ghost-text.ts — Local-first ghost text engine (P0.17–P0.18).
 *
 * Pure, synchronous suggestions for Claude Code–class inline ghost complete.
 * Layers (no model calls):
 *   1. Empty buffer → optional goal-aware hint (injected)
 *   2. Slash name / slash arg via menu-completion pure seams
 *   3. Path / @-mention via pre-resolved completeChat hits (async caller)
 *   4. History prefix match (recent submitted lines)
 *   5. Recent-accept cache
 *
 * Fail-soft: never throws. Returns null when nothing confident extends `line`.
 * Only proposes when the suggestion is a strict prefix extension of `line`
 * (never rewrites mid-token fuzzy matches as ghost — Tab multi-candidate row
 * still handles those).
 */

import {
  CHAT_SLASH_ARG_MAP,
  CHAT_SLASH_COMMANDS,
  classifyCompletion,
  completeSlash,
  completeSlashArg,
  fuzzyRank,
} from './menu-completion.js';

/** Default idle debounce before showing ghost in the composer (ms). */
export const GHOST_DEBOUNCE_MS = 300;

/** Max length for an empty-prompt goal hint. */
export const GHOST_HINT_MAX = 80;

export type GhostSource =
  | 'history'
  | 'slash'
  | 'slash-arg'
  | 'path'
  | 'mention'
  | 'goal-hint'
  | 'cache';

/**
 * A single ghost proposal. `suffix` is the dim inline tail after the typed
 * prefix; accepting sets the buffer (up to cursor) to `full`.
 */
export interface GhostSuggestion {
  readonly full: string;
  readonly suffix: string;
  readonly source: GhostSource;
}

/** Inputs for {@link proposeGhost}. All optional fields fail soft when missing. */
export interface GhostEngineInput {
  /** Buffer text up to the caret (ghost only extends this prefix). */
  readonly line: string;
  /** Recent submitted lines, oldest → newest. */
  readonly history?: readonly string[];
  /** Short empty-prompt next-action hints (goal/board inject). */
  readonly goalHints?: readonly string[];
  /** Recently accepted completions (local session cache). */
  readonly recentCompletions?: readonly string[];
  readonly commands?: readonly string[];
  readonly argMap?: Readonly<Record<string, readonly string[]>>;
  /**
   * Pre-resolved hits from `completeChat` (path / @ / optional slash).
   * Token-scoped candidates are joined with the line's token head.
   */
  readonly completionHits?: readonly string[];
}

/**
 * Propose a local ghost for `input.line`. PURE + fail-soft.
 * Priority: goal-hint (empty) → completionHits (classified) → slash pure →
 * history → recent cache. Returns null when nothing extends the line.
 */
export function proposeGhost(input: GhostEngineInput): GhostSuggestion | null {
  try {
    const line = typeof input.line === 'string' ? input.line : '';
    const commands = input.commands ?? CHAT_SLASH_COMMANDS;
    const argMap = input.argMap ?? CHAT_SLASH_ARG_MAP;

    if (line.length === 0) {
      return proposeEmptyHint(input.goalHints);
    }

    const classified = classifyCompletion(line, argMap);

    // Async-resolved path/mention (and optional slash) hits from the caller.
    if (
      input.completionHits !== undefined &&
      input.completionHits.length > 0 &&
      classified.kind !== 'none'
    ) {
      const fromHits = proposalFromHits(line, classified.prefixLen, classified.token, input.completionHits, sourceForKind(classified.kind));
      if (fromHits) return fromHits;
    }

    if (classified.kind === 'slash-name') {
      const fromSlash = proposeSlashName(line, commands);
      if (fromSlash) return fromSlash;
    }

    if (classified.kind === 'slash-arg' && classified.command) {
      const fromArg = proposeSlashArg(line, classified.prefixLen, classified.token, classified.command, argMap);
      if (fromArg) return fromArg;
    }

    // Plain prose (and free-text slash args): history then recent cache.
    if (classified.kind === 'none' || classified.kind === 'slash-name') {
      // slash-name already tried above; history can still complete a partial
      // free-form line that happens to start with '/' only if classified none.
    }
    const fromHistory = matchPrefixList(line, input.history ?? [], 'history');
    if (fromHistory) return fromHistory;

    const fromCache = matchPrefixList(line, input.recentCompletions ?? [], 'cache');
    if (fromCache) return fromCache;

    return null;
  } catch {
    return null;
  }
}

/**
 * Accept a ghost into a buffer: replace `lineToCursor` with `ghost.full`, keep
 * text to the right of the caret. PURE.
 */
export function applyGhost(
  value: string,
  cursor: number,
  ghost: GhostSuggestion,
): { value: string; cursor: number } {
  const head = ghost.full;
  const tail = value.slice(cursor);
  const next = head + tail;
  return { value: next, cursor: head.length };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function proposeEmptyHint(goalHints: readonly string[] | undefined): GhostSuggestion | null {
  if (!goalHints || goalHints.length === 0) return null;
  for (const raw of goalHints) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim().slice(0, GHOST_HINT_MAX);
    if (text.length === 0) continue;
    return { full: text, suffix: text, source: 'goal-hint' };
  }
  return null;
}

function proposeSlashName(line: string, commands: readonly string[]): GhostSuggestion | null {
  const [prefixHits] = completeSlash(line, commands);
  let ranked = prefixHits;
  if (ranked.length === 0 && line.startsWith('/')) {
    ranked = fuzzyRank(line.slice(1), commands.map((c) => c.slice(1))).map((h) => `/${h}`);
  }
  return firstPrefixExtension(line, ranked, 'slash');
}

function proposeSlashArg(
  line: string,
  prefixLen: number,
  token: string,
  command: string,
  argMap: Readonly<Record<string, readonly string[]>>,
): GhostSuggestion | null {
  const hits = completeSlashArg(command, token, argMap);
  if (hits.length === 0) return null;
  // Ghost extends the whole line-to-cursor via token head + hit.
  for (const hit of hits) {
    if (typeof hit !== 'string' || hit.length === 0) continue;
    const full = line.slice(0, prefixLen) + hit;
    if (full.startsWith(line) && full.length > line.length) {
      return { full, suffix: full.slice(line.length), source: 'slash-arg' };
    }
  }
  return null;
}

function proposalFromHits(
  line: string,
  prefixLen: number,
  token: string,
  hits: readonly string[],
  source: GhostSource,
): GhostSuggestion | null {
  for (const hit of hits) {
    if (typeof hit !== 'string' || hit.length === 0) continue;
    // completeChat returns either full slash lines or token-scoped path/@ hits.
    const full =
      source === 'slash' && hit.startsWith('/')
        ? hit
        : line.slice(0, prefixLen) + hit;
    // When hit already includes display prefix (path/mention), prefer head+hit
    // only if hit looks like a token replacement (starts with token or extends it).
    const candidate =
      full.startsWith(line) && full.length > line.length
        ? full
        : hit.startsWith(line) && hit.length > line.length
          ? hit
          : hit.startsWith(token) && line.slice(0, prefixLen) + hit !== line
            ? (() => {
                const f = line.slice(0, prefixLen) + hit;
                return f.startsWith(line) && f.length > line.length ? f : null;
              })()
            : null;
    if (candidate) {
      return { full: candidate, suffix: candidate.slice(line.length), source };
    }
  }
  return null;
}

function firstPrefixExtension(
  line: string,
  candidates: readonly string[],
  source: GhostSource,
): GhostSuggestion | null {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    if (c.startsWith(line) && c.length > line.length) {
      return { full: c, suffix: c.slice(line.length), source };
    }
  }
  return null;
}

/** Most-recent-first prefix match over a list of prior strings. */
function matchPrefixList(
  line: string,
  list: readonly string[],
  source: GhostSource,
): GhostSuggestion | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const h = list[i];
    if (typeof h !== 'string') continue;
    if (h.startsWith(line) && h.length > line.length) {
      return { full: h, suffix: h.slice(line.length), source };
    }
  }
  return null;
}

function sourceForKind(kind: string): GhostSource {
  switch (kind) {
    case 'slash-name':
      return 'slash';
    case 'slash-arg':
      return 'slash-arg';
    case 'path':
      return 'path';
    case 'mention':
      return 'mention';
    default:
      return 'cache';
  }
}
