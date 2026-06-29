/**
 * Unit tests for src/providers/hang-cap.ts — the UNIVERSAL HANG CAP.
 *
 * The cap exists because execa's `timeout` SIGKILLs only the DIRECT child; a
 * grandchild holding the stdout pipe can keep `for await (const line of subprocess)`
 * from ever resolving, hanging the whole call. These tests prove the wall-clock race
 * (`withHangCap`) and the ceiling derivation (`providerHangCapMs`) WITHOUT spawning a
 * real process — a fake inner stream that never terminates stands in for the hang.
 *
 * Key guarantees asserted:
 *  - A never-terminating inner stream → the guard emits exactly ONE honest `timeout`
 *    error event within the cap, and NEVER a fabricated `done`/text.
 *  - `onCap` (the process-tree kill hook) fires exactly once on the cap path.
 *  - The HAPPY PATH is pass-through: a stream that terminates yields the same events
 *    in the same order and the cap NEVER fires (onCap not called).
 *  - `providerHangCapMs` is a SAFETY CEILING strictly above req.timeoutMs.
 *
 * NOTE on the "hang": a JS `await` cannot be interrupted from outside (calling
 * `iterator.return()` on an async generator suspended at an `await` can't resume it).
 * That is exactly the real-world deadlock the cap defends against — `withHangCap` must
 * NOT await the inner iterator on the cap path. To keep the TEST itself clean (no
 * leaked pending promise that the runner flags), each hanging inner blocks on a
 * promise whose resolver is captured and released in `t.after`, so the abandoned
 * generator unwinds once the assertions are done. The CAP still fires entirely on its
 * own wall-clock — the release only tidies up after.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { withHangCap, providerHangCapMs } from '../../src/providers/hang-cap.ts';
import type { ProviderEvent } from '../../src/providers/port.ts';

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('providerHangCapMs — the safety ceiling', () => {
  it('is strictly above req.timeoutMs (never pre-empts a legit long turn)', () => {
    for (const t of [1_000, 30_000, 120_000, 600_000]) {
      assert.ok(
        providerHangCapMs(t) > t,
        `cap ${providerHangCapMs(t)} must exceed timeout ${t}`,
      );
    }
  });

  it('floors small/degenerate timeouts at 30s', () => {
    assert.equal(providerHangCapMs(0), 30_000);
    assert.equal(providerHangCapMs(-5), 30_000);
    assert.equal(providerHangCapMs(Number.NaN), 30_000);
    assert.equal(providerHangCapMs(Number.POSITIVE_INFINITY), 30_000);
    // A 1s timeout still gets at least 30s of grace.
    assert.ok(providerHangCapMs(1_000) >= 30_000);
  });
});

describe('withHangCap — never-terminating inner stream', () => {
  it('emits an honest timeout error within the cap and fires onCap once', async () => {
    let capCalls = 0;
    // In production `onCap` force-kills the process tree, which unblocks the inner
    // `for await`. We model that here: `onCap` resolves the inner's block, so the
    // abandoned generator finalizes cleanly (no leaked pending promise) — exactly the
    // real teardown sequence. The CAP still fires on its own wall-clock first.
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    // An inner stream that dribbles a non-terminal event then BLOCKS — the exact
    // shape of a grandchild holding the pipe open with no terminal `done`.
    async function* hangingInner(): AsyncIterable<ProviderEvent> {
      yield { type: 'text', delta: 'partial...' };
      await blocked;
      yield { type: 'done', text: 'NEVER', raw: {} };
    }

    const CAP_MS = 120;
    const t0 = Date.now();
    const events = await collect(
      withHangCap(hangingInner(), {
        provider: 'claude',
        capMs: CAP_MS,
        onCap: () => {
          capCalls += 1;
          release(); // model the process-kill that unblocks the hung inner stream
        },
      }),
    );
    const elapsed = Date.now() - t0;

    // The non-terminal partial passes through, then the honest timeout terminates it.
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'text');
    const terminal = events[1];
    assert.ok(terminal !== undefined && terminal.type === 'error');
    if (terminal.type === 'error') {
      assert.equal(terminal.error.category, 'timeout');
      assert.equal(terminal.error.recoverable, true);
      assert.match(terminal.error.message, /force-stopped|hung/i);
    }
    // NEVER a fabricated success.
    assert.equal(events.filter((e) => e.type === 'done').length, 0);
    // The process-tree kill hook fired exactly once.
    assert.equal(capCalls, 1);
    // Fired within a sane window above the cap (not hanging forever).
    assert.ok(elapsed < CAP_MS + 2_000, `cap fired too late (${elapsed}ms)`);
    // Let the abandoned inner generator (unblocked by onCap) finalize before the
    // test returns, so no pending promise lingers past the test.
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('withHangCap — happy path is byte-identical pass-through', () => {
  it('yields the inner events unchanged and never fires onCap', async () => {
    let capCalls = 0;
    const inputEvents: ProviderEvent[] = [
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'done', text: 'hello world', raw: {} },
    ];
    async function* goodInner(): AsyncIterable<ProviderEvent> {
      for (const ev of inputEvents) yield ev;
    }

    const events = await collect(
      withHangCap(goodInner(), {
        provider: 'codex',
        capMs: 5_000,
        onCap: () => {
          capCalls += 1;
        },
      }),
    );

    assert.deepEqual(events, inputEvents);
    assert.equal(capCalls, 0);
  });

  it('stops at the first terminal event and does not race the cap afterward', async () => {
    let capCalls = 0;
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A stream that terminates, then would (illegally) hang — the guard must have
    // already returned on the terminal event, so the post-terminal hang is unreachable.
    async function* terminalThenHang(): AsyncIterable<ProviderEvent> {
      yield { type: 'error', error: { category: 'auth', recoverable: false, message: 'x', suggestion: 'y' } };
      await blocked;
    }

    const events = await collect(
      withHangCap(terminalThenHang(), {
        provider: 'opencode',
        capMs: 200,
        onCap: () => {
          capCalls += 1;
        },
      }),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'error');
    assert.equal(capCalls, 0);
    // withHangCap already issued the inner's queued .return() on the terminal path;
    // unblock so it finalizes, then flush so nothing lingers past the test.
    release();
    await new Promise((r) => setTimeout(r, 0));
  });
});
