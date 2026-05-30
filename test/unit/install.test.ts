/**
 * test/unit/install.test.ts — unit tests for src/commands/install.ts
 * and src/providers/install.ts (pure helpers only).
 *
 * All I/O tests use a temp HOME directory so they never touch the real one.
 *
 * Honesty Contract: no Math.random, no fabricated data, no digit-% literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

import {
  detectShellTarget,
  buildHookBlock,
  upsertHook,
  runInstall,
  HOOK_BEGIN,
  HOOK_END,
} from '../../src/commands/install.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import { installCommandFor } from '../../src/providers/install.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSink(): OutputSink & { buf: string } {
  let buf = '';
  return {
    get buf() { return buf; },
    write: (s: string) => { buf += s; },
    color: false,
    isTty: false,
  };
}

/**
 * Build a fake env with HOME and optionally SHELL set.
 * USERPROFILE is set for win32 paths.
 */
function fakeEnv(opts: {
  home?: string;
  shell?: string;
  userProfile?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (opts.home !== undefined) env['HOME'] = opts.home;
  if (opts.shell !== undefined) env['SHELL'] = opts.shell;
  if (opts.userProfile !== undefined) env['USERPROFILE'] = opts.userProfile;
  return env;
}

// ---------------------------------------------------------------------------
// detectShellTarget — PURE
// ---------------------------------------------------------------------------

describe('detectShellTarget — pure, no I/O', () => {
  it('returns powershell + profile path on win32', () => {
    const env = fakeEnv({ userProfile: 'C:\\Users\\TestUser' });
    const result = detectShellTarget(env, 'win32');
    assert.equal(result.kind, 'powershell');
    assert.ok(
      result.path.includes('WindowsPowerShell'),
      `path should include WindowsPowerShell: ${result.path}`,
    );
    assert.ok(
      result.path.includes('Microsoft.PowerShell_profile.ps1'),
      `path should include profile file name: ${result.path}`,
    );
    assert.ok(
      result.path.includes('TestUser'),
      `path should include USERPROFILE: ${result.path}`,
    );
  });

  it('returns zsh + ~/.zshrc when SHELL contains zsh', () => {
    const env = fakeEnv({ home: '/home/testuser', shell: '/usr/bin/zsh' });
    const result = detectShellTarget(env, 'linux');
    assert.equal(result.kind, 'zsh');
    assert.equal(result.path, '/home/testuser/.zshrc');
  });

  it('returns bash + ~/.bashrc when SHELL is /bin/bash', () => {
    const env = fakeEnv({ home: '/home/testuser', shell: '/bin/bash' });
    const result = detectShellTarget(env, 'linux');
    assert.equal(result.kind, 'bash');
    assert.equal(result.path, '/home/testuser/.bashrc');
  });

  it('returns bash + ~/.bashrc when SHELL is absent (default)', () => {
    const env = fakeEnv({ home: '/home/testuser' });
    const result = detectShellTarget(env, 'linux');
    assert.equal(result.kind, 'bash');
    assert.equal(result.path, '/home/testuser/.bashrc');
  });

  it('win32 result uses USERPROFILE, not HOME', () => {
    const env = fakeEnv({ home: '/home/notused', userProfile: 'C:\\Users\\RealUser' });
    const result = detectShellTarget(env, 'win32');
    assert.ok(result.path.includes('RealUser'), 'should use USERPROFILE on win32');
    assert.ok(!result.path.includes('notused'), 'should NOT use HOME on win32');
  });

  it('is a pure function — same inputs yield same output', () => {
    const env = fakeEnv({ home: '/home/x', shell: '/bin/bash' });
    const a = detectShellTarget(env, 'linux');
    const b = detectShellTarget(env, 'linux');
    assert.equal(a.kind, b.kind);
    assert.equal(a.path, b.path);
  });
});

// ---------------------------------------------------------------------------
// buildHookBlock — PURE
// ---------------------------------------------------------------------------

describe('buildHookBlock — pure, no I/O', () => {
  it('bash block contains HOOK_BEGIN marker', () => {
    const block = buildHookBlock('bash');
    assert.ok(block.includes(HOOK_BEGIN), 'bash block must include HOOK_BEGIN');
  });

  it('bash block contains HOOK_END marker', () => {
    const block = buildHookBlock('bash');
    assert.ok(block.includes(HOOK_END), 'bash block must include HOOK_END');
  });

  it('bash block contains TTY guard [ -t 1 ]', () => {
    const block = buildHookBlock('bash');
    assert.ok(block.includes('[ -t 1 ]'), 'bash block must contain TTY guard "[ -t 1 ]"');
  });

  it('bash block references MYSHELL_SKIP opt-out variable', () => {
    const block = buildHookBlock('bash');
    assert.ok(block.includes('MYSHELL_SKIP'), 'bash block must reference MYSHELL_SKIP');
  });

  it('bash block references MYSHELL_LOADED double-launch guard', () => {
    const block = buildHookBlock('bash');
    assert.ok(block.includes('MYSHELL_LOADED'), 'bash block must reference MYSHELL_LOADED');
  });

  it('bash block contains the launch line', () => {
    const block = buildHookBlock('bash');
    assert.ok(
      block.includes('myshell-tools'),
      'bash block must contain a line that launches myshell-tools',
    );
  });

  it('zsh block is identical to bash block (POSIX syntax shared)', () => {
    const bashBlock = buildHookBlock('bash');
    const zshBlock = buildHookBlock('zsh');
    assert.equal(bashBlock, zshBlock, 'bash and zsh blocks must be identical');
  });

  it('powershell block contains HOOK_BEGIN marker', () => {
    const block = buildHookBlock('powershell');
    assert.ok(block.includes(HOOK_BEGIN), 'powershell block must include HOOK_BEGIN');
  });

  it('powershell block contains HOOK_END marker', () => {
    const block = buildHookBlock('powershell');
    assert.ok(block.includes(HOOK_END), 'powershell block must include HOOK_END');
  });

  it('powershell block references $env:MYSHELL_LOADED', () => {
    const block = buildHookBlock('powershell');
    assert.ok(
      block.includes('MYSHELL_LOADED'),
      'powershell block must reference MYSHELL_LOADED',
    );
  });

  it('powershell block references $env:MYSHELL_SKIP', () => {
    const block = buildHookBlock('powershell');
    assert.ok(
      block.includes('MYSHELL_SKIP'),
      'powershell block must reference MYSHELL_SKIP',
    );
  });

  it('powershell block contains Get-Command guard', () => {
    const block = buildHookBlock('powershell');
    assert.ok(
      block.includes('Get-Command myshell-tools'),
      'powershell block must use Get-Command to check for myshell-tools',
    );
  });

  it('powershell block contains the launch call', () => {
    const block = buildHookBlock('powershell');
    assert.ok(
      block.includes('myshell-tools'),
      'powershell block must contain a call to myshell-tools',
    );
  });

  it('does not contain digit-% literals (Honesty Contract)', () => {
    for (const kind of ['bash', 'zsh', 'powershell'] as const) {
      const block = buildHookBlock(kind);
      assert.ok(!/\d+%/.test(block), `no digit-% in ${kind} block`);
    }
  });
});

// ---------------------------------------------------------------------------
// upsertHook — PURE
// ---------------------------------------------------------------------------

describe('upsertHook — pure, no I/O', () => {
  it('appends the block when rc file is empty', () => {
    const result = upsertHook('', 'bash', true);
    assert.ok(result.includes(HOOK_BEGIN), 'empty rc: block must be appended');
    assert.ok(result.includes(HOOK_END), 'empty rc: block must include end marker');
  });

  it('appends the block when rc file has existing content', () => {
    const existing = '# existing bashrc content\nexport PATH="$HOME/bin:$PATH"\n';
    const result = upsertHook(existing, 'bash', true);
    assert.ok(result.includes('# existing bashrc content'), 'existing content preserved');
    assert.ok(result.includes(HOOK_BEGIN), 'block appended after existing content');
  });

  it('does not duplicate the block when already present (idempotent install)', () => {
    const existing = '# stuff\n';
    // First insert
    const once = upsertHook(existing, 'bash', true);
    // Second insert on already-modified content
    const twice = upsertHook(once, 'bash', true);
    const beginCount = (twice.match(new RegExp(escapeForCount(HOOK_BEGIN), 'g')) ?? []).length;
    assert.equal(beginCount, 1, 'HOOK_BEGIN must appear exactly once after two installs');
  });

  it('removes the block when enable=false (uninstall)', () => {
    const base = '# before\n';
    const withHook = upsertHook(base, 'bash', true);
    const removed = upsertHook(withHook, 'bash', false);
    assert.ok(!removed.includes(HOOK_BEGIN), 'HOOK_BEGIN must be removed on uninstall');
    assert.ok(!removed.includes(HOOK_END), 'HOOK_END must be removed on uninstall');
  });

  it('preserves surrounding content when removing the block', () => {
    const before = '# before the hook\n';
    const after = '# after the hook\n';
    const withHook = upsertHook(before, 'bash', true) + after;
    const removed = upsertHook(withHook, 'bash', false);
    assert.ok(removed.includes('# before the hook'), 'content before hook preserved');
    assert.ok(removed.includes('# after the hook'), 'content after hook preserved');
  });

  it('enable=false on already-empty file returns empty string', () => {
    const result = upsertHook('', 'bash', false);
    assert.equal(result, '', 'removing from empty file yields empty string');
  });

  it('is a pure function — does not throw for any combination of inputs', () => {
    const kinds = ['bash', 'zsh', 'powershell'] as const;
    for (const kind of kinds) {
      assert.doesNotThrow(() => upsertHook('', kind, true));
      assert.doesNotThrow(() => upsertHook('', kind, false));
      assert.doesNotThrow(() => upsertHook('existing\n', kind, true));
      assert.doesNotThrow(() => upsertHook('existing\n', kind, false));
    }
  });
});

function escapeForCount(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// runInstall — I/O tests with a temp HOME
// ---------------------------------------------------------------------------

describe('runInstall — writes to temp HOME, not real HOME', () => {
  /**
   * Build a temp HOME directory and override process.env.HOME + process.platform
   * for the duration of the test, then restore them.
   */
  async function withTempHome<T>(
    fn: (tempHome: string) => Promise<T>,
  ): Promise<T> {
    const tempHome = join(tmpdir(), `install-test-${randomUUID()}`);
    await mkdir(tempHome, { recursive: true });

    const origHome = process.env['HOME'];
    const origShell = process.env['SHELL'];
    const origPlatform = process.platform;

    // Override HOME and SHELL to point at temp dir + bash
    process.env['HOME'] = tempHome;
    process.env['SHELL'] = '/bin/bash';

    // Override platform to linux so we hit bash path
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    try {
      return await fn(tempHome);
    } finally {
      // Restore
      if (origHome !== undefined) {
        process.env['HOME'] = origHome;
      } else {
        delete process.env['HOME'];
      }
      if (origShell !== undefined) {
        process.env['SHELL'] = origShell;
      } else {
        delete process.env['SHELL'];
      }
      Object.defineProperty(process, 'platform', {
        value: origPlatform,
        configurable: true,
      });
    }
  }

  it('creates ~/.bashrc with the hook block on first install', async () => {
    await withTempHome(async (tempHome) => {
      const sink = makeSink();
      const code = await runInstall(sink);
      assert.equal(code, 0, 'runInstall should return 0 on success');

      const rcPath = join(tempHome, '.bashrc');
      const content = await readFile(rcPath, 'utf8');
      assert.ok(content.includes(HOOK_BEGIN), '.bashrc must contain HOOK_BEGIN');
      assert.ok(content.includes(HOOK_END), '.bashrc must contain HOOK_END');
    });
  });

  it('does not duplicate the block when installed twice (idempotent)', async () => {
    await withTempHome(async (tempHome) => {
      const sink1 = makeSink();
      await runInstall(sink1);

      const sink2 = makeSink();
      await runInstall(sink2);

      const rcPath = join(tempHome, '.bashrc');
      const content = await readFile(rcPath, 'utf8');
      const count = (content.match(new RegExp(escapeForCount(HOOK_BEGIN), 'g')) ?? []).length;
      assert.equal(count, 1, 'HOOK_BEGIN must appear exactly once after two installs');
    });
  });

  it('removes the block on uninstall', async () => {
    await withTempHome(async (tempHome) => {
      // Install first
      await runInstall(makeSink());

      // Verify installed
      const rcPath = join(tempHome, '.bashrc');
      const afterInstall = await readFile(rcPath, 'utf8');
      assert.ok(afterInstall.includes(HOOK_BEGIN), 'hook must be present after install');

      // Now uninstall
      const uninstallSink = makeSink();
      const code = await runInstall(uninstallSink, { uninstall: true });
      assert.equal(code, 0, 'uninstall should return 0');

      const afterUninstall = await readFile(rcPath, 'utf8');
      assert.ok(!afterUninstall.includes(HOOK_BEGIN), 'hook must be removed after uninstall');
      assert.ok(!afterUninstall.includes(HOOK_END), 'HOOK_END must be removed after uninstall');
    });
  });

  it('install output mentions the rc file path', async () => {
    await withTempHome(async (_tempHome) => {
      const sink = makeSink();
      await runInstall(sink);
      // The output should contain ".bashrc" — we don't assert the full path because
      // path separator style (forward/back) can vary across platforms.
      assert.ok(
        sink.buf.includes('.bashrc'),
        `output must mention .bashrc; got: ${sink.buf}`,
      );
    });
  });

  it('install output mentions how to opt out', async () => {
    await withTempHome(async () => {
      const sink = makeSink();
      await runInstall(sink);
      assert.ok(
        sink.buf.includes('MYSHELL_SKIP'),
        'output must mention the MYSHELL_SKIP opt-out variable',
      );
    });
  });

  it('install output mentions how to reverse (uninstall command)', async () => {
    await withTempHome(async () => {
      const sink = makeSink();
      await runInstall(sink);
      assert.ok(
        sink.buf.includes('uninstall'),
        'output must mention the uninstall command',
      );
    });
  });

  it('uninstall output confirms removal', async () => {
    await withTempHome(async () => {
      await runInstall(makeSink()); // install first
      const sink = makeSink();
      await runInstall(sink, { uninstall: true });
      assert.ok(
        sink.buf.toLowerCase().includes('removed'),
        'uninstall output must confirm removal',
      );
    });
  });

  it('does not contain digit-% literals in output (Honesty Contract)', async () => {
    await withTempHome(async () => {
      const sink = makeSink();
      await runInstall(sink);
      assert.ok(!/\d+%/.test(sink.buf), 'install output must not contain digit-% literals');
    });
  });
});

// ---------------------------------------------------------------------------
// installCommandFor — kept from the original provider install tests
// ---------------------------------------------------------------------------

describe('installCommandFor — pure helper, no I/O', () => {
  it('returns the correct npm install command for claude', () => {
    const cmd = installCommandFor('claude');
    assert.equal(cmd, 'npm install -g @anthropic-ai/claude-code');
  });

  it('returns the correct npm install command for codex', () => {
    const cmd = installCommandFor('codex');
    assert.equal(cmd, 'npm install -g @openai/codex');
  });

  it('commands start with "npm install -g "', () => {
    for (const id of ['claude', 'codex'] as const) {
      assert.ok(
        installCommandFor(id).startsWith('npm install -g '),
        `${id}: command must start with "npm install -g "`,
      );
    }
  });

  it('claude command references @anthropic-ai/claude-code', () => {
    assert.ok(
      installCommandFor('claude').includes('@anthropic-ai/claude-code'),
      'claude command must include the @anthropic-ai/claude-code package name',
    );
  });

  it('codex command references @openai/codex', () => {
    assert.ok(
      installCommandFor('codex').includes('@openai/codex'),
      'codex command must include the @openai/codex package name',
    );
  });

  it('is a pure function — same inputs always produce the same output', () => {
    assert.equal(installCommandFor('claude'), installCommandFor('claude'));
    assert.equal(installCommandFor('codex'), installCommandFor('codex'));
  });

  it('does not contain digit-% literals (Honesty Contract)', () => {
    for (const id of ['claude', 'codex'] as const) {
      const cmd = installCommandFor(id);
      assert.ok(!/\d+%/.test(cmd), `no digit-% literal in: "${cmd}"`);
    }
  });

  it('commands are different for different providers', () => {
    assert.notEqual(
      installCommandFor('claude'),
      installCommandFor('codex'),
      'install commands must differ between providers',
    );
  });
});
