/**
 * scripts/pty-smoke-handoff.mjs — real-PTY proof of the Ink suspend/resume
 * inherited-stdio child handoff (Step 2b of the Ink migration).
 *
 * This is the HIGHEST-RISK seam in the migration: it is the path that historically
 * produced the "first paste into `claude auth login` fails, second works" bug.
 * Component tests (ink-testing-library) can't reach raw-mode / fd0 ownership, so
 * we drive the REAL Ink app under a genuine PTY (util-linux `script`) and assert:
 *
 *   [1] CHILD HANDOFF  — while `reader.suspend()` is in effect, an inherited-stdio
 *       child (`bash -c 'read x; echo CHILD_GOT=$x'`) reads a line off the TTY.
 *       Ink, if it hadn't released raw mode + the stream, would have stolen those
 *       bytes; the child echoing CHILD_GOT=<line> proves the handoff.
 *   [2] FIRST-LINE-AFTER-RESUME — after `reader.resume()`, the FIRST line fed into
 *       the Ink input is received (INK_GOT=<line>). This is the direct regression
 *       guard for the first-paste bug: it must work on the FIRST try, not the 2nd.
 *
 * SELF-GUARDING: prints SKIP + exit 0 if `script` / a PTY is unavailable, so it
 * never breaks headless CI. Run:  node scripts/pty-smoke-handoff.mjs
 * (requires tsx — the inner runner is TypeScript executed via the repo's tsx.)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const INNER = new URL('./pty-handoff-inner.mts', import.meta.url).pathname;
const TSX = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;
const CHILD_LINE = 'handed-off-code-42';
const INK_LINE = 'first-after-resume-99';

function hasScript() {
  if (process.platform === 'win32') return false;
  const r = spawnSync('script', ['--version'], { stdio: 'ignore' });
  return r.status === 0 || r.status === 1;
}

if (!existsSync(TSX)) {
  console.log('SKIP: tsx not installed (run npm install)');
  process.exit(0);
}
if (!hasScript()) {
  console.log('SKIP: no PTY (`script` unavailable) — handoff not verifiable here');
  process.exit(0);
}

// MYSHELL_INK so any flag-gated code in the inner path is live; pass a sane width.
const env = { ...process.env, MYSHELL_INK: '1', COLUMNS: '80', LINES: '24', FORCE_COLOR: '0' };
const cmd = `${TSX} ${INNER}`;
const child = spawn('script', ['-qec', cmd, '/dev/null'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
});

let out = '';
const seen = new Set();
const onChunk = (d) => {
  out += d.toString('utf8');
  // React to phase markers as they arrive (more robust than fixed offsets).
  for (const m of out.matchAll(/<<([^>]+)>>/g)) {
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
  if (marker === 'SUSPENDED') {
    // The child is (about to be) the sole TTY reader; feed it the line it reads.
    // Small delay so the spawned bash has issued its `read`.
    setTimeout(() => w(`${CHILD_LINE}\n`), 300);
  } else if (marker === 'RESUMED') {
    // Ink input is live again — feed the FIRST line, then Enter as a SEPARATE
    // keystroke (a human types, then presses Return; Ink treats a single
    // text+\r chunk as one pasted blob). It must land on the 1st try.
    setTimeout(() => w(INK_LINE), 300);
    setTimeout(() => w('\r'), 700);
  }
}

const hardStop = setTimeout(() => {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already exited */
  }
}, 25000);

const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c ?? 0));
  child.on('error', () => resolve(1));
});
clearTimeout(hardStop);
await sleep(200);

// --- Assertions ------------------------------------------------------------
const childGot = new RegExp(`CHILD_GOT=${CHILD_LINE}`).test(out);
const inkGot = new RegExp(`INK_GOT=${INK_LINE}`).test(out);
const sawReady = /<<READY>>/.test(out);
const sawResumed = /<<RESUMED>>/.test(out);

console.log('PTY handoff smoke results:');
console.log(`  mounted Ink (READY)                : ${sawReady}`);
console.log(`  [1] CHILD HANDOFF (suspended)      : ${childGot ? 'PASS' : 'FAIL'} (expected CHILD_GOT=${CHILD_LINE})`);
console.log(`  resumed (RESUMED)                  : ${sawResumed}`);
console.log(`  [2] FIRST-LINE-AFTER-RESUME        : ${inkGot ? 'PASS' : 'FAIL'} (expected INK_GOT=${INK_LINE})`);

if (!sawReady) {
  console.log('--- captured output (truncated) ---');
  console.log(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 2000));
}

if (childGot && inkGot) {
  console.log('PTY HANDOFF SMOKE: PASS');
  process.exit(0);
}
console.log('PTY HANDOFF SMOKE: FAIL');
console.log('--- captured output (ANSI-stripped, truncated) ---');
console.log(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').slice(0, 3000));
process.exit(1);
