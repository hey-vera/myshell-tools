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
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';

import {
  detectShellTarget,
  buildHookBlock,
  upsertHook,
  runInstall,
  isHookInstalled,
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

  it('returns fish + fish config path when SHELL contains fish', () => {
    const env = fakeEnv({ home: '/home/testuser', shell: '/usr/bin/fish' });
    const result = detectShellTarget(env, 'linux');
    assert.equal(result.kind, 'fish');
    assert.equal(result.path, '/home/testuser/.config/fish/config.fish');
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

  it('bash block contains command-exists guard for aliases', () => {
    const block = buildHookBlock('bash');
    assert.ok(
      block.includes('command -v myshell-tools >/dev/null 2>&1'),
      'bash block must guard aliases with command-exists check',
    );
  });

  it("bash block defines alias cm='myshell-tools'", () => {
    const block = buildHookBlock('bash');
    assert.ok(
      block.includes("alias cm='myshell-tools'"),
      "bash block must define alias cm='myshell-tools'",
    );
  });

  it("bash block defines alias mst='myshell-tools'", () => {
    const block = buildHookBlock('bash');
    assert.ok(
      block.includes("alias mst='myshell-tools'"),
      "bash block must define alias mst='myshell-tools'",
    );
  });

  it('zsh block is identical to bash block (POSIX syntax shared)', () => {
    const bashBlock = buildHookBlock('bash');
    const zshBlock = buildHookBlock('zsh');
    assert.equal(bashBlock, zshBlock, 'bash and zsh blocks must be identical');
  });

  it('zsh block contains command-exists guard for aliases', () => {
    const block = buildHookBlock('zsh');
    assert.ok(
      block.includes('command -v myshell-tools >/dev/null 2>&1'),
      'zsh block must guard aliases with command-exists check',
    );
  });

  it("zsh block defines alias cm='myshell-tools'", () => {
    const block = buildHookBlock('zsh');
    assert.ok(
      block.includes("alias cm='myshell-tools'"),
      "zsh block must define alias cm='myshell-tools'",
    );
  });

  it("zsh block defines alias mst='myshell-tools'", () => {
    const block = buildHookBlock('zsh');
    assert.ok(
      block.includes("alias mst='myshell-tools'"),
      "zsh block must define alias mst='myshell-tools'",
    );
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

  it('powershell block contains Get-Command guard for alias functions', () => {
    const block = buildHookBlock('powershell');
    // There should be a second Get-Command check guarding the cm/mst functions
    const matches = block.match(/Get-Command myshell-tools/g) ?? [];
    assert.ok(
      matches.length >= 2,
      'powershell block must use Get-Command at least twice (launch guard + alias guard)',
    );
  });

  it('powershell block defines function cm { myshell-tools @args }', () => {
    const block = buildHookBlock('powershell');
    assert.ok(
      block.includes('function cm { myshell-tools @args }'),
      'powershell block must define function cm',
    );
  });

  it('powershell block defines function mst { myshell-tools @args }', () => {
    const block = buildHookBlock('powershell');
    assert.ok(
      block.includes('function mst { myshell-tools @args }'),
      'powershell block must define function mst',
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

  it('removes alias definitions when uninstalling (aliases are inside the guarded block)', () => {
    const withHook = upsertHook('', 'bash', true);
    const removed = upsertHook(withHook, 'bash', false);
    assert.ok(!removed.includes("alias cm="), 'alias cm must be removed on uninstall');
    assert.ok(!removed.includes("alias mst="), 'alias mst must be removed on uninstall');
  });

  it('removes powershell alias functions when uninstalling', () => {
    const withHook = upsertHook('', 'powershell', true);
    const removed = upsertHook(withHook, 'powershell', false);
    assert.ok(!removed.includes('function cm'), 'function cm must be removed on uninstall');
    assert.ok(!removed.includes('function mst'), 'function mst must be removed on uninstall');
  });

  it('aborts on malformed markers instead of removing across user content', () => {
    const malformed = `${HOOK_BEGIN}\n# user line that must not be crossed\n${buildHookBlock('bash')}\n`;
    assert.throws(
      () => upsertHook(malformed, 'bash', false),
      /malformed/,
      'orphan begin above a clean block must be treated as malformed',
    );
  });

  it('aborts install upsert when existing markers are malformed', () => {
    const malformed = `${HOOK_BEGIN}\n# no matching managed block\n`;
    assert.throws(
      () => upsertHook(malformed, 'bash', true),
      /malformed/,
      'install must not append around malformed existing markers',
    );
  });

  it('install then uninstall leaves normal rc bytes unchanged', () => {
    const before = '# normal rc\nexport PATH="$HOME/bin:$PATH"';
    const installed = upsertHook(before, 'bash', true);
    const removed = upsertHook(installed, 'bash', false);
    assert.equal(removed, before, 'round-trip must preserve original bytes');
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
    opts?: { shell?: string },
  ): Promise<T> {
    const tempHome = join(tmpdir(), `install-test-${randomUUID()}`);
    await mkdir(tempHome, { recursive: true });

    const origHome = process.env['HOME'];
    const origShell = process.env['SHELL'];
    const origPlatform = process.platform;

    // Override HOME and SHELL to point at temp dir + requested shell
    process.env['HOME'] = tempHome;
    process.env['SHELL'] = opts?.shell ?? '/bin/bash';

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

  it('installs through a symlinked ~/.bashrc without replacing the symlink and preserves mode', { skip: process.platform === 'win32' }, async () => {
    await withTempHome(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const dotfilesDir = join(tempHome, 'dotfiles');
      const realRcPath = join(dotfilesDir, 'bashrc');
      await mkdir(dotfilesDir, { recursive: true });
      await writeFile(realRcPath, '# managed by dotfiles\n');
      await chmod(realRcPath, 0o600);
      await symlink(realRcPath, rcPath);

      const code = await runInstall(makeSink());
      assert.equal(code, 0, 'install through symlink should succeed');

      const linkStat = await lstat(rcPath);
      assert.equal(linkStat.isSymbolicLink(), true, 'rc path must remain a symlink');

      const content = await readFile(realRcPath, 'utf8');
      assert.ok(content.includes(HOOK_BEGIN), 'real symlink target must receive hook');

      const targetMode = (await stat(realRcPath)).mode & 0o777;
      assert.equal(targetMode, 0o600, 'existing rc mode must be preserved');
    });
  });

  it('refuses a dangling symlinked ~/.bashrc and prints the manual hook', { skip: process.platform === 'win32' }, async () => {
    await withTempHome(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      await symlink(join(tempHome, 'missing-bashrc'), rcPath);

      const sink = makeSink();
      const code = await runInstall(sink);
      assert.equal(code, 1, 'dangling symlink should be refused');
      assert.ok(sink.buf.includes('Refusing to replace the symlink'), 'output must refuse clobbering');
      assert.ok(sink.buf.includes(HOOK_BEGIN), 'output must include the manual hook snippet');

      const linkStat = await lstat(rcPath);
      assert.equal(linkStat.isSymbolicLink(), true, 'dangling rc path must remain a symlink');
    });
  });

  it('uninstall aborts on malformed markers and leaves user lines untouched', async () => {
    await withTempHome(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const malformed = `${HOOK_BEGIN}\n# unrelated user line\n${buildHookBlock('bash')}\n`;
      await writeFile(rcPath, malformed);

      const sink = makeSink();
      const code = await runInstall(sink, { uninstall: true });
      assert.equal(code, 1, 'uninstall should refuse malformed markers');
      assert.ok(sink.buf.includes('malformed'), 'output must explain malformed markers');

      const after = await readFile(rcPath, 'utf8');
      assert.equal(after, malformed, 'malformed rc must be left byte-identical');
      assert.ok(after.includes('# unrelated user line'), 'user line must not be deleted');
    });
  });

  it('clean managed block uninstall removes exactly the installed block', async () => {
    await withTempHome(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const before = '# before hook\nexport TEST=1\n';
      await writeFile(rcPath, upsertHook(before, 'bash', true));

      const code = await runInstall(makeSink(), { uninstall: true });
      assert.equal(code, 0, 'clean uninstall should succeed');

      const after = await readFile(rcPath, 'utf8');
      assert.equal(after, before, 'only the managed block should be removed');
    });
  });

  it('install then uninstall on a normal rc leaves it byte-identical', async () => {
    await withTempHome(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const before = '# normal rc\nexport PATH="$HOME/bin:$PATH"';
      await writeFile(rcPath, before);

      assert.equal(await runInstall(makeSink()), 0, 'install should succeed');
      assert.equal(await runInstall(makeSink(), { uninstall: true }), 0, 'uninstall should succeed');

      const after = await readFile(rcPath, 'utf8');
      assert.equal(after, before, 'install/uninstall round-trip must preserve bytes');
    });
  });

  it('fish shell refuses install and does not touch ~/.bashrc', async () => {
    await withTempHome(async (tempHome) => {
      const bashRcPath = join(tempHome, '.bashrc');
      const before = '# existing bash rc\n';
      await writeFile(bashRcPath, before);

      const sink = makeSink();
      const code = await runInstall(sink);
      assert.equal(code, 1, 'fish install should refuse');
      assert.ok(sink.buf.includes('fish is not supported'), 'output must name fish refusal');
      assert.ok(sink.buf.includes(HOOK_BEGIN), 'output must include manual hook guidance');

      const after = await readFile(bashRcPath, 'utf8');
      assert.equal(after, before, '~/.bashrc must not be touched for fish');
    }, { shell: '/usr/bin/fish' });
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

  it('install output mentions the cm / mst shortcuts', async () => {
    await withTempHome(async () => {
      const sink = makeSink();
      await runInstall(sink);
      assert.ok(
        sink.buf.includes('cm') && sink.buf.includes('mst'),
        'output must mention the cm and mst shortcuts',
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

  it('returns the correct npm install command for opencode', () => {
    const cmd = installCommandFor('opencode');
    assert.equal(cmd, 'npm install -g opencode-ai');
  });

  it('commands start with "npm install -g "', () => {
    for (const id of ['claude', 'codex', 'opencode'] as const) {
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

  it('opencode command references opencode-ai', () => {
    assert.ok(
      installCommandFor('opencode').includes('opencode-ai'),
      'opencode command must include the opencode-ai package name',
    );
  });

  it('is a pure function — same inputs always produce the same output', () => {
    assert.equal(installCommandFor('claude'), installCommandFor('claude'));
    assert.equal(installCommandFor('codex'), installCommandFor('codex'));
    assert.equal(installCommandFor('opencode'), installCommandFor('opencode'));
  });

  it('does not contain digit-% literals (Honesty Contract)', () => {
    for (const id of ['claude', 'codex', 'opencode'] as const) {
      const cmd = installCommandFor(id);
      assert.ok(!/\d+%/.test(cmd), `no digit-% literal in: "${cmd}"`);
    }
  });

  it('commands are all different from each other', () => {
    assert.notEqual(
      installCommandFor('claude'),
      installCommandFor('codex'),
      'install commands must differ between providers',
    );
    assert.notEqual(
      installCommandFor('claude'),
      installCommandFor('opencode'),
      'install commands must differ between providers',
    );
    assert.notEqual(
      installCommandFor('codex'),
      installCommandFor('opencode'),
      'install commands must differ between providers',
    );
  });
});

// ---------------------------------------------------------------------------
// isHookInstalled — never-throwing async detector
// ---------------------------------------------------------------------------

describe('isHookInstalled — async detector, never throws', () => {
  /**
   * Like the runInstall withTempHome helper but scoped here so it is accessible
   * to the isHookInstalled describe block (the runInstall one is function-scoped
   * to its own describe).
   */
  async function withTempHomeForHook<T>(
    fn: (tempHome: string) => Promise<T>,
  ): Promise<T> {
    const tempHome = join(tmpdir(), `hook-detect-${randomUUID()}`);
    await mkdir(tempHome, { recursive: true });

    const origHome = process.env['HOME'];
    const origShell = process.env['SHELL'];
    const origPlatform = process.platform;

    process.env['HOME'] = tempHome;
    process.env['SHELL'] = '/bin/bash';
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    try {
      return await fn(tempHome);
    } finally {
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
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  }

  it('returns true when HOOK_BEGIN is present in the rc file', async () => {
    await withTempHomeForHook(async (tempHome) => {
      // Write the hook to the rc file first (process.env.HOME now points at tempHome)
      await runInstall(makeSink());

      const env = fakeEnv({ home: tempHome, shell: '/bin/bash' });
      const result = await isHookInstalled(env, 'linux');
      assert.equal(result, true, 'isHookInstalled must return true when hook is present');
    });
  });

  it('returns false when HOOK_BEGIN is absent from the rc file', async () => {
    await withTempHomeForHook(async (tempHome) => {
      // Write a plain rc file without the hook
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(tempHome, '.bashrc'), '# plain bashrc\nexport PATH="$HOME/bin:$PATH"\n');

      const env = fakeEnv({ home: tempHome, shell: '/bin/bash' });
      const result = await isHookInstalled(env, 'linux');
      assert.equal(result, false, 'isHookInstalled must return false when hook is absent');
    });
  });

  it('returns false when the rc file does not exist (missing file)', async () => {
    await withTempHomeForHook(async (tempHome) => {
      // No rc file written — the file doesn't exist
      const env = fakeEnv({ home: tempHome, shell: '/bin/bash' });
      const result = await isHookInstalled(env, 'linux');
      assert.equal(result, false, 'isHookInstalled must return false for a missing rc file');
    });
  });

  it('never throws — always returns a boolean', async () => {
    // Even with a nonsense HOME path that can't be read
    const env = fakeEnv({ home: '/this/path/does/not/exist', shell: '/bin/bash' });
    await assert.doesNotReject(
      () => isHookInstalled(env, 'linux'),
      'isHookInstalled must never throw',
    );
    const result = await isHookInstalled(env, 'linux');
    assert.equal(typeof result, 'boolean', 'result must always be a boolean');
  });

  it('returns false after uninstalling the hook', async () => {
    await withTempHomeForHook(async (tempHome) => {
      // Install, then uninstall
      await runInstall(makeSink());
      await runInstall(makeSink(), { uninstall: true });

      const env = fakeEnv({ home: tempHome, shell: '/bin/bash' });
      const result = await isHookInstalled(env, 'linux');
      assert.equal(result, false, 'isHookInstalled must return false after uninstall');
    });
  });
});
