/**
 * src/providers/native-sessions.ts — Read-only access to native Claude/Codex transcripts.
 *
 * Supports two operations:
 *   1. `listNativeSessions`   — scan the native CLI's transcript directory and
 *      return lightweight metadata (newest first, bounded by `limit`).
 *   2. `importNativeSession`  — parse a native session and seed a NEW myshell-tools
 *      conversation from its message history. The native file is NEVER modified.
 *
 * Pure parsers (`parseClaudeSession`, `parseCodexSession`) contain zero I/O — they
 * operate on raw file content strings and are hermetic-testable.
 *
 * On-disk formats (defensive — never throw on bad input):
 *
 * Claude: `~/.claude/projects/<slug>/<session-uuid>.jsonl`
 *   Each line has a `type`. Conversation turns are `type:"user"` or `type:"assistant"`,
 *   with `message.role` and `message.content` (string or text-block array).
 *   Meta line types to skip: custom-title, agent-name, agent-setting, permission-mode,
 *   file-history-snapshot, summary, system, and anything else.
 *
 * Codex: `~/.codex/archived_sessions/rollout-<ts>-<uuid>.jsonl`
 *   A `type:"session_meta"` line carries `{ id, timestamp, cwd, ... }`.
 *   Conversation turns are `type:"response_item"` with `payload.type:"message"`,
 *   `payload.role` ('user'|'assistant'|'developer'), `payload.content` array of
 *   `{ type:"input_text"|"output_text", text:"..." }`.
 *   Skip role 'developer'/'system'.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionEntry } from '../core/types.js';
import type { ConversationStore, ConversationMode } from '../infra/conversation-store.js';
import type { ProviderId } from './port.js';
import { defaultStateLayout } from '../infra/state-layout.js';
import { resolveProviderHome } from './provider-home.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface NativeSession {
  readonly provider: ProviderId;
  readonly id: string;
  readonly file: string;
  readonly updatedAt: string; // ISO
  readonly title: string;
  readonly messageCount: number;
}

// ---------------------------------------------------------------------------
// Claude parser
// ---------------------------------------------------------------------------

/** Meta line types that are not conversation turns — skip silently. */
const CLAUDE_META_TYPES = new Set([
  'custom-title',
  'agent-name',
  'agent-setting',
  'permission-mode',
  'file-history-snapshot',
  'summary',
  'system',
]);

/**
 * Extract the text from a Claude message content value.
 * Content may be a plain string or an array of blocks like
 * `[{ "type": "text", "text": "..." }, ...]`.
 * Only `type:"text"` blocks are extracted; tool_use/tool_result blocks are ignored.
 */
function extractClaudeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as Record<string, unknown>)['type'] === 'text'
    ) {
      const text = (block as Record<string, unknown>)['text'];
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

/**
 * Parse a raw Claude JSONL session file content into ordered SessionEntry[].
 *
 * Pure, hermetic, never throws. Returns [] on any unrecoverable input.
 */
export function parseClaudeSession(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj['type'];
    if (typeof type !== 'string') continue;

    // Skip known meta line types
    if (CLAUDE_META_TYPES.has(type)) continue;

    // Only process user/assistant turns
    if (type !== 'user' && type !== 'assistant') continue;

    const message = obj['message'];
    if (typeof message !== 'object' || message === null) continue;
    const msg = message as Record<string, unknown>;

    const role = msg['role'];
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractClaudeContent(msg['content']);
    if (text.trim().length === 0) continue;

    // Prefer explicit timestamp if present
    const ts =
      typeof obj['timestamp'] === 'string' && obj['timestamp'].length > 0
        ? obj['timestamp']
        : new Date().toISOString();

    entries.push({
      timestamp: ts,
      role: role as 'user' | 'assistant',
      content: text,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Codex parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw Codex JSONL session file content into ordered SessionEntry[].
 *
 * Pure, hermetic, never throws. Returns [] on any unrecoverable input.
 */
export function parseCodexSession(content: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  let sessionTimestamp: string | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj['type'];
    if (typeof type !== 'string') continue;

    // Capture session-level timestamp from session_meta
    if (type === 'session_meta') {
      if (typeof obj['timestamp'] === 'string') {
        sessionTimestamp = obj['timestamp'];
      }
      continue;
    }

    // Only process response_item turns
    if (type !== 'response_item') continue;

    const payload = obj['payload'];
    if (typeof payload !== 'object' || payload === null) continue;
    const p = payload as Record<string, unknown>;

    // Only message payloads
    if (p['type'] !== 'message') continue;

    const role = p['role'];
    // Skip developer/system roles
    if (role !== 'user' && role !== 'assistant') continue;

    // Extract text from content array
    const contentArr = p['content'];
    if (!Array.isArray(contentArr)) continue;

    const parts: string[] = [];
    for (const block of contentArr) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      const bType = b['type'];
      if (bType === 'input_text' || bType === 'output_text') {
        if (typeof b['text'] === 'string') parts.push(b['text']);
      }
    }

    const text = parts.join('');
    if (text.trim().length === 0) continue;

    const ts = sessionTimestamp ?? new Date().toISOString();

    entries.push({
      timestamp: ts,
      role: role as 'user' | 'assistant',
      content: text,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Title derivation
// ---------------------------------------------------------------------------

const MAX_TITLE_LEN = 80;

/**
 * Is this content a system-injected wrapper rather than a real human prompt?
 * Both CLIs prepend context/caveat blocks (e.g. `<environment_context>`,
 * `<local-command-caveat>`, `<command-name>`, "Caveat: …") as the first "user"
 * turn — those make terrible titles, so we skip them.
 */
function isWrapperMessage(content: string): boolean {
  const s = content.trim();
  return s.startsWith('<') || /^caveat:/i.test(s);
}

/**
 * Derive a display title from the first REAL user message (skipping system
 * wrappers), with any residual XML-ish tags stripped. Falls back to the first
 * user message if every one looks like a wrapper.
 */
export function deriveTitle(entries: SessionEntry[]): string {
  const users = entries.filter((e) => e.role === 'user' && e.content.trim().length > 0);
  const chosen = users.find((u) => !isWrapperMessage(u.content)) ?? users[0];
  if (chosen === undefined) return '';
  let s = chosen.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length === 0) s = chosen.content.trim();
  return s.length <= MAX_TITLE_LEN ? s : s.slice(0, MAX_TITLE_LEN);
}

// ---------------------------------------------------------------------------
// Directory layout
// ---------------------------------------------------------------------------

/**
 * Resolve a provider's config base dir. Honours `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
 * (set by Replit/bashrc or our own replitPersistentEnv) so we find sessions in the
 * PERSISTENT workspace dir, not just the ephemeral `~/.claude` / `~/.codex`.
 *
 * Delegates to resolveProviderHome so the full precedence (explicit env →
 * myshell-managed → .replit-tools back-compat → home-dir fallback) is
 * centralised in provider-home.ts.
 */
function providerBaseDir(
  provider: ProviderId,
  homeDir: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  try {
    return resolveProviderHome(provider, {
      env: env ?? process.env,
      layout: defaultStateLayout(),
      cwd,
      home: homeDir,
    });
  } catch {
    // Fall through to legacy logic
  }
  if (provider === 'claude') {
    const cfg = env?.['CLAUDE_CONFIG_DIR'];
    return cfg !== undefined && cfg.length > 0 ? cfg : join(homeDir, '.claude');
  }
  const codex = env?.['CODEX_HOME'];
  return codex !== undefined && codex.length > 0 ? codex : join(homeDir, '.codex');
}

/** Return the directories to scan for a given provider. */
function nativeDirs(provider: ProviderId, homeDir: string, cwd: string, env?: NodeJS.ProcessEnv): string[] {
  const base = providerBaseDir(provider, homeDir, cwd, env);
  if (provider === 'claude') {
    return [join(base, 'projects'), join(base, 'sessions')];
  }
  return [join(base, 'archived_sessions'), join(base, 'sessions')];
}

/** True when a filename looks like a native session file for the given provider. */
function isNativeFile(provider: ProviderId, name: string): boolean {
  if (provider === 'claude') return name.endsWith('.jsonl');
  // Codex: rollout-<ts>-<uuid>.jsonl or any .jsonl
  return name.endsWith('.jsonl');
}

// ---------------------------------------------------------------------------
// listNativeSessions
// ---------------------------------------------------------------------------

/**
 * Scan the native CLI's transcript directories for the given provider, sort by
 * file mtime descending, take up to `limit` (default 12), parse each for title
 * and messageCount, and return `NativeSession[]`.
 *
 * Returns [] if the directories do not exist. Never throws.
 */
export async function listNativeSessions(
  provider: ProviderId,
  opts?: { homeDir?: string; limit?: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<NativeSession[]> {
  const home = opts?.homeDir ?? homedir();
  const limit = opts?.limit ?? 12;
  const cwd = opts?.cwd ?? process.cwd();
  const dirs = nativeDirs(provider, home, cwd, opts?.env);

  // Collect candidate files across all directories
  const candidates: Array<{ file: string; mtimeMs: number }> = [];

  for (const dir of dirs) {
    // Recursively scan (Claude stores sessions in per-project sub-dirs)
    await collectFiles(dir, provider, candidates);
  }

  // Sort newest first
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Take at most `limit` and parse each
  const top = candidates.slice(0, limit);
  const sessions: NativeSession[] = [];

  for (const { file, mtimeMs } of top) {
    try {
      const content = await readFile(file, 'utf8');
      const entries =
        provider === 'claude' ? parseClaudeSession(content) : parseCodexSession(content);

      const id = deriveId(provider, file);
      const title = deriveTitle(entries);
      const updatedAt = new Date(mtimeMs).toISOString();

      sessions.push({
        provider,
        id,
        file,
        updatedAt,
        title,
        messageCount: entries.length,
      });
    } catch {
      // Skip files we can't read
    }
  }

  return sessions;
}

/** Recursively collect .jsonl files and their mtime, appending into `out`. */
async function collectFiles(
  dir: string,
  provider: ProviderId,
  out: Array<{ file: string; mtimeMs: number }>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory missing or inaccessible
  }

  for (const entry of entries) {
    const full = join(dir, String(entry.name));
    if (entry.isDirectory()) {
      await collectFiles(full, provider, out);
    } else if (entry.isFile() && isNativeFile(provider, entry.name)) {
      try {
        const s = await stat(full);
        out.push({ file: full, mtimeMs: s.mtimeMs });
      } catch {
        // skip
      }
    }
  }
}

/** Derive a session id from the file path. For Claude: the filename stem (= session uuid). */
function deriveId(_provider: ProviderId, file: string): string {
  const base = file.split(/[\\/]/).at(-1) ?? file;
  return base.replace(/\.jsonl$/, '');
}

// ---------------------------------------------------------------------------
// importNativeSession
// ---------------------------------------------------------------------------

/**
 * Parse a native session file and seed a NEW myshell-tools conversation with
 * its message history. The native file is NEVER modified.
 *
 * Returns the new conversation's `id` and the number of messages imported.
 */
export async function importNativeSession(
  session: NativeSession,
  store: ConversationStore,
  mode?: ConversationMode,
): Promise<{ id: string; imported: number }> {
  const content = await readFile(session.file, 'utf8');
  const entries =
    session.provider === 'claude'
      ? parseClaudeSession(content)
      : parseCodexSession(content);

  const title =
    session.title.length > 0 ? session.title : `Imported from ${session.provider} — ${session.id}`;

  const meta = await store.create(title, mode);
  const writer = store.writer(meta.id);

  for (const entry of entries) {
    await writer.append(entry);
  }

  return { id: meta.id, imported: entries.length };
}

// ---------------------------------------------------------------------------
// listRecentNativeSessions — merged claude + codex, newest first
// ---------------------------------------------------------------------------

/**
 * List recent native sessions across BOTH claude and codex, merged and sorted by
 * recency (newest first), capped at `limit`. This powers the single numbered
 * "resume a Claude/Codex session" picker — one list, press a number, no
 * pick-the-provider-first step (mirrors DATA Tools' cross-tool resume).
 *
 * Only scans providers in `providers` (default both). Honours
 * CLAUDE_CONFIG_DIR/CODEX_HOME via `opts.env`. Returns [] when nothing is found.
 * Never throws.
 */
export async function listRecentNativeSessions(opts?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  providers?: readonly ProviderId[];
  cwd?: string;
}): Promise<NativeSession[]> {
  const limit = opts?.limit ?? 9;
  const providers = opts?.providers ?? (['claude', 'codex'] as const);
  const cwd = opts?.cwd ?? process.cwd();
  const perProvider: { homeDir?: string; env?: NodeJS.ProcessEnv; limit: number; cwd: string } = {
    limit,
    cwd,
    ...(opts?.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts?.env !== undefined ? { env: opts.env } : {}),
  };

  const lists = await Promise.all(
    providers.map((p) => listNativeSessions(p, perProvider).catch(() => [] as NativeSession[])),
  );

  return lists
    .flat()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit);
}
