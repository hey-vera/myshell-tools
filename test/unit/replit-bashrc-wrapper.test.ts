/**
 * test/unit/replit-bashrc-wrapper.test.ts — unit tests for the Replit bashrc
 * wrapper helpers in src/commands/install.ts.
 *
 * Pure helper tests run on all platforms.
 * Symlink-aware I/O tests are guarded: skipped on win32 because symlink creation
 * requires privileges that CI/test runners typically lack.
 *
 * Honesty Contract: no Math.random in assertions, no digit-% literals.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';

import {
  shellSingleQuote,
  buildReplitWrappedBashrc,
  isReplitWrappedBashrc,
  parseReplitOriginalTarget,
  buildHookBlock,
  ensureReplitShellHook,
  HOOK_BEGIN,
  HOOK_END,
} from '../../src/commands/install.ts';
import type { OutputSink } from '../../src/interface/render.ts';

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

const FAKE_NIX_TARGET = '/nix/store/abc123-replit-bashrc/bashrc';

// ---------------------------------------------------------------------------
// shellSingleQuote — PURE
// ---------------------------------------------------------------------------

describe('shellSingleQuote — pure', () => {
  it('wraps a simple string in single quotes', () => {
    assert.equal(shellSingleQuote('hello'), "'hello'");
  });

  it('escapes embedded single quotes as the standard sequence', () => {
    const result = shellSingleQuote("it's");
    assert.equal(result, "'it'\\''s'");
  });

  it('handles a path with no special characters', () => {
    const result = shellSingleQuote('/nix/store/foo/bar');
    assert.equal(result, "'/nix/store/foo/bar'");
  });

  it('handles a path containing single quotes', () => {
    const result = shellSingleQuote("/path/with/quote's/in/it");
    assert.equal(result, "'/path/with/quote'\\''s/in/it'");
  });

  it('handles multiple single quotes', () => {
    const result = shellSingleQuote("a'b'c");
    assert.equal(result, "'a'\\''b'\\''c'");
  });

  it('returns a pure result — same input, same output', () => {
    const a = shellSingleQuote(FAKE_NIX_TARGET);
    const b = shellSingleQuote(FAKE_NIX_TARGET);
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// buildReplitWrappedBashrc — PURE
// ---------------------------------------------------------------------------

describe('buildReplitWrappedBashrc — pure', () => {
  it('contains the wrapper begin marker', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.ok(
      result.includes('# >>> myshell-tools replit bashrc wrapper >>>'),
      'must contain wrapper begin marker',
    );
  });

  it('contains the wrapper end marker', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.ok(
      result.includes('# <<< myshell-tools replit bashrc wrapper <<<'),
      'must contain wrapper end marker',
    );
  });

  it('contains the REPLIT_ORIGINAL_PREFIX line with the target', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    const expectedLine = `# myshell-tools-replit-original-bashrc: ${FAKE_NIX_TARGET}`;
    assert.ok(result.includes(expectedLine), `must contain "${expectedLine}"`);
  });

  it('contains a sourcing line that single-quotes the target', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.ok(
      result.includes(`. '${FAKE_NIX_TARGET}'`),
      `must contain ". '${FAKE_NIX_TARGET}'"`,
    );
  });

  it('contains the guarded sourcing block in the correct order', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    const idxBegin = result.indexOf('# >>> myshell-tools replit bashrc wrapper >>>');
    const idxSource = result.indexOf('# Source Replit original');
    const idxIf = result.indexOf(`if [ -r '${FAKE_NIX_TARGET}' ]; then`);
    const idxDot = result.indexOf(`. '${FAKE_NIX_TARGET}'`);
    const idxFi = result.indexOf('\nfi\n', idxDot);
    const idxHook = result.indexOf(HOOK_BEGIN);
    const idxEnd = result.indexOf('# <<< myshell-tools replit bashrc wrapper <<<');

    assert.ok(idxBegin >= 0, 'begin marker present');
    assert.ok(idxEnd >= 0, 'end marker present');
    assert.ok(idxHook >= 0, 'hook begin present');
    assert.ok(idxFi >= 0, 'closing fi present');
    assert.ok(idxBegin < idxSource, 'begin < source comment');
    assert.ok(idxSource < idxIf, 'source comment < if');
    assert.ok(idxIf < idxDot, 'if < dot-source');
    assert.ok(idxDot < idxFi, 'dot-source < fi');
    assert.ok(idxFi < idxHook, 'fi < hook block');
    assert.ok(idxHook < idxEnd, 'hook block < end marker');
  });

  it('contains the full buildHookBlock("bash") output', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    const hookBlock = buildHookBlock('bash');
    assert.ok(result.includes(hookBlock), 'must include full bash hook block');
  });

  it('contains the bash hook fail-soft launch (|| true)', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.ok(result.includes('|| true'), 'must include fail-soft launch');
  });

  it('contains the bash hook MYSHELL_SKIP opt-out', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.ok(result.includes('MYSHELL_SKIP'), 'must include MYSHELL_SKIP');
  });

  it('wraps the path in single quotes for the sourcing guard', () => {
    const result = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.ok(
      result.includes(`if [ -r '${FAKE_NIX_TARGET}' ]`),
      'must quote path in -r test',
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency at the string level
// ---------------------------------------------------------------------------

describe('buildReplitWrappedBashrc idempotency', () => {
  it('building a wrapper for the same target twice is byte-identical', () => {
    const a = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    const b = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.equal(a, b, 'same target must produce byte-identical output');
  });

  it('different targets produce different output', () => {
    const a = buildReplitWrappedBashrc('/nix/store/aaa/bashrc');
    const b = buildReplitWrappedBashrc('/nix/store/bbb/bashrc');
    assert.notEqual(a, b, 'different targets must produce different output');
  });

  it('is a pure function — no side effects', () => {
    const before = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    // Call again — nothing should change
    const after = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.equal(before, after);
  });
});

// ---------------------------------------------------------------------------
// isReplitWrappedBashrc + parseReplitOriginalTarget round-trip
// ---------------------------------------------------------------------------

describe('isReplitWrappedBashrc + parseReplitOriginalTarget round-trip', () => {
  it('isReplitWrappedBashrc returns true for wrapped content', () => {
    const wrapped = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    assert.equal(isReplitWrappedBashrc(wrapped), true);
  });

  it('isReplitWrappedBashrc returns false for unwrapped content', () => {
    assert.equal(isReplitWrappedBashrc('# plain bashrc\n'), false);
    assert.equal(isReplitWrappedBashrc(''), false);
  });

  it('isReplitWrappedBashrc returns false for content with only HOOK_BEGIN', () => {
    const content = `${HOOK_BEGIN}\nsome hook\n${HOOK_END}`;
    assert.equal(isReplitWrappedBashrc(content), false);
  });

  it('parseReplitOriginalTarget returns the target that build embedded', () => {
    const wrapped = buildReplitWrappedBashrc(FAKE_NIX_TARGET);
    const parsed = parseReplitOriginalTarget(wrapped);
    assert.equal(parsed, FAKE_NIX_TARGET, 'parse must recover the original target');
  });

  it('parseReplitOriginalTarget returns undefined for unwrapped content', () => {
    assert.equal(parseReplitOriginalTarget(''), undefined);
    assert.equal(parseReplitOriginalTarget('# plain content'), undefined);
  });

  it('parseReplitOriginalTarget returns empty string when prefix is present but target is empty', () => {
    const content = '# myshell-tools-replit-original-bashrc: \n';
    // The prefix is present but followed by only whitespace — still returns empty string, not undefined
    const result = parseReplitOriginalTarget(content);
    assert.equal(result, '');
  });

  it('round-trip: build then parse returns the same target', () => {
    const targets = [
      FAKE_NIX_TARGET,
      '/nix/store/xyz-other-bashrc/bashrc',
      '/nix/store/hash123---replit-bashrc-2.0/bashrc',
    ];
    for (const target of targets) {
      const built = buildReplitWrappedBashrc(target);
      const parsed = parseReplitOriginalTarget(built);
      assert.equal(parsed, target, `round-trip failed for target: ${target}`);
    }
  });
});

// ---------------------------------------------------------------------------
// ensureReplitShellHook — I/O tests with temp HOME and REPL_ID
// ---------------------------------------------------------------------------

describe('ensureReplitShellHook — I/O (Replit env)', () => {
  /**
   * Build a temp HOME and set REPL_ID env for the duration of the test.
   */
  async function withReplitEnv<T>(
    fn: (tempHome: string) => Promise<T>,
  ): Promise<T> {
    const tempHome = join(tmpdir(), `replit-test-${randomUUID()}`);
    await mkdir(tempHome, { recursive: true });

    const origHome = process.env['HOME'];
    const origReplId = process.env['REPL_ID'];
    const origNixRoot = process.env['MYSHELL_NIX_STORE_ROOT'];
    const origPlatform = process.platform;

    process.env['HOME'] = tempHome;
    process.env['REPL_ID'] = 'test-repl-id';
    // Point the Nix-store-root detection at this test's temp nix store. A sandbox
    // cannot create files under the real /nix/store/, so we resolve symlinks in
    // the temp home (e.g. macOS /var → /private/var) to match realpath() output.
    const resolvedHome = await realpath(tempHome);
    process.env['MYSHELL_NIX_STORE_ROOT'] = `${join(resolvedHome, 'nix', 'store')}/`;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    try {
      return await fn(tempHome);
    } finally {
      if (origHome !== undefined) {
        process.env['HOME'] = origHome;
      } else {
        delete process.env['HOME'];
      }
      if (origReplId !== undefined) {
        process.env['REPL_ID'] = origReplId;
      } else {
        delete process.env['REPL_ID'];
      }
      if (origNixRoot !== undefined) {
        process.env['MYSHELL_NIX_STORE_ROOT'] = origNixRoot;
      } else {
        delete process.env['MYSHELL_NIX_STORE_ROOT'];
      }
      Object.defineProperty(process, 'platform', {
        value: origPlatform,
        configurable: true,
      });
    }
  }

  it('returns ok:true, installed:false when not on Replit (no REPL_ID)', async () => {
    // Don't set REPL_ID — simulate non-Replit env
    const tempHome = join(tmpdir(), `replit-test-${randomUUID()}`);
    await mkdir(tempHome, { recursive: true });

    const origHome = process.env['HOME'];
    const origPlatform = process.platform;

    process.env['HOME'] = tempHome;
    delete process.env['REPL_ID'];
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    try {
      const result = await ensureReplitShellHook(makeSink());
      assert.equal(result.ok, true);
      assert.equal(result.installed, false);
      assert.equal(result.changed, false);
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
      Object.defineProperty(process, 'platform', {
        value: origPlatform,
        configurable: true,
      });
    }
  });

  it('returns installed:false when .bashrc does not exist on Replit', async () => {
    await withReplitEnv(async (_tempHome) => {
      const result = await ensureReplitShellHook(makeSink());
      assert.equal(result.ok, true);
      assert.equal(result.installed, false);
    });
  });

  it('creates wrapper when .bashrc is a Nix-store symlink', { skip: process.platform === 'win32' }, async () => {
    await withReplitEnv(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      // Create a real file under /nix/store/ lookalike in the temp home
      const nixDir = join(tempHome, 'nix', 'store', 'abc123-replit-bashrc');
      await mkdir(nixDir, { recursive: true });
      const nixTarget = join(nixDir, 'bashrc');
      await writeFile(nixTarget, '# original Replit bashrc\nexport REPLIT_TRACKING=1\n');

      // Create symlink ~/.bashrc -> nix real target
      await symlink(nixTarget, rcPath);

      const sink = makeSink();
      const result = await ensureReplitShellHook(sink);
      assert.equal(result.ok, true);
      assert.equal(result.installed, true);
      assert.equal(result.changed, true);

      // Verify the wrapper file was written in place of the symlink
      const st = await lstat(rcPath);
      assert.equal(st.isFile(), true, '~/.bashrc must be a regular file after install');

      const content = await readFile(rcPath, 'utf8');
      assert.ok(isReplitWrappedBashrc(content), 'content must be wrapped');
      assert.ok(
        content.includes(`# myshell-tools-replit-original-bashrc: ${nixTarget}`),
        'must record original target',
      );
      assert.ok(content.includes(HOOK_BEGIN), 'must include hook block');
      assert.ok(content.includes(HOOK_END), 'must include hook end');
    });
  });

  it('is idempotent — second install on already-wrapped bashrc does not change content', { skip: process.platform === 'win32' }, async () => {
    await withReplitEnv(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const nixDir = join(tempHome, 'nix', 'store', 'abc123-replit-bashrc');
      await mkdir(nixDir, { recursive: true });
      const nixTarget = join(nixDir, 'bashrc');
      await writeFile(nixTarget, '# original\n');
      await symlink(nixTarget, rcPath);

      // First install
      const result1 = await ensureReplitShellHook(makeSink());
      assert.equal(result1.installed, true);
      const content1 = await readFile(rcPath, 'utf8');

      // Second install
      const result2 = await ensureReplitShellHook(makeSink());
      assert.equal(result2.installed, true);
      assert.equal(result2.changed, false, 'second install must report no change');

      const content2 = await readFile(rcPath, 'utf8');
      assert.equal(content2, content1, 'content must be byte-identical after second install');
    });
  });

  it('uninstall restores the symlink', { skip: process.platform === 'win32' }, async () => {
    await withReplitEnv(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const nixDir = join(tempHome, 'nix', 'store', 'abc123-replit-bashrc');
      await mkdir(nixDir, { recursive: true });
      const nixTarget = join(nixDir, 'bashrc');
      await writeFile(nixTarget, '# original Replit bashrc\n');
      await symlink(nixTarget, rcPath);

      // Install
      const installResult = await ensureReplitShellHook(makeSink());
      assert.equal(installResult.installed, true);

      // Verify it's a regular file now
      const stAfterInstall = await lstat(rcPath);
      assert.equal(stAfterInstall.isFile(), true);

      // Uninstall
      const uninstallResult = await ensureReplitShellHook(makeSink(), { uninstall: true });
      assert.equal(uninstallResult.ok, true);
      assert.equal(uninstallResult.restored, true);

      // Verify symlink is restored
      const stAfterUninstall = await lstat(rcPath);
      assert.equal(stAfterUninstall.isSymbolicLink(), true, 'must restore symlink');

      const resolved = await realpath(rcPath);
      assert.equal(resolved, nixTarget, 'symlink must point to original target');

      // Verify original target is untouched
      const originalContent = await readFile(nixTarget, 'utf8');
      assert.equal(originalContent, '# original Replit bashrc\n', 'original target must be unchanged');
    });
  });

  it('uninstall on already-symlink is a no-op success', { skip: process.platform === 'win32' }, async () => {
    await withReplitEnv(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const nixDir = join(tempHome, 'nix', 'store', 'abc123-replit-bashrc');
      await mkdir(nixDir, { recursive: true });
      const nixTarget = join(nixDir, 'bashrc');
      await writeFile(nixTarget, '# original\n');
      await symlink(nixTarget, rcPath);

      // Uninstall without installing first
      const result = await ensureReplitShellHook(makeSink(), { uninstall: true });
      assert.equal(result.ok, true);
      assert.equal(result.changed, false);

      // Symlink must still be intact
      const st = await lstat(rcPath);
      assert.equal(st.isSymbolicLink(), true);
    });
  });

  it('regular unwrapped .bashrc on Replit falls through (not handled by wrapper)', async () => {
    await withReplitEnv(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      await writeFile(rcPath, '# user-owned bashrc\n');

      const result = await ensureReplitShellHook(makeSink());
      assert.equal(result.ok, true);
      assert.equal(result.changed, false);
      assert.equal(result.installed, false);
      assert.equal(result.reason, 'regular unwrapped bashrc');

      // Content must be untouched
      const content = await readFile(rcPath, 'utf8');
      assert.equal(content, '# user-owned bashrc\n');
    });
  });

  it('reports failure when wrapped bashrc is missing original target metadata', { skip: process.platform === 'win32' }, async () => {
    await withReplitEnv(async (tempHome) => {
      const rcPath = join(tempHome, '.bashrc');
      const nixDir = join(tempHome, 'nix', 'store', 'abc123-replit-bashrc');
      await mkdir(nixDir, { recursive: true });
      const nixTarget = join(nixDir, 'bashrc');
      await writeFile(nixTarget, '# original\n');
      await symlink(nixTarget, rcPath);

      // Install first
      await ensureReplitShellHook(makeSink());

      // Corrupt the wrapper — remove the original target metadata line
      let content = await readFile(rcPath, 'utf8');
      const prefix = '# myshell-tools-replit-original-bashrc: ';
      const prefixIdx = content.indexOf(prefix);
      if (prefixIdx !== -1) {
        const newlineIdx = content.indexOf('\n', prefixIdx);
        content = content.slice(0, prefixIdx) + content.slice(newlineIdx + 1);
        await writeFile(rcPath, content);
      }

      const result = await ensureReplitShellHook(makeSink());
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'wrapped bashrc is missing original target metadata');
    });
  });
});