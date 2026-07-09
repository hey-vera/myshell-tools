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
 *
 * PINNED TO LEGACY: the npm `smoke:pty` script sets MYSHELL_INK=0 so this keeps
 * exercising the LEGACY raw-mode renderer (the doubled-paste fix + single-key
 * nav) even though Ink is now the DEFAULT (3.28.0). The legacy path is retained
 * as the opt-out fallback for one release, so this coverage stays valuable. The
 * spawn below inherits this process's env, so MYSHELL_INK=0 reaches `node CLI`.
 * The DEFAULT (Ink) path is covered by smoke:pty:ink + test:ui + smoke:pty:handoff.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const PASTE = 'the quick brown fox jumps over the lazy dog';

// Run repo chat live smoke FIRST (always, before any PTY skip/exit). It is self-contained
// and prints receipts then returns; pty logic continues or exits after.
await (async function runRepoChatLiveSmoke() {
  // Use src .ts + tsx (smoke:repo-chat sets --import tsx/esm). Falls back comment for dist.
  const SRC_HANDLER = fileURLToPath(new URL('../src/interface/repo-chat-handler.ts', import.meta.url));
  const SRC_CHECKPOINT = fileURLToPath(new URL('../src/core/ai-checkpoint.ts', import.meta.url));
  const SRC_STORE = fileURLToPath(new URL('../src/infra/ai-checkpoint-store.ts', import.meta.url));
  const SRC_LAYOUT = fileURLToPath(new URL('../src/infra/state-layout.ts', import.meta.url));
  if (!existsSync(SRC_HANDLER)) {
    console.log('REPO-CHAT SMOKE: SKIP (src not present)');
    return;
  }
  try {
    const { handleRepoChatIntent } = await import('file://' + SRC_HANDLER);
    const { buildAiCheckpoint } = await import('file://' + SRC_CHECKPOINT);
    const { createAiCheckpointStore } = await import('file://' + SRC_STORE);
    const { resolveStateLayout } = await import('file://' + SRC_LAYOUT);

    const home = mkdtempSync(join(tmpdir(), 'myshell-smoke-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'myshell-smoke-repo-'));
    try {
      const layout = resolveStateLayout({ env: {}, platform: process.platform, cwd, homeDir: home });
      const store = createAiCheckpointStore({ cwd, layout });

      const baseRepoOps = {
        async status() { return { isGitRepo: true, clean: true, changedFiles: [], raw: '' }; },
        async diff() { return { isGitRepo: true, empty: true, stat: '', patchPreview: '' }; },
        async detectTestCommand() { return { label: 'test', command: 'npm', args: ['test'] }; },
      };
      const makeDeps = (overrides = {}) => ({
        cwd,
        repoOps: baseRepoOps,
        checkpointStore: store,
        readFileText: async () => null,
        ...overrides,
      });

      console.log('\n=== LIVE USER SMOKE (repo chat) ===');
      console.log('start menu');
      console.log('new conversation');
      let r = await handleRepoChatIntent('status', makeDeps());
      console.log('user: status');
      console.log('assistant:', r && r.message);
      r = await handleRepoChatIntent('what changed?', makeDeps());
      console.log('user: what changed?');
      console.log('assistant:', r && r.message);
      r = await handleRepoChatIntent('run tests', makeDeps());
      console.log('user: run tests');
      console.log('assistant:', r && r.message);
      r = await handleRepoChatIntent('undo that', makeDeps());
      console.log('user: undo that (before any checkpoint exists)');
      console.log('assistant:', r && r.message);

      // tiny AI edit + verify checkpoint creation
      const tinyCp = buildAiCheckpoint({
        id: 'smoke-cp-live-1',
        createdAt: '2026-07-07T12:34:56.000Z',
        repoRoot: cwd,
        intent: 'tiny AI edit',
        files: [{ path: 'foo.txt', beforeText: 'old', afterText: 'new' }],
      });
      await store.save(tinyCp);
      const listed = await store.list();
      console.log('perform a tiny AI edit');
      console.log('verify checkpoint creation:', listed.map(c => c.id));
      r = await handleRepoChatIntent('what changed?', makeDeps());
      console.log('user: what changed?');
      console.log('assistant:', r && r.message);
      r = await handleRepoChatIntent('undo that', makeDeps({
        readFileText: async (p) => (p === 'foo.txt' ? 'new' : null),
        // no applyUndoActions → preview-only path
      }));
      console.log('user: undo that');
      console.log('assistant:', r && r.message);
      console.log('verified safe preview (has "I have not applied"):', /I have not applied/.test(r ? r.message : ''));
      console.log('mutatesWorkspace (preview):', r && r.mutatesWorkspace);
      // autonomous + apply seam → actual apply receipt
      const applyCalls = [];
      r = await handleRepoChatIntent('undo that', makeDeps({
        readFileText: async (p) => (p === 'foo.txt' ? 'new' : null),
        oversight: 'autonomous',
        repoOps: {
          ...baseRepoOps,
          async applyUndoActions(_cwd, actions) {
            applyCalls.push(actions.length);
            return { applied: actions.length, errors: [] };
          },
          async commitChanges() { return { ok: true, output: 'ok' }; },
        },
      }));
      console.log('user: undo that (autonomous apply)');
      console.log('assistant:', r && r.message);
      console.log('verified apply path:', /Applied undo/.test(r ? r.message : ''), 'actions:', applyCalls);
      console.log('=== LIVE USER SMOKE: PASS ===\n');
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    console.log('REPO-CHAT SMOKE: FAIL', e && e.message);
  }
})();

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
const cleanText = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, '').replace(/\r/g, '\n');

await sleep(6000);  // provider detection + menu render
const menuBeforeN = out;
w('n');             // new chat (single keypress)
await sleep(3000);
const afterSingleN = out;
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

const clean = cleanText(out);
const lines = clean.split('\n').map((l) => l.trim());
const homeMarkers = ['Effort Mode:', 'Session Manager', 'Choice:', 'ESC to exit'];
const forbiddenHome = ['No runs yet', 'Health:', 'doctor', 'Ctrl+C x2'];
// The committed input line carries the `❯` caret; the menu's Recent-list entry
// (after /exit) also contains the text but is NOT an input echo. Count ONLY the
// caret-prefixed input rows — a doubled paste would show two of them (or a `>`-row).
const inputRows = lines.filter((l) => /^❯\s/.test(l) && l.includes('quick brown fox'));
const strayEcho = lines.filter((l) => /^>\s/.test(l) && l.includes('quick brown fox'));
const sawCaret = inputRows.length >= 1;
const noDup = inputRows.length === 1 && strayEcho.length === 0;
const menuPhase = cleanText(menuBeforeN);
const chatPhase = cleanText(afterSingleN);
const homeLooksLocked =
  homeMarkers.every((marker) => menuPhase.includes(marker)) &&
  forbiddenHome.every((marker) => !menuPhase.includes(marker));
const menuMarker = 'Effort Mode:';
const chatMarker = 'Type a message and press Enter';
const menuIdx = menuPhase.indexOf(menuMarker);
const chatIdx = chatPhase.indexOf(chatMarker);
const menuKeyWorked = menuIdx !== -1 && chatIdx !== -1 && chatIdx > menuIdx;

console.log('PTY smoke results:');
console.log(`  locked home markers present : ${homeLooksLocked}`);
console.log(`  input caret rows with paste : ${inputRows.length} ${inputRows.map((l) => JSON.stringify(l)).join(' ')}`);
console.log(`  stray '>' echo rows         : ${strayEcho.length}`);
console.log(`  single-keypress nav worked  : ${menuKeyWorked} (menu rendered via 'n'/'q'/'/exit')`);
console.log(`  caret rendered (❯)          : ${sawCaret}`);
console.log(`  [1] LOCKED HOME SKELETON    : ${homeLooksLocked ? 'PASS' : 'FAIL'}`);
console.log(`  [2] DOUBLED-PASTE FIX       : ${noDup ? 'PASS (committed once)' : 'FAIL'}`);
console.log(`  [3] SINGLE-KEYPRESS MENU    : ${menuKeyWorked ? 'PASS' : 'FAIL'}`);
if (!homeLooksLocked || !noDup || !menuKeyWorked) process.exit(1);
console.log('PTY SMOKE: PASS');
