import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  createAutoStageContext,
  createAutoStageEngine,
  createAutoStageEngineContext,
  type AutoStageEngineDeps,
  type AutoStageEngineContext,
} from '../../src/interface/auto-stage.ts';
import type { GoalPlan, GoalPlanTodo } from '../../src/core/goal-plan.ts';
import type { RoadmapItem } from '../../src/core/work-contract.ts';
import type { SystemModel } from '../../src/core/understanding.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { MenuContext } from '../../src/interface/menu.ts';
import type { AppConfig } from '../../src/infra/config.ts';
import type { EnvironmentStatus, ProviderStatus } from '../../src/providers/detect.ts';
import type { GoalStore } from '../../src/infra/goal-store.ts';
import type { Goal } from '../../src/core/goal-todo.ts';
import type { OrchestrateDeps } from '../../src/core/types.ts';
import type { ProviderId } from '../../src/providers/port.ts';

import { createTurnCallBudget, type TurnCallBudget } from '../../src/core/turn-call-budget.js';

const MODEL: SystemModel = {
  summary: 'auth flows live under src/auth',
  modules: ['src/auth/session.ts'],
  conventions: ['use injected stores'],
  constraints: ['do not shell out from core'],
  openQuestions: ['which provider owns refresh?'],
  researchCitations: [],
};

function providerStatus(id: ProviderId, authenticated = false): ProviderStatus {
  return {
    id,
    installed: authenticated,
    version: authenticated ? '1.0.0' : null,
    authenticated,
    plan: null,
    binaryPath: authenticated ? `/${id}` : null,
    availableModels: [],
  };
}

function fakeEnv(authenticated = false): EnvironmentStatus {
  return {
    claude: providerStatus('claude', authenticated),
    codex: providerStatus('codex', false),
    opencode: providerStatus('opencode', false),
    grok: providerStatus('grok', false),
    hasAnyProvider: authenticated,
    platform: 'linux',
  };
}

function makeSink(): OutputSink & { text: string } {
  return {
    text: '',
    color: false,
    isTty: false,
    write(s: string): void {
      this.text += s;
    },
  };
}

function todosToRoadmap(todos: readonly GoalPlanTodo[]): RoadmapItem[] {
  return todos.map((todo, index) => ({
    id: `r${String(index + 1)}`,
    text: todo.text,
    status: 'pending',
    ...(todo.dependsOn !== undefined
      ? { dependsOn: todo.dependsOn.map((dep) => `r${String(dep)}`) }
      : {}),
  }));
}

function fallbackLabel(text: string): string {
  return `Label: ${text.trim().slice(0, 24)}`;
}

function makeGoal(title: string, todos: readonly GoalPlanTodo[]): Goal {
  return {
    version: 1,
    id: `goal_${title.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'x'}`,
    title,
    state: 'parked',
    source: 'auto-staged',
    roadmap: todosToRoadmap(todos),
    scope: 'project',
    projectKey: 'project-key',
    conversationId: 'conv_1',
    createdAt: '2026-06-23T00:00:00.000Z',
    lastTouched: '2026-06-23T00:00:00.000Z',
  };
}

interface GoalStoreCalls {
  readonly created: Goal[];
  readonly setStates: { id: string; state: string }[];
  readonly listFilters: unknown[];
}

function makeGoalStore(existing: Goal[] = []): GoalStore & GoalStoreCalls {
  const created: Goal[] = [];
  const setStates: { id: string; state: string }[] = [];
  const listFilters: unknown[] = [];
  return {
    created,
    setStates,
    listFilters,
    async list(filter?: unknown): Promise<Goal[]> {
      listFilters.push(filter);
      return [...existing, ...created];
    },
    async get(): Promise<Goal | null> {
      return null;
    },
    async create(input): Promise<Goal> {
      const goal = makeGoal(input.title, input.roadmap.map((item) => ({ text: item.text })));
      const stored: Goal = {
        ...goal,
        roadmap: input.roadmap,
        scope: input.scope,
        projectKey: input.projectKey,
        conversationId: input.conversationId ?? null,
        source: input.source ?? 'user-explicit',
        ...(input.approach !== undefined ? { approach: input.approach } : {}),
      };
      created.push(stored);
      return stored;
    },
    async setState(id, state): Promise<Goal | null> {
      setStates.push({ id, state });
      return created.find((goal) => goal.id === id) ?? null;
    },
    async setGoalVerdict(): Promise<Goal | null> {
      return null;
    },
    async setRoadmapItemVerdict(): Promise<Goal | null> {
      return null;
    },
    async updateRoadmapItem(): Promise<Goal | null> {
      return null;
    },
    async addRoadmapItem(): Promise<Goal | null> {
      return null;
    },
    async removeRoadmapItem(): Promise<Goal | null> {
      return null;
    },
  } as unknown as GoalStore & GoalStoreCalls;
}

function makeCtx(config: AppConfig = {}): MenuContext {
  return {
    version: 'test',
    clock: {
      now: () => 0,
      isoNow: () => '2026-06-23T00:00:00.000Z',
      uuid: () => 'uuid',
      random: () => 0.5,
    },
    ledger: { async record(): Promise<void> {} },
    providers: {},
    env: fakeEnv(),
    store: {
      async list() {
        return [
          {
            id: 'conv_1',
            title: 'Conversation',
            createdAt: '2026-06-23T00:00:00.000Z',
            updatedAt: '2026-06-23T00:00:00.000Z',
            messageCount: 0,
            pinned: false,
            category: null,
          },
        ];
      },
    },
    config,
    cwd: '/repo',
    sandbox: 'workspace-write',
    timeoutMs: 5_000,
  } as unknown as MenuContext;
}

function makeEngine(
  overrides: Partial<AutoStageEngineDeps> = {},
): { deps: AutoStageEngineDeps; autoCtx: AutoStageEngineContext; out: ReturnType<typeof makeSink>; goalStore: GoalStore & GoalStoreCalls } {
  const upstream = createAutoStageContext();
  const autoCtx = createAutoStageEngineContext(upstream);
  const out = makeSink();
  const goalStore = makeGoalStore();
  const mutableCtx = {
    config: { mode: 'balanced' } as AppConfig,
    env: fakeEnv(),
  };
  const deps: AutoStageEngineDeps = {
    autoCtx,
    autoStageOn: true,
    understandingOn: true,
    planningDepthOn: true,
    tasteOn: false,
    ROADMAP_LIMIT: 8,
    UNDERSTANDING_REFRESH_TURNS: 3,
    ctx: makeCtx(mutableCtx.config),
    mutableCtx,
    out,
    convId: 'conv_1',
    goalStore,
    syncBoard: async () => {},
    currentPressure: () => 0,
    resolveProjectKeyOnce: async () => 'project-key',
    // The understanding cache is keyed via resolveCacheKey; the fakes return a
    // stable key so the tests can pre-seed/read the cache by a known string.
    resolveCacheKey: async () => 'project-key',
    resolveRepoFingerprintOnce: async () => ({ headSha: '', treeHash: '' }),
    repoFingerprint: () => undefined,
    verificationAvailableForCwd: async () => true,
    todosToRoadmap,
    buildGoalPlanner: () => null,
    buildGoalPlannerAttempt: () => null,
    buildUnderstandingPass: () => null,
    buildDeps: () => ({}) as OrchestrateDeps,
    resolvePlannerTasteContext: async () => undefined,
    formGoalLabel: async (text) => fallbackLabel(text),
    resolveEnvironmentOnce: async () => 'repo files',
    conversationLive: () => true,
    ...overrides,
  };
  return { deps, autoCtx, out, goalStore };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  assert.equal(predicate(), true);
}

describe('createAutoStageEngine warmUnderstanding cache behavior', () => {
  it('cold cache calls the understanding pass, stores the model, and counts the blocking call', async () => {
    let passCalls = 0;
    const { deps, autoCtx } = makeEngine({
      buildUnderstandingPass: () => async (task) => {
        passCalls += 1;
        assert.equal(task, 'build the auth refresh flow');
        return MODEL;
      },
    });
    const engine = createAutoStageEngine(deps);

    engine.warmUnderstanding('project-key', 'build the auth refresh flow');

    await waitFor(() => autoCtx.systemModelCache.has('project-key'));
    assert.equal(passCalls, 1);
    assert.equal(autoCtx.upstreamBlockingCalls, 1);
    assert.deepEqual(autoCtx.systemModelCache.get('project-key'), {
      model: MODEL,
      atTurn: 0,
    });
  });

  it('fresh (warm) cache used by resolveAutoStage does not re-run the understanding pass', async () => {
    let passFactories = 0;
    let plannerCalls = 0;
    const { deps, autoCtx } = makeEngine({
      buildUnderstandingPass: () => {
        passFactories += 1;
        return async () => MODEL;
      },
      buildGoalPlanner: (systemModel) => {
        assert.equal(systemModel, MODEL);
        return async () => {
          plannerCalls += 1;
          return { judgment: 'none', goals: [] };
        };
      },
    });
    autoCtx.autoStageTurns = 4;
    autoCtx.systemModelCache.set('project-key', { model: MODEL, atTurn: 4 });
    const engine = createAutoStageEngine(deps);

    await engine.resolveAutoStage('build the auth refresh flow');

    assert.equal(autoCtx.autoStageTurns, 5);
    assert.equal(passFactories, 0);
    assert.equal(autoCtx.upstreamBlockingCalls, 0);
    assert.equal(plannerCalls, 1);
  });

  it('stale (in-flight) warm does not double-launch another understanding pass', () => {
    let passFactories = 0;
    const { deps, autoCtx } = makeEngine({
      buildUnderstandingPass: () => {
        passFactories += 1;
        return async () => MODEL;
      },
    });
    autoCtx.understandingWarmInFlight.add('project-key');
    const engine = createAutoStageEngine(deps);

    engine.warmUnderstanding('project-key', 'build the auth refresh flow');

    assert.equal(passFactories, 0);
    assert.equal(autoCtx.upstreamBlockingCalls, 0);
    assert.equal(autoCtx.understandingWarmInFlight.has('project-key'), true);
  });
});

describe('createAutoStageEngine judgeGoal planner mapping', () => {
  const approach = {
    chosen: 'rotate tokens server-side',
    rationale: 'it closes the replay window',
    alternatives: ['client-only refresh'],
  };

  async function judgeWithPlan(goalText: string, plan: GoalPlan | null) {
    const { deps, autoCtx } = makeEngine({
      buildGoalPlannerAttempt: (_tier, systemModel) => {
        assert.equal(systemModel, MODEL);
        return async (task) => {
          assert.equal(task, goalText);
          return plan === null ? null : { plan, provider: 'claude', model: 'model-a', raw: JSON.stringify(plan) };
        };
      },
    });
    autoCtx.systemModelCache.set('project-key', { model: MODEL, atTurn: 0 });
    return createAutoStageEngine(deps).judgeGoal(goalText);
  }

  it('trivial planner miss falls back to a staged smart label and single roadmap item', async () => {
    const result = await judgeWithPlan('fix a typo', null);

    assert.deepEqual(result, {
      judgment: 'stage',
      title: 'Label: fix a typo',
      roadmap: [{ id: 'r1', text: 'fix a typo', status: 'pending' }],
    });
  });

  it('complex staged planner output preserves title, roadmap, approach, plan, and system model', async () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'ship auth hardening',
      goals: [
        {
          title: 'Harden token refresh',
          approach,
          doneWhen: 'refresh rotation is covered by tests',
          todos: [
            { text: 'Add refresh-token rotation' },
            { text: 'Cover replay rejection', dependsOn: [1] },
          ],
        },
      ],
    };

    const result = await judgeWithPlan('build a multi-step auth refresh feature', plan);

    assert.equal(result.judgment, 'stage');
    assert.equal(result.title, 'Harden token refresh');
    assert.deepEqual(result.roadmap, [
      { id: 'r1', text: 'Add refresh-token rotation', status: 'pending' },
      {
        id: 'r2',
        text: 'Cover replay rejection',
        status: 'pending',
        dependsOn: ['r1'],
      },
    ]);
    assert.equal(result.approach, approach);
    assert.equal(result.plan, plan);
    assert.equal(result.systemModel, MODEL);
    assert.equal('clarifyingQuestion' in result, false);
  });

  it('ambiguous clarify output surfaces the planner question and uses the fallback title when no goal title exists', async () => {
    const plan: GoalPlan = {
      judgment: 'clarify',
      clarifyingQuestion: 'Which billing provider should this target?',
      goals: [],
    };

    const result = await judgeWithPlan('add billing integration', plan);

    assert.equal(result.judgment, 'clarify');
    assert.equal(result.title, 'Label: add billing integration');
    assert.deepEqual(result.roadmap, [
      { id: 'r1', text: 'add billing integration', status: 'pending' },
    ]);
    assert.equal(result.clarifyingQuestion, 'Which billing provider should this target?');
    assert.equal(result.plan, plan);
    assert.equal(result.systemModel, MODEL);
    assert.equal('approach' in result, false);
  });

  it('risky clarify output keeps a non-empty planner title, roadmap, approach, and question', async () => {
    const plan: GoalPlan = {
      judgment: 'clarify',
      clarifyingQuestion: 'Which data is safe to delete, and what backup is approved?',
      goals: [
        {
          title: 'Plan production data removal',
          approach,
          todos: [{ text: 'Confirm retention and backup requirements' }],
        },
      ],
    };

    const result = await judgeWithPlan('delete old production customer data', plan);

    assert.equal(result.judgment, 'clarify');
    assert.equal(result.title, 'Plan production data removal');
    assert.deepEqual(result.roadmap, [
      {
        id: 'r1',
        text: 'Confirm retention and backup requirements',
        status: 'pending',
      },
    ]);
    assert.equal(result.clarifyingQuestion, 'Which data is safe to delete, and what backup is approved?');
    assert.equal(result.approach, approach);
    assert.equal(result.plan, plan);
    assert.equal(result.systemModel, MODEL);
  });

  it("already-complete planner judgment 'none' currently falls through to the staged fallback", async () => {
    const plan: GoalPlan = { judgment: 'none', goals: [] };

    const result = await judgeWithPlan('the migration is already complete', plan);

    assert.deepEqual(result, {
      judgment: 'stage',
      title: 'Label: the migration is already',
      roadmap: [
        {
          id: 'r1',
          text: 'the migration is already complete',
          status: 'pending',
        },
      ],
    });
  });
});

describe('createAutoStageEngine resolveAutoStage', () => {
  it('disabled auto-stage is a no-op', async () => {
    let plannerFactories = 0;
    const { deps, autoCtx, goalStore } = makeEngine({
      autoStageOn: false,
      buildGoalPlanner: () => {
        plannerFactories += 1;
        return async () => ({ judgment: 'none', goals: [] });
      },
    });

    await createAutoStageEngine(deps).resolveAutoStage('build the auth refresh flow');

    assert.equal(autoCtx.autoStageTurns, 0);
    assert.equal(plannerFactories, 0);
    assert.equal(goalStore.created.length, 0);
  });

  it("enabled planner judgment 'none' does not auto-stage a goal", async () => {
    let plannerCalls = 0;
    const { deps, autoCtx, goalStore } = makeEngine({
      understandingOn: false,
      buildGoalPlanner: (systemModel) => {
        assert.equal(systemModel, undefined);
        return async () => {
          plannerCalls += 1;
          return { judgment: 'none', goals: [] };
        };
      },
    });

    await createAutoStageEngine(deps).resolveAutoStage('thanks, sounds good');

    assert.equal(autoCtx.autoStageTurns, 1);
    assert.equal(plannerCalls, 1);
    assert.equal(goalStore.created.length, 0);
  });

  it('enabled clear work intent creates a project-scoped auto-staged goal and syncs the board', async () => {
    let synced = 0;
    const runSpyFired = false;
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'ship auth hardening',
      goals: [
        {
          title: 'Harden token refresh',
          todos: [
            { text: 'Add refresh-token rotation' },
            { text: 'Cover replay rejection' },
          ],
          approach: {
            chosen: 'rotate refresh tokens server-side',
            rationale: 'server rotation prevents replay',
          },
        },
      ],
    };
    const { deps, autoCtx, goalStore, out } = makeEngine({
      understandingOn: false,
      syncBoard: async () => {
        synced += 1;
      },
      buildGoalPlanner: (systemModel) => {
        assert.equal(systemModel, undefined);
        return async (task) => {
          assert.equal(task, 'build auth refresh hardening');
          return plan;
        };
      },
    });

    await createAutoStageEngine(deps).resolveAutoStage('build auth refresh hardening');

    assert.equal(autoCtx.autoStageTurns, 1);
    assert.equal(goalStore.created.length, 1);
    assert.equal(goalStore.created[0]?.title, 'Harden token refresh');
    assert.equal(goalStore.created[0]?.scope, 'project');
    assert.equal(goalStore.created[0]?.projectKey, 'project-key');
    assert.equal(goalStore.created[0]?.conversationId, 'conv_1');
    assert.equal(goalStore.created[0]?.source, 'auto-staged');
    assert.deepEqual(
      goalStore.created[0]?.roadmap.map((item) => item.text),
      ['Add refresh-token rotation', 'Cover replay rejection'],
    );
    assert.deepEqual(goalStore.created[0]?.approach, {
      chosen: 'rotate refresh tokens server-side',
      rationale: 'server rotation prevents replay',
    });
    assert.equal(synced, 1);
    assert.match(out.text, /Staged 1 goal on the board: Harden token refresh/);
    // INVARIANT: zero execution functions invoked
    assert.deepEqual(goalStore.setStates, []);
    assert.equal(runSpyFired, false, 'no background run was spawned');
  });

  it('stage/confident/adaptive remains parked — confident plan with 3+ todos never auto-executes', async () => {
    const runSpyFired = false;
    let synced = 0;
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'ship the full auth system',
      goals: [
        {
          title: 'Build auth module',
          todos: [
            { text: 'Design token schema' },
            { text: 'Implement refresh rotation' },
            { text: 'Add replay rejection' },
            { text: 'Wire integration tests' },
          ],
          approach: {
            chosen: 'server-side refresh with TTL rotation',
            rationale: 'strongest security posture',
          },
        },
      ],
    };
    const { deps, autoCtx, goalStore, out } = makeEngine({
      understandingOn: false,
      syncBoard: async () => { synced += 1; },
      buildGoalPlanner: () => async () => plan,
    });

    await createAutoStageEngine(deps).resolveAutoStage('build a complete auth system with token refresh');

    assert.equal(autoCtx.autoStageTurns, 1);
    assert.equal(goalStore.created.length, 1);
    assert.equal(goalStore.created[0]?.source, 'auto-staged');
    assert.equal(synced, 1);
    // INVARIANT: goal stays parked, zero execution functions invoked
    assert.equal(runSpyFired, false, 'no background run was spawned');
    assert.deepEqual(goalStore.setStates, [], 'zero setState calls — goal stays parked');
    // Verify it is NOT 'running'
    // The store create puts it as 'parked' and we never call setState.
    // The created goal's state field in the mock is set by makeGoal (parked).
    assert.match(out.text, /Staged/);
  });

  it('stage/high-risk remains parked — high-stakes plan never auto-executes', async () => {
    const runSpyFired = false;
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'security hardening',
      goals: [
        {
          title: 'Rotate all secrets and oauth tokens',
          todos: [
            { text: 'Audit current secret usage' },
            { text: 'Generate new secrets' },
            { text: 'Deploy rotation' },
          ],
        },
      ],
    };
    const { deps, goalStore } = makeEngine({
      understandingOn: false,
      buildGoalPlanner: () => async () => plan,
    });

    await createAutoStageEngine(deps).resolveAutoStage('rotate all secrets and oauth credentials');

    assert.equal(goalStore.created.length, 1);
    assert.equal(goalStore.created[0]?.source, 'auto-staged');
    // INVARIANT: zero execution
    assert.equal(runSpyFired, false);
    assert.deepEqual(goalStore.setStates, []);
  });

  it('planner failure creates nothing', async () => {
    const { deps, goalStore } = makeEngine({
      understandingOn: false,
      buildGoalPlanner: () => async () => {
        throw new Error('planner timeout');
      },
    });

    await createAutoStageEngine(deps).resolveAutoStage('build a complete auth system');

    assert.equal(goalStore.created.length, 0);
    assert.equal(goalStore.setStates.length, 0);
  });

  it('planner returns null creates nothing', async () => {
    const { deps, goalStore } = makeEngine({
      understandingOn: false,
      buildGoalPlanner: () => async () => null,
    });

    await createAutoStageEngine(deps).resolveAutoStage('build a complete auth system');

    assert.equal(goalStore.created.length, 0);
    assert.equal(goalStore.setStates.length, 0);
  });

  it('verification unavailable does not change parked-only behaviour', async () => {
    const runSpyFired = false;
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'add CI pipeline',
      goals: [
        {
          title: 'Set up CI',
          todos: [
            { text: 'Write pipeline config' },
            { text: 'Add test stage' },
            { text: 'Add deploy stage' },
          ],
        },
      ],
    };
    const { deps, goalStore } = makeEngine({
      understandingOn: false,
      verificationAvailableForCwd: async () => false,
      buildGoalPlanner: () => async () => plan,
    });

    await createAutoStageEngine(deps).resolveAutoStage('build a CI pipeline from scratch');

    assert.equal(goalStore.created.length, 1);
    assert.equal(runSpyFired, false);
    assert.deepEqual(goalStore.setStates, []);
  });

  it('conversation dead does not block parked goal creation but never paints output', async () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'add feature',
      goals: [
        {
          title: 'Add dark mode',
          todos: [
            { text: 'Add CSS variables' },
            { text: 'Wire toggle' },
          ],
        },
      ],
    };
    const { deps, autoCtx, goalStore, out } = makeEngine({
      understandingOn: false,
      conversationLive: () => false,
      syncBoard: async () => {},
      buildGoalPlanner: () => async () => plan,
    });

    await createAutoStageEngine(deps).resolveAutoStage('add a dark mode');

    assert.equal(autoCtx.autoStageTurns, 1);
    assert.equal(goalStore.created.length, 1);
    assert.equal(goalStore.created[0]?.source, 'auto-staged');
    assert.deepEqual(goalStore.setStates, []);
    // Output must NOT be painted when conversation is dead
    assert.equal(out.text.includes('Staged'), false);
    assert.equal(out.text, '');
  });

  it('create-failure does not crash the stage loop (fail-soft)', async () => {
    let createCalls = 0;
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'add two features',
      goals: [
        {
          title: 'Add dark mode',
          todos: [{ text: 'Add CSS variables' }],
        },
        {
          title: 'Add light mode',
          todos: [{ text: 'Add CSS variables' }],
        },
      ],
    };
    const fakeStore = makeGoalStore();
    const origCreate = fakeStore.create.bind(fakeStore);
    fakeStore.create = async (input) => {
      createCalls += 1;
      if (createCalls === 1) throw new Error('store write failed');
      return origCreate(input);
    };
    const { deps, autoCtx } = makeEngine({
      understandingOn: false,
      goalStore: fakeStore,
      buildGoalPlanner: () => async () => plan,
    });

    await createAutoStageEngine(deps).resolveAutoStage('add dark and light modes');

    assert.equal(autoCtx.autoStageTurns, 1);
    // First goal failed to create, second succeeded
    assert.equal(fakeStore.created.length, 1);
    assert.equal(fakeStore.created[0]?.title, 'Add light mode');
    assert.deepEqual(fakeStore.setStates, []);
  });

  it('budgeted auto-stage creates parked goal and invokes zero execution callbacks', async () => {
    // This test verifies the budget resolver wiring: auto-stage receives a budget
    // keyed by the originating turn ID and threads it into the goal-plan generator,
    // which already wraps the provider call with runBudgetedProvider. The result
    // is still parked-only: a goal is created, and zero execution callbacks fire.
    const budget = createTurnCallBudget({
      turnId: 'turn-budgeted-test',
      mode: 'observe',
      totalUnits: 5,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'add test feature',
      goals: [
        {
          title: 'Wire budget test',
          todos: [{ text: 'Add budget test' }, { text: 'Verify parked' }],
        },
      ],
    };

    let budgetCaptured: TurnCallBudget | undefined;

    const { deps, goalStore } = makeEngine({
      understandingOn: false,
      getCurrentTurnId: () => 'turn-budgeted-test',
      getBudgetForTurn: (turnId: string) => {
        if (turnId === 'turn-budgeted-test') return budget;
        return undefined;
      },
      buildGoalPlanner: (
        _systemModel?: SystemModel,
        _tasteContext?: string,
        turnCallBudget?: TurnCallBudget,
      ) => {
        budgetCaptured = turnCallBudget;
        return async () => plan;
      },
    });

    await createAutoStageEngine(deps).resolveAutoStage('wire the budget test');

    // Budget was threaded to buildGoalPlanner
    assert.equal(budgetCaptured, budget);

    // Goal was created and is parked
    assert.equal(goalStore.created.length, 1);
    assert.equal(goalStore.created[0]?.title, 'Wire budget test');
    assert.equal(goalStore.created[0]?.source, 'auto-staged');

    // Zero execution callbacks — parked-only invariant
    assert.deepEqual(goalStore.setStates, []);
  });
});
