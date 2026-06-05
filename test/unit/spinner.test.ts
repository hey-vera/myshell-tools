/**
 * Unit tests for src/ui/spinner.ts
 *
 * Drives createSpinner() with a capturing OutputSink and verifies:
 *  - Non-TTY: start() writes static text once, stop() does not throw.
 *  - TTY (fake): start() writes something, stop() clears the line.
 *  - No percentage values appear in output.
 *  - No Math.random usage (enforced statically by guards; also checked here
 *    by ensuring the frame cycle is deterministic — same sequence every run).
 *
 * Real timers are NOT used — the test relies on start/stop side effects only
 * so the suite is fully deterministic and does not race against setInterval.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSpinner } from '../../src/ui/spinner.ts';
import type { OutputSink } from '../../src/interface/render.ts';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeSink(isTty: boolean): OutputSink & { buf: string[] } {
  const buf: string[] = [];
  return {
    buf,
    write: (s: string) => { buf.push(s); },
    color: isTty,
    isTty,
  };
}

// ---------------------------------------------------------------------------
// 1. Non-TTY — static text, no animation
// ---------------------------------------------------------------------------

describe('createSpinner — non-TTY', () => {
  it('start() writes the text once and stop() does not throw', () => {
    const sink = makeSink(false);
    const spinner = createSpinner(sink);

    spinner.start('working on task');
    const after = sink.buf.join('');

    // Static text should contain the label.
    assert.ok(after.includes('working on task'), 'Should write the label text');

    // Exactly one write (no animation frames).
    assert.equal(sink.buf.length, 1, 'Non-TTY should produce exactly one write on start()');

    // stop() must not throw.
    assert.doesNotThrow(() => { spinner.stop(); }, 'stop() must not throw');

    // stop() should not write anything in non-TTY mode.
    assert.equal(sink.buf.length, 1, 'stop() must not write in non-TTY mode');
  });

  it('output contains no percentage values', () => {
    const sink = makeSink(false);
    const spinner = createSpinner(sink);
    spinner.start('processing');
    spinner.stop();
    const joined = sink.buf.join('');
    assert.ok(!/\d+%/.test(joined), 'Spinner output must not contain digit-% patterns');
  });
});

// ---------------------------------------------------------------------------
// 2. TTY — animated, clears on stop
// ---------------------------------------------------------------------------

describe('createSpinner — TTY', () => {
  it('start() writes something to the sink', () => {
    const sink = makeSink(true);
    const spinner = createSpinner(sink);

    spinner.start('working…');

    // start() must write at least one frame immediately (before the interval fires).
    assert.ok(sink.buf.length >= 1, 'start() must write at least once in TTY mode');
    const first = sink.buf[0] ?? '';
    assert.ok(first.includes('working…'), 'First write must contain the label');
    // Frame indicator — one of the braille chars or \r.
    assert.ok(first.startsWith('\r'), 'Frame writes must begin with \\r');

    spinner.stop();
  });

  it('stop() writes a clear-line sequence in TTY mode', () => {
    const sink = makeSink(true);
    const spinner = createSpinner(sink);

    spinner.start('processing…');
    const countAfterStart = sink.buf.length;

    spinner.stop();

    // stop() must add at least one write (the clear-line sequence).
    assert.ok(sink.buf.length > countAfterStart, 'stop() must write something in TTY mode');

    const lastWrite = sink.buf[sink.buf.length - 1] ?? '';
    // Clear-line sequence: \r + ANSI erase-line (\x1b[K) or similar.
    assert.ok(
      lastWrite.includes('\r') || lastWrite.includes('\x1b[K'),
      'stop() must write a carriage-return or erase-line sequence',
    );
  });

  it('output contains no percentage values', () => {
    const sink = makeSink(true);
    const spinner = createSpinner(sink);
    spinner.start('analysing');
    spinner.stop();
    const joined = sink.buf.join('');
    assert.ok(!/\d+%/.test(joined), 'Spinner output must not contain digit-% patterns');
  });

  it('calling stop() a second time does not throw or write extra', () => {
    const sink = makeSink(true);
    const spinner = createSpinner(sink);
    spinner.start('task');
    spinner.stop();
    const countAfterFirstStop = sink.buf.length;

    assert.doesNotThrow(() => { spinner.stop(); }, 'Second stop() must not throw');
    assert.equal(sink.buf.length, countAfterFirstStop, 'Second stop() must not write');
  });
});

// ---------------------------------------------------------------------------
// 3. Determinism — frame sequence is identical across two instances
// ---------------------------------------------------------------------------

describe('createSpinner — deterministic frames (no Math.random)', () => {
  it('two spinners started in sequence produce the same first frame', () => {
    const sink1 = makeSink(true);
    const sink2 = makeSink(true);

    const s1 = createSpinner(sink1);
    const s2 = createSpinner(sink2);

    s1.start('a');
    s2.start('a');

    s1.stop();
    s2.stop();

    // Both sinks' first writes should be identical (same deterministic frame).
    assert.equal(sink1.buf[0], sink2.buf[0], 'Frame sequence must be deterministic');
  });
});

// ---------------------------------------------------------------------------
// 3. resume() — re-arm after stop WITHOUT resetting the elapsed counter
// ---------------------------------------------------------------------------

describe('createSpinner — resume()', () => {
  it('non-TTY: resume() writes the label like start()', () => {
    const sink = makeSink(false);
    const spinner = createSpinner(sink);
    spinner.start('one');
    spinner.stop();
    spinner.resume('two');
    assert.ok(sink.buf.join('').includes('two'), 'resume() should write its label in non-TTY mode');
  });

  it('TTY: resume() continues the elapsed count instead of resetting to 0s', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const sink = makeSink(true);
      const spinner = createSpinner(sink);

      spinner.start('phase one');
      mock.timers.tick(80 * 30); // ~30 ticks → ~2s elapsed
      spinner.stop();
      assert.ok(sink.buf.join('').includes('· 2s'), 'should show ~2s elapsed before the pause');

      sink.buf.length = 0;
      spinner.resume('phase two');
      mock.timers.tick(80 * 2); // a couple more ticks
      spinner.stop();

      const after = sink.buf.join('');
      assert.ok(after.includes('· 2s'), `resume must CONTINUE elapsed (~2s), got: ${JSON.stringify(after)}`);
      assert.ok(!after.includes('· 0s'), 'resume must not reset the elapsed counter to 0s');
    } finally {
      mock.timers.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. elapsed() — real tick-derived seconds, survives stop(), 0 off-TTY
// ---------------------------------------------------------------------------

describe('createSpinner — elapsed()', () => {
  it('TTY: reports whole seconds derived from real ticks and persists after stop()', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const sink = makeSink(true);
      const spinner = createSpinner(sink);

      assert.equal(spinner.elapsed(), 0, 'elapsed is 0 before any tick');
      spinner.start('working');
      mock.timers.tick(80 * 30); // ~30 ticks → 2s at 80ms/12.5fps
      assert.equal(spinner.elapsed(), 2, 'elapsed reflects the real tick count (2s)');
      spinner.stop();
      // stop() must NOT reset the counter — the completion line reads it after stop.
      assert.equal(spinner.elapsed(), 2, 'elapsed survives stop() so the completion line can show it');
    } finally {
      mock.timers.reset();
    }
  });

  it('non-TTY: elapsed() is 0 (no ticks fire) so piped output stays stable', () => {
    const sink = makeSink(false);
    const spinner = createSpinner(sink);
    spinner.start('working');
    spinner.stop();
    assert.equal(spinner.elapsed(), 0, 'no animation off-TTY → elapsed stays 0');
  });
});
