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
import { InputBox, composerRules, createInputBoxBridge } from '../../src/interface/ui/InputBox.js';
import { visibleLength } from '../../src/ui/tui.js';

// Raw input sequences (what a terminal sends).
const ENTER = '\r';
const BACKSPACE = '\x7f';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const HOME = '\x01'; // Ctrl+A
const ALT_ENTER = '\x1b\r'; // Meta+Return

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

/** Strip ANSI SGR colour codes so frame assertions match the visible glyphs. */
const plain = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

test('idle InputBox renders the full-width composer and info chip (TTY+colour)', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  const frame = plain(lastFrame());
  assert.ok(frame.includes('❯'), `expected caret, got:\n${frame}`);
  assert.ok(frame.includes('─ chat '), `expected chat rule, got:\n${frame}`);
  assert.ok(frame.includes('┌ Mode Balanced · /goal · /help · /back ┐'), `expected info chip, got:\n${frame}`);
  assert.ok(frame.includes('Type a message...'), `expected placeholder, got:\n${frame}`);
  assert.ok(!frame.includes('✦'), `old mini-box glyph must not render, got:\n${frame}`);
});

test('non-TTY InputBox renders a plain caret (no border)', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={false} isTty={false} columns={60} />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('❯'), `expected caret, got:\n${frame}`);
  assert.ok(!frame.includes('┌'), `expected NO info chip, got:\n${frame}`);
  assert.ok(!frame.includes('─ chat'), `expected NO rule, got:\n${frame}`);
  assert.ok(!frame.includes('\x1b['), `expected NO ANSI, got:\n${frame}`);
});

test('hidden InputBox (visible=false) renders the minimal menu prompt, not the composer', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} visible={false} />,
  );
  const frame = plain(lastFrame());
  assert.ok(frame.includes('❯'), `expected the menu-prompt caret, got:\n${frame}`);
  assert.ok(frame.includes('press a key'), `expected the single-key hint, got:\n${frame}`);
  // NOT the full composer: no chat rule, no Mode chip, no free-text placeholder.
  assert.ok(!frame.includes('─ chat '), `menu prompt must NOT show the chat rule, got:\n${frame}`);
  assert.ok(!frame.includes('┌ Mode'), `menu prompt must NOT show the Mode chip, got:\n${frame}`);
  assert.ok(!frame.includes('Type a message'), `menu prompt must NOT imply free-text typing, got:\n${frame}`);
});

test('hidden InputBox degrades to a bare caret (non-TTY / NO_COLOR), never blank', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={false} isTty={false} columns={60} visible={false} />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('❯'), `expected a bare caret affordance, got:\n${frame}`);
  assert.ok(!frame.includes('\x1b['), `expected NO ANSI in the degraded prompt, got:\n${frame}`);
  assert.ok(frame.trim() !== '', 'degraded prompt must not be blank');
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

// ---------------------------------------------------------------------------
// FIX 1 — multiline vertical rendering
// ---------------------------------------------------------------------------

test('multiline buffer renders adjacent composer rows (caret on row 1, gutter on row 2)', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('line1');
  await tick();
  stdin.write(ALT_ENTER);
  await tick();
  stdin.write('line2');
  await tick();
  const frame = plain(lastFrame());
  // Both lines appear, on separate rows, inside the composer.
  assert.ok(frame.includes('❯ line1'), `expected caret row, got:\n${frame}`);
  assert.ok(frame.includes('… line2'), `expected continuation row, got:\n${frame}`);
  // The two logical rows render on different physical lines.
  const rows = frame.split('\n');
  const r1 = rows.findIndex((r) => r.includes('line1'));
  const r2 = rows.findIndex((r) => r.includes('line2'));
  assert.ok(r1 !== -1 && r2 !== -1 && r2 === r1 + 1, `rows should be adjacent, got:\n${frame}`);
  // Full-width rules still frame the (now taller) input, without old side rails.
  assert.ok(frame.includes('─ chat '), `expected top rule, got:\n${frame}`);
  assert.ok(frame.includes('└'), `expected chip bottom, got:\n${frame}`);
  assert.ok(!frame.includes('│'), `expected no old side rails, got:\n${frame}`);
});

test('multiline submit sends the full \\n-joined buffer', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('a');
  await tick();
  stdin.write(ALT_ENTER);
  await tick();
  stdin.write('b');
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['a\nb']);
});

test('Up/Down move the caret between rows on a multiline buffer (not history)', async () => {
  const bridge = createInputBoxBridge();
  bridge.seedHistory(['old-line']); // history exists but must NOT trigger mid-buffer
  bridge.onSubmit(() => {});
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('aaa');
  await tick();
  stdin.write(ALT_ENTER);
  await tick();
  stdin.write('bbb'); // buffer "aaa\nbbb", cursor at end (row 1, col 3)
  await tick();
  // Up → row 0 col 3 (no history navigation while a row is above).
  stdin.write(UP);
  await tick();
  assert.equal(bridge.currentLine(), 'aaa\nbbb', 'Up within buffer must not change the value');
  // Insert at the moved caret to prove it landed on row 0.
  stdin.write('X'); // "aaaX\nbbb"
  await tick();
  assert.equal(bridge.currentLine(), 'aaaX\nbbb');
  // Up again from the FIRST row falls through to history.
  stdin.write(UP);
  await tick();
  assert.equal(bridge.currentLine(), 'old-line');
});

// ---------------------------------------------------------------------------
// FIX 2 — paste ending in a newline auto-submits
// ---------------------------------------------------------------------------

test('paste ending in CR auto-submits on the FIRST write (auth-code case)', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('authcode123\r'); // one paste chunk ending in CR
  await tick();
  assert.deepEqual(submitted, ['authcode123'], 'paste should submit without a second Enter');
  assert.equal(bridge.currentLine(), '', 'editor should be cleared after submit');
});

test('paste ending in LF auto-submits', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('hello world\n');
  await tick();
  assert.deepEqual(submitted, ['hello world']);
});

test('paste with INTERNAL newline + trailing newline inserts then submits', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('line1\nline2\r'); // internal \n composed, trailing \r submits
  await tick();
  assert.deepEqual(submitted, ['line1\nline2']);
});

test('paste with ONLY internal newlines (no trailing) does NOT submit', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('line1\nline2'); // no trailing newline → stays in the buffer
  await tick();
  assert.deepEqual(submitted, [], 'internal-only newline paste must not submit');
  assert.equal(bridge.currentLine(), 'line1\nline2');
});

test('paste ending in CRLF submits a single clean line (no stray \\r)', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('code456\r\n');
  await tick();
  assert.deepEqual(submitted, ['code456']);
});

test('Alt+Enter still inserts a newline and does NOT submit', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('keep');
  await tick();
  stdin.write(ALT_ENTER);
  await tick();
  assert.deepEqual(submitted, [], 'Alt+Enter must not submit');
  assert.equal(bridge.currentLine(), 'keep\n');
});

test('plain single Enter still submits typed input (no paste path interference)', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('typed');
  await tick();
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['typed']);
});

test('queued indicator appears when setQueued(N) is called', async () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  bridge.setQueued(3);
  await tick();
  const frame = plain(lastFrame());
  assert.ok(frame.includes('queued (3)'), `expected queued indicator, got:\n${frame}`);
  const rows = frame.split('\n');
  const queuedRow = rows.findIndex((r) => r.includes('queued (3)'));
  assert.ok(queuedRow > 0, `queued row should sit below top rule, got:\n${frame}`);
  assert.ok(rows.slice(queuedRow + 1).some((r) => r.includes('└')), `queued row should sit above bottom rule, got:\n${frame}`);
});

test('composerRules pins the mode chip and grows past the old 84-column clamp', () => {
  const rules = composerRules(100, 'Mode Balanced · /goal · /help · /back', false);
  assert.equal(visibleLength(rules.top), 100);
  assert.equal(visibleLength(rules.bottom), 100);
  assert.ok(rules.top.includes('┌ Mode Balanced · /goal · /help · /back ┐'), `got:\n${rules.top}`);
});

test('NO_COLOR InputBox falls back to plain caret without chip or ANSI', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={false} isTty={true} columns={60} />,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('❯'), `expected caret, got:\n${frame}`);
  assert.ok(!frame.includes('┌'), `expected no chip, got:\n${frame}`);
  assert.ok(!frame.includes('\x1b['), `expected no ANSI, got:\n${frame}`);
});
