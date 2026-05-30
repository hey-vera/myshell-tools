/**
 * Unit tests for src/infra/conversations.ts
 * Run with: node --import ./test/register.mjs --test "test/unit/conversations.test.ts"
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createFileConversationStore } from '../../src/infra/conversations.ts';
import type { Clock } from '../../src/core/types.ts';
import type { SessionEntry } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

function makeFakeClock(fixedIso = '2024-01-01T00:00:00.000Z'): Clock & { advance(): void } {
  let counter = 0;
  let iso = fixedIso;
  return {
    now() {
      return new Date(iso).getTime();
    },
    isoNow() {
      return iso;
    },
    uuid() {
      counter += 1;
      return `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`;
    },
    random() {
      return 0.5;
    },
    advance() {
      // Advance the clock by 1 second
      const d = new Date(iso);
      d.setSeconds(d.getSeconds() + 1);
      iso = d.toISOString();
    },
  };
}

function makeEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    timestamp: new Date().toISOString(),
    role: 'user',
    content: 'Hello world',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// create / list
// ---------------------------------------------------------------------------

describe('createFileConversationStore — create and list', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `conv-test-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('list returns [] when no conversations exist', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    const list = await store.list();
    assert.deepEqual(list, []);
  });

  it('create returns metadata with id, title, timestamps, messageCount 0', async () => {
    const clock = makeFakeClock('2024-06-01T10:00:00.000Z');
    const store = createFileConversationStore({ homeDir, clock });
    const meta = await store.create('Test conversation');
    assert.equal(typeof meta.id, 'string');
    assert.ok(meta.id.length > 0);
    assert.equal(meta.title, 'Test conversation');
    assert.equal(meta.createdAt, '2024-06-01T10:00:00.000Z');
    assert.equal(meta.updatedAt, '2024-06-01T10:00:00.000Z');
    assert.equal(meta.messageCount, 0);
  });

  it('list returns 2 conversations newest-first by updatedAt', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-order-${randomUUID()}-`));
    try {
      const clock = makeFakeClock('2024-01-01T00:00:00.000Z');
      const store = createFileConversationStore({ homeDir: home2, clock });

      await store.create('Older conversation');
      clock.advance(); // advance clock so second conversation has a later updatedAt
      await store.create('Newer conversation');

      const list = await store.list();
      assert.equal(list.length, 2);
      // Newest first (higher updatedAt sorts first)
      assert.equal(list[0]?.title, 'Newer conversation');
      assert.equal(list[1]?.title, 'Older conversation');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writer / load
// ---------------------------------------------------------------------------

describe('createFileConversationStore — writer and load', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `conv-writer-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('writer.id matches conversation id', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    const meta = await store.create('My session');
    const w = store.writer(meta.id);
    assert.equal(w.id, meta.id);
  });

  it('append persists entries and load returns them', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    const meta = await store.create('Entries test');
    const w = store.writer(meta.id);

    const e1 = makeEntry({ role: 'user', content: 'first' });
    const e2 = makeEntry({ role: 'assistant', content: 'second' });
    await w.append(e1);
    await w.append(e2);

    const entries = await store.load(meta.id);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.content, 'first');
    assert.equal(entries[1]?.content, 'second');
  });

  it('load returns [] for unknown id', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    const result = await store.load('nonexistent-id');
    assert.deepEqual(result, []);
  });

  it('append bumps messageCount in list()', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-count-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Count test');

      const w = store.writer(meta.id);
      await w.append(makeEntry({ role: 'assistant', content: 'msg 1' }));
      await w.append(makeEntry({ role: 'assistant', content: 'msg 2' }));

      const list = await store.list();
      const found = list.find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found?.messageCount, 2);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('first user message sets the title when created with a placeholder', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-title-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      // Create with empty title (placeholder)
      const meta = await store.create('');
      const w = store.writer(meta.id);

      await w.append(makeEntry({ role: 'user', content: 'What is the meaning of life?' }));

      const list = await store.list();
      const found = list.find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found?.title, 'What is the meaning of life?');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('long user message is truncated to 80 chars for title', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-truncate-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('');
      const w = store.writer(meta.id);

      const longContent = 'A'.repeat(200);
      await w.append(makeEntry({ role: 'user', content: longContent }));

      const list = await store.list();
      const found = list.find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found?.title.length, 80);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('non-user first message does not override title', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-notitle-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('My fixed title');
      const w = store.writer(meta.id);

      // assistant message should not change the title
      await w.append(makeEntry({ role: 'assistant', content: 'I am the assistant' }));

      const list = await store.list();
      const found = list.find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found?.title, 'My fixed title');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// rename / remove
// ---------------------------------------------------------------------------

describe('createFileConversationStore — rename and remove', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `conv-rr-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('rename updates title in list()', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    const meta = await store.create('Original title');

    await store.rename(meta.id, 'New title');

    const list = await store.list();
    const found = list.find((m) => m.id === meta.id);
    assert.ok(found !== undefined);
    assert.equal(found?.title, 'New title');
  });

  it('rename on unknown id is a no-op (no throw)', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    // Should not throw
    await store.rename('does-not-exist', 'Whatever');
  });

  it('remove deletes conversation from list()', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    const meta = await store.create('To be deleted');

    await store.remove(meta.id);

    const list = await store.list();
    const found = list.find((m) => m.id === meta.id);
    assert.equal(found, undefined);
  });

  it('remove on unknown id is a no-op (no throw)', async () => {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir, clock });
    // Should not throw
    await store.remove('ghost-id');
  });

  it('remove also deletes the message file', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-rmfile-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('With messages');
      const w = store.writer(meta.id);
      await w.append(makeEntry({ content: 'message content' }));

      // Confirm load works before remove
      const before = await store.load(meta.id);
      assert.equal(before.length, 1);

      await store.remove(meta.id);

      // After remove, load returns []
      const after = await store.load(meta.id);
      assert.deepEqual(after, []);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Resilience: corrupt / missing index
// ---------------------------------------------------------------------------

describe('createFileConversationStore — resilience', () => {
  it('list returns [] when index.json is missing', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-missing-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const list = await store.list();
      assert.deepEqual(list, []);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('list returns [] when index.json is corrupt JSON (no throw)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-corrupt-${randomUUID()}-`));
    try {
      const convDir = join(home2, '.myshell-tools', 'conversations');
      await mkdir(convDir, { recursive: true });
      await writeFile(join(convDir, 'index.json'), 'NOT VALID JSON', 'utf8');

      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const list = await store.list();
      assert.deepEqual(list, []);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('load skips malformed JSONL lines without throwing', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-malformed-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Malformed test');
      const w = store.writer(meta.id);
      await w.append(makeEntry({ content: 'valid line' }));

      // Inject corrupt line directly
      const { appendFile } = await import('node:fs/promises');
      const convDir = join(home2, '.myshell-tools', 'conversations');
      await appendFile(join(convDir, `${meta.id}.jsonl`), 'NOT JSON\n', 'utf8');

      await w.append(makeEntry({ content: 'another valid' }));

      const entries = await store.load(meta.id);
      assert.equal(entries.length, 2);
      assert.equal(entries[0]?.content, 'valid line');
      assert.equal(entries[1]?.content, 'another valid');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});
