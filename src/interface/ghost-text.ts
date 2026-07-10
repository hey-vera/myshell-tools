/**
 * src/interface/ghost-text.ts — Local-first ghost text engine (P0.17–P0.18)
 * plus pure helpers for optional budgeted model ghost (P1.5).
 *
 * Pure, synchronous suggestions for Claude Code–class inline ghost complete.
 * Layers (local; no model calls inside proposeGhost):
 *   1. Empty buffer → optional goal-aware hint (injected)
 *   2. Slash name / slash arg via menu-completion pure seams
 *   3. Path / @-mention via pre-resolved completeChat hits (async caller)
 *   4. History prefix match (recent submitted lines)
 *   5. Recent-accept cache
 *
 * Optional model fallback (P1.5) is async + injected: the caller only asks a
 * model after local layers return null AND `modelGhost` is enabled. Helpers
 * here stay pure (prompt build, parse, precedence, gate).
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
import {
  MODEL_GHOST_MAX_SUFFIX,
  MODEL_GHOST_TIMEOUT_MS,
  buildModelGhostPrompt,
  type SuggestGhost,
} from '../core/model-ghost.js';

export {
  MODEL_GHOST_TIMEOUT_MS,
  MODEL_GHOST_MAX_SUFFIX,
  buildModelGhostPrompt,
  type SuggestGhost,
};

/** Default idle debounce before showing ghost in the composer (ms). */
export const GHOST_DEBOUNCE_MS = 300;

/** Max length for an empty-prompt goal hint. */
export const GHOST_HINT_MAX = 80;

/**
 * Minimum typed length before model ghost may fire (empty buffer is allowed —
 * empty uses goalHints first; model only when those also miss).
 */
export const MODEL_GHOST_MIN_PREFIX = 2;

export type GhostSource =
  | 'history'
  | 'slash'
  | 'slash-arg'
  | 'path'
  | 'mention'
  | 'goal-hint'
  | 'cache'
  | 'model';

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
// Optional model ghost (P1.5) — pure helpers
// ---------------------------------------------------------------------------

/**
 * Local always wins. Model only when enabled and local is empty. PURE.
 */
export function resolveGhostPrecedence(opts: {
  readonly local: GhostSuggestion | null;
  readonly model: GhostSuggestion | null;
  readonly modelEnabled: boolean;
}): GhostSuggestion | null {
  if (opts.local !== null) return opts.local;
  if (opts.modelEnabled && opts.model !== null) return opts.model;
  return null;
}

/**
 * Gate for whether the composer may request a model ghost. PURE + fail-soft.
 * Requires: toggle on, no local hit, caret-ready prose/empty (not slash/path
 * multi-candidate territory), and enough prefix (or empty).
 */
export function shouldOfferModelGhost(opts: {
  readonly enabled: boolean;
  readonly local: GhostSuggestion | null;
  readonly line: string;
  /** From classifyCompletion; absent → treat as 'none'. */
  readonly kind?: string;
}): boolean {
  try {
    if (opts.enabled !== true) return false;
    if (opts.local !== null) return false;
    const line = typeof opts.line === 'string' ? opts.line : '';
    const kind = opts.kind ?? 'none';
    // Local layers own slash/path/mention/arg completions — never race model.
    if (kind !== 'none') return false;
    if (line.length === 0) return true;
    if (line.length < MODEL_GHOST_MIN_PREFIX) return false;
    // Skip multi-line compose for model ghost (cheap, single-line only).
    if (line.includes('\n')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a model reply into a ghost suggestion. Accepts suffix-only or full-line
 * replies. PURE + fail-soft → null on garbage.
 */
export function parseModelGhostCompletion(
  line: string,
  raw: string | undefined,
): GhostSuggestion | null {
  try {
    if (raw === undefined || typeof raw !== 'string') return null;
    const prefix = typeof line === 'string' ? line : '';
    // Preserve leading spaces on pure suffixes (" world"); only strip trailing
    // noise and common wrappers. Full-line replies are rtrimmed after match.
    let text = raw.replace(/\r\n/g, '\n');
    if (text.length === 0) return null;

    // Strip common wrappers: ```…```, surrounding quotes (whole reply).
    const trimmedProbe = text.trim();
    if (trimmedProbe.startsWith('```')) {
      const body = trimmedProbe.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
      text = body;
    } else if (
      (trimmedProbe.startsWith('"') && trimmedProbe.endsWith('"') && trimmedProbe.length >= 2) ||
      (trimmedProbe.startsWith("'") && trimmedProbe.endsWith("'") && trimmedProbe.length >= 2)
    ) {
      text = trimmedProbe.slice(1, -1);
    }
    // Single line only (keep leading space on that line).
    const nl = text.indexOf('\n');
    if (nl !== -1) text = text.slice(0, nl);
    text = text.replace(/\s+$/u, ''); // rtrim only
    if (text.length === 0) return null;

    let full: string;
    const asFull = text.trimStart(); // full-line candidates ignore leading pad
    if (asFull.startsWith(prefix) && asFull.length > prefix.length) {
      full = asFull;
    } else if (prefix.length === 0) {
      full = asFull;
    } else {
      // Pure suffix — keep leading whitespace from the model reply.
      full = prefix + text;
    }

    // Cap new characters.
    if (full.length > prefix.length + MODEL_GHOST_MAX_SUFFIX) {
      full = full.slice(0, prefix.length + MODEL_GHOST_MAX_SUFFIX);
    }
    if (!full.startsWith(prefix) || full.length <= prefix.length) return null;
    // Empty-prompt: also cap absolute length like goal hints.
    if (prefix.length === 0 && full.length > GHOST_HINT_MAX) {
      full = full.slice(0, GHOST_HINT_MAX);
    }
    const suffix = full.slice(prefix.length);
    if (suffix.trim().length === 0) return null;
    return { full, suffix, source: 'model' };
  } catch {
    return null;
  }
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
