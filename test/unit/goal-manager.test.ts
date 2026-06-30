/**
 * Unit tests for src/core/goal-manager.ts — the PURE decision core of the
 * per-goal manager cycle (elite-partner Part 7). All pure/table-tested: no I/O,
 * no clock, no randomness. The honesty boundary (a to-do is verified-done ONLY
 * with a real verdict.state ∈ {passing,reviewed}) is exercised directly, and the
 * fix-it spawn is checked to be BOUNDED (it stops at the cap).
 *
 * Run with: node --import ./test/register.mjs --test "test/unit/goal-manager.test.ts"
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  pickNextTodo,
  pickReadyTodos,
  managerCycleComplete,
  buildTodoTask,
  fixItTodo,
  fixItDepth,
  isTodoVerifiedDone,
  itemBlockReason,
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

// ---------------------------------------------------------------------------
// Dependency-aware pick + grouping (additive; strict superset of linear march)
// ---------------------------------------------------------------------------

describe('pickNextTodo — dependency-aware (additive)', () => {
  it('with no dependsOn/parentId behaves EXACTLY as the linear march', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'one', status: 'done', verdict: verdict('passing') },
      { id: 'r2', text: 'two', status: 'pending' },
      { id: 'r3', text: 'three', status: 'pending' },
    ];
    assert.equal(pickNextTodo(roadmap)?.id, 'r2');
  });

  it('skips an item whose dependency is not yet verified-done', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'build module', status: 'pending' },
      { id: 'r2', text: 'wire module', status: 'pending', dependsOn: ['r1'] },
    ];
    // r1 is unblocked → picked first; r2 waits on r1.
    assert.equal(pickNextTodo(roadmap)?.id, 'r1');
  });

  it('picks the dependent once its blocker is verified-done', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'build', status: 'done', verdict: verdict('passing') },
      { id: 'r2', text: 'wire', status: 'pending', dependsOn: ['r1'] },
    ];
    assert.equal(pickNextTodo(roadmap)?.id, 'r2');
  });

  it('a dependent with an UNSATISFIED dep is skipped in favor of a later ready item', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'wire', status: 'pending', dependsOn: ['r3'] },
      { id: 'r3', text: 'build', status: 'pending' },
    ];
    // r1 blocks on r3 (not done) → skip; r3 is ready → picked.
    assert.equal(pickNextTodo(roadmap)?.id, 'r3');
  });

  it('a dangling dep id (no matching sibling) keeps the item blocked', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'wire', status: 'pending', dependsOn: ['ghost'] },
    ];
    assert.equal(pickNextTodo(roadmap), null);
  });

  it('skips a pure parent header (rollup-only, never worked directly)', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'p1', text: 'Group: backend', status: 'pending' },
      { id: 'c1', text: 'child', status: 'pending', parentId: 'p1' },
    ];
    // p1 is a header (c1 names it) → skipped; c1 is the first real actionable item.
    assert.equal(pickNextTodo(roadmap)?.id, 'c1');
  });
});

describe('pickReadyTodos', () => {
  it('returns ALL currently-unblocked actionable items in order', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'a', status: 'pending' },
      { id: 'r2', text: 'b', status: 'pending', dependsOn: ['r1'] },
      { id: 'r3', text: 'c', status: 'pending' },
    ];
    // r1 + r3 are ready; r2 waits on r1.
    assert.deepEqual(pickReadyTodos(roadmap).map((i) => i.id), ['r1', 'r3']);
  });

  it('excludes verified-done, blocked, parent-headers, and dep-blocked items', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'done', status: 'done', verdict: verdict('passing') },
      { id: 'r2', text: 'blocked', status: 'blocked' },
      { id: 'p1', text: 'header', status: 'pending' },
      { id: 'c1', text: 'child', status: 'pending', parentId: 'p1', dependsOn: ['r2'] },
      { id: 'r5', text: 'ready', status: 'pending' },
    ];
    assert.deepEqual(pickReadyTodos(roadmap).map((i) => i.id), ['r5']);
  });

  it('with no structure returns every not-done, not-blocked item (the whole plan)', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'r1', text: 'a', status: 'pending' },
      { id: 'r2', text: 'b', status: 'active' },
    ];
    assert.deepEqual(pickReadyTodos(roadmap).map((i) => i.id), ['r1', 'r2']);
  });
});

describe('managerCycleComplete — parent rollup (computed, never fabricated)', () => {
  it('a header is done iff all its children are verified-done', () => {
    const incomplete: RoadmapItem[] = [
      { id: 'p1', text: 'header', status: 'pending' },
      { id: 'c1', text: 'child a', status: 'done', verdict: verdict('passing') },
      { id: 'c2', text: 'child b', status: 'pending', parentId: 'p1' },
    ];
    // c2 has parentId p1 → p1 is a header; c1 has no parentId so it is a normal item.
    // c2 not verified → not complete.
    assert.equal(managerCycleComplete({ roadmap: incomplete }), false);

    const complete: RoadmapItem[] = [
      { id: 'p1', text: 'header', status: 'pending' }, // header carries NO verdict
      { id: 'c1', text: 'child a', status: 'done', verdict: verdict('passing'), parentId: 'p1' },
      { id: 'c2', text: 'child b', status: 'done', verdict: verdict('reviewed'), parentId: 'p1' },
    ];
    // both children verified; the header rolls up done WITHOUT a fabricated verdict.
    assert.equal(managerCycleComplete({ roadmap: complete }), true);
  });

  it('a header with an unverified child is NOT complete', () => {
    const roadmap: RoadmapItem[] = [
      { id: 'p1', text: 'header', status: 'pending' },
      { id: 'c1', text: 'child', status: 'pending', parentId: 'p1' },
    ];
    assert.equal(managerCycleComplete({ roadmap }), false);
  });
});

describe('fixItTodo — dependency blocking edge case', () => {
  it('a fix-it leaves X unverified, so anything depending on X stays blocked', () => {
    const failed: RoadmapItem = { id: 'r1', text: 'build', status: 'pending' };
    const fix = fixItTodo(failed, 'tests red');
    assert.notEqual(fix, null);
    // The roadmap after the fix-it spawns: r1 still unverified, fix pending, r2 depends on r1.
    const roadmap: RoadmapItem[] = [
      { ...failed }, // still no verdict → not verified-done
      fix as RoadmapItem,
      { id: 'r2', text: 'wire', status: 'pending', dependsOn: ['r1'] },
    ];
    // The fix-it (r1-fix1) is ready (no deps); r2 stays blocked on the unverified r1.
    const next = pickNextTodo(roadmap);
    assert.equal(next?.id, 'r1');
    assert.ok(!isTodoVerifiedDone(roadmap[0] as RoadmapItem));
    // r2 must NOT be ready (it depends on the still-unverified r1).
    assert.equal(pickReadyTodos(roadmap).some((i) => i.id === 'r2'), false);
  });
});

describe('itemBlockReason — why an item is blocked (pure, existing fields only)', () => {
  function byIdOf(roadmap: readonly RoadmapItem[]): ReadonlyMap<string, RoadmapItem> {
    return new Map(roadmap.map((it) => [it.id, it]));
  }

  it('returns null for a plain actionable item (no deps, not blocked)', () => {
    const roadmap = [item({ id: 'r1' })];
    assert.equal(itemBlockReason(roadmap[0] as RoadmapItem, byIdOf(roadmap)), null);
  });

  it('returns null for a done/verified item too (not blocked)', () => {
    const roadmap = [item({ id: 'r1', status: 'done', verdict: verdict('passing') })];
    assert.equal(itemBlockReason(roadmap[0] as RoadmapItem, byIdOf(roadmap)), null);
  });

  it("'dependency' when a dependsOn target is not yet verified-done", () => {
    const roadmap = [
      item({ id: 'r1' }), // unverified blocker
      item({ id: 'r2', dependsOn: ['r1'] }),
    ];
    assert.equal(itemBlockReason(roadmap[1] as RoadmapItem, byIdOf(roadmap)), 'dependency');
  });

  it("'dependency' for a dangling dep id (can never satisfy)", () => {
    const roadmap = [item({ id: 'r2', dependsOn: ['missing'] })];
    assert.equal(itemBlockReason(roadmap[0] as RoadmapItem, byIdOf(roadmap)), 'dependency');
  });

  it('dependency dominates even when the item is also status blocked', () => {
    const roadmap = [
      item({ id: 'r1' }), // unverified blocker
      item({ id: 'r2', status: 'blocked', text: 'Clarify: which db?', dependsOn: ['r1'] }),
    ];
    assert.equal(itemBlockReason(roadmap[1] as RoadmapItem, byIdOf(roadmap)), 'dependency');
  });

  it('null once the dependency becomes verified-done (and item not blocked)', () => {
    const roadmap = [
      item({ id: 'r1', status: 'done', verdict: verdict('passing') }),
      item({ id: 'r2', dependsOn: ['r1'] }),
    ];
    assert.equal(itemBlockReason(roadmap[1] as RoadmapItem, byIdOf(roadmap)), null);
  });

  it("'clarify' for a blocked item carrying the Clarify: marker (owner answer needed)", () => {
    const roadmap = [item({ id: 'r1', status: 'blocked', text: 'Clarify: which auth provider?' })];
    assert.equal(itemBlockReason(roadmap[0] as RoadmapItem, byIdOf(roadmap)), 'clarify');
  });

  it("'unverifiable' for a blocked fix-it item with no clarify marker (self-heal exhausted)", () => {
    const roadmap = [
      item({ id: 'r1-fix2', status: 'blocked', text: 'Fix: build — tests red' }),
    ];
    assert.equal(itemBlockReason(roadmap[0] as RoadmapItem, byIdOf(roadmap)), 'unverifiable');
  });

  it("'unverifiable' is the catch-all for a plain blocked item (never null)", () => {
    const roadmap = [item({ id: 'r1', status: 'blocked' })];
    assert.equal(itemBlockReason(roadmap[0] as RoadmapItem, byIdOf(roadmap)), 'unverifiable');
  });
});
