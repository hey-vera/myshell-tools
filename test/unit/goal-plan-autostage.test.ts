/**
 * test/unit/goal-plan-autostage.test.ts — the POST-TURN auto-stage behaviour
 * (Elite-partner Phase 6, the menu.ts wiring contract). Drives the REAL file-backed
 * GoalStore with the SAME staging logic the menu post-turn slot applies to a judged
 * GoalPlan, plus a board-sync spy, so it locks in:
 *   - judgment 'stage'   → parked goals created in the store (born parked,
 *                          roadmap = todos), then the board is synced.
 *   - judgment 'none'    → nothing created, board not synced.
 *   - judgment 'clarify' → nothing created (the question is surfaced elsewhere).
 *   - the planner-gate truth: flag-off / trivial / max-pressure ⇒ planner NOT
 *     invoked (no model call).
 *
 * Hermetic: temp homeDir + injected Clock, mirroring goal-store.test.ts.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createFileGoalStore, type GoalStore } from '../../src/infra/goal-store.ts';
import type { Clock } from '../../src/core/types.ts';
import type { GoalPlan } from '../../src/core/goal-plan.ts';
import { planTodosToRoadmap } from '../../src/core/goal-plan.ts';
import { autoStageEnabled } from '../../src/interface/ui/auto-goal-flag.ts';
import { understandingEnabled } from '../../src/interface/ui/understanding-flag.ts';
import { classify, hasTierEvidence } from '../../src/core/classify.ts';
import type { SystemModel } from '../../src/core/understanding.ts';

function makeFakeClock(startIso = '2026-06-05T00:00:00.000Z'): Clock {
  let counter = 0;
  return {
    now: () => Date.parse(startIso),
    isoNow: () => startIso,
    uuid: () => {
      counter += 1;
      return `01HX0000000000000000${String(counter).padStart(6, '0')}`;
    },
    random: () => 0.5,
  };
}

/**
 * The EXACT staging logic the menu post-turn slot applies to a judged plan
 * (mirrors resolveAutoStage's stage branch): born-parked create per goal with the
 * todos as the roadmap, then a board sync. Returns the count actually staged.
 */
async function applyStage(
  store: GoalStore,
  plan: GoalPlan,
  convId: string | null,
  syncBoard: () => Promise<void>,
): Promise<number> {
  if (plan.judgment !== 'stage') {
    // 'none' / 'clarify' create nothing and never touch the board from staging.
    return 0;
  }
  let staged = 0;
  for (const g of plan.goals) {
    const title = g.title.trim();
    if (title.length === 0) continue;
    await store.create({
      title,
      roadmap: planTodosToRoadmap(g.todos),
      scope: 'global',
      projectKey: null,
      conversationId: convId,
      source: 'auto-staged',
    });
    staged += 1;
  }
  if (staged > 0) await syncBoard();
  return staged;
}

describe('post-turn auto-stage', () => {
  let home: string;
  let store: GoalStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `autostage-${randomUUID()}-`));
    store = createFileGoalStore({ homeDir: home, clock: makeFakeClock() });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("judgment 'stage' creates PARKED goals (roadmap = todos) and syncs the board", async () => {
    const plan: GoalPlan = {
      judgment: 'stage',
      vision: 'A real auth system',
      goals: [
        {
          title: 'Build the signup flow',
          todos: [{ text: 'Model users' }, { text: 'Add the endpoint', dependsOn: [1] }],
        },
        { title: 'Add password reset', todos: [{ text: 'Wire the reset email' }] },
      ],
    };
    let synced = 0;
    const staged = await applyStage(store, plan, 'conv_1', async () => {
      synced += 1;
    });
    assert.equal(staged, 2);
    assert.equal(synced, 1, 'board synced once after staging');

    const goals = await store.list();
    assert.equal(goals.length, 2);
    // Born parked (non-destructive) — never queued/running.
    for (const g of goals) {
      assert.equal(g.state, 'parked', 'staged goals are born parked');
      assert.equal(g.source, 'auto-staged');
      assert.equal(g.conversationId, 'conv_1');
    }
    const signup = goals.find((g) => g.title === 'Build the signup flow');
    assert.ok(signup !== undefined);
    assert.deepEqual(
      signup?.roadmap.map((it) => it.text),
      ['Model users', 'Add the endpoint'],
      'todos became the roadmap',
    );
    assert.ok(signup?.roadmap.every((it) => it.status === 'pending'), 'todos start pending');
    // The 1-based dependsOn index [1] translated into the first sibling's id (r1).
    const endpoint = signup?.roadmap.find((it) => it.text === 'Add the endpoint');
    const modelUsers = signup?.roadmap.find((it) => it.text === 'Model users');
    assert.deepEqual(endpoint?.dependsOn, [modelUsers?.id], 'index→id dependency wired');
    assert.equal(modelUsers?.dependsOn, undefined, 'a todo with no deps has no dependsOn field');
  });

  it("judgment 'none' creates nothing and never syncs the board", async () => {
    const plan: GoalPlan = { judgment: 'none', goals: [] };
    let synced = 0;
    const staged = await applyStage(store, plan, null, async () => {
      synced += 1;
    });
    assert.equal(staged, 0);
    assert.equal(synced, 0);
    assert.equal((await store.list()).length, 0, 'no goals created on none');
  });

  it("judgment 'clarify' creates no goals (the question is surfaced, not staged)", async () => {
    const plan: GoalPlan = {
      judgment: 'clarify',
      goals: [],
      clarifyingQuestion: 'Which database?',
    };
    let synced = 0;
    const staged = await applyStage(store, plan, null, async () => {
      synced += 1;
    });
    assert.equal(staged, 0);
    assert.equal(synced, 0);
    assert.equal((await store.list()).length, 0, 'no goals created on clarify');
  });
});

describe('planner gate — the menu invocation conditions', () => {
  // The menu only invokes the planner when: flag ON, a NON-TRIVIAL turn
  // (hasTierEvidence), and pressure below the ceiling. This locks the pure pieces
  // of that gate; flag-off OR a trivial turn ⇒ planner never runs.
  function shouldInvoke(env: NodeJS.ProcessEnv, config: { experimentalAutoGoal?: boolean }, line: string, pressure: number): boolean {
    return autoStageEnabled(env, config) && hasTierEvidence(line) && pressure < 3;
  }

  it('flag OFF (explicit opt-out) ⇒ planner not invoked (byte-identical post-turn)', () => {
    assert.equal(shouldInvoke({ MYSHELL_AUTO_GOAL: '0' }, {}, 'build the whole billing system end to end', 0), false);
    assert.equal(shouldInvoke({}, { experimentalAutoGoal: false }, 'build the whole billing system end to end', 0), false);
  });

  it('default ON (no flag) + substantial turn ⇒ planner invoked', () => {
    assert.equal(shouldInvoke({}, {}, 'build and ship the whole auth system with token refresh', 0), true);
  });

  it('flag ON + trivial turn ⇒ planner not invoked', () => {
    assert.equal(shouldInvoke({ MYSHELL_AUTO_GOAL: '1' }, {}, 'sounds good?', 0), false);
    assert.equal(shouldInvoke({ MYSHELL_AUTO_GOAL: '1' }, {}, 'thanks!', 0), false);
  });

  it('flag ON + substantial turn + pressure below ceiling ⇒ planner invoked', () => {
    assert.equal(
      shouldInvoke({ MYSHELL_AUTO_GOAL: '1' }, {}, 'build and ship the whole auth system with token refresh', 0),
      true,
    );
  });

  it('flag ON + substantial turn but pressure at the ceiling ⇒ planner not invoked', () => {
    assert.equal(
      shouldInvoke({ MYSHELL_AUTO_GOAL: '1' }, {}, 'build and ship the whole auth system with token refresh', 3),
      false,
    );
  });
});

describe('understanding pass — the menu grounding wiring (Part 2)', () => {
  // Mirrors resolveAutoStage's understanding branch: when the flag is ON we FIRST
  // run a fail-soft understanding pass, then pass its SystemModel (or undefined) to
  // the planner. When OFF the understanding pass never runs and the planner is
  // called with NO model (byte-identical, ungrounded). highStakes rides
  // classify().risk ∈ {high,critical}. This pure harness captures that contract
  // without a live model.
  const MODEL: SystemModel = {
    summary: 'auth lives in core/oauth',
    modules: ['core/oauth'],
    conventions: [],
    constraints: ['subscription-OAuth only'],
    openQuestions: [],
    researchCitations: [],
  };

  async function simulate(
    env: NodeJS.ProcessEnv,
    config: { experimentalUnderstanding?: boolean },
    line: string,
    pass: ((task: string) => Promise<SystemModel | null>) | null,
  ): Promise<{ understandingRan: boolean; highStakes: boolean; modelToPlanner: SystemModel | undefined }> {
    let understandingRan = false;
    let modelToPlanner: SystemModel | undefined;
    const highStakes = ((): boolean => {
      const r = classify(line).risk;
      return r === 'high' || r === 'critical';
    })();
    if (understandingEnabled(env, config) && pass !== null) {
      understandingRan = true;
      try {
        modelToPlanner = (await pass(line)) ?? undefined;
      } catch {
        modelToPlanner = undefined;
      }
    }
    return { understandingRan, highStakes, modelToPlanner };
  }

  it('understanding OFF (explicit opt-out) ⇒ pass never runs, planner gets NO model (ungrounded)', async () => {
    const pass = async (): Promise<SystemModel | null> => MODEL;
    const r = await simulate({ MYSHELL_UNDERSTANDING: '0' }, {}, 'build the whole auth system', pass);
    assert.equal(r.understandingRan, false);
    assert.equal(r.modelToPlanner, undefined, 'planner ungrounded when understanding opted out');
  });

  it('understanding ON by default ⇒ pass runs, planner grounded', async () => {
    const pass = async (): Promise<SystemModel | null> => MODEL;
    const r = await simulate({}, {}, 'build the whole auth system', pass);
    assert.equal(r.understandingRan, true);
    assert.equal(r.modelToPlanner, MODEL, 'planner grounded by default (cache-ahead in the live menu)');
  });

  it('understanding ON + substantial ⇒ pass runs, planner gets the SystemModel', async () => {
    const pass = async (): Promise<SystemModel | null> => MODEL;
    const r = await simulate({ MYSHELL_UNDERSTANDING: '1' }, {}, 'migrate the oauth token refresh', pass);
    assert.equal(r.understandingRan, true);
    assert.deepEqual(r.modelToPlanner, MODEL, 'planner grounded in the system model');
  });

  it('understanding ON but the pass fails ⇒ planner falls back to ungrounded (fail-soft)', async () => {
    const failing = async (): Promise<SystemModel | null> => {
      throw new Error('investigation timed out');
    };
    const r = await simulate({ MYSHELL_UNDERSTANDING: '1' }, {}, 'migrate the oauth token refresh', failing);
    assert.equal(r.understandingRan, true);
    assert.equal(r.modelToPlanner, undefined, 'a failed pass degrades to ungrounded, never blocks');
  });

  it('understanding ON but the pass returns null ⇒ planner ungrounded', async () => {
    const nullPass = async (): Promise<SystemModel | null> => null;
    const r = await simulate({ MYSHELL_UNDERSTANDING: '1' }, {}, 'migrate the oauth token refresh', nullPass);
    assert.equal(r.modelToPlanner, undefined);
  });

  it('highStakes rides classify().risk: auth/security ⇒ true; a plain feature ⇒ false', async () => {
    const auth = await simulate({ MYSHELL_UNDERSTANDING: '1' }, {}, 'rotate the oauth tokens and secrets', async () => MODEL);
    assert.equal(auth.highStakes, true, 'auth/secrets is high-stakes (web research eligible)');
    const plain = await simulate({ MYSHELL_UNDERSTANDING: '1' }, {}, 'add a dark mode toggle to the settings page', async () => MODEL);
    assert.equal(plain.highStakes, false, 'a plain UI feature is not high-stakes');
  });
});
