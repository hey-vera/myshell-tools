import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { correctionForkV1Enabled } from '../../src/interface/ui/correction-fork-flag.ts';

describe('correctionForkV1Enabled', () => {
  it('defaults false', () => {
    assert.equal(correctionForkV1Enabled(undefined), false);
    assert.equal(correctionForkV1Enabled({}), false);
  });

  it('accepts explicit on values', () => {
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: '1' }), true);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'true' }), true);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'on' }), true);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'yes' }), true);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: ' TRUE ' }), true);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'On' }), true);
  });

  it('treats explicit off values as false', () => {
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: '0' }), false);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'false' }), false);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'off' }), false);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'no' }), false);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: '' }), false);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'garbage' }), false);
  });

  it('returns false for hostile env access', () => {
    const hostile = { get MYSHELL_CORRECTION_FORK_V1() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(correctionForkV1Enabled(hostile), false);
  });
});
