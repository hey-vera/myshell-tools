/**
 * test/integration/menu-cli.test.ts — REAL end-to-end test of the menu's input
 * layer against the actual built CLI.
 *
 * Unlike test/unit/menu-flow.test.ts (which injects a fake `readLine` and so
 * bypasses `node:readline` entirely), this test spawns the genuine compiled
 * entry point — `node dist/cli.js` — with PIPED, non-TTY stdin. That is the
 * exact condition under which the original P0 manifested:
 *
 *   - empty stdin threw `ERR_USE_AFTER_CLOSE` (exit 1) instead of exiting 0;
 *   - a buffered key (e.g. "x") was lost because the per-prompt rl.question()
 *     reader missed lines that readline eagerly drained during the ~1–2s
 *     provider-detection at startup.
 *
 * These assertions can only pass when the menu uses the event-driven on('line')
 * queue over a single readline interface — so this is the test that proves the
 * fix.
 *
 * Quota-free: only navigation/quit keys are sent. No key path here invokes a
 * real model/provider.
 *
 * Honesty Contract: no fabricated data, no digit-% literals, no Math.random.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

/** Generous per-spawn timeout so a hung child can never wedge CI. */
const SPAWN_TIMEOUT_MS = 30_000;

interface SpawnResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Spawn the real built CLI with the given stdin and collect its output.
 *
 * Writes `input` to stdin then ends it (EOF). Resolves once the process exits,
 * or kills it and resolves with `timedOut: true` after SPAWN_TIMEOUT_MS so the
 * test can fail loudly instead of hanging.
 */
function runCli(input: string): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH], {
      cwd: REPO_ROOT,
      // Force non-TTY, color-free output regardless of where the test runs.
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SPAWN_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    // Drive the piped (non-TTY) stdin, then signal EOF.
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe('menu CLI (real spawn, piped stdin)', () => {
  before(() => {
    // The fix is only meaningful against the compiled artifact — build if needed.
    if (!existsSync(CLI_PATH)) {
      execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
    }
    assert.ok(existsSync(CLI_PATH), `built CLI must exist at ${CLI_PATH}`);
  });

  it('empty stdin → exit 0 and no ERR_USE_AFTER_CLOSE', async () => {
    const res = await runCli('');
    assert.equal(res.timedOut, false, 'CLI must not hang on empty stdin');
    assert.equal(res.code, 0, `empty stdin must exit 0 (got ${res.code}); stderr: ${res.stderr}`);
    assert.ok(
      !res.stderr.includes('ERR_USE_AFTER_CLOSE'),
      `stderr must not contain ERR_USE_AFTER_CLOSE; got: ${res.stderr}`,
    );
  });

  it('"q" → exit 0 (clean quit)', async () => {
    const res = await runCli('q\n');
    assert.equal(res.timedOut, false, 'CLI must not hang on "q"');
    assert.equal(res.code, 0, `"q" must exit 0 (got ${res.code}); stderr: ${res.stderr}`);
    assert.ok(
      !res.stderr.includes('ERR_USE_AFTER_CLOSE'),
      `stderr must not contain ERR_USE_AFTER_CLOSE; got: ${res.stderr}`,
    );
  });

  it('"x\\nq\\n" → exit 0 AND the unknown-option message for "x" is shown (key was dispatched, not lost)', async () => {
    const res = await runCli('x\nq\n');
    assert.equal(res.timedOut, false, 'CLI must not hang on "x" then "q"');
    assert.equal(res.code, 0, `must exit 0 (got ${res.code}); stderr: ${res.stderr}`);
    // The buffered "x" must actually reach the dispatcher — proving the
    // event-driven queue captured the line that the old rl.question() reader
    // dropped during startup provider-detection.
    assert.ok(
      res.stdout.includes('Unknown option: "x"'),
      `stdout must show the unknown-option message for "x" (proving dispatch); got:\n${res.stdout}`,
    );
  });

  it('"n" with no provider → auth gate → cancel → "q" → exit 0 (no ERR_USE_AFTER_CLOSE)', async () => {
    // "n" hits promptForAuthBeforeChat since no provider is signed in. Enter
    // cancels the gate, re-renders the menu, then "q" quits. This exercises the
    // same non-TTY line-dispatch path the original P0 fix targeted — but gated
    // behind the auth-prompt that now runs before entering the chat loop.
    const res = await runCli('n\n\nq\n');
    assert.equal(res.timedOut, false, 'CLI must not hang on n → cancel → q');
    assert.equal(res.code, 0, `must exit 0 (got ${res.code}); stderr: ${res.stderr}`);
    assert.ok(
      res.stdout.includes('No provider signed in yet'),
      `stdout must show the auth gate (proving "n" was dispatched); got:\n${res.stdout}`,
    );
    assert.ok(
      !res.stderr.includes('ERR_USE_AFTER_CLOSE'),
      `stderr must not contain ERR_USE_AFTER_CLOSE; got: ${res.stderr}`,
    );
  });
});
