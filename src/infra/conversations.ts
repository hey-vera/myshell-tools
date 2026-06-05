/**
 * src/infra/conversations.ts — File-backed ConversationStore implementation.
 *
 * Storage layout under <homeDir>/.myshell-tools/conversations/:
 *   index.json       — JSON array of ConversationMeta, newest first
 *   index.json.corrupt — last corrupt index preserved during recovery
 *   index.json.lock  — advisory lock for concurrent index mutations
 *   <id>.jsonl       — one SessionEntry per line (append-only message log)
 */

import { mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock, SessionEntry, SessionWriter } from '../core/types.js';
import type { ConversationMeta, ConversationStore } from './conversation-store.js';
import { atomicAppendJSONL, atomicWrite, withLock } from './atomic.js';
import { isConversationMessage } from './jsonl-guards.js';
import { defaultStateHome } from './state-dir.js';
import { archiveConversation } from './session-mirror.js';

// ---------------------------------------------------------------------------
// Path helpers (local — conversations dir lives in homeDir, not cwd)
// ---------------------------------------------------------------------------

function getConversationsDir(homeDir: string): string {
  return join(homeDir, '.myshell-tools', 'conversations');
}

function getIndexPath(homeDir: string): string {
  return join(getConversationsDir(homeDir), 'index.json');
}

function getCorruptIndexPath(homeDir: string): string {
  return join(getConversationsDir(homeDir), 'index.json.corrupt');
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

type ConversationStoreWarning = (message: string) => void;

type IndexReadResult =
  | { readonly kind: 'ok'; readonly index: ConversationMeta[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly reason: string };

async function ensureDir(homeDir: string): Promise<void> {
  await mkdir(getConversationsDir(homeDir), { recursive: true });
}

/**
 * Normalise a raw index entry that may be missing fields added in later
 * versions (pinned, category, recap). Old on-disk entries that predate these
 * fields will be migrated transparently on read so existing stores keep working —
 * an absent field is a valid default (no recap), never a data-loss or a scary
 * prompt for upgraders.
 */
function normaliseMeta(raw: unknown): ConversationMeta {
  const r = raw as Record<string, unknown>;
  const meta: {
    -readonly [K in keyof ConversationMeta]: ConversationMeta[K];
  } = {
    id: String(r['id'] ?? ''),
    title: String(r['title'] ?? ''),
    createdAt: String(r['createdAt'] ?? ''),
    updatedAt: String(r['updatedAt'] ?? ''),
    messageCount: typeof r['messageCount'] === 'number' ? r['messageCount'] : 0,
    pinned: typeof r['pinned'] === 'boolean' ? r['pinned'] : false,
    category: typeof r['category'] === 'string' ? r['category'] : null,
  };
  // Recap fields (additive, forward-migrated): carry them only when present and
  // well-typed. A legacy entry lacking them keeps recap absent — exactly the
  // "no recap yet" state, never a fabricated one.
  if (typeof r['recap'] === 'string') meta.recap = r['recap'];
  else if (r['recap'] === null) meta.recap = null;
  if (typeof r['recapAt'] === 'string') meta.recapAt = r['recapAt'];
  else if (r['recapAt'] === null) meta.recapAt = null;
  if (typeof r['recapMessageCount'] === 'number') meta.recapMessageCount = r['recapMessageCount'];
  return meta;
}

/**
 * The recap fields of a meta, spread back in on every index mutation so an
 * unrelated update (writer/rename/pin/category) never drops a cached recap.
 * Returns only the fields that are actually present (exactOptionalPropertyTypes).
 */
function recapFields(
  m: ConversationMeta,
): Pick<ConversationMeta, 'recap' | 'recapAt' | 'recapMessageCount'> {
  const out: {
    recap?: string | null;
    recapAt?: string | null;
    recapMessageCount?: number;
  } = {};
  if (m.recap !== undefined) out.recap = m.recap;
  if (m.recapAt !== undefined) out.recapAt = m.recapAt;
  if (m.recapMessageCount !== undefined) out.recapMessageCount = m.recapMessageCount;
  return out;
}

async function readIndexFile(homeDir: string): Promise<IndexReadResult> {
  try {
    const raw = await readFile(getIndexPath(homeDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { kind: 'corrupt', reason: 'index.json is not an array' };
    }
    return { kind: 'ok', index: parsed.map(normaliseMeta) };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'corrupt',
      reason: err instanceof SyntaxError ? 'index.json is invalid JSON' : 'index.json is unreadable',
    };
  }
}

async function writeIndex(homeDir: string, index: ConversationMeta[]): Promise<void> {
  await atomicWrite(getIndexPath(homeDir), JSON.stringify(index, null, 2));
}

function parseMessageLines(raw: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isConversationMessage(parsed)) entries.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

async function loadMessageFile(path: string): Promise<SessionEntry[]> {
  const raw = await readFile(path, 'utf8');
  return parseMessageLines(raw);
}

// ---------------------------------------------------------------------------
// Title extraction: trim + truncate to 80 chars
// ---------------------------------------------------------------------------

const MAX_TITLE_LEN = 80;

function deriveTitle(content: string): string {
  // Collapse ALL internal whitespace (incl. newlines) to single spaces so a
  // multi-line first message can't render as a broken multi-line menu entry.
  const trimmed = content.trim().replace(/\s+/g, ' ');
  return trimmed.length <= MAX_TITLE_LEN ? trimmed : trimmed.slice(0, MAX_TITLE_LEN);
}

function metaFromMessages(
  id: string,
  entries: readonly SessionEntry[],
  fallbackIso: string,
): ConversationMeta {
  const first = entries[0];
  const last = entries[entries.length - 1];
  const firstUser = entries.find((entry) => entry.role === 'user');
  return {
    id,
    title: firstUser === undefined ? '' : deriveTitle(firstUser.content),
    createdAt: first?.timestamp ?? fallbackIso,
    updatedAt: last?.timestamp ?? fallbackIso,
    messageCount: entries.length,
    pinned: false,
    category: null,
  };
}

async function rebuildIndexFromMessages(homeDir: string): Promise<ConversationMeta[]> {
  const dir = getConversationsDir(homeDir);
  const files = await readdir(dir, { withFileTypes: true });
  const rebuilt: ConversationMeta[] = [];

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
    const id = file.name.slice(0, -'.jsonl'.length);
    const path = join(dir, file.name);
    try {
      const [messages, st] = await Promise.all([loadMessageFile(path), stat(path)]);
      rebuilt.push(metaFromMessages(id, messages, st.mtime.toISOString()));
    } catch {
      // Best-effort: a single unreadable message log must not block the others.
    }
  }

  return rebuilt.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function preserveCorruptIndex(homeDir: string): Promise<string> {
  const corruptPath = getCorruptIndexPath(homeDir);
  try {
    await rename(getIndexPath(homeDir), corruptPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
  }
  return corruptPath;
}

async function recoverIndex(
  homeDir: string,
  reason: string,
  onWarning: ConversationStoreWarning | undefined,
): Promise<ConversationMeta[]> {
  const corruptPath = await preserveCorruptIndex(homeDir);
  const rebuilt = await rebuildIndexFromMessages(homeDir);
  await writeIndex(homeDir, rebuilt);
  onWarning?.(
    `Recovered conversations index (${reason}); rebuilt ${rebuilt.length} conversation(s), preserved original at ${corruptPath}.`,
  );
  return rebuilt;
}

async function readIndexLocked(
  homeDir: string,
  onWarning: ConversationStoreWarning | undefined,
): Promise<ConversationMeta[]> {
  const result = await readIndexFile(homeDir);
  if (result.kind === 'ok') return result.index;
  if (result.kind === 'absent') return [];
  return recoverIndex(homeDir, result.reason, onWarning);
}

async function readIndex(
  homeDir: string,
  onWarning: ConversationStoreWarning | undefined,
): Promise<ConversationMeta[]> {
  const result = await readIndexFile(homeDir);
  if (result.kind === 'ok') return result.index;
  if (result.kind === 'absent') return [];

  return withLock(getIndexLockPath(homeDir), async () => readIndexLocked(homeDir, onWarning));
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
  onWarning?: ConversationStoreWarning;
}): ConversationStore {
  const { clock } = opts;
  const onWarning = opts.onWarning;
  const home = opts.homeDir ?? defaultStateHome();

  return {
    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------
    async list(): Promise<ConversationMeta[]> {
      const index = await readIndex(home, onWarning);
      return [...index].sort((a, b) => {
        // Pinned items always come before unpinned
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        // Within the same pin group, most-recently-updated first
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
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
        pinned: false,
        category: null,
      };

      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndexLocked(home, onWarning);
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

      return parseMessageLines(raw);
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
            const index = await readIndexLocked(home, onWarning);
            const idx = index.findIndex((m) => m.id === id);
            if (idx === -1) return;

            const existing = index[idx];
            if (existing === undefined) return;
            const updatedAt = clock.isoNow();
            const messageCount = existing.messageCount + 1;

            // If this is the first user message AND the conversation is still
            // untitled, derive the title from it. Only when EMPTY — an explicitly
            // set title (e.g. a /goal run names itself with the clean goal text)
            // must not be clobbered. (The old `|| title === existing.title` clause
            // was always true, so it overwrote any pre-set title.)
            let title = existing.title;
            if (
              entry.role === 'user' &&
              entry.content &&
              title.trim().length === 0 &&
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
              pinned: existing.pinned,
              category: existing.category,
              ...recapFields(existing),
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
        const index = await readIndexLocked(home, onWarning);
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
          pinned: existing.pinned,
          category: existing.category,
          ...recapFields(existing),
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
      // Preserve the conversation in the append-only archive BEFORE unlinking, so
      // a delete is recoverable (the archive only ever grows). Best-effort.
      await archiveConversation(id, home);

      // Best-effort delete of message file
      try {
        await unlink(getMessagePath(home, id));
      } catch {
        // Missing or already gone — ignore
      }

      // Remove from index under lock
      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndexLocked(home, onWarning);
        const filtered = index.filter((m) => m.id !== id);
        if (filtered.length === index.length) return; // not found, no-op
        await writeIndex(home, filtered);
      });
    },

    // -----------------------------------------------------------------------
    // setPinned
    // -----------------------------------------------------------------------
    async setPinned(id: string, pinned: boolean): Promise<void> {
      await ensureDir(home);
      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndexLocked(home, onWarning);
        const idx = index.findIndex((m) => m.id === id);
        if (idx === -1) return; // no-op if missing

        const existing = index[idx];
        if (existing === undefined) return;
        const updated: ConversationMeta = {
          id: existing.id,
          title: existing.title,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          messageCount: existing.messageCount,
          pinned,
          category: existing.category,
          ...recapFields(existing),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(home, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // setCategory
    // -----------------------------------------------------------------------
    async setCategory(id: string, category: string | null): Promise<void> {
      await ensureDir(home);
      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndexLocked(home, onWarning);
        const idx = index.findIndex((m) => m.id === id);
        if (idx === -1) return; // no-op if missing

        const existing = index[idx];
        if (existing === undefined) return;
        const updated: ConversationMeta = {
          id: existing.id,
          title: existing.title,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          messageCount: existing.messageCount,
          pinned: existing.pinned,
          category,
          ...recapFields(existing),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(home, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // setRecap — cache the conversation recap (text + provenance) under the lock
    // -----------------------------------------------------------------------
    async setRecap(id: string, recap: string | null, atMessageCount: number): Promise<void> {
      await ensureDir(home);
      await withLock(getIndexLockPath(home), async () => {
        const index = await readIndexLocked(home, onWarning);
        const idx = index.findIndex((m) => m.id === id);
        if (idx === -1) return; // no-op if missing

        const existing = index[idx];
        if (existing === undefined) return;
        const updated: ConversationMeta = {
          id: existing.id,
          title: existing.title,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
          messageCount: existing.messageCount,
          pinned: existing.pinned,
          category: existing.category,
          recap,
          recapAt: recap === null ? null : clock.isoNow(),
          recapMessageCount: atMessageCount,
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(home, newIndex);
      });
    },
  };
}
