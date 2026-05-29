/**
 * atomic.mjs — Atomic file operations for safe concurrent access
 * Adapted from archive/dual-brain/hooks/atomic-write.mjs
 */

import { openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs';
import { constants } from 'fs';

const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 10000;

/**
 * Atomically write JSON data to filePath using tmp-file + rename
 * Tmp file is in the same directory to avoid cross-device rename issues
 */
export function atomicWriteJSON(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, filePath);
}

/**
 * Atomically append a line to a JSONL file
 */
export function atomicAppendJSONL(filePath, data) {
  const line = JSON.stringify(data) + '\n';
  const tmp = filePath + '.tmp.' + process.pid;

  // Read existing content if file exists
  let existing = '';
  try {
    existing = readFileSync(filePath, 'utf8');
  } catch {
    // File doesn't exist, start with empty
  }

  // Write existing + new line to tmp file
  writeFileSync(tmp, existing + line);
  renameSync(tmp, filePath);
}

/**
 * Acquire a .lock file using O_EXCL for atomic creation
 * Returns true if lock acquired, false otherwise
 * Steals stale locks (older than STALE_LOCK_MS)
 */
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Check for stale lock
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          // Stale lock — process likely died, steal it
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        // Lock disappeared between our check — retry
        continue;
      }

      // Wait briefly before retrying
      const waitMs = 10 + Math.floor(Math.random() * 20);
      const end = Date.now() + waitMs;
      while (Date.now() < end) { /* spin */ }
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}

/**
 * Locked read-modify-write cycle
 *
 * 1. Acquire .lock file (O_EXCL atomic creation)
 * 2. Read current JSON (or use defaultValue if missing/corrupt)
 * 3. Call modifyFn(currentData) → newData
 * 4. Atomic write newData via tmp+rename
 * 5. Release lock
 */
export function lockedReadModifyWrite(filePath, modifyFn, defaultValue = {}) {
  const lockPath = filePath + '.lock';
  const locked = acquireLock(lockPath);

  if (!locked) {
    throw new Error(`Lock acquisition timed out after ${LOCK_TIMEOUT_MS}ms for ${filePath}`);
  }

  try {
    let current;
    try {
      current = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      current = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
    }

    const updated = modifyFn(current);
    atomicWriteJSON(filePath, updated);
    return updated;
  } finally {
    releaseLock(lockPath);
  }
}