/**
 * Unit tests for src/core/goal-manager.ts — the PURE decision core of the
 * per-goal manager cycle (elite-partner Part 7). All pure/table-tested: no I/O,
 * no clock, no randomness. The honesty boundary (a to-do is verified-done ONLY
 * with a real verdict.state ∈ {passing,reviewed}) is exercised directly, and the
 * fix-it spawn is checked to be BOUNDED (it stops at the cap).
 *
 * Run with: node --import ./test/register.mjs --test "test/unit/goal-manager.test.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickNextTodo,
  managerCycleComplete,
  buildTodoTask,
  fixItTodo,
  fixItDepth,
  isTodoVerifiedDone,
  FIX_IT_MAX_DEPTH,
} from '../../src/core/goal-manager.ts';
import type { RoadmapItem, RoadmapItemVerdict } from '../../src/core/work-contract.ts';

function verdict(state: RoadmapItemVerdict['state']): RoadmapItemVerdict {
  return { state, receipt: `receipt:${state}`, at: '2026-06-10T00:00:00.000Z' };
}

function item(partial: Partial<RoadmapItem> & { id: string }): RoadmapItem {
  return { text: `todo ${partial.id}`, status: 'pending', ...partial };
}

describe('isTodoVerifiedDone — the honesty bar', () => {
  it('true ONLY for passing/reviewed verdicts', () => {
    assert.equal(isTodoVerifiedDone(item({ id: 'a', verdict: verdict('passing') })), true);
    assert.equal(isTodoVerifiedDone(item({ id: 'b', verdict: verdict('reviewed') })), true);
  });
  it('false for failing/unverified and for NO verdict (status alone never qualifies)', () => {
    assert.equal(isTodoVerifiedDone(item({ id: 'a', verdict: verdict('failing') })), false);
    assert.equal(isTodoVerifiedDone(item({ id: 'b', verdict: verdict('unverified') })), false);
    assert.equal(isTodoVerifiedDone(item({ id: 'c' })), false);
    // A `done` status with NO verdict is NOT verified-done (no fake green).
    assert.equal(isTodoVerifiedDone(item({ id: 'd', status: 'done' })), false);
  });
});

describe('pickNextTodo', () => {
  it('returns the first non-verified, non-blocked item in roadmap order', () => {
    const roadmap = [
      item({ id: 'r1', verdict: verdict('passing') }),
      item({ id: 'r2' }),
      item({ id: 'r3' }),
    ];
    assert.equal(pickNextTodo(roadmap)?.id, 'r2');
  });

  it('skips verified-done items', () => {
    const roadmap = [
      item({ id: 'r1', verdict: verdict('passing') }),
      item({ id: 'r2', verdict: verdict('reviewed') }),
      item({ id: 'r3' }),
    ];
    assert.equal(pickNextTodo(roadmap)?.id, 'r3');
  });

  it('returns null when every item is verified-done', () => {
    const roadmap = [
      item({ id: 'r1', verdict: verdict('passing') }),
      item({ id: 'r2', verdict: verdict('reviewed') }),
    ];
    assert.equal(pickNextTodo(roadmap), null);
  });

  it('skips blocked items (need input, not worker-actionable) → null when only blocked left', () => {
    const roadmap = [
      item({ id: 'r1', verdict: verdict('passing') }),
      item({ id: 'r2', status: 'blocked' }),
    ];
    assert.equal(pickNextTodo(roadmap), null);
  });

  it('returns null for an empty roadmap', () => {
    assert.equal(pickNextTodo([]), null);
  });
});

describe('managerCycleComplete', () => {
  it('true when every item is verified-done (passing or reviewed)', () => {
    assert.equal(
      managerCycleComplete({
        roadmap: [
          item({ id: 'r1', verdict: verdict('passing') }),
          item({ id: 'r2', verdict: verdict('reviewed') }),
        ],
      }),
      true,
    );
  });

  it('false when ONE item is unverified', () => {
    assert.equal(
      managerCycleComplete({
        roadmap: [
          item({ id: 'r1', verdict: verdict('passing') }),
          item({ id: 'r2', verdict: verdict('unverified') }),
        ],
      }),
      false,
    );
  });

  it('false when one item has no verdict at all', () => {
    assert.equal(
      managerCycleComplete({
        roadmap: [item({ id: 'r1', verdict: verdict('passing') }), item({ id: 'r2' })],
      }),
      false,
    );
  });

  it('false for an empty roadmap (nothing verified ⇒ not complete)', () => {
    assert.equal(managerCycleComplete({ roadmap: [] }), false);
  });
});

describe('buildTodoTask', () => {
  it('scopes the task to ONE to-do and includes its acceptanceCriterion', () => {
    const task = buildTodoTask(
      { title: 'Ship the feed redesign', goalAcceptance: 'feed loads <100ms' },
      item({ id: 'r1', text: 'add the pagination cursor', acceptanceCriterion: 'cursor paginates 50/page' }),
    );
    assert.match(task, /Ship the feed redesign/);
    assert.match(task, /add the pagination cursor/);
    assert.match(task, /cursor paginates 50\/page/);
    assert.match(task, /feed loads <100ms/);
    // It must tell the worker to do EXACTLY this to-do, not the whole goal.
    assert.match(task, /ONE to-do at a time/);
    // It must NOT promise the worker's word marks it done.
    assert.match(task, /verification/);
  });

  it('degrades gracefully with no criterion / no vision (still coherent)', () => {
    const task = buildTodoTask({ title: 'Goal X' }, item({ id: 'r1', text: 'do the thing' }));
    assert.match(task, /Goal X/);
    assert.match(task, /do the thing/);
    assert.doesNotThrow(() => task.length);
  });
});

describe('fixItTodo — bounded self-heal', () => {
  it('spawns a pending fix-it carrying the failure note + original criterion', () => {
    const failed = item({
      id: 'r1',
      text: 'wire the endpoint',
      acceptanceCriterion: 'returns 200',
    });
    const fix = fixItTodo(failed, 'tests red: 2 failing');
    assert.notEqual(fix, null);
    assert.equal(fix?.status, 'pending');
    assert.match(fix!.text, /Fix:/);
    assert.match(fix!.text, /wire the endpoint/);
    assert.match(fix!.text, /tests red/);
    assert.equal(fix?.acceptanceCriterion, 'returns 200');
    // The fix-it must NOT carry a verdict (it is fresh, unverified work).
    assert.equal(fix?.verdict, undefined);
  });

  it('increments fix-it depth deterministically (r1 → r1-fix1 → r1-fix2)', () => {
    const f1 = fixItTodo(item({ id: 'r1', text: 'x' }), 'fail');
    assert.equal(f1?.id, 'r1-fix1');
    assert.equal(fixItDepth(f1!), 1);
    const f2 = fixItTodo(f1!, 'fail again');
    assert.equal(f2?.id, 'r1-fix2');
    assert.equal(fixItDepth(f2!), 2);
  });

  it('returns null at the cap (bounded — no infinite fix-of-a-fix)', () => {
    let cur: RoadmapItem | null = item({ id: 'r1', text: 'x' });
    let spawns = 0;
    while (cur !== null) {
      const next: RoadmapItem | null = fixItTodo(cur, 'fail');
      if (next === null) break;
      spawns += 1;
      cur = next;
    }
    assert.equal(spawns, FIX_IT_MAX_DEPTH);
    // One more attempt on a capped item is null.
    assert.equal(fixItTodo({ id: `r1-fix${String(FIX_IT_MAX_DEPTH)}`, text: 'x', status: 'pending' }, 'fail'), null);
  });

  it('fixItDepth of a fresh to-do is 0', () => {
    assert.equal(fixItDepth(item({ id: 'r1' })), 0);
    assert.equal(fixItDepth({ id: 'anything' }), 0);
  });
});
