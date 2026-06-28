import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { blockedStateV1Enabled } from '../../src/interface/ui/blocked-state-flag.ts';

describe('blockedStateV1Enabled', () => {
  it('defaults true', () => {
    assert.equal(blockedStateV1Enabled(undefined), true);
    assert.equal(blockedStateV1Enabled({}), true);
  });

  it('accepts explicit on values', () => {
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: '1' }), true);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'true' }), true);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'on' }), true);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'yes' }), true);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: ' TRUE ' }), true);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'On' }), true);
  });

  it('treats explicit off values as false', () => {
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: '0' }), false);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'false' }), false);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'off' }), false);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'no' }), false);
  });

  it('returns true for empty and ambiguous values', () => {
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: '' }), true);
    assert.equal(blockedStateV1Enabled({ MYSHELL_BLOCKED_STATE_V1: 'garbage' }), true);
  });

  it('returns true for hostile env access', () => {
    const hostile = { get MYSHELL_BLOCKED_STATE_V1() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(blockedStateV1Enabled(hostile), true);
  });
});
