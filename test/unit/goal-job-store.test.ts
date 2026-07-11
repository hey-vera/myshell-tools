/**
 * File-backed goal job store + worker loop skeleton (multi-chat PR-D).
 */
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createGoalJobStore,
  ensureGoalJobsRoot,
  isProcessAlive,
  readWorkerPid,
  writeWorkerPidFile,
  type GoalJobStore,
} from '../../src/infra/goal-job-store.ts';
import { runWorkerLoop } from '../../src/commands/worker.ts';
import { ensureWorkerProcess } from '../../src/infra/detached-worker-spawn.ts';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

let root: string;
let store: GoalJobStore;
const alive = new Set<number>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'goal-job-store-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  // Fresh subdir per test for isolation
  const dir = join(root, `t-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await ensureGoalJobsRoot(dir);
  alive.clear();
  store = createGoalJobStore({
    root: dir,
    isOwnerAlive: (pid) => alive.has(pid),
  });
  // stash for tests that need the path
  (store as { _testRoot?: string })._testRoot = dir;
});

function jobsRoot(): string {
  return (store as { _testRoot?: string })._testRoot ?? store.root;
}

describe('createGoalJobStore', () => {
  it('enqueues a pending job without secrets fields', async () => {
    const job = await store.enqueue({
      conversationId: 'conv1',
      goalId: 'goal_1',
      work: 'Implement X',
      title: 'Implement X',
      cwd: '/proj',
      nowIso: '2026-07-10T00:00:00.000Z',
    });
    assert.equal(job.status, 'pending');
    assert.equal(job.work, 'Implement X');
    const raw = await readFile(
      join(jobsRoot(), 'conv1', 'goal_1.json'),
      'utf8',
    );
    assert.equal(raw.includes('apiKey'), false);
    assert.equal(raw.includes('token'), false);
    assert.equal(raw.includes('password'), false);

    const got = await store.get('conv1', 'goal_1');
    assert.equal(got?.goalId, 'goal_1');
  });

  it('claims pending then denies second claim while owner alive', async () => {
    await store.enqueue({
      conversationId: 'conv1',
      goalId: 'goal_2',
      work: 'w',
      title: 't',
      cwd: '/c',
    });
    alive.add(111);
    const c1 = await store.claim('conv1', 'goal_2', 'tui', 111);
    assert.equal(c1?.status, 'claimed');
    assert.equal(c1?.claimedBy, 111);
    const c2 = await store.claim('conv1', 'goal_2', 'worker', 222);
    assert.equal(c2, null);
  });

  it('reclaims when owner is dead', async () => {
    await store.enqueue({
      conversationId: 'conv1',
      goalId: 'goal_3',
      work: 'w',
      title: 't',
      cwd: '/c',
    });
    // Do not add 50 to alive → dead
    await store.claim('conv1', 'goal_3', 'tui', 50);
    await store.markRunning('conv1', 'goal_3', 'mid-flight');
    alive.add(99);
    const reclaimed = await store.claim('conv1', 'goal_3', 'worker', 99);
    assert.equal(reclaimed?.owner, 'worker');
    assert.equal(reclaimed?.claimedBy, 99);
  });

  it('claimNext prefers pending', async () => {
    await store.enqueue({
      conversationId: 'cA',
      goalId: 'goal_a',
      work: 'a',
      title: 'A',
      cwd: '/c',
    });
    await store.enqueue({
      conversationId: 'cB',
      goalId: 'goal_b',
      work: 'b',
      title: 'B',
      cwd: '/c',
    });
    alive.add(7);
    const first = await store.claimNext('worker', 7);
    assert.ok(first);
    assert.equal(first!.status, 'claimed');
    const active = await store.listActive();
    assert.ok(active.length >= 1);
    const ids = await store.activeGoalIds(first!.conversationId);
    assert.equal(ids.has(first!.goalId), true);
  });

  it('markTerminal settles job', async () => {
    await store.enqueue({
      conversationId: 'conv1',
      goalId: 'goal_done',
      work: 'w',
      title: 't',
      cwd: '/c',
    });
    alive.add(1);
    await store.claim('conv1', 'goal_done', 'worker', 1);
    const done = await store.markTerminal('conv1', 'goal_done', 'done', 'ok');
    assert.equal(done?.status, 'done');
    assert.equal(done?.note, 'ok');
    const active = await store.listActive();
    assert.equal(
      active.find((j) => j.goalId === 'goal_done'),
      undefined,
    );
  });
});

describe('isProcessAlive', () => {
  it('reports current process alive', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('reports nonsense pid dead', () => {
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(0), false);
  });
});

describe('worker pid file I/O', () => {
  it('writes and reads pid', async () => {
    const dir = jobsRoot();
    assert.equal(await writeWorkerPidFile(dir, 4242, '2026-07-10T00:00:00.000Z'), true);
    assert.equal(await readWorkerPid(dir), 4242);
  });
});

describe('runWorkerLoop', () => {
  it('claims jobs, runs executor, idle-exits', async () => {
    const dir = jobsRoot();
    const s = createGoalJobStore({
      root: dir,
      isOwnerAlive: () => false,
    });
    await s.enqueue({
      conversationId: 'convW',
      goalId: 'goal_w1',
      work: 'work-one',
      title: 'Work One',
      cwd: '/c',
    });
    const outcomes: string[] = [];
    const processed = await runWorkerLoop({
      store: s,
      jobsRoot: dir,
      idleTtlMs: 50,
      pollMs: 5,
      skipPidFile: true,
      maxJobs: 1,
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => {
          t += 100;
          return t;
        };
      })(),
      log: () => {},
      executor: async (job) => {
        outcomes.push(job.goalId);
        return 'done';
      },
    });
    assert.equal(processed, 1);
    assert.deepEqual(outcomes, ['goal_w1']);
    const settled = await s.get('convW', 'goal_w1');
    assert.equal(settled?.status, 'done');
  });

  it('idle-exits with empty queue without hanging', async () => {
    const dir = jobsRoot();
    const s = createGoalJobStore({ root: dir, isOwnerAlive: () => false });
    let ticks = 0;
    const processed = await runWorkerLoop({
      store: s,
      jobsRoot: dir,
      idleTtlMs: 30,
      pollMs: 5,
      skipPidFile: true,
      sleep: async () => {
        ticks += 1;
      },
      now: (() => {
        let t = 0;
        return () => {
          t += 20;
          return t;
        };
      })(),
      log: () => {},
      executor: async () => 'done',
    });
    assert.equal(processed, 0);
    assert.ok(ticks >= 1);
  });
});

describe('ensureWorkerProcess', () => {
  it('returns alreadyRunning when pid file is live', async () => {
    const dir = jobsRoot();
    await writeWorkerPidFile(dir, 555);
    const result = await ensureWorkerProcess({
      jobsRoot: dir,
      isAlive: (pid) => pid === 555,
      resolveCliEntry: () => '/fake/cli.js',
      spawnImpl: () => {
        throw new Error('should not spawn');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyRunning, true);
    assert.equal(result.pid, 555);
  });

  it('spawns detached and records pid (fail-soft shape)', async () => {
    const dir = jobsRoot();
    const fakeChild = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: () => void;
    };
    fakeChild.pid = 777;
    let unrefed = false;
    fakeChild.unref = () => {
      unrefed = true;
    };

    const result = await ensureWorkerProcess({
      jobsRoot: dir,
      isAlive: () => false,
      resolveCliEntry: () => join(dir, 'cli.js'),
      spawnImpl: ((_cmd, _args, opts) => {
        assert.equal((opts as { detached?: boolean }).detached, true);
        return fakeChild as unknown as ChildProcess;
      }) as typeof import('node:child_process').spawn,
    });
    // resolveCliEntry path may not exist on disk — spawn still happens with our inject
    // If cli missing from resolve returning path that existsSync fails... we inject resolveCliEntry
    // existsSync is only used in resolveMyshellCliEntry, not when resolveCliEntry is injected.
    assert.equal(result.ok, true);
    assert.equal(result.pid, 777);
    assert.equal(unrefed, true);
    assert.equal(await readWorkerPid(dir), 777);
  });

  it('fail-soft when cli entry missing', async () => {
    const dir = jobsRoot();
    const result = await ensureWorkerProcess({
      jobsRoot: dir,
      isAlive: () => false,
      resolveCliEntry: () => null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'cli-entry-missing');
  });
});
