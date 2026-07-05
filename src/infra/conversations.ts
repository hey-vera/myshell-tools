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
import { join, normalize } from 'node:path';
import type { Clock, SessionEntry, SessionWriter } from '../core/types.js';
import type { Intensity } from '../core/capacity-allocator.js';
import type { GoalActivationOverride } from '../core/autonomy.js';
import type {
  ConversationMeta,
  ConversationMode,
  ConversationStore,
  CreateConversationOptions,
} from './conversation-store.js';
import { atomicAppendJSONL, atomicWrite, withLock } from './atomic.js';
import { isConversationMessage } from './jsonl-guards.js';
import { defaultStateLayout, resolveStateLayout, type AppStateLayout } from './state-layout.js';
import { archiveConversation } from './session-mirror.js';

// ---------------------------------------------------------------------------
// Layout resolution (homeDir compat bridge)
// ---------------------------------------------------------------------------

function resolveLayout(homeDir?: string, layout?: AppStateLayout): AppStateLayout {
  if (layout) return layout;
  if (homeDir !== undefined) {
    return resolveStateLayout({
      env: {},
      platform: 'linux',
      cwd: homeDir,
      homeDir,
    });
  }
  return defaultStateLayout();
}

// ---------------------------------------------------------------------------
// Path helpers (layout-based)
// ---------------------------------------------------------------------------

function getConversationsDir(l: AppStateLayout): string {
  return l.paths.conversationsDir;
}

function getIndexPath(l: AppStateLayout): string {
  return join(getConversationsDir(l), 'index.json');
}

function getCorruptIndexPath(l: AppStateLayout): string {
  return join(getConversationsDir(l), 'index.json.corrupt');
}

function getIndexLockPath(l: AppStateLayout): string {
  return join(getConversationsDir(l), 'index.json.lock');
}

function getMessagePath(l: AppStateLayout, id: string): string {
  return join(getConversationsDir(l), `${id}.jsonl`);
}

/**
 * Path-traversal guard for the controlled `truncateAfter` rewrite — the only op
 * that REWRITES a message file (vs. append/read), so it gates the id against the
 * known conversation-id shape (a UUID, plus a permissive alnum/`-`/`_` fallback
 * for legacy/test ids) before touching the filesystem. No `/`, `\`, `.` or NUL
 * can reach the path. Append/load stay as-is (they never overwrite a sibling).
 */
const VALID_CONV_ID_RE = /^[A-Za-z0-9_-]+$/;
function isValidConversationId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && VALID_CONV_ID_RE.test(id);
}

/**
 * Normalize a workspaceRoot for storage/read — collapses `.`/`..` segments and
 * redundant separators via node:path `normalize`, and strips a trailing
 * separator (except for a bare root like `/` or `C:\`). Absent/null pass
 * through unchanged; never resolved against cwd (that would defeat the
 * "never infer from current cwd" rule) and never throws.
 */
function normalizeWorkspaceRoot(root: string | null | undefined): string | null | undefined {
  if (root === undefined) return undefined;
  if (root === null) return null;
  if (typeof root !== 'string' || root.length === 0) return null;
  let n = normalize(root);
  if (n.length > 1 && /[\\/]$/.test(n) && !/^[\\/]$/.test(n) && !/^[A-Za-z]:[\\/]$/.test(n)) {
    n = n.replace(/[\\/]+$/, '');
  }
  return n;
}

// ---------------------------------------------------------------------------
// Internal index helpers
// ---------------------------------------------------------------------------

type ConversationStoreWarning = (message: string) => void;

type IndexReadResult =
  | { readonly kind: 'ok'; readonly index: ConversationMeta[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly reason: string };

async function ensureDir(l: AppStateLayout): Promise<void> {
  await mkdir(getConversationsDir(l), { recursive: true });
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
  if (r['intensity'] === 1 || r['intensity'] === 2 || r['intensity'] === 3 || r['intensity'] === 4 || r['intensity'] === 5) {
    meta.intensity = r['intensity'];
  }
  if (r['activation'] === 'go-when-confident' || r['activation'] === 'always-plan-first') {
    meta.activation = r['activation'];
  }
  if (r['mode'] === 'auto' || r['mode'] === 'budget' || r['mode'] === 'balanced' || r['mode'] === 'high' || r['mode'] === 'max') {
    meta.mode = r['mode'];
  }
  if (typeof r['workspaceRoot'] === 'string') meta.workspaceRoot = normalizeWorkspaceRoot(r['workspaceRoot']) ?? null;
  else if (r['workspaceRoot'] === null) meta.workspaceRoot = null;
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

function intensityFields(m: ConversationMeta): Pick<ConversationMeta, 'intensity'> {
  const out: { intensity?: Intensity } = {};
  if (m.intensity !== undefined && m.intensity !== 'auto') out.intensity = m.intensity;
  return out;
}

function activationFields(m: ConversationMeta): Pick<ConversationMeta, 'activation'> {
  const out: { activation?: Exclude<GoalActivationOverride, 'adaptive'> } = {};
  if (m.activation !== undefined) out.activation = m.activation;
  return out;
}

function modeFields(m: ConversationMeta): Pick<ConversationMeta, 'mode'> {
  const out: { mode?: ConversationMode } = {};
  if (m.mode !== undefined && m.mode !== 'auto') out.mode = m.mode;
  return out;
}

function workspaceRootFields(m: ConversationMeta): Pick<ConversationMeta, 'workspaceRoot'> {
  const out: { workspaceRoot?: string | null } = {};
  if (m.workspaceRoot !== undefined) out.workspaceRoot = m.workspaceRoot;
  return out;
}

async function readIndexFile(l: AppStateLayout): Promise<IndexReadResult> {
  try {
    const raw = await readFile(getIndexPath(l), 'utf8');
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

async function writeIndex(l: AppStateLayout, index: ConversationMeta[]): Promise<void> {
  await atomicWrite(getIndexPath(l), JSON.stringify(index, null, 2));
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

/** Semantic titles (gap #5) are shorter than raw first-words truncations: a
 * clean topic phrase, not a sentence. Bounded so the menu row stays compact. */
const MAX_RECAP_TITLE_LEN = 56;

function deriveTitle(content: string): string {
  // Collapse ALL internal whitespace (incl. newlines) to single spaces so a
  // multi-line first message can't render as a broken multi-line menu entry.
  const trimmed = content.trim().replace(/\s+/g, ' ');
  return trimmed.length <= MAX_TITLE_LEN ? trimmed : trimmed.slice(0, MAX_TITLE_LEN);
}

/**
 * Derive a short, clean TITLE from a conversation's already-cached recap
 * (real-chat gap #5) — semantic auto-naming with NO new model call. The recap
 * (the ※ orientation line) is the existing topic summary; this distills it to a
 * 3-to-~8-word topic phrase so a thread that opened "hey can you look at this"
 * is titled by what it became, not its first keystrokes.
 *
 * Deterministic + fail-soft + bounded:
 *   - takes the recap's FIRST clause (up to the first sentence/clause boundary —
 *     `.`/`;`/`—`/newline), trims a leading "we …"/"you …" framing the recap
 *     tends to open with so the title reads as a topic, then bounds to
 *     {@link MAX_RECAP_TITLE_LEN} on a word boundary;
 *   - returns null when the recap is absent/blank/too short to be a better title
 *     than the fallback, so the caller keeps the first-words title (no churn,
 *     no regressions).
 *
 * PURE; never throws.
 */
export function deriveTitleFromRecap(recap: string | null | undefined): string | null {
  if (typeof recap !== 'string') return null;
  // Single line, single-spaced; drop a leading ※ glyph the recap may carry.
  let s = recap.replace(/^[\s※]+/, '').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;
  // First clause only — the recap's opening phrase is the topic; the rest is
  // detail. Split on the earliest strong boundary.
  const boundary = s.search(/[.;\n]|\s—\s/);
  if (boundary > 0) s = s.slice(0, boundary).trim();
  // Strip a leading conversational framing ("We've been…", "You asked…") so the
  // title is a topic, not a narration. Only when it leaves a usable remainder.
  const reframed = s.replace(
    /^(?:we(?:'ve| have| are| were)?|you(?:'ve| have| are| were)?|i(?:'ve| have| am| was)?|this conversation(?: is| was)?|the (?:user|thread))\b[\s:,-]*/i,
    '',
  );
  if (reframed.trim().length >= 3) s = reframed.trim();
  if (s.length < 3) return null;
  // Bound on a word boundary so we never cut mid-word.
  if (s.length > MAX_RECAP_TITLE_LEN) {
    s = s.slice(0, MAX_RECAP_TITLE_LEN).replace(/\s+\S*$/, '').trim();
    if (s.length === 0) return null;
  }
  // Capitalise the first letter for a clean title; leave the rest as written.
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Is this title still an auto-derived STUB (the first-words truncation of the
 * opening user message), as opposed to a title the user explicitly set or a goal
 * named itself? Used to gate the gap-#5 recap re-title so we only IMPROVE an
 * auto stub and never clobber a deliberate name. A title is a stub when it is
 * empty, or it exactly equals `deriveTitle(firstUserContent)`. PURE; never throws.
 */
export function isStubTitle(title: string, firstUserContent: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  if (t.length === 0) return true;
  if (typeof firstUserContent !== 'string') return false;
  return t === deriveTitle(firstUserContent);
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

async function rebuildIndexFromMessages(l: AppStateLayout): Promise<ConversationMeta[]> {
  const dir = getConversationsDir(l);
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

async function preserveCorruptIndex(l: AppStateLayout): Promise<string> {
  const corruptPath = getCorruptIndexPath(l);
  try {
    await rename(getIndexPath(l), corruptPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
  }
  return corruptPath;
}

async function recoverIndex(
  l: AppStateLayout,
  reason: string,
  onWarning: ConversationStoreWarning | undefined,
): Promise<ConversationMeta[]> {
  const corruptPath = await preserveCorruptIndex(l);
  const rebuilt = await rebuildIndexFromMessages(l);
  await writeIndex(l, rebuilt);
  onWarning?.(
    `Recovered conversations index (${reason}); rebuilt ${rebuilt.length} conversation(s), preserved original at ${corruptPath}.`,
  );
  return rebuilt;
}

async function readIndexLocked(
  l: AppStateLayout,
  onWarning: ConversationStoreWarning | undefined,
): Promise<ConversationMeta[]> {
  const result = await readIndexFile(l);
  if (result.kind === 'ok') return result.index;
  if (result.kind === 'absent') return [];
  return recoverIndex(l, result.reason, onWarning);
}

async function readIndex(
  l: AppStateLayout,
  onWarning: ConversationStoreWarning | undefined,
): Promise<ConversationMeta[]> {
  const result = await readIndexFile(l);
  if (result.kind === 'ok') return result.index;
  if (result.kind === 'absent') return [];

  return withLock(getIndexLockPath(l), async () => readIndexLocked(l, onWarning));
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
  layout?: AppStateLayout;
  clock: Clock;
  onWarning?: ConversationStoreWarning;
}): ConversationStore {
  const { clock } = opts;
  const onWarning = opts.onWarning;
  const l = resolveLayout(opts.homeDir, opts.layout);

  return {
    // -----------------------------------------------------------------------
    // list
    // -----------------------------------------------------------------------
    async list(): Promise<ConversationMeta[]> {
      const index = await readIndex(l, onWarning);
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
    async create(
      title: string,
      modeOrOptions?: ConversationMode | CreateConversationOptions,
    ): Promise<ConversationMeta> {
      await ensureDir(l);
      const id = clock.uuid();
      const now = clock.isoNow();
      const options: CreateConversationOptions =
        typeof modeOrOptions === 'string'
          ? { mode: modeOrOptions }
          : (modeOrOptions === undefined ? {} : modeOrOptions);
      const { mode, workspaceRoot } = options;
      const meta: ConversationMeta = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        pinned: false,
        category: null,
        ...(mode !== undefined && mode !== 'auto' ? { mode } : {}),
        ...(() => {
          const normalized = normalizeWorkspaceRoot(workspaceRoot);
          return normalized !== undefined ? { workspaceRoot: normalized } : {};
        })(),
      };

      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
        await writeIndex(l, [meta, ...index]);
      });

      return meta;
    },

    // -----------------------------------------------------------------------
    // load
    // -----------------------------------------------------------------------
    async load(id: string): Promise<SessionEntry[]> {
      let raw: string;
      try {
        raw = await readFile(getMessagePath(l, id), 'utf8');
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
          await ensureDir(l);
          // Append the entry to the conversation's JSONL file
          await atomicAppendJSONL(getMessagePath(l, id), entry);

          // Update index under lock
          await withLock(getIndexLockPath(l), async () => {
            const index = await readIndexLocked(l, onWarning);
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
              ...intensityFields(existing),
              ...activationFields(existing),
              ...modeFields(existing),
              ...workspaceRootFields(existing),
            };

            const newIndex = [...index];
            newIndex[idx] = updated;
            await writeIndex(l, newIndex);
          });
        },
      };
    },

    // -----------------------------------------------------------------------
    // truncateAfter — the controlled, atomic, fail-soft departure from append-
    // only that powers /retry and /edit (rewrite the log to its first
    // `keepCount` entries; clear the now-possibly-stale recap; bump messageCount).
    // -----------------------------------------------------------------------
    async truncateAfter(id: string, keepCount: number): Promise<number> {
      // Path/id validation FIRST — this op overwrites a file, so a bad id must
      // never resolve a path. Fail-soft: a no-op (0), never a throw.
      if (!isValidConversationId(id)) return 0;

      const keep = Math.max(0, Math.floor(Number.isFinite(keepCount) ? keepCount : 0));
      const messagePath = getMessagePath(l, id);

      // The conversations dir must exist before acquiring the lock (the lock file
      // lives there) — matches setPinned/setCategory/setRecap. Fail-soft.
      try {
        await ensureDir(l);
      } catch {
        return 0;
      }

      // Read the current log OUTSIDE the rewrite is unsafe (TOCTOU), so do the
      // whole read-decide-rewrite INSIDE the index lock — the same lock that
      // guards the messageCount/recap update — so a concurrent append can't
      // interleave with the rewrite.
      return withLock(getIndexLockPath(l), async () => {
        let entries: SessionEntry[];
        try {
          entries = await loadMessageFile(messagePath);
        } catch (err) {
          const nodeErr = err as NodeJS.ErrnoException;
          if (nodeErr.code === 'ENOENT') return 0; // no log → nothing to truncate
          // Unreadable log: fail-soft. Leave it untouched rather than risk
          // clobbering a recoverable file; report the best-known length (0).
          return 0;
        }

        const newLength = Math.min(keep, entries.length);
        // Already covers (or exceeds) the whole log → genuine no-op, no rewrite.
        if (newLength >= entries.length) return entries.length;

        const kept = entries.slice(0, newLength);

        // Atomic rewrite: tmp + rename (atomicWrite), same as the index. A crash
        // mid-write leaves the original log intact (rename is the commit point).
        const body = kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : '');
        try {
          await atomicWrite(messagePath, body);
        } catch {
          // A rewrite failure must NOT corrupt the conversation or crash the
          // loop. atomicWrite either fully commits or leaves the original in
          // place; on failure we report the unchanged length.
          return entries.length;
        }

        // Update the index: new count + CLEAR the cached recap (it may describe
        // turns that no longer exist). Best-effort — the log is already the
        // source of truth; an index miss self-heals on the next rebuild.
        const index = await readIndexLocked(l, onWarning);
        const idx = index.findIndex((m) => m.id === id);
        if (idx !== -1) {
          const existing = index[idx];
          if (existing !== undefined) {
            const updated: ConversationMeta = {
              id: existing.id,
              title: existing.title,
              createdAt: existing.createdAt,
              updatedAt: clock.isoNow(),
              messageCount: newLength,
              pinned: existing.pinned,
              category: existing.category,
              // Drop the recap provenance entirely so resume regenerates rather
              // than show a recap of deleted turns (isRecapStale → regenerate).
              recap: null,
              recapAt: null,
              ...intensityFields(existing),
              ...activationFields(existing),
              ...modeFields(existing),
              ...workspaceRootFields(existing),
            };
            const newIndex = [...index];
            newIndex[idx] = updated;
            await writeIndex(l, newIndex);
          }
        }

        return newLength;
      });
    },

    // -----------------------------------------------------------------------
    // rename
    // -----------------------------------------------------------------------
    async rename(id: string, title: string): Promise<void> {
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
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
          ...intensityFields(existing),
          ...activationFields(existing),
          ...modeFields(existing),
          ...workspaceRootFields(existing),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(l, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // remove
    // -----------------------------------------------------------------------
    async remove(id: string): Promise<void> {
      // Preserve the conversation in the append-only archive BEFORE unlinking, so
      // a delete is recoverable (the archive only ever grows). Best-effort.
      await archiveConversation(id, undefined, l);

      // Best-effort delete of message file
      try {
        await unlink(getMessagePath(l, id));
      } catch {
        // Missing or already gone — ignore
      }

      // Remove from index under lock
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
        const filtered = index.filter((m) => m.id !== id);
        if (filtered.length === index.length) return; // not found, no-op
        await writeIndex(l, filtered);
      });
    },

    // -----------------------------------------------------------------------
    // setPinned
    // -----------------------------------------------------------------------
    async setPinned(id: string, pinned: boolean): Promise<void> {
      await ensureDir(l);
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
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
          ...intensityFields(existing),
          ...activationFields(existing),
          ...modeFields(existing),
          ...workspaceRootFields(existing),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(l, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // setCategory
    // -----------------------------------------------------------------------
    async setCategory(id: string, category: string | null): Promise<void> {
      await ensureDir(l);
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
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
          ...intensityFields(existing),
          ...activationFields(existing),
          ...modeFields(existing),
          ...workspaceRootFields(existing),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(l, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // setRecap — cache the conversation recap (text + provenance) under the lock
    // -----------------------------------------------------------------------
    async setRecap(id: string, recap: string | null, atMessageCount: number): Promise<void> {
      await ensureDir(l);
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
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
          ...intensityFields(existing),
          ...activationFields(existing),
          ...modeFields(existing),
          ...workspaceRootFields(existing),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(l, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // setIntensity — persist a conversation-scoped intensity override under the
    // lock, canonicalizing Auto/inherit to absence.
    // -----------------------------------------------------------------------
    async setIntensity(id: string, intensity: Intensity | undefined): Promise<void> {
      await ensureDir(l);
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
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
          ...recapFields(existing),
          ...activationFields(existing),
          ...modeFields(existing),
          ...workspaceRootFields(existing),
          ...(intensity === undefined || intensity === 'auto' ? {} : { intensity }),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(l, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // setActivation — persist a conversation-scoped activation preference under
    // the lock, canonicalizing adaptive/inherit to absence.
    // -----------------------------------------------------------------------
    async setActivation(
      id: string,
      activation: GoalActivationOverride | undefined,
    ): Promise<void> {
      await ensureDir(l);
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
        const idx = index.findIndex((m) => m.id === id);
        if (idx === -1) return;

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
          ...recapFields(existing),
          ...intensityFields(existing),
          ...modeFields(existing),
          ...workspaceRootFields(existing),
          ...(activation === undefined || activation === 'adaptive' ? {} : { activation }),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(l, newIndex);
      });
    },

    // -----------------------------------------------------------------------
    // setMode — persist or clear the per-conversation firepower mode override
    // under the lock, canonicalizing auto/inherit to absence.
    // -----------------------------------------------------------------------
    async setMode(id: string, mode: ConversationMode | undefined): Promise<void> {
      await ensureDir(l);
      await withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
        const idx = index.findIndex((m) => m.id === id);
        if (idx === -1) return;

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
          ...recapFields(existing),
          ...intensityFields(existing),
          ...activationFields(existing),
          ...workspaceRootFields(existing),
          ...(mode === undefined || mode === 'auto' ? {} : { mode }),
        };
        const newIndex = [...index];
        newIndex[idx] = updated;
        await writeIndex(l, newIndex);
      });
    },
  };
}
