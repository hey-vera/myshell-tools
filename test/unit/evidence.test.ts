import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildSnapshotFromVerify,
  normalizeEvidenceSnapshotV1,
  normalizeEvidenceSnapshotV2,
  type BuildSnapshotFromVerifyInput,
  type EvidenceFileWriteV2,
  type EvidenceSnapshotV2,
} from '../../src/core/evidence.ts';
import type { VerifyOutcome } from '../../src/core/verify.ts';

function outcome(
  verified: VerifyOutcome['verified'],
  over: Partial<VerifyOutcome> = {},
): VerifyOutcome {
  return { verified, changedFiles: 1, changedPaths: ['src/a.ts'], ...over };
}

function input(over: Partial<BuildSnapshotFromVerifyInput> = {}): BuildSnapshotFromVerifyInput {
  return {
    taskId: 'task_1',
    turnNumber: 2,
    verifyOutcome: outcome('passing', {
      testCommand: 'npm test',
      testRun: { outcome: 'green', output: 'ok', durationMs: 5 },
    }),
    providersAttempted: ['claude', 'codex'],
    providersSucceeded: ['claude'],
    providersFailed: [],
    filesWritten: [{ path: 'src/a.ts', hashAfter: 'sha256:after' }],
    commandsRun: [{
      command: 'npm test',
      tier: 'test-build',
      confirmed: true,
      outcome: 'success',
    }],
    conclusionsReached: ['verify:passing'],
    timestamp: 123,
    ...over,
  };
}

describe('buildSnapshotFromVerify', () => {
  it('maps verify states to confidence labels, including independent approval', () => {
    const cases = [
      {
        verifyOutcome: outcome('passing', {
          critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
        }),
        expected: 'verified-by-tests-and-independent-review',
      },
      {
        verifyOutcome: outcome('passing'),
        expected: 'verified-by-tests',
      },
      {
        verifyOutcome: outcome('reviewed', {
          critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
        }),
        expected: 'reviewed',
      },
      {
        verifyOutcome: outcome('unverified', { note: 'no test command detected' }),
        expected: 'not-verified',
      },
      {
        verifyOutcome: outcome('failing', {
          testCommand: 'npm test',
          testRun: { outcome: 'red', output: 'FAIL', durationMs: 5 },
        }),
        expected: 'not-verified',
      },
    ] as const;

    for (const testCase of cases) {
      const snapshot = buildSnapshotFromVerify(input({ verifyOutcome: testCase.verifyOutcome }));
      assert.equal(snapshot.confidenceLabel, testCase.expected);
    }
  });

  it('caps passing independent-review confidence at reviewed in solo mode', () => {
    const snapshot = buildSnapshotFromVerify(input({
      providerMode: 'solo',
      verifyOutcome: outcome('passing', {
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
    }));

    assert.equal(snapshot.providerMode, 'solo');
    assert.equal(snapshot.confidenceLabel, 'reviewed');
  });

  it('derives providerMode from provider and critic evidence', () => {
    assert.equal(
      buildSnapshotFromVerify(input({
        providersAttempted: [],
        providersSucceeded: [],
        providersFailed: [],
      })).providerMode,
      'zero',
    );
    assert.equal(
      buildSnapshotFromVerify(input({
        providersAttempted: ['claude'],
        providersSucceeded: ['claude'],
        providersFailed: [],
      })).providerMode,
      'solo',
    );
    assert.equal(
      buildSnapshotFromVerify(input({
        providersAttempted: ['claude'],
        providersSucceeded: ['claude'],
        verifyOutcome: outcome('passing', {
          critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
        }),
      })).providerMode,
      'multi',
    );
  });

  it('passes changed files through as filesWritten and freezes the snapshot', () => {
    const filesWritten: EvidenceFileWriteV2[] = [{ path: 'src/core/evidence.ts', hashAfter: 'sha256:x' }];
    const snapshot = buildSnapshotFromVerify(input({ filesWritten }));

    assert.deepEqual(snapshot.filesWritten, filesWritten);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.filesWritten), true);
  });
  it('omits absent optional keys from V2 output', () => {
    const snapshot = buildSnapshotFromVerify({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing', { note: 'done' }),
      providersSucceeded: ['claude'],
      filesWritten: [],
      commandsRun: [],
      conclusionsReached: ['done'],
    });
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.taskId, 'task_1');
    assert.equal(Object.hasOwn(snapshot, 'filesReadPre'), false);
    assert.equal(Object.hasOwn(snapshot, 'providersAttempted'), false);
    assert.equal(Object.hasOwn(snapshot, 'providersFailed'), false);
  });

  it('succeeded provider with attempts absent derives solo not zero', () => {
    const snapshot = buildSnapshotFromVerify({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing'),
      providersSucceeded: ['claude'],
      filesWritten: [],
      commandsRun: [],
      conclusionsReached: ['done'],
    });
    assert.equal(snapshot.providerMode, 'solo');
  });

  it('independent critic with attempts absent derives multi', () => {
    const snapshot = buildSnapshotFromVerify({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing', {
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
      providersSucceeded: ['claude'],
      filesWritten: [],
      commandsRun: [],
      conclusionsReached: ['done'],
    });
    assert.equal(snapshot.providerMode, 'multi');
  });

  it('zero requires no observed provider', () => {
    const snapshot = buildSnapshotFromVerify({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('unverified', { note: 'no provider ran' }),
      providersSucceeded: [],
      filesWritten: [],
      commandsRun: [],
      conclusionsReached: ['done'],
    });
    assert.equal(snapshot.providerMode, 'zero');
  });
});

describe('normalizeEvidenceSnapshotV2', () => {
  function v2(over: Partial<EvidenceSnapshotV2> = {}): EvidenceSnapshotV2 {
    return {
      version: 2 as const,
      taskId: 'task_1',
      turnNumber: 1,
      filesWritten: [{ path: 'src/a.ts', hashBefore: 'sha256:before', hashAfter: 'sha256:after' }],
      commandsRun: [{ command: 'npm test', tier: 'test-build', confirmed: true, outcome: 'success' }],
      conclusionsReached: ['done'],
      confidenceLabel: 'verified-by-tests',
      providerMode: 'solo',
      providersSucceeded: ['claude'],
      timestamp: 1000,
      ...over,
    };
  }

  it('accepts omitted unknown fields', () => {
    const raw = {
      version: 2,
      taskId: 'task_1',
      turnNumber: 1,
      filesWritten: [{ path: 'src/a.ts', hashBefore: 'sha256:before', hashAfter: 'sha256:after' }],
      commandsRun: [{ command: 'npm test', tier: 'test-build', confirmed: true, outcome: 'success' }],
      conclusionsReached: ['done'],
      confidenceLabel: 'verified-by-tests',
      providerMode: 'solo',
      providersSucceeded: ['claude'],
      timestamp: 1000,
      extraField: 'ignored',
      anotherUnknown: 42,
    };
    const result = normalizeEvidenceSnapshotV2(raw);
    assert.notEqual(result, null);
    assert.equal(result!.version, 2);
    assert.equal(result!.taskId, 'task_1');
  });

  it('rejects present empty hashes', () => {
    assert.equal(
      normalizeEvidenceSnapshotV2({
        version: 2,
        taskId: 'task_1',
        turnNumber: 1,
        filesWritten: [{ path: 'src/a.ts', hashBefore: '', hashAfter: 'sha256:after' }],
        commandsRun: [{ command: 'npm test', tier: 'test-build', confirmed: true, outcome: 'success' }],
        conclusionsReached: ['done'],
        confidenceLabel: 'verified-by-tests',
        providerMode: 'solo',
        providersSucceeded: ['claude'],
        timestamp: 1000,
      }),
      null,
    );

    assert.equal(
      normalizeEvidenceSnapshotV2({
        version: 2,
        taskId: 'task_1',
        turnNumber: 1,
        filesWritten: [{ path: 'src/a.ts', hashBefore: 'sha256:before', hashAfter: '' }],
        commandsRun: [{ command: 'npm test', tier: 'test-build', confirmed: true, outcome: 'success' }],
        conclusionsReached: ['done'],
        confidenceLabel: 'verified-by-tests',
        providerMode: 'solo',
        providersSucceeded: ['claude'],
        timestamp: 1000,
      }),
      null,
    );

    assert.equal(
      normalizeEvidenceSnapshotV2({
        version: 2,
        taskId: 'task_1',
        turnNumber: 1,
        filesReadPre: [{ path: 'src/b.ts', hash: '' }],
        filesWritten: [{ path: 'src/a.ts' }],
        commandsRun: [{ command: 'npm test', tier: 'test-build', confirmed: true, outcome: 'success' }],
        conclusionsReached: ['done'],
        confidenceLabel: 'verified-by-tests',
        providerMode: 'solo',
        providersSucceeded: ['claude'],
        timestamp: 1000,
      }),
      null,
    );

    const valid = normalizeEvidenceSnapshotV2(v2());
    assert.notEqual(valid, null);
  });

  it('accepts omitted optional fields', () => {
    const result = normalizeEvidenceSnapshotV2({
      version: 2,
      taskId: 'task_1',
      turnNumber: 1,
      filesWritten: [{ path: 'src/a.ts' }],
      commandsRun: [{ command: 'npm test', tier: 'test-build', confirmed: true, outcome: 'success' }],
      conclusionsReached: ['done'],
      confidenceLabel: 'verified-by-tests',
      providerMode: 'solo',
      providersSucceeded: ['claude'],
      timestamp: 1000,
    });
    assert.notEqual(result, null);
    assert.equal(result!.filesReadPre, undefined);
    assert.equal(result!.providersAttempted, undefined);
    assert.equal(result!.providersFailed, undefined);
  });
});

describe('normalizeEvidenceSnapshotV1', () => {
  it('keeps legacy empty hashes readable', () => {
    const result = normalizeEvidenceSnapshotV1({
      taskId: 'task_1',
      turnNumber: 1,
      filesReadPre: [{ path: 'src/a.ts', hash: '' }],
      filesWritten: [{ path: 'src/b.ts', hashBefore: '', hashAfter: '' }],
      commandsRun: [{ command: 'npm test', tier: 'test-build', confirmed: true, outcome: 'success' }],
      conclusionsReached: ['done'],
      confidenceLabel: 'verified-by-tests',
      providerMode: 'solo',
      providersAttempted: ['claude'],
      providersSucceeded: ['claude'],
      providersFailed: [],
      timestamp: 1000,
    });
    assert.notEqual(result, null);
    assert.equal(result!.filesReadPre[0]!.hash, '');
    assert.equal(result!.filesWritten[0]!.hashBefore, '');
    assert.equal(result!.filesWritten[0]!.hashAfter, '');
  });
});
