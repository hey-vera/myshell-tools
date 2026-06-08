/**
 * scripts/pty-smoke-ink.mjs — END-TO-END Ink RENDER smoke.
 *
 * Mounts the REAL Ink chat app (scripts/pty-ink-inner.mts) under a genuine PTY
 * (util-linux `script`), drives a scripted MULTI-TURN conversation through the
 * real renderTurn path with a FAKE provider, captures the raw PTY bytes, and
 * REPLAYS them through @xterm/headless to reconstruct the exact on-screen pixels a
 * human would see. A naive ANSI strip does NOT work for Ink's cursor-move repaints
 * — only a headless terminal-emulator replay reconstructs the true visible screen
 * (incl. scrollback, which is where the committed <Static> transcript lives).
 *
 * It asserts what the hermetic ink-testing-library tests CANNOT reach:
 *   C1/C2 (live): after all turns, the reconstructed screen+scrollback contains
 *     EVERY turn's answer text AND the inter-turn chrome lines, each EXACTLY ONCE
 *     (no <Static> duplication / scrollback smear — the live proof the append-only
 *     persistent-store fix holds on a real terminal).
 *   PANEL: the live "Waiting on N models" panel status line renders during the
 *     panel turn (≥2 candidates).
 *   GOALS: the bordered GOALS box + an agent tree row render mid-turn.
 *   COMPOSER: the full-width chat rail + blue info chip + ❯ caret is intact (not broken/duplicated) while
 *     streaming — checked against the ATOMIC last-synchronized Ink frame (the true
 *     on-screen repaint), which is independent of terminal height (a tall, non-
 *     scrolled viewport legitimately retains prior-frame chrome rows in the replay
 *     — that is Ink's static/dynamic boundary, not a render bug).
 *   ESC: the turn-interrupt handler actually fired on a bare ESC.
 *
 * SELF-GUARDING: prints SKIP + exit 0 if `script` / tsx / @xterm/headless is
 * unavailable, so it never breaks headless CI. Run: node scripts/pty-smoke-ink.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const INNER = new URL('./pty-ink-inner.mts', import.meta.url).pathname;
const TSX = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
const COLS = 80;
const ROWS = 30;

function hasScript() {
  if (process.platform === 'win32') return false;
  const r = spawnSync('script', ['--version'], { stdio: 'ignore' });
  return r.status === 0 || r.status === 1;
}

function hasXterm() {
  try {
    require.resolve('@xterm/headless');
    return true;
  } catch {
    return false;
  }
}

if (!existsSync(TSX)) {
  console.log('SKIP: tsx not installed (run npm install)');
  process.exit(0);
}
if (!hasXterm()) {
  console.log('SKIP: @xterm/headless not installed (run npm install) — screen reconstruction unavailable');
  process.exit(0);
}
if (!hasScript()) {
  console.log('SKIP: no PTY (`script` unavailable) — live render not verifiable here');
  process.exit(0);
}

const { Terminal } = require('@xterm/headless');

// MYSHELL_INK on (any flag-gated path is live) + a sane width so Ink doesn't wrap
// every line to one column.
// FORCE_COLOR:1 so Ink/chalk emit SGR under the PTY and the REAL full-width composer
// (dim chat rail + blue info chip) renders (the inner mounts color:true). @xterm/headless folds SGR into cell
// attributes, so the reconstructed TEXT is colour-independent.
const env = { ...process.env, MYSHELL_INK: '1', COLUMNS: String(COLS), LINES: String(ROWS), FORCE_COLOR: '1' };
const cmd = `${TSX} ${INNER}`;
const child = spawn('script', ['-qec', cmd, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env });

let raw = '';
const seen = new Set();
const onChunk = (d) => {
  raw += d.toString('utf8');
  for (const m of raw.matchAll(/<<([^>]+)>>/g)) {
    const marker = m[1];
    if (seen.has(marker)) continue;
    seen.add(marker);
    handleMarker(marker);
  }
};
child.stdout.on('data', onChunk);
child.stderr.on('data', onChunk);

const w = (s) => {
  try {
    child.stdin.write(s);
  } catch {
    /* child gone */
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function handleMarker(marker) {
  if (marker === 'ESC_BEFORE') {
    // Feed a bare ESC byte to the InputBox during turn 4. The <InputBox>'s
    // `useInput` routes a standalone Escape to bridge.interrupt(), which runs the
    // installed handler (→ <<ESC_FIRED>>). A short delay lets the turn get
    // streaming and the handler arm.
    setTimeout(() => w('\x1b'), 400);
    // Belt-and-suspenders: a second ESC a beat later in case the first lands in a
    // sub-frame window (the InputBox's readPending/awaitingKey guard is not active
    // here, but raw-mode re-priming under `script` can swallow the very first byte).
    setTimeout(() => w('\x1b'), 1200);
  }
}

const hardStop = setTimeout(() => {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already exited */
  }
}, 45000);

const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c ?? 0));
  child.on('error', () => resolve(1));
});
clearTimeout(hardStop);
await sleep(200);

// ---------------------------------------------------------------------------
// Reconstruct the screen by replaying the raw PTY bytes through @xterm/headless.
// ---------------------------------------------------------------------------

/** Replay `bytes` into a headless terminal and return the FULL visible buffer
 *  (scrollback + viewport) as trimmed lines — exactly what a human scrolling up
 *  would see. The marker lines (<<…>>) are written outside Ink's frame; we keep
 *  them out of the screen lines by filtering, since they are control signals, not
 *  UI. */
function reconstructScreen(bytes, opts = {}) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 5000 });
  return new Promise((resolve) => {
    term.write(bytes, () => {
      const buf = term.buffer.active;
      const lines = [];
      // `viewportOnly` → just the ROWS currently on screen (the active viewport,
      // baseY..baseY+rows), EXCLUDING scrollback. This is what a human sees right
      // now without scrolling — the true frame for "the live input box while
      // streaming". The default reads the FULL buffer (scrollback + viewport),
      // which is what a human scrolling up would see (the transcript proof).
      const start = opts.viewportOnly ? buf.baseY : 0;
      const end = opts.viewportOnly ? buf.baseY + ROWS : buf.length;
      for (let i = start; i < end; i += 1) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true).replace(/\s+$/u, '') : '');
      }
      resolve(lines);
    });
  });
}

/** Snapshot the screen as of the FIRST occurrence of `marker` in the byte stream
 *  (everything up to and including that marker), so a transient mid-turn frame
 *  (the live panel / GOALS box) can be inspected even though it is later cleared. */
async function screenAt(marker, opts = {}) {
  const idx = raw.indexOf(`<<${marker}>>`);
  if (idx === -1) return [];
  return reconstructScreen(raw.slice(0, idx + `<<${marker}>>`.length), opts);
}

const finalScreen = await reconstructScreen(raw);
const panelScreen = await screenAt('PANEL_OPEN');
const goalsScreen = await screenAt('GOALS_OPEN');

/**
 * Extract the LAST complete SYNCHRONIZED Ink frame (`?2026h … ?2026l`) drawn
 * BEFORE `marker`, stripped to its visible drawn lines. This is the ATOMIC repaint
 * Ink committed for that moment — the true "what's on screen right now" frame,
 * independent of how a taller-than-content viewport replays scrollback. The
 * input-box-integrity check runs against THIS (not the accumulated viewport),
 * because the number of stale prior-frame border rows still visible in a
 * non-scrolled viewport is a function of terminal height, not a render bug:
 * Ink only erases its DYNAMIC region and lets committed chrome scroll into
 * permanent history, so on a short (realistic) terminal those rows scroll away,
 * while on a tall one (whole session fits, baseY stays 0) they linger in the
 * replay. The atomic frame is the height-independent source of truth. Returns the
 * trimmed, non-empty drawn lines of that frame (ANSI + erase preamble removed).
 */
function lastInkFrameAt(marker) {
  const i = raw.indexOf(`<<${marker}>>`);
  if (i === -1) return [];
  const pre = raw.slice(0, i);
  const lastH = pre.lastIndexOf('\x1b[?2026h');
  if (lastH === -1) return [];
  const afterH = pre.slice(lastH);
  const lastL = afterH.indexOf('\x1b[?2026l');
  const frame = lastL >= 0 ? afterH.slice(0, lastL) : afterH;
  const body = frame
    .replace(/\x1b\[\?2026[hl]/g, '')
    .replace(/\x1b\[2K/g, '')
    .replace(/\x1b\[\d*[A-Za-z]/g, '') // cursor moves / erases (UP, G, J, …)
    .replace(/\x1b\[[0-9;]*m/g, '') // SGR colour
    .replace(/\r/g, '');
  return body
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''))
    .filter((l) => l !== '');
}

// The marker lines are control signals; drop them + blanks from the screen view.
const isMarker = (l) => /^<<[^>]+>>$/.test(l.trim());
const visible = (lines) => lines.filter((l) => l.trim() !== '' && !isMarker(l));

const finalLines = visible(finalScreen);
const screenText = finalLines.join('\n');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Count NON-OVERLAPPING occurrences of a literal substring across the screen text.
const countOccurrences = (hay, needle) => {
  if (needle === '') return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    n += 1;
    from = idx + needle.length;
  }
  return n;
};

const sawReady = /<<READY>>/.test(raw);
const sawAllDone = /<<ALL_DONE>>/.test(raw);
const sawEscFired = /<<ESC_FIRED>>/.test(raw);

// --- C1/C2 (live): every turn's answer + inter-turn chrome present EXACTLY ONCE.
// These unique tokens are seeded into the fake answers/chrome so a duplicated
// <Static> append (the scrollback-dup bug) would show a count > 1.
const UNIQUE_ONCE = [
  'ALPHA-UNIQUE',   // turn 1 answer
  'RECAP-ONE',      // inter-turn chrome after turn 1
  'BETA-UNIQUE',    // turn 2 (panel) synthesized answer
  'RECAP-TWO',      // inter-turn chrome after turn 2
  'GAMMA-UNIQUE',   // turn 3 answer
  'RECAP-THREE',    // inter-turn chrome after turn 3
];
let allOnce = true;
const counts = {};
for (const tok of UNIQUE_ONCE) {
  const c = countOccurrences(screenText, tok);
  counts[tok] = c;
  if (c !== 1) allOnce = false;
}
record(
  'C1/C2 multi-turn transcript present, NO duplication (each unique line ×1)',
  allOnce && sawAllDone,
  JSON.stringify(counts),
);

// All three turns' answers must be present at all (subset of the above, called out
// separately so a partial transcript is distinguishable from a dup).
const allThreeAnswers =
  counts['ALPHA-UNIQUE'] >= 1 && counts['BETA-UNIQUE'] >= 1 && counts['GAMMA-UNIQUE'] >= 1;
record('all THREE turns’ answer text reached the transcript', allThreeAnswers);

// --- PANEL: live "Waiting on N models" panel status line during the panel turn.
const panelText = visible(panelScreen).join('\n');
const sawPanelLine = /Waiting on \d+ models?/.test(panelText) || /Synthesizing \d+ answers?/.test(panelText);
record('PANEL: live panel status line rendered (Waiting on N models)', sawPanelLine,
  sawPanelLine ? '' : firstStatusish(panelText));

// --- GOALS: the bordered GOALS box + an agent tree row mid-turn.
const goalsText = visible(goalsScreen).join('\n');
const sawGoalsTitle = /GOALS/.test(goalsText);
const sawGoalsBorder = /[╭╮╰╯─]/.test(goalsText) && /[│]/.test(goalsText);
const sawAgentRow = /[├└]─\s+claude\/claude-opus/.test(goalsText) || /[├└]─\s+claude\//.test(goalsText);
record('GOALS: bordered GOALS panel box rendered', sawGoalsTitle && sawGoalsBorder);
record('GOALS: at least one agent tree row rendered', sawAgentRow,
  sawAgentRow ? '' : firstMatch(goalsText, /[├└]/));

// --- COMPOSER integrity while streaming: the full-width composer is ONE
// contiguous, intact surface pinned at the bottom of the ATOMIC live Ink frame
// (not broken, split, or duplicated). The composer is three drawn rows:
//   top   — `─ chat ───…───┌ Mode … · /goal · /help · /back ┐`  (dim rail + blue chip)
//   caret — `❯ <input or placeholder>`                          (cyan caret, no rail)
//   bottom— `───…───└────────┘`                                 (dim rule + blue chip base)
// We inspect the LAST synchronized Ink frame at the GOALS-open moment (the exact
// atomic repaint Ink committed) rather than the replayed viewport, because how many
// stale prior-frame rows linger in a non-scrolled viewport is purely a function of
// terminal height (Ink erases only its dynamic region; committed chrome scrolls into
// history — on a short terminal it scrolls away, on a tall one it lingers in the
// replay), NOT a render bug. The atomic frame is the height-independent truth. In it
// the composer must be the LAST three drawn rows AND the chip top + caret must each
// appear EXACTLY ONCE (Ink repaints the pinned composer in place, never duplicating).
const liveFrame = lastInkFrameAt('GOALS_OPEN');
const fTail = liveFrame.slice(-3);
const tailTop = /^─ chat ─+┌ .* ┐$/.test(fTail[0] ?? '');
const tailCaret = /^❯ /.test(fTail[1] ?? '');
const tailBottom = /^─+└─+┘$/.test(fTail[2] ?? '');
const frameText = liveFrame.join('\n');
const frameTopBorders = (frameText.match(/─ chat ─+┌ [^┐]* ┐/g) || []).length;
const frameCarets = (frameText.match(/❯/g) || []).length;
record(
  'COMPOSER: full-width chat rail + blue info chip + ❯ caret intact + pinned while streaming (single contiguous surface)',
  tailTop && tailCaret && tailBottom && frameTopBorders === 1 && frameCarets === 1,
  `top=${tailTop} caret=${tailCaret} bottom=${tailBottom} uniqueTop=${frameTopBorders} uniqueCaret=${frameCarets}`,
);

// --- ESC interrupt actually fired.
record('ESC: turn-interrupt handler fired on a bare ESC', sawEscFired);
// And the canceled turn surfaced its outcome line in the transcript.
record('ESC: interrupted turn committed "■ Cancelled"', /■ Cancelled/.test(screenText));

record('Ink app mounted (READY) + clean exit', sawReady && code === 0, `exit=${code}`);

// ---------------------------------------------------------------------------
// Reconstructed screen capture (for the human reviewer)
// ---------------------------------------------------------------------------
function firstStatusish(text) {
  const m = text.split('\n').filter((l) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐]|Waiting|Thinking|Synth/.test(l));
  return m.length ? JSON.stringify(m.slice(-2)) : '(no status line found)';
}
function firstMatch(text, re) {
  const m = text.split('\n').filter((l) => re.test(l));
  return m.length ? JSON.stringify(m.slice(0, 3)) : '(none)';
}

console.log('\n--- RECONSTRUCTED FINAL SCREEN (scrollback + viewport) ---');
console.log(finalLines.join('\n'));
console.log('--- end final screen ---\n');

console.log('--- LIVE PANEL FRAME (snapshot at <<PANEL_OPEN>>) ---');
console.log(visible(panelScreen).join('\n'));
console.log('--- end panel frame ---\n');

console.log('--- LIVE GOALS FRAME (snapshot at <<GOALS_OPEN>>) ---');
console.log(visible(goalsScreen).join('\n'));
console.log('--- end goals frame ---\n');

const passed = results.filter((r) => r.pass).length;
const total = results.length;
console.log(`Ink render smoke: ${passed}/${total} assertions passed`);

if (passed === total) {
  console.log('PTY INK RENDER SMOKE: PASS');
  process.exit(0);
}
console.log('PTY INK RENDER SMOKE: FAIL');
if (!sawReady) {
  console.log('--- captured output (ANSI-stripped, truncated) ---');
  console.log(raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').slice(0, 3000));
}
process.exit(1);
