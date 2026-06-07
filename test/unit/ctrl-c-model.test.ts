/**
 * test/unit/ctrl-c-model.test.ts — unit tests for the Ctrl+C escape-model pure
 * helpers in src/interface/menu.ts.
 *
 * Both helpers are pure (no I/O, no side effects, never throw) and can be
 * tested exhaustively without any process signals, spawns, or TTYs.
 *
 * Honesty Contract: no fabricated data, no digit-% literals, no hardcoded AI
 * output phrases. Only the two exported pure helpers are exercised here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  countRecentInterrupts,
  interpretInterrupt,
  interpretChatKey,
  shouldEscapeRawSession,
} from '../../src/interface/menu.ts';
import { decidePostTurn } from '../../src/interface/menu-post-turn.ts';
import type { PostTurnAction, PostTurnInputs } from '../../src/interface/menu-post-turn.ts';

// ---------------------------------------------------------------------------
// countRecentInterrupts
// ---------------------------------------------------------------------------

describe('countRecentInterrupts', () => {
  const NOW = 1_700_000_000_000;
  const WIN = 1_500;

  // ---- empty input -----------------------------------------------------------

  it('returns 0 for an empty array', () => {
    assert.strictEqual(countRecentInterrupts([], NOW, WIN), 0);
  });

  // ---- all entries within the window -----------------------------------------

  it('counts all entries when all are within the window', () => {
    const times = [NOW - 1_000, NOW - 500, NOW];
    assert.strictEqual(countRecentInterrupts(times, NOW, WIN), 3);
  });

  it('counts a single entry at exactly now', () => {
    assert.strictEqual(countRecentInterrupts([NOW], NOW, WIN), 1);
  });

  it('counts a single entry at exactly now - windowMs (inclusive boundary)', () => {
    assert.strictEqual(countRecentInterrupts([NOW - WIN], NOW, WIN), 1);
  });

  // ---- some outside the window -----------------------------------------------

  it('excludes entries older than windowMs', () => {
    const times = [NOW - WIN - 1, NOW - 1_000, NOW];
    // NOW - WIN - 1 is 1 ms before the cutoff → excluded
    assert.strictEqual(countRecentInterrupts(times, NOW, WIN), 2);
  });

  it('excludes all entries when all are older than windowMs', () => {
    const times = [NOW - 5_000, NOW - 3_000, NOW - 2_000];
    assert.strictEqual(countRecentInterrupts(times, NOW, WIN), 0);
  });

  it('excludes entries strictly older than cutoff', () => {
    const times = [NOW - WIN - 100];
    assert.strictEqual(countRecentInterrupts(times, NOW, WIN), 0);
  });

  // ---- boundary at now -------------------------------------------------------

  it('counts entry at exactly now = 1', () => {
    assert.strictEqual(countRecentInterrupts([NOW], NOW, WIN), 1);
  });

  it('does not count entries in the future (> now)', () => {
    // future timestamps are beyond now; the window is [now-win, now] so
    // future entries are excluded (t > now)
    const times = [NOW + 1, NOW + 500];
    assert.strictEqual(countRecentInterrupts(times, NOW, WIN), 0);
  });

  // ---- mixed future and past -------------------------------------------------

  it('only counts entries within [now-window, now]', () => {
    const times = [NOW - 2_000, NOW - 1_000, NOW, NOW + 500];
    // NOW - 2000 is outside (2000 > 1500); NOW+500 is in the future
    assert.strictEqual(countRecentInterrupts(times, NOW, WIN), 2);
  });

  // ---- larger window ---------------------------------------------------------

  it('counts more entries when window is larger', () => {
    const times = [NOW - 3_000, NOW - 2_000, NOW - 1_000, NOW];
    assert.strictEqual(countRecentInterrupts(times, NOW, 5_000), 4);
    assert.strictEqual(countRecentInterrupts(times, NOW, 1_500), 2);
  });

  // ---- zero-width window -----------------------------------------------------

  it('with windowMs=0 only counts entries at exactly now', () => {
    const times = [NOW - 1, NOW, NOW + 1];
    assert.strictEqual(countRecentInterrupts(times, NOW, 0), 1);
  });

  // ---- readonly contract (does not mutate) -----------------------------------

  it('does not mutate the input array', () => {
    const times = [NOW - 1_000, NOW] as const;
    const copy = [...times];
    countRecentInterrupts(times, NOW, WIN);
    assert.deepStrictEqual([...times], copy);
  });

  // ---- never throws ----------------------------------------------------------

  it('never throws for any reasonable input', () => {
    const cases: [readonly number[], number, number][] = [
      [[], 0, 0],
      [[0], 0, 0],
      [[NOW], NOW, WIN],
      [[NOW - WIN, NOW], NOW, WIN],
      [[NOW + 1_000_000], NOW, WIN],
    ];
    for (const [times, now, win] of cases) {
      assert.doesNotThrow(() => countRecentInterrupts(times, now, win));
    }
  });

  // ---- count=3 scenario (triple-press) ---------------------------------------

  it('returns 3 for three presses all at now', () => {
    assert.strictEqual(countRecentInterrupts([NOW, NOW, NOW], NOW, WIN), 3);
  });

  it('returns 2 for two presses in window and one outside', () => {
    const times = [NOW - 2_000, NOW - 800, NOW];
    assert.strictEqual(countRecentInterrupts(times, NOW, WIN), 2);
  });
});

// ---------------------------------------------------------------------------
// interpretInterrupt
// ---------------------------------------------------------------------------

describe('interpretInterrupt', () => {
  // ---- exit-app (count >= 3) ------------------------------------------------

  it('returns "exit-app" for count=3, taskRunning=false', () => {
    assert.strictEqual(interpretInterrupt(3, false), 'exit-app');
  });

  it('returns "exit-app" for count=3, taskRunning=true', () => {
    assert.strictEqual(interpretInterrupt(3, true), 'exit-app');
  });

  it('returns "exit-app" for count=4, taskRunning=false', () => {
    assert.strictEqual(interpretInterrupt(4, false), 'exit-app');
  });

  it('returns "exit-app" for count=10, taskRunning=true', () => {
    assert.strictEqual(interpretInterrupt(10, true), 'exit-app');
  });

  // ---- to-menu (count === 2) -------------------------------------------------

  it('returns "to-menu" for count=2, taskRunning=false', () => {
    assert.strictEqual(interpretInterrupt(2, false), 'to-menu');
  });

  it('returns "to-menu" for count=2, taskRunning=true', () => {
    assert.strictEqual(interpretInterrupt(2, true), 'to-menu');
  });

  // ---- cancel-task (count === 1, taskRunning) --------------------------------

  it('returns "cancel-task" for count=1, taskRunning=true', () => {
    assert.strictEqual(interpretInterrupt(1, true), 'cancel-task');
  });

  // ---- hint (count === 1, !taskRunning) --------------------------------------

  it('returns "hint" for count=1, taskRunning=false', () => {
    assert.strictEqual(interpretInterrupt(1, false), 'hint');
  });

  // ---- defensive: count <= 0 ------------------------------------------------

  it('returns "hint" for count=0, taskRunning=false (defensive)', () => {
    assert.strictEqual(interpretInterrupt(0, false), 'hint');
  });

  it('returns "hint" for count=0, taskRunning=true (defensive)', () => {
    assert.strictEqual(interpretInterrupt(0, true), 'hint');
  });

  it('returns "hint" for count=-1, taskRunning=false (negative, defensive)', () => {
    assert.strictEqual(interpretInterrupt(-1, false), 'hint');
  });

  it('returns "hint" for count=-5, taskRunning=true (large negative, defensive)', () => {
    assert.strictEqual(interpretInterrupt(-5, true), 'hint');
  });

  // ---- never throws ----------------------------------------------------------

  it('never throws for any combination of count and taskRunning', () => {
    const counts = [-10, -1, 0, 1, 2, 3, 4, 100];
    for (const count of counts) {
      for (const taskRunning of [true, false]) {
        assert.doesNotThrow(() => interpretInterrupt(count, taskRunning));
      }
    }
  });

  // ---- all return values are valid strings -----------------------------------

  it('always returns one of the four valid action strings', () => {
    const valid = new Set(['cancel-task', 'to-menu', 'exit-app', 'hint']);
    const counts = [-1, 0, 1, 2, 3, 4];
    for (const count of counts) {
      for (const taskRunning of [true, false]) {
        const result = interpretInterrupt(count, taskRunning);
        assert.ok(valid.has(result), `unexpected result "${result}" for count=${count}, taskRunning=${String(taskRunning)}`);
      }
    }
  });

  // ---- boundary between cancel-task and hint ---------------------------------

  it('count=1 flips between cancel-task and hint based solely on taskRunning', () => {
    assert.strictEqual(interpretInterrupt(1, true), 'cancel-task');
    assert.strictEqual(interpretInterrupt(1, false), 'hint');
  });

  // ---- boundary between to-menu and exit-app ---------------------------------

  it('count=2 is to-menu and count=3 is exit-app regardless of taskRunning', () => {
    assert.strictEqual(interpretInterrupt(2, false), 'to-menu');
    assert.strictEqual(interpretInterrupt(2, true), 'to-menu');
    assert.strictEqual(interpretInterrupt(3, false), 'exit-app');
    assert.strictEqual(interpretInterrupt(3, true), 'exit-app');
  });
});

// ---------------------------------------------------------------------------
// shouldEscapeRawSession
// ---------------------------------------------------------------------------

describe('shouldEscapeRawSession', () => {
  // ---- Returns true for count >= 2 (escape to menu) -------------------------

  it('returns true for count=2 (rapid double press)', () => {
    assert.strictEqual(shouldEscapeRawSession(2), true);
  });

  it('returns true for count=3 (triple press)', () => {
    assert.strictEqual(shouldEscapeRawSession(3), true);
  });

  it('returns true for count=10 (many presses)', () => {
    assert.strictEqual(shouldEscapeRawSession(10), true);
  });

  // ---- Returns false for count < 2 (let child handle single press) ----------

  it('returns false for count=1 (single press — must not interfere)', () => {
    assert.strictEqual(shouldEscapeRawSession(1), false);
  });

  it('returns false for count=0 (no press — defensive)', () => {
    assert.strictEqual(shouldEscapeRawSession(0), false);
  });

  it('returns false for negative count (defensive)', () => {
    assert.strictEqual(shouldEscapeRawSession(-1), false);
    assert.strictEqual(shouldEscapeRawSession(-100), false);
  });

  // ---- Never throws ----------------------------------------------------------

  it('never throws for any count', () => {
    const counts = [-100, -1, 0, 1, 2, 3, 4, 100, Number.MAX_SAFE_INTEGER];
    for (const count of counts) {
      assert.doesNotThrow(() => shouldEscapeRawSession(count));
    }
  });

  // ---- Result is strictly boolean --------------------------------------------

  it('always returns a strict boolean', () => {
    for (const count of [-1, 0, 1, 2, 3]) {
      const result = shouldEscapeRawSession(count);
      assert.ok(result === true || result === false, `expected boolean, got ${String(result)}`);
    }
  });

  // ---- Boundary at count=2 ---------------------------------------------------

  it('count=1 is false and count=2 is true (boundary)', () => {
    assert.strictEqual(shouldEscapeRawSession(1), false);
    assert.strictEqual(shouldEscapeRawSession(2), true);
  });
});

// ---------------------------------------------------------------------------
// Integration: countRecentInterrupts + interpretInterrupt together
// ---------------------------------------------------------------------------

describe('countRecentInterrupts + interpretInterrupt integration', () => {
  const WIN = 1_500;
  const NOW = 2_000_000_000_000;

  it('single press at prompt → hint', () => {
    const times = [NOW];
    const count = countRecentInterrupts(times, NOW, WIN);
    assert.strictEqual(interpretInterrupt(count, false), 'hint');
  });

  it('single press during task → cancel-task', () => {
    const times = [NOW];
    const count = countRecentInterrupts(times, NOW, WIN);
    assert.strictEqual(interpretInterrupt(count, true), 'cancel-task');
  });

  it('two presses within window → to-menu', () => {
    const times = [NOW - 700, NOW];
    const count = countRecentInterrupts(times, NOW, WIN);
    assert.strictEqual(count, 2);
    assert.strictEqual(interpretInterrupt(count, false), 'to-menu');
  });

  it('three presses within window → exit-app', () => {
    const times = [NOW - 900, NOW - 400, NOW];
    const count = countRecentInterrupts(times, NOW, WIN);
    assert.strictEqual(count, 3);
    assert.strictEqual(interpretInterrupt(count, false), 'exit-app');
  });

  it('two presses but second is outside window → only first counts → hint', () => {
    // First press is old (outside window), second is now → count=1
    const times = [NOW - 5_000, NOW];
    const count = countRecentInterrupts(times, NOW, WIN);
    assert.strictEqual(count, 1);
    assert.strictEqual(interpretInterrupt(count, false), 'hint');
  });

  it('three rapid presses but only two in window → to-menu', () => {
    // Oldest press is outside window; two recent ones are in
    const times = [NOW - 3_000, NOW - 800, NOW];
    const count = countRecentInterrupts(times, NOW, WIN);
    assert.strictEqual(count, 2);
    assert.strictEqual(interpretInterrupt(count, false), 'to-menu');
  });
});

// ---------------------------------------------------------------------------
// interpretChatKey — mid-turn ESC classification (Phase 0)
// ---------------------------------------------------------------------------

describe('interpretChatKey', () => {
  it('a bare ESC while a turn is running interrupts that turn', () => {
    assert.equal(interpretChatKey('\x1b', true), 'interrupt-task');
  });

  it('a bare ESC while idle is ignored (no interrupt at idle)', () => {
    assert.equal(interpretChatKey('\x1b', false), 'ignore');
  });

  it('arrow / function-key escape sequences are ignored even while running', () => {
    assert.equal(interpretChatKey('\x1b[A', true), 'ignore'); // up
    assert.equal(interpretChatKey('\x1b[B', true), 'ignore'); // down
    assert.equal(interpretChatKey('\x1bOP', true), 'ignore'); // F1
  });

  it('printable input and Ctrl+C bytes are ignored by this helper', () => {
    assert.equal(interpretChatKey('a', true), 'ignore');
    assert.equal(interpretChatKey('\x03', true), 'ignore'); // Ctrl+C handled by SIGINT model
    assert.equal(interpretChatKey('\r', true), 'ignore');
    assert.equal(interpretChatKey('', true), 'ignore');
  });
});

// ---------------------------------------------------------------------------
// decidePostTurn — the one canonical post-turn order (MASTER-PLAN MF3)
// ---------------------------------------------------------------------------

describe('decidePostTurn', () => {
  const decide = (i: Partial<PostTurnInputs>): readonly PostTurnAction[] =>
    decidePostTurn({
      hasQuestions: false,
      hasMemoryProposal: false,
      queuedCount: 0,
      interrupted: false,
      ...i,
    });

  it('normal settle, no q/proposal, queue=2 → [discard-typeahead, drain-queue]', () => {
    assert.deepEqual(decide({ queuedCount: 2 }), ['discard-typeahead', 'drain-queue']);
  });

  it('questions present, queue=1 → [discard-typeahead, question-flow] (no drain)', () => {
    assert.deepEqual(decide({ hasQuestions: true, queuedCount: 1 }), [
      'discard-typeahead',
      'question-flow',
    ]);
  });

  it('memory proposal, no questions, queue=0 → [discard-typeahead, memory-approval, drain-queue]', () => {
    assert.deepEqual(decide({ hasMemoryProposal: true }), [
      'discard-typeahead',
      'memory-approval',
      'drain-queue',
    ]);
  });

  it('interrupted, queue=3 → [discard-typeahead] (queue discarded, no drain)', () => {
    assert.deepEqual(decide({ interrupted: true, queuedCount: 3 }), ['discard-typeahead']);
  });

  it('question-flow and memory-approval are mutually exclusive per turn (questions win)', () => {
    assert.deepEqual(decide({ hasQuestions: true, hasMemoryProposal: true }), [
      'discard-typeahead',
      'question-flow',
    ]);
  });

  it('memory-approval always runs AFTER discard and BEFORE drain (a queued "1" can never become "Save")', () => {
    const actions = decide({ hasMemoryProposal: true, queuedCount: 2 });
    const discardIdx = actions.indexOf('discard-typeahead');
    const approvalIdx = actions.indexOf('memory-approval');
    const drainIdx = actions.indexOf('drain-queue');
    assert.ok(discardIdx < approvalIdx, 'discard precedes memory-approval');
    assert.ok(approvalIdx < drainIdx, 'memory-approval precedes drain');
  });

  it('discard-typeahead is always first', () => {
    for (const i of [
      { queuedCount: 0 },
      { queuedCount: 5 },
      { hasQuestions: true },
      { hasMemoryProposal: true },
      { interrupted: true },
    ]) {
      assert.equal(decide(i)[0], 'discard-typeahead');
    }
  });

  it('interrupt suppresses drain even with a memory proposal', () => {
    assert.deepEqual(decide({ hasMemoryProposal: true, interrupted: true, queuedCount: 4 }), [
      'discard-typeahead',
      'memory-approval',
    ]);
  });
});
