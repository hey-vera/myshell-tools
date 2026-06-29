/**
 * CLI integration coverage for persistent feature rollback.
 *
 * Spawns the real src/cli.ts entry point against an isolated HOME, proving the
 * top-level command persists atomically, is idempotent, removes its override,
 * and reports an emergency environment override honestly.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const CLI = new URL('../../src/cli.ts', import.meta.url).pathname;
const TSX_LOADER = import.meta.resolve('tsx/esm');

describe('myshell-tools rollback CLI', () => {
  let homeDir: string;

  beforeAll(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `rollback-cli-${randomUUID()}-`));
  });

  afterAll(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  async function run(args: readonly string[], rollbackEnv?: string): Promise<string> {
    const env = { ...process.env, HOME: homeDir };
    delete env['REPL_ID'];
    delete env['REPLIT_DEV_DOMAIN'];
    if (rollbackEnv === undefined) delete env['MYSHELL_ROLLBACK'];
    else env['MYSHELL_ROLLBACK'] = rollbackEnv;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', TSX_LOADER, CLI, ...args],
      { cwd: homeDir, env },
    );
    assert.equal(stderr, '');
    return stdout;
  }

  async function readPersisted(): Promise<Record<string, unknown>> {
    return JSON.parse(
      await readFile(join(homeDir, '.myshell-tools', 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
  }

  it.skipIf(process.platform === 'win32')('engages/removes rollback idempotently and preserves env precedence', async () => {
    assert.equal(
      await run(['rollback']),
      'Rollback engaged. Disabled: verify, judgment, trust.\n',
    );
    assert.equal((await readPersisted())['rollback'], true);

    assert.equal(
      await run(['rollback']),
      'Rollback engaged. Disabled: verify, judgment, trust.\n',
    );
    assert.equal((await readPersisted())['rollback'], true);

    assert.equal(
      await run(['rollback', 'off']),
      'Rollback override removed. Defaults restored for: verify, judgment, trust.\n',
    );
    assert.equal(Object.hasOwn(await readPersisted(), 'rollback'), false);

    assert.equal(
      await run(['rollback', 'off']),
      'Rollback override removed. Defaults restored for: verify, judgment, trust.\n',
    );
    assert.equal(Object.hasOwn(await readPersisted(), 'rollback'), false);

    assert.equal(
      await run(['rollback', 'off'], '1'),
      'Rollback override removed. MYSHELL_ROLLBACK remains engaged. Disabled: verify, judgment, trust.\n',
    );
    assert.equal(Object.hasOwn(await readPersisted(), 'rollback'), false);
  });
});
