/**
 * test/unit/goal.test.ts — the pure `/goal` decision core (core/goal.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoalTask,
  parseTrailingGoalMarker,
  stripTrailingGoalMarker,
  parseGoalSignal,
  stripTrailingGoalConfidenceEnvelope,
  parseGoalContinueText,
  decideGoalNext,
  formatGoalProgress,
  DEFAULT_MAX_GOAL_ITERATIONS,
} from '../../src/core/goal.ts';

describe('buildGoalTask', () => {
  it('preserves the byte-identical prompt when no contract is provided', () => {
    assert.equal(
      buildGoalTask('ship the login page', 0),
      [
        'Goal: ship the login page',
        '',
        'You are working across multiple autonomous turns. Take the next concrete step',
        'now (read, edit, run — whatever actually moves the goal forward). Then, on its',
        'own line, signal status:',
        '  • write exactly "GOAL_COMPLETE" when the goal is FULLY achieved and verified;',
        '  • otherwise write "GOAL_CONTINUE: <the single next step>".',
        'Only claim completion when it is genuinely done — do not stop early, and do not',
        'claim completion just to end the loop.',
      ].join('\n'),
    );
  });

  it('frames the goal on the first turn and asks to continue after', () => {
    const first = buildGoalTask('ship the login page', 0);
    assert.ok(first.startsWith('Goal: ship the login page'));
    const later = buildGoalTask('ship the login page', 3);
    assert.ok(/Continue working autonomously/.test(later));
    assert.ok(later.includes('ship the login page'));
  });

  it('always instructs the completion + continue markers', () => {
    const t = buildGoalTask('x', 0);
    assert.ok(t.includes('GOAL_COMPLETE'));
    assert.ok(t.includes('GOAL_CONTINUE'));
  });

  it('prepends the contract and keeps goal-marker instructions intact', () => {
    const t = buildGoalTask(
      'ship the login page',
      1,
      {
        version: 1,
        objective: 'ship the login page',
        checkpoints: [{ id: 'C1', summary: 'implemented the form' }],
      },
    );

    assert.ok(t.startsWith('OBJECTIVE: ship the login page'));
    assert.ok(t.includes("RECENT STEPS (each turn's stated next action):\n- C1: implemented the form"));
    assert.ok(
      t.includes('Before acting, confirm this turn still directly serves the OBJECTIVE; do not pursue unrelated improvements.'),
    );
    assert.ok(t.includes('own line, signal status:'));
    assert.ok(t.includes('  • write exactly "GOAL_COMPLETE" when the goal is FULLY achieved and verified;'));
    assert.ok(t.includes('  • otherwise write "GOAL_CONTINUE: <the single next step>".'));
    assert.ok(t.endsWith('claim completion just to end the loop.'));
  });
});

describe('parseTrailingGoalMarker / stripTrailingGoalMarker', () => {
  it('parses a trailing GOAL_COMPLETE marker', () => {
    assert.equal(parseTrailingGoalMarker('All done.\nGOAL_COMPLETE'), 'complete');
  });

  it('parses a trailing GOAL_CONTINUE marker with a next step', () => {
    assert.equal(parseTrailingGoalMarker('Did step 1.\nGOAL_CONTINUE: write the tests'), 'continue');
  });

  it('ignores a marker that is not on the last non-empty line', () => {
    assert.equal(parseTrailingGoalMarker('GOAL_COMPLETE\nBut this is the real ending.'), null);
  });

  it('ignores prose that merely mentions GOAL_COMPLETE mid-text', () => {
    assert.equal(parseTrailingGoalMarker('Do not write GOAL_COMPLETE in prose.\nStill working.'), null);
  });

  it('strips only a trailing marker line', () => {
    assert.equal(
      stripTrailingGoalMarker('Mention GOAL_COMPLETE safely.\nDone.\nGOAL_COMPLETE'),
      'Mention GOAL_COMPLETE safely.\nDone.',
    );
    assert.equal(
      stripTrailingGoalMarker('GOAL_COMPLETE\nBut this is prose.'),
      'GOAL_COMPLETE\nBut this is prose.',
    );
  });
});

describe('parseGoalSignal', () => {
  it('returns the trailing marker signal when present', () => {
    assert.equal(parseGoalSignal('All done.\nGOAL_COMPLETE'), 'complete');
    assert.equal(parseGoalSignal('Did step 1.\nGOAL_CONTINUE: write the tests'), 'continue');
  });

  it('"missing" when no valid trailing marker is present', () => {
    assert.equal(parseGoalSignal('I made some changes.'), 'missing');
    assert.equal(parseGoalSignal(''), 'missing');
    assert.equal(parseGoalSignal('GOAL_CONTINUE: more\n...later...\nfinished without marker'), 'missing');
  });
});

describe('stripTrailingGoalConfidenceEnvelope', () => {
  it('lets goal-loop control parse a marker before a stale confidence envelope', () => {
    const output =
      'Did step 1.\nGOAL_CONTINUE: write the tests\n{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false}';
    const normalized = stripTrailingGoalConfidenceEnvelope(output);

    assert.equal(parseGoalSignal(normalized), 'continue');
    assert.equal(parseGoalContinueText(normalized), 'write the tests');
  });

  it('does not make parseGoalSignal itself scan past the last line', () => {
    const output =
      'Did step 1.\nGOAL_CONTINUE: write the tests\n{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false}';

    assert.equal(parseGoalSignal(output), 'missing');
  });
});

describe('parseGoalContinueText', () => {
  it('returns the trailing GOAL_CONTINUE next-step text', () => {
    assert.equal(
      parseGoalContinueText('Did step 1.\nGOAL_CONTINUE: write the tests'),
      'write the tests',
    );
  });

  it('returns empty string unless the trusted trailing marker is GOAL_CONTINUE', () => {
    assert.equal(parseGoalContinueText('All done.\nGOAL_COMPLETE'), '');
    assert.equal(parseGoalContinueText('GOAL_CONTINUE: more\nnot a marker'), '');
    assert.equal(parseGoalContinueText('GOAL_CONTINUE:'), '');
  });
});

describe('decideGoalNext', () => {
  const ceilings = { maxIterations: 8, maxCostUsd: 2 };

  it('stops on a failed turn', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: false, completedIterations: 1, ceilings, costSoFarUsd: 0 });
    assert.equal(s.action, 'stop-error');
  });

  it('completes when the model signals complete', () => {
    const s = decideGoalNext({ signal: 'complete', lastSucceeded: true, completedIterations: 2, ceilings, costSoFarUsd: 0.5 });
    assert.equal(s.action, 'complete');
  });

  it('stops on the cost ceiling before another turn', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: true, completedIterations: 2, ceilings, costSoFarUsd: 2.5 });
    assert.equal(s.action, 'stop-budget');
  });

  it('stops honestly when the marker is missing or invalid', () => {
    const s = decideGoalNext({ signal: 'missing', lastSucceeded: true, completedIterations: 2, ceilings, costSoFarUsd: 0.1 });
    assert.equal(s.action, 'stop-signal');
    assert.match(s.reason, /no goal signal/);
  });

  it('stops on the iteration ceiling', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: true, completedIterations: 8, ceilings, costSoFarUsd: 0.1 });
    assert.equal(s.action, 'stop-iterations');
  });

  it('continues when work remains and ceilings are not hit', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: true, completedIterations: 3, ceilings, costSoFarUsd: 0.1 });
    assert.equal(s.action, 'continue');
  });

  it('cost ceiling is optional (no cap → never stop-budget)', () => {
    const s = decideGoalNext({
      signal: 'continue',
      lastSucceeded: true,
      completedIterations: 3,
      ceilings: { maxIterations: 8 },
      costSoFarUsd: 999,
    });
    assert.equal(s.action, 'continue');
  });

  it('exposes a sane default iteration ceiling', () => {
    assert.ok(DEFAULT_MAX_GOAL_ITERATIONS >= 3 && DEFAULT_MAX_GOAL_ITERATIONS <= 25);
  });
});

describe('formatGoalProgress', () => {
  it('shows turn, elapsed (seconds), and tokens', () => {
    assert.equal(
      formatGoalProgress({ turn: 1, maxTurns: 8, elapsedMs: 12_000, tokensThisRun: 0 }),
      'turn 1/8 · 12s · 0 tokens this goal',
    );
  });

  it('formats minutes+seconds and k tokens', () => {
    assert.equal(
      formatGoalProgress({ turn: 3, maxTurns: 8, elapsedMs: 372_000, tokensThisRun: 42_100 }),
      'turn 3/8 · 6m 12s · 42.1k tokens this goal',
    );
  });

  it('formats whole minutes (no trailing seconds) and hours', () => {
    assert.equal(
      formatGoalProgress({ turn: 2, maxTurns: 5, elapsedMs: 120_000, tokensThisRun: 1_500_000 }),
      'turn 2/5 · 2m · 1.5M tokens this goal',
    );
    assert.equal(
      formatGoalProgress({ turn: 9, maxTurns: 9, elapsedMs: 3_660_000, tokensThisRun: 500 }),
      'turn 9/9 · 1h 1m · 500 tokens this goal',
    );
  });

  it('never produces negative figures', () => {
    assert.equal(
      formatGoalProgress({ turn: 1, maxTurns: 1, elapsedMs: -5, tokensThisRun: -10 }),
      'turn 1/1 · 0s · 0 tokens this goal',
    );
  });
});
