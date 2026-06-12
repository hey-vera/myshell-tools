/**
 * scripts/pty-smoke-menu-ink.mjs — early-keypress PTY smoke for the built Ink CLI.
 *
 * Proves startup type-ahead on the real compiled binary:
 *   1. spawn the built CLI under a real PTY,
 *   2. send EXACTLY ONE menu key IMMEDIATELY (before any banner/menu output),
 *   3. assert that key is NOT echoed as a standalone cooked-mode line,
 *   4. assert the buffered key opens the composer with NO second menu byte,
 *   5. `/exit` back to the menu, then one `q` exits cleanly.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const COLS = 80;
const ROWS = 24;
const EARLY_KEY = 'n';
const MENU_MARKER = '[n] New';
const QUIT_MARKER = '[q] Quit';

function hasScript() {
  if (process.platform === 'win32') return false;
  const result = spawnSync('script', ['--version'], { stdio: 'ignore' });
  return result.status === 0 || result.status === 1;
}

function hasXterm() {
  try {
    require.resolve('@xterm/headless');
    return true;
  } catch {
    return false;
  }
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r/g, '');
}

function normalizeScreenText(lines) {
  return lines
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');
}

function summarize(text) {
  return text.split('\n').slice(-30).join('\n');
}

function hasComposer(text) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const tail = lines.slice(-8);
  return tail.some((line) => /^❯(?: |$)/u.test(line));
}

function latestNonEmptyLine(text) {
  const lines = text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? '';
}

function hasStandaloneEcho(raw, key) {
  const clean = stripAnsi(raw);
  return clean.split('\n').some((line) => line.trim() === key);
}

async function reconstructScreen(bytes, Terminal) {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 6000 });
  return new Promise((resolve) => {
    term.write(bytes, () => {
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i += 1) {
        const line = buf.getLine(i);
        lines.push(line ? line.translateToString(true) : '');
      }
      resolve(normalizeScreenText(lines));
    });
  });
}

async function waitFor(label, timeoutMs, getText, predicate) {
  const start = Date.now();
  let last = '';
  for (;;) {
    last = await getText();
    if (predicate(last)) return last;
    if (Date.now() - start >= timeoutMs) {
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.screen = last;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

if (!existsSync(CLI)) {
  console.log('SKIP: dist/cli.js not built (run npx tsc)');
  process.exit(0);
}
if (!hasXterm()) {
  console.log('SKIP: @xterm/headless not installed (run npm install) — screen reconstruction unavailable');
  process.exit(0);
}
if (!hasScript()) {
  console.log('SKIP: no PTY (`script` unavailable) — early-keypress Ink menu not verifiable here');
  process.exit(0);
}

const { Terminal } = require('@xterm/headless');
const env = {
  ...process.env,
  MYSHELL_INK: '1',
  MYSHELL_NO_UPDATE: '1',
  COLUMNS: String(COLS),
  LINES: String(ROWS),
  FORCE_COLOR: '1',
};
const child = spawn('script', ['-qec', `node ${CLI}`, '/dev/null'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
});

let raw = '';
child.stdout.on('data', (chunk) => {
  raw += chunk.toString('utf8');
});
child.stderr.on('data', (chunk) => {
  raw += chunk.toString('utf8');
});

const write = (text) => {
  try {
    child.stdin.write(text);
  } catch {
    /* child already exited */
  }
};
const getScreen = async () => reconstructScreen(raw, Terminal);

let hardStop;
try {
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code: code ?? 0, signal: signal ?? null }));
    child.on('error', (error) => resolve({ code: 1, signal: 'error', error }));
  });
  hardStop = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }, 45000);

  write(EARLY_KEY);

  const composerScreen = await waitFor(
    'composer after one early menu key',
    15000,
    getScreen,
    (text) => hasComposer(text),
  );
  if (hasStandaloneEcho(raw, EARLY_KEY)) {
    const err = new Error(`saw standalone echoed "${EARLY_KEY}" before Ink mounted`);
    err.screen = composerScreen;
    throw err;
  }

  write('/exit\r');
  await waitFor(
    'menu after /exit',
    8000,
    getScreen,
    (text) => text.includes(MENU_MARKER) && text.includes(QUIT_MARKER) && latestNonEmptyLine(text) === '>',
  );
  await new Promise((resolve) => setTimeout(resolve, 200));

  write('q');
  const exit = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timeout' }), 8000)),
  ]);
  if (exit.code !== 0 || exit.signal !== null) {
    const err = new Error(`expected clean exit after one q, got code=${String(exit.code)} signal=${String(exit.signal)}`);
    err.screen = await getScreen();
    throw err;
  }

  clearTimeout(hardStop);
  console.log('PTY EARLY-KEYPRESS MENU-INK: PASS');
} catch (error) {
  if (hardStop) clearTimeout(hardStop);
  console.error('PTY EARLY-KEYPRESS MENU-INK: FAIL');
  console.error(`Expected one early "${EARLY_KEY}" to open the composer without an echoed standalone line.`);
  console.error('Observed screen:');
  console.error(summarize((error && error.screen) || (await getScreen().catch(() => ''))));
  console.error(`Reason: ${error instanceof Error ? error.message : String(error)}`);
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  process.exit(1);
}
