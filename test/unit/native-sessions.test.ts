/**
 * test/unit/native-sessions.test.ts — unit tests for src/providers/native-sessions.ts
 *
 * Covers:
 *   - parseClaudeSession: string content, array-of-blocks content, meta-line
 *     skipping, developer-role skip (n/a for Claude), garbage resilience.
 *   - parseCodexSession: input_text/output_text blocks, developer-role skip,
 *     session_meta timestamp capture, garbage resilience.
 *   - listNativeSessions: temp homeDir with sample files, newest-first ordering,
 *     title and messageCount derivation.
 *   - importNativeSession: creates a conversation + appends entries via an
 *     in-memory store; source file is never modified.
 *
 * All I/O uses real temp directories; no real claude/codex binaries are spawned.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  parseClaudeSession,
  parseCodexSession,
  listNativeSessions,
  listRecentNativeSessions,
  importNativeSession,
  deriveTitle,
} from '../../src/providers/native-sessions.ts';
import type { NativeSession } from '../../src/providers/native-sessions.ts';
import type { SessionEntry } from '../../src/core/types.ts';

describe('deriveTitle — skips system-wrapper first messages', () => {
  const mk = (role: 'user' | 'assistant', content: string): SessionEntry => ({
    timestamp: '2026-01-01T00:00:00.000Z',
    role,
    content,
  });
  it('uses the first REAL user message, not an <environment_context> wrapper', () => {
    assert.equal(
      deriveTitle([
        mk('user', '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>'),
        mk('assistant', 'ok'),
        mk('user', 'Refactor the auth module please'),
      ]),
      'Refactor the auth module please',
    );
  });
  it('skips a "Caveat:" wrapper too', () => {
    assert.equal(
      deriveTitle([
        mk('user', 'Caveat: The messages below were generated while running local commands.'),
        mk('user', 'Add a dark mode toggle'),
      ]),
      'Add a dark mode toggle',
    );
  });
  it('strips residual xml tags and never returns empty when a user msg exists', () => {
    const t = deriveTitle([mk('user', '<command-name>/model</command-name>')]);
    assert.equal(t.includes('<'), false);
    assert.ok(t.length > 0);
  });
});
import type { ConversationMeta, ConversationStore } from '../../src/infra/conversation-store.ts';
import type { SessionEntry, SessionWriter } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Fake in-memory ConversationStore
// ---------------------------------------------------------------------------

interface FakeStore extends ConversationStore {
  readonly metas: ConversationMeta[];
  readonly written: Map<string, SessionEntry[]>;
}

function makeFakeStore(): FakeStore {
  const metas: ConversationMeta[] = [];
  const written = new Map<string, SessionEntry[]>();
  let counter = 0;

  return {
    metas,
    written,

    async list() {
      return [...metas];
    },

    async create(title: string): Promise<ConversationMeta> {
      counter += 1;
      const id = `fake-${counter}`;
      const now = new Date().toISOString();
      const meta: ConversationMeta = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        pinned: false,
        category: null,
      };
      metas.push(meta);
      return meta;
    },

    async load(id: string): Promise<SessionEntry[]> {
      return written.get(id) ?? [];
    },

    async rename(id: string, title: string): Promise<void> {
      const m = metas.find((x) => x.id === id);
      if (m !== undefined) {
        const idx = metas.indexOf(m);
        metas[idx] = { ...m, title };
      }
    },

    async remove(id: string): Promise<void> {
      const idx = metas.findIndex((m) => m.id === id);
      if (idx >= 0) metas.splice(idx, 1);
    },

    writer(id: string): SessionWriter {
      if (!written.has(id)) written.set(id, []);
      const arr = written.get(id)!;
      return {
        id,
        async append(entry: SessionEntry): Promise<void> {
          arr.push(entry);
        },
      };
    },

    async setPinned(): Promise<void> { /* no-op */ },
    async setCategory(): Promise<void> { /* no-op */ },
    async setRecap(): Promise<void> { /* no-op */ },
    async setIntensity(): Promise<void> { /* no-op */ },
    async truncateAfter(id: string, keepCount: number): Promise<number> {
      const arr = written.get(id);
      if (arr === undefined) return 0;
      const keep = Math.max(0, Math.min(Math.floor(keepCount), arr.length));
      arr.length = keep;
      return keep;
    },
  };
}

// ---------------------------------------------------------------------------
// parseClaudeSession
// ---------------------------------------------------------------------------

describe('parseClaudeSession — pure parser', () => {
  it('returns [] for empty content', () => {
    assert.deepEqual(parseClaudeSession(''), []);
  });

  it('returns [] for completely garbage content', () => {
    assert.deepEqual(parseClaudeSession('NOT JSON AT ALL\n{broken\n'), []);
  });

  it('parses a user turn with string content', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2024-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Hello world' },
    });
    const entries = parseClaudeSession(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'user');
    assert.equal(entries[0]?.content, 'Hello world');
    assert.equal(entries[0]?.timestamp, '2024-01-01T00:00:00.000Z');
  });

  it('parses an assistant turn with string content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:01:00.000Z',
      message: { role: 'assistant', content: 'Hi there!' },
    });
    const entries = parseClaudeSession(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'assistant');
    assert.equal(entries[0]?.content, 'Hi there!');
  });

  it('parses array-of-blocks content, extracting text blocks only', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2024-01-02T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Part one ' },
          { type: 'tool_use', id: 'call-1', name: 'bash', input: {} }, // should be ignored
          { type: 'text', text: 'Part two' },
        ],
      },
    });
    const entries = parseClaudeSession(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'Part one Part two');
  });

  it('skips meta line types: custom-title, summary, system, etc.', () => {
    const lines = [
      JSON.stringify({ type: 'custom-title', title: 'My session' }),
      JSON.stringify({ type: 'summary', summary: 'Summary text' }),
      JSON.stringify({ type: 'system', content: 'System prompt' }),
      JSON.stringify({ type: 'agent-name', name: 'agent' }),
      JSON.stringify({ type: 'agent-setting', key: 'v', value: 'x' }),
      JSON.stringify({ type: 'permission-mode', mode: 'default' }),
      JSON.stringify({ type: 'file-history-snapshot', files: [] }),
      JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'Actual message' },
      }),
    ].join('\n');

    const entries = parseClaudeSession(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'Actual message');
  });

  it('skips lines with unknown type', () => {
    const lines = [
      JSON.stringify({ type: 'unknown-future-type', data: 'whatever' }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2024-01-01T00:01:00.000Z',
        message: { role: 'assistant', content: 'Response' },
      }),
    ].join('\n');

    const entries = parseClaudeSession(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'Response');
  });

  it('skips blocks where message.content is an empty array', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [] },
    });
    const entries = parseClaudeSession(line);
    assert.deepEqual(entries, []);
  });

  it('skips blocks where text is whitespace-only', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '   \n\t  ' },
    });
    const entries = parseClaudeSession(line);
    assert.deepEqual(entries, []);
  });

  it('preserves order across multiple turns', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: 'Q1' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2024-01-01T00:01:00.000Z', message: { role: 'assistant', content: 'A1' } }),
      JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:02:00.000Z', message: { role: 'user', content: 'Q2' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2024-01-01T00:03:00.000Z', message: { role: 'assistant', content: 'A2' } }),
    ].join('\n');
    const entries = parseClaudeSession(lines);
    assert.equal(entries.length, 4);
    assert.equal(entries[0]?.content, 'Q1');
    assert.equal(entries[1]?.content, 'A1');
    assert.equal(entries[2]?.content, 'Q2');
    assert.equal(entries[3]?.content, 'A2');
  });

  it('ignores tool_use and tool_result blocks in array content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2024-01-01T00:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'ls' } },
          { type: 'text', text: 'Result text' },
          { type: 'tool_result', tool_use_id: 'tu1', content: 'output' },
        ],
      },
    });
    const entries = parseClaudeSession(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'Result text');
  });

  it('never throws on deeply malformed input', () => {
    const bad = [
      'null',
      '[]',
      '{"type":123}',
      '{"type":"user","message":null}',
      '{"type":"user","message":{"role":42,"content":"x"}}',
    ].join('\n');
    assert.doesNotThrow(() => parseClaudeSession(bad));
  });
});

// ---------------------------------------------------------------------------
// parseCodexSession
// ---------------------------------------------------------------------------

describe('parseCodexSession — pure parser', () => {
  it('returns [] for empty content', () => {
    assert.deepEqual(parseCodexSession(''), []);
  });

  it('returns [] for completely garbage content', () => {
    assert.deepEqual(parseCodexSession('not json\n{broken'), []);
  });

  it('parses a user turn from response_item', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello codex' }],
      },
    });
    const entries = parseCodexSession(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'user');
    assert.equal(entries[0]?.content, 'Hello codex');
  });

  it('parses an assistant turn with output_text', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Here is my response.' }],
      },
    });
    const entries = parseCodexSession(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'assistant');
    assert.equal(entries[0]?.content, 'Here is my response.');
  });

  it('skips developer role turns', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'System prompt' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'User message' }],
        },
      }),
    ].join('\n');

    const entries = parseCodexSession(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'User message');
  });

  it('skips system role turns', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: 'System instruction' }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Assistant reply' }],
        },
      }),
    ].join('\n');

    const entries = parseCodexSession(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.role, 'assistant');
  });

  it('uses session_meta timestamp when present', () => {
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        id: 'sess-001',
        timestamp: '2024-03-15T10:00:00.000Z',
        cwd: '/home/user',
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hi' }],
        },
      }),
    ].join('\n');

    const entries = parseCodexSession(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.timestamp, '2024-03-15T10:00:00.000Z');
  });

  it('concatenates multiple content blocks', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Part A' },
          { type: 'output_text', text: ' Part B' },
        ],
      },
    });
    const entries = parseCodexSession(line);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'Part A Part B');
  });

  it('skips response_item that is not type:message', () => {
    const lines = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'bash', arguments: '' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'A question' }],
        },
      }),
    ].join('\n');

    const entries = parseCodexSession(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.content, 'A question');
  });

  it('preserves order across multiple turns', () => {
    const lines = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Q1' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A1' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Q2' }] } }),
    ].join('\n');

    const entries = parseCodexSession(lines);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.content, 'Q1');
    assert.equal(entries[1]?.content, 'A1');
    assert.equal(entries[2]?.content, 'Q2');
  });

  it('never throws on deeply malformed input', () => {
    const bad = [
      'null',
      '[]',
      '{"type":"response_item"}',
      '{"type":"response_item","payload":null}',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":null}}',
    ].join('\n');
    assert.doesNotThrow(() => parseCodexSession(bad));
  });
});

// ---------------------------------------------------------------------------
// listNativeSessions
// ---------------------------------------------------------------------------

describe('listNativeSessions', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `native-list-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns [] when the provider directory does not exist', async () => {
    const result = await listNativeSessions('claude', { homeDir });
    assert.deepEqual(result, []);
  });

  it('returns [] for an empty directory', async () => {
    const dir = join(homeDir, '.claude', 'projects');
    await mkdir(dir, { recursive: true });
    const result = await listNativeSessions('claude', { homeDir });
    assert.deepEqual(result, []);
  });

  it('lists Claude sessions from ~/.claude/projects, newest first', async () => {
    const h2 = await mkdtemp(join(tmpdir(), `native-claude-${randomUUID()}-`));
    try {
      const projDir = join(h2, '.claude', 'projects', 'my-project');
      await mkdir(projDir, { recursive: true });

      const olderContent = [
        JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: 'Older question' } }),
      ].join('\n');

      const newerContent = [
        JSON.stringify({ type: 'user', timestamp: '2024-06-01T00:00:00.000Z', message: { role: 'user', content: 'Newer question' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2024-06-01T00:01:00.000Z', message: { role: 'assistant', content: 'Answer' } }),
      ].join('\n');

      // Write older file first
      await writeFile(join(projDir, 'session-old.jsonl'), olderContent, 'utf8');
      // Small delay to ensure different mtime
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(projDir, 'session-new.jsonl'), newerContent, 'utf8');

      const sessions = await listNativeSessions('claude', { homeDir: h2 });

      assert.ok(sessions.length >= 2, `expected at least 2 sessions, got ${sessions.length}`);
      // Newest first
      assert.equal(sessions[0]?.title, 'Newer question');
      assert.equal(sessions[0]?.messageCount, 2);
      assert.equal(sessions[1]?.title, 'Older question');
      assert.equal(sessions[1]?.messageCount, 1);
    } finally {
      await rm(h2, { recursive: true, force: true });
    }
  });

  it('lists Codex sessions from ~/.codex/archived_sessions', async () => {
    const h3 = await mkdtemp(join(tmpdir(), `native-codex-${randomUUID()}-`));
    try {
      const archDir = join(h3, '.codex', 'archived_sessions');
      await mkdir(archDir, { recursive: true });

      const content = [
        JSON.stringify({ type: 'session_meta', id: 'abc', timestamp: '2024-05-01T00:00:00.000Z', cwd: '/home' }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex question' }] } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex answer' }] } }),
      ].join('\n');

      await writeFile(join(archDir, 'rollout-1234-abc.jsonl'), content, 'utf8');

      const sessions = await listNativeSessions('codex', { homeDir: h3 });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.provider, 'codex');
      assert.equal(sessions[0]?.title, 'Codex question');
      assert.equal(sessions[0]?.messageCount, 2);
    } finally {
      await rm(h3, { recursive: true, force: true });
    }
  });

  it('respects the limit option', async () => {
    const h4 = await mkdtemp(join(tmpdir(), `native-limit-${randomUUID()}-`));
    try {
      const projDir = join(h4, '.claude', 'projects', 'proj');
      await mkdir(projDir, { recursive: true });

      for (let i = 0; i < 5; i++) {
        const content = JSON.stringify({ type: 'user', message: { role: 'user', content: `Question ${i}` } });
        await writeFile(join(projDir, `session-${i}.jsonl`), content, 'utf8');
        await new Promise((r) => setTimeout(r, 10));
      }

      const sessions = await listNativeSessions('claude', { homeDir: h4, limit: 3 });
      assert.equal(sessions.length, 3);
    } finally {
      await rm(h4, { recursive: true, force: true });
    }
  });

  it('title defaults to empty string when no user messages exist', async () => {
    const h5 = await mkdtemp(join(tmpdir(), `native-notitle-${randomUUID()}-`));
    try {
      const projDir = join(h5, '.claude', 'projects', 'proj');
      await mkdir(projDir, { recursive: true });

      const content = JSON.stringify({ type: 'custom-title', title: 'meta only' });
      await writeFile(join(projDir, 'empty.jsonl'), content, 'utf8');

      const sessions = await listNativeSessions('claude', { homeDir: h5 });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.title, '');
      assert.equal(sessions[0]?.messageCount, 0);
    } finally {
      await rm(h5, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// importNativeSession
// ---------------------------------------------------------------------------

describe('importNativeSession', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `native-import-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('creates a new conversation and appends all entries', async () => {
    const projDir = join(homeDir, '.claude', 'projects', 'proj');
    await mkdir(projDir, { recursive: true });

    const content = [
      JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: 'First question' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2024-01-01T00:01:00.000Z', message: { role: 'assistant', content: 'First answer' } }),
      JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:02:00.000Z', message: { role: 'user', content: 'Second question' } }),
    ].join('\n');

    const filePath = join(projDir, 'session-abc.jsonl');
    await writeFile(filePath, content, 'utf8');

    const session: NativeSession = {
      provider: 'claude',
      id: 'session-abc',
      file: filePath,
      updatedAt: '2024-01-01T00:02:00.000Z',
      title: 'First question',
      messageCount: 3,
    };

    const store = makeFakeStore();
    const result = await importNativeSession(session, store);

    // Returns the new conversation id and count
    assert.equal(typeof result.id, 'string');
    assert.equal(result.imported, 3);

    // Conversation was created
    assert.equal(store.metas.length, 1);
    assert.equal(store.metas[0]?.title, 'First question');

    // Entries were appended
    const entries = store.written.get(result.id);
    assert.ok(entries !== undefined);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.role, 'user');
    assert.equal(entries[0]?.content, 'First question');
    assert.equal(entries[1]?.role, 'assistant');
    assert.equal(entries[2]?.role, 'user');
  });

  it('uses a fallback title when session.title is empty', async () => {
    const projDir = join(homeDir, '.claude', 'projects', 'proj2');
    await mkdir(projDir, { recursive: true });

    const content = JSON.stringify({ type: 'custom-title', title: 'meta' });
    const filePath = join(projDir, 'no-title.jsonl');
    await writeFile(filePath, content, 'utf8');

    const session: NativeSession = {
      provider: 'claude',
      id: 'no-title',
      file: filePath,
      updatedAt: new Date().toISOString(),
      title: '',
      messageCount: 0,
    };

    const store = makeFakeStore();
    const result = await importNativeSession(session, store);

    assert.ok(store.metas[0]?.title.length > 0, 'title should not be empty');
    assert.ok(store.metas[0]?.title.includes('claude'), 'fallback title should mention provider');
    assert.equal(result.imported, 0);
  });

  it('NEVER modifies the source file', async () => {
    const projDir = join(homeDir, '.claude', 'projects', 'proj3');
    await mkdir(projDir, { recursive: true });

    const content = JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: 'Original content' } });
    const filePath = join(projDir, 'immutable.jsonl');
    await writeFile(filePath, content, 'utf8');

    const before = await readFile(filePath, 'utf8');

    const session: NativeSession = {
      provider: 'claude',
      id: 'immutable',
      file: filePath,
      updatedAt: new Date().toISOString(),
      title: 'Original content',
      messageCount: 1,
    };

    const store = makeFakeStore();
    await importNativeSession(session, store);

    const after = await readFile(filePath, 'utf8');
    assert.equal(after, before, 'source file must not be modified');
  });

  it('works for a Codex session', async () => {
    const archDir = join(homeDir, '.codex', 'archived_sessions');
    await mkdir(archDir, { recursive: true });

    const content = [
      JSON.stringify({ type: 'session_meta', id: 'xyz', timestamp: '2024-02-01T00:00:00.000Z', cwd: '/home' }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex import test' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex response' }] } }),
    ].join('\n');

    const filePath = join(archDir, 'rollout-5678-xyz.jsonl');
    await writeFile(filePath, content, 'utf8');

    const session: NativeSession = {
      provider: 'codex',
      id: 'rollout-5678-xyz',
      file: filePath,
      updatedAt: '2024-02-01T00:00:00.000Z',
      title: 'Codex import test',
      messageCount: 2,
    };

    const store = makeFakeStore();
    const result = await importNativeSession(session, store);

    assert.equal(result.imported, 2);
    const entries = store.written.get(result.id);
    assert.ok(entries !== undefined);
    assert.equal(entries[0]?.role, 'user');
    assert.equal(entries[0]?.content, 'Codex import test');
    assert.equal(entries[1]?.role, 'assistant');
    assert.equal(entries[1]?.content, 'Codex response');
  });
});

// ---------------------------------------------------------------------------
// listRecentNativeSessions — merged claude + codex, config-dir aware
// ---------------------------------------------------------------------------

describe('listRecentNativeSessions', () => {
  it('merges claude + codex sessions, newest first, capped at limit', async () => {
    const home = await mkdtemp(join(tmpdir(), `native-merged-${randomUUID()}-`));
    try {
      const claudeDir = join(home, '.claude', 'projects', 'p');
      const codexDir = join(home, '.codex', 'archived_sessions');
      await mkdir(claudeDir, { recursive: true });
      await mkdir(codexDir, { recursive: true });

      await writeFile(
        join(claudeDir, 'c1.jsonl'),
        JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: 'claude old' } }),
        'utf8',
      );
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(
        join(codexDir, 'rollout-x.jsonl'),
        [
          JSON.stringify({ type: 'session_meta', timestamp: '2024-06-01T00:00:00.000Z', payload: { id: 'cx', timestamp: '2024-06-01T00:00:00.000Z', cwd: '/x' } }),
          JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex newer' }] } }),
        ].join('\n'),
        'utf8',
      );

      const merged = await listRecentNativeSessions({ homeDir: home, limit: 9 });
      assert.equal(merged.length, 2);
      // Newest (codex, written last → larger mtime) comes first.
      assert.equal(merged[0]?.provider, 'codex');
      assert.equal(merged[1]?.provider, 'claude');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('honours CLAUDE_CONFIG_DIR (finds sessions in the persistent dir, not ~/.claude)', async () => {
    const home = await mkdtemp(join(tmpdir(), `native-cfg-${randomUUID()}-`));
    const cfg = await mkdtemp(join(tmpdir(), `native-cfgdir-${randomUUID()}-`));
    try {
      // Nothing under ~/.claude; the real session lives under CLAUDE_CONFIG_DIR.
      const projDir = join(cfg, 'projects', 'p');
      await mkdir(projDir, { recursive: true });
      await writeFile(
        join(projDir, 's.jsonl'),
        JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'user', content: 'persistent session' } }),
        'utf8',
      );

      const withoutEnv = await listRecentNativeSessions({ homeDir: home, providers: ['claude'] });
      assert.equal(withoutEnv.length, 0, 'not found under ~/.claude');

      const withEnv = await listRecentNativeSessions({
        homeDir: home,
        providers: ['claude'],
        env: { CLAUDE_CONFIG_DIR: cfg },
      });
      assert.equal(withEnv.length, 1, 'found via CLAUDE_CONFIG_DIR');
      assert.equal(withEnv[0]?.title, 'persistent session');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cfg, { recursive: true, force: true });
    }
  });

  it('returns [] when nothing exists (never throws)', async () => {
    const home = await mkdtemp(join(tmpdir(), `native-none-${randomUUID()}-`));
    try {
      assert.deepEqual(await listRecentNativeSessions({ homeDir: home }), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
