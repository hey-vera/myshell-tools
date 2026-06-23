/**
 * test/unit/rollback-flag.test.ts — the DEFAULT-OFF / explicit-opt-IN contract for
 * the unified rollback kill-switch. When engaged, canaried experimental flags are
 * forced off regardless of their own env/config opt-ins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rollbackEngaged } from '../../src/core/rollback-flag.ts';
import { judgmentEnabled } from '../../src/core/judgment-flag.ts';
import { trustEnabled } from '../../src/interface/ui/trust-flag.ts';
import { verifyEnabled } from '../../src/interface/ui/verify-flag.ts';

describe('rollbackEngaged — default OFF, explicit opt-IN via env', () => {
  it('absent env ⇒ false (ships dark)', () => {
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

  it('never throws on a hostile env bag (defaults OFF)', () => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } }) as Record<string, string | undefined>;
    assert.equal(rollbackEngaged(hostile), false);
  });
});

describe('rollback kill-switch — forces canaried experimental flags off', () => {
  it('MYSHELL_ROLLBACK=1 overrides individual env opt-ins', () => {
    const env = {
      MYSHELL_ROLLBACK: '1',
      MYSHELL_VERIFY: '1',
      MYSHELL_JUDGMENT: '1',
      MYSHELL_TRUST: '1',
    };

    assert.equal(verifyEnabled(env, undefined), false);
    assert.equal(judgmentEnabled(env, undefined), false);
    assert.equal(trustEnabled(env, undefined), false);
  });

  it('MYSHELL_ROLLBACK=1 overrides individual config opt-ins', () => {
    const env = { MYSHELL_ROLLBACK: '1' };

    assert.equal(verifyEnabled(env, { experimentalVerify: true }), false);
    assert.equal(judgmentEnabled(env, { experimentalJudgment: true }), false);
    assert.equal(trustEnabled(env, { experimentalTrust: true }), false);
  });

  it('without rollback, individual env opt-ins are unchanged', () => {
    assert.equal(verifyEnabled({ MYSHELL_VERIFY: '1' }, undefined), true);
    assert.equal(judgmentEnabled({ MYSHELL_JUDGMENT: '1' }, undefined), true);
    assert.equal(trustEnabled({ MYSHELL_TRUST: '1' }, undefined), true);
  });

  it('without rollback, individual config opt-ins are unchanged', () => {
    assert.equal(verifyEnabled({}, { experimentalVerify: true }), true);
    assert.equal(judgmentEnabled({}, { experimentalJudgment: true }), true);
    assert.equal(trustEnabled({}, { experimentalTrust: true }), true);
  });
});
