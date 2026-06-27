import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  nativeSessionsPromoteEnabled,
  nativeSessionsEffectiveEnabled,
} from '../../src/interface/ui/native-sessions-promote-flag.ts';

describe('nativeSessionsPromoteEnabled', () => {
  it('absent env returns false', () => {
    assert.equal(nativeSessionsPromoteEnabled(undefined), false);
    assert.equal(nativeSessionsPromoteEnabled({}), false);
  });

  it('accepts opt-in values', () => {
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: '1' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'true' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'on' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'yes' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: ' TRUE ' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'On' }), true);
  });

  it('rejects off and ambiguous values', () => {
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: '0' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'false' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'off' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'no' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: '' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'garbage' }), false);
  });
});

describe('nativeSessionsEffectiveEnabled', () => {
  it('preserves config nativeSessions and adds promotion', () => {
    // Both off
    assert.equal(nativeSessionsEffectiveEnabled({ promoted: false }), false);
    // Config on
    assert.equal(nativeSessionsEffectiveEnabled({ configNativeSessions: true, promoted: false }), true);
    // Promoted on
    assert.equal(nativeSessionsEffectiveEnabled({ configNativeSessions: false, promoted: true }), true);
    // Both on
    assert.equal(nativeSessionsEffectiveEnabled({ configNativeSessions: true, promoted: true }), true);
  });
});
