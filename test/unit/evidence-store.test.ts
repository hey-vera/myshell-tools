import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvidence,
  appendEvidenceV2,
  InvalidEvidenceTaskIdError,
  readEvidence,
} from '../../src/infra/evidence-store.ts';
import {
  normalizeEvidenceSnapshotV1,
  type ConfidenceLabel,
  type EvidenceSnapshotV1,
  type EvidenceSnapshotV2,
} from '../../src/core/evidence.ts';
import { defaultStateLayout, projectStateDirs } from '../../src/infra/state-layout.ts';
import { withStateHome } from '../with-state-home.ts';

function makeSnapshot(overrides: Partial<EvidenceSnapshotV1> = {}): EvidenceSnapshotV1 {
  return {
    taskId: 'task_1',
    turnNumber: 1,
    filesReadPre: [{ path: 'src/core/types.ts', hash: 'sha256:read-before' }],
    filesWritten: [
      {
        path: 'src/core/evidence.ts',
        hashBefore: 'sha256:before',
        hashAfter: 'sha256:after',
      },
    ],
    commandsRun: [
      {
        command: 'node --test test/unit/evidence-store.test.ts',
        tier: 'test-build',
        confirmed: true,
        outcome: 'success',
      },
    ],
    conclusionsReached: ['evidence snapshots round-trip'],
    confidenceLabel: 'verified-by-tests',
    providerMode: 'solo',
    providersAttempted: ['codex'],
    providersSucceeded: ['codex'],
    providersFailed: [{ provider: 'reviewer', reason: 'not configured' }],
    timestamp: 1_718_000_000_000,
    ...overrides,
  };
}

function makeV2Snapshot(overrides: Partial<EvidenceSnapshotV2> = {}): EvidenceSnapshotV2 {
  return {
    version: 2 as const,
    taskId: 'task_1',
    turnNumber: 1,
    filesWritten: [{ path: 'src/core/evidence.ts', hashBefore: 'sha256:before', hashAfter: 'sha256:after' }],
    commandsRun: [
      {
        command: 'node --test test/unit/evidence-store.test.ts',
        tier: 'test-build',
        confirmed: true,
        outcome: 'success',
      },
    ],
    conclusionsReached: ['evidence snapshots round-trip'],
    confidenceLabel: 'verified-by-tests',
    providerMode: 'solo',
    providersSucceeded: ['codex'],
    timestamp: 1_718_000_000_000,
    ...overrides,
  };
}

function evidencePath(homeDir: string, taskId: string): string {
  return join(projectStateDirs(defaultStateLayout(), homeDir).evidenceDir, `${taskId}.jsonl`);
}

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), `evidence-test-${randomUUID()}-`));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('normalizeEvidenceSnapshotV1', () => {
  it('returns a normalized snapshot for the frozen shape', () => {
    const snapshot = makeSnapshot();
    assert.deepEqual(normalizeEvidenceSnapshotV1(snapshot), snapshot);
  });

  it('returns null when a required field is missing', () => {
    const { timestamp: _timestamp, ...missingTimestamp } = makeSnapshot();
    assert.equal(normalizeEvidenceSnapshotV1(missingTimestamp), null);
  });
});

describe('evidence-store', () => {
  it('appends and reads full snapshots with fields intact', async () => {
    await withStateHome(homeDir, async () => {
    const first = makeSnapshot({ turnNumber: 1 });
    const reviewed: ConfidenceLabel = 'reviewed';
    const second = makeSnapshot({
      turnNumber: 2,
      filesReadPre: [{ path: 'README.md', hash: 'sha256:readme' }],
      conclusionsReached: ['second snapshot'],
      confidenceLabel: reviewed,
      providerMode: 'multi',
      providersAttempted: ['codex', 'claude'],
      providersSucceeded: ['codex'],
      providersFailed: [{ provider: 'claude', reason: 'timeout' }],
      timestamp: 1_718_000_000_001,
    });

    await appendEvidence(homeDir, first);
    await appendEvidence(homeDir, second);

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.deepEqual(snapshots, [first, second]);
    assert.equal(snapshots[0]?.commandsRun[0]?.tier, 'test-build');
    });
  });

  it('compacts 35 turns to the newest 30 by turnNumber', async () => {
    await withStateHome(homeDir, async () => {
    for (let turnNumber = 1; turnNumber <= 35; turnNumber += 1) {
      await appendEvidence(
        homeDir,
        makeSnapshot({
          turnNumber,
          timestamp: 1_718_000_000_000 + turnNumber,
          conclusionsReached: [`turn ${turnNumber}`],
        }),
      );
    }

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.equal(snapshots.length, 30);
    assert.equal(snapshots[0]?.turnNumber, 6);
    assert.equal(snapshots.at(-1)?.turnNumber, 35);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.turnNumber),
      Array.from({ length: 30 }, (_, index) => index + 6),
    );
    });
  });

  it('skips malformed JSONL lines on read', async () => {
    await withStateHome(homeDir, async () => {
    const snapshot = makeSnapshot();
    await appendEvidence(homeDir, snapshot);
    await appendFile(evidencePath(homeDir, 'task_1'), 'NOT JSON\n', 'utf8');

    assert.deepEqual(await readEvidence(homeDir, 'task_1'), [snapshot]);
    });
  });

  it('throws a guard error for invalid task ids', async () => {
    await assert.rejects(readEvidence(homeDir, '../etc'), InvalidEvidenceTaskIdError);
    await assert.rejects(
      appendEvidence(homeDir, makeSnapshot({ taskId: '../etc' })),
      InvalidEvidenceTaskIdError,
    );
    await assert.rejects(
      appendEvidenceV2(homeDir, makeV2Snapshot({ taskId: '../etc' })),
      InvalidEvidenceTaskIdError,
    );
  });

  it('mixed V1 and V2 lanes merge in chronological order', async () => {
    await withStateHome(homeDir, async () => {
    await appendEvidence(homeDir, makeSnapshot({ turnNumber: 1, timestamp: 100 }));
    await appendEvidenceV2(homeDir, makeV2Snapshot({ turnNumber: 2, timestamp: 200 }));
    await appendEvidence(homeDir, makeSnapshot({ turnNumber: 3, timestamp: 300 }));

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[0]!.turnNumber, 1);
    assert.equal(snapshots[1]!.turnNumber, 2);
    assert.equal(snapshots[2]!.turnNumber, 3);
    });
  });

  it('exact V1/V2 collision prefers V2', async () => {
    await withStateHome(homeDir, async () => {
    await appendEvidence(homeDir, makeSnapshot({ turnNumber: 1, timestamp: 100, conclusionsReached: ['v1'] }));
    await appendEvidenceV2(homeDir, makeV2Snapshot({ turnNumber: 1, timestamp: 100, conclusionsReached: ['v2'] }));

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]!.conclusionsReached[0], 'v2');
    });
  });

  it('V2 compaction keeps newest 30 without rewriting V1', async () => {
    await withStateHome(homeDir, async () => {
    for (let turnNumber = 1; turnNumber <= 35; turnNumber += 1) {
      await appendEvidenceV2(
        homeDir,
        makeV2Snapshot({ turnNumber, timestamp: 1_718_000_000_000 + turnNumber }),
      );
    }
    await appendEvidence(homeDir, makeSnapshot({ turnNumber: 36, timestamp: 1_718_000_000_036, conclusionsReached: ['v1-last'] }));

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.equal(snapshots.length, 30);

    const v1Last = snapshots.find((s) => (s as EvidenceSnapshotV2).version !== 2 && s.conclusionsReached[0] === 'v1-last');
    assert.notEqual(v1Last, undefined);
    });
  });

  it('simulated old V1 compaction cannot erase V2', async () => {
    await withStateHome(homeDir, async () => {
    for (let turnNumber = 1; turnNumber <= 35; turnNumber += 1) {
      await appendEvidence(homeDir, makeSnapshot({ turnNumber, timestamp: turnNumber, conclusionsReached: [`v1-${turnNumber}`] }));
    }
    await appendEvidenceV2(homeDir, makeV2Snapshot({ turnNumber: 40, timestamp: 40000, conclusionsReached: ['v2-row'] }));

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.equal(snapshots.length, 30);

    const v2Row = snapshots.find((s) => (s as EvidenceSnapshotV2).version === 2);
    assert.notEqual(v2Row, undefined);
    });
  });

  it('malformed V2 tail does not hide V1 or prior V2 rows', async () => {
    await withStateHome(homeDir, async () => {
    await appendEvidence(homeDir, makeSnapshot({ turnNumber: 1, timestamp: 100, conclusionsReached: ['v1'] }));
    await appendEvidenceV2(homeDir, makeV2Snapshot({ turnNumber: 2, timestamp: 200, conclusionsReached: ['v2-good'] }));

    const v2Path = join(projectStateDirs(defaultStateLayout(), homeDir).evidenceDir, 'v2', 'task_1.jsonl');
    await appendFile(v2Path, 'NOT JSON\n', 'utf8');

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.equal(snapshots.length, 2);
    const v2Good = snapshots.find((s) => (s as EvidenceSnapshotV2).version === 2);
    assert.notEqual(v2Good, undefined);
    const v1Row = snapshots.find((s) => (s as EvidenceSnapshotV2).version !== 2);
    assert.notEqual(v1Row, undefined);
    });
  });

  it('production V2 sink round-trips sparse record from V2 lane', async () => {
    await withStateHome(homeDir, async () => {
    const sparse: EvidenceSnapshotV2 = {
      version: 2 as const,
      taskId: 'task_1',
      turnNumber: 5,
      filesWritten: [{ path: 'src/a.ts' }],
      commandsRun: [],
      conclusionsReached: ['sparse round-trip'],
      confidenceLabel: 'reviewed',
      providerMode: 'solo',
      providersSucceeded: ['claude'],
      timestamp: 1_720_000_000_000,
    };

    await appendEvidenceV2(homeDir, sparse);

    const snapshots = await readEvidence(homeDir, 'task_1');
    assert.equal(snapshots.length, 1);
    const round = snapshots[0] as EvidenceSnapshotV2;
    assert.equal(round.version, 2);
    assert.equal(round.taskId, 'task_1');
    assert.equal(round.turnNumber, 5);
    assert.equal(round.conclusionsReached[0], 'sparse round-trip');
    assert.equal(round.confidenceLabel, 'reviewed');
    assert.equal(round.providerMode, 'solo');
    assert.deepEqual(round.providersSucceeded, ['claude']);
    assert.equal(round.filesWritten.length, 1);
    assert.equal(round.filesWritten[0]?.path, 'src/a.ts');
    assert.equal(Object.hasOwn(round, 'filesReadPre'), false);
    assert.equal(Object.hasOwn(round, 'providersAttempted'), false);
    assert.equal(Object.hasOwn(round, 'providersFailed'), false);
    });
  });
});
