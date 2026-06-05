/**
 * Unit tests for src/core/work-contract.ts.
 * Run with: node --import ./test/register.mjs --test "test/unit/work-contract.test.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCheckpointFromContinue,
  capContract,
  renderContractForPrompt,
  shouldMaterializeContract,
  type Checkpoint,
  type ContractVerification,
  type RoadmapItem,
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
        verdict: 'approve',
        notes: '4',
        failedCheckpointIds: ['1'],
      },
    });
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
    assert.match(rendered, /CHECKPOINTS SO FAR:\n- c1 \(r1\): tests pass/);
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
