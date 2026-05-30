/**
 * src/infra/session.ts — SessionWriter implementation and session reader.
 *
 * Sessions are persisted as JSONL files under `.myshell-tools/sessions/current.jsonl`.
 * Each call to `append` writes a single line atomically using `atomicAppendJSONL`.
 * `readSession` re-hydrates a session from the JSONL file, skipping any malformed
 * lines so a partial write can never break a resume.
 */

import { mkdir, readFile } from 'node:fs/promises';
import type { SessionEntry, SessionWriter } from '../core/types.js';
import { atomicAppendJSONL } from './atomic.js';
import { getSessionsDir, getSessionFile } from './paths.js';

/**
 * Create a SessionWriter for the given working directory and session id.
 *
 * @param opts.cwd - The project working directory (parent of `.myshell-tools/`).
 * @param opts.id  - A unique session identifier (typically a UUID).
 */
export function createSessionWriter(opts: { cwd: string; id: string }): SessionWriter {
  const { cwd, id } = opts;

  return {
    id,

    async append(entry: SessionEntry): Promise<void> {
      await mkdir(getSessionsDir(cwd), { recursive: true });
      await atomicAppendJSONL(getSessionFile(cwd), entry);
    },
  };
}

/**
 * Read all SessionEntry records from the current session JSONL file.
 *
 * Returns an empty array if the file does not exist. Malformed lines (e.g.
 * caused by a partial write) are silently skipped.
 *
 * @param cwd - The project working directory.
 */
export async function readSession(cwd: string): Promise<SessionEntry[]> {
  let raw: string;
  try {
    raw = await readFile(getSessionFile(cwd), 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return [];
    throw err;
  }

  const entries: SessionEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed) as SessionEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}
