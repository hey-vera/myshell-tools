/**
 * Integration: real packed-artifact install smoke (R9.1).
 *
 * Delegates to scripts/packed-install-smoke.mjs so CI package-check and the
 * vitest integration lane share one implementation. Slow (pack + install);
 * timeout is generous. Skips only if explicitly disabled via env.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts', 'packed-install-smoke.mjs');

const SKIP = process.env['MYSHELL_SKIP_PACKED_SMOKE'] === '1';

describe('packed-install-smoke (R9.1 real tarball)', () => {
  it.skipIf(SKIP)(
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
