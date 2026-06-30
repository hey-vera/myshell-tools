import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvidence,
  InvalidEvidenceTaskIdError,
  readEvidence,
} from '../../src/infra/evidence-store.ts';
import {
  normalizeEvidenceSnapshot,
  type ConfidenceLabel,
  type EvidenceSnapshot,
} from '../../src/core/evidence.ts';
import { defaultStateLayout, projectStateDirs } from '../../src/infra/state-layout.ts';
import { withStateHome } from '../with-state-home.ts';

function makeSnapshot(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
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

describe('normalizeEvidenceSnapshot', () => {
  it('returns a normalized snapshot for the frozen shape', () => {
    const snapshot = makeSnapshot();
    assert.deepEqual(normalizeEvidenceSnapshot(snapshot), snapshot);
  });

  it('returns null when a required field is missing', () => {
    const { timestamp: _timestamp, ...missingTimestamp } = makeSnapshot();
    assert.equal(normalizeEvidenceSnapshot(missingTimestamp), null);
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
  });
});
