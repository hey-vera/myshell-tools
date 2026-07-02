import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEvidenceSnapshotBuilder } from '../../src/infra/evidence-sink.ts';
import type { VerifyOutcome } from '../../src/core/verify.ts';

function outcome(
  verified: VerifyOutcome['verified'],
  over: Partial<VerifyOutcome> = {},
): VerifyOutcome {
  return { verified, changedFiles: 1, changedPaths: ['src/a.ts'], ...over };
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), `evidence-sink-test-${randomUUID()}-`));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('evidence-sink builder', () => {
  it('available providers are not recorded as attempted', async () => {
    const builder = createEvidenceSnapshotBuilder({ cwd, now: () => 1000 });
    const snapshot = await builder({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing'),
      provider: 'claude',
      availableProviders: ['claude', 'codex'],
      conclusionsReached: ['done'],
    });
    assert.equal(Object.hasOwn(snapshot, 'providersAttempted'), false);
  });

  it('unknown failed providers and pre-reads are omitted', async () => {
    const builder = createEvidenceSnapshotBuilder({ cwd, now: () => 1000 });
    const snapshot = await builder({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing'),
      provider: 'claude',
      availableProviders: ['claude'],
      conclusionsReached: ['done'],
    });
    assert.equal(Object.hasOwn(snapshot, 'providersFailed'), false);
    assert.equal(Object.hasOwn(snapshot, 'filesReadPre'), false);
  });

  it('readable changed file records only nonempty hashAfter', async () => {
    const filePath = 'src/hello.ts';
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, filePath), 'content');
    const builder = createEvidenceSnapshotBuilder({ cwd, now: () => 1000 });
    const snapshot = await builder({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing', { changedPaths: [filePath] }),
      provider: 'claude',
      availableProviders: ['claude'],
      conclusionsReached: ['done'],
    });
    assert.equal(snapshot.filesWritten.length, 1);
    const fw = snapshot.filesWritten[0];
    assert.equal(fw?.path, filePath);
    assert.equal(Object.hasOwn(fw, 'hashBefore'), false);
    assert.equal(typeof fw?.hashAfter, 'string');
    assert.notEqual(fw?.hashAfter, '');
  });

  it('deleted or out-of-root path omits both hashes', async () => {
    const builder = createEvidenceSnapshotBuilder({ cwd, now: () => 1000 });
    const snapshot = await builder({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing', { changedPaths: ['nonexistent.ts'] }),
      provider: 'claude',
      availableProviders: ['claude'],
      conclusionsReached: ['done'],
    });
    assert.equal(snapshot.filesWritten.length, 1);
    const fw = snapshot.filesWritten[0];
    assert.equal(fw?.path, 'nonexistent.ts');
    assert.equal(Object.hasOwn(fw, 'hashBefore'), false);
    assert.equal(Object.hasOwn(fw, 'hashAfter'), false);
  });

  it('critic vendor is succeeded only when critic exists', async () => {
    const builder = createEvidenceSnapshotBuilder({ cwd, now: () => 1000 });

    const withoutCritic = await builder({
      taskId: 'task_1',
      turnNumber: 1,
      verifyOutcome: outcome('passing'),
      provider: 'claude',
      availableProviders: ['claude'],
      conclusionsReached: ['done'],
    });
    assert.deepEqual(withoutCritic.providersSucceeded, ['claude']);

    const withCritic = await builder({
      taskId: 'task_1',
      turnNumber: 2,
      verifyOutcome: outcome('passing', {
        critic: { vendor: 'codex', sameVendor: false, parsed: true, verdict: 'approve' },
      }),
      provider: 'claude',
      availableProviders: ['claude', 'codex'],
      conclusionsReached: ['done'],
    });
    assert.deepEqual(withCritic.providersSucceeded, ['claude', 'codex']);
  });
});
