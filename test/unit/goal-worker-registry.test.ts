/**
 * Process-scoped multi-conversation goal worker registry (multi-chat PR-B).
 *
 * Leave-chat must not abort; pause is conversation-scoped; workers for A
 * survive while B is active.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  abortConversationGoalWorkers,
  abortGoalWorker,
  conversationWorkerCount,
  getGoalWorker,
  liveGoalIds,
  registerGoalWorker,
  resetGoalWorkerRegistryForTests,
  totalWorkerCount,
  unregisterGoalWorker,
} from '../../src/interface/goal-worker-registry.js';
import { zombieRunningGoalIds } from '../../src/interface/menu-post-turn.js';

describe('goal-worker-registry', () => {
  beforeEach(() => {
    resetGoalWorkerRegistryForTests();
  });

  afterEach(() => {
    resetGoalWorkerRegistryForTests();
  });

  it('registers and looks up workers per conversation', () => {
    const acA = new AbortController();
    const acB = new AbortController();
    registerGoalWorker('conv-a', 'g1', acA);
    registerGoalWorker('conv-b', 'g1', acB);

    assert.equal(getGoalWorker('conv-a', 'g1'), acA);
    assert.equal(getGoalWorker('conv-b', 'g1'), acB);
    assert.equal(getGoalWorker('conv-a', 'missing'), undefined);
    assert.equal(conversationWorkerCount('conv-a'), 1);
    assert.equal(conversationWorkerCount('conv-b'), 1);
    assert.equal(totalWorkerCount(), 2);
  });

  it('replace re-register aborts the prior controller for the same goal', () => {
    const prior = new AbortController();
    const next = new AbortController();
    registerGoalWorker('c1', 'g1', prior);
    registerGoalWorker('c1', 'g1', next);
    assert.equal(prior.signal.aborted, true);
    assert.equal(next.signal.aborted, false);
    assert.equal(getGoalWorker('c1', 'g1'), next);
    assert.equal(conversationWorkerCount('c1'), 1);
  });

  it('unregister is race-safe when a replacement already landed', () => {
    const first = new AbortController();
    const second = new AbortController();
    registerGoalWorker('c1', 'g1', first);
    registerGoalWorker('c1', 'g1', second);
    // finally of the first run must not drop the second registration
    assert.equal(unregisterGoalWorker('c1', 'g1', first), false);
    assert.equal(getGoalWorker('c1', 'g1'), second);
    assert.equal(unregisterGoalWorker('c1', 'g1', second), true);
    assert.equal(getGoalWorker('c1', 'g1'), undefined);
    assert.equal(conversationWorkerCount('c1'), 0);
    assert.equal(totalWorkerCount(), 0);
  });

  it('abortGoalWorker only aborts that conversation’s goal', () => {
    const a1 = new AbortController();
    const a2 = new AbortController();
    const b1 = new AbortController();
    registerGoalWorker('A', 'g1', a1);
    registerGoalWorker('A', 'g2', a2);
    registerGoalWorker('B', 'g1', b1);

    assert.equal(abortGoalWorker('A', 'g1'), true);
    assert.equal(a1.signal.aborted, true);
    assert.equal(a2.signal.aborted, false);
    assert.equal(b1.signal.aborted, false);
    assert.equal(abortGoalWorker('A', 'nope'), false);
  });

  it('abortConversationGoalWorkers leaves other conversations running', () => {
    const a1 = new AbortController();
    const a2 = new AbortController();
    const b1 = new AbortController();
    registerGoalWorker('A', 'g1', a1);
    registerGoalWorker('A', 'g2', a2);
    registerGoalWorker('B', 'g1', b1);

    assert.equal(abortConversationGoalWorkers('A'), 2);
    assert.equal(a1.signal.aborted, true);
    assert.equal(a2.signal.aborted, true);
    assert.equal(b1.signal.aborted, false);
    // Entries remain until spawn finally unregisters (pause path mirrors pre-PR-B)
    assert.equal(conversationWorkerCount('A'), 2);
    assert.equal(conversationWorkerCount('B'), 1);
  });

  it('leave-chat does not require abort — workers stay registered and live', () => {
    // Simulates runChatLoop finally: no abortConversationGoalWorkers call.
    const ac = new AbortController();
    registerGoalWorker('A', 'g1', ac);
    // user leaves chat A → home → open chat B
    registerGoalWorker('B', 'g2', new AbortController());
    assert.equal(ac.signal.aborted, false);
    assert.equal(getGoalWorker('A', 'g1'), ac);
    assert.equal(totalWorkerCount(), 2);
  });

  it('liveGoalIds supports per-conversation zombie reconcile', () => {
    registerGoalWorker('A', 'live-1', new AbortController());
    registerGoalWorker('B', 'other-live', new AbortController());

    const runningInA = ['live-1', 'zombie-x', 'zombie-y'];
    const zombies = zombieRunningGoalIds(runningInA, liveGoalIds('A'));
    assert.deepEqual(zombies, ['zombie-x', 'zombie-y']);

    // B’s live worker is not visible as live for A
    assert.equal(liveGoalIds('A').has('other-live'), false);
  });

  it('liveGoalIds returns empty set for unknown conversation', () => {
    assert.deepEqual([...liveGoalIds('none')], []);
    assert.equal(conversationWorkerCount('none'), 0);
  });
});
