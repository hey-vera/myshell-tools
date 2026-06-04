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

import { randomBytes } from 'node:crypto';
import { mkdir, stat, readdir, copyFile, rename, unlink, readFile, open } from 'node:fs/promises';
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

function uniqueSuffix(): string {
  return `${Date.now()}.${process.pid}.${randomBytes(4).toString('hex')}`;
}

async function atomicCopyFile(srcPath: string, destPath: string): Promise<void> {
  const tmpPath = `${destPath}.tmp.${uniqueSuffix()}`;
  try {
    await copyFile(srcPath, tmpPath);
    await rename(tmpPath, destPath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

async function isBytePrefix(prefixPath: string, fullPath: string): Promise<boolean> {
  const prefix = await readFile(prefixPath);
  const fh = await open(fullPath, 'r');
  try {
    const fullPrefix = Buffer.allocUnsafe(prefix.length);
    const { bytesRead } = await fh.read(fullPrefix, 0, prefix.length, 0);
    return bytesRead === prefix.length && prefix.equals(fullPrefix);
  } finally {
    await fh.close();
  }
}

async function appendSuffix(srcPath: string, destPath: string, start: number): Promise<void> {
  const src = await open(srcPath, 'r');
  const dest = await open(destPath, 'a');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pos = start;
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      await dest.write(buf, 0, bytesRead);
      pos += bytesRead;
    }
  } finally {
    await Promise.allSettled([src.close(), dest.close()]);
  }
}

async function writeConflictCopy(srcPath: string, destPath: string): Promise<void> {
  // The archive is not a byte-prefix of the live file, so keep the known-good
  // archive and preserve the divergent live bytes beside it for manual recovery.
  await atomicCopyFile(srcPath, `${destPath}.conflict-${uniqueSuffix()}`);
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
    if (destSize < 0) {
      await atomicCopyFile(srcPath, destPath);
      return 'copied';
    }
    if (!(await isBytePrefix(destPath, srcPath))) {
      await writeConflictCopy(srcPath, destPath);
      return 'skipped';
    }
    await appendSuffix(srcPath, destPath, destSize);
    return 'grew';
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
