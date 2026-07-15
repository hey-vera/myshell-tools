/**
 * Pure helpers for detached goal jobs (multi-chat PR-D).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  ACTIVE_GOAL_JOB_STATUSES,
  applyClaim,
  applyReleaseForHandoff,
  applyRenewLease,
  applyRunning,
  applyTerminal,
  beginTuiExitHandoff,
  canClaimGoalJob,
  classifyGoalJobForReopen,
  createPendingGoalJob,
  DEFAULT_GOAL_JOB_LEASE_TTL_MS,
  formatExitHandoffReopenMessages,
  goalJobConversationDir,
  goalJobFilePath,
  isActiveGoalJob,
  isGoalJobStatus,
  isLeaseExpired,
  isLeaseHeld,
  isOwnedByPid,
  isSafeJobSegment,
  isTerminalGoalJob,
  isTuiExitHandoffActive,
  parseGoalJob,
  parseWorkerPidFile,
  resetTuiExitHandoffForTests,
  serializeGoalJob,
  serializeWorkerPidFile,
  workerPidFilePath,
  zombieRunningGoalIdsWithJobs,
  type GoalJob,
} from '../../src/infra/goal-job.ts';

const NOW = '2026-07-10T12:00:00.000Z';

function sampleJob(overrides: Partial<GoalJob> = {}): GoalJob {
  return {
    version: 1,
    conversationId: 'conv_abc',
    goalId: 'goal_xyz',
    work: 'Ship the feature',
    title: 'Ship the feature',
    cwd: '/tmp/proj',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('isSafeJobSegment', () => {
  it('accepts normal ids', () => {
    assert.equal(isSafeJobSegment('goal_abc123'), true);
    assert.equal(isSafeJobSegment('conv-1'), true);
  });

  it('rejects empty, traversal, separators', () => {
    assert.equal(isSafeJobSegment(''), false);
    assert.equal(isSafeJobSegment('..'), false);
    assert.equal(isSafeJobSegment('a/b'), false);
    assert.equal(isSafeJobSegment('a\\b'), false);
    assert.equal(isSafeJobSegment('x\0y'), false);
  });
});

describe('goalJobFilePath / dirs', () => {
  it('builds stable paths', () => {
    const root = join('/state', 'goal-jobs');
    assert.equal(
      goalJobFilePath(root, 'conv1', 'goal_1'),
      join(root, 'conv1', 'goal_1.json'),
    );
    assert.equal(goalJobConversationDir(root, 'conv1'), join(root, 'conv1'));
    assert.equal(workerPidFilePath(root), join(root, 'worker.pid'));
  });

  it('throws on unsafe segments', () => {
    assert.throws(() => goalJobFilePath('/r', '../x', 'goal_1'));
    assert.throws(() => goalJobFilePath('/r', 'conv', 'a/b'));
  });
});

describe('parseGoalJob / serializeGoalJob', () => {
  it('round-trips a valid job', () => {
    const job = sampleJob({ owner: 'tui', claimedBy: 42, note: 'ok' });
    const parsed = parseGoalJob(JSON.parse(serializeGoalJob(job)));
    assert.deepEqual(parsed, job);
  });

  it('rejects secrets-shaped garbage and bad version', () => {
    assert.equal(parseGoalJob(null), null);
    assert.equal(parseGoalJob({ version: 2 }), null);
    assert.equal(
      parseGoalJob({
        version: 1,
        conversationId: 'c',
        goalId: 'g',
        // missing work/title/cwd/status/timestamps
      }),
      null,
    );
  });

  it('caps note length', () => {
    const long = 'n'.repeat(600);
    const parsed = parseGoalJob({
      ...sampleJob(),
      note: long,
    });
    assert.ok(parsed);
    assert.equal(parsed!.note?.length, 500);
  });

  it('isGoalJobStatus covers lifecycle', () => {
    assert.equal(isGoalJobStatus('pending'), true);
    assert.equal(isGoalJobStatus('running'), true);
    assert.equal(isGoalJobStatus('bogus'), false);
  });
});

describe('createPendingGoalJob + transitions', () => {
  it('creates pending job', () => {
    const job = createPendingGoalJob({
      conversationId: 'conv1',
      goalId: 'goal_1',
      work: 'do it',
      title: 'Do it',
      cwd: '/w',
      nowIso: NOW,
    });
    assert.equal(job.status, 'pending');
    assert.equal(job.version, 1);
    assert.equal(isActiveGoalJob(job), true);
    assert.equal(isTerminalGoalJob(job), false);
  });

  it('applyClaim / applyRunning / applyTerminal', () => {
    const pending = sampleJob();
    const claimed = applyClaim(pending, 99, 'worker', '2026-07-10T12:01:00.000Z', {
      leaseId: 'lease-abc',
    });
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.claimedBy, 99);
    assert.equal(claimed.owner, 'worker');
    assert.equal(claimed.leaseId, 'lease-abc');
    assert.equal(claimed.leaseGeneration, 1);
    assert.ok(claimed.leaseExpiresAt);
    const claimMs = Date.parse('2026-07-10T12:01:00.000Z');
    assert.equal(
      Date.parse(claimed.leaseExpiresAt!),
      claimMs + DEFAULT_GOAL_JOB_LEASE_TTL_MS,
    );
    const running = applyRunning(claimed, '2026-07-10T12:02:00.000Z', 'heartbeat');
    assert.equal(running.status, 'running');
    assert.equal(running.note, 'heartbeat');
    const done = applyTerminal(running, 'done', '2026-07-10T12:03:00.000Z');
    assert.equal(done.status, 'done');
    assert.equal(isTerminalGoalJob(done), true);
    assert.equal(ACTIVE_GOAL_JOB_STATUSES.has('pending'), true);
  });

  it('applyClaim bumps leaseGeneration on reclaim', () => {
    const first = applyClaim(sampleJob(), 1, 'tui', NOW, { leaseId: 'L1' });
    const second = applyClaim(first, 2, 'worker', '2026-07-10T12:01:00.000Z', {
      leaseId: 'L2',
    });
    assert.equal(second.leaseGeneration, 2);
    assert.equal(second.leaseId, 'L2');
    assert.equal(second.claimedBy, 2);
  });

  it('applyReleaseForHandoff clears ownership and lease fence', () => {
    const running = sampleJob({
      status: 'running',
      owner: 'tui',
      claimedBy: 42,
      claimedAt: NOW,
      note: 'tui in-process',
      leaseId: 'lease-tui',
      leaseGeneration: 3,
      leaseExpiresAt: '2026-07-10T12:10:00.000Z',
    });
    const released = applyReleaseForHandoff(running, '2026-07-10T12:05:00.000Z');
    assert.equal(released.status, 'pending');
    assert.equal(released.owner, undefined);
    assert.equal(released.claimedBy, undefined);
    assert.equal(released.claimedAt, undefined);
    assert.equal(released.leaseId, undefined);
    assert.equal(released.leaseGeneration, undefined);
    assert.equal(released.leaseExpiresAt, undefined);
    assert.match(released.note ?? '', /handoff/);
    assert.equal(canClaimGoalJob(released, () => true), true);
    assert.equal(isOwnedByPid(running, 42, 'tui'), true);
    assert.equal(isOwnedByPid(released, 42, 'tui'), false);
  });
});

describe('exit handoff reopen messaging', () => {
  it('classifies worker-running / pending / parked', () => {
    assert.equal(
      classifyGoalJobForReopen(sampleJob({ status: 'running', owner: 'worker' })),
      'worker-running',
    );
    assert.equal(classifyGoalJobForReopen(sampleJob({ status: 'pending' })), 'pending-handoff');
    assert.equal(classifyGoalJobForReopen(sampleJob({ status: 'parked' })), 'parked-job');
    assert.equal(
      classifyGoalJobForReopen(sampleJob({ status: 'running', owner: 'tui' })),
      'other-active',
    );
  });

  it('formats distinct reopen lines for heal / worker / parked', () => {
    const lines = formatExitHandoffReopenMessages({
      healedOrphans: 1,
      workerRunning: 2,
      pendingHandoff: 1,
      parkedGoals: 3,
      storeRunning: 0,
    });
    assert.ok(lines.some((l) => l.includes('healed 1 orphaned')));
    assert.ok(lines.some((l) => l.includes('detached worker running 2')));
    assert.ok(lines.some((l) => l.includes('queued for detached worker')));
    assert.ok(lines.some((l) => l.includes('3 parked')));
  });

  it('tui exit handoff latch arms', () => {
    resetTuiExitHandoffForTests();
    assert.equal(isTuiExitHandoffActive(), false);
    beginTuiExitHandoff();
    assert.equal(isTuiExitHandoffActive(), true);
    resetTuiExitHandoffForTests();
    assert.equal(isTuiExitHandoffActive(), false);
  });
});

describe('canClaimGoalJob', () => {
  const alive = (pid: number) => pid === 1;
  const nowMs = Date.parse(NOW);

  it('allows pending always', () => {
    assert.equal(canClaimGoalJob(sampleJob(), alive, nowMs), true);
  });

  it('allows reclaim when owner is dead', () => {
    const job = sampleJob({
      status: 'running',
      claimedBy: 999,
      owner: 'tui',
      leaseId: 'L',
      leaseGeneration: 1,
      leaseExpiresAt: '2026-07-10T12:10:00.000Z',
    });
    assert.equal(canClaimGoalJob(job, alive, nowMs), true);
  });

  it('denies when owner is alive and lease unexpired', () => {
    const job = sampleJob({
      status: 'running',
      claimedBy: 1,
      owner: 'tui',
      leaseId: 'L',
      leaseGeneration: 1,
      leaseExpiresAt: '2026-07-10T12:10:00.000Z',
    });
    assert.equal(canClaimGoalJob(job, alive, nowMs), false);
  });

  it('allows reclaim when lease expired even if owner alive', () => {
    const job = sampleJob({
      status: 'running',
      claimedBy: 1,
      owner: 'worker',
      leaseId: 'L',
      leaseGeneration: 1,
      leaseExpiresAt: '2026-07-10T11:59:00.000Z',
    });
    assert.equal(canClaimGoalJob(job, alive, nowMs), true);
  });

  it('legacy job without lease: owner alive holds (PID-only)', () => {
    const job = sampleJob({ status: 'running', claimedBy: 1, owner: 'tui' });
    assert.equal(canClaimGoalJob(job, alive, nowMs), false);
  });

  it('denies terminal', () => {
    assert.equal(canClaimGoalJob(sampleJob({ status: 'done' }), alive, nowMs), false);
    assert.equal(canClaimGoalJob(sampleJob({ status: 'failed' }), alive, nowMs), false);
  });
});

describe('fenced lease helpers', () => {
  const claimIso = '2026-07-10T12:00:00.000Z';
  const claimMs = Date.parse(claimIso);

  it('isLeaseExpired / isLeaseHeld', () => {
    const job = applyClaim(sampleJob(), 7, 'worker', claimIso, { leaseId: 'fence-1' });
    assert.equal(isLeaseExpired(job, claimMs), false);
    assert.equal(isLeaseExpired(job, claimMs + DEFAULT_GOAL_JOB_LEASE_TTL_MS), true);
    assert.equal(
      isLeaseHeld(job, { leaseId: 'fence-1', leaseGeneration: 1 }, claimMs + 1_000),
      true,
    );
    assert.equal(
      isLeaseHeld(job, { leaseId: 'wrong', leaseGeneration: 1 }, claimMs + 1_000),
      false,
    );
    assert.equal(
      isLeaseHeld(job, { leaseId: 'fence-1', leaseGeneration: 2 }, claimMs + 1_000),
      false,
    );
  });

  it('applyRenewLease extends expiry; wrong generation fails', () => {
    const job = applyClaim(sampleJob(), 7, 'worker', claimIso, { leaseId: 'fence-1' });
    const renewIso = '2026-07-10T12:00:30.000Z';
    const renewed = applyRenewLease(
      job,
      { leaseId: 'fence-1', leaseGeneration: 1, pid: 7 },
      renewIso,
    );
    assert.ok(renewed);
    assert.equal(
      Date.parse(renewed!.leaseExpiresAt!),
      Date.parse(renewIso) + DEFAULT_GOAL_JOB_LEASE_TTL_MS,
    );

    const wrongGen = applyRenewLease(
      job,
      { leaseId: 'fence-1', leaseGeneration: 99, pid: 7 },
      renewIso,
    );
    assert.equal(wrongGen, null);

    const wrongId = applyRenewLease(
      job,
      { leaseId: 'other', leaseGeneration: 1, pid: 7 },
      renewIso,
    );
    assert.equal(wrongId, null);
  });

  it('parseGoalJob round-trips lease fields', () => {
    const job = sampleJob({
      leaseId: 'lease-x',
      leaseGeneration: 4,
      leaseExpiresAt: '2026-07-10T12:03:00.000Z',
      owner: 'worker',
      claimedBy: 9,
    });
    const parsed = parseGoalJob(JSON.parse(serializeGoalJob(job)));
    assert.deepEqual(parsed, job);
  });
});

describe('zombieRunningGoalIdsWithJobs', () => {
  it('keeps goals that have live AC or active detached job', () => {
    const live = new Set(['live-ac']);
    const detached = new Set(['job-owned']);
    assert.deepEqual(
      zombieRunningGoalIdsWithJobs(['live-ac', 'job-owned', 'orphan'], live, detached),
      ['orphan'],
    );
  });

  it('returns all when nothing is live', () => {
    assert.deepEqual(
      zombieRunningGoalIdsWithJobs(['a', 'b'], new Set(), new Set()),
      ['a', 'b'],
    );
  });
});

describe('worker pid file pure helpers', () => {
  it('parses plain pid and JSON', () => {
    assert.equal(parseWorkerPidFile('12345'), 12345);
    assert.equal(parseWorkerPidFile('{"version":1,"pid":77}'), 77);
    assert.equal(parseWorkerPidFile(''), null);
    assert.equal(parseWorkerPidFile('nope'), null);
  });

  it('serializes pid file', () => {
    const s = serializeWorkerPidFile(42, NOW);
    assert.match(s, /"pid": 42/);
    assert.ok(s.includes(NOW));
  });
});
