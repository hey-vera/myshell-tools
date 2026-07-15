#!/usr/bin/env node
/**
 * scripts/multichat-handoff-smoke.mjs — hermetic multi-chat handoff smoke (U5).
 *
 * Quota-free: imports real package modules (via tsx) and exercises pure helpers
 * + temp-dir job store only. No provider CLIs, no network, no live auth.
 *
 * Proves:
 *   1. Leave-chat isolation — abortConversationGoalWorkers(A) does not abort B
 *   2. Fenced lease reclaim without trusting PID alone (expired lease + live PID)
 *   3. Work-status chips pure format (formatConversationWorkStatus shapes)
 *   4. releaseTuiOwnership returns TUI jobs to pending so workers can claim
 *
 * Does NOT prove:
 *   - Live provider auth / chat / streaming / paid quota
 *   - Full interactive PTY menu (/back, Esc) or real detached spawn
 *   - ensureWorkerProcess PID liveness across OS
 *   - Cross-process worker reclaim under contention
 *
 * Run:
 *   npm run smoke:multichat
 *   node --import tsx/esm scripts/multichat-handoff-smoke.mjs
 *
 * Exit 0 only when every check passes.
 */
// @ts-check

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  abortConversationGoalWorkers,
  conversationWorkerCount,
  registerGoalWorker,
  resetGoalWorkerRegistryForTests,
  totalWorkerCount,
} from '../src/interface/goal-worker-registry.ts';
import { formatConversationWorkStatus } from '../src/interface/menu-render.ts';
import {
  createGoalJobStore,
  ensureGoalJobsRoot,
} from '../src/infra/goal-job-store.ts';

/** @type {{ id: string, ok: boolean, detail: string }[]} */
const results = [];

/**
 * @param {string} id
 * @param {boolean} ok
 * @param {string} detail
 */
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} — ${detail}`);
}

console.log('=== multichat handoff smoke (U5, hermetic) ===\n');

// ---------------------------------------------------------------------------
// 1. Leave-chat does not abort other conversations' workers
// ---------------------------------------------------------------------------
console.log('1) leave-chat isolation (goal-worker-registry)');
resetGoalWorkerRegistryForTests();

const acA1 = new AbortController();
const acA2 = new AbortController();
const acB1 = new AbortController();
registerGoalWorker('conv-A', 'g1', acA1);
registerGoalWorker('conv-A', 'g2', acA2);
registerGoalWorker('conv-B', 'g1', acB1);

check(
  'registry-setup',
  conversationWorkerCount('conv-A') === 2 &&
    conversationWorkerCount('conv-B') === 1 &&
    totalWorkerCount() === 3,
  `counts A=${conversationWorkerCount('conv-A')} B=${conversationWorkerCount('conv-B')} total=${totalWorkerCount()}`,
);

// Explicit NL "pause all" on A aborts only A — models leave-chat vs pause-all.
// Leave-chat itself does NOT call abortConversationGoalWorkers; this proves the
// abort API is conversation-scoped (other chats keep running).
const aborted = abortConversationGoalWorkers('conv-A');
check(
  'abort-conv-A-scoped',
  aborted === 2 && acA1.signal.aborted && acA2.signal.aborted,
  `aborted=${aborted} A1.aborted=${acA1.signal.aborted} A2.aborted=${acA2.signal.aborted}`,
);
check(
  'conv-B-still-live',
  !acB1.signal.aborted && conversationWorkerCount('conv-B') === 1,
  `B.aborted=${acB1.signal.aborted} B.count=${conversationWorkerCount('conv-B')}`,
);

// Simulate leave-chat: no abort call — workers remain registered and un-aborted.
resetGoalWorkerRegistryForTests();
const leaveAc = new AbortController();
registerGoalWorker('conv-leave', 'goal-x', leaveAc);
registerGoalWorker('conv-other', 'goal-y', new AbortController());
// intentionally no abortConversationGoalWorkers('conv-leave')
check(
  'leave-chat-no-abort',
  !leaveAc.signal.aborted &&
    conversationWorkerCount('conv-leave') === 1 &&
    conversationWorkerCount('conv-other') === 1,
  `leave live; other live (no abort on leave path)`,
);

resetGoalWorkerRegistryForTests();

// ---------------------------------------------------------------------------
// 2. Fenced lease reclaim without PID alone
// ---------------------------------------------------------------------------
console.log('\n2) fenced lease reclaim (goal-job-store temp dir)');

const jobsRoot = await mkdtemp(join(tmpdir(), 'u5-multichat-jobs-'));
/** @type {Set<number>} */
const alive = new Set();

try {
  await ensureGoalJobsRoot(jobsRoot);
  const store = createGoalJobStore({
    root: jobsRoot,
    isOwnerAlive: (pid) => alive.has(pid),
  });

  await store.enqueue({
    conversationId: 'conv1',
    goalId: 'goal_lease',
    work: 'hermetic lease work',
    title: 'Lease reclaim',
    cwd: '/tmp/u5',
  });

  // Owner PID still "alive" — reclaim must rely on expired lease, not dead PID.
  alive.add(50);
  alive.add(99);
  const first = await store.claim(
    'conv1',
    'goal_lease',
    'tui',
    50,
    '2026-07-10T12:00:00.000Z',
  );
  check(
    'claim-mints-fence',
    first !== null &&
      typeof first.leaseId === 'string' &&
      first.leaseId.length > 0 &&
      first.leaseGeneration === 1 &&
      typeof first.leaseExpiresAt === 'string',
    `leaseId=${first?.leaseId?.slice(0, 8)}… gen=${first?.leaseGeneration} exp=${first?.leaseExpiresAt}`,
  );

  // While lease still valid + owner alive → second claim denied
  const denied = await store.claim(
    'conv1',
    'goal_lease',
    'worker',
    99,
    '2026-07-10T12:01:00.000Z',
  );
  check('claim-denied-while-lease-live', denied === null, `second claim=${denied}`);

  // 4 min later (> default 3m TTL) with owner still alive → reclaim succeeds
  const reclaimed = await store.claim(
    'conv1',
    'goal_lease',
    'worker',
    99,
    '2026-07-10T12:04:00.000Z',
  );
  check(
    'reclaim-on-expired-lease-not-pid',
    reclaimed !== null &&
      reclaimed.owner === 'worker' &&
      reclaimed.claimedBy === 99 &&
      reclaimed.leaseGeneration === 2 &&
      reclaimed.leaseId !== first?.leaseId,
    `owner=${reclaimed?.owner} pid=${reclaimed?.claimedBy} gen=${reclaimed?.leaseGeneration} newFence=${reclaimed?.leaseId !== first?.leaseId}`,
  );

  // ---------------------------------------------------------------------------
  // 4. releaseTuiOwnership → claimable by worker
  // ---------------------------------------------------------------------------
  console.log('\n4) releaseTuiOwnership handoff (goal-job-store)');

  await store.enqueue({
    conversationId: 'conv1',
    goalId: 'goal_hand',
    work: 'handoff work',
    title: 'TUI handoff',
    cwd: '/tmp/u5',
  });
  alive.add(100);
  alive.add(200);
  await store.claim('conv1', 'goal_hand', 'tui', 100, '2026-07-10T13:00:00.000Z');
  await store.markRunning('conv1', 'goal_hand', 'tui in-process', '2026-07-10T13:00:01.000Z');

  const blocked = await store.claim(
    'conv1',
    'goal_hand',
    'worker',
    200,
    '2026-07-10T13:00:30.000Z',
  );
  check(
    'worker-blocked-while-tui-holds',
    blocked === null,
    `claim while TUI holds=${blocked}`,
  );

  const released = await store.releaseTuiOwnership({
    pid: 100,
    nowIso: '2026-07-10T13:01:00.000Z',
  });
  check(
    'release-tui-clears-claim',
    released.length === 1 &&
      released[0]?.status === 'pending' &&
      released[0]?.owner === undefined &&
      released[0]?.claimedBy === undefined &&
      released[0]?.leaseId === undefined,
    `n=${released.length} status=${released[0]?.status} owner=${released[0]?.owner}`,
  );

  const workerClaim = await store.claim(
    'conv1',
    'goal_hand',
    'worker',
    200,
    '2026-07-10T13:01:01.000Z',
  );
  check(
    'worker-claims-after-release',
    workerClaim !== null &&
      workerClaim.owner === 'worker' &&
      workerClaim.claimedBy === 200,
    `owner=${workerClaim?.owner} pid=${workerClaim?.claimedBy}`,
  );
} finally {
  await rm(jobsRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. Work status chips pure format
// ---------------------------------------------------------------------------
console.log('\n3) work-status chips (menu-render pure)');

/** @type {Array<{ input: import('../src/interface/menu-render.ts').ConversationWorkStatusInput, expected: string }>} */
const chipCases = [
  {
    input: { liveWorkers: 2, runningGoals: 2, parkedGoals: 0, activeJobs: 0 },
    expected: '2 working',
  },
  {
    input: { liveWorkers: 0, runningGoals: 0, parkedGoals: 1, activeJobs: 0 },
    expected: '1 parked',
  },
  {
    input: { liveWorkers: 0, runningGoals: 0, parkedGoals: 0, activeJobs: 1 },
    expected: 'job alive',
  },
  {
    input: { liveWorkers: 2, runningGoals: 0, parkedGoals: 1, activeJobs: 1 },
    expected: '2 working · 1 parked · job alive',
  },
  {
    input: { liveWorkers: 0, runningGoals: 1, parkedGoals: 0, activeJobs: 1 },
    expected: '1 running · job alive',
  },
  {
    input: { liveWorkers: 0, runningGoals: 0, parkedGoals: 0, activeJobs: 3 },
    expected: '3 jobs',
  },
  {
    input: { liveWorkers: 0, runningGoals: 0, parkedGoals: 0, activeJobs: 0 },
    expected: '',
  },
];

let chipFails = 0;
for (const c of chipCases) {
  const got = formatConversationWorkStatus(c.input);
  const ok = got === c.expected;
  if (!ok) chipFails += 1;
  check(
    `chip:${c.expected || 'empty'}`,
    ok,
    ok ? `→ ${JSON.stringify(got)}` : `got ${JSON.stringify(got)} want ${JSON.stringify(c.expected)}`,
  );
}
check('chips-all', chipFails === 0, `${chipCases.length - chipFails}/${chipCases.length} shapes match`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('\n---');
if (failed.length > 0) {
  console.log(`multichat handoff smoke: FAIL (${failed.length} check(s))`);
  for (const f of failed) console.log(`  - ${f.id}: ${f.detail}`);
  process.exit(1);
}

console.log(`multichat handoff smoke: PASS (${results.length} checks)`);
console.log(
  'Note: does not prove live auth/chat, PTY menu, or real detached worker spawn.',
);
process.exit(0);
