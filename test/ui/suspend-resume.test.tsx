/**
 * test/ui/suspend-resume.test.tsx — Step-2b coverage for the inherited-stdio
 * child handoff: createInkLineReader.suspend()/resume() driving the Ink App's
 * suspended state + Ink's raw-mode control.
 *
 * Runs under `npm run test:ui` (tsx + ink-testing-library). ink-testing-library
 * wires its own stdin (a small EventEmitter with setRawMode); rendering the real
 * <App> through it exercises the useStdin()-captured control end-to-end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App, createInkAppBridge } from '../../src/interface/ui/App.js';
import { createInkLineReader } from '../../src/interface/ui/mount.js';

const ENTER = '\r';
const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('suspend() makes input inactive: typing does nothing while suspended', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  const { stdin } = render(<App bridge={bridge} color={true} isTty={true} columns={60} />);
  await tick();

  reader.suspend();
  await tick();

  // While suspended, the InputBox useInput is isActive:false — bytes are ignored.
  stdin.write('ghost');
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.equal(bridge.input.currentLine(), '', 'suspended input must not accept typing');
  assert.deepEqual(reader.drainBuffered(), [], 'no line should have submitted while suspended');
});

test('resume() restores input: the FIRST line after resume is received', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  const { stdin } = render(<App bridge={bridge} color={true} isTty={true} columns={60} />);
  await tick();

  reader.suspend();
  await tick();
  reader.resume();
  await tick();

  // Regression guard for the historical "first paste after login fails" bug: the
  // very first submission after resume must land.
  const pending = reader.nextLine();
  stdin.write('first-after-resume');
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.equal(await pending, 'first-after-resume');
});

test('resume() suppresses an immediate blank submit (child trailing Enter)', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  render(<App bridge={bridge} color={true} isTty={true} columns={60} />);
  await tick();

  reader.suspend();
  await tick();
  reader.resume();
  await tick();

  // A blank line arriving in the suppression window (the child's queued Enter) is
  // dropped, not delivered as an empty submission.
  bridge.input._submit?.('');
  assert.deepEqual(reader.drainBuffered(), [], 'immediate blank after resume must be suppressed');

  // A non-blank line in the same window is NOT suppressed.
  bridge.input._submit?.('real');
  assert.deepEqual(reader.drainBuffered(), ['real']);
});

test('suppression only catches ONE blank, then normal blanks pass through', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  render(<App bridge={bridge} color={true} isTty={true} columns={60} />);
  await tick();

  reader.suspend();
  reader.resume();
  bridge.input._submit?.(''); // suppressed (the one trailing Enter)
  bridge.input._submit?.(''); // window now cleared → delivered as a normal blank
  assert.deepEqual(reader.drainBuffered(), [''], 'only the first blank is suppressed');
});

test('suspend()/resume() are idempotent and safe when never suspended', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  const { stdin } = render(<App bridge={bridge} color={true} isTty={true} columns={60} />);
  await tick();

  // resume() with no prior suspend() is a no-op (must not arm suppression).
  reader.resume();
  bridge.input._submit?.(''); // no suppression armed → delivered
  assert.deepEqual(reader.drainBuffered(), ['']);

  // Double suspend, double resume — no throw, input works after.
  reader.suspend();
  reader.suspend();
  await tick();
  reader.resume();
  reader.resume();
  await tick();

  const pending = reader.nextLine();
  stdin.write('works');
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.equal(await pending, 'works');
});

test('suspend() clears the buffered line backlog', () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  render(<App bridge={bridge} color={true} isTty={true} columns={60} />);

  bridge.input._submit?.('stale-1');
  bridge.input._submit?.('stale-2');
  reader.suspend();
  assert.deepEqual(reader.drainBuffered(), [], 'suspend() must drop buffered lines');
});

test('suspend() drives Ink cooked mode via the registered control', async () => {
  const bridge = createInkAppBridge();
  const reader = createInkLineReader(bridge);
  render(<App bridge={bridge} color={true} isTty={true} columns={60} />);
  await tick();

  // The InputBox registered an Ink stdin control from inside useStdin().
  assert.ok(bridge.stdinControl !== null, 'an Ink stdin control should be registered after mount');

  // Spy on the control: suspend() forces cooked mode (belt-and-suspenders before
  // Ink's isActive:false effect runs); resume() does NOT touch raw mode directly
  // (Ink re-takes it on the isActive 0→1 transition — the readable-listener
  // re-prime), so no raw call is expected on resume.
  const calls: string[] = [];
  bridge.attachStdinControl({
    setRawMode: (v: boolean) => calls.push(`raw:${v}`),
    isRawModeSupported: true,
  });

  reader.suspend();
  assert.deepEqual(calls, ['raw:false'], 'suspend() forces cooked mode');

  calls.length = 0;
  reader.resume();
  assert.deepEqual(calls, [], 'resume() leaves raw-mode re-take to Ink (isActive toggle)');
});
