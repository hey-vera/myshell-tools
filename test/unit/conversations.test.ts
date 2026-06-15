/**
 * Unit tests for src/infra/conversations.ts
 * Run with: node --import ./test/register.mjs --test "test/unit/conversations.test.ts"
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
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

  it('old index entries missing recap fields migrate cleanly — no data loss, no recap fabricated', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-legacy-recap-${randomUUID()}-`));
    try {
      const convDir = join(home2, '.myshell-tools', 'conversations');
      await mkdir(convDir, { recursive: true });
      // A pre-recap index entry: has pinned/category but NONE of recap/recapAt/
      // recapMessageCount. The forward-migration must keep all real data and treat
      // the absent recap as the valid "no recap yet" default (never a scary prompt).
      const legacyIndex = [
        {
          id: 'legacy-id-2',
          title: 'Pre-recap conversation',
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-06-01T00:00:00.000Z',
          messageCount: 7,
          pinned: true,
          category: 'ui',
          // deliberately omits: recap, recapAt, recapMessageCount
        },
      ];
      await writeFile(join(convDir, 'index.json'), JSON.stringify(legacyIndex), 'utf8');

      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const list = await store.list();

      assert.equal(list.length, 1, 'no data loss: the conversation still loads');
      const m = list[0];
      assert.ok(m !== undefined);
      // Real data preserved
      assert.equal(m.title, 'Pre-recap conversation');
      assert.equal(m.messageCount, 7);
      assert.equal(m.pinned, true);
      assert.equal(m.category, 'ui');
      // Recap absent — NOT fabricated, NOT a default string
      assert.equal(m.recap, undefined);
      assert.equal(m.recapAt, undefined);
      assert.equal(m.recapMessageCount, undefined);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// setRecap — recap fields round-trip + preserved across other mutations
// ---------------------------------------------------------------------------

describe('createFileConversationStore — setRecap', () => {
  it('persists recap text + provenance and list reflects them', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-recap-persist-${randomUUID()}-`));
    try {
      const clock = makeFakeClock('2024-06-01T10:00:00.000Z');
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Recap me');

      await store.setRecap(meta.id, 'Migrating auth to JWT; next: expiry tests.', 5);

      const found = (await store.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.recap, 'Migrating auth to JWT; next: expiry tests.');
      assert.equal(found.recapAt, '2024-06-01T10:00:00.000Z');
      assert.equal(found.recapMessageCount, 5);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('setRecap(null) clears the recap', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-recap-clear-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Clear me');
      await store.setRecap(meta.id, 'something', 4);
      await store.setRecap(meta.id, null, 4);
      const found = (await store.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.recap, null);
      assert.equal(found.recapAt, null);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('is a no-op for an unknown id', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-recap-noop-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      await store.setRecap('does-not-exist', 'x', 3); // must not throw
      const found = (await store.list()).find((m) => m.id === 'does-not-exist');
      assert.equal(found, undefined);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('a cached recap survives an unrelated mutation (rename / pin / category)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-recap-survive-${randomUUID()}-`));
    const cleanup = async () => rm(home2, { recursive: true, force: true });
    try {
    const clock = makeFakeClock();
    const store = createFileConversationStore({ homeDir: home2, clock });
    const meta = await store.create('Survivor');
    await store.setRecap(meta.id, 'where we were', 6);

    await store.rename(meta.id, 'Survivor renamed');
    await store.setPinned(meta.id, true);
    await store.setCategory(meta.id, 'refactor');

    const found = (await store.list()).find((m) => m.id === meta.id);
    assert.ok(found !== undefined);
    assert.equal(found.title, 'Survivor renamed');
    assert.equal(found.pinned, true);
    assert.equal(found.category, 'refactor');
    // The recap must NOT be dropped by the unrelated updates
    assert.equal(found.recap, 'where we were');
    assert.equal(found.recapMessageCount, 6);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// setIntensity — numeric round-trip, clear-on-auto/undefined, preservation
// ---------------------------------------------------------------------------

describe('createFileConversationStore — setIntensity', () => {
  it('persists a numeric intensity override and list reflects it', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-intensity-persist-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Dial me');

      await store.setIntensity(meta.id, 4);

      const found = (await store.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.intensity, 4);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('canonicalizes auto/undefined to an absent key and preserves unrelated metadata', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-intensity-clear-${randomUUID()}-`));
    try {
      const clock = makeFakeClock('2024-06-01T10:00:00.000Z');
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Preserve me');
      await store.rename(meta.id, 'Preserve me renamed');
      await store.setPinned(meta.id, true);
      await store.setCategory(meta.id, 'refactor');
      await store.setRecap(meta.id, 'where we were', 6);
      await store.setIntensity(meta.id, 3);
      await store.setIntensity(meta.id, 'auto');

      let found = (await store.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.title, 'Preserve me renamed');
      assert.equal(found.pinned, true);
      assert.equal(found.category, 'refactor');
      assert.equal(found.recap, 'where we were');
      assert.equal(found.recapAt, '2024-06-01T10:00:00.000Z');
      assert.equal(found.recapMessageCount, 6);
      assert.equal(found.intensity, undefined);

      const indexPath = join(home2, '.myshell-tools', 'conversations', 'index.json');
      const rawAfterAuto = await readFile(indexPath, 'utf8');
      assert.equal(rawAfterAuto.includes('"intensity"'), false);

      await store.setIntensity(meta.id, 2);
      await store.setIntensity(meta.id, undefined);

      found = (await store.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.intensity, undefined);

      const rawAfterUndefined = await readFile(indexPath, 'utf8');
      assert.equal(rawAfterUndefined.includes('"intensity"'), false);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// setActivation — non-default round-trip, normalization, clearing, preservation
// ---------------------------------------------------------------------------

describe('createFileConversationStore — setActivation', () => {
  it('persists and normalizes a non-default activation preference', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-activation-persist-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Activation');

      await store.setActivation(meta.id, 'go-when-confident');

      const reopened = createFileConversationStore({ homeDir: home2, clock });
      const found = (await reopened.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.activation, 'go-when-confident');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('leaves activation absent by default and preserves it across unrelated mutations', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-activation-preserve-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Activation');
      assert.equal((await store.list()).find((m) => m.id === meta.id)?.activation, undefined);

      await store.setIntensity(meta.id, 4);
      await store.setActivation(meta.id, 'always-plan-first');
      await store.rename(meta.id, 'Activation renamed');
      await store.setPinned(meta.id, true);

      const found = (await store.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.activation, 'always-plan-first');
      assert.equal(found.intensity, 4);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('canonicalizes adaptive and undefined to an absent persisted key', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-activation-clear-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Activation');
      const indexPath = join(home2, '.myshell-tools', 'conversations', 'index.json');

      await store.setActivation(meta.id, 'go-when-confident');
      await store.setActivation(meta.id, 'adaptive');
      assert.equal((await store.list()).find((m) => m.id === meta.id)?.activation, undefined);
      assert.equal((await readFile(indexPath, 'utf8')).includes('"activation"'), false);

      await store.setActivation(meta.id, 'always-plan-first');
      await store.setActivation(meta.id, undefined);
      assert.equal((await store.list()).find((m) => m.id === meta.id)?.activation, undefined);
      assert.equal((await readFile(indexPath, 'utf8')).includes('"activation"'), false);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// truncateAfter — controlled, atomic, fail-soft departure from append-only
// (powers /retry and /edit). Round-trip, index update, recap-clear, validation,
// atomicity, fail-soft.
// ---------------------------------------------------------------------------

describe('createFileConversationStore — truncateAfter', () => {
  async function seed(home: string, clock: Clock, n: number) {
    const store = createFileConversationStore({ homeDir: home, clock });
    const meta = await store.create('Truncate me');
    const w = store.writer(meta.id);
    for (let i = 0; i < n; i++) {
      await w.append(
        makeEntry({
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `msg ${i}`,
        }),
      );
    }
    return { store, id: meta.id };
  }

  it('keeps the first keepCount entries and drops the rest (round-trip)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-rt-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 5);
      const result = await store.truncateAfter(id, 3);
      assert.equal(result, 3);
      const entries = await store.load(id);
      assert.equal(entries.length, 3);
      assert.equal(entries[0]?.content, 'msg 0');
      assert.equal(entries[2]?.content, 'msg 2');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('updates messageCount in the index to the new length', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-count-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 4);
      await store.truncateAfter(id, 1);
      const found = (await store.list()).find((m) => m.id === id);
      assert.ok(found !== undefined);
      assert.equal(found.messageCount, 1);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('clears any cached recap (it may describe deleted turns)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-recap-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 4);
      await store.setRecap(id, 'we were doing X', 4);
      await store.truncateAfter(id, 2);
      const found = (await store.list()).find((m) => m.id === id);
      assert.ok(found !== undefined);
      assert.equal(found.recap, null);
      assert.equal(found.recapAt, null);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('truncateAfter(0) empties the log', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-zero-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 3);
      const result = await store.truncateAfter(id, 0);
      assert.equal(result, 0);
      assert.deepEqual(await store.load(id), []);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('keepCount >= length is a no-op (returns the unchanged length)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-noop-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 3);
      assert.equal(await store.truncateAfter(id, 3), 3);
      assert.equal(await store.truncateAfter(id, 99), 3);
      assert.equal((await store.load(id)).length, 3);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('clamps a negative keepCount to 0', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-neg-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 3);
      assert.equal(await store.truncateAfter(id, -5), 0);
      assert.deepEqual(await store.load(id), []);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('is a no-op (0) for an unknown id — never throws', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-unknown-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      assert.equal(await store.truncateAfter('no-such-conversation', 1), 0);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('rejects a path-traversal id without touching the filesystem (fail-soft 0)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-traversal-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      assert.equal(await store.truncateAfter('../../etc/passwd', 0), 0);
      assert.equal(await store.truncateAfter('a/b', 0), 0);
      assert.equal(await store.truncateAfter('', 0), 0);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('atomically rewrites the JSONL so a re-load round-trips byte-faithfully', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-atomic-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 6);
      await store.truncateAfter(id, 2);
      // No tmp file should be left behind by the atomic rewrite.
      const convDir = join(home2, '.myshell-tools', 'conversations');
      const files = await import('node:fs/promises').then((m) => m.readdir(convDir));
      assert.ok(!files.some((f) => f.includes('.tmp.')), 'no orphaned tmp file');
      // The file ends with exactly one trailing newline and parses cleanly.
      const raw = await readFile(join(convDir, `${id}.jsonl`), 'utf8');
      assert.ok(raw.endsWith('\n'));
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      assert.equal(lines.length, 2);
      const reloaded = await store.load(id);
      assert.equal(reloaded.length, 2);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('a subsequent append after truncate continues the (now shorter) log', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-trunc-append-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const { store, id } = await seed(home2, clock, 4);
      await store.truncateAfter(id, 2);
      const w = store.writer(id);
      await w.append(makeEntry({ role: 'assistant', content: 'fresh answer' }));
      const entries = await store.load(id);
      assert.equal(entries.length, 3);
      assert.equal(entries[2]?.content, 'fresh answer');
      const found = (await store.list()).find((m) => m.id === id);
      assert.equal(found?.messageCount, 3);
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

  it('recovers a corrupt index from message files and create does not drop them', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-corrupt-${randomUUID()}-`));
    try {
      const convDir = join(home2, '.myshell-tools', 'conversations');
      await mkdir(convDir, { recursive: true });
      await writeFile(join(convDir, 'index.json'), '{ broken', 'utf8');
      await writeFile(
        join(convDir, 'existing-id.jsonl'),
        [
          JSON.stringify({
            timestamp: '2024-02-01T00:00:00.000Z',
            role: 'system',
            content: 'system seed',
          }),
          JSON.stringify({
            timestamp: '2024-02-01T00:00:01.000Z',
            role: 'user',
            content: 'Recover this conversation from messages',
          }),
          JSON.stringify({
            timestamp: '2024-02-01T00:00:02.000Z',
            role: 'assistant',
            content: 'Recovered.',
          }),
          '',
        ].join('\n'),
        'utf8',
      );

      const warnings: string[] = [];
      const clock = makeFakeClock();
      const store = createFileConversationStore({
        homeDir: home2,
        clock,
        onWarning: (message) => warnings.push(message),
      });
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, 'existing-id');
      assert.equal(list[0]?.title, 'Recover this conversation from messages');
      assert.equal(list[0]?.createdAt, '2024-02-01T00:00:00.000Z');
      assert.equal(list[0]?.updatedAt, '2024-02-01T00:00:02.000Z');
      assert.equal(list[0]?.messageCount, 3);
      assert.equal(list[0]?.pinned, false);
      assert.equal(list[0]?.category, null);
      assert.equal(await readFile(join(convDir, 'index.json.corrupt'), 'utf8'), '{ broken');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /Recovered conversations index/);

      await store.create('New conversation');
      const afterCreate = await store.list();
      assert.equal(afterCreate.length, 2);
      assert.ok(afterCreate.some((m) => m.id === 'existing-id'));
      assert.ok(afterCreate.some((m) => m.title === 'New conversation'));
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('recovers a non-array index object instead of treating it as empty', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-object-index-${randomUUID()}-`));
    try {
      const convDir = join(home2, '.myshell-tools', 'conversations');
      await mkdir(convDir, { recursive: true });
      await writeFile(join(convDir, 'index.json'), '{"not":"an array"}', 'utf8');
      await writeFile(
        join(convDir, 'object-id.jsonl'),
        `${JSON.stringify({
          timestamp: '2024-03-01T00:00:00.000Z',
          role: 'user',
          content: 'Object index recovery',
        })}\n`,
        'utf8',
      );

      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, 'object-id');
      assert.equal(list[0]?.title, 'Object index recovery');
      assert.equal(await readFile(join(convDir, 'index.json.corrupt'), 'utf8'), '{"not":"an array"}');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('missing index remains an empty store and normal create works', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-enoent-create-${randomUUID()}-`));
    try {
      const clock = makeFakeClock('2024-06-01T10:00:00.000Z');
      const store = createFileConversationStore({ homeDir: home2, clock });
      assert.deepEqual(await store.list(), []);

      await store.create('First conversation');
      const list = await store.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.title, 'First conversation');
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

  it('load skips valid JSON lines with the wrong shape', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-wrong-shape-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Wrong shape test');
      const w = store.writer(meta.id);
      await w.append(makeEntry({ content: 'valid before' }));

      const convDir = join(home2, '.myshell-tools', 'conversations');
      await appendFile(
        join(convDir, `${meta.id}.jsonl`),
        ['null', '{}', '{"timestamp":123,"role":"user","content":"bad"}', '123', ''].join('\n'),
        'utf8',
      );

      await w.append(makeEntry({ content: 'valid after' }));

      const entries = await store.load(meta.id);
      assert.equal(entries.length, 2);
      assert.equal(entries[0]?.content, 'valid before');
      assert.equal(entries[1]?.content, 'valid after');
      assert.doesNotThrow(() => {
        for (const entry of entries) entry.content.slice(0, 5);
      });
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});
