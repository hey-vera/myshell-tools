/**
 * Unit tests for src/core/memory-injection.ts (Phase 4 retrieval/injection seam).
 * Run with: node --import ./test/register.mjs --test "test/unit/memory-injection.test.ts"
 *
 * Hermetic: a tiny in-memory fake `MemoryReadStore` (no disk, no clock). Covers
 * the inject-time gate (constraints/identity always ride; prefs gated behind a
 * real work request), the kill-switch, empty-store, markUsed-on-relevance-only,
 * the decay sweep on open, and full fail-soft (a throwing store → '').
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyInjectGate,
  isMemoryEnabled,
  resolveMemoryContext,
  resolveMemoryContextDetailed,
  type MemoryReadStore,
} from '../../src/core/memory-injection.ts';
import type { UserMemoryFact, MemoryKind } from '../../src/core/user-memory.ts';

const NOW = '2026-06-05T00:00:00.000Z';

function fact(overrides: Partial<UserMemoryFact> & { kind: MemoryKind; text: string }): UserMemoryFact {
  return {
    version: 1,
    id: overrides.id ?? `id-${overrides.kind}-${Math.random().toString(36).slice(2, 8)}`,
    scope: overrides.scope ?? 'global',
    projectKey: overrides.projectKey ?? null,
    shape: overrides.shape ?? 'profile',
    kind: overrides.kind,
    subject: overrides.subject ?? 'other',
    text: overrides.text,
    value: overrides.value ?? null,
    reason: overrides.reason ?? '',
    trust: overrides.trust ?? 'user_stated',
    source: overrides.source ?? 'user_explicit',
    provenance: overrides.provenance ?? { conversationId: null, capturedFromTurn: null, command: '/remember' },
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    validFrom: overrides.validFrom ?? NOW,
    validTo: overrides.validTo ?? null,
    supersededBy: overrides.supersededBy ?? null,
    lastUsedAt: overrides.lastUsedAt ?? null,
    useCount: overrides.useCount ?? 0,
    importance: overrides.importance ?? 2,
    tags: overrides.tags ?? [],
    archived: overrides.archived ?? false,
  };
}

interface FakeStore extends MemoryReadStore {
  readonly markedUsed: string[][];
  sweepCount: number;
}

function fakeStore(facts: readonly UserMemoryFact[]): FakeStore {
  const markedUsed: string[][] = [];
  let sweepCount = 0;
  return {
    markedUsed,
    get sweepCount() {
      return sweepCount;
    },
    async listAll() {
      return [...facts];
    },
    async markUsed(ids) {
      markedUsed.push([...ids]);
    },
    async sweepDecay() {
      sweepCount += 1;
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// applyInjectGate — the pure inject-time gate (§7)
// ---------------------------------------------------------------------------

describe('applyInjectGate', () => {
  const facts = [
    fact({ kind: 'identity', text: 'Senior backend engineer.' }),
    fact({ kind: 'constraint', text: 'Uses Node 22; avoids paid APIs.' }),
    fact({ kind: 'preference', text: 'Prefers concise answers.' }),
    fact({ kind: 'correction', text: 'Stop adding emoji.' }),
    fact({ kind: 'project', scope: 'project', text: 'heyvera.org should feel 2010-era.' }),
  ];

  it('passes EVERYTHING through on a substantial work request', () => {
    const out = applyInjectGate(facts, true);
    assert.equal(out.length, facts.length);
  });

  it('keeps ONLY identity + constraint on a trivial (non-work) turn', () => {
    const out = applyInjectGate(facts, false);
    const kinds = out.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['constraint', 'identity']);
  });

  it('never drops a load-bearing constraint even on a trivial turn', () => {
    const out = applyInjectGate(facts, false);
    assert.ok(out.some((f) => f.text.includes('Node 22')));
  });
});

// ---------------------------------------------------------------------------
// isMemoryEnabled — kill-switch semantics (absent/true → on)
// ---------------------------------------------------------------------------

describe('isMemoryEnabled', () => {
  it('is on when memory is absent (default)', () => {
    assert.equal(isMemoryEnabled({}), true);
  });
  it('is on when memory is explicitly true', () => {
    assert.equal(isMemoryEnabled({ memory: true }), true);
  });
  it('is off (kill-switch) when memory is explicitly false', () => {
    assert.equal(isMemoryEnabled({ memory: false }), false);
  });
});

// ---------------------------------------------------------------------------
// resolveMemoryContext — the impure orchestration, fail-soft
// ---------------------------------------------------------------------------

describe('resolveMemoryContext', () => {
  it('injects a rendered MEMORY block on a substantial turn when facts exist', async () => {
    const store = fakeStore([
      fact({ kind: 'preference', text: 'Prefers concise answers about refactoring code.' }),
    ]);
    const block = await resolveMemoryContext({
      store,
      task: 'Please refactor the authentication module and add tests for the code.',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.ok(block.includes('USER MEMORY'));
    assert.ok(block.includes('Prefers concise answers'));
  });

  it('injects NOTHING when memory:false (the kill-switch)', async () => {
    const store = fakeStore([fact({ kind: 'constraint', text: 'Uses Node 22.' })]);
    const block = await resolveMemoryContext({
      store,
      task: 'refactor the auth module thoroughly',
      projectKey: null,
      nowIso: NOW,
      config: { memory: false },
    });
    assert.equal(block, '');
    // Kill-switch must not even open the store.
    assert.equal(store.sweepCount, 0);
  });

  it('injects NOTHING when the store has no facts', async () => {
    const store = fakeStore([]);
    const block = await resolveMemoryContext({
      store,
      task: 'refactor the auth module thoroughly',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.equal(block, '');
  });

  it('injects NOTHING when store is undefined', async () => {
    const block = await resolveMemoryContext({
      store: undefined,
      task: 'refactor the auth module',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.equal(block, '');
  });

  it('inject-time gate: a trivial turn gets identity/constraints but NOT preferences', async () => {
    const store = fakeStore([
      fact({ kind: 'constraint', text: 'Uses Node 22; avoids paid APIs.' }),
      fact({ kind: 'identity', text: 'Senior backend engineer.' }),
      fact({ kind: 'preference', text: 'Prefers concise answers.' }),
    ]);
    const block = await resolveMemoryContext({
      store,
      task: "what's 2+2",
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.ok(block.includes('Node 22'), 'constraint always rides');
    assert.ok(block.includes('Senior backend engineer'), 'identity always rides');
    assert.ok(!block.includes('Prefers concise answers'), 'preference is gated out on a trivial turn');
  });

  it('inject-time gate: a substantial turn DOES get preferences', async () => {
    const store = fakeStore([
      fact({ kind: 'preference', text: 'Prefers concise answers.' }),
    ]);
    const block = await resolveMemoryContext({
      store,
      task: 'Refactor and redesign the entire authentication architecture across the codebase.',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.ok(block.includes('Prefers concise answers'));
  });

  it('calls markUsed for relevance-selected ids only (RC-5)', async () => {
    const store = fakeStore([
      fact({ id: 'rel-1', kind: 'preference', text: 'Prefers tests written before refactoring authentication code.' }),
    ]);
    const block = await resolveMemoryContext({
      store,
      task: 'refactor the authentication code and write tests for it before the refactor',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.ok(block.includes('Prefers tests'));
    // The relevant fact's id was marked used.
    const allMarked = store.markedUsed.flat();
    assert.ok(allMarked.includes('rel-1'), 'relevance-selected id is marked used');
  });

  it('does NOT mark always-ride-only facts used on a trivial turn (decay decoupled from injection)', async () => {
    const store = fakeStore([
      fact({ id: 'c1', kind: 'constraint', text: 'Uses Node 22.' }),
    ]);
    const block = await resolveMemoryContext({
      store,
      task: 'hi',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    // The constraint rides (always-include) but is not relevance-selected, so no
    // markUsed should fire for it (or markUsed got an empty set).
    assert.ok(block.includes('Node 22'));
    const allMarked = store.markedUsed.flat();
    assert.ok(!allMarked.includes('c1'), 'always-include-only fact is not decay-reset');
  });

  it('runs the decay sweep on open by default', async () => {
    const store = fakeStore([fact({ kind: 'preference', text: 'Prefers concise answers.' })]);
    await resolveMemoryContext({
      store,
      task: 'refactor the codebase architecture thoroughly',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.equal(store.sweepCount, 1);
  });

  it('skips the decay sweep when sweep:false', async () => {
    const store = fakeStore([fact({ kind: 'preference', text: 'Prefers concise answers.' })]);
    await resolveMemoryContext({
      store,
      task: 'refactor the codebase architecture thoroughly',
      projectKey: null,
      nowIso: NOW,
      config: {},
      sweep: false,
    });
    assert.equal(store.sweepCount, 0);
  });

  it('is fail-soft: a throwing store degrades to no memory (returns "")', async () => {
    const throwingStore: MemoryReadStore = {
      async listAll() {
        throw new Error('disk gone');
      },
      async markUsed() {
        throw new Error('disk gone');
      },
      async sweepDecay() {
        throw new Error('disk gone');
      },
    };
    const block = await resolveMemoryContext({
      store: throwingStore,
      task: 'refactor the auth module thoroughly',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.equal(block, '', 'a throwing store must never throw into the turn');
  });

  it('is fail-soft: a throwing markUsed still returns the rendered block', async () => {
    const store: MemoryReadStore = {
      async listAll() {
        return [fact({ kind: 'preference', text: 'Prefers tests before refactoring code.' })];
      },
      async markUsed() {
        throw new Error('markUsed failed');
      },
      async sweepDecay() {
        return [];
      },
    };
    const block = await resolveMemoryContext({
      store,
      task: 'refactor the code and add tests before refactoring',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.ok(block.includes('Prefers tests'), 'a failed markUsed must not drop the injected block');
  });
});

// ---------------------------------------------------------------------------
// resolveMemoryContextDetailed — exposes the injected facts (/memory loaded)
// ---------------------------------------------------------------------------

describe('resolveMemoryContextDetailed', () => {
  it('returns BOTH the block and the facts injected this turn', async () => {
    const f = fact({ kind: 'constraint', text: 'Uses Node 22.', subject: 'runtime' });
    const store = fakeStore([f]);
    const { block, facts } = await resolveMemoryContextDetailed({
      store,
      task: 'build the auth module',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.ok(block.includes('Uses Node 22'), 'block carries the injected fact');
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.id, f.id, 'the injected fact id is exposed for /memory loaded');
  });

  it('empty store → { block: "", facts: [] }', async () => {
    const { block, facts } = await resolveMemoryContextDetailed({
      store: fakeStore([]),
      task: 'do work',
      projectKey: null,
      nowIso: NOW,
      config: {},
    });
    assert.equal(block, '');
    assert.deepEqual(facts, []);
  });

  it('kill-switch → no facts exposed', async () => {
    const { block, facts } = await resolveMemoryContextDetailed({
      store: fakeStore([fact({ kind: 'constraint', text: 'Uses Node 22.' })]),
      task: 'do work',
      projectKey: null,
      nowIso: NOW,
      config: { memory: false },
    });
    assert.equal(block, '');
    assert.deepEqual(facts, []);
  });
});
