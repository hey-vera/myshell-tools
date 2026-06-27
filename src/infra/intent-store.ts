/**
 * src/infra/intent-store.ts — IntentStoreWriter implementation and reader
 * for MYSHELL_INTENT_STORE_V1 (PR3).
 *
 * The intent-versions file is a JSONL file at `.myshell-tools/intent-versions.jsonl`.
 * Each `append` call adds one IntentVersion atomically. `readIntentVersions`
 * re-hydrates entries (skipping malformed lines). `readIntentVersionById` returns
 * the first matching version by id.
 *
 * Mirrors the existing ledger/session JSONL persistence pattern exactly.
 */

import { mkdir, readFile } from 'node:fs/promises';
import type { IntentVersion, IntentStoreWriter, IntentStoreReader } from '../core/intent-version.js';
import { atomicAppendJSONL } from './atomic.js';
import { isIntentVersion } from './jsonl-guards.js';
import { getStateDir, getIntentVersionsFile } from './paths.js';

/**
 * Create an IntentStoreWriter + IntentStoreReader for the given working directory.
 */
export function createIntentStore(opts: { cwd: string }): IntentStoreWriter & IntentStoreReader {
  const { cwd } = opts;

  return {
    async append(version: IntentVersion): Promise<void> {
      await mkdir(getStateDir(cwd), { recursive: true });
      await atomicAppendJSONL(getIntentVersionsFile(cwd), version);
    },

    async readAll(): Promise<readonly IntentVersion[]> {
      return readIntentVersions(cwd);
    },
  };
}

/**
 * Read all IntentVersion records from the intent-versions JSONL file.
 *
 * Returns an empty array if the file does not exist. Malformed lines and
 * rows failing `isIntentVersion` are silently skipped.
 */
export async function readIntentVersions(cwd: string): Promise<IntentVersion[]> {
  let raw: string;
  try {
    raw = await readFile(getIntentVersionsFile(cwd), 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return [];
    throw err;
  }

  const entries: IntentVersion[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isIntentVersion(parsed)) entries.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Read a single IntentVersion by id. Returns the first match, or `null`.
 */
export async function readIntentVersionById(
  cwd: string,
  id: string,
): Promise<IntentVersion | null> {
  const versions = await readIntentVersions(cwd);
  return versions.find((v) => v.id === id) ?? null;
}
