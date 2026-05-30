/**
 * test/unit/install.test.ts — unit tests for src/providers/install.ts.
 *
 * Only the pure, hermetic helper is tested here.  The `installProvider`
 * function spawns `npm install -g`, which we do NOT run in unit tests —
 * that would be slow, side-effectful, and would actually modify the user's
 * global node_modules.  Integration coverage of the spawn path is out of
 * scope for this suite.
 *
 * Honesty Contract: no Math.random, no fabricated data, no digit-% literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installCommandFor } from '../../src/providers/install.ts';

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
