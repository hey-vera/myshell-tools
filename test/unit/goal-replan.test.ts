/**
 * test/unit/goal-replan.test.ts — the PURE core of AUTOMATIC LIVING-PLAN
 * MAINTENANCE (src/core/goal-replan.ts). All pure/table-tested: no I/O, no clock,
 * no randomness.
 *
 * Covers:
 *   - buildReplanprompt: grounded vs ungrounded, verified-done items flagged.
 *   - parseReplanEdits: well-formed → edits, garbage → null, caps, never throws.
 *   - applyReplanEdits: add / edit / reorder / prune semantics + the HONESTY
 *     invariants (a verified-done item is immovable, never edited, never pruned).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildReplanPrompt,
  parseReplanEdits,
  applyReplanEdits,
  REPLAN_MAX_EDITS,
  type RoadmapEdit,
} from '../../src/core/goal-replan.ts';
import type { Goal } from '../../src/core/goal-todo.ts';
import type { RoadmapItem, RoadmapItemVerdict } from '../../src/core/work-contract.ts';
import type { SystemModel } from '../../src/core/understanding.ts';

function verdict(state: RoadmapItemVerdict['state']): RoadmapItemVerdict {
  return { state, receipt: `r:${state}`, at: '2026-06-10T00:00:00.000Z' };
}
function item(p: Partial<RoadmapItem> & { id: string }): RoadmapItem {
  return { text: `todo ${p.id}`, status: 'pending', ...p };
}
function goal(roadmap: RoadmapItem[], over: Partial<Goal> = {}): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Harden the auth path',
    state: 'running',
    source: 'user-explicit',
    roadmap,
    scope: 'project',
    projectKey: 'repo#1',
    conversationId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastTouched: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildReplanPrompt
// ---------------------------------------------------------------------------

describe('buildReplanPrompt', () => {
  it('empty for a titleless goal (never throws)', () => {
    assert.equal(buildReplanPrompt(goal([], { title: '   ' })), '');
  });

  it('lists each to-do by id + flags verified-done as do-not-touch', () => {
    const p = buildReplanPrompt(
      goal([
        item({ id: 'r1', text: 'wire refresh', verdict: verdict('passing'), status: 'done' }),
        item({ id: 'r2', text: 'add retry' }),
      ]),
    );
    assert.match(p, /\[r1\] \(DONE\/VERIFIED — do not touch\) wire refresh/);
    assert.match(p, /\[r2\] \(pending\) add retry/);
    assert.match(p, /ADD:/);
    assert.match(p, /REORDER:/);
    assert.match(p, /PRUNE/);
  });

  it('grounds in the SystemModel summary + constraints when present', () => {
    const sm: SystemModel = {
      summary: 'OAuth-subscription CLI, no metered services',
      modules: [],
      conventions: [],
      constraints: ['subscription-OAuth only, no embeddings'],
      openQuestions: [],
      researchCitations: [],
    };
    const grounded = buildReplanPrompt(goal([item({ id: 'r1' })]), sm);
    assert.match(grounded, /WHOLE-PICTURE UNDERSTANDING/);
    assert.match(grounded, /no embeddings/);
    // Ungrounded form omits the block entirely.
    const plain = buildReplanPrompt(goal([item({ id: 'r1' })]));
    assert.ok(!/WHOLE-PICTURE UNDERSTANDING/.test(plain));
  });

  it('includes goalAcceptance when set', () => {
    const p = buildReplanPrompt(goal([item({ id: 'r1' })], { goalAcceptance: 'all auth tests green' }));
    assert.match(p, /THE GOAL IS DONE WHEN:/);
    assert.match(p, /all auth tests green/);
  });
});

// ---------------------------------------------------------------------------
// parseReplanEdits
// ---------------------------------------------------------------------------

describe('parseReplanEdits', () => {
  it('non-string / no-tag → null (unusable, caller leaves plan as-is)', () => {
    assert.equal(parseReplanEdits(null), null);
    assert.equal(parseReplanEdits(undefined), null);
    assert.equal(parseReplanEdits(123 as unknown as string), null);
    assert.equal(parseReplanEdits('just some prose, no tags at all'), null);
    assert.equal(parseReplanEdits(''), null);
  });

  it('parses a well-formed mixed edit list', () => {
    const raw = [
      'ADD: write the retry test',
      'ADD: add a circuit breaker || DONE-WHEN: breaker opens after 5 failures',
      'EDIT r2: clarify the token refresh step',
      'EDIT r3: tighten || DONE-WHEN: lint clean',
      'REORDER: r3, r2, r1',
      'PRUNE r4: obsolete after the rewrite',
    ].join('\n');
    const edits = parseReplanEdits(raw);
    assert.notEqual(edits, null);
    assert.deepEqual(edits, [
      { kind: 'add', text: 'write the retry test' },
      {
        kind: 'add',
        text: 'add a circuit breaker',
        acceptanceCriterion: 'breaker opens after 5 failures',
      },
      { kind: 'edit', id: 'r2', text: 'clarify the token refresh step' },
      { kind: 'edit', id: 'r3', text: 'tighten', acceptanceCriterion: 'lint clean' },
      { kind: 'reorder', order: ['r3', 'r2', 'r1'] },
      { kind: 'prune', id: 'r4' },
    ] satisfies RoadmapEdit[]);
  });

  it('ignores prose lines + keeps only the real tagged edits', () => {
    const raw = [
      'Here is my reasoning about the plan.',
      'ADD: write the retry test',
      'This step matters because...',
      'PRUNE r1: obsolete',
    ].join('\n');
    assert.deepEqual(parseReplanEdits(raw), [
      { kind: 'add', text: 'write the retry test' },
      { kind: 'prune', id: 'r1' },
    ] satisfies RoadmapEdit[]);
  });

  it('an all-unusable reply (no parseable tag) → null, never fabricated', () => {
    // Malformed tag lines with no payload do not count as a usable signal, so the
    // whole reply degrades to null (the caller leaves the plan exactly as-is).
    assert.equal(parseReplanEdits(['ADD:   ', 'EDIT r1:', 'PRUNE'].join('\n')), null);
  });

  it('caps the number of edits at REPLAN_MAX_EDITS', () => {
    const lines = Array.from({ length: REPLAN_MAX_EDITS + 10 }, (_, i) => `ADD: step ${i}`);
    const edits = parseReplanEdits(lines.join('\n'));
    assert.equal(edits?.length, REPLAN_MAX_EDITS);
  });

  it('caps text + criterion length, never throws on garbage', () => {
    const long = 'x'.repeat(500);
    const edits = parseReplanEdits(`ADD: ${long} || DONE-WHEN: ${long}`);
    assert.equal(edits?.length, 1);
    const add = edits?.[0];
    assert.ok(add?.kind === 'add');
    assert.ok((add.text?.length ?? 0) <= 120);
    assert.ok((add.acceptanceCriterion?.length ?? 0) <= 200);
    // fuzz: never throws
    for (const junk of ['\u0000\u0000', 'ADD', 'REORDER:', 'EDIT :', '— — —']) {
      assert.doesNotThrow(() => parseReplanEdits(junk));
    }
  });
});

// ---------------------------------------------------------------------------
// applyReplanEdits — semantics + honesty invariants
// ---------------------------------------------------------------------------

describe('applyReplanEdits', () => {
  it('ADD appends a fresh-id pending to-do; cap honoured', () => {
    const out = applyReplanEdits(
      [item({ id: 'r1' })],
      [{ kind: 'add', text: 'new step', acceptanceCriterion: 'done when X' }],
    );
    assert.equal(out.length, 2);
    assert.equal(out[1]?.id, 'r2');
    assert.equal(out[1]?.status, 'pending');
    assert.equal(out[1]?.acceptanceCriterion, 'done when X');

    // cap: a roadmap already at the cap drops the add (no overflow).
    const full = Array.from({ length: 8 }, (_, i) => item({ id: `r${i + 1}` }));
    const capped = applyReplanEdits(full, [{ kind: 'add', text: 'overflow' }], 8);
    assert.equal(capped.length, 8);
  });

  it('EDIT patches a pending item; verified-done item is IMMUTABLE', () => {
    const out = applyReplanEdits(
      [
        item({ id: 'r1', text: 'old', verdict: verdict('passing'), status: 'done' }),
        item({ id: 'r2', text: 'old2' }),
      ],
      [
        { kind: 'edit', id: 'r1', text: 'HACKED' }, // verified → must be ignored
        { kind: 'edit', id: 'r2', text: 'clarified' },
      ],
    );
    assert.equal(out[0]?.text, 'old', 'verified-done item never edited');
    assert.equal(out[0]?.verdict?.state, 'passing', 'verdict preserved verbatim');
    assert.equal(out[1]?.text, 'clarified');
  });

  it('PRUNE drops a pending item; verified-done item is RETAINED', () => {
    const out = applyReplanEdits(
      [
        item({ id: 'r1', verdict: verdict('reviewed'), status: 'done' }),
        item({ id: 'r2' }),
      ],
      [
        { kind: 'prune', id: 'r1' }, // verified → retained
        { kind: 'prune', id: 'r2' }, // pending → removed
        { kind: 'prune', id: 'rX' }, // unknown → no-op
      ],
    );
    assert.deepEqual(out.map((i) => i.id), ['r1']);
  });

  it('REORDER permutes pending items but ANCHORS verified-done at their slot', () => {
    // r2 (verified) is at index 1. A reorder of the pending ids must keep r2 in
    // place; only r1/r3 may swap around it.
    const out = applyReplanEdits(
      [
        item({ id: 'r1' }),
        item({ id: 'r2', verdict: verdict('passing'), status: 'done' }),
        item({ id: 'r3' }),
      ],
      [{ kind: 'reorder', order: ['r3', 'r1'] }],
    );
    // index 1 stays r2 (anchored); pending slots (0, 2) become r3, r1.
    assert.deepEqual(out.map((i) => i.id), ['r3', 'r2', 'r1']);
    assert.equal(out[1]?.id, 'r2');
  });

  it('REORDER never drops an omitted pending item', () => {
    const out = applyReplanEdits(
      [item({ id: 'r1' }), item({ id: 'r2' }), item({ id: 'r3' })],
      [{ kind: 'reorder', order: ['r3'] }],
    );
    // r3 first, then r1, r2 in original relative order.
    assert.deepEqual(out.map((i) => i.id), ['r3', 'r1', 'r2']);
  });

  it('never mutates the input roadmap', () => {
    const input = [item({ id: 'r1' })];
    const snapshot = JSON.stringify(input);
    applyReplanEdits(input, [{ kind: 'add', text: 'x' }, { kind: 'prune', id: 'r1' }]);
    assert.equal(JSON.stringify(input), snapshot);
  });
});

// ---------------------------------------------------------------------------
// New structural edit kinds: depends + group
// ---------------------------------------------------------------------------

describe('parseReplanEdits — depends + group', () => {
  it('parses DEPENDS <id>: <ids>', () => {
    const edits = parseReplanEdits('DEPENDS r2: r1, r3');
    assert.deepEqual(edits, [{ kind: 'depends', id: 'r2', dependsOn: ['r1', 'r3'] }]);
  });

  it('drops a self-edge from a DEPENDS line', () => {
    const edits = parseReplanEdits('DEPENDS r2: r2, r1');
    assert.deepEqual(edits, [{ kind: 'depends', id: 'r2', dependsOn: ['r1'] }]);
  });

  it('a DEPENDS with only a self-edge yields no edit (tag seen → [])', () => {
    // The DEPENDS tag is recognized (sawAnyTag) but the self-edge is dropped, so
    // no edit is pushed — matching the existing "saw a tag, nothing usable" → [].
    assert.deepEqual(parseReplanEdits('DEPENDS r2: r2'), []);
  });

  it('parses GROUP <id>: <parent>', () => {
    const edits = parseReplanEdits('GROUP c1: p1');
    assert.deepEqual(edits, [{ kind: 'group', id: 'c1', parentId: 'p1' }]);
  });

  it('drops a self-grouping GROUP line (tag seen → [])', () => {
    assert.deepEqual(parseReplanEdits('GROUP c1: c1'), []);
  });
});

describe('applyReplanEdits — depends + group guards', () => {
  it('depends edit wires an edge; normalization keeps it when the sibling exists', () => {
    const out = applyReplanEdits([item({ id: 'r1' }), item({ id: 'r2' })], [
      { kind: 'depends', id: 'r2', dependsOn: ['r1'] },
    ] as RoadmapEdit[]);
    assert.deepEqual(out.find((i) => i.id === 'r2')?.dependsOn, ['r1']);
  });

  it('depends edit to an unknown id is stripped by the relational guard', () => {
    const out = applyReplanEdits([item({ id: 'r1' })], [
      { kind: 'depends', id: 'r1', dependsOn: ['ghost'] },
    ] as RoadmapEdit[]);
    assert.ok(out[0]?.dependsOn === undefined);
  });

  it('depends edit that would form a cycle is stripped (no deadlock)', () => {
    const out = applyReplanEdits([item({ id: 'r1', dependsOn: ['r2'] }), item({ id: 'r2' })], [
      { kind: 'depends', id: 'r2', dependsOn: ['r1'] },
    ] as RoadmapEdit[]);
    // r1→r2 already; adding r2→r1 closes a cycle → both cyclic edges stripped.
    assert.ok(out[0]?.dependsOn === undefined || !out[0].dependsOn.includes('r2'));
    assert.ok(out[1]?.dependsOn === undefined || !out[1].dependsOn.includes('r1'));
  });

  it('depends never touches a verified-done item', () => {
    const out = applyReplanEdits(
      [item({ id: 'r1' }), item({ id: 'r2', verdict: verdict('passing') })],
      [{ kind: 'depends', id: 'r2', dependsOn: ['r1'] }] as RoadmapEdit[],
    );
    assert.ok(out.find((i) => i.id === 'r2')?.dependsOn === undefined);
  });

  it('group edit sets a 1-level parent; over-depth is dropped', () => {
    const out = applyReplanEdits(
      [item({ id: 'p' }), item({ id: 'c', parentId: 'p' }), item({ id: 'gc' })],
      [{ kind: 'group', id: 'gc', parentId: 'c' }] as RoadmapEdit[],
    );
    // gc → c is over-depth (c is itself a child) → dropped.
    assert.ok(out.find((i) => i.id === 'gc')?.parentId === undefined);
    assert.equal(out.find((i) => i.id === 'c')?.parentId, 'p');
  });

  it('a prune that would orphan a dependedOn item is dropped (dependency-safety)', () => {
    const out = applyReplanEdits([item({ id: 'r1' }), item({ id: 'r2', dependsOn: ['r1'] })], [
      { kind: 'prune', id: 'r1' },
    ] as RoadmapEdit[]);
    // r2 still depends on r1 → the prune is refused; r1 survives.
    assert.ok(out.some((i) => i.id === 'r1'), 'r1 retained (still depended on)');
    assert.deepEqual(out.find((i) => i.id === 'r2')?.dependsOn, ['r1']);
  });
});
