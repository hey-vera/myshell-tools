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

  it('create defaults pinned=false and category=null', async () => {
    const clock = makeFakeClock('2024-06-01T10:00:00.000Z');
    const store = createFileConversationStore({ homeDir, clock });
    const meta = await store.create('Defaults test');
    assert.equal(meta.pinned, false);
    assert.equal(meta.category, null);
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
// setPinned / setCategory
// ---------------------------------------------------------------------------

describe('createFileConversationStore — setPinned and setCategory', () => {
  it('setPinned(true) makes a conversation sort before unpinned ones', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-pin-${randomUUID()}-`));
    try {
      const clock = makeFakeClock('2024-01-01T00:00:00.000Z');
      const store = createFileConversationStore({ homeDir: home2, clock });

      await store.create('Unpinned A');
      clock.advance();
      const b = await store.create('To be pinned B');

      // B was created after A so it is already first; pin A to force it ahead
      const a = (await store.list()).find((m) => m.title === 'Unpinned A');
      assert.ok(a !== undefined);
      await store.setPinned(a.id, true);

      const list = await store.list();
      assert.equal(list[0]?.title, 'Unpinned A', 'pinned conversation is first');
      assert.equal(list[1]?.title, 'To be pinned B');
      // pinned flag is reflected
      assert.equal(list[0]?.pinned, true);
      assert.equal(list[1]?.pinned, false);
      void b; // used above
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('setPinned(false) demotes a pinned conversation back to updatedAt order', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-unpin-${randomUUID()}-`));
    try {
      const clock = makeFakeClock('2024-01-01T00:00:00.000Z');
      const store = createFileConversationStore({ homeDir: home2, clock });

      const a = await store.create('A');
      clock.advance();
      await store.create('B');

      // pin A, then unpin it
      await store.setPinned(a.id, true);
      await store.setPinned(a.id, false);

      const list = await store.list();
      // B has a later updatedAt, so it should be first now that A is not pinned
      assert.equal(list[0]?.title, 'B');
      assert.equal(list[1]?.title, 'A');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('setPinned is a no-op for unknown id', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-pinnoop-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      // Should not throw
      await store.setPinned('does-not-exist', true);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('setCategory persists the tag and list/load reflect it', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-cat-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Categorised conversation');

      await store.setCategory(meta.id, 'ui');

      const list = await store.list();
      const found = list.find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.category, 'ui');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('setCategory(null) clears an existing category', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-catclear-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Category then clear');

      await store.setCategory(meta.id, 'refactor');
      await store.setCategory(meta.id, null);

      const list = await store.list();
      const found = list.find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.category, null);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('setCategory is a no-op for unknown id', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-catnoop-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      // Should not throw
      await store.setCategory('does-not-exist', 'ui');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy index migration (entries written before pinned/category existed)
// ---------------------------------------------------------------------------

describe('createFileConversationStore — legacy index migration', () => {
  it('old index entries missing pinned/category still load with defaults', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-legacy-${randomUUID()}-`));
    try {
      // Write a legacy index.json that is missing pinned and category fields
      const convDir = join(home2, '.myshell-tools', 'conversations');
      await mkdir(convDir, { recursive: true });
      const legacyIndex = [
        {
          id: 'legacy-id-1',
          title: 'Old conversation',
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z',
          messageCount: 3,
          // deliberately omits: pinned, category
        },
      ];
      await writeFile(join(convDir, 'index.json'), JSON.stringify(legacyIndex), 'utf8');

      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const list = await store.list();

      assert.equal(list.length, 1);
      assert.equal(list[0]?.title, 'Old conversation');
      // Migrated to defaults
      assert.equal(list[0]?.pinned, false);
      assert.equal(list[0]?.category, null);
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
