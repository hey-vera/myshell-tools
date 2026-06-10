/**
 * test/unit/goal-replan-generator.test.ts — the live AUTOMATIC RE-PLAN pass
 * (src/core/goal-replan-generator.ts). Two halves:
 *   1. makeReplanner over a FAKE Provider — verifies the plumbing (manager-tier
 *      read-only request shape, parse into edits, every failure → null so the cycle
 *      leaves the roadmap unchanged). Twin of goal-plan-generator.test.ts.
 *   2. applyReplanEditsViaStore over a REAL file-backed GoalStore — verifies the
 *      edits land via the store CRUD (the AUTOMATIC consumer of update/reorder/
 *      remove), the cap is respected, null/empty ⇒ no change, and the HONESTY
 *      invariant (a verified-done item is never edited/pruned/moved).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  makeReplanner,
  applyReplanEditsViaStore,
} from '../../src/core/goal-replan-generator.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';
import { createFileGoalStore, type GoalStore } from '../../src/infra/goal-store.ts';
import type { Clock } from '../../src/core/types.ts';
import type { Goal } from '../../src/core/goal-todo.ts';
import type { RoadmapEdit } from '../../src/core/goal-replan.ts';

const SIGNAL = new AbortController().signal;

function goal(roadmap: Goal['roadmap']): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Harden the auth path',
    state: 'running',
    source: 'user-explicit',
    roadmap,
    scope: 'project',
    projectKey: 'repo#1',
    conversationId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastTouched: '2026-06-01T00:00:00.000Z',
  };
}

function fakeProvider(events: ProviderEvent[], sink?: { req?: ProviderRequest }): Provider {
  return {
    id: 'claude',
    async detect() {
      return {
        id: 'claude',
        installed: true,
        version: '1.0.0',
        authenticated: true,
        plan: null,
        binaryPath: null,
        availableModels: [],
      };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (sink) sink.req = req;
      for (const ev of events) yield ev;
    },
  };
}

const baseDeps = (provider: Provider) => ({
  providers: { claude: provider },
  policy: DEFAULT_POLICY,
  cwd: '/tmp/project',
  timeoutMs: 8_000,
});

// ---------------------------------------------------------------------------
// makeReplanner — the plumbing + every failure → null
// ---------------------------------------------------------------------------

describe('makeReplanner', () => {
  it('null when no providers are available', async () => {
    const gen = makeReplanner({ providers: {}, policy: DEFAULT_POLICY, cwd: '/x', timeoutMs: 1000 });
    assert.equal(await gen(goal([{ id: 'r1', text: 'a', status: 'pending' }]), SIGNAL), null);
  });

  it('null for a titleless goal (no model touch)', async () => {
    const sink: { req?: ProviderRequest } = {};
    const gen = makeReplanner(baseDeps(fakeProvider([{ type: 'done', text: 'ADD: x', raw: {} }], sink)));
    assert.equal(await gen({ ...goal([]), title: '  ' }, SIGNAL), null);
    assert.equal(sink.req, undefined, 'never touched the provider');
  });

  it('read-only request + parses a well-formed reply into edits', async () => {
    const sink: { req?: ProviderRequest } = {};
    const gen = makeReplanner(
      baseDeps(
        fakeProvider([{ type: 'done', text: 'ADD: write a retry test\nPRUNE r1: obsolete', raw: {} }], sink),
      ),
    );
    const edits = await gen(goal([{ id: 'r1', text: 'a', status: 'pending' }]), SIGNAL);
    assert.equal(sink.req?.sandbox, 'read-only');
    assert.deepEqual(edits, [
      { kind: 'add', text: 'write a retry test' },
      { kind: 'prune', id: 'r1' },
    ] satisfies RoadmapEdit[]);
  });

  it('null on a provider error event', async () => {
    const gen = makeReplanner(
      baseDeps(
        fakeProvider([
          { type: 'error', error: { category: 'auth', recoverable: false, message: 'boom', suggestion: 'login' } },
        ]),
      ),
    );
    assert.equal(await gen(goal([{ id: 'r1', text: 'a', status: 'pending' }]), SIGNAL), null);
  });

  it('null when the provider throws (fail-soft, never throws)', async () => {
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, plan: null, binaryPath: null, availableModels: [] };
      },
      // eslint-disable-next-line require-yield
      async *run(): AsyncIterable<ProviderEvent> {
        throw new Error('explode');
      },
    };
    const gen = makeReplanner(baseDeps(provider));
    assert.equal(await gen(goal([{ id: 'r1', text: 'a', status: 'pending' }]), SIGNAL), null);
  });

  it('null on empty/unusable output', async () => {
    const gen = makeReplanner(baseDeps(fakeProvider([{ type: 'done', text: 'no tags here', raw: {} }])));
    assert.equal(await gen(goal([{ id: 'r1', text: 'a', status: 'pending' }]), SIGNAL), null);
  });
});

// ---------------------------------------------------------------------------
// applyReplanEditsViaStore — the AUTOMATIC store CRUD consumer
// ---------------------------------------------------------------------------

function makeClock(iso = '2026-06-10T00:00:00.000Z'): Clock {
  let n = 0;
  return { now: () => Date.parse(iso), isoNow: () => iso, uuid: () => `u${String(++n)}`, random: () => 0.5 };
}

describe('applyReplanEditsViaStore', () => {
  let homeDir: string;
  let store: GoalStore;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `replan-${randomUUID()}-`));
    store = createFileGoalStore({ homeDir, clock: makeClock() });
  });
  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('null / empty edits ⇒ no change', async () => {
    const g = await store.create({ title: 'g', roadmap: [{ id: 'r1', text: 'a', status: 'pending' }] });
    assert.equal(await applyReplanEditsViaStore(store, g.id, null), null);
    assert.equal(await applyReplanEditsViaStore(store, g.id, []), null);
    const reread = await store.get(g.id);
    assert.deepEqual(reread?.roadmap.map((i) => i.id), ['r1']);
  });

  it('applies add / edit / prune / reorder via the store CRUD', async () => {
    const g = await store.create({
      title: 'g',
      roadmap: [
        { id: 'r1', text: 'one', status: 'pending' },
        { id: 'r2', text: 'two', status: 'pending' },
      ],
    });
    const result = await applyReplanEditsViaStore(store, g.id, [
      { kind: 'add', text: 'three' },
      { kind: 'edit', id: 'r1', text: 'ONE!' },
      { kind: 'prune', id: 'r2' },
      { kind: 'reorder', order: ['r3', 'r1'] }, // r3 is the freshly-added id
    ]);
    assert.deepEqual(result, { added: 1, edited: 1, reordered: 1, pruned: 1, structured: 0 });
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.find((i) => i.id === 'r1')?.text, 'ONE!');
    assert.ok(!reread?.roadmap.some((i) => i.id === 'r2'), 'r2 pruned');
    assert.deepEqual(reread?.roadmap.map((i) => i.id), ['r3', 'r1']);
  });

  it('HONESTY: never edits / prunes / moves a verified-done item', async () => {
    const g = await store.create({
      title: 'g',
      roadmap: [
        {
          id: 'r1',
          text: 'verified',
          status: 'done',
          verdict: { state: 'passing', receipt: 'green', at: '2026-06-10T00:00:00.000Z' },
        },
        { id: 'r2', text: 'pending', status: 'pending' },
      ],
    });
    const result = await applyReplanEditsViaStore(store, g.id, [
      { kind: 'edit', id: 'r1', text: 'HACKED' }, // verified → skipped
      { kind: 'prune', id: 'r1' }, // verified → skipped (store also retains)
      { kind: 'reorder', order: ['r2', 'r1'] }, // r1 filtered out → r1 stays anchored
    ]);
    assert.equal(result?.edited, 0);
    assert.equal(result?.pruned, 0);
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.find((i) => i.id === 'r1')?.text, 'verified', 'never edited');
    assert.equal(reread?.roadmap.find((i) => i.id === 'r1')?.verdict?.state, 'passing', 'verdict intact');
    assert.ok(reread?.roadmap.some((i) => i.id === 'r1'), 'verified item retained');
  });

  it('respects the roadmap cap (an ADD past 8 is a no-op)', async () => {
    const full = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i + 1}`,
      text: `t${i}`,
      status: 'pending' as const,
    }));
    const g = await store.create({ title: 'g', roadmap: full });
    const result = await applyReplanEditsViaStore(store, g.id, [{ kind: 'add', text: 'overflow' }]);
    assert.equal(result?.added, 0);
    const reread = await store.get(g.id);
    assert.equal(reread?.roadmap.length, 8);
  });

  it('unknown goal id ⇒ null (fail-soft)', async () => {
    assert.equal(await applyReplanEditsViaStore(store, 'goal_nope', [{ kind: 'add', text: 'x' }]), null);
  });
});
