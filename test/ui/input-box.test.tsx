/**
 * test/ui/input-box.test.tsx — Ink component tests for the real <InputBox>
 * editor (Step 2a). Runs under `npm run test:ui` (tsx + ink-testing-library).
 *
 * ink-testing-library's `stdin.write(...)` injects raw key bytes; we use the
 * ANSI control sequences Ink decodes into `key.*` (arrows, etc.).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBox, createInputBoxBridge } from '../../src/interface/ui/InputBox.js';

// Raw input sequences (what a terminal sends).
const ENTER = '\r';
const BACKSPACE = '\x7f';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const HOME = '\x01'; // Ctrl+A
const ALT_ENTER = '\x1b\r'; // Meta+Return

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

test('idle InputBox renders the caret (bordered, TTY+colour)', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('❯'), `expected caret, got:\n${frame}`);
  assert.ok(frame.includes('✦'), `expected box corner glyph, got:\n${frame}`);
});

test('non-TTY InputBox renders a plain caret (no border)', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={false} isTty={false} columns={60} />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('❯'), `expected caret, got:\n${frame}`);
  assert.ok(!frame.includes('✦'), `expected NO box corner, got:\n${frame}`);
});

test('typing updates the visible line', async () => {
  const bridge = createInputBoxBridge();
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('hi there');
  await tick();
  assert.ok(lastFrame()?.includes('hi there'), `got:\n${lastFrame()}`);
  assert.equal(bridge.currentLine(), 'hi there');
});

test('Enter submits (untrimmed) and clears the line', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('hello');
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['hello']);
  assert.equal(bridge.currentLine(), '');
  assert.ok(!lastFrame()?.includes('hello'), `line should be cleared, got:\n${lastFrame()}`);
});

test('backspace deletes the char before the cursor', async () => {
  const bridge = createInputBoxBridge();
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('abc');
  await tick();
  stdin.write(BACKSPACE);
  await tick();
  assert.equal(bridge.currentLine(), 'ab');
});

test('Home + insert: cursor movement edits mid-line', async () => {
  const bridge = createInputBoxBridge();
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('world');
  await tick();
  stdin.write(HOME); // cursor to start
  await tick();
  stdin.write('hello ');
  await tick();
  assert.equal(bridge.currentLine(), 'hello world');
});

test('LEFT then backspace deletes mid-line', async () => {
  const bridge = createInputBoxBridge();
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('abc');
  await tick();
  stdin.write(LEFT); // between b and c
  await tick();
  stdin.write(BACKSPACE); // delete b
  await tick();
  assert.equal(bridge.currentLine(), 'ac');
});

test('Up/Down navigate submitted-line history', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('first');
  await tick();
  stdin.write(ENTER);
  await tick();
  stdin.write('second');
  await tick();
  stdin.write(ENTER);
  await tick();
  // Up → newest ('second'), Up again → 'first'
  stdin.write(UP);
  await tick();
  assert.equal(bridge.currentLine(), 'second');
  stdin.write(UP);
  await tick();
  assert.equal(bridge.currentLine(), 'first');
  // Down → back to 'second', Down → restore empty draft
  stdin.write(DOWN);
  await tick();
  assert.equal(bridge.currentLine(), 'second');
  stdin.write(DOWN);
  await tick();
  assert.equal(bridge.currentLine(), '');
});

test('seeded history is available via Up', async () => {
  const bridge = createInputBoxBridge();
  bridge.seedHistory(['old-one', 'old-two']);
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write(UP);
  await tick();
  assert.equal(bridge.currentLine(), 'old-two');
});

test('Alt+Enter inserts a newline; plain Enter then submits the multiline value', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('line1');
  await tick();
  stdin.write(ALT_ENTER);
  await tick();
  stdin.write('line2');
  await tick();
  assert.equal(bridge.currentLine(), 'line1\nline2');
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['line1\nline2']);
});

test('queued indicator appears when setQueued(N) is called', async () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  bridge.setQueued(3);
  await tick();
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('queued (3)'), `expected queued indicator, got:\n${frame}`);
});
