import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshotFromVerify, type BuildSnapshotFromVerifyInput } from '../../src/core/evidence.ts';
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
    filesWritten: [{ path: 'src/a.ts', hashBefore: '', hashAfter: 'sha256:after' }],
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
    const filesWritten = [{ path: 'src/core/evidence.ts', hashBefore: '', hashAfter: 'sha256:x' }];
    const snapshot = buildSnapshotFromVerify(input({ filesWritten }));

    assert.deepEqual(snapshot.filesWritten, filesWritten);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.filesWritten), true);
  });
});
