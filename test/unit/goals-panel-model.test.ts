import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { nextGoalId } from '../../src/interface/ui/goals-panel-model.ts';

// ---------------------------------------------------------------------------
// nextGoalId
// ---------------------------------------------------------------------------

describe('nextGoalId', () => {
  it('empty goalIds => undefined', () => {
    assert.strictEqual(
      nextGoalId({ goalIds: [], currentGoalId: undefined, direction: 'down' }),
      undefined,
    );
    assert.strictEqual(
      nextGoalId({ goalIds: [], currentGoalId: 'g1', direction: 'up' }),
      undefined,
    );
  });

  it('undefined current => first (down) / last (up)', () => {
    const ids = ['a', 'b', 'c'];
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: undefined, direction: 'down' }),
      'a',
    );
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: undefined, direction: 'up' }),
      'c',
    );
  });

  it('down wraps from last to first', () => {
    const ids = ['a', 'b', 'c'];
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'c', direction: 'down' }),
      'a',
    );
  });

  it('up wraps from first to last', () => {
    const ids = ['a', 'b', 'c'];
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'a', direction: 'up' }),
      'c',
    );
  });

  it('normal down / up in middle', () => {
    const ids = ['a', 'b', 'c'];
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'b', direction: 'down' }),
      'c',
    );
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'b', direction: 'up' }),
      'a',
    );
  });

  it('unknown currentGoalId => first (down) / last (up)', () => {
    const ids = ['a', 'b', 'c'];
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'unknown', direction: 'down' }),
      'a',
    );
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'unknown', direction: 'up' }),
      'c',
    );
  });

  it('single-item list wraps to itself', () => {
    const ids = ['only'];
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'only', direction: 'down' }),
      'only',
    );
    assert.strictEqual(
      nextGoalId({ goalIds: ids, currentGoalId: 'only', direction: 'up' }),
      'only',
    );
  });
});
