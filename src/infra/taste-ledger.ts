/**
 * src/infra/taste-ledger.ts — the I/O layer for the LEARNED-TASTE LEDGER (Phase 7
 * free layer; .tmp-master-judgment.md Part 4). The infra sibling of
 * src/infra/ledger.ts: an append-only JSONL event log of OBSERVED user decisions.
 *
 * Storage: a single JSONL file at <homeDir>/.myshell-tools/memory/taste.jsonl,
 * mode 0o600 on create (mirrors the memory store's 0o600 perimeter). Each line is
 * one `TasteEvent` (src/core/taste.ts), appended atomically via the SAME
 * `atomicAppendJSONL` the cost ledger uses — no new deps, no embeddings, no vector
 * DB, no metered service (subscription-clean by construction). Project scoping
 * rides INSIDE each event via `deriveProjectKey` (reused verbatim from the memory
 * store): a project-scoped event carries the privacy-preserving `basename#hash`,
 * NEVER the raw path; a global event carries `null`.
 *
 * FAIL-SOFT (non-negotiable, §4.4): a corrupt/missing ledger NEVER breaks a turn.
 * `record` swallows every write error; `recall` returns the EMPTY playbook on any
 * read/parse failure and skips foreign/corrupt lines. The store throws nothing
 * into a turn. Recording is OBSERVED-ONLY — `record` rejects (drops) any event
 * that `normalizeTasteEvent` can't validate, so no fabricated fact can ever land.
 *
 * The FLAG (src/core/taste-flag.ts) is checked by the WIRING layer before it ever
 * calls `record`/`recall`; this module is the mechanism, flag-agnostic, so its
 * unit tests are hermetic.
 */

import { mkdir, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

import type { Clock } from '../core/types.js';
import { atomicAppendJSONL } from './atomic.js';
import { defaultStateHome } from './state-dir.js';
import {
  normalizeTasteEvent,
  isTasteEvent,
  distillTaste,
  EMPTY_PLAYBOOK,
  TASTE_LEDGER_MAX,
  type TasteEvent,
  type TasteSignal,
  type TastePlaybook,
} from '../core/taste.js';

// Re-export the project-key derivation so taste callers don't reach into the
// memory store (same privacy-preserving basename#hash, reused verbatim). The
// chat loop resolves the project key via the memory store's resolveProjectKey;
// deriveProjectKey is re-exported here for the taste ledger's own tests.
export { deriveProjectKey } from './user-memory-store.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getMemoryDir(homeDir: string): string {
  return join(homeDir, '.myshell-tools', 'memory');
}
function getTasteFile(homeDir: string): string {
  return join(getMemoryDir(homeDir), 'taste.jsonl');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The raw, pre-normalized signal a caller hands to `record`. */
interface TasteObservation {
  readonly signal: TasteSignal;
  readonly subject: string;
  readonly choice: string;
  readonly detail?: string;
  /** Privacy-preserving project key (deriveProjectKey) or null for global. */
  readonly projectKey?: string | null;
}

export interface TasteLedger {
  /**
   * Append ONE observed taste event. Validates via `normalizeTasteEvent` (the
   * observed-only honesty gate) — an unvalidatable observation is DROPPED, never
   * fabricated. Fully fail-soft: any write error is swallowed (a failed taste
   * write must never break a turn). No model call.
   */
  record(obs: TasteObservation): Promise<void>;
  /**
   * Read the log + distill it into a project-scoped `TastePlaybook` (the
   * memoryBias dial + the playbook lines). Fail-soft: a missing/corrupt ledger
   * returns `EMPTY_PLAYBOOK` (degrade to no-bias). No model call.
   */
  recall(projectKey: string | null): Promise<TastePlaybook>;
  /** Read all well-formed events (newest-last, file order). For tests/inspection. */
  readAll(): Promise<TasteEvent[]>;
}

/**
 * Create a file-backed taste ledger. `homeDir` is explicit for hermetic tests
 * (defaults to the persistent state home, like the memory store). The `clock` is
 * injected (no wall-clock) so event timestamps are deterministic in tests.
 */
export function createFileTasteLedger(opts: { homeDir?: string; clock: Clock }): TasteLedger {
  const home = opts.homeDir ?? defaultStateHome();
  const { clock } = opts;

  async function ensureDir(): Promise<void> {
    await mkdir(getMemoryDir(home), { recursive: true });
  }

  async function readEvents(): Promise<TasteEvent[]> {
    let raw: string;
    try {
      raw = await readFile(getTasteFile(home), 'utf8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return []; // no ledger yet — no taste
      return []; // unreadable → degrade to no-bias (fail-soft)
    }
    const events: TasteEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isTasteEvent(parsed)) events.push(parsed);
        // foreign/corrupt line → skipped (fail-soft), never throws the turn
      } catch {
        // skip malformed line
      }
    }
    // Bound the scan to the newest TASTE_LEDGER_MAX (file order is oldest→newest).
    return events.length > TASTE_LEDGER_MAX ? events.slice(events.length - TASTE_LEDGER_MAX) : events;
  }

  return {
    async record(obs): Promise<void> {
      try {
        const event = normalizeTasteEvent(
          {
            signal: obs.signal,
            subject: obs.subject,
            choice: obs.choice,
            ...(obs.detail !== undefined ? { detail: obs.detail } : {}),
            projectKey: obs.projectKey ?? null,
          },
          clock.isoNow(),
        );
        // Observed-only gate: an unvalidatable observation is DROPPED (never faked).
        if (event === null) return;
        await ensureDir();
        const file = getTasteFile(home);
        await atomicAppendJSONL(file, event);
        // Best-effort 0o600 (the memory perimeter); a chmod failure is non-fatal.
        try {
          await chmod(file, 0o600);
        } catch {
          /* non-fatal */
        }
      } catch {
        // A failed taste write must NEVER break a turn (fail-soft).
      }
    },

    async recall(projectKey): Promise<TastePlaybook> {
      try {
        const events = await readEvents();
        if (events.length === 0) return EMPTY_PLAYBOOK;
        return distillTaste(events, projectKey);
      } catch {
        return EMPTY_PLAYBOOK; // degrade to no-bias on ANY failure
      }
    },

    async readAll(): Promise<TasteEvent[]> {
      try {
        return await readEvents();
      } catch {
        return [];
      }
    },
  };
}
