import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { classify } from '../../src/core/classify.ts';
import { isTrivial, type EngagementSignals } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import {
  decideSemanticPreflightDisposition,
  type SemanticPreflightDisposition,
} from '../../src/core/semantic-preflight.ts';
import type { Classification } from '../../src/core/types.ts';

const WORKER_LOW: Classification = {
  tier: 'worker',
  risk: 'low',
  rationale: 'test worker low',
};

const IC_LOW: Classification = {
  tier: 'ic',
  risk: 'low',
  rationale: 'test ic low',
};

const skippedFrame: IntentFrame = {
  version: 1,
  goal: '',
  confidence: 'high',
  source: 'skipped',
};

function decide(
  task: string,
  deterministic: Classification = classify(task),
  over: Partial<{
    readonly goalTurn: boolean;
    readonly goalTurnHasObjectiveAndDone: boolean;
    readonly hasSemanticExtractor: boolean;
  }> = {},
): SemanticPreflightDisposition {
  return decideSemanticPreflightDisposition({
    task,
    deterministic,
    goalTurn: false,
    goalTurnHasObjectiveAndDone: false,
    hasSemanticExtractor: true,
    ...over,
  });
}

function engagementSignals(
  task: string,
  classification: Classification,
): EngagementSignals {
  return {
    frame: skippedFrame,
    classification,
    routePlan: false,
    engagementBias: 0,
    task,
  };
}

describe('decideSemanticPreflightDisposition', () => {
  it('greeting acknowledgement arithmetic and exact-output turns bypass', () => {
    for (const task of [
      'hi',
      ' hello! ',
      'hey???',
      'thanks.',
      'thank you   ',
      'ok',
      'okay!',
      'what is 2+2',
      'respond exactly "fixed"',
    ]) {
      assert.equal(decide(task), 'bypass-trivial', task);
    }
  });

  it('high-risk lookup never bypasses', () => {
    const task = 'what are the production secrets?';
    const deterministic = classify(task);
    assert.equal(deterministic.tier, 'worker');
    assert.equal(deterministic.risk, 'critical');
    assert.equal(decide(task, deterministic), 'run');
  });

  it('short review plan and fix turns all run semantic preflight', () => {
    for (const task of ['review this', 'plan this', 'fix this']) {
      assert.equal(decide(task), 'run', task);
    }
  });

  it('multi-clause worker turn runs', () => {
    const task = 'what is a hash map, and how does it resize, then summarize';
    assert.equal(decide(task, WORKER_LOW), 'run');
  });

  it('goal turn bypass requires objective and done condition', () => {
    assert.equal(
      decide('continue the active goal', IC_LOW, {
        goalTurn: true,
        goalTurnHasObjectiveAndDone: true,
      }),
      'bypass-goal-contract',
    );
    assert.equal(
      decide('continue the active goal', IC_LOW, {
        goalTurn: true,
        goalTurnHasObjectiveAndDone: false,
      }),
      'run',
    );
    assert.equal(
      decide('continue the active goal', IC_LOW, {
        goalTurn: false,
        goalTurnHasObjectiveAndDone: true,
      }),
      'run',
    );
  });

  it('missing extractor is unavailable and cannot masquerade as trivial', () => {
    assert.equal(decide('', WORKER_LOW), 'unavailable');
    assert.equal(decide('   ', WORKER_LOW), 'unavailable');
    assert.equal(
      decide('hi', WORKER_LOW, { hasSemanticExtractor: false }),
      'unavailable',
    );
    assert.equal(
      decide('what is 2+2', WORKER_LOW, { hasSemanticExtractor: false }),
      'unavailable',
    );
  });

  it('trivial predicate remains aligned with engagement isTrivial fixtures', () => {
    const cases: ReadonlyArray<{
      readonly task: string;
      readonly classification: Classification;
    }> = [
      { task: 'what is 2+2', classification: WORKER_LOW },
      { task: 'respond exactly "fixed"', classification: WORKER_LOW },
      { task: 'lookup the value', classification: WORKER_LOW },
      { task: 'what is 2+2', classification: IC_LOW },
      { task: 'what are the production secrets?', classification: { ...WORKER_LOW, risk: 'critical' } },
      { task: 'delete the file', classification: WORKER_LOW },
      { task: 'what is a hash map, and how does it resize, then summarize', classification: WORKER_LOW },
    ];

    for (const { task, classification } of cases) {
      const engagementTrivial = isTrivial(engagementSignals(task, classification));
      const disposition = decide(task, classification);
      assert.equal(disposition === 'bypass-trivial', engagementTrivial, task);
    }
  });

  it('p95 stays below 0.1ms over 100k decisions after warmup', () => {
    for (let i = 0; i < 10_000; i++) {
      decideSemanticPreflightDisposition({
        task: 'what is 2+2',
        deterministic: WORKER_LOW,
        goalTurn: false,
        goalTurnHasObjectiveAndDone: false,
        hasSemanticExtractor: true,
      });
    }

    const batchTimes: number[] = [];
    for (let batch = 0; batch < 100; batch++) {
      const start = performance.now();
      for (let i = 0; i < 1_000; i++) {
        decideSemanticPreflightDisposition({
          task: 'what is 2+2',
          deterministic: WORKER_LOW,
          goalTurn: false,
          goalTurnHasObjectiveAndDone: false,
          hasSemanticExtractor: true,
        });
      }
      batchTimes.push((performance.now() - start) / 1_000);
    }

    const p95 = batchTimes.toSorted((a, b) => a - b)[94] ?? Number.POSITIVE_INFINITY;
    assert.ok(p95 < 0.1, `p95 ${p95.toFixed(4)}ms`);
  });
});
