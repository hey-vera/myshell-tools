/**
 * Unit tests for src/core/work-contract.ts.
 * Run with: node --import ./test/register.mjs --test "test/unit/work-contract.test.ts"
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  appendCheckpointFromContinue,
  capContract,
  capRoadmapItem,
  normalizeRoadmapRelations,
  DEPENDS_ON_LIMIT,
  isCleanObjectiveTask,
  renderContractForPrompt,
  shouldMaterializeContract,
  stampContractIntentVersion,
  type Checkpoint,
  type ContractVerification,
  type RoadmapItem,
  type RoadmapItemApproach,
  type RoadmapItemVerdict,
  type RoadmapStatus,
  type WorkContract,
} from '../../src/core/work-contract.ts';
import type { Classification } from '../../src/core/types.ts';

const lowIc: Classification = { tier: 'ic', risk: 'low', rationale: 'r' };
const highIc: Classification = { tier: 'ic', risk: 'high', rationale: 'r' };
const managerLow: Classification = { tier: 'manager', risk: 'low', rationale: 'r' };

function repeat(ch: string, length: number): string {
  return ch.repeat(length);
}

describe('capContract', () => {
  it('truncates capped fields and arrays deterministically', () => {
    const active: RoadmapStatus = 'active';
    const roadmap: RoadmapItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      text: repeat(String(i), 200),
      status: i === 0 ? active : 'pending',
    }));
    const checkpoints: Checkpoint[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      summary: repeat('s', 200),
      roadmapId: `r${i}`,
      evidence: repeat('e', 200),
    }));
    const verification: ContractVerification = {
      verdict: 'revise',
      notes: repeat('n', 300),
      failedCheckpointIds: ['c1', 'c2'],
    };
    const contract: WorkContract = {
      version: 1,
      objective: repeat('o', 300),
      vision: repeat('v', 300),
      roadmap,
      checkpoints,
      verification,
    };

    const first = capContract(contract);
    const second = capContract(contract);

    assert.deepEqual(first, second);
    assert.equal(first.objective.length, 240);
    assert.equal(first.vision?.length, 240);
    assert.equal(first.roadmap?.length, 8);
    assert.equal(first.roadmap?.[0]?.text.length, 160);
    assert.equal(first.checkpoints?.length, 6);
    assert.equal(first.checkpoints?.[0]?.summary.length, 160);
    assert.equal(first.checkpoints?.[0]?.evidence?.length, 120);
    assert.equal(first.verification?.notes?.length, 240);
  });

  it('never throws on malformed runtime input', () => {
    const malformed = {
      version: 99,
      objective: { toString: () => { throw new Error('boom'); } },
      vision: null,
      roadmap: [{ id: 1, text: null, status: 'invalid' }, null],
      checkpoints: [{ id: 2, summary: undefined, evidence: 3 }, null],
      verification: { verdict: 'bad', notes: 4, failedCheckpointIds: [1] },
    } as unknown as WorkContract;

    assert.doesNotThrow(() => capContract(malformed));
    assert.doesNotThrow(() => capContract(null as unknown as WorkContract));
    assert.deepEqual(capContract(malformed), {
      version: 1,
      objective: '',
      vision: '',
      roadmap: [
        { id: '1', text: '', status: 'pending' },
        { id: '', text: '', status: 'pending' },
      ],
      checkpoints: [
        { id: '2', summary: '', evidence: '3' },
        { id: '', summary: '' },
      ],
      verification: {
        // A malformed verdict ('bad') must NOT silently become 'approve' — it
        // falls back to the fail-safe non-approval verdict 'revise'.
        verdict: 'revise',
        notes: '4',
        failedCheckpointIds: ['1'],
      },
    });
  });

  it('an explicit approve verdict is preserved', () => {
    const result = capContract({
      version: 1,
      objective: 'ship',
      verification: { verdict: 'approve', notes: 'tests pass' },
    });
    assert.equal(result.verification?.verdict, 'approve');
  });

  it('an empty verification object is NOT approved (defaults to revise)', () => {
    const result = capContract({
      version: 1,
      objective: 'ship',
      verification: {} as ContractVerification,
    });
    // The verification block is still surfaced, but it must not read as approval.
    assert.equal(result.verification?.verdict, 'revise');
  });

  it('a malformed/under-specified verdict is NOT approved (defaults to revise)', () => {
    for (const bad of ['', 'APPROVE', 'ok', 'yes', undefined, null, 42, {}]) {
      const result = capContract({
        version: 1,
        objective: 'ship',
        verification: { verdict: bad } as unknown as ContractVerification,
      });
      assert.equal(
        result.verification?.verdict,
        'revise',
        `verdict=${JSON.stringify(bad)} must not silently approve`,
      );
    }
  });

  it('preserves an explicit revise/escalate verdict', () => {
    assert.equal(
      capContract({
        version: 1,
        objective: 'ship',
        verification: { verdict: 'revise' },
      }).verification?.verdict,
      'revise',
    );
    assert.equal(
      capContract({
        version: 1,
        objective: 'ship',
        verification: { verdict: 'escalate' },
      }).verification?.verdict,
      'escalate',
    );
  });
});

describe('renderContractForPrompt', () => {
  it('degrades to OBJECTIVE-only when roadmap and checkpoints are empty', () => {
    assert.equal(
      renderContractForPrompt({ version: 1, objective: 'ship the fix', roadmap: [], checkpoints: [] }),
      'OBJECTIVE: ship the fix',
    );
  });

  it('includes VISION when present', () => {
    assert.equal(
      renderContractForPrompt({ version: 1, objective: 'ship the fix', vision: 'keep behavior stable' }),
      'OBJECTIVE: ship the fix\nVISION: keep behavior stable',
    );
  });

  it('renders roadmap statuses and checkpoints when present', () => {
    const rendered = renderContractForPrompt({
      version: 1,
      objective: 'ship',
      roadmap: [{ id: 'r1', text: 'patch review prompt', status: 'done' }],
      checkpoints: [{ id: 'c1', summary: 'tests pass', roadmapId: 'r1', evidence: 'npm test' }],
    });

    assert.match(rendered, /ROADMAP:\n- \[done\] r1: patch review prompt/);
    assert.match(rendered, /RECENT STEPS \(each turn's stated next action\):\n- c1 \(r1\): tests pass/);
    assert.match(rendered, /evidence: npm test/);
  });
});

describe('appendCheckpointFromContinue', () => {
  it('appends one checkpoint with a capped summary', () => {
    const result = appendCheckpointFromContinue(
      { version: 1, objective: 'ship' },
      repeat('s', 200),
      0,
    );

    assert.equal(result.checkpoints?.length, 1);
    assert.equal(result.checkpoints?.[0]?.id, 'C1');
    assert.equal(result.checkpoints?.[0]?.summary.length, 160);
  });

  it('preserves order and keeps the most recent six checkpoints', () => {
    const contract: WorkContract = {
      version: 1,
      objective: 'ship',
      checkpoints: Array.from({ length: 6 }, (_, i) => ({
        id: `C${i + 1}`,
        summary: `step ${i + 1}`,
      })),
    };

    const result = appendCheckpointFromContinue(contract, 'step 7', 6);

    assert.deepEqual(
      result.checkpoints?.map((checkpoint) => checkpoint.id),
      ['C2', 'C3', 'C4', 'C5', 'C6', 'C7'],
    );
    assert.deepEqual(
      result.checkpoints?.map((checkpoint) => checkpoint.summary),
      ['step 2', 'step 3', 'step 4', 'step 5', 'step 6', 'step 7'],
    );
  });

  it('returns the original contract unchanged for empty or whitespace continue text', () => {
    const contract: WorkContract = { version: 1, objective: 'ship' };

    assert.equal(appendCheckpointFromContinue(contract, '', 0), contract);
    assert.equal(appendCheckpointFromContinue(contract, '   \n\t  ', 0), contract);
  });

  it('never throws on garbage continue text', () => {
    const garbage = {
      toString: () => {
        throw new Error('boom');
      },
    } as unknown as string;

    assert.doesNotThrow(() => appendCheckpointFromContinue({ version: 1, objective: 'ship' }, garbage, 2));
  });
});

describe('shouldMaterializeContract', () => {
  it('criteria is gated only by an existing verifier run', () => {
    assert.deepEqual(
      shouldMaterializeContract({
        classification: lowIc,
        routePlan: false,
        context: 'normal',
        reviewWillRun: false,
      }),
      { criteria: false, roadmap: false },
    );
    assert.deepEqual(
      shouldMaterializeContract({
        classification: lowIc,
        routePlan: false,
        context: 'normal',
        reviewWillRun: true,
      }),
      { criteria: true, roadmap: false },
    );
  });

  it('roadmap is gated by goal/keep-going context, route plan, or manager tier', () => {
    assert.equal(
      shouldMaterializeContract({
        classification: lowIc,
        routePlan: false,
        context: 'goal',
        reviewWillRun: false,
      }).roadmap,
      true,
    );
    assert.equal(
      shouldMaterializeContract({
        classification: lowIc,
        routePlan: false,
        context: 'keep_going',
        reviewWillRun: false,
      }).roadmap,
      true,
    );
    assert.equal(
      shouldMaterializeContract({
        classification: lowIc,
        routePlan: true,
        context: 'normal',
        reviewWillRun: false,
      }).roadmap,
      true,
    );
    assert.equal(
      shouldMaterializeContract({
        classification: managerLow,
        routePlan: false,
        context: 'normal',
        reviewWillRun: false,
      }).roadmap,
      true,
    );
  });

  it('risk alone never materializes roadmap', () => {
    assert.deepEqual(
      shouldMaterializeContract({
        classification: highIc,
        routePlan: false,
        context: 'normal',
        reviewWillRun: false,
      }),
      { criteria: false, roadmap: false },
    );
  });
});

describe('isCleanObjectiveTask', () => {
  it('accepts ordinary objectives and rejects already-contracted prompt text', () => {
    assert.equal(isCleanObjectiveTask('ship the login flow'), true);
    assert.equal(isCleanObjectiveTask('   '), false);
    assert.equal(isCleanObjectiveTask('OBJECTIVE: ship'), false);
    assert.equal(
      isCleanObjectiveTask(
        'Goal: ship\nBefore acting, confirm this turn still directly serves the OBJECTIVE; do not pursue unrelated improvements.',
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 2 data-model: capRoadmapItem new optional fields
// ---------------------------------------------------------------------------

describe('capRoadmapItem — Phase 2 acceptanceCriterion + verdict + approach', () => {
  it('a RoadmapItem WITHOUT the new fields round-trips byte-identically (regression guard)', () => {
    const item: RoadmapItem = { id: 'r1', text: 'implement auth', status: 'active' };
    const capped = capRoadmapItem(item);
    assert.deepEqual(capped, item);
    assert.equal('acceptanceCriterion' in capped, false);
    assert.equal('verdict' in capped, false);
    assert.equal('approach' in capped, false);
  });

  it('acceptanceCriterion is preserved and capped at 400 chars', () => {
    const item: RoadmapItem = {
      id: 'r1', text: 'fix', status: 'pending',
      acceptanceCriterion: 'X'.repeat(500),
    };
    const capped = capRoadmapItem(item);
    assert.equal(capped.acceptanceCriterion?.length, 400);
  });

  it('acceptanceCriterion absent → field not present on output', () => {
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending' });
    assert.equal('acceptanceCriterion' in capped, false);
  });

  it('verdict round-trips all four valid VerifiedState values', () => {
    for (const state of ['unverified', 'reviewed', 'passing', 'failing'] as const) {
      const verdict: RoadmapItemVerdict = {
        state,
        receipt: '~ reviewed',
        at: '2026-06-10T10:00:00.000Z',
      };
      const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', verdict });
      assert.equal(capped.verdict?.state, state, `state '${state}' must survive round-trip`);
      assert.equal(capped.verdict?.receipt, verdict.receipt);
    }
  });

  it('verdict is dropped (not thrown) when state is invalid', () => {
    for (const badState of ['PASSING', 'done', '', 0, null, undefined]) {
      const item = {
        id: 'r1', text: 'x', status: 'pending',
        verdict: { state: badState, receipt: 'r', at: '2026-06-10T00:00:00.000Z' },
      };
      assert.doesNotThrow(() => capRoadmapItem(item));
      const capped = capRoadmapItem(item);
      assert.equal('verdict' in capped, false, `bad state=${JSON.stringify(badState)} must be dropped`);
    }
  });

  it('verdict.receipt is capped to 400 chars', () => {
    const verdict: RoadmapItemVerdict = {
      state: 'failing',
      receipt: 'E'.repeat(600),
      at: '2026-06-10T10:00:00.000Z',
    };
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', verdict });
    assert.equal(capped.verdict?.receipt.length, 400);
  });

  it('verdict.changedPaths is bounded to 20 and each path capped to 200 chars', () => {
    const verdict: RoadmapItemVerdict = {
      state: 'passing',
      receipt: 'ok',
      at: '2026-06-10T10:00:00.000Z',
      changedPaths: Array.from({ length: 25 }, (_, i) => 'P'.repeat(250) + `/f${i}.ts`),
    };
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', verdict });
    assert.equal(capped.verdict?.changedPaths?.length, 20);
    assert.ok((capped.verdict?.changedPaths?.[0]?.length ?? 0) <= 200);
  });

  it('approach round-trips chosen + rationale + optional alternatives', () => {
    const approach: RoadmapItemApproach = {
      chosen: 'memoize with WeakMap',
      rationale: 'zero allocation on hot path',
      alternatives: ['global cache', 'no cache'],
    };
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', approach });
    assert.deepEqual(capped.approach, approach);
  });

  it('approach is omitted when chosen is empty', () => {
    const approach: RoadmapItemApproach = { chosen: '', rationale: 'reason' };
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', approach });
    assert.equal('approach' in capped, false);
  });

  it('approach is omitted when rationale is empty', () => {
    const approach: RoadmapItemApproach = { chosen: 'some plan', rationale: '' };
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', approach });
    assert.equal('approach' in capped, false);
  });

  it('approach.chosen and rationale are each capped to 400 chars', () => {
    const approach: RoadmapItemApproach = {
      chosen: 'C'.repeat(500),
      rationale: 'R'.repeat(500),
    };
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', approach });
    assert.equal(capped.approach?.chosen.length, 400);
    assert.equal(capped.approach?.rationale.length, 400);
  });

  it('approach.alternatives is bounded to 8 items, each capped to 160 chars', () => {
    const approach: RoadmapItemApproach = {
      chosen: 'best',
      rationale: 'efficient',
      alternatives: Array.from({ length: 15 }, (_, i) => 'A'.repeat(200) + i),
    };
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending', approach });
    assert.equal(capped.approach?.alternatives?.length, 8);
    assert.ok((capped.approach?.alternatives?.[0]?.length ?? 0) <= 160);
  });

  it('approach absent → field not present on output', () => {
    const capped = capRoadmapItem({ id: 'r1', text: 'x', status: 'pending' });
    assert.equal('approach' in capped, false);
  });

  it('capContract roadmap items carry new fields through the contract shaper', () => {
    const verdict: RoadmapItemVerdict = {
      state: 'passing',
      receipt: '✓ tests passing (npm test, 400ms)',
      at: '2026-06-10T10:00:00.000Z',
      changedPaths: ['src/core/work-contract.ts'],
    };
    const approach: RoadmapItemApproach = {
      chosen: 'extend interface',
      rationale: 'additive, no breakage',
    };
    const item: RoadmapItem = {
      id: 'r1', text: 'add fields', status: 'done',
      acceptanceCriterion: 'Types present + tests green',
      verdict,
      approach,
    };
    const contract: WorkContract = { version: 1, objective: 'ship phase 2', roadmap: [item] };
    const capped = capContract(contract);
    assert.deepEqual(capped.roadmap?.[0]?.verdict, verdict);
    assert.deepEqual(capped.roadmap?.[0]?.approach, approach);
    assert.equal(capped.roadmap?.[0]?.acceptanceCriterion, item.acceptanceCriterion);
  });

  it('capRoadmapItem never throws on garbage input', () => {
    const garbage = [null, undefined, 42, 'string', [], { id: null, text: {}, status: [] }];
    for (const bad of garbage) {
      assert.doesNotThrow(() => capRoadmapItem(bad));
    }
  });
});

describe('dependsOn / parentId — additive structural fields', () => {
  function it_(id: string, extra: Partial<RoadmapItem> = {}): RoadmapItem {
    return { id, text: `t-${id}`, status: 'pending', ...extra };
  }

  it('an item with NEITHER field round-trips byte-identical (omitted, not defaulted)', () => {
    const items = [it_('r1'), it_('r2')];
    const out = normalizeRoadmapRelations(items);
    assert.deepEqual(out, items);
    for (const o of out) {
      assert.ok(!('dependsOn' in o), 'no dependsOn key');
      assert.ok(!('parentId' in o), 'no parentId key');
    }
  });

  it('keeps only dep ids that exist among siblings; drops unknown', () => {
    const out = normalizeRoadmapRelations([
      it_('r1'),
      it_('r2', { dependsOn: ['r1', 'ghost'] }),
    ]);
    assert.deepEqual(out[1]?.dependsOn, ['r1']);
  });

  it('drops self-edges and dedupes', () => {
    const out = normalizeRoadmapRelations([
      it_('r1'),
      it_('r2', { dependsOn: ['r2', 'r1', 'r1'] }),
    ]);
    assert.deepEqual(out[1]?.dependsOn, ['r1']);
  });

  it('caps dependsOn length at DEPENDS_ON_LIMIT', () => {
    const sibs = Array.from({ length: 8 }, (_v, i) => it_(`s${String(i)}`));
    const deps = sibs.map((s) => s.id);
    const out = normalizeRoadmapRelations([it_('r1', { dependsOn: deps }), ...sibs]);
    assert.equal(out[0]?.dependsOn?.length, DEPENDS_ON_LIMIT);
  });

  it('strips edges that would form a CYCLE (degrade, never deadlock)', () => {
    // r1→r2→r1 is a 2-cycle. The peel orders neither; both get their cyclic edges stripped.
    const out = normalizeRoadmapRelations([
      it_('r1', { dependsOn: ['r2'] }),
      it_('r2', { dependsOn: ['r1'] }),
    ]);
    // Neither item ends up with a dependency edge back into the cycle.
    assert.ok(out[0]?.dependsOn === undefined || !out[0].dependsOn.includes('r2'));
    assert.ok(out[1]?.dependsOn === undefined || !out[1].dependsOn.includes('r1'));
  });

  it('keeps an honest acyclic chain intact', () => {
    const out = normalizeRoadmapRelations([
      it_('r1'),
      it_('r2', { dependsOn: ['r1'] }),
      it_('r3', { dependsOn: ['r2'] }),
    ]);
    assert.deepEqual(out[1]?.dependsOn, ['r1']);
    assert.deepEqual(out[2]?.dependsOn, ['r2']);
  });

  it('parentId must reference an existing sibling that is NOT itself a child (depth=1)', () => {
    // c → p is fine; gc → c is over-depth (c is itself a child) → dropped.
    const out = normalizeRoadmapRelations([
      it_('p'),
      it_('c', { parentId: 'p' }),
      it_('gc', { parentId: 'c' }),
    ]);
    assert.equal(out[1]?.parentId, 'p');
    assert.ok(out[2]?.parentId === undefined, 'grandchild parent dropped (over-depth)');
  });

  it('drops a parentId pointing at an unknown id', () => {
    const out = normalizeRoadmapRelations([it_('r1', { parentId: 'ghost' })]);
    assert.ok(out[0]?.parentId === undefined);
  });

  it('capContract round-trips the new fields through normalization', () => {
    const contract: WorkContract = {
      version: 1,
      objective: 'o',
      roadmap: [
        { id: 'r1', text: 'a', status: 'pending' },
        { id: 'r2', text: 'b', status: 'pending', dependsOn: ['r1'], parentId: 'r1' },
      ],
    };
    const capped = capContract(contract);
    assert.deepEqual(capped.roadmap?.[1]?.dependsOn, ['r1']);
    assert.equal(capped.roadmap?.[1]?.parentId, 'r1');
  });

  it('capContract preserves valid intentVersionId', () => {
    const c = capContract({ version: 1, objective: 'task', intentVersionId: 'iv-1' });
    assert.equal(c.intentVersionId, 'iv-1');
  });

  it('capContract drops blank intentVersionId', () => {
    const c = capContract({ version: 1, objective: 'task', intentVersionId: '' });
    assert.equal('intentVersionId' in c, false);
  });

  it('stampContractIntentVersion adds id only when provided', () => {
    const c: WorkContract = { version: 1, objective: 'task' };
    // undefined id → unchanged
    const unchanged = stampContractIntentVersion(c, undefined);
    assert.equal('intentVersionId' in (unchanged ?? {}), false);
    // non-empty id → stamped
    const stamped = stampContractIntentVersion(c, 'iv-2');
    assert.equal(stamped?.intentVersionId, 'iv-2');
    // undefined contract → undefined
    assert.equal(stampContractIntentVersion(undefined, 'iv-3'), undefined);
    // empty id → unchanged
    const empty = stampContractIntentVersion(c, '');
    assert.equal('intentVersionId' in (empty ?? {}), false);
  });
});
