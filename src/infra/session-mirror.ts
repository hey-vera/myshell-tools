/**
 * src/infra/session-mirror.ts — an append-only safety net for conversations.
 *
 * Conversations live as append-only `<id>.jsonl` logs under
 * `<stateHome>/.myshell-tools/conversations/`. Two things can still lose one: an
 * explicit delete (`store.remove` unlinks the file) or on-disk corruption/
 * truncation. This module keeps a parallel archive under
 * `<stateHome>/.myshell-tools/.session-archive/` that only ever GROWS — a file is
 * copied into the archive only when the live copy is larger than the archived
 * one, and the archive is never trimmed. So even after a conversation is deleted,
 * its last-archived content is still there. (Mirrors DATA Tools' append-only
 * session mirror, adapted to myshell's own store.)
 *
 * Pairs with the state-dir fix: the archive lives under the SAME persistent base
 * as the conversations (the workspace on Replit), so it actually survives a
 * container restart. Best-effort and silent — never throws, a mirror failure
 * must never break a real operation.
 */

import { mkdir, stat, readdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { defaultStateHome } from './state-dir.js';

function conversationsDir(home: string): string {
  return join(home, '.myshell-tools', 'conversations');
}

function archiveDir(home: string): string {
  return join(home, '.myshell-tools', '.session-archive');
}

export interface MirrorSyncResult {
  /** Files copied into the archive for the first time. */
  readonly copied: number;
  /** Existing archived files that grew (live copy was larger). */
  readonly grew: number;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1; // missing
  }
}

/**
 * Copy `src` → `dest` only when `src` is strictly larger than `dest` (grow-only).
 * Returns what happened so callers can tally. Never throws.
 */
async function archiveGrowOnly(
  srcPath: string,
  destPath: string,
): Promise<'copied' | 'grew' | 'skipped'> {
  try {
    const srcSize = await fileSize(srcPath);
    if (srcSize < 0) return 'skipped'; // source gone — nothing to archive
    const destSize = await fileSize(destPath);
    if (srcSize <= destSize) return 'skipped'; // archive already as complete or better
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    return destSize < 0 ? 'copied' : 'grew';
  } catch {
    return 'skipped';
  }
}

/**
 * Archive a single conversation's log into the append-only mirror. Call this
 * BEFORE deleting a conversation so the content is preserved even though the
 * live file is about to be unlinked. Grow-only, best-effort, never throws.
 */
export async function archiveConversation(id: string, homeDir?: string): Promise<void> {
  try {
    const home = homeDir ?? defaultStateHome();
    await archiveGrowOnly(
      join(conversationsDir(home), `${id}.jsonl`),
      join(archiveDir(home), `${id}.jsonl`),
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Sync every conversation log into the append-only archive (grow-only). Safe to
 * call at launch: cheap (a stat per file, copy only when grown), best-effort,
 * never throws. Returns counts for optional surfacing/telemetry.
 */
export async function syncConversationMirror(homeDir?: string): Promise<MirrorSyncResult> {
  let copied = 0;
  let grew = 0;
  try {
    const home = homeDir ?? defaultStateHome();
    const src = conversationsDir(home);
    let entries: string[];
    try {
      entries = await readdir(src);
    } catch {
      return { copied, grew }; // no conversations dir yet
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const r = await archiveGrowOnly(join(src, name), join(archiveDir(home), name));
      if (r === 'copied') copied++;
      else if (r === 'grew') grew++;
    }
  } catch {
    /* best-effort */
  }
  return { copied, grew };
}
