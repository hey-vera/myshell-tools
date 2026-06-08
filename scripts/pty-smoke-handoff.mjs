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
 * WEDGE-AWARE RETRY: under `script`, an inherited-stdio child briefly owns the
 * terminal's foreground process group; the orchestrator's next TTY write can race
 * the kernel's SIGTTOU job-control stop and WEDGE the run (no RESUMED ever appears).
 * This is a documented TEST-HARNESS artifact of PTY job control, NOT a product bug
 * (the production menu never spawns a child mid-write like this) — see the inner
 * harness header. So a wedged attempt (SUSPENDED seen, RESUMED never seen within
 * the window) is RETRIED. Crucially, any attempt that RUNS TO COMPLETION (resumes)
 * is asserted HARD: wrong CHILD_GOT or a missing INK_GOT after a clean resume is a
 * genuine regression and FAILS without retry. Retries are logged (no silent masking).
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

// How many times to re-run a wedged attempt before giving up. The wedge is a PTY
// job-control race whose rate climbs under system load (e.g. when this runs right
// after the other PTY smokes in the gate). 8 attempts keeps a spurious all-wedge
// run astronomically unlikely even under load, while the short wedge window below
// keeps the worst-case wall time bounded (~8 × ~6s).
const MAX_ATTEMPTS = 8;
// After SUSPENDED, RESUMED must appear within this window or we call it a wedge
// (the orchestrator was SIGTTOU-stopped) and retry. The inner resumes well within
// this: child watchdog is 4s, resume fires immediately after. Kept tight so a
// wedged attempt is abandoned fast and the retry is cheap.
const WEDGE_MS = 6000;
// Absolute per-attempt ceiling — a belt-and-suspenders kill if even the wedge
// detector somehow doesn't fire.
const HARD_MS = 22000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run ONE handoff attempt under a fresh PTY. Resolves with the captured output and
 * the parsed phase flags. `reason` records why the attempt ended: 'done' (ALL_DONE
 * seen), 'wedged' (SUSPENDED seen but RESUMED never within WEDGE_MS), 'exit' (child
 * exited), 'timeout' (hard ceiling). Never rejects.
 */
function runAttempt() {
  return new Promise((resolve) => {
    // MYSHELL_INK so any flag-gated code in the inner path is live; pass a sane width.
    const env = { ...process.env, MYSHELL_INK: '1', COLUMNS: '80', LINES: '24', FORCE_COLOR: '0' };
    const cmd = `${TSX} ${INNER}`;
    const child = spawn('script', ['-qec', cmd, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let out = '';
    const seen = new Set();
    let settled = false;
    let wedgeTimer = null;

    const w = (s) => {
      try {
        child.stdin.write(s);
      } catch {
        /* child gone */
      }
    };

    const settle = (reason) => {
      if (settled) return;
      settled = true;
      if (wedgeTimer) clearTimeout(wedgeTimer);
      clearTimeout(hardStop);
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
      resolve({
        reason,
        out,
        sawReady: /<<READY>>/.test(out),
        childGot: new RegExp(`CHILD_GOT=${CHILD_LINE}`).test(out),
        inkGot: new RegExp(`INK_GOT=${INK_LINE}`).test(out),
        sawResumed: /<<RESUMED>>/.test(out),
      });
    };

    const handleMarker = (marker) => {
      if (marker === 'SUSPENDED') {
        // The child is (about to be) the sole TTY reader; feed it the line it reads.
        // Small delay so the spawned bash has issued its `read`.
        setTimeout(() => w(`${CHILD_LINE}\n`), 300);
        // Arm the wedge watchdog: if RESUMED never lands, the orchestrator was
        // SIGTTOU-stopped — abandon this attempt and let the loop retry.
        wedgeTimer = setTimeout(() => {
          if (!seen.has('RESUMED')) settle('wedged');
        }, WEDGE_MS);
      } else if (marker === 'RESUMED') {
        // Ink input is live again — feed the FIRST line, then Enter as a SEPARATE
        // keystroke (a human types, then presses Return; Ink treats a single
        // text+\r chunk as one pasted blob). It must land on the 1st try.
        setTimeout(() => w(INK_LINE), 300);
        setTimeout(() => w('\r'), 700);
      }
    };

    const onChunk = (d) => {
      out += d.toString('utf8');
      for (const m of out.matchAll(/<<([^>]+)>>/g)) {
        const marker = m[1];
        if (seen.has(marker)) continue;
        seen.add(marker);
        handleMarker(marker);
      }
      if (seen.has('ALL_DONE')) settle('done');
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    const hardStop = setTimeout(() => settle('timeout'), HARD_MS);
    child.on('exit', () => settle('exit'));
    child.on('error', () => settle('error'));
  });
}

let result;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  result = await runAttempt();
  // An attempt that RESUMED ran the seam to completion — assert on it (pass OR a
  // real behavioral fail). Only a true wedge (never resumed) is retried.
  if (result.sawResumed) break;
  if (attempt < MAX_ATTEMPTS) {
    console.log(`  attempt ${attempt}: PTY job-control wedge (SUSPENDED seen, no RESUMED) — retrying…`);
    await sleep(500);
  }
}
await sleep(150);

// --- Assertions ------------------------------------------------------------
const { out, sawReady, childGot, inkGot, sawResumed } = result;

console.log('PTY handoff smoke results:');
console.log(`  mounted Ink (READY)                : ${sawReady}`);
console.log(`  [1] CHILD HANDOFF (suspended)      : ${childGot ? 'PASS' : 'FAIL'} (expected CHILD_GOT=${CHILD_LINE})`);
console.log(`  resumed (RESUMED)                  : ${sawResumed}`);
console.log(`  [2] FIRST-LINE-AFTER-RESUME        : ${inkGot ? 'PASS' : 'FAIL'} (expected INK_GOT=${INK_LINE})`);

if (childGot && inkGot) {
  console.log('PTY HANDOFF SMOKE: PASS');
  process.exit(0);
}

if (!sawResumed) {
  console.log(`PTY HANDOFF SMOKE: FAIL (job-control wedge persisted across ${MAX_ATTEMPTS} attempts — never resumed)`);
} else {
  console.log('PTY HANDOFF SMOKE: FAIL (resumed but the handoff assertions did not hold — a real regression)');
}
console.log('--- captured output (ANSI-stripped, truncated) ---');
console.log(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n').slice(0, 3000));
process.exit(1);
