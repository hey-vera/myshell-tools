import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { GoalBoardRow } from '../../src/interface/ui/state.ts';
import {
  buildGoalsPanelModel,
  nextGoalId,
} from '../../src/interface/ui/goals-panel-model.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function br(
  id: string,
  title: string,
  over: Partial<GoalBoardRow> = {},
): GoalBoardRow {
  return {
    id,
    title,
    state: 'running',
    done: 0,
    total: 3,
    glyph: '▶',
    scope: 'global',
    agents: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildGoalsPanelModel
// ---------------------------------------------------------------------------

describe('buildGoalsPanelModel', () => {
  it('empty board => empty rows, empty goalIds, undefined highlight', () => {
    const model = buildGoalsPanelModel({ board: [] });
    assert.deepStrictEqual(model.rows, []);
    assert.deepStrictEqual(model.goalIds, []);
    assert.strictEqual(model.highlightedGoalId, undefined);
  });

  it('one running goal => one goal row with active=true and correct todoSummary', () => {
    const board: GoalBoardRow[] = [
      br('g1', 'Ship MVP', { state: 'running', done: 2, total: 5 }),
    ];
    const model = buildGoalsPanelModel({ board });
    assert.strictEqual(model.rows.length, 1);
    assert.strictEqual(model.rows[0].kind, 'goal');
    assert.strictEqual(model.rows[0].id, 'g1');
    assert.strictEqual(model.rows[0].goalId, 'g1');
    assert.strictEqual(model.rows[0].depth, 0);
    assert.strictEqual(model.rows[0].active, true);
    assert.strictEqual(model.rows[0].todoSummary, '2/5 to-dos');
    assert.strictEqual(model.rows[0].statusLabel, 'running');
    assert.deepStrictEqual(model.goalIds, ['g1']);
    assert.strictEqual(model.highlightedGoalId, 'g1');
  });

  it('highlighted goal expands its todos as depth-1 rows', () => {
    const board: GoalBoardRow[] = [
      br('g1', 'Alpha', {
        state: 'running',
        done: 1,
        total: 3,
        todos: [
          { id: 't1', text: 'wire up API', status: 'done' },
          { id: 't2', text: 'write docs', status: 'active' },
        ],
      }),
    ];
    const model = buildGoalsPanelModel({ board, highlightedGoalId: 'g1' });
    assert.strictEqual(model.rows.length, 3);
    // goal row
    assert.strictEqual(model.rows[0].kind, 'goal');
    assert.strictEqual(model.rows[0].id, 'g1');
    assert.strictEqual(model.rows[0].depth, 0);
    // todo rows
    assert.strictEqual(model.rows[1].kind, 'todo');
    assert.strictEqual(model.rows[1].id, 't1');
    assert.strictEqual(model.rows[1].goalId, 'g1');
    assert.strictEqual(model.rows[1].depth, 1);
    assert.strictEqual(model.rows[1].title, 'wire up API');
    assert.strictEqual(model.rows[1].statusLabel, 'done');
    assert.strictEqual(model.rows[2].kind, 'todo');
    assert.strictEqual(model.rows[2].id, 't2');
    assert.strictEqual(model.rows[2].goalId, 'g1');
    assert.strictEqual(model.rows[2].depth, 1);
    assert.strictEqual(model.rows[2].statusLabel, 'active');
  });

  it('non-highlighted goals contribute no todo rows', () => {
    const board: GoalBoardRow[] = [
      br('g1', 'Alpha', {
        todos: [{ id: 't1', text: 'x', status: 'pending' }],
      }),
      br('g2', 'Beta', {
        todos: [{ id: 't2', text: 'y', status: 'pending' }],
      }),
    ];
    const model = buildGoalsPanelModel({
      board,
      highlightedGoalId: 'g1',
    });
    // g1 + its 1 todo, g2 (collapsed) = 3 total
    assert.strictEqual(model.rows.length, 3);
    assert.strictEqual(model.rows[0].id, 'g1');
    assert.strictEqual(model.rows[1].kind, 'todo');
    assert.strictEqual(model.rows[1].goalId, 'g1');
    assert.strictEqual(model.rows[2].id, 'g2');
    assert.strictEqual(model.rows[2].kind, 'goal');
    assert.strictEqual(model.highlightedGoalId, 'g1');
  });

  it('effective highlight falls back to first goalId when given id is not in board', () => {
    const board: GoalBoardRow[] = [
      br('g1', 'One'),
      br('g2', 'Two', {
        todos: [{ id: 't2', text: 'task', status: 'pending' }],
      }),
    ];
    const model = buildGoalsPanelModel({
      board,
      highlightedGoalId: 'unknown',
    });
    assert.strictEqual(model.highlightedGoalId, 'g1');
    // g1 is highlighted, not g2 — so no todo rows from g2 appear
    const todoRows = model.rows.filter((r) => r.kind === 'todo');
    assert.strictEqual(todoRows.length, 0);
  });

  it('effective highlight falls back to first goalId when no highlightedGoalId given', () => {
    const board: GoalBoardRow[] = [
      br('g1', 'One'),
      br('g2', 'Two', {
        todos: [{ id: 't2', text: 'task', status: 'pending' }],
      }),
    ];
    const model = buildGoalsPanelModel({ board });
    assert.strictEqual(model.highlightedGoalId, 'g1');
    // g1 has no todos, so only goal rows appear
    assert.strictEqual(model.rows.length, 2);
    assert.strictEqual(model.rows[0].kind, 'goal');
    assert.strictEqual(model.rows[1].kind, 'goal');
  });

  it('board with no todos at all => only goal rows, todoSummary present', () => {
    const board: GoalBoardRow[] = [
      br('g1', 'One', { state: 'done', done: 3, total: 3 }),
      br('g2', 'Two', { state: 'queued', done: 0, total: 4 }),
    ];
    const model = buildGoalsPanelModel({ board, highlightedGoalId: 'g1' });
    assert.strictEqual(model.rows.length, 2);
    assert.strictEqual(model.rows[0].todoSummary, '3/3 to-dos');
    assert.strictEqual(model.rows[0].statusLabel, 'done');
    assert.strictEqual(model.rows[0].active, false);
    assert.strictEqual(model.rows[1].todoSummary, '0/4 to-dos');
    assert.strictEqual(model.rows[1].statusLabel, 'queued');
  });
});

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
