/**
 * test/ui/mount.test.tsx — unit coverage for the Node-side Ink mount adapters
 * (width backfill, OutputSink, LineReader). No React render here; these are pure
 * adapter functions. Lives under test/ui so it runs via `tsx` (mount.tsx is a
 * .tsx module and imports App.tsx).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillTerminalSize,
  createInkOutputSink,
  createInkLineReader,
  createInkStore,
  createTurnDriver,
} from '../../src/interface/ui/mount.js';
import { createInkAppBridge } from '../../src/interface/ui/App.js';
import type { CoreEvent } from '../../src/core/types.js';
import type { UiState } from '../../src/interface/ui/index.js';

test('backfillTerminalSize fills a zero-width stream from env, else 80x24', () => {
  const zero: { columns?: number; rows?: number } = { columns: 0, rows: 0 };
  backfillTerminalSize(zero, { COLUMNS: '120', LINES: '40' });
  assert.equal(zero.columns, 120);
  assert.equal(zero.rows, 40);

  const bare: { columns?: number; rows?: number } = {};
  backfillTerminalSize(bare, {});
  assert.equal(bare.columns, 80);
  assert.equal(bare.rows, 24);

  // A usable width is left untouched.
  const ok: { columns?: number; rows?: number } = { columns: 100, rows: 30 };
  backfillTerminalSize(ok, { COLUMNS: '10' });
  assert.equal(ok.columns, 100);
});

test('createInkOutputSink commits whole lines (as raw chrome) and buffers partials', () => {
  // The sink now dispatches `commit/raw` actions into the persistent InkStore, so
  // out.write chrome feeds the SAME growing committed[] transcript the reducer
  // prose feeds — one monotonic <Static> source (the C1/C2 fix).
  const bridge = createInkAppBridge();
  let last: UiState | null = null;
  bridge._setUiState = (s) => { last = s; };
  const store = createInkStore(bridge);
  const out = createInkOutputSink(store, { color: false, isTty: true });
  assert.equal(out.color, false);
  assert.equal(out.isTty, true);

  const chrome = (): string[] =>
    (last?.committed ?? []).filter((l) => l.kind === 'raw').map((l) => l.text);

  out.write('one\ntwo\n');
  assert.deepEqual(chrome(), ['one', 'two']);
  out.write('par'); // partial — not yet committed
  assert.deepEqual(chrome(), ['one', 'two']);
  out.write('tial\n');
  assert.deepEqual(chrome(), ['one', 'two', 'partial']);
});

test('createInkOutputSink flush() commits pending partial line; no-op when empty', () => {
  // FIX 1: an unterminated prompt (no trailing \n) sits in `pending` and would
  // never render — flush() commits it as a raw line so it's visible before a
  // blocking input read. flush() with nothing pending must not emit a phantom line.
  const bridge = createInkAppBridge();
  let last: UiState | null = null;
  bridge._setUiState = (s) => { last = s; };
  const store = createInkStore(bridge);
  const out = createInkOutputSink(store, { color: false, isTty: true });

  const chrome = (): string[] =>
    (last?.committed ?? []).filter((l) => l.kind === 'raw').map((l) => l.text);

  // No-op when empty (no pending, nothing committed yet).
  out.flush?.();
  assert.deepEqual(chrome(), []);

  // A trailing-space prompt with no newline — buffered, not yet visible.
  out.write('Sign in to claude? (Y/n) ');
  assert.deepEqual(chrome(), []);

  // flush() makes it visible as its own committed raw line.
  out.flush?.();
  assert.deepEqual(chrome(), ['Sign in to claude? (Y/n) ']);

  // A second flush with nothing pending is a no-op (no duplicate / empty line).
  out.flush?.();
  assert.deepEqual(chrome(), ['Sign in to claude? (Y/n) ']);
});

test('MENU-LAG FIX: ephemeral frame REPLACES the live region; committed[] stays flat across N menu redraws', () => {
  // The interactive menu redraws its full chrome (~30 lines) on EVERY loop
  // iteration. Before the fix, each redraw committed those lines to the
  // append-only committed[] (→ unbounded <Static> growth → progressive lag and
  // duplicate menus). With beginFrame()/endFrame() the menu paints into the
  // bounded NON-<Static> `chrome` live region, REPLACED each frame, so committed[]
  // does NOT grow as the user navigates with no-op (re-render) keypresses.
  const bridge = createInkAppBridge();
  let last: UiState | null = null;
  bridge._setUiState = (s) => { last = s; };
  const store = createInkStore(bridge);
  const out = createInkOutputSink(store, { color: false, isTty: true });

  const committedLen = (): number => last?.committed.length ?? 0;
  const chromeLines = (): string[] => (last?.chrome ?? []).map((l) => l.text);

  // Simulate 50 menu redraws (50 no-op keypresses → 50 re-render loop iterations).
  for (let i = 0; i < 50; i++) {
    out.beginFrame?.();
    out.write('myshell-tools v3\n');
    out.write('  Recent\n');
    out.write('  [n] New  [c] Continue  [q] Quit\n');
    out.write('> '); // unterminated prompt — folded into the frame on endFrame
    out.endFrame?.();
  }

  // committed[] NEVER grew across the 50 redraws (the lag root cause is gone).
  assert.equal(committedLen(), 0, `committed[] grew across menu redraws: ${committedLen()}`);
  // The live region holds exactly ONE current frame (4 lines incl. the prompt),
  // not 50×4 — it was REPLACED each time, never appended.
  assert.deepEqual(chromeLines(), [
    'myshell-tools v3',
    '  Recent',
    '  [n] New  [c] Continue  [q] Quit',
    '> ',
  ]);
});

test('MENU-LAG FIX: promoteFrame() folds the live frame into committed[] (sub-flow handoff, legacy scrollback parity)', () => {
  const bridge = createInkAppBridge();
  let last: UiState | null = null;
  bridge._setUiState = (s) => { last = s; };
  const store = createInkStore(bridge);
  const out = createInkOutputSink(store, { color: false, isTty: true });

  const committed = (): string[] => (last?.committed ?? []).map((l) => l.text);
  const chromeLines = (): string[] => (last?.chrome ?? []).map((l) => l.text);

  // Paint a menu frame (live region only — committed stays empty).
  out.beginFrame?.();
  out.write('menu line 1\n');
  out.write('menu line 2\n');
  out.endFrame?.();
  assert.deepEqual(committed(), []);
  assert.deepEqual(chromeLines(), ['menu line 1', 'menu line 2']);

  // A real action key: promote the frame into the transcript (it lingers in
  // scrollback above the sub-flow), then the sub-flow commits below it.
  out.promoteFrame?.();
  assert.deepEqual(chromeLines(), []);
  assert.deepEqual(committed(), ['menu line 1', 'menu line 2']);

  // Sub-flow output now commits as normal (append-only) BELOW the promoted menu.
  out.write('sub-flow output\n');
  assert.deepEqual(committed(), ['menu line 1', 'menu line 2', 'sub-flow output']);
});

test('createInkLineReader resolves nextLine() with submitted input (FIFO)', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);

  // Awaiter-before-line
  const pending = reader.nextLine();
  bridge.input._submit?.('hello');
  assert.equal(await pending, 'hello');

  // Line-before-awaiter (buffered)
  bridge.input._submit?.('a');
  bridge.input._submit?.('b');
  assert.equal(await reader.nextLine(), 'a');
  assert.deepEqual(reader.drainBuffered(), ['b']);

  // close() makes every future call resolve null
  reader.close();
  assert.equal(await reader.nextLine(), null);
});

test('createInkLineReader trims submitted lines (matches legacy createLineReader)', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  const pending = reader.nextLine();
  bridge.input._submit?.('  spaced  ');
  assert.equal(await pending, 'spaced');
});

test('createInkLineReader currentLine() mirrors the InputBox in-progress buffer', () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  assert.equal(reader.currentLine(), '');
  // Simulate the InputBox attaching its imperative API.
  bridge.input.attach({ currentLine: () => 'typing…' });
  assert.equal(reader.currentLine(), 'typing…');
});

test('createInkLineReader beginCapture routes submits to onLine, drops blanks, is exclusive', () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  const captured: string[] = [];
  const stop = reader.beginCapture((l) => captured.push(l));

  bridge.input._submit?.('queued-1');
  bridge.input._submit?.('   '); // blank → dropped
  bridge.input._submit?.('queued-2');
  assert.deepEqual(captured, ['queued-1', 'queued-2']);
  // Nothing leaked into the nextLine buffer.
  assert.deepEqual(reader.drainBuffered(), []);

  // Exclusive: a second beginCapture throws while one is active.
  assert.throws(() => reader.beginCapture(() => {}), /capture already active/);

  // After detach, submits flow back to the buffer.
  stop();
  bridge.input._submit?.('normal');
  assert.deepEqual(reader.drainBuffered(), ['normal']);

  // Detach is idempotent.
  stop();
});

test('createInkLineReader drainBuffered returns+empties; clearBuffered empties silently', () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  bridge.input._submit?.('a');
  bridge.input._submit?.('b');
  assert.deepEqual(reader.drainBuffered(), ['a', 'b']);
  assert.deepEqual(reader.drainBuffered(), []);

  bridge.input._submit?.('c');
  reader.clearBuffered();
  assert.deepEqual(reader.drainBuffered(), []);
});

test('createInkLineReader ignores submits after close()', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  reader.close();
  bridge.input._submit?.('too late');
  assert.deepEqual(reader.drainBuffered(), []);
  assert.equal(await reader.nextLine(), null);
});

// ---------------------------------------------------------------------------
// C1/C2 REGRESSION — persistent state across ≥3 consecutive turns through ONE
// mounted store + turn driver (NOT rebuilt per turn — rebuilding is exactly what
// hid the bug). Asserts:
//   - prior turns' committed lines PERSIST;
//   - committed[] is MONOTONICALLY NON-DECREASING across turns (the <Static>
//     append-only contract — it never shrinks then regrows);
//   - tokens.session ACCUMULATES across turns;
//   - an out.write chrome line written BETWEEN turns appears in committed[] and
//     SURVIVES the next turn.
// ---------------------------------------------------------------------------

/** A minimal one-tier turn producing `answer` prose and 150 (100+50) tokens. */
function makeTurnStream(answer: string): AsyncIterable<CoreEvent> {
  const events: CoreEvent[] = [
    { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1 },
    { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: answer } },
    { type: 'tier-done', tier: 'ic', success: true, confidence: 0.9, costUsd: 0, inputTokens: 100, outputTokens: 50, durationMs: 1 },
    { type: 'final', success: true, output: answer, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 },
  ];
  return (async function* () { for (const e of events) yield e; })();
}

test('persistent store: ≥3 consecutive turns keep committed[] monotonic, accumulate session tokens, and never lose inter-turn chrome', async () => {
  const bridge = createInkAppBridge();
  let last: UiState | null = null;
  bridge._setUiState = (s) => { last = s; };

  const store = createInkStore(bridge);
  const out = createInkOutputSink(store, { color: false, isTty: true });
  // SYNCHRONOUS flush so the throttled prose lands deterministically in the fold.
  const renderTurn = createTurnDriver(store, { color: false, isTty: true });

  const lens = (): readonly { kind: string; text: string }[] => last?.committed ?? [];
  let prevLen = 0;
  const assertGrew = (): void => {
    assert.ok(lens().length >= prevLen, `committed[] shrank: ${prevLen} -> ${lens().length}`);
    prevLen = lens().length;
  };

  const answers = ['Turn one answer.', 'Turn two answer.', 'Turn three answer.'];
  const sessionTotals: number[] = [];

  for (let i = 0; i < answers.length; i += 1) {
    // Inter-turn chrome (the echoed prompt / ※ recap analogue) written via the sink.
    out.write(`> chrome before turn ${i + 1}\n`);
    assertGrew();
    // committed[] must already contain EVERY prior turn's prose + chrome.
    for (let j = 0; j < i; j += 1) {
      assert.ok(
        lens().some((l) => l.kind === 'prose' && l.text.includes(answers[j]!)),
        `prior turn ${j + 1} prose lost after entering turn ${i + 1}`,
      );
      assert.ok(
        lens().some((l) => l.kind === 'raw' && l.text.includes(`chrome before turn ${j + 1}`)),
        `prior chrome ${j + 1} lost after entering turn ${i + 1}`,
      );
    }

    // Note: createTurnDriver dispatches turn/start; with synchronous internal
    // flush behaviour the default ~40ms timer is unref'd. Drive with the real
    // driver and await its completion (events are finite).
    await renderTurn(makeTurnStream(answers[i]!), { verbosity: 'normal' });
    assertGrew();

    // This turn's prose + completion line are now committed.
    assert.ok(
      lens().some((l) => l.kind === 'prose' && l.text.includes(answers[i]!)),
      `turn ${i + 1} prose not committed`,
    );
    sessionTotals.push(last!.tokens.session);
    // Per-turn token counter is reset each turn by turn/start.
    assert.equal(last!.tokens.turn, 150, `turn ${i + 1} per-turn tokens`);
  }

  // tokens.session ACCUMULATES across turns (150, 300, 450) — never de-cumulates.
  assert.deepEqual(sessionTotals, [150, 300, 450]);

  // The chrome written between turns survived every subsequent turn.
  for (let j = 0; j < answers.length; j += 1) {
    assert.ok(
      lens().some((l) => l.kind === 'raw' && l.text.includes(`chrome before turn ${j + 1}`)),
      `chrome ${j + 1} did not survive to the end`,
    );
    assert.ok(
      lens().some((l) => l.kind === 'prose' && l.text.includes(answers[j]!)),
      `turn ${j + 1} prose did not survive to the end`,
    );
  }
});
