/**
 * test/unit/menu-goal-review.test.ts — unit tests for the goal-review prompt
 * presenter in src/interface/menu-goal-review.ts.
 *
 * Run with: node --import ./test/register.mjs --test "test/unit/menu-goal-review.test.ts"
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import type { GoalFinding } from '../../src/core/goal-steward.ts';
import {
  renderGoalReviewPrompt,
  ageDays,
} from '../../src/interface/menu-goal-review.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function f(overrides: Partial<GoalFinding> = {}): GoalFinding {
  return {
    goalId: 'goal_test',
    conversationId: 'conv_test',
    state: 'parked',
    classification: 'stale',
    recommendedAction: 'review',
    reason: 'Goal is parked and untouched for 42 days — may be outdated',
    ...overrides,
  };
}

const NOW_MS = new Date('2026-07-15T00:00:00.000Z').getTime();
const TOUCHED_42D_AGO = '2026-06-03T00:00:00.000Z';
// Sanity: the fixture timestamp is ~42 days before NOW_MS.
assert.equal(ageDays(TOUCHED_42D_AGO, NOW_MS), 42);

// ---------------------------------------------------------------------------
// ageDays
// ---------------------------------------------------------------------------

describe('ageDays', () => {
  it('computes whole days since lastTouched', () => {
    assert.equal(ageDays('2026-07-14T00:00:00.000Z', NOW_MS), 1);
  });

  it('returns 0 for a future date', () => {
    assert.equal(ageDays('2026-07-16T00:00:00.000Z', NOW_MS), 0);
  });

  it('returns 0 for unparseable input', () => {
    assert.equal(ageDays('not-a-date', NOW_MS), 0);
  });

  it('returns 0 when nowMs <= lastTouched', () => {
    const t = Date.parse('2026-07-15T00:00:00.000Z');
    assert.equal(ageDays('2026-07-15T00:00:00.000Z', t), 0);
  });
});

// ---------------------------------------------------------------------------
// inactive / running stale
// ---------------------------------------------------------------------------

describe('renderGoalReviewPrompt — inactive (running/queued stale)', () => {
  it('renders resume / ask / dismiss / cancel for running inactive', () => {
    const finding = f({
      classification: 'inactive',
      state: 'running',
      reason: 'Goal is running and untouched for 24 days',
    });
    const result = renderGoalReviewPrompt(finding, 'Menu IA redesign', 24);
    assert.ok(result.prompt.includes('[r] Resume'), 'shows resume key');
    assert.ok(result.prompt.includes('[a] Ask what changed'), 'shows ask key');
    assert.ok(result.prompt.includes('[d] Dismiss for now'), 'shows dismiss key');
    assert.ok(result.prompt.includes('[x] Cancel goal'), 'shows cancel key');
    assert.ok(result.prompt.includes('running, inactive'), 'shows state label');
    assert.ok(result.prompt.includes('Menu IA redesign'), 'shows goal title');
    assert.ok(result.prompt.includes('24d ago'), 'shows age');
    assert.deepStrictEqual(result.validKeys, ['r', 'a', 'd', 'x']);
    assert.equal(result.isTextInput, false);
  });

  it('renders queued label for queued inactive', () => {
    const finding = f({
      classification: 'inactive',
      state: 'queued',
      reason: 'Goal is queued and untouched for 24 days',
    });
    const result = renderGoalReviewPrompt(finding, 'Queued task', 24);
    assert.ok(result.prompt.includes('queued, inactive'), 'shows queued label');
  });

  it('omits age suffix when 0 days', () => {
    const finding = f({
      classification: 'inactive',
      state: 'running',
      reason: 'fresh',
    });
    const result = renderGoalReviewPrompt(finding, 'Fresh goal', 0);
    assert.ok(!result.prompt.includes('since'), 'no age suffix for 0 days');
    assert.ok(result.prompt.includes('[r] Resume'), 'still shows actions');
  });
});

// ---------------------------------------------------------------------------
// stale (parked)
// ---------------------------------------------------------------------------

describe('renderGoalReviewPrompt — stale (parked)', () => {
  it('renders resume / update / cancel / Enter for parked stale', () => {
    const finding = f({
      classification: 'stale',
      state: 'parked',
      reason: 'Goal is parked and untouched for 42 days — may be outdated',
    });
    const result = renderGoalReviewPrompt(finding, 'OpenCode setup cleanup', 42);
    assert.ok(result.prompt.includes('[r] Resume it'), 'shows resume key');
    assert.ok(result.prompt.includes('[u] Update the goal first'), 'shows update key');
    assert.ok(result.prompt.includes('[x] Cancel it'), 'shows cancel key');
    assert.ok(result.prompt.includes('parked for 42 days'), 'shows age');
    assert.ok(result.prompt.includes('OpenCode setup cleanup'), 'shows goal title');
    assert.deepStrictEqual(result.validKeys, ['r', 'u', 'x', '']);
    assert.equal(result.isTextInput, false);
  });

  it('uses correct age in wording', () => {
    const finding = f({ classification: 'stale', state: 'parked' });
    const result = renderGoalReviewPrompt(finding, 'Test', 7);
    assert.ok(result.prompt.includes('parked for 7 days'), 'age in days');
  });
});

// ---------------------------------------------------------------------------
// blocked
// ---------------------------------------------------------------------------

describe('renderGoalReviewPrompt — blocked', () => {
  it('renders blocked prompt with reason and Enter to skip', () => {
    const finding = f({
      classification: 'blocked',
      state: 'blocked',
      reason: 'Goal is blocked — requires unblock or cancellation',
    });
    const result = renderGoalReviewPrompt(finding, 'Harden auth refresh', 0);
    assert.ok(result.prompt.includes('Goal needs input'), 'shows header');
    assert.ok(result.prompt.includes('is blocked'), 'shows blocked status');
    assert.ok(result.prompt.includes('requires unblock'), 'shows reason');
    assert.ok(result.prompt.includes('press Enter to skip'), 'shows skip hint');
    assert.ok(result.prompt.includes('Harden auth refresh'), 'shows goal title');
    assert.deepStrictEqual(result.validKeys, ['']);
    assert.equal(result.isTextInput, true);
  });
});

// ---------------------------------------------------------------------------
// verified-complete (resolve-done)
// ---------------------------------------------------------------------------

describe('renderGoalReviewPrompt — verified-complete (resolve-done)', () => {
  it('renders y/n confirm for verified complete', () => {
    const finding = f({
      classification: 'verified-complete',
      state: 'done',
      recommendedAction: 'resolve-done',
      reason: 'Goal is verified complete (verdict: passing) — safe to mark done',
    });
    const result = renderGoalReviewPrompt(finding, 'Auth module', 0);
    assert.ok(result.prompt.includes('verified complete'), 'shows verified-complete');
    assert.ok(result.prompt.includes('(y/n)'), 'shows y/n confirm');
    assert.deepStrictEqual(result.validKeys, ['y', 'n']);
    assert.equal(result.isTextInput, false);
  });

  it('renders review prompt for done-but-unverified', () => {
    const finding = f({
      classification: 'verified-complete',
      state: 'done',
      recommendedAction: 'review',
      reason: 'Goal is done but lacks a verified verdict',
    });
    const result = renderGoalReviewPrompt(finding, 'Unverified task', 0);
    assert.ok(result.prompt.includes('done but not verified'), 'shows not-verified note');
    assert.ok(result.prompt.includes('[r] Review'), 'shows review key');
    assert.ok(result.prompt.includes('[d] Dismiss'), 'shows dismiss key');
    assert.ok(result.prompt.includes('[x] Cancel goal'), 'shows cancel key');
    assert.deepStrictEqual(result.validKeys, ['r', 'd', 'x']);
  });
});

// ---------------------------------------------------------------------------
// fresh (edge case — should never surface)
// ---------------------------------------------------------------------------

describe('renderGoalReviewPrompt — fresh (edge case)', () => {
  it('returns empty prompt for fresh finding', () => {
    const finding = f({ classification: 'fresh', recommendedAction: 'none' });
    const result = renderGoalReviewPrompt(finding, 'Fresh goal', 0);
    assert.equal(result.prompt, '');
    assert.deepStrictEqual(result.validKeys, []);
    assert.equal(result.isTextInput, false);
  });
});
