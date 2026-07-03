/**
 * test/unit/rollback-flag.test.ts — the rollback kill-switch contract. When engaged,
 * verify/judgment/trust are forced off regardless of their own env/config opt-ins
 * (now removed — these features are unconditional, gated only by rollback).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { rollbackEngaged } from '../../src/core/rollback-flag.ts';

describe('rollbackEngaged — default OFF, explicit opt-IN via env', () => {
  it('absent env ⇒ false (rollback itself ships dark)', () => {
    assert.equal(rollbackEngaged(undefined), false);
    assert.equal(rollbackEngaged({}), false);
  });

  it('explicit env opt-IN ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(rollbackEngaged({ MYSHELL_ROLLBACK: v }), true, `MYSHELL_ROLLBACK=${v}`);
    }
  });

  it('ambiguous / off values ⇒ false (default holds)', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(rollbackEngaged({ MYSHELL_ROLLBACK: v }), false, `MYSHELL_ROLLBACK=${v}`);
    }
  });

  it('persisted config engages rollback while absent/false stays off', () => {
    assert.equal(rollbackEngaged({}, { rollback: true }), true);
    assert.equal(rollbackEngaged({}, { rollback: false }), false);
    assert.equal(rollbackEngaged({}, {}), false);
  });

  it('never throws on a hostile env bag (defaults OFF)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as Record<string, string | undefined>;
    assert.equal(rollbackEngaged(hostile), false);
    assert.equal(rollbackEngaged(hostile, { rollback: true }), true);
  });
});

describe('rollback kill-switch — verify/trust/judgment are unconditional, gated only by rollback', () => {
  it('MYSHELL_ROLLBACK=1 forces features off', () => {
    const env = {
      MYSHELL_ROLLBACK: '1',
    };
    assert.equal(rollbackEngaged(env, undefined), true);
  });

  it('without rollback, features are on (unconditional)', () => {
    assert.equal(rollbackEngaged(undefined, undefined), false);
    assert.equal(rollbackEngaged({}, {}), false);
  });
});
