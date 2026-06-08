/**
 * test/ui/menu-single-key.test.tsx — single-key MENU nav + y/n confirm on the
 * Ink path (this task). Proves that a single keypress resolves a menu choice /
 * confirm WITHOUT Enter through Ink's own input pipeline, that the InputBox line
 * editor still works after a single-key read (no stuck/inactive state), and that
 * a single-key read does NOT fire while suspended.
 *
 * Runs under `npm run test:ui` (tsx + ink-testing-library). `stdin.write(...)`
 * injects raw key bytes Ink decodes into `key.*`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App, createInkAppBridge, normalizeInkKey } from '../../src/interface/ui/App.js';
import { readMenuKey, makeConfirm } from '../../src/interface/menu-key-confirm.js';
import type { OutputSink } from '../../src/interface/render.js';

const ENTER = '\r';
const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeOut(): { sink: OutputSink; written: string[] } {
  const written: string[] = [];
  const sink: OutputSink = {
    write(s: string): void {
      written.push(s);
    },
    get color(): boolean {
      return false;
    },
    get isTty(): boolean {
      return true;
    },
  };
  return { sink, written };
}

// ---------------------------------------------------------------------------
// normalizeInkKey — the pure mapping that keeps the Ink read legacy-shaped.
// ---------------------------------------------------------------------------

test('normalizeInkKey maps keys to legacy readSingleKey-shaped strings', () => {
  assert.equal(normalizeInkKey('n', {}), 'n');
  assert.equal(normalizeInkKey('5', {}), '5');
  assert.equal(normalizeInkKey('', { return: true }), '\r');
  assert.equal(normalizeInkKey('', { escape: true }), '\x1b');
  assert.equal(normalizeInkKey('c', { ctrl: true }), '\x03');
  assert.equal(normalizeInkKey('d', { ctrl: true }), '\x04');
  // Arrows → multi-byte sentinel (length > 1) → a menu no-op.
  assert.ok(normalizeInkKey('', { upArrow: true }).length > 1);
  assert.ok(normalizeInkKey('', { downArrow: true }).length > 1);
});

// ---------------------------------------------------------------------------
// A single keypress resolves a menu action WITHOUT Enter.
// ---------------------------------------------------------------------------

test('a single key (no Enter) resolves a menu choice on the Ink path', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  const { sink } = makeOut();
  const readLineNever = (): Promise<string | null> =>
    new Promise(() => {}); // must NOT be used — single-key only.

  const choice = readMenuKey(sink, readLineNever, undefined, false, () => bridge.readKey());
  await tick();
  stdin.write('n'); // single key, NO Enter
  await tick();
  assert.equal(await choice, 'n');
});

test('a digit keypress (no Enter) resolves on the Ink path', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();
  const { sink } = makeOut();
  const choice = readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  await tick();
  stdin.write('3');
  await tick();
  assert.equal(await choice, '3');
});

test('bare Enter is a no-op (re-render) and Ctrl-C exits on the Ink menu', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();
  const { sink } = makeOut();

  const enterChoice = readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.equal(await enterChoice, '');

  const ctrlcChoice = readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  await tick();
  stdin.write('\x03'); // Ctrl-C
  await tick();
  assert.equal(await ctrlcChoice, null);
});

// ---------------------------------------------------------------------------
// A y/n confirm resolves on a single keypress under Ink.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FIX 1: readMenuKey / confirm flush any unterminated prompt BEFORE blocking on
// input, so a trailing-space prompt becomes visible on a flush-aware (Ink) sink.
// ---------------------------------------------------------------------------

function makeFlushSpyOut(): {
  sink: OutputSink;
  events: string[];
} {
  const events: string[] = [];
  const sink: OutputSink = {
    write(s: string): void {
      events.push('write:' + s);
    },
    flush(): void {
      events.push('flush');
    },
    get color(): boolean {
      return false;
    },
    get isTty(): boolean {
      return true;
    },
  };
  return { sink, events };
}

test('readMenuKey flushes the sink before blocking on the key read', async () => {
  const { sink, events } = makeFlushSpyOut();
  let readStarted = false;
  const inkReadKey = (): Promise<string> => {
    readStarted = true;
    // flush must already have happened by the time the read is reached.
    assert.deepEqual(events, ['flush']);
    return Promise.resolve('n');
  };
  const choice = await readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, inkReadKey);
  assert.equal(choice, 'n');
  assert.ok(readStarted);
  // flush ran before the echo write of the chosen key.
  assert.equal(events[0], 'flush');
  assert.ok(events.includes('write:n\n'));
});

test('confirm flushes the sink before blocking on the key read', async () => {
  const { sink, events } = makeFlushSpyOut();
  const inkReadKey = (): Promise<string> => {
    assert.deepEqual(events, ['flush']);
    return Promise.resolve('y');
  };
  const confirm = makeConfirm(sink, () => new Promise<string | null>(() => {}), undefined, false, inkReadKey);
  const verdict = await confirm(true);
  assert.equal(verdict, true);
  assert.equal(events[0], 'flush');
});

test('a y/n confirm resolves on a single y keypress under Ink', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();
  const { sink } = makeOut();

  const confirm = makeConfirm(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  const verdict = confirm(true);
  await tick();
  stdin.write('y'); // single key
  await tick();
  assert.equal(await verdict, true);
});

test('a y/n confirm resolves false on a single n keypress under Ink', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();
  const { sink } = makeOut();

  const confirm = makeConfirm(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  const verdict = confirm(true);
  await tick();
  stdin.write('n');
  await tick();
  assert.equal(await verdict, false);
});

test('a default-yes confirm takes the default on a bare Enter under Ink', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();
  const { sink } = makeOut();

  const confirm = makeConfirm(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  const verdict = confirm(true);
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.equal(await verdict, true);
});

// ---------------------------------------------------------------------------
// After a single-key read, the InputBox line editor still works.
// ---------------------------------------------------------------------------

test('after a single-key menu read, the InputBox editor still accepts a line', async () => {
  const bridge = createInkAppBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();
  const { sink } = makeOut();

  // 1. A single-key menu read.
  const choice = readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  await tick();
  stdin.write('n');
  await tick();
  assert.equal(await choice, 'n');

  // 2. The editor must resume cleanly: typing + Enter submits the WHOLE line, and
  //    the single 'n' must NOT have leaked into the buffer.
  await tick();
  stdin.write('hello world');
  await tick();
  assert.equal(bridge.input.currentLine(), 'hello world', 'editor must resume after a single-key read');
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['hello world'], 'no leaked/swallowed key; the full line submits');
});

test('exactly ONE key is consumed: a second key goes to the editor, not the resolver', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();
  const { sink } = makeOut();

  const choice = readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  await tick();
  // Send two keys back to back. The FIRST resolves the read; the SECOND must land
  // in the editor (capture mode consumed exactly one).
  stdin.write('q');
  await tick();
  assert.equal(await choice, 'q');
  stdin.write('x');
  await tick();
  assert.equal(bridge.input.currentLine(), 'x', 'the second key must go to the editor');
});

// ---------------------------------------------------------------------------
// A single-key read does NOT fire while suspended (child owns the TTY).
// ---------------------------------------------------------------------------

test('a single-key read does not fire while suspended', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // Suspend FIRST (an inherited-stdio child owns the TTY), then start a read.
  bridge.setSuspended(true);
  await tick();

  let resolved: string | null = null;
  void bridge.readKey().then((k) => {
    resolved = k;
  });
  await tick();
  // A key arriving while suspended must NOT resolve the read (the child owns it).
  stdin.write('y');
  await tick();
  assert.equal(resolved, null, 'no key should be consumed while suspended');

  // After resume, the parked read resolves on the next key.
  bridge.setSuspended(false);
  await tick();
  stdin.write('z');
  await tick();
  assert.equal(resolved, 'z', 'the parked read resolves after resume');
});
