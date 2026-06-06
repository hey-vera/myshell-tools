/**
 * scripts/pty-smoke.mjs — real-PTY smoke test for the interactive TUI.
 *
 * Verifies raw-mode behavior that unit tests can't reach, under a genuine
 * pseudo-terminal via util-linux `script`. SELF-GUARDING: if `script` (or a PTY)
 * is unavailable it prints SKIP and exits 0, so it never breaks headless CI. Run
 * manually:  node scripts/pty-smoke.mjs   (requires a built dist/ + /usr/bin/script)
 *
 * Primary check: a pasted multi-word line is committed EXACTLY ONCE (the readline
 * `prompt:''` fix, CHANGELOG 3.18.1) — never duplicated on a second prompt row.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const PASTE = 'the quick brown fox jumps over the lazy dog';

function hasScript() {
  if (process.platform === 'win32') return false;
  const r = spawnSync('script', ['--version'], { stdio: 'ignore' });
  return r.status === 0 || r.status === 1; // present (some builds exit 1 on --version)
}

if (!existsSync(CLI)) { console.log('SKIP: dist/cli.js not built (run npm run build)'); process.exit(0); }
if (!hasScript()) { console.log('SKIP: no PTY (`script` unavailable) — interactive feel not verifiable here'); process.exit(0); }

const child = spawn('script', ['-qec', `node ${CLI}`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d.toString('utf8'); });
child.stderr.on('data', (d) => { out += d.toString('utf8'); });
const w = (s) => { try { child.stdin.write(s); } catch { /* child gone */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(6000);  // provider detection + menu render
w('n');             // new chat (single keypress)
await sleep(3000);
w(PASTE);           // paste as one chunk
await sleep(600);
w('\r');            // submit
await sleep(2500);  // committed echo renders
w('\x1b');          // ESC
await sleep(800);
w('/exit\r');       // back to menu
await sleep(1500);
w('q');             // quit
await sleep(1500);
try { child.kill('SIGTERM'); } catch { /* already exited */ }
await sleep(400);

const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, '').replace(/\r/g, '\n');
const lines = clean.split('\n').map((l) => l.trim());
// The committed input line carries the `❯` caret; the menu's Recent-list entry
// (after /exit) also contains the text but is NOT an input echo. Count ONLY the
// caret-prefixed input rows — a doubled paste would show two of them (or a `>`-row).
const inputRows = lines.filter((l) => /^❯\s/.test(l) && l.includes('quick brown fox'));
const strayEcho = lines.filter((l) => /^>\s/.test(l) && l.includes('quick brown fox'));
const sawCaret = inputRows.length >= 1;
const noDup = inputRows.length === 1 && strayEcho.length === 0;
const menuKeyWorked = /myshell-tools v/.test(clean) && /Type a message and press Enter/.test(clean);

console.log(`PTY smoke results:`);
console.log(`  input caret rows with paste : ${inputRows.length} ${inputRows.map((l)=>JSON.stringify(l)).join(' ')}`);
console.log(`  stray '>' echo rows         : ${strayEcho.length}`);
console.log(`  single-keypress nav worked  : ${menuKeyWorked} (menu rendered via 'n'/'q'/'/exit')`);
console.log(`  caret rendered (❯)          : ${sawCaret}`);
console.log(`  [1] DOUBLED-PASTE FIX       : ${noDup ? 'PASS (committed once)' : 'FAIL'}`);
console.log(`  [2] SINGLE-KEYPRESS MENU    : ${menuKeyWorked ? 'PASS' : 'FAIL'}`);
if (!noDup || !menuKeyWorked) process.exit(1);
console.log('PTY SMOKE: PASS');
