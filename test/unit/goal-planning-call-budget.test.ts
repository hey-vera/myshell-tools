import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { makeGoalPlannerAttempt } from '../../src/core/goal-plan-generator.ts';
import { makeGoalObjectiveGenerator } from '../../src/core/goal-objective-generator.ts';
import { makeReplanner } from '../../src/core/goal-replan-generator.ts';
import { decompose } from '../../src/core/decompose.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { createTurnCallBudget } from '../../src/core/turn-call-budget.js';
import type { Provider, ProviderEvent, ProviderId, ProviderRequest } from '../../src/providers/port.ts';
import type { Goal } from '../../src/core/goal-todo.ts';

const SIGNAL = new AbortController().signal;

const SUBSTANTIAL = 'build the whole billing system with stripe and invoices';

function fakeProvider(
  events: ProviderEvent[],
  sink?: { req?: ProviderRequest },
  id: ProviderId = 'claude',
): Provider {
  return {
    id,
    async detect() {
      return {
        id,
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

function singleGoal(roadmap?: Goal['roadmap']): Goal {
  const items = roadmap ?? [{ id: 'r1', text: 'task', status: 'pending' } as const];
  return {
    version: 1,
    id: 'goal_1',
    title: 'Test goal',
    state: 'running',
    source: 'user-explicit',
    roadmap: items as Goal['roadmap'],
    scope: 'project',
    projectKey: 'repo#1',
    conversationId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastTouched: '2026-06-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// 1. objective plan replan and decompose keep one goal-attempt id
// ---------------------------------------------------------------------------
describe('objective plan replan and decompose keep one goal-attempt id', () => {
  it('all four phases share the same turn ID from one budget object', async () => {
    const budget = createTurnCallBudget({
      turnId: 'goal-attempt-42',
      mode: 'observe',
      totalUnits: 8,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const objProvider = fakeProvider([
      { type: 'done', text: 'OBJECTIVE: Build billing core', raw: {} },
    ]);
    const objectiveGen = makeGoalObjectiveGenerator({
      providers: { claude: objProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await objectiveGen('Build billing', SIGNAL);

    const planProvider = fakeProvider([
      { type: 'done', text: 'JUDGMENT: stage\nGOAL: Build billing\nTODO: Wire Stripe', raw: {} },
    ]);
    const planGen = makeGoalPlannerAttempt({
      providers: { claude: planProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await planGen(SUBSTANTIAL, SIGNAL);

    const replanProvider = fakeProvider([
      { type: 'done', text: 'ADD: new task', raw: {} },
    ]);
    const replanGen = makeReplanner({
      providers: { claude: replanProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await replanGen(singleGoal(), SIGNAL);

    const decompProvider = fakeProvider([
      { type: 'done', text: JSON.stringify({ goals: [{ id: 'a', title: 'Part A' }] }), raw: {} },
    ]);
    await decompose('Part A', {}, {
      providers: { claude: decompProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    }, SIGNAL);

    const snap = budget.snapshot();
    assert.equal(snap.turnId, 'goal-attempt-42');
    assert.equal(snap.begun, 4, 'objective + plan + replan + decompose = 4 begun');
    assert.equal(snap.settled, 4);
  });
});

// ---------------------------------------------------------------------------
// 2. each phase has its exact purpose
// ---------------------------------------------------------------------------
describe('each phase has its exact purpose', () => {
  it('records goal-objective, goal-plan, goal-replan, and goal-decompose', async () => {
    const budget = createTurnCallBudget({
      turnId: 'purposes-1',
      mode: 'observe',
      totalUnits: 8,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const objProvider = fakeProvider([
      { type: 'done', text: 'OBJECTIVE: Build billing core', raw: {} },
    ]);
    const objectiveGen = makeGoalObjectiveGenerator({
      providers: { claude: objProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await objectiveGen('Build billing', SIGNAL);

    const planProvider = fakeProvider([
      { type: 'done', text: 'JUDGMENT: stage\nGOAL: Build billing\nTODO: Wire Stripe', raw: {} },
    ]);
    const planGen = makeGoalPlannerAttempt({
      providers: { claude: planProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await planGen(SUBSTANTIAL, SIGNAL);

    const replanProvider = fakeProvider([
      { type: 'done', text: 'ADD: new task', raw: {} },
    ]);
    const replanGen = makeReplanner({
      providers: { claude: replanProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await replanGen(singleGoal(), SIGNAL);

    const decompProvider = fakeProvider([
      { type: 'done', text: JSON.stringify({ goals: [{ id: 'a', title: 'Part A' }] }), raw: {} },
    ]);
    await decompose('Part A', {}, {
      providers: { claude: decompProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    }, SIGNAL);

    const snap = budget.snapshot();
    const begunEvents = snap.events.filter((e) => e.type === 'call-begun');
    assert.equal(begunEvents.length, 4);

    const purposes = begunEvents.map((e) => (e as { type: 'call-begun'; purpose: string }).purpose);
    assert.ok(purposes.includes('goal-objective'));
    assert.ok(purposes.includes('goal-plan'));
    assert.ok(purposes.includes('goal-replan'));
    assert.ok(purposes.includes('goal-decompose'));
  });
});

// ---------------------------------------------------------------------------
// 3. planning cannot borrow work reservation in enforce mode
// ---------------------------------------------------------------------------
describe('planning cannot borrow work reservation in enforce mode', () => {
  it('discretionary-exhausted budget denies planning calls even when work=1 is unused', async () => {
    const budget = createTurnCallBudget({
      turnId: 'enforce-1',
      mode: 'enforce',
      totalUnits: 1,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const provider = fakeProvider([
      { type: 'done', text: 'OBJECTIVE: Build billing core', raw: {} },
    ]);
    const objectiveGen = makeGoalObjectiveGenerator({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });

    const result = await objectiveGen('Build billing', SIGNAL);
    assert.equal(result, null);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 0, 'denied call is never begun');
    assert.equal(snap.denied, 1);
    assert.equal(snap.workRemaining, 1, 'work reservation is intact');
  });
});

// ---------------------------------------------------------------------------
// 4. parse failure counts once
// ---------------------------------------------------------------------------
describe('parse failure counts once', () => {
  it('unparseable output still counts as one attempted call', async () => {
    const budget = createTurnCallBudget({
      turnId: 'parse-fail-1',
      mode: 'observe',
      totalUnits: 4,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const provider = fakeProvider([
      { type: 'done', text: 'sounds good to me!', raw: {} },
    ]);
    const gen = makeGoalPlannerAttempt({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });

    const result = await gen(SUBSTANTIAL, SIGNAL);
    assert.equal(result?.plan, null, 'parse yields null plan');
    assert.equal(result?.raw, 'sounds good to me!', 'raw text is preserved');

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.settled, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. generator with no provider counts zero
// ---------------------------------------------------------------------------
describe('generator with no provider counts zero', () => {
  it('zero providers → zero calls recorded across all four phases', async () => {
    const budget = createTurnCallBudget({
      turnId: 'no-provider-1',
      mode: 'observe',
      totalUnits: 4,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const planGen = makeGoalPlannerAttempt({
      providers: {},
      policy: DEFAULT_POLICY,
      cwd: '/x',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await planGen(SUBSTANTIAL, SIGNAL);

    const objectiveGen = makeGoalObjectiveGenerator({
      providers: {},
      policy: DEFAULT_POLICY,
      cwd: '/x',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await objectiveGen('Build billing', SIGNAL);

    const replanGen = makeReplanner({
      providers: {},
      policy: DEFAULT_POLICY,
      cwd: '/x',
      timeoutMs: 1000,
      turnCallBudget: budget,
    });
    await replanGen(singleGoal(), SIGNAL);

    await decompose('Part A', {}, {
      providers: {},
      policy: DEFAULT_POLICY,
      cwd: '/x',
      timeoutMs: 1000,
      turnCallBudget: budget,
    }, SIGNAL);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 0);
    assert.equal(snap.settled, 0);
    assert.equal(snap.denied, 0);
  });
});
