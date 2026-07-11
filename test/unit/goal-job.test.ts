/**
 * Pure helpers for detached goal jobs (multi-chat PR-D).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  ACTIVE_GOAL_JOB_STATUSES,
  applyClaim,
  applyRunning,
  applyTerminal,
  canClaimGoalJob,
  createPendingGoalJob,
  goalJobConversationDir,
  goalJobFilePath,
  isActiveGoalJob,
  isGoalJobStatus,
  isSafeJobSegment,
  isTerminalGoalJob,
  parseGoalJob,
  parseWorkerPidFile,
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
    const claimed = applyClaim(pending, 99, 'worker', '2026-07-10T12:01:00.000Z');
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.claimedBy, 99);
    assert.equal(claimed.owner, 'worker');
    const running = applyRunning(claimed, '2026-07-10T12:02:00.000Z', 'heartbeat');
    assert.equal(running.status, 'running');
    assert.equal(running.note, 'heartbeat');
    const done = applyTerminal(running, 'done', '2026-07-10T12:03:00.000Z');
    assert.equal(done.status, 'done');
    assert.equal(isTerminalGoalJob(done), true);
    assert.equal(ACTIVE_GOAL_JOB_STATUSES.has('pending'), true);
  });
});

describe('canClaimGoalJob', () => {
  const alive = (pid: number) => pid === 1;

  it('allows pending always', () => {
    assert.equal(canClaimGoalJob(sampleJob(), alive), true);
  });

  it('allows reclaim when owner is dead', () => {
    const job = sampleJob({ status: 'running', claimedBy: 999, owner: 'tui' });
    assert.equal(canClaimGoalJob(job, alive), true);
  });

  it('denies when owner is alive', () => {
    const job = sampleJob({ status: 'running', claimedBy: 1, owner: 'tui' });
    assert.equal(canClaimGoalJob(job, alive), false);
  });

  it('denies terminal', () => {
    assert.equal(canClaimGoalJob(sampleJob({ status: 'done' }), alive), false);
    assert.equal(canClaimGoalJob(sampleJob({ status: 'failed' }), alive), false);
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
