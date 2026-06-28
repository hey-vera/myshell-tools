/**
 * test/unit/intent-store-flag.test.ts — pure-helper unit tests for
 * src/interface/ui/intent-store-flag.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { intentStoreV1Enabled } from '../../src/interface/ui/intent-store-flag.ts';

describe('intentStoreV1Enabled', () => {
  it('absent env returns true (default on)', () => {
    assert.equal(intentStoreV1Enabled(undefined), true);
    assert.equal(intentStoreV1Enabled({}), true);
  });

  it('accepts trimmed case-insensitive opt-in values', () => {
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: '1' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'true' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'on' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'yes' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: ' TRUE ' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'On' }), true);
  });

  it('returns false only for explicit opt-out values', () => {
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: '0' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'false' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'off' }), false);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'no' }), false);
  });

  it('returns true for empty and ambiguous values', () => {
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: '' }), true);
    assert.equal(intentStoreV1Enabled({ MYSHELL_INTENT_STORE_V1: 'garbage' }), true);
  });

  it('never throws and defaults true on hostile env', () => {
    const hostile = { get MYSHELL_INTENT_STORE_V1() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(intentStoreV1Enabled(hostile), true);
  });
});
