/**
 * src/core/taste.ts — the PURE core of the LEARNED-TASTE LEDGER (Phase 7, the
 * "free layer" of the judgment axis; .tmp-master-judgment.md Part 4).
 *
 * This module owns the SCHEMA of an observed taste signal + the deterministic,
 * never-throwing, no-I/O DISTILL that turns a raw append-only event log into:
 *   - a `memoryBias: -1 | 0 | 1` (the already-wired ask-vs-proceed dial on
 *     `EngagementSignals.memoryBias`, currently unfed — engagement.ts:73), and
 *   - a bounded, ACE-style **taste playbook** context block injected at prompt
 *     assembly so the model reasons WITH the user's recorded taste in scope.
 *
 * HONESTY FLOOR (judgment doc §4.2 / §6.2.5): a taste fact records ONLY a signal
 * the system ACTUALLY OBSERVED — a fork the user picked, a push-back they
 * accepted/rejected, a proposal they accepted unchanged vs. immediately edited, a
 * goal they immediately rephrased. NEVER an inferred opinion. The schema has no
 * field for sentiment; every event carries the seam it was observed at.
 *
 * PURITY: no I/O, no clock, no randomness, no Node builtins. Every export is
 * deterministic and NEVER throws — on bad input it returns a safe default (a
 * neutral bias / an empty playbook / a dropped event). The infra layer
 * (src/infra/taste-ledger.ts) owns all I/O and passes a `now` ISO string in.
 */

// ===========================================================================
// Schema — an OBSERVED decision signal (never inferred)
// ===========================================================================

/**
 * The observed-signal taxonomy. Each member maps 1:1 to a REAL seam the partner
 * already has (judgment doc §4.2 table); there is no "the user probably likes"
 * member by construction.
 */
export type TasteSignal =
  /** The option the user picked on a genuine fork (questions.ts selector answer). */
  | 'fork_choice'
  /** A push-back the user ACCEPTED (took the partner's alternative). */
  | 'pushback_accept'
  /** A push-back the user REJECTED (stuck with their original ask). */
  | 'pushback_reject'
  /** A reflect_confirm proposal the user accepted unchanged ("Go"). */
  | 'accept_unchanged'
  /** A proposal/answer the user immediately Edited / corrected. */
  | 'immediate_edit'
  /** The next turn re-states the same goal differently (a strong miss signal). */
  | 'immediate_rephrase';

/** Whether an event leans the dial toward proceeding, toward asking, or neither. */
export type TasteLean = 'proceed' | 'ask' | 'neutral';

/**
 * One append-only taste event (the JSONL line shape). `source` is always
 * `'observed'` — the schema cannot express anything else, which is the honesty
 * guarantee made structural. `subject` is a short, free-form decision label (e.g.
 * "server-vs-client data"); `choice` is the user's actual call on it. Both are
 * bounded at the infra write boundary.
 */
export interface TasteEvent {
  /** Schema version (forward-compat). */
  readonly v: 1;
  /** ISO timestamp the event was observed (injected clock — never wall-clock). */
  readonly ts: string;
  /** Privacy-preserving project key (deriveProjectKey) or null for global. */
  readonly projectKey: string | null;
  /** The observed signal class. */
  readonly signal: TasteSignal;
  /** Short decision label this signal is about. */
  readonly subject: string;
  /** The user's actual call (the fork option, the accepted alternative, …). */
  readonly choice: string;
  /** Optional one-line context (e.g. the original ask a push-back replaced). */
  readonly detail?: string;
  /** ALWAYS 'observed' — the honesty floor made structural. */
  readonly source: 'observed';
}

/** Bounds shared by the infra writer; keep a taste line small + cheap. */
export const TASTE_SUBJECT_MAX = 120;
const TASTE_CHOICE_MAX = 160;
const TASTE_DETAIL_MAX = 160;

/** Cap on how many events the distill scans / a ledger retains (newest-first). */
export const TASTE_LEDGER_MAX = 500;

/**
 * Validate + normalize a candidate event into a storable `TasteEvent`, or null
 * when it is not a real observed signal (the write boundary's honesty gate).
 * Pure; never throws. Rejects: a missing/blank subject or choice, an unknown
 * signal, or an out-of-vocabulary `source`.
 */
export function normalizeTasteEvent(
  raw: {
    signal: TasteSignal;
    subject: string;
    choice: string;
    detail?: string;
    projectKey?: string | null;
  },
  nowIso: string,
): TasteEvent | null {
  try {
    if (raw === null || typeof raw !== 'object') return null;
    if (!isTasteSignal(raw.signal)) return null;
    const subject = boundedTrim(raw.subject, TASTE_SUBJECT_MAX);
    if (subject === null) return null;
    const choice = boundedTrim(raw.choice, TASTE_CHOICE_MAX);
    if (choice === null) return null;
    const detail = raw.detail === undefined ? undefined : boundedTrim(raw.detail, TASTE_DETAIL_MAX);
    const projectKey =
      typeof raw.projectKey === 'string' && raw.projectKey.length > 0 ? raw.projectKey : null;
    return {
      v: 1,
      ts: typeof nowIso === 'string' && nowIso.length > 0 ? nowIso : '',
      projectKey,
      signal: raw.signal,
      subject,
      choice,
      ...(detail !== undefined && detail !== null ? { detail } : {}),
      source: 'observed',
    };
  } catch {
    return null;
  }
}

const TASTE_SIGNALS: ReadonlySet<string> = new Set<TasteSignal>([
  'fork_choice',
  'pushback_accept',
  'pushback_reject',
  'accept_unchanged',
  'immediate_edit',
  'immediate_rephrase',
]);

/** Type guard for a stored/parsed event's `signal`. Pure. */
export function isTasteSignal(s: unknown): s is TasteSignal {
  return typeof s === 'string' && TASTE_SIGNALS.has(s);
}

/**
 * Type guard for a parsed JSONL line being a well-formed `TasteEvent`. Used by
 * the infra reader to skip corrupt/foreign lines (fail-soft). Pure; never throws.
 */
export function isTasteEvent(v: unknown): v is TasteEvent {
  try {
    if (v === null || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return (
      e['v'] === 1 &&
      typeof e['ts'] === 'string' &&
      (e['projectKey'] === null || typeof e['projectKey'] === 'string') &&
      isTasteSignal(e['signal']) &&
      typeof e['subject'] === 'string' &&
      typeof e['choice'] === 'string' &&
      (e['detail'] === undefined || typeof e['detail'] === 'string') &&
      e['source'] === 'observed'
    );
  } catch {
    return false;
  }
}

function boundedTrim(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// ===========================================================================
// Distill — events → { memoryBias, playbook }
// ===========================================================================

/**
 * The distilled "taste playbook": a bounded, ranked set of the user's recurring
 * recorded calls + the ask-vs-proceed bias derived from their accept/correct
 * history. This is the ONLY thing recall hands to the wiring layer.
 */
export interface TastePlaybook {
  /**
   * The ask-vs-proceed nudge for `EngagementSignals.memoryBias` (engagement.ts).
   * +1 = lean PROCEED (the user keeps accepting our calls → ask less); -1 = lean
   * ASK (the user keeps correcting us → confirm once more); 0 = no evidence.
   * Bounded to ±1 by construction (a calibration, never a takeover, §4.3.1).
   */
  readonly memoryBias: -1 | 0 | 1;
  /**
   * Distilled, ranked taste lines (most-supported first), already capped for the
   * prompt block. Each is `<subject>: <the call the user keeps making>`.
   */
  readonly lines: readonly string[];
}

/** An empty/neutral playbook — what recall returns with no evidence (or flag OFF). */
export const EMPTY_PLAYBOOK: TastePlaybook = { memoryBias: 0, lines: [] };

/** How many proceed-minus-ask net events tip the dial. */
const BIAS_THRESHOLD = 2;
/** Max distilled lines in a playbook (prompt-altitude cap). */
const MAX_PLAYBOOK_LINES = 6;
/** A subject needs this many supporting events before it earns a playbook line. */
const MIN_SUPPORT = 1;

/** Which way an observed signal leans the ask-vs-proceed dial. Pure. */
export function leanOf(signal: TasteSignal): TasteLean {
  switch (signal) {
    // The user took our call as-is / accepted our push-back → we read them well;
    // we can afford to PROCEED more (ask one less).
    case 'accept_unchanged':
    case 'pushback_accept':
      return 'proceed';
    // The user corrected us / rephrased / rejected our push-back → we misread;
    // confirm once more before barreling ahead.
    case 'immediate_edit':
    case 'immediate_rephrase':
    case 'pushback_reject':
      return 'ask';
    // A fork choice is taste signal but ask-vs-proceed neutral (they DID want the ask).
    case 'fork_choice':
    default:
      return 'neutral';
  }
}

interface SubjectAgg {
  subject: string;
  choice: string;
  support: number;
  /** Most-recent ts seen for this (subject) — for recency tie-break. */
  lastTs: string;
}

/**
 * Distill an event log into a `TastePlaybook`, scoped to the current project
 * (a fact with `projectKey === null` is global and always eligible; a
 * project-scoped fact rides only when its key matches `projectKey`). Deterministic,
 * no I/O, no embeddings — a count over the closed signal vocabulary. Pure; never
 * throws (returns `EMPTY_PLAYBOOK` on any malformed input).
 *
 * @param events    The raw event log (any order; newest-anywhere).
 * @param projectKey The current project key (null → only global events apply).
 */
export function distillTaste(
  events: readonly TasteEvent[],
  projectKey: string | null,
): TastePlaybook {
  try {
    if (!Array.isArray(events) || events.length === 0) return EMPTY_PLAYBOOK;

    // Scope: a project-scoped event applies only in its own project; a global
    // (null) event applies everywhere (deriveProjectKey privacy is upstream).
    const scoped = events.filter(
      (e) => isTasteEvent(e) && (e.projectKey === null || e.projectKey === projectKey),
    );
    if (scoped.length === 0) return EMPTY_PLAYBOOK;

    // 1) Ask-vs-proceed bias: net (proceed - ask) over the scoped log, clamped ±1.
    let net = 0;
    for (const e of scoped) {
      const lean = leanOf(e.signal);
      if (lean === 'proceed') net += 1;
      else if (lean === 'ask') net -= 1;
    }
    const memoryBias: -1 | 0 | 1 = net >= BIAS_THRESHOLD ? 1 : net <= -BIAS_THRESHOLD ? -1 : 0;

    // 2) Playbook lines: the user's recurring CALLS, keyed by subject. The latest
    //    choice for a subject wins (taste evolves; we never fossilize a stale call),
    //    support counts how often that subject was decided.
    const bySubject = new Map<string, SubjectAgg>();
    for (const e of scoped) {
      if (!subjectSignal(e.signal)) continue; // only choice-bearing signals make lines
      const key = e.subject.toLowerCase();
      const prev = bySubject.get(key);
      if (prev === undefined) {
        bySubject.set(key, { subject: e.subject, choice: e.choice, support: 1, lastTs: e.ts });
      } else {
        prev.support += 1;
        // Latest event (by ts) defines the current call for this subject.
        if (e.ts >= prev.lastTs) {
          prev.choice = e.choice;
          prev.subject = e.subject;
          prev.lastTs = e.ts;
        }
      }
    }

    const lines = [...bySubject.values()]
      .filter((a) => a.support >= MIN_SUPPORT)
      .sort((a, b) => b.support - a.support || (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))
      .slice(0, MAX_PLAYBOOK_LINES)
      .map((a) => `${a.subject}: ${a.choice}`);

    return { memoryBias, lines };
  } catch {
    return EMPTY_PLAYBOOK;
  }
}

/** Signals that carry a user CHOICE worth a playbook line (vs. pure dial signals). */
function subjectSignal(signal: TasteSignal): boolean {
  switch (signal) {
    case 'fork_choice':
    case 'pushback_accept':
    case 'pushback_reject':
    case 'immediate_edit':
      return true;
    // accept_unchanged / immediate_rephrase are dial signals only — they have no
    // distinct "call" to render (accepting our plan isn't a taste of the user's own).
    default:
      return false;
  }
}

// ===========================================================================
// Observed immediate-rephrase detector (a STRONG miss signal, judgment §4.2)
// ===========================================================================

/** Min token-overlap ratio for "the user re-stated the same goal differently". */
const REPHRASE_OVERLAP = 0.5;
const REPHRASE_MIN_TOKENS = 3;

/**
 * Conservative, OBSERVED test for "the user's new turn re-states the SAME goal
 * differently" (an immediate-rephrase miss signal). Deterministic token-overlap,
 * no model, no embeddings: true only when both lines clear a minimum length AND
 * share ≥ REPHRASE_OVERLAP of the shorter line's content tokens, while NOT being
 * byte-identical (an exact resend is a retry, not a rephrase). Conservative on the
 * positive side — a false negative just means we don't learn a miss (recoverable);
 * a false positive would record a fabricated-ish signal, so we err toward silence.
 * Pure; never throws.
 */
export function isImmediateRephrase(prev: string, next: string): boolean {
  try {
    if (typeof prev !== 'string' || typeof next !== 'string') return false;
    const a = tokenize(prev);
    const b = tokenize(next);
    if (a.size < REPHRASE_MIN_TOKENS || b.size < REPHRASE_MIN_TOKENS) return false;
    const pn = prev.trim().toLowerCase();
    const nn = next.trim().toLowerCase();
    if (pn === nn) return false; // exact resend → a retry, not a rephrase
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const denom = Math.min(a.size, b.size);
    if (denom === 0) return false;
    return inter / denom >= REPHRASE_OVERLAP;
  } catch {
    return false;
  }
}

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    if (tok.length >= 3) out.add(tok); // drop stopword-length noise
  }
  return out;
}

// ===========================================================================
// Render — the taste playbook prompt block
// ===========================================================================

const TASTE_HEADER =
  'LEARNED TASTE (this user\'s OBSERVED past decisions — a prior, not a rule; the\ncurrent request and live evidence ALWAYS override a learned lean):';
const TASTE_FOOTER =
  'Lean toward these where they apply; an explicit instruction this turn wins. Do not\nrepeat these back. These are recorded choices, never inferred opinions.';

/**
 * Render a playbook into the tagged, overridable taste context block injected at
 * prompt assembly. Returns '' when there are no lines (so the block never appears
 * empty / when recall returned EMPTY_PLAYBOOK). Pure; never
 * throws. The footer enforces explicit > learned (judgment doc §4.4).
 */
export function renderTastePlaybook(playbook: TastePlaybook): string {
  try {
    if (playbook === null || typeof playbook !== 'object') return '';
    const lines = playbook.lines ?? [];
    if (lines.length === 0) return '';
    const body = lines.map((l) => `- ${l}`).join('\n');
    return `${TASTE_HEADER}\n${body}\n\n${TASTE_FOOTER}`;
  } catch {
    return '';
  }
}
