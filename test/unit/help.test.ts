/**
 * test/unit/help.test.ts — unit tests for per-command help text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { commandHelpText } from '../../src/ui/help.ts';

describe('commandHelpText', () => {
  it('returns focused help for login that explains the sign-in methods', () => {
    const help = commandHelpText('login');
    assert.ok(help !== null);
    assert.ok(help.includes('--code'), 'login help mentions --code');
    assert.ok(help.includes('--browser'), 'login help mentions --browser');
    assert.ok(help.toLowerCase().includes('oauth') || help.toLowerCase().includes('sign in'));
  });

  it('returns cost help that is honest about subscription vs API billing', () => {
    const help = commandHelpText('cost');
    assert.ok(help !== null);
    assert.ok(/subscription/i.test(help), 'cost help mentions subscription');
    assert.ok(/token/i.test(help), 'cost help leads with tokens');
  });

  it('returns the same health help for the status/check/doctor aliases', () => {
    for (const alias of ['status', 'check', 'doctor']) {
      const help = commandHelpText(alias);
      assert.ok(help !== null, `${alias} should have help`);
      assert.ok(help.includes('--fix'), `${alias} help mentions --fix`);
      assert.ok(help.startsWith(`myshell-tools ${alias}`), `${alias} help names itself`);
    }
  });

  it('covers run, install, uninstall, repl', () => {
    for (const cmd of ['run', 'install', 'uninstall', 'repl', 'rollback']) {
      assert.ok(commandHelpText(cmd) !== null, `${cmd} should have focused help`);
    }
  });

  it('describes rollback scope and rejects workspace undo claims', () => {
    const help = commandHelpText('rollback');
    assert.ok(help !== null);
    assert.match(help, /verify, judgment, and trust/);
    assert.match(help, /Governor, taste, and tribunal are not changed/);
    assert.match(help, /does not revert files or undo workspace changes/);
  });

  it('returns null for unknown commands (caller falls back to global help)', () => {
    assert.strictEqual(commandHelpText('frobnicate'), null);
    assert.strictEqual(commandHelpText(''), null);
  });

  it('every help block ends with a trailing newline and has no ANSI codes', () => {
    for (const cmd of ['login', 'cost', 'run', 'status', 'install', 'uninstall', 'repl', 'rollback']) {
      const help = commandHelpText(cmd);
      assert.ok(help !== null);
      assert.ok(help.endsWith('\n'), `${cmd} help ends with newline`);
      assert.ok(!/\x1b\[/.test(help), `${cmd} help has no ANSI codes`);
    }
  });
});
