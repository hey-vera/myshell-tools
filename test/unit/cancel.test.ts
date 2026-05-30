/**
 * Cancellation gate test (GOLDEN-PLAN §11 / §4.4).
 *
 * The Claude adapter (src/providers/claude.ts) cancels a run by passing the
 * orchestrator's AbortSignal straight to execa's `cancelSignal`. This test
 * validates that exact mechanism end-to-end: a long-running child process must
 * be terminated within 250 ms of the signal firing — on every platform.
 *
 * We spawn `node` (always available, cross-platform) rather than the real
 * `claude` binary so the test is hermetic and quota-free.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execa } from 'execa';

describe('cancellation — the mechanism createClaudeProvider relies on', () => {
  it('terminates a long-running child within 250ms of abort', async () => {
    const ac = new AbortController();

    // A child that would otherwise run effectively forever.
    const subprocess = execa(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        cancelSignal: ac.signal,
        timeout: 10_000,
        reject: false,
      },
    );

    // Let the child actually start before we cancel.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const t0 = Date.now();
    ac.abort();
    const result = await subprocess;
    const elapsedMs = Date.now() - t0;

    assert.ok(
      result.isCanceled === true || result.isTerminated === true,
      `expected the child to be canceled/terminated, got ${JSON.stringify({
        isCanceled: result.isCanceled,
        isTerminated: result.isTerminated,
      })}`,
    );
    assert.ok(
      elapsedMs < 250,
      `cancellation took ${elapsedMs}ms, expected < 250ms`,
    );
  });

  it('a pre-aborted signal prevents the child from running on', async () => {
    const ac = new AbortController();
    ac.abort(); // already aborted before spawn

    const t0 = Date.now();
    const result = await execa(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { cancelSignal: ac.signal, timeout: 10_000, reject: false },
    );
    const elapsedMs = Date.now() - t0;

    // Correctness is what matters here: a pre-aborted signal must cancel the run.
    assert.ok(
      result.isCanceled === true || result.isTerminated === true,
      'pre-aborted signal should cancel the run',
    );
    // Timing here is dominated by cold *process startup* (the child is killed the
    // instant it spawns), not cancellation latency — so the bound is generous and
    // only guards against a hang. The strict <250ms cancellation gate is asserted
    // by the warm "abort a running child" test above.
    assert.ok(elapsedMs < 5000, `pre-aborted run hung (${elapsedMs}ms)`);
  });
});
