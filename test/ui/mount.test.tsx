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
} from '../../src/interface/ui/mount.js';
import { createInkAppBridge } from '../../src/interface/ui/App.js';

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

test('createInkOutputSink commits whole lines and buffers partials', () => {
  const bridge = createInkAppBridge();
  const committed: string[] = [];
  bridge._setLines = (fn) => {
    const next = fn([]);
    committed.push(next[next.length - 1] as string);
  };
  const out = createInkOutputSink(bridge, { color: false, isTty: true });
  assert.equal(out.color, false);
  assert.equal(out.isTty, true);

  out.write('one\ntwo\n');
  assert.deepEqual(committed, ['one', 'two']);
  out.write('par'); // partial — not yet committed
  assert.deepEqual(committed, ['one', 'two']);
  out.write('tial\n');
  assert.deepEqual(committed, ['one', 'two', 'partial']);
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
