/**
 * test/ui/interrupt-and-key-race.test.tsx — regression tests for three Ink-path
 * review bugs, all behind the default-OFF MYSHELL_INK flag:
 *
 *   H1 — a bare ESC during a turn must interrupt it (the StatusBlock promises
 *        "esc to interrupt"). We install a turn-interrupt handler on the bridge
 *        (the Ink twin of the legacy ESC→currentAc.abort()), press ESC in the
 *        InputBox, and assert the handler fired / the turn's AbortSignal aborted —
 *        WITHOUT clobbering the typed-ahead edit buffer.
 *
 *   M1 — a readKey() pending when the App unmounts must RESOLVE (with the cancel
 *        sentinel '\x03'), not orphan and hang the awaiting menu/confirm read.
 *
 *   M2 — a key arriving immediately after readKey() must route to the menu resolver,
 *        not mutate the editor buffer; the read still resolves on one key.
 *
 *   M3 — the first chat character written immediately after menu selection must
 *        survive the menu-to-chat visibility render before passive effects settle.
 *
 * Runs under `npm run test:ui` (tsx + ink-testing-library).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App, createInkAppBridge } from '../../src/interface/ui/App.js';
import { InputBox, createInputBoxBridge } from '../../src/interface/ui/InputBox.js';
import { mountInk } from '../../src/interface/ui/mount.js';

const ESC = '\x1b';
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

// ---------------------------------------------------------------------------
// H1 — bare ESC during a turn interrupts it (and preserves typed-ahead)
// ---------------------------------------------------------------------------

test('H1: a bare ESC during a turn fires the installed interrupt (aborts the turn)', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // The menu loop installs this for the duration of a turn: ESC → abort the
  // current turn's AbortController (mirrors legacy currentAc.abort()).
  const ac = new AbortController();
  let interruptCount = 0;
  bridge.setInterrupt(() => {
    interruptCount += 1;
    ac.abort();
  });

  // A bare ESC during the turn must interrupt it.
  stdin.write(ESC);
  await tick();

  assert.equal(interruptCount, 1, 'ESC during a turn invokes the interrupt handler exactly once');
  assert.ok(ac.signal.aborted, "the turn's AbortSignal is aborted");
});

test('H1: ESC interrupts but does NOT clobber the typed-ahead edit buffer', async () => {
  const inBridge = createInputBoxBridge();
  let interrupted = 0;
  const { stdin } = render(
    <InputBox
      bridge={inBridge}
      color={false}
      isTty={true}
      columns={60}
      onEscape={() => {
        interrupted += 1;
        return true; // a turn is active → ESC is consumed as an interrupt
      }}
    />,
  );
  await tick();

  // User types ahead DURING the turn, then presses ESC.
  stdin.write('queued line');
  await tick();
  assert.equal(inBridge.currentLine(), 'queued line', 'typed-ahead is in the buffer');

  stdin.write(ESC);
  await tick();

  assert.equal(interrupted, 1, 'ESC routed to the interrupt handler');
  assert.equal(
    inBridge.currentLine(),
    'queued line',
    'the typed-ahead line is preserved (ESC interrupts the turn, does not clear the buffer)',
  );
});

test('H1: at the idle prompt (no interrupt installed) ESC is a no-op, not a regression', async () => {
  const inBridge = createInputBoxBridge();
  // onEscape returns false → no turn is active → ESC must not be intercepted.
  const { stdin } = render(
    <InputBox bridge={inBridge} color={false} isTty={true} columns={60} onEscape={() => false} />,
  );
  await tick();

  stdin.write('hello');
  await tick();
  stdin.write(ESC);
  await tick();

  // The editor buffer is unchanged by a no-op ESC at the idle prompt.
  assert.equal(inBridge.currentLine(), 'hello', 'idle ESC leaves the edit buffer intact');
});

// ---------------------------------------------------------------------------
// M1 — a pending readKey() resolves (does not hang) on unmount
// ---------------------------------------------------------------------------

test('M1: a pending readKey() RESOLVES on unmount with the cancel sentinel', async () => {
  const handle = mountInk({ color: false, isTty: false });
  await tick();

  const keyPromise = handle.readKey();
  // Prove it is genuinely pending (not yet resolved) before teardown.
  let settled = false;
  void keyPromise.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, 'readKey() is pending before unmount');

  handle.unmount();

  // The orphan-fix: unmount() must resolve the pending resolver (sentinel '\x03').
  const key = await keyPromise;
  assert.equal(key, '\x03', "readKey() resolves with the Ctrl-C/cancel sentinel on unmount");
});

// ---------------------------------------------------------------------------
// M2 — a key immediately after readKey() is routed to the pending menu read
// ---------------------------------------------------------------------------

test('M2: a key delivered right after readKey() does not mutate the editor and the read still resolves on one key', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  // Type something so the editor has a known buffer we can assert is untouched.
  stdin.write('abc');
  await tick();
  assert.equal(bridge.input.currentLine(), 'abc', 'editor seeded');

  // Start a single-key read and deliver a key IMMEDIATELY. The readPending branch
  // must route it to the resolver without mutating the editor.
  const keyPromise = bridge.readKey();
  stdin.write('n');
  await tick();

  const key = await keyPromise;
  assert.equal(key, 'n', 'the read resolves on exactly one key');
  assert.equal(
    bridge.input.currentLine(),
    'abc',
    'the editor buffer was NOT mutated by the key delivered during the read',
  );
});

// ---------------------------------------------------------------------------
// M3 — menu-to-chat transition preserves the first immediately typed character
// ---------------------------------------------------------------------------

test('M3: the first chat character survives an immediate menu-to-chat transition', async () => {
  const bridge = createInkAppBridge();
  const { stdin } = render(<App bridge={bridge} color={false} isTty={true} columns={60} />);
  await tick();

  const choicePromise = bridge.readKey();
  stdin.write('n');
  assert.equal(await choicePromise, 'n', 'the menu selection resolves');

  // Mirror the real menu loop: entering chat makes the composer visible, and the
  // user may type before React's passive effects run for that visibility render.
  bridge.setChatActive(true);
  stdin.write('f');
  await tick();

  assert.equal(bridge.input.currentLine(), 'f', 'the first chat character is not dropped');
});
