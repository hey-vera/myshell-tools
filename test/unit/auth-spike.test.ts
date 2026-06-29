/**
 * test/unit/auth-spike.test.ts — existence + fail-soft smoke for the auth-spike script.
 *
 * The real auth validation lives in `test/auth-spike.sh` (Chunk B deliverable).
 * This test only verifies that the script exists, is executable, and runs to
 * completion without error. It makes NO live model calls; it may shell out to
 * provider CLIs, but the script is fail-soft and reports missing/unauthenticated
 * providers honestly rather than crashing.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'auth-spike.sh');

describe('auth-spike.sh — Chunk B auth validation script', () => {
  it('exists and is executable', async () => {
    await access(SCRIPT_PATH, constants.F_OK | constants.X_OK);
  });

  it.skipIf(process.platform === 'win32')('runs fail-soft and exits 0 even when providers are missing or unsigned-in', async () => {
    const { stdout, stderr } = await execFileAsync(SCRIPT_PATH, [], {
      timeout: 60_000,
      env: { ...process.env, QUIET: '0' },
    });
    const out = stdout + stderr;
    assert.match(out, /auth-spike:/);
    assert.match(out, /claude:/);
    assert.match(out, /codex:/);
    assert.match(out, /grok:/);
    assert.match(out, /opencode:/);
  });
});
