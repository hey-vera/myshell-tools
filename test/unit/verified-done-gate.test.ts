/**
 * test/unit/verified-done-gate.test.ts — the VERIFIED-DONE goal-completion GATE
 * composition (Elite-partner Part 3, the anti-fabrication backbone).
 *
 * The gate (menu.ts `gateGoalCompletion`) is the composition:
 *   verifyStage(real port) → goalVerdictFromOutcome → { persist via setGoalVerdict,
 *   isGoalVerifiedDone → done|not-done }.
 * The model's GOAL_COMPLETE is DEMOTED to a request to verify — the verdict, computed
 * ONLY from a real VerifyOutcome, decides. This test wires that exact chain through a
 * fake VerifyPort so the four canonical outcomes are pinned end-to-end:
 *   - tests GREEN  ⇒ passing ⇒ DONE  (+ verdict persisted)
 *   - tests RED    ⇒ failing ⇒ NOT done (+ honest receipt persisted)
 *   - empty diff   ⇒ unverified ⇒ NOT done (no fake green on no change)
 *   - port THROWS  ⇒ unverified ⇒ NOT done (fail-soft, never crashes)
 *
 * Run with: node --import ./test/register.mjs --test "test/unit/verified-done-gate.test.ts"
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { verifyStage } from '../../src/core/work-call.ts';
import type {
  VerifyPort,
  CapturedDiff,
  DetectedTestCommand,
  TestRunResult,
} from '../../src/core/verify.ts';
import { goalVerdictFromOutcome, isGoalVerifiedDone } from '../../src/core/goal-todo.ts';
import { createFileGoalStore, type GoalStore } from '../../src/infra/goal-store.ts';
import type { Clock } from '../../src/core/types.ts';

function makeFakeClock(iso = '2026-06-10T00:00:00.000Z'): Clock {
  let n = 0;
  return {
    now: () => Date.parse(iso),
    isoNow: () => iso,
    uuid: () => `01HX0000000000000000${String(++n).padStart(6, '0')}`,
    random: () => 0.5,
  };
}

function fakePort(over: Partial<VerifyPort> = {}): VerifyPort {
  return {
    async captureDiff(): Promise<CapturedDiff> {
      return { files: ['a.ts'], patch: 'diff --git a/a.ts b/a.ts\n+const x = 1;' };
    },
    async detectTestCommand(): Promise<DetectedTestCommand | null> {
      return { label: 'npm test', command: 'npm', args: ['test'] };
    },
    async runTests(): Promise<TestRunResult> {
      return { outcome: 'green', output: 'ok', durationMs: 4200 };
    },
    ...over,
  };
}

/**
 * Mirror the menu.ts gate exactly: run verifyStage (tests-only, like the gate),
 * map → verdict, persist via the SOLE evidence-write path, return whether done.
 */
async function runGate(
  store: GoalStore,
  clock: Clock,
  goalId: string,
  port: VerifyPort,
): Promise<{ done: boolean; persistedState: string | undefined }> {
  const outcome = await verifyStage({
    output: '',
    provider: 'claude',
    tier: 'worker',
    port,
    level: 'tests',
    cwd: '/tmp/proj',
  }).catch(() => ({ verified: 'unverified' as const, changedFiles: 0, note: 'crashed' }));
  const verdict = goalVerdictFromOutcome(
    outcome ?? { verified: 'unverified', changedFiles: 0, note: 'unarmed' },
    clock.isoNow(),
  );
  const updated = await store.setGoalVerdict(goalId, verdict).catch(() => null);
  return { done: isGoalVerifiedDone(verdict), persistedState: updated?.goalVerdict?.state };
}

let homeDir: string;
let clock: Clock;
let store: GoalStore;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), `gate-test-${randomUUID()}-`));
  clock = makeFakeClock();
  store = createFileGoalStore({ homeDir, clock });
});
afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('verified-done gate — only REAL passing/reviewed marks done', () => {
  it('tests GREEN ⇒ passing ⇒ DONE, verdict persisted', async () => {
    const g = await store.create({ title: 'ship feature' });
    const r = await runGate(store, clock, g.id, fakePort());
    assert.equal(r.done, true);
    assert.equal(r.persistedState, 'passing');
  });

  it('tests RED ⇒ failing ⇒ NOT done, honest failing verdict persisted', async () => {
    const g = await store.create({ title: 'ship feature' });
    const r = await runGate(
      store,
      clock,
      g.id,
      fakePort({ async runTests() { return { outcome: 'red', output: '1 failing', durationMs: 900 }; } }),
    );
    assert.equal(r.done, false);
    assert.equal(r.persistedState, 'failing');
  });

  it('EMPTY diff ⇒ unverified ⇒ NOT done (no fake green on no change)', async () => {
    const g = await store.create({ title: 'no-op turn' });
    const r = await runGate(
      store,
      clock,
      g.id,
      fakePort({ async captureDiff() { return { files: [], patch: '' }; } }),
    );
    assert.equal(r.done, false);
    assert.equal(r.persistedState, 'unverified');
  });

  it('no test command ⇒ unverified ⇒ NOT done (a diff with no tests is not verified)', async () => {
    const g = await store.create({ title: 'docs only' });
    const r = await runGate(
      store,
      clock,
      g.id,
      fakePort({ async detectTestCommand() { return null; } }),
    );
    assert.equal(r.done, false);
    assert.equal(r.persistedState, 'unverified');
  });

  it('port THROWS ⇒ unverified ⇒ NOT done (fail-soft, never crashes the loop)', async () => {
    const g = await store.create({ title: 'flaky env' });
    const r = await runGate(
      store,
      clock,
      g.id,
      fakePort({ async captureDiff(): Promise<CapturedDiff> { throw new Error('git exploded'); } }),
    );
    assert.equal(r.done, false);
    assert.equal(r.persistedState, 'unverified');
  });
});
