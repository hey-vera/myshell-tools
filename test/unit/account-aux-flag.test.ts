/**
 * test/unit/account-aux-flag.test.ts — pure-helper unit tests for
 * src/interface/ui/account-aux-flag.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { accountAuxEnabled } from '../../src/interface/ui/account-aux-flag.ts';

describe('accountAuxEnabled', () => {
  it('absent env returns false', () => {
    assert.equal(accountAuxEnabled(undefined), false);
    assert.equal(accountAuxEnabled({}), false);
  });

  it('accepts trimmed case-insensitive opt-in values', () => {
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: '1' }), true);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'true' }), true);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'on' }), true);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'yes' }), true);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: ' TRUE ' }), true);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'On' }), true);
  });

  it('returns false for opt-out and ambiguous values', () => {
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: '0' }), false);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'false' }), false);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'off' }), false);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'no' }), false);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: '' }), false);
    assert.equal(accountAuxEnabled({ MYSHELL_ACCOUNT_AUX: 'garbage' }), false);
  });

  it('never throws and defaults false on hostile env', () => {
    const hostile = { get MYSHELL_ACCOUNT_AUX() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(accountAuxEnabled(hostile), false);
  });
});
