/**
 * src/infra/conversations.ts — File-backed ConversationStore implementation.
 *
 * Storage layout under <homeDir>/.myshell-tools/conversations/:
 *   index.json       — JSON array of ConversationMeta, newest first
 *   index.json.lock  — advisory lock for concurrent index mutations
 *   <id>.jsonl       — one SessionEntry per line (append-only message log)
 */

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock, SessionEntry, SessionWriter } from '../core/types.js';
import type { ConversationMeta, ConversationStore } from './conversation-store.js';
import { atomicAppendJSONL, atomicWrite, withLock } from './atomic.js';

// ---------------------------------------------------------------------------
// Path helpers (local — conversations dir lives in homeDir, not cwd)
// ---------------------------------------------------------------------------

function getConversationsDir(homeDir: string): string {
  return join(homeDir, '.myshell-tools', 'conversations');
}

function getIndexPath(homeDir: string): string {
  return join(getConversationsDir(homeDir), 'index.json');
}

function getIndexLockPath(homeDir: string): string {
  return join(getConversationsDir(homeDir), 'index.json.lock');
}

function getMessagePath(homeDir: string, id: string): string {
  return join(getConversationsDir(homeDir), `${id}.jsonl`);
}

// ---------------------------------------------------------------------------
// Internal index helpers
// ---------------------------------------------------------------------------

async function ensureDir(homeDir: string): Promise<void> {
  await mkdir(getConversationsDir(homeDir), { recursive: true });
}

async function readIndex(homeDir: string): Promise<ConversationMeta[]> {
  try {
    const raw = await readFile(getIndexPath(homeDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ConversationMeta[];
  } catch {
    return [];
  }
}

async function writeIndex(homeDir: string, index: ConversationMeta[]): Promise<void> {
  await atomicWrite(getIndexPath(homeDir), JSON.stringify(index, null, 2));
}

// ---------------------------------------------------------------------------
// Title extraction: trim + truncate to 80 chars
// ---------------------------------------------------------------------------

const MAX_TITLE_LEN = 80;

function deriveTitle(content: string): string {
  const trimmed = content.trim();
  return trimmed.length <= MAX_TITLE_LEN ? trimmed : trimmed.slice(0, MAX_TITLE_LEN);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a file-backed ConversationStore that persists conversations under
 * `<homeDir ?? os.homedir()>/.myshell-tools/conversations/`.
 */
export function createFileConversationStore(opts: {
  homeDir?: string;
  clock: Clock;
}): ConversationStore {
  const { clock } = opts;
  const home = opts.homeDir ?? homedir();

  return {
    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------
    async list(): Promise<ConversationMeta[]> {
      const index = await readIndex(home);
      return [...index].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    // -----------------------------------------------------------------------
    // create
    // -----------------------------------------------------------------------
    async create(title: string): Promise<ConversationMeta> {
      await ensureDir(home);
      const id = clock.uuid();
      const now = clock.isoNow();
      const meta: ConversationMeta = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };

      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndex(home);
        await writeIndex(home, [meta, ...index]);
      });

      return meta;
    },

    // -----------------------------------------------------------------------
    // load
    // -----------------------------------------------------------------------
    async load(id: string): Promise<SessionEntry[]> {
      let raw: string;
      try {
        raw = await readFile(getMessagePath(home, id), 'utf8');
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
    },

    // -----------------------------------------------------------------------
    // writer
    // -----------------------------------------------------------------------
    writer(id: string): SessionWriter {
      return {
        id,
        async append(entry: SessionEntry): Promise<void> {
          await ensureDir(home);
          // Append the entry to the conversation's JSONL file
          await atomicAppendJSONL(getMessagePath(home, id), entry);

          // Update index under lock
          await withLock(getIndexLockPath(home), async () => {
            const index = await readIndex(home);
            const idx = index.findIndex((m) => m.id === id);
            if (idx === -1) return;

            const existing = index[idx];
            if (existing === undefined) return;
            const updatedAt = clock.isoNow();
            const messageCount = existing.messageCount + 1;

            // If this is a user message and the title is still the placeholder,
            // use the message content as the title (first user message wins).
            let title = existing.title;
            if (
              entry.role === 'user' &&
              entry.content &&
              (title.trim().length === 0 || title === existing.title) &&
              existing.messageCount === 0
            ) {
              title = deriveTitle(entry.content);
            }

            const updated: ConversationMeta = {
              id: existing.id,
              title,
              createdAt: existing.createdAt,
              updatedAt,
              messageCount,
            };

            const newIndex = [...index];
            newIndex[idx] = updated;
            await writeIndex(home, newIndex);
          });
        },
      };
    },

    // -----------------------------------------------------------------------
    // rename
    // -----------------------------------------------------------------------
    async rename(id: string, title: string): Promise<void> {
      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndex(home);
        const idx = index.findIndex((m) => m.id === id);
        if (idx === -1) return;

        const existing = index[idx];
        if (existing === undefined) return;
        const updated: ConversationMeta = {
          id: existing.id,
          title,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          messageCount: existing.messageCount,
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(home, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // remove
    // -----------------------------------------------------------------------
    async remove(id: string): Promise<void> {
      // Best-effort delete of message file
      try {
        await unlink(getMessagePath(home, id));
      } catch {
        // Missing or already gone — ignore
      }

      // Remove from index under lock
      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndex(home);
        const filtered = index.filter((m) => m.id !== id);
        if (filtered.length === index.length) return; // not found, no-op
        await writeIndex(home, filtered);
      });
    },
  };
}
