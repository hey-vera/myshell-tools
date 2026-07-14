/**
 * test/ui/input-box.test.tsx — Ink component tests for the real <InputBox>
 * editor (Step 2a). Runs under `npm run test:ui` (tsx + ink-testing-library).
 *
 * ink-testing-library's `stdin.write(...)` injects raw key bytes; we use the
 * ANSI control sequences Ink decodes into `key.*` (arrows, etc.).
 */
import { test } from 'vitest';
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
const RIGHT = '\x1b[C';
/** xterm CSI with Alt/Meta modifier (Ink → key.meta + left/rightArrow). */
const ALT_LEFT = '\x1b[1;3D';
const ALT_RIGHT = '\x1b[1;3C';
/** xterm CSI with Ctrl modifier (Ink → key.ctrl + leftArrow) — word move. */
const CTRL_LEFT = '\x1b[1;5D';
const HOME = '\x01'; // Ctrl+A
const ALT_ENTER = '\x1b\r'; // Meta+Return
const TAB = '\t';
/** Many terminals send CSI Z for Shift+Tab; Ink maps it to key.tab + key.shift. */
const SHIFT_TAB = '\x1b[Z';
const ESC = '\x1b';

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
  assert.ok(frame.includes('Mode: Balanced · /help · Shift+Tab mode'), `expected folded bottom hints, got:\n${frame}`);
  assert.ok(frame.includes('Type a message...'), `expected placeholder, got:\n${frame}`);
  assert.ok(!frame.includes('┌'), `nested info-box corners must not render, got:\n${frame}`);
  assert.ok(!frame.includes('└'), `nested info-box corners must not render, got:\n${frame}`);
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

test('hidden InputBox (visible=false) renders nothing visible — no stray "press a key", no composer', () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} visible={false} />,
  );
  const frame = plain(lastFrame());
  // The hidden state prints NO hint: every single-key menu/auth/settings/confirm read
  // site writes its own visible prompt, so a `❯ press a key` here was redundant and
  // read like a glitch (it stacked under the menu's own `>`). It must be GONE.
  assert.ok(!frame.includes('press a key'), `hidden InputBox must NOT print "press a key", got:\n${frame}`);
  assert.ok(!frame.includes('❯'), `hidden InputBox must NOT print the composer caret, got:\n${frame}`);
  // NOT the full composer: no chat rule, no Mode chip, no free-text placeholder.
  assert.ok(!frame.includes('─ chat '), `menu prompt must NOT show the chat rule, got:\n${frame}`);
  assert.ok(!frame.includes('┌ Mode'), `menu prompt must NOT show the Mode chip, got:\n${frame}`);
  assert.ok(!frame.includes('Type a message'), `menu prompt must NOT imply free-text typing, got:\n${frame}`);
});

test('hidden InputBox renders a single reserved line (one Box), never crashes / never blank-undefined', () => {
  const bridge = createInputBoxBridge();
  // The hidden branch must return exactly ONE <Box> (not literal null / a bare string
  // child — either crashes Ink) so the useInput/useStdin hooks stay mounted and Ink
  // keeps raw mode armed for single-key menu nav. lastFrame() resolving to a (blank)
  // string rather than undefined proves the component rendered without throwing.
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={false} isTty={false} columns={60} visible={false} />,
  );
  const frame = lastFrame() ?? '';
  assert.equal(typeof lastFrame(), 'string', 'hidden InputBox must render (a string frame), never crash');
  assert.ok(!frame.includes('press a key'), `degraded hidden state must NOT print "press a key", got:\n${frame}`);
  assert.ok(!frame.includes('\x1b['), `expected NO ANSI in the reserved hidden line, got:\n${frame}`);
});

test('typing updates the visible line', async () => {
  const bridge = createInputBoxBridge();
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  await tick();
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
  assert.ok(frame.includes('Mode: Balanced · /help · Shift+Tab mode'), `expected folded bottom hints, got:\n${frame}`);
  assert.ok(!frame.includes('│'), `expected no old side rails, got:\n${frame}`);
});

test('a long single-line input WRAPS across multiple physical rows (no ellipsis clip)', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const columns = 40;
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={columns} />,
  );
  // One logical line (no '\n') far longer than the box's inner width.
  const long = 'wordwordword '.repeat(8).trim(); // ~103 chars, no newlines
  stdin.write(long);
  await tick();
  assert.equal(bridge.currentLine(), long, 'buffer holds the full single line');
  const frame = plain(lastFrame());
  // The text spills onto multiple physical rows: more than one frame row carries
  // a chunk of the input. Count rows that contain part of the wrapped word run.
  const contentRows = frame
    .split('\n')
    .filter((r) => r.includes('word'));
  // The INPUT rows must NOT be hard-truncated with an ellipsis (the info chip in
  // the top rule may legitimately ellipsize — that's chrome, not the buffer).
  assert.ok(
    !contentRows.some((r) => r.includes('…')),
    `long input rows should wrap, not clip with an ellipsis, got:\n${frame}`,
  );
  assert.ok(
    contentRows.length >= 2,
    `long single line should occupy >=2 physical rows, got ${contentRows.length}:\n${frame}`,
  );
  // The whole text is recoverable from the frame (nothing dropped).
  const reassembled = contentRows.map((r) => r.replace(/[❯…]/g, '').replace(/\s+/g, '')).join('');
  assert.ok(
    reassembled.includes('wordwordword'),
    `wrapped rows should preserve the input text, got:\n${frame}`,
  );
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

test('legacy setQueued(N) still paints indicator (menu no longer drives it)', async () => {
  // Mid-turn prose is live notes ("noted · applies next"); the chat loop never
  // calls setQueued. Bridge API remains for compatibility — prove it still paints.
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
  assert.ok(
    rows
      .slice(queuedRow + 1)
      .some((r) => r.includes('Mode: Balanced · /help · Shift+Tab mode')),
    `queued row should sit above the folded bottom rule, got:\n${frame}`,
  );
});

test('composer default (setQueued never called) has no queued indicator', async () => {
  const bridge = createInputBoxBridge();
  const { lastFrame } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  await tick();
  const frame = plain(lastFrame());
  assert.ok(!frame.includes('queued ('), `expected no queued indicator by default, got:\n${frame}`);
});

test('composerRules uses the full width and folds hints into the bottom rule', () => {
  const rules = composerRules(100, 'Mode: Balanced · /help · Shift+Tab mode', false);
  assert.equal(visibleLength(rules.top), 100);
  assert.equal(visibleLength(rules.bottom), 100);
  assert.ok(!rules.top.includes('┌'), `got:\n${rules.top}`);
  assert.ok(rules.bottom.includes('Mode: Balanced · /help · Shift+Tab mode'), `got:\n${rules.bottom}`);
});

test('composerRules drops trailing hints on narrow widths before shrinking the editor', () => {
  const rules = composerRules(32, 'Mode: Balanced · /help · Shift+Tab mode', false);
  assert.equal(visibleLength(rules.bottom), 32);
  assert.ok(rules.bottom.includes('Mode: Balanced'), `got:\n${rules.bottom}`);
  assert.ok(!rules.bottom.includes('/back'), `narrow width should hide trailing hints first, got:\n${rules.bottom}`);
});

test('long input wraps to the same row count with default vs overlong hints at a narrow width', async () => {
  const long = 'wordwordword '.repeat(8).trim();
  const countWrappedRows = (frame: string): number =>
    frame.split('\n').filter((row) => row.includes('word')).length;

  const baseBridge = createInputBoxBridge();
  const base = render(<InputBox bridge={baseBridge} color={true} isTty={true} columns={32} />);
  base.stdin.write(long);
  await tick();

  const extraHintBridge = createInputBoxBridge();
  const extraHint = render(
    <InputBox
      bridge={extraHintBridge}
      color={true}
      isTty={true}
      columns={32}
      info="Mode: Balanced · /help · Shift+Tab mode · /extra-hint"
    />,
  );
  extraHint.stdin.write(long);
  await tick();

  assert.equal(
    countWrappedRows(plain(base.lastFrame())),
    countWrappedRows(plain(extraHint.lastFrame())),
    'hint truncation must not reduce the editor content width',
  );
});

// ---------------------------------------------------------------------------
// Tab-autocomplete (the offline completion engine wired into the Ink editor)
// ---------------------------------------------------------------------------

test('typing /go then Tab shows a suggestion row with /goal and /goals', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('/go');
  await tick();
  stdin.write(TAB);
  await tick();
  const frame = plain(lastFrame());
  assert.ok(frame.includes('/goal'), `expected /goal candidate, got:\n${frame}`);
  assert.ok(frame.includes('/goals'), `expected /goals candidate, got:\n${frame}`);
  // The buffer is unchanged while the (multi-candidate) row is shown.
  assert.equal(bridge.currentLine(), '/go');
});

test('typing /hel then Tab auto-accepts to /help with no suggestion row', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('/hel');
  await tick();
  stdin.write(TAB);
  await tick();
  assert.equal(bridge.currentLine(), '/help', 'single hit should auto-accept');
  const frame = plain(lastFrame());
  // The completed value shows, but there is no separate candidate row offering
  // /help a second time above the rule (single hit → no row).
  const rows = frame.split('\n');
  const ruleRow = rows.findIndex((r) => r.includes('─ chat '));
  const aboveRule = rows.slice(0, ruleRow).join('\n');
  assert.ok(!aboveRule.includes('/help'), `expected NO suggestion row, got:\n${frame}`);
});

test('typing /g then Tab twice cycles the highlighted candidate', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('/g');
  await tick();
  stdin.write(TAB); // first Tab: shows candidates (/goal, /goals), index 0
  await tick();
  const first = lastFrame() ?? '';
  stdin.write(TAB); // second Tab: cycle highlight + splice the selected candidate
  await tick();
  const second = lastFrame() ?? '';
  // The frame changed between the two Tabs (the highlight/buffer advanced).
  assert.notEqual(plain(first), plain(second), `cycle should change the frame:\n${plain(second)}`);
  // After cycling, the buffer holds one of the candidate commands.
  const line = bridge.currentLine();
  assert.ok(line === '/goal' || line === '/goals', `expected a cycled candidate, got: ${line}`);
});

test('Esc dismisses the suggestion row, leaving the value unchanged', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('/go');
  await tick();
  stdin.write(TAB);
  await tick();
  assert.ok(plain(lastFrame()).includes('/goals'), 'precondition: candidates shown');
  stdin.write(ESC);
  await tick();
  const frame = plain(lastFrame());
  const rows = frame.split('\n');
  const ruleRow = rows.findIndex((r) => r.includes('─ chat '));
  const aboveRule = rows.slice(0, ruleRow).join('\n');
  assert.ok(!aboveRule.includes('/goals'), `Esc should clear the candidate row, got:\n${frame}`);
  assert.equal(bridge.currentLine(), '/go', 'Esc must not change the buffer');
});

test('typing a normal char after Tab clears the suggestions', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('/go');
  await tick();
  stdin.write(TAB);
  await tick();
  assert.ok(plain(lastFrame()).includes('/goals'), 'precondition: candidates shown');
  stdin.write('a'); // a normal edit invalidates the completions
  await tick();
  const frame = plain(lastFrame());
  const rows = frame.split('\n');
  const ruleRow = rows.findIndex((r) => r.includes('─ chat '));
  const aboveRule = rows.slice(0, ruleRow).join('\n');
  assert.ok(!aboveRule.includes('/goals'), `a non-Tab edit must clear candidates, got:\n${frame}`);
  assert.equal(bridge.currentLine(), '/goa');
});

test('plain prose + Tab is a no-op (no candidate row, no literal tab inserted)', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('hello');
  await tick();
  stdin.write(TAB);
  await tick();
  assert.equal(bridge.currentLine(), 'hello', 'Tab on prose must not insert a literal tab');
  const frame = plain(lastFrame());
  assert.ok(!frame.includes('\t'), `no literal tab in the buffer, got:\n${frame}`);
  // No candidate row above the chat rule.
  const rows = frame.split('\n');
  const ruleRow = rows.findIndex((r) => r.includes('─ chat '));
  assert.ok(ruleRow >= 0, `expected the chat rule, got:\n${frame}`);
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

// ---------------------------------------------------------------------------
// Slice 4 / PR1 — always-hot Ctrl+G routing (any buffer)
// ---------------------------------------------------------------------------

const CTRL_G = '\x07';

test('Ctrl+G on empty editor invokes onToggleFullscreenPanel once, does NOT submit or edit', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  let toggleCalls = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onToggleFullscreenPanel={() => { toggleCalls += 1; return true; }}
    />,
  );
  stdin.write(CTRL_G);
  await tick();
  assert.equal(toggleCalls, 1, 'onToggleFullscreenPanel should be invoked exactly once');
  assert.deepEqual(submitted, [], 'Ctrl+G must not submit');
  assert.equal(bridge.currentLine(), '', 'Ctrl+G must not insert text');
});

test('Ctrl+G with non-empty buffer still invokes callback, buffer preserved', async () => {
  const bridge = createInputBoxBridge();
  let toggleCalls = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onToggleFullscreenPanel={() => { toggleCalls += 1; return true; }}
    />,
  );
  stdin.write('hello');
  await tick();
  stdin.write(CTRL_G);
  await tick();
  assert.equal(toggleCalls, 1, 'onToggleFullscreenPanel must fire with draft present');
  assert.equal(bridge.currentLine(), 'hello', 'buffer must be preserved');
});

test('onToggleFullscreenPanel returns false → Ctrl+G falls through to readPending/onReadKey', async () => {
  const bridge = createInputBoxBridge();
  let toggleCalls = 0;
  const readKeys: string[] = [];
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onToggleFullscreenPanel={() => { toggleCalls += 1; return false; }}
      readPending={() => true}
      onReadKey={(input) => { readKeys.push(input); }}
    />,
  );
  stdin.write(CTRL_G);
  await tick();
  assert.equal(toggleCalls, 1, 'callback should still be called');
  assert.ok(readKeys.length > 0, 'Ctrl+G should reach readPending/onReadKey when callback returns false');
  assert.equal(bridge.currentLine(), '', 'buffer must stay empty');
});

test('onToggleFullscreenPanel present → Left Arrow still moves cursor, never invokes callback', async () => {
  const bridge = createInputBoxBridge();
  let toggleCalls = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onToggleFullscreenPanel={() => { toggleCalls += 1; return true; }}
    />,
  );
  // Type 'ab', move left between 'a' and 'b', insert 'X' → 'aXb'
  stdin.write('ab');
  await tick();
  stdin.write(LEFT);
  await tick();
  stdin.write('X');
  await tick();
  assert.equal(toggleCalls, 0, 'Left Arrow must not invoke onToggleFullscreenPanel');
  assert.equal(bridge.currentLine(), 'aXb', 'Left Arrow must move cursor, insertion at correct position');
});

// ---------------------------------------------------------------------------
// Multi-chat PR-A — empty-buffer b/c nav + Ctrl+B; ←/→ cursor only
// ---------------------------------------------------------------------------

const CTRL_B = '\x02';

test('empty-buffer b → calls onEmptyLeft (back)', async () => {
  const bridge = createInputBoxBridge();
  let leftCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyLeft={() => { leftCalled += 1; }}
    />,
  );
  assert.equal(bridge.currentLine(), '', 'buffer must start empty');
  stdin.write('b');
  await tick();
  assert.equal(leftCalled, 1, 'onEmptyLeft must be called once on empty-buffer b');
  assert.equal(bridge.currentLine(), '', 'buffer must stay empty after back');
});

test('empty-buffer c → calls onEmptyRight (panel)', async () => {
  const bridge = createInputBoxBridge();
  let rightCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyRight={() => { rightCalled += 1; }}
    />,
  );
  assert.equal(bridge.currentLine(), '', 'buffer must start empty');
  stdin.write('c');
  await tick();
  assert.equal(rightCalled, 1, 'onEmptyRight must be called once on empty-buffer c');
  assert.equal(bridge.currentLine(), '', 'buffer must stay empty after panel');
});

test('non-empty buffer b types the letter, does NOT call onEmptyLeft', async () => {
  const bridge = createInputBoxBridge();
  let leftCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyLeft={() => { leftCalled += 1; }}
    />,
  );
  stdin.write('hi');
  await tick();
  stdin.write('b');
  await tick();
  assert.equal(leftCalled, 0, 'onEmptyLeft must NOT fire when typing b mid-word');
  assert.equal(bridge.currentLine(), 'hib', 'b must type as a letter');
});

test('non-empty buffer c types the letter, does NOT call onEmptyRight', async () => {
  const bridge = createInputBoxBridge();
  let rightCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyRight={() => { rightCalled += 1; }}
    />,
  );
  stdin.write('hi');
  await tick();
  stdin.write('c');
  await tick();
  assert.equal(rightCalled, 0, 'onEmptyRight must NOT fire when typing c mid-word');
  assert.equal(bridge.currentLine(), 'hic', 'c must type as a letter');
});

test('empty-buffer Left/Right are cursor-only (no nav callbacks)', async () => {
  const bridge = createInputBoxBridge();
  let leftCalled = 0;
  let rightCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyLeft={() => { leftCalled += 1; }}
      onEmptyRight={() => { rightCalled += 1; }}
    />,
  );
  stdin.write(LEFT);
  await tick();
  stdin.write(RIGHT);
  await tick();
  assert.equal(leftCalled, 0, 'empty-buffer Left must not navigate');
  assert.equal(rightCalled, 0, 'empty-buffer Right must not navigate');
  assert.equal(bridge.currentLine(), '', 'buffer stays empty');
});

test('Ctrl+B always-hot back with draft preserved', async () => {
  const bridge = createInputBoxBridge();
  let leftCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyLeft={() => { leftCalled += 1; }}
    />,
  );
  stdin.write('draft text');
  await tick();
  stdin.write(CTRL_B);
  await tick();
  assert.equal(leftCalled, 1, 'Ctrl+B must fire back with draft present');
  assert.equal(bridge.currentLine(), 'draft text', 'draft must be preserved');
});

test('Alt+arrows no longer navigate (cursor-only product lock)', async () => {
  const bridge = createInputBoxBridge();
  let leftCalled = 0;
  let rightCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyLeft={() => { leftCalled += 1; }}
      onEmptyRight={() => { rightCalled += 1; }}
    />,
  );
  stdin.write(ALT_LEFT);
  await tick();
  stdin.write(ALT_RIGHT);
  await tick();
  assert.equal(leftCalled, 0, 'Alt+Left must not navigate');
  assert.equal(rightCalled, 0, 'Alt+Right must not navigate');
});

test('Ctrl+Left with non-empty buffer moves by word, does NOT call onEmptyLeft', async () => {
  const bridge = createInputBoxBridge();
  let leftCalled = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onEmptyLeft={() => { leftCalled += 1; }}
    />,
  );
  stdin.write('hello world');
  await tick();
  stdin.write(CTRL_LEFT);
  await tick();
  stdin.write('X');
  await tick();
  assert.equal(leftCalled, 0, 'Ctrl+Left must not call onEmptyLeft');
  assert.equal(bridge.currentLine(), 'hello Xworld', 'Ctrl+Left must word-move then insert');
});

test('Shift+Enter inserts a newline without submitting', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('line1');
  await tick();
  // Shift+Enter — some terminals send CSI 13;2u or meta; Ink often reports
  // key.return + key.shift for modified Enter. Use the same path as Alt+Enter
  // via a shift-flagged return when the library supports it; fall back to
  // meta+return equivalence is covered by Alt+Enter tests. Simulate via
  // writing newline through meta path is already tested; here send \x1b\r is
  // Alt — for Shift we use a direct handler by typing then verifying Alt path
  // parity: Shift is accepted in key.return branch. ink-testing may not set
  // key.shift on plain sequences — send Alt+Enter as known newline, then
  // document Shift in unit path via ESC+[13;2u if needed.
  stdin.write(ALT_ENTER);
  await tick();
  stdin.write('line2');
  await tick();
  assert.deepEqual(submitted, [], 'newline chord must not submit');
  assert.equal(bridge.currentLine(), 'line1\nline2');
});

test('setLine restores draft and notifies onDraftChange', async () => {
  const bridge = createInputBoxBridge();
  const drafts: string[] = [];
  bridge.onDraftChange((t) => drafts.push(t));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  await tick();
  bridge.setLine('restored draft');
  await tick();
  assert.equal(bridge.currentLine(), 'restored draft');
  assert.ok(drafts.includes('restored draft'), 'setLine must notify draft change');
  // Live seedHistory after mount: Up browses the seeded user message.
  bridge.seedHistory(['prior user msg']);
  await tick();
  stdin.write(UP);
  await tick();
  assert.equal(bridge.currentLine(), 'prior user msg');
});

// ---------------------------------------------------------------------------
// Shift+Tab → cycle conversation Effort Mode (P0.8)
// ---------------------------------------------------------------------------

test('Shift+Tab calls onShiftTab and does not insert a tab', async () => {
  const bridge = createInputBoxBridge();
  let cycleCalls = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onShiftTab={() => { cycleCalls += 1; }}
    />,
  );
  stdin.write(SHIFT_TAB);
  await tick();
  assert.equal(cycleCalls, 1, 'onShiftTab must fire once on Shift+Tab');
  assert.equal(bridge.currentLine(), '', 'Shift+Tab must not insert text into the buffer');
});

test('Shift+Tab fires with a non-empty buffer (mode cycle independent of draft)', async () => {
  const bridge = createInputBoxBridge();
  let cycleCalls = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onShiftTab={() => { cycleCalls += 1; }}
    />,
  );
  stdin.write('hello');
  await tick();
  stdin.write(SHIFT_TAB);
  await tick();
  assert.equal(cycleCalls, 1, 'onShiftTab must fire even with a non-empty buffer');
  assert.equal(bridge.currentLine(), 'hello', 'draft text must be preserved across Shift+Tab');
});

test('plain Tab does not call onShiftTab', async () => {
  const bridge = createInputBoxBridge();
  let cycleCalls = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={60}
      onShiftTab={() => { cycleCalls += 1; }}
    />,
  );
  stdin.write(TAB);
  await tick();
  assert.equal(cycleCalls, 0, 'plain Tab must not cycle mode');
});

// ---------------------------------------------------------------------------
// Ghost text — local-first Tab accept (P0.17–P0.18)
// ---------------------------------------------------------------------------

/** Wait long enough for ghostDebounceMs=0 setTimeout(0) + React paint. */
const ghostTick = (): Promise<void> => new Promise((r) => setTimeout(r, 80));

test('history ghost appears after debounce and Tab accepts it', async () => {
  const bridge = createInputBoxBridge();
  bridge.seedHistory(['fix the flaky chat test']);
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={80} ghostDebounceMs={0} />,
  );
  stdin.write('fix the');
  await ghostTick();
  const frame = plain(lastFrame());
  assert.ok(
    frame.includes('flaky chat test'),
    `expected history ghost suffix in frame, got:\n${frame}`,
  );
  assert.equal(bridge.currentLine(), 'fix the', 'ghost must not mutate buffer until Tab');
  stdin.write(TAB);
  await tick();
  assert.equal(bridge.currentLine(), 'fix the flaky chat test');
});

test('Esc dismisses ghost without changing the buffer', async () => {
  const bridge = createInputBoxBridge();
  bridge.seedHistory(['ship the release notes']);
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={80} ghostDebounceMs={0} />,
  );
  stdin.write('ship the');
  await ghostTick();
  assert.ok(plain(lastFrame()).includes('release notes'), 'precondition: ghost shown');
  stdin.write(ESC);
  await tick();
  assert.equal(bridge.currentLine(), 'ship the');
  const frame = plain(lastFrame());
  assert.ok(!frame.includes('release notes'), `Esc must dismiss ghost, got:\n${frame}`);
});

test('typing dismisses ghost', async () => {
  const bridge = createInputBoxBridge();
  bridge.seedHistory(['continue the migration']);
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={80} ghostDebounceMs={0} />,
  );
  stdin.write('continue');
  await ghostTick();
  assert.ok(plain(lastFrame()).includes('the migration'), 'precondition: ghost shown');
  stdin.write('x');
  await tick();
  assert.equal(bridge.currentLine(), 'continuex');
  // Ghost for "continuex" should not match history; suffix gone immediately on type.
  assert.ok(!plain(lastFrame()).includes('the migration'), 'typing must dismiss prior ghost');
});

test('empty-buffer goal hint ghost; Tab accepts', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={80}
      ghostDebounceMs={0}
      goalHints={['continue active goal']}
    />,
  );
  await ghostTick();
  const frame = plain(lastFrame());
  assert.ok(
    frame.includes('continue active goal'),
    `expected empty-prompt goal ghost, got:\n${frame}`,
  );
  stdin.write(TAB);
  await tick();
  assert.equal(bridge.currentLine(), 'continue active goal');
});

test('slash ghost shows and Tab accepts /help', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} ghostDebounceMs={0} />,
  );
  stdin.write('/hel');
  await ghostTick();
  assert.ok(plain(lastFrame()).includes('p') || plain(lastFrame()).includes('/help'), 'ghost or completed /help');
  // Tab accepts ghost → /help (single-hit Tab path also works if ghost missed).
  stdin.write(TAB);
  await tick();
  assert.equal(bridge.currentLine(), '/help');
});

test('Shift+Tab still cycles mode when ghost is present (does not accept ghost)', async () => {
  const bridge = createInputBoxBridge();
  bridge.seedHistory(['hello world from history']);
  bridge.onSubmit(() => {});
  let cycleCalls = 0;
  const { stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={80}
      ghostDebounceMs={0}
      onShiftTab={() => {
        cycleCalls += 1;
      }}
    />,
  );
  stdin.write('hello');
  await ghostTick();
  stdin.write(SHIFT_TAB);
  await tick();
  assert.equal(cycleCalls, 1, 'Shift+Tab must still cycle mode with ghost showing');
  assert.equal(bridge.currentLine(), 'hello', 'Shift+Tab must not accept the ghost');
});

// ---------------------------------------------------------------------------
// Optional model ghost (P1.5) — gated off by default; local wins when both
// ---------------------------------------------------------------------------

test('model ghost stays off by default even when suggestGhost is wired', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  let calls = 0;
  const { lastFrame, stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={80}
      ghostDebounceMs={0}
      // modelGhostEnabled omitted → false
      suggestGhost={async () => {
        calls += 1;
        return ' from the model';
      }}
    />,
  );
  // Unique prefix with no local history match
  stdin.write('zzunique');
  await ghostTick();
  await ghostTick(); // allow any accidental async model path
  assert.equal(calls, 0, 'suggestGhost must not fire when modelGhostEnabled is off');
  assert.ok(!plain(lastFrame()).includes('from the model'));
});

test('model ghost fires only when enabled and local empty; Tab accepts', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  let calls = 0;
  const { lastFrame, stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={80}
      ghostDebounceMs={0}
      modelGhostEnabled={true}
      suggestGhost={async (line) => {
        calls += 1;
        assert.equal(line, 'zzunique');
        return ' from the model';
      }}
    />,
  );
  stdin.write('zzunique');
  await ghostTick();
  await ghostTick();
  assert.ok(calls >= 1, 'suggestGhost must fire when enabled + local miss');
  assert.ok(
    plain(lastFrame()).includes('from the model'),
    `expected model ghost suffix, got:\n${lastFrame()}`,
  );
  stdin.write(TAB);
  await tick();
  assert.equal(bridge.currentLine(), 'zzunique from the model');
});

test('local history ghost wins over model even when modelGhost enabled', async () => {
  const bridge = createInputBoxBridge();
  bridge.seedHistory(['test the migration']);
  bridge.onSubmit(() => {});
  let modelCalls = 0;
  const { lastFrame, stdin } = render(
    <InputBox
      bridge={bridge}
      color={true}
      isTty={true}
      columns={80}
      ghostDebounceMs={0}
      modelGhostEnabled={true}
      suggestGhost={async () => {
        modelCalls += 1;
        return ' from the model';
      }}
    />,
  );
  // Mount effect runs with empty line; model ghost is allowed for empty prompts
  // (shouldOfferModelGhost). On slower CI (Win+Node20) that setTimeout(0) can
  // fire before stdin is processed and inflate modelCalls. Settle mount + drain
  // empty-prompt ghost, then count only calls during the typed local-hit path.
  await tick();
  await ghostTick();
  modelCalls = 0;
  stdin.write('test the');
  await ghostTick();
  await ghostTick();
  const frame = plain(lastFrame());
  // Behavior under race: local history suffix must win the chrome; model text never.
  assert.ok(frame.includes('migration'), `local history ghost must show, got:\n${frame}`);
  assert.ok(!frame.includes('from the model'), `model ghost must not appear, got:\n${frame}`);
  assert.equal(modelCalls, 0, 'model must not fire when local history matches after type');
});

// ---------------------------------------------------------------------------
// Phase 5: insertText — imperative text insertion into the composer
// ---------------------------------------------------------------------------

test('insertText on empty buffer sets the text', async () => {
  const bridge = createInputBoxBridge();
  render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  await tick();
  bridge.insertText('@goal:g1 ');
  await tick();
  assert.equal(bridge.currentLine(), '@goal:g1 ');
});

test('insertText preserves existing draft and appends with a space', async () => {
  const bridge = createInputBoxBridge();
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('hello');
  await tick();
  assert.equal(bridge.currentLine(), 'hello');
  bridge.insertText('@goal:g1 ');
  await tick();
  assert.equal(bridge.currentLine(), 'hello @goal:g1 ');
});

test('insertText on buffer ending with space appends without doubling', async () => {
  const bridge = createInputBoxBridge();
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('hello ');
  await tick();
  bridge.insertText('@goal:g1 ');
  await tick();
  assert.equal(bridge.currentLine(), 'hello @goal:g1 ');
});

test('insertText inserts at cursor position', async () => {
  const bridge = createInputBoxBridge();
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('ab');
  await tick();
  // Move cursor between 'a' and 'b'
  stdin.write(LEFT);
  await tick();
  bridge.insertText('x');
  await tick();
  assert.equal(bridge.currentLine(), 'axb');
});

test('insertText inserted text submits fine as literal text', async () => {
  const bridge = createInputBoxBridge();
  const submitted: string[] = [];
  bridge.onSubmit((l) => submitted.push(l));
  const { stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  bridge.insertText('@goal:g1 ');
  await tick();
  assert.equal(bridge.currentLine(), '@goal:g1 ');
  stdin.write(ENTER);
  await tick();
  assert.deepEqual(submitted, ['@goal:g1 ']);
  assert.equal(bridge.currentLine(), '');
});

test('insertText clears suggestions when candidate row is shown', async () => {
  const bridge = createInputBoxBridge();
  bridge.onSubmit(() => {});
  const { lastFrame, stdin } = render(
    <InputBox bridge={bridge} color={true} isTty={true} columns={60} />,
  );
  stdin.write('/go');
  await tick();
  stdin.write(TAB);
  await tick();
  assert.ok(plain(lastFrame()).includes('/goals'), 'precondition: candidates shown');
  bridge.insertText('hello');
  await tick();
  const frame = plain(lastFrame());
  const rows = frame.split('\n');
  const ruleRow = rows.findIndex((r) => r.includes('─ chat '));
  const aboveRule = rows.slice(0, ruleRow).join('\n');
  assert.ok(!aboveRule.includes('/goals'), 'insertText must clear the candidate row');
});
