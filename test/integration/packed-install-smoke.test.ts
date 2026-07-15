/**
 * Integration: real packed-artifact install smoke (R9.1).
 *
 * Delegates to scripts/packed-install-smoke.mjs so CI package-check and local
 * opt-in runs share one implementation. Slow (pack + install); too heavy for
 * the multi-OS×Node unit/integration matrix — opt-in only via
 * MYSHELL_PACKED_SMOKE=1. Default CI proof is package-check's `npm run smoke:packed`.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts', 'packed-install-smoke.mjs');

// Opt-in only. Default test:integration must not run pack+install on every matrix cell.
const RUN = process.env['MYSHELL_PACKED_SMOKE'] === '1';

describe('packed-install-smoke (R9.1 real tarball)', () => {
  it.skipIf(!RUN)(
    'npm pack → install empty project → both bins help/version → actionable no-provider',
    () => {
      assert.ok(existsSync(script), `missing ${script}`);
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 300_000,
      });
      if (result.error) {
        assert.fail(`spawn failed: ${result.error.message}`);
      }
      if (result.status !== 0) {
        assert.fail(
          `packed-install-smoke exited ${result.status}\n` +
            `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
        );
      }
      assert.match(result.stdout ?? '', /ALL CHECKS PASSED/);
    },
    300_000,
  );
});
