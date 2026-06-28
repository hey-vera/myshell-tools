import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  nativeSessionsPromoteEnabled,
  nativeSessionsEffectiveEnabled,
} from '../../src/interface/ui/native-sessions-promote-flag.ts';

describe('nativeSessionsPromoteEnabled', () => {
  it('absent env returns true (default on)', () => {
    assert.equal(nativeSessionsPromoteEnabled(undefined), true);
    assert.equal(nativeSessionsPromoteEnabled({}), true);
  });

  it('accepts opt-in values', () => {
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: '1' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'true' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'on' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'yes' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: ' TRUE ' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'On' }), true);
  });

  it('rejects only explicit off values', () => {
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: '0' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'false' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'off' }), false);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'no' }), false);
  });

  it('returns true for empty and ambiguous values', () => {
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: '' }), true);
    assert.equal(nativeSessionsPromoteEnabled({ MYSHELL_NATIVE_SESSIONS_PROMOTE: 'garbage' }), true);
  });
});

describe('nativeSessionsEffectiveEnabled', () => {
  it('preserves config nativeSessions and adds promotion', () => {
    // Both off (no config, promoted false — but promoted false requires explicit opt-out)
    assert.equal(nativeSessionsEffectiveEnabled({ promoted: false }), false);
    // Config on
    assert.equal(nativeSessionsEffectiveEnabled({ configNativeSessions: true, promoted: false }), true);
    // Promoted on
    assert.equal(nativeSessionsEffectiveEnabled({ configNativeSessions: false, promoted: true }), true);
    // Both on
    assert.equal(nativeSessionsEffectiveEnabled({ configNativeSessions: true, promoted: true }), true);
  });
});
