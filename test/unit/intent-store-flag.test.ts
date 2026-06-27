/**
 * test/unit/intent-store-flag.test.ts — pure-helper unit tests for
 * src/interface/ui/intent-store-flag.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { intentStoreV1Enabled } from '../../src/interface/ui/intent-store-flag.ts';

describe('intentStoreV1Enabled', () => {
  it('absent env returns false', () => {
    assert.equal(intentStoreV1Enabled(undefined), false);
    assert.equal(intentStoreV1Enabled({}), false);
  });

  it('accepts trimmed case-insensitive opt-in values', () => {
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: '1' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'true' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'on' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'yes' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: ' TRUE ' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'On' }), true);
  });

  it('returns false for opt-out and ambiguous values', () => {
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: '0' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'false' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'off' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'no' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: '' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'garbage' }), false);
  });

  it('never throws and defaults false on hostile env', () => {
    const hostile = { get MYSHELL_INTENT_STORE_V1() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(intentStoreV1Enabled(hostile), false);
  });
});
