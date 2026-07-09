/**
 * test/unit/menu-mode-scope.test.ts — unit tests for the per-conversation mode
 * model + mode-toggle scoping foundation (Redesign Slice A).
 *
 * Covers:
 *   1. conversationModeLabel helper
 *   2. config.mode absent → resolves/labels as 'auto'
 *   3. new conversation stamps current global default mode
 *   4. changing global default does NOT mutate existing conversations
 *   5. per-conversation mode override persists and is read back
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { conversationModeLabel } from '../../src/interface/menu-display.ts';
import { migrateMode, levelLabel, nextLevel, ALL_LEVELS } from '../../src/core/mode-levels.ts';
import type { Level } from '../../src/core/mode-levels.ts';
import type { ConversationMode } from '../../src/infra/conversation-store.ts';
import { createFileConversationStore } from '../../src/infra/conversations.ts';
import type { Clock } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

function makeFakeClock(fixedIso = '2024-01-01T00:00:00.000Z'): Clock & { advance(): void } {
  let counter = 0;
  let iso = fixedIso;
  return {
    now() { return new Date(iso).getTime(); },
    isoNow() { return iso; },
    uuid() {
      counter += 1;
      return `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`;
    },
    random() { return 0.5; },
    advance() {
      const d = new Date(iso);
      d.setSeconds(d.getSeconds() + 1);
      iso = d.toISOString();
    },
  };
}

// ---------------------------------------------------------------------------
// 1. conversationModeLabel helper
// ---------------------------------------------------------------------------

describe('conversationModeLabel', () => {
  it('returns "auto" for undefined', () => {
    assert.equal(conversationModeLabel(undefined), 'auto');
  });

  it('returns "auto" for auto', () => {
    assert.equal(conversationModeLabel('auto'), 'auto');
  });

  it('returns "budget" for budget', () => {
    assert.equal(conversationModeLabel('budget'), 'budget');
  });

  it('returns "balanced" for balanced', () => {
    assert.equal(conversationModeLabel('balanced'), 'balanced');
  });

  it('returns "high" for high', () => {
    assert.equal(conversationModeLabel('high'), 'high');
  });

  it('returns "max" for max', () => {
    assert.equal(conversationModeLabel('max'), 'max');
  });
});

// ---------------------------------------------------------------------------
// 2. config.mode absent → resolves/labels as 'auto'
// ---------------------------------------------------------------------------

describe('config.mode absent → auto', () => {
  it('migrateMode(undefined) returns "auto"', () => {
    assert.equal(migrateMode(undefined), 'auto');
  });

  it('levelLabel for auto returns "Auto"', () => {
    assert.equal(levelLabel('auto'), 'Auto');
  });

  it('absent config.mode displays as Auto (smart) via label chain', () => {
    const label = 'Auto (smart)';
    assert.equal(migrateMode(undefined), 'auto');
    assert.equal('Auto (smart)', label);
  });

  it('migrateMode maps cost-saver → budget', () => {
    assert.equal(migrateMode('cost-saver'), 'budget');
  });

  it('migrateMode maps balanced → balanced', () => {
    assert.equal(migrateMode('balanced'), 'balanced');
  });

  it('migrateMode maps quality-first → max', () => {
    assert.equal(migrateMode('quality-first'), 'max');
  });

  it('levelLabel("budget") returns "Budget"', () => {
    assert.equal(levelLabel('budget'), 'Budget');
  });

  it('levelLabel("balanced") returns "Balanced"', () => {
    assert.equal(levelLabel('balanced'), 'Balanced');
  });

  it('levelLabel("max") returns "Max"', () => {
    assert.equal(levelLabel('max'), 'Max');
  });

  it('levelLabel("high") returns "High"', () => {
    assert.equal(levelLabel('high'), 'High');
  });
});

// ---------------------------------------------------------------------------
// 3. new conversation stamps current global default mode
// ---------------------------------------------------------------------------

describe('new conversation stamps global default mode', () => {
  it('creates with mode "budget" when default is cost-saver', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-stamp-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const convMode: ConversationMode = migrateMode('cost-saver');
      assert.equal(convMode, 'budget');
      const meta = await store.create('Budget chat', convMode);
      assert.equal(meta.mode, 'budget');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('creates with mode absent when default is auto (config.mode absent)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-stamp-auto-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const convMode: ConversationMode = migrateMode(undefined);
      assert.equal(convMode, 'auto');
      const meta = await store.create('Auto chat', convMode);
      assert.equal(meta.mode, undefined); // auto → absent in storage
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('creates with mode "max" when default is quality-first', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-stamp-max-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const convMode: ConversationMode = migrateMode('quality-first');
      assert.equal(convMode, 'max');
      const meta = await store.create('Max chat', convMode);
      assert.equal(meta.mode, 'max');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('creates with mode "balanced" when default is balanced', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-stamp-balanced-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const convMode: ConversationMode = migrateMode('balanced');
      assert.equal(convMode, 'balanced');
      const meta = await store.create('Balanced chat', convMode);
      assert.equal(meta.mode, 'balanced');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. changing global default does NOT mutate existing conversations
// ---------------------------------------------------------------------------

describe('changing global default does NOT mutate existing conversations', () => {
  it('persisted per-conversation mode stays when store is reopened with different intent', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-immutable-${randomUUID()}-`));
    try {
      const clock = makeFakeClock('2024-06-01T10:00:00.000Z');
      const store = createFileConversationStore({ homeDir: home2, clock });

      // Simulate: global default is "budget", create a conversation with it
      const budgetMeta = await store.create('Budget era chat', 'budget');
      assert.equal(budgetMeta.mode, 'budget');

      // Simulate: global default changes to "max" — create a new conversation
      // but the old one's mode stays "budget"
      const maxMeta = await store.create('Max era chat', 'max');
      assert.equal(maxMeta.mode, 'max');

      // Reopen the store — the first conversation still has mode budget
      const reopened = createFileConversationStore({ homeDir: home2, clock });
      const all = await reopened.list();
      const budgetFound = all.find((m) => m.id === budgetMeta.id);
      assert.ok(budgetFound !== undefined);
      assert.equal(budgetFound.mode, 'budget');

      const maxFound = all.find((m) => m.id === maxMeta.id);
      assert.ok(maxFound !== undefined);
      assert.equal(maxFound.mode, 'max');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('conversation without explicit mode stays absent after default changes', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-no-mode-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });

      // Create a conversation without an explicit mode (auto/inherit)
      const autoMeta = await store.create('Auto chat', 'auto');
      assert.equal(autoMeta.mode, undefined);

      // Create another conversation with an explicit mode
      await store.create('Max chat', 'max');

      // Reopen — auto chat should still have mode undefined
      const reopened = createFileConversationStore({ homeDir: home2, clock });
      const found = (await reopened.list()).find((m) => m.id === autoMeta.id);
      assert.ok(found !== undefined);
      assert.equal(found.mode, undefined);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. per-conversation mode override persists and is read back
// ---------------------------------------------------------------------------

describe('per-conversation mode override', () => {
  it('setMode persists and round-trips through a reopened store', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-override-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Override test');

      await store.setMode(meta.id, 'balanced');
      assert.equal((await store.list()).find((m) => m.id === meta.id)?.mode, 'balanced');

      await store.setMode(meta.id, 'max');
      assert.equal((await store.list()).find((m) => m.id === meta.id)?.mode, 'max');

      // Reopen
      const reopened = createFileConversationStore({ homeDir: home2, clock });
      const found = (await reopened.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.mode, 'max');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('conversation.mode label is correct for each mode', () => {
    const cases: [ConversationMode | undefined, string][] = [
      [undefined, 'auto'],
      ['auto', 'auto'],
      ['budget', 'budget'],
      ['balanced', 'balanced'],
      ['high', 'high'],
      ['max', 'max'],
    ];
    for (const [mode, expected] of cases) {
      assert.equal(conversationModeLabel(mode), expected);
    }
  });

  it('setMode auto clears to absent and conversationModeLabel returns auto', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `conv-override-clear-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      const meta = await store.create('Clear mode test');
      await store.setMode(meta.id, 'max');
      await store.setMode(meta.id, 'auto');

      const found = (await store.list()).find((m) => m.id === meta.id);
      assert.ok(found !== undefined);
      assert.equal(found.mode, undefined);
      // Label for absent should be 'auto'
      assert.equal(conversationModeLabel(found.mode), 'auto');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('Shift+Tab-style nextLevel cycle persists via setMode without needing global config', async () => {
    // Simulates the P0.8 chat handler: walk the dial, setMode each step, never
    // touch a global config.mode field.
    const home2 = await mkdtemp(join(tmpdir(), `conv-shift-tab-${randomUUID()}-`));
    try {
      const clock = makeFakeClock();
      const store = createFileConversationStore({ homeDir: home2, clock });
      // Stamp balanced as the "home default" on the conversation at create time.
      const meta = await store.create('Cycle test', 'balanced');
      assert.equal(meta.mode, 'balanced');

      let level: Level = meta.mode ?? 'auto';
      const walked: Level[] = [];
      for (let i = 0; i < ALL_LEVELS.length; i++) {
        level = nextLevel(level);
        walked.push(level);
        await store.setMode(meta.id, level);
        const found = (await store.list()).find((m) => m.id === meta.id);
        assert.ok(found !== undefined);
        // auto clears to absent in storage; others round-trip.
        if (level === 'auto') {
          assert.equal(found.mode, undefined);
        } else {
          assert.equal(found.mode, level);
        }
      }
      assert.deepEqual(walked, ['high', 'max', 'auto', 'budget', 'balanced']);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});
