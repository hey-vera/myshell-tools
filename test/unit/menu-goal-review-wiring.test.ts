/**
 * test/unit/menu-goal-review-wiring.test.ts — unit tests for the goal-review
 * wiring helper in src/interface/menu-goal-review-wiring.ts.
 *
 * Tests the flag gate, the audit+prompt flow, and each action handler's
 * correct store method call, without touching a real filesystem or TTY.
 *
 * Run with: node --import ./test/register.mjs --test "test/unit/menu-goal-review-wiring.test.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { reviewConversationGoals } from '../../src/interface/menu-goal-review-wiring.js';
import type { GoalStore } from '../../src/infra/goal-store.js';
import type { OutputSink } from '../../src/interface/render.js';
import type { Goal, GoalState } from '../../src/core/goal-todo.js';
import type { GoalVerdict } from '../../src/core/goal-todo.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = new Date('2026-07-15T00:00:00.000Z').getTime();
const NOW_ISO = '2026-07-15T00:00:00.000Z';

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Test goal',
    state: 'parked',
    source: 'user-explicit',
    roadmap: [],
    scope: 'project',
    projectKey: null,
    conversationId: 'conv_1',
    createdAt: '2026-06-01T00:00:00.000Z',
    lastTouched: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeVerdict(state: GoalVerdict['state']): GoalVerdict {
  return { state, receipt: 'test receipt', at: '2026-06-15T00:00:00.000Z' };
}

function makeSink(): { sink: OutputSink; text: () => string } {
  let buf = '';
  const sink = {
    write(s: string) { buf += s; },
    color: false,
  } as unknown as OutputSink;
  return { sink, text: () => buf };
}

/** Captures store method calls for assertion. */
interface StoreCall {
  method: string;
  args: unknown[];
}

function makeFakeStore(opts: {
  goals: Goal[];
  setStateResult?: Goal | null;
  patchGoalResult?: Goal | null;
  markVerifiedCompleteResult?: Goal | null;
}): { store: GoalStore; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  return {
    store: {
      list: async () => opts.goals,
      get: async (id: string) => opts.goals.find((g) => g.id === id) ?? null,
      create: async () => { throw new Error('not used in tests'); },
      setState: async (id: string, state: GoalState) => { record('setState', [id, state]); return opts.setStateResult ?? null; },
      patchGoal: async (id: string, patch: unknown) => { record('patchGoal', [id, patch]); return opts.patchGoalResult ?? null; },
      setGoalVerdict: async () => null,
      setRoadmapItemVerdict: async () => null,
      setRoadmapItemStatus: async () => null,
      addRoadmapItem: async () => ({ ok: false, reason: 'unknown-goal' } as const),
      updateRoadmapItem: async () => null,
      reorderRoadmap: async () => null,
      removeRoadmapItem: async () => ({ ok: false, reason: 'unknown' } as const),
      remove: async () => false,
      cancelGoalTree: async () => ({ terminated: [] }),
      markSuperseded: async () => [],
      listByConversation: async (convId: string) =>
        opts.goals.filter((g) => g.conversationId === convId),
      markVerifiedComplete: async (goalId: string) => {
        record('markVerifiedComplete', [goalId]);
        return opts.markVerifiedCompleteResult ?? null;
      },
    },
    calls,
  };
}

function makeDeps(overrides: {
  store?: GoalStore;
  readLine?: () => Promise<string | null>;
  readKey?: (() => Promise<string | null>) | null;
  env?: NodeJS.ProcessEnv;
  config?: { experimentalGoalSteward?: boolean };
  clockNow?: number;
  out?: OutputSink;
} = {}): { deps: Parameters<typeof reviewConversationGoals>[0];
  storeCalls: StoreCall[];
  sink: ReturnType<typeof makeSink>['sink'];
  text: () => string; } {
  const { sink, text } = makeSink();
  const goals = overrides.store === undefined
    ? [makeGoal()]
    : [] as Goal[];
  const fake = makeFakeStore({ goals });
  const actualStore = overrides.store ?? fake.store;
  const storeCalls = overrides.store !== undefined ? [] : fake.calls;

  const deps = {
    goalStore: actualStore,
    clock: { now: () => overrides.clockNow ?? NOW_MS, isoNow: () => NOW_ISO, uuid: () => 'test-uuid', random: () => 0 },
    out: overrides.out ?? sink,
    readLine: overrides.readLine ?? (async () => ''),
    readMenuKey: overrides.readKey !== null
      ? (async () => (overrides.readKey ? (await overrides.readKey()) : ''))
      : (async () => '' as string | null),
    env: overrides.env ?? { MYSHELL_GOAL_STEWARD: '1' },
    config: overrides.config,
  };

  return { deps, storeCalls, sink, text };
}

// ---------------------------------------------------------------------------
// Flag OFF — no-op
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — flag OFF', () => {
  it('returns true immediately when flag is OFF (env absent)', async () => {
    const { deps } = makeDeps({ env: {} });
    const result = await reviewConversationGoals(deps, 'conv_1');
    assert.equal(result, true);
  });

  it('returns true immediately when flag is OFF (config false)', async () => {
    const { deps } = makeDeps({ env: {}, config: { experimentalGoalSteward: false } });
    const result = await reviewConversationGoals(deps, 'conv_1');
    assert.equal(result, true);
  });

  it('does not write output when flag is OFF', async () => {
    const { deps, text } = makeDeps({ env: {} });
    await reviewConversationGoals(deps, 'conv_1');
    assert.equal(text(), '');
  });
});

// ---------------------------------------------------------------------------
// No goals — no prompt
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — no goals', () => {
  it('returns true when no goals are linked to conversation', async () => {
    const emptyStore = makeFakeStore({ goals: [] }).store;
    const { deps } = makeDeps({ store: emptyStore });
    const result = await reviewConversationGoals(deps, 'conv_1');
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// Fresh goal — no prompt (recommendedAction=none)
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — fresh goal', () => {
  it('returns true without prompting when goal is fresh', async () => {
    const fresh = makeGoal({ lastTouched: '2026-07-14T00:00:00.000Z', conversationId: 'conv_F', id: 'goal_F' });
    const { deps, text } = makeDeps({ store: makeFakeStore({ goals: [fresh] }).store });
    const result = await reviewConversationGoals(deps, 'conv_F');
    assert.equal(result, true);
    assert.equal(text(), '');
  });
});

// ---------------------------------------------------------------------------
// Inactive (running/queued stale) — prompt + actions
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — inactive stale', () => {
  it('prompts and dispatches Resume [r] → setState running', async () => {
    const g = makeGoal({ id: 'goal_R', state: 'running', conversationId: 'conv_R', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps, text } = makeDeps({
      store: fake.store,
      readKey: async () => 'r',
    });
    const result = await reviewConversationGoals(deps, 'conv_R');
    assert.equal(result, true);
    assert.ok(text().includes('[r] Resume'), 'shows resume key');
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'setState', args: ['goal_R', 'running'] });
  });

  it('dispatches Ask [a] — prints note, no store mutation', async () => {
    const g = makeGoal({ id: 'goal_R', state: 'running', conversationId: 'conv_R', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps, text } = makeDeps({
      store: fake.store,
      readKey: async () => 'a',
    });
    const result = await reviewConversationGoals(deps, 'conv_R');
    assert.equal(result, true);
    assert.ok(text().includes('What changed'), 'prints ask note');
    assert.equal(fake.calls.length, 0, 'no store mutations for ask');
  });

  it('dispatches Dismiss [d] → patchGoal touch', async () => {
    const g = makeGoal({ id: 'goal_R', state: 'running', conversationId: 'conv_R', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => 'd',
    });
    const result = await reviewConversationGoals(deps, 'conv_R');
    assert.equal(result, true);
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'patchGoal', args: ['goal_R', {}] });
  });

  it('dispatches Cancel [x] → setState failed', async () => {
    const g = makeGoal({ id: 'goal_R', state: 'running', conversationId: 'conv_R', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => 'x',
    });
    const result = await reviewConversationGoals(deps, 'conv_R');
    assert.equal(result, true);
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'setState', args: ['goal_R', 'failed'] });
  });

  it('returns false on Ctrl-C/EOF during prompt', async () => {
    const g = makeGoal({ id: 'goal_R', state: 'running', conversationId: 'conv_R', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => null, // Ctrl-C → null
    });
    const result = await reviewConversationGoals(deps, 'conv_R');
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// Stale (parked) — prompt + actions
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — stale parked', () => {
  it('dispatches Resume [r] → setState running', async () => {
    const g = makeGoal({ id: 'goal_P', state: 'parked', conversationId: 'conv_P', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => 'r',
    });
    const result = await reviewConversationGoals(deps, 'conv_P');
    assert.equal(result, true);
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'setState', args: ['goal_P', 'running'] });
  });

  it('dispatches Update [u] → prints note, no store mutation', async () => {
    const g = makeGoal({ id: 'goal_P', state: 'parked', conversationId: 'conv_P', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps, text } = makeDeps({
      store: fake.store,
      readKey: async () => 'u',
    });
    await reviewConversationGoals(deps, 'conv_P');
    assert.ok(text().includes('type your update'), 'prints update note');
    assert.equal(fake.calls.length, 0, 'no store mutations for update');
  });

  it('dispatches Cancel [x] → setState failed', async () => {
    const g = makeGoal({ id: 'goal_P', state: 'parked', conversationId: 'conv_P', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => 'x',
    });
    const result = await reviewConversationGoals(deps, 'conv_P');
    assert.equal(result, true);
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'setState', args: ['goal_P', 'failed'] });
  });

  it('dispatches Skip [Enter] → patchGoal touch', async () => {
    const g = makeGoal({ id: 'goal_P', state: 'parked', conversationId: 'conv_P', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => '', // Enter
    });
    await reviewConversationGoals(deps, 'conv_P');
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'patchGoal', args: ['goal_P', {}] });
  });
});

// ---------------------------------------------------------------------------
// Blocked — prompt + actions
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — blocked', () => {
  it('on Enter → bump lastTouched, no other mutation', async () => {
    const g = makeGoal({ id: 'goal_B', state: 'blocked', conversationId: 'conv_B', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps, text } = makeDeps({
      store: fake.store,
      readLine: async () => '', // Enter → empty line
    });
    await reviewConversationGoals(deps, 'conv_B');
    assert.ok(text().includes('blocked'), 'shows blocked prompt');
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'patchGoal', args: ['goal_B', {}] });
  });

  it('on text answer → bump lastTouched + print note', async () => {
    const g = makeGoal({ id: 'goal_B', state: 'blocked', conversationId: 'conv_B', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps, text } = makeDeps({
      store: fake.store,
      readLine: async () => 'Support the legacy OAuth2 token path',
    });
    await reviewConversationGoals(deps, 'conv_B');
    assert.ok(text().includes('Noted'), 'prints noted for text answer');
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'patchGoal', args: ['goal_B', {}] });
  });

  it('returns false on Ctrl-C/EOF during blocked prompt', async () => {
    const g = makeGoal({ id: 'goal_B', state: 'blocked', conversationId: 'conv_B', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readLine: async () => null, // EOF
    });
    const result = await reviewConversationGoals(deps, 'conv_B');
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// Verified-complete — resolve-done action
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — verified-complete (resolve-done)', () => {
  it('[y] → calls markVerifiedComplete', async () => {
    const g = makeGoal({
      id: 'goal_VD',
      state: 'done',
      conversationId: 'conv_VD',
      lastTouched: '2026-06-01T00:00:00.000Z',
      goalVerdict: makeVerdict('passing'),
    });
    const fake = makeFakeStore({ goals: [g], markVerifiedCompleteResult: makeGoal({ id: 'goal_VD', state: 'done' }) });
    const { deps, text } = makeDeps({
      store: fake.store,
      readKey: async () => 'y',
    });
    const result = await reviewConversationGoals(deps, 'conv_VD');
    assert.equal(result, true);
    assert.ok(text().includes('verified complete'), 'shows verified-complete prompt');
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'markVerifiedComplete', args: ['goal_VD'] });
  });

  it('[y] when precondition fails → prints error', async () => {
    const g = makeGoal({
      id: 'goal_VD',
      state: 'done',
      conversationId: 'conv_VD',
      lastTouched: '2026-06-01T00:00:00.000Z',
      goalVerdict: makeVerdict('passing'),
    });
    // markVerifiedComplete returns null (precondition failed)
    const fake = makeFakeStore({ goals: [g], markVerifiedCompleteResult: null });
    const { deps, text } = makeDeps({
      store: fake.store,
      readKey: async () => 'y',
    });
    await reviewConversationGoals(deps, 'conv_VD');
    assert.ok(text().includes('precondition failed'), 'reports precondition failure');
  });

  it('[n] → no-op', async () => {
    const g = makeGoal({
      id: 'goal_VD',
      state: 'done',
      conversationId: 'conv_VD',
      lastTouched: '2026-06-01T00:00:00.000Z',
      goalVerdict: makeVerdict('passing'),
    });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => 'n',
    });
    await reviewConversationGoals(deps, 'conv_VD');
    assert.equal(fake.calls.length, 0, 'no store calls for [n]');
  });
});

// ---------------------------------------------------------------------------
// Verified-complete — review (done-but-unverified)
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — verified-complete (review)', () => {
  it('[d] → patchGoal touch', async () => {
    const g = makeGoal({
      id: 'goal_DU',
      state: 'done',
      conversationId: 'conv_DU',
      lastTouched: '2026-06-01T00:00:00.000Z',
    });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => 'd',
    });
    await reviewConversationGoals(deps, 'conv_DU');
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'patchGoal', args: ['goal_DU', {}] });
  });

  it('[x] → setState failed', async () => {
    const g = makeGoal({
      id: 'goal_DU',
      state: 'done',
      conversationId: 'conv_DU',
      lastTouched: '2026-06-01T00:00:00.000Z',
    });
    const fake = makeFakeStore({ goals: [g] });
    const { deps } = makeDeps({
      store: fake.store,
      readKey: async () => 'x',
    });
    await reviewConversationGoals(deps, 'conv_DU');
    assert.equal(fake.calls.length, 1);
    assert.deepStrictEqual(fake.calls[0], { method: 'setState', args: ['goal_DU', 'failed'] });
  });
});

// ---------------------------------------------------------------------------
// Priority — blocked > inactive > stale
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — priority', () => {
  it('surfaces blocked over inactive', async () => {
    const blocked = makeGoal({ id: 'goal_B', state: 'blocked', conversationId: 'conv_M', lastTouched: '2026-06-01T00:00:00.000Z' });
    const inactive = makeGoal({ id: 'goal_R', state: 'running', conversationId: 'conv_M', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [inactive, blocked] });
    const { deps, text } = makeDeps({
      store: fake.store,
      readLine: async () => '',
    });
    await reviewConversationGoals(deps, 'conv_M');
    assert.ok(text().includes('blocked'), 'surfaces blocked prompt over inactive');
    assert.ok(text().includes('Test goal'), 'shows blocked goal title');
  });
});

// ---------------------------------------------------------------------------
// goalStewardEnabled flag — env + config integration
// ---------------------------------------------------------------------------

describe('reviewConversationGoals — flag integration', () => {
  it('env MYSHELL_GOAL_STEWARD=0 → no prompt', async () => {
    const g = makeGoal({ id: 'goal_B', state: 'blocked', conversationId: 'conv_B', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps, text } = makeDeps({
      store: fake.store,
      env: { MYSHELL_GOAL_STEWARD: '0' },
    });
    await reviewConversationGoals(deps, 'conv_B');
    assert.equal(text(), '');
  });

  it('config.experimentalGoalSteward=true → prompts', async () => {
    const g = makeGoal({ id: 'goal_B', state: 'blocked', conversationId: 'conv_B', lastTouched: '2026-06-01T00:00:00.000Z' });
    const fake = makeFakeStore({ goals: [g] });
    const { deps, text } = makeDeps({
      store: fake.store,
      env: {},
      config: { experimentalGoalSteward: true },
      readLine: async () => '',
    });
    await reviewConversationGoals(deps, 'conv_B');
    assert.ok(text().includes('blocked'), 'prompts when config=true even with empty env');
  });
});
