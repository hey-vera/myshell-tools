/**
 * test/ui/menu-capture-fifo.test.tsx — BUG 2 fix: menu key-capture FIFO and
 * selective capture flag. Proves:
 *   1. A key sent while capture is active but no readKey resolver is pending is
 *      queued and consumed by the next readKey (not dropped into the editor).
 *   2. When capture is off, keys flow to the InputBox editor normally.
 *   3. Capture is explicit (off by default) — does not interfere with normal
 *      editor/readLine operation.
 *   4. FIFO preserves ordering for rapid keys.
 *   5. After a single-key read completes, the editor still works.
 *   6. setMenuCaptureActive(false) clears any stale queued keys.
 *
 * Runs under `npm run test:ui` (tsx + ink-testing-library).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App, createInkAppBridge } from '../../src/interface/ui/App.js';
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
// 1. Key queued during capture (no resolver) consumed by next readKey
// ---------------------------------------------------------------------------

test('BUG 2: a key sent while capture is active (no resolver pending) is queued and consumed by the next readKey', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // Simulate the menu loop: arm capture BEFORE paint/refresh.
  bridge.setMenuCaptureActive(true);

  // The key arrives DURING the unarmed window (no resolver pending yet).
  // It must be queued in the FIFO, not dropped into the hidden editor.
  stdin.write('n');
  await tick();

  // The editor buffer must still be empty (the key went to the FIFO, not the editor).
  assert.equal(bridge.input.currentLine(), '', 'key must be queued, not edit the hidden editor');

  // Now the menu loop calls readMenuKey after paint completes.
  // readKey drains the FIFO then the menu interprets the key.
  const { sink } = makeOut();
  const choice = await readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  assert.equal(choice, 'n', 'the queued key is consumed by readMenuKey via readKey FIFO drain');

  // Cleanup
  bridge.setMenuCaptureActive(false);
});

// ---------------------------------------------------------------------------
// 2. Capture OFF — keys flow to the editor normally (not queued)
// ---------------------------------------------------------------------------

test('BUG 2: when capture is off (default), keys flow to the InputBox editor normally', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // Default state: capture is off.
  assert.equal(bridge._menuCaptureActive, false, 'capture must default to off');

  // A key arrives while no resolver is pending → the editor receives it.
  stdin.write('x');
  await tick();
  assert.equal(bridge.input.currentLine(), 'x', 'key must go to the editor when capture is off');
});

// ---------------------------------------------------------------------------
// 3. Capture on + resolver pending → key routes to resolver (not queued)
// ---------------------------------------------------------------------------

test('BUG 2: when capture is on AND a resolver is pending, the key resolves the read (not queued)', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  bridge.setMenuCaptureActive(true);

  // Start a readKey — now there IS a resolver pending.
  const keyPromise = bridge.readKey();
  stdin.write('q');
  await tick();

  const key = await keyPromise;
  assert.equal(key, 'q', 'the key resolves the pending read, not queued');
  // FIFO should still be empty (key went to resolver, not queue).
  assert.equal(bridge._menuKeyQueue.length, 0, 'FIFO must remain empty when resolver consumes the key');

  bridge.setMenuCaptureActive(false);
});

// ---------------------------------------------------------------------------
// 4. FIFO preserves ordering for rapid keys
// ---------------------------------------------------------------------------

test('BUG 2: rapid keys sent during capture maintain FIFO order', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  bridge.setMenuCaptureActive(true);

  // Send multiple keys rapidly during the unarmed window.
  stdin.write('a');
  await tick();
  stdin.write('b');
  await tick();
  stdin.write('c');
  await tick();

  // First readKey drains 'a'.
  assert.equal(await bridge.readKey(), 'a');
  // Second drains 'b'.
  assert.equal(await bridge.readKey(), 'b');
  // Third drains 'c'.
  assert.equal(await bridge.readKey(), 'c');
  // Fourth has no queued keys left → creates a resolver.
  const laterKey = bridge.readKey();
  stdin.write('d');
  assert.equal(await laterKey, 'd');

  bridge.setMenuCaptureActive(false);
});

// ---------------------------------------------------------------------------
// 5. setMenuCaptureActive(false) clears stale queued keys
// ---------------------------------------------------------------------------

test('BUG 2: setMenuCaptureActive(false) clears stale queued keys', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  bridge.setMenuCaptureActive(true);

  // Queue a key.
  stdin.write('z');
  await tick();
  assert.equal(bridge._menuKeyQueue.length, 1, 'key is queued');

  // Disarm capture — the queue must be cleared.
  bridge.setMenuCaptureActive(false);
  assert.equal(bridge._menuKeyQueue.length, 0, 'queue cleared on disarm');

  // A subsequent readKey without capture active arms a resolver normally.
  const keyPromise = bridge.readKey();
  stdin.write('y');
  assert.equal(await keyPromise, 'y', 'readKey works normally after capture off');
});

// ---------------------------------------------------------------------------
// 6. After a captured key read, the editor still works
// ---------------------------------------------------------------------------

test('BUG 2: after a captured key read + capture disarm, the editor accepts lines normally', async () => {
  const bridge = createInkAppBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // Arm capture and queue a key, then read it.
  bridge.setMenuCaptureActive(true);
  stdin.write('n');
  await tick();
  assert.equal(await bridge.readKey(), 'n');

  // Disarm capture (simulates entering a sub-flow).
  bridge.setMenuCaptureActive(false);
  bridge.setChatActive(true);

  // The editor must now accept typed lines normally.
  stdin.write('hello world');
  await tick();
  assert.equal(bridge.input.currentLine(), 'hello world');
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['hello world']);
});

// ---------------------------------------------------------------------------
// 7. Non-printable keys during capture are also queued
// ---------------------------------------------------------------------------

test('BUG 2: Enter key sent during capture is queued (no-op re-render)', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  bridge.setMenuCaptureActive(true);
  stdin.write(ENTER);
  await tick();

  const { sink } = makeOut();
  const choice = await readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  // Enter is a no-op → readMenuKey returns ''.
  assert.equal(choice, '', 'Enter queued via capture resolves as no-op');

  bridge.setMenuCaptureActive(false);
});

// ---------------------------------------------------------------------------
// 8. Capture is NEVER global — it only applies when explicitly enabled
// ---------------------------------------------------------------------------

test('BUG 2: capture is off by default and does not interfere with readKey resolving a line', async () => {
  const bridge = createInkAppBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // No setMenuCaptureActive → capture is off.
  // Type a line with Enter — it should submit to the editor.
  stdin.write('test line');
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['test line'], 'editor submit must work with capture off');

  // readKey works normally without capture (creates a resolver).
  const keyPromise = bridge.readKey();
  stdin.write('n');
  assert.equal(await keyPromise, 'n');

  // After the read, the editor buffer is still clean.
  assert.equal(bridge.input.currentLine(), '', 'editor must be clean after single-key read');
});

// ---------------------------------------------------------------------------
// 9. Ctrl-C during capture with no resolver → queued, then readKey returns
//    the cancel sentinel
// ---------------------------------------------------------------------------

test('BUG 2: Ctrl-C during capture (no resolver) is queued then resolved as null by readMenuKey', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  bridge.setMenuCaptureActive(true);

  // Send Ctrl-C while no resolver is pending.
  stdin.write('\x03');
  await tick();

  // readMenuKey drains the FIFO via readKey, then maps '\x03' to null (exit).
  const { sink } = makeOut();
  const choice = await readMenuKey(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  assert.equal(choice, null, 'Ctrl-C via capture resolves as exit');

  bridge.setMenuCaptureActive(false);
});

// ---------------------------------------------------------------------------
// 10. Confirm (y/n) works without capture active (auth/login prompts)
// ---------------------------------------------------------------------------

test('BUG 2: y/n confirm works normally when capture is off (auth/settings prompts unaffected)', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // Capture is off (as it would be in auth/settings).
  bridge.setMenuCaptureActive(false);

  const { sink } = makeOut();
  const confirm = makeConfirm(sink, () => new Promise<string | null>(() => {}), undefined, false, () =>
    bridge.readKey(),
  );
  const verdict = confirm(true);
  await tick();
  stdin.write('y');
  await tick();
  assert.equal(await verdict, true, 'confirm must work with capture off');
});

// ---------------------------------------------------------------------------
// 11. readKey already pending + setMenuCaptureActive does not interfere
// ---------------------------------------------------------------------------

test('BUG 2: readKey pending while capture is on → capture does not steal the resolver', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // Start a readKey FIRST.
  const keyPromise = bridge.readKey();

  // Then arm capture (simulates menu loop arming capture for the NEXT iteration).
  bridge.setMenuCaptureActive(true);

  // A key arrives — must resolve the pending readKey, NOT be queued.
  stdin.write('n');
  const key = await keyPromise;
  assert.equal(key, 'n', 'pending readKey must resolve with capture on');
  assert.equal(bridge._menuKeyQueue.length, 0, 'no key should be queued when resolver was pending');

  bridge.setMenuCaptureActive(false);
});

// ---------------------------------------------------------------------------
// 12. readKey drains FIFO before arming a resolver (no busy-wait / no spin)
// ---------------------------------------------------------------------------

test('BUG 2: readKey draining FIFO returns immediately (no async delay)', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  bridge.setMenuCaptureActive(true);
  stdin.write('n');
  await tick();

  // readKey should resolve synchronously (the queued key is already in the FIFO).
  const start = Date.now();
  const key = await bridge.readKey();
  const elapsed = Date.now() - start;
  assert.equal(key, 'n', 'queued key is returned');
  assert.ok(elapsed < 20, 'FIFO drain must not incur IO delay');

  bridge.setMenuCaptureActive(false);
});
