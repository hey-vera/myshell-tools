/**
 * atomic.ts — Atomic file operations for safe concurrent access
 * Ported from myshell-tools/src/state/atomic.mjs with the following fixes:
 *   - Full TypeScript strict typing
 *   - Async (fs/promises) throughout
 *   - Async backoff instead of CPU-spinning lock acquisition
 *   - O(1) JSONL append via fs.appendFile (no read-then-rewrite)
 */

import { open, rename, unlink, stat, appendFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** How long to keep trying before giving up (default: 5 000 ms) */
  timeoutMs?: number;
  /** Age at which an existing lock is considered stale and may be stolen (default: 10 000 ms) */
  staleMs?: number;
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Lock acquisition timed out after ${timeoutMs}ms for: ${lockPath}`);
    this.name = 'LockTimeoutError';
  }
}

class AtomicWriteError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(
      `Atomic write failed for: ${filePath} — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AtomicWriteError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 10_000;

/** Async sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Unique suffix so concurrent processes never collide on the tmp file. */
function tmpSuffix(): string {
  return `${process.pid}.${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Lock primitives
// ---------------------------------------------------------------------------

/**
 * Acquire a `.lock` file using `O_EXCL` for atomic creation.
 * Retries with exponential backoff until `timeoutMs` is reached.
 * Steals locks whose mtime is older than `staleMs`.
 *
 * Throws `LockTimeoutError` if the lock cannot be acquired in time.
 */
export async function acquireLock(lockPath: string, opts?: LockOptions): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  let attempt = 0;

  while (Date.now() < deadline) {
    try {
      // O_EXCL guarantees atomic creation — only one caller wins
      const fh = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        await fh.close();
      }
      return; // lock acquired
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'EEXIST') throw err;

      // Check whether the existing lock is stale
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          // Stale — the holding process likely crashed; steal it
          try {
            await unlink(lockPath);
          } catch {
            // Another process may have already removed it; harmless
          }
          continue; // retry immediately
        }
      } catch {
        // Lock file disappeared between the EEXIST and stat — retry
        continue;
      }

      // Back off before the next attempt (50 ms, 100 ms, 200 ms … up to 1 s)
      const waitMs = Math.min(50 * 2 ** attempt, 1_000);
      attempt++;

      // Don't sleep past the deadline
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(waitMs, remaining));
    }
  }

  throw new LockTimeoutError(lockPath, timeoutMs);
}

/**
 * Release a lock file previously acquired with `acquireLock`.
 * Silently ignores a missing lock file (idempotent).
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Already gone — that's fine
  }
}

/**
 * Convenience wrapper: acquire the lock, run `fn`, then always release.
 * Re-throws any error from `fn` after releasing the lock.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

// ---------------------------------------------------------------------------
// Atomic file operations
// ---------------------------------------------------------------------------

/**
 * Atomically write `data` to `filePath` using a tmp-file + rename strategy.
 * The tmp file lives in the same directory to avoid cross-device rename issues.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp.${tmpSuffix()}`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    await rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup of orphaned tmp file
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw new AtomicWriteError(filePath, err);
  }
}

/**
 * Atomically append a single JSONL entry to `filePath`.
 *
 * This is O(1) — it uses `fs.appendFile` rather than reading the entire file
 * and rewriting it on every call. The caller is responsible for holding a lock
 * when concurrent appends must be strictly ordered.
 *
 * Creates `filePath` if it does not exist.
 */
export async function atomicAppendJSONL(filePath: string, entry: unknown): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  try {
    await appendFile(filePath, line, 'utf8');
  } catch (err) {
    throw new AtomicWriteError(filePath, err);
  }
}
