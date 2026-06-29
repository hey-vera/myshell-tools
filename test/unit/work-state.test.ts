/**
 * test/unit/work-state.test.ts — Adaptive Partner Engine v2, STAGE 2 (AP2-B).
 *
 * Pure-function coverage for the truthful work-state reducer (§2.3 B):
 *   - deriveWorkStateFromHistory: empty history → undefined; an evidence-backed
 *     ('done') roadmap step → verifiedDone; a model-stated next (checkpoint summary)
 *     with NO evidence → claimedNext but NOT verifiedDone; a blocked turn → blocked,
 *     not done; reviewer 'approve' / GOAL_COMPLETE → verifiedDone; never infers done
 *     from silence; uses the LATEST trusted workTrace on a stale resume.
 *   - renderWorkStateBlock: truthful OBJECTIVE/DONE/NEXT/BLOCKED; "none yet" when no
 *     evidence; "" when absent.
 *
 * PURE — no model, no I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  deriveWorkStateFromHistory,
  renderWorkStateBlock,
} from '../../src/core/work-state.ts';
import type { SessionEntry } from '../../src/core/types.ts';
import type { WorkContract } from '../../src/core/work-contract.ts';

function assistant(content: string, workTrace?: WorkContract): SessionEntry {
  return {
    timestamp: '2026-06-06T00:00:00.000Z',
    role: 'assistant',
    content,
    ...(workTrace !== undefined ? { workTrace } : {}),
  };
}

function user(content: string): SessionEntry {
  return { timestamp: '2026-06-06T00:00:00.000Z', role: 'user', content };
}

// ---------------------------------------------------------------------------
// deriveWorkStateFromHistory
// ---------------------------------------------------------------------------

describe('deriveWorkStateFromHistory — empty / no trace', () => {
  it('returns undefined for empty history', () => {
    assert.equal(deriveWorkStateFromHistory([]), undefined);
  });

  it('returns undefined when no assistant entry carries a workTrace', () => {
    const h: SessionEntry[] = [user('do the thing'), assistant('working on it')];
    assert.equal(deriveWorkStateFromHistory(h), undefined);
  });

  it('returns undefined when the trace has no objective, roadmap, or checkpoints', () => {
    const h: SessionEntry[] = [assistant('', { version: 1, objective: '' })];
    assert.equal(deriveWorkStateFromHistory(h), undefined);
  });
});

describe('deriveWorkStateFromHistory — evidence rules', () => {
  it('puts an evidence-backed (status:done) roadmap step into verifiedDone', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'ship the analytics dashboard',
      roadmap: [
        { id: 'R1', text: 'wire the route', status: 'done' },
        { id: 'R2', text: 'hydrate the chart', status: 'pending' },
      ],
    };
    const snap = deriveWorkStateFromHistory([assistant('done R1', trace)]);
    assert.ok(snap !== undefined);
    assert.equal(snap.source, 'session-workTrace');
    assert.deepEqual(snap.verifiedDone, ['wire the route']);
    // The pending item is NOT done.
    assert.equal(snap.verifiedDone.includes('hydrate the chart'), false);
  });

  it('a model-stated next (checkpoint summary) is claimedNext but NEVER verifiedDone', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'ship the analytics dashboard',
      roadmap: [{ id: 'R1', text: 'wire the route', status: 'active' }],
      checkpoints: [{ id: 'C1', summary: 'investigate chart hydration failure' }],
    };
    const snap = deriveWorkStateFromHistory([assistant('next: hydration', trace)]);
    assert.ok(snap !== undefined);
    assert.equal(snap.claimedNext, 'investigate chart hydration failure');
    // The checkpoint summary must NOT leak into verifiedDone (no evidence).
    assert.deepEqual(snap.verifiedDone, []);
    assert.equal(
      snap.verifiedDone.includes('investigate chart hydration failure'),
      false,
    );
  });

  it('a blocked roadmap item is reported blocked, not done', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'fix the broken page',
      roadmap: [{ id: 'R1', text: 'locate the missing repo', status: 'blocked' }],
    };
    const snap = deriveWorkStateFromHistory([assistant('blocked', trace)]);
    assert.ok(snap !== undefined);
    assert.deepEqual(snap.verifiedDone, []);
    const block = renderWorkStateBlock(snap);
    assert.match(block, /BLOCKED: R1: locate the missing repo/);
    assert.match(block, /DONE: none yet/);
  });

  it('NEVER infers done from silence (active item + empty assistant content → not done)', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'multi-step task',
      roadmap: [
        { id: 'R1', text: 'step one', status: 'active' },
        { id: 'R2', text: 'step two', status: 'pending' },
      ],
    };
    const snap = deriveWorkStateFromHistory([assistant('', trace)]);
    assert.ok(snap !== undefined);
    // Nothing is 'done' — silence is not evidence.
    assert.deepEqual(snap.verifiedDone, []);
  });

  it('reviewer approval counts as evidence in verifiedDone', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'land the patch',
      roadmap: [{ id: 'R1', text: 'apply the patch', status: 'active' }],
      verification: { verdict: 'approve', notes: 'tests pass' },
    };
    const snap = deriveWorkStateFromHistory([assistant('reviewed', trace)]);
    assert.ok(snap !== undefined);
    assert.ok(snap.verifiedDone.some((d) => /reviewer approved/.test(d)));
  });

  it('a non-approve review verdict (revise) is NOT evidence of done', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'land the patch',
      roadmap: [{ id: 'R1', text: 'apply the patch', status: 'active' }],
      verification: { verdict: 'revise', notes: 'fix the edge case' },
    };
    const snap = deriveWorkStateFromHistory([assistant('revising', trace)]);
    assert.ok(snap !== undefined);
    assert.deepEqual(snap.verifiedDone, []);
  });

  it('GOAL_COMPLETE in assistant content is evidence the objective finished', () => {
    const trace: WorkContract = { version: 1, objective: 'the goal', roadmap: [] };
    const h: SessionEntry[] = [
      assistant('working', trace),
      assistant('all set. GOAL_COMPLETE'),
    ];
    const snap = deriveWorkStateFromHistory(h);
    assert.ok(snap !== undefined);
    assert.ok(snap.verifiedDone.some((d) => /GOAL_COMPLETE/.test(d)));
  });
});

describe('deriveWorkStateFromHistory — latest trusted trace on resume', () => {
  it('uses the LATEST assistant workTrace (newest trusted state wins)', () => {
    const t1: WorkContract = { version: 1, objective: 'old objective', roadmap: [] };
    const t2: WorkContract = {
      version: 1,
      objective: 'new objective',
      roadmap: [{ id: 'R1', text: 'newest step', status: 'done' }],
    };
    const h: SessionEntry[] = [
      assistant('t1', t1),
      assistant('stale generic prose that should not poison work-state'),
      assistant('t2', t2),
    ];
    const snap = deriveWorkStateFromHistory(h);
    assert.ok(snap !== undefined);
    assert.equal(snap.objective, 'new objective');
    assert.deepEqual(snap.verifiedDone, ['newest step']);
  });
});

// ---------------------------------------------------------------------------
// renderWorkStateBlock
// ---------------------------------------------------------------------------

describe('renderWorkStateBlock', () => {
  it('renders OBJECTIVE / DONE / NEXT / BLOCKED truthfully', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'ship the analytics dashboard',
      roadmap: [
        { id: 'R1', text: 'wired route', status: 'done' },
        { id: 'R2', text: 'hydration', status: 'active' },
      ],
      checkpoints: [{ id: 'C1', summary: 'investigate chart hydration failure' }],
    };
    const block = renderWorkStateBlock(deriveWorkStateFromHistory([assistant('x', trace)]));
    assert.match(block, /WORK STATE \(truthful, from accepted prior turns\):/);
    assert.match(block, /OBJECTIVE: ship the analytics dashboard/);
    assert.match(block, /DONE: wired route/);
    assert.match(block, /NEXT \(model-stated, not yet verified\): investigate chart hydration failure/);
    assert.match(block, /BLOCKED: none/);
  });

  it('returns "" when snapshot is undefined (absent → omitted)', () => {
    assert.equal(renderWorkStateBlock(undefined), '');
  });

  it('DONE says "none yet" when there is no verified evidence', () => {
    const trace: WorkContract = {
      version: 1,
      objective: 'just started',
      roadmap: [{ id: 'R1', text: 'first step', status: 'active' }],
    };
    const block = renderWorkStateBlock(deriveWorkStateFromHistory([assistant('x', trace)]));
    assert.match(block, /DONE: none yet/);
  });
});
