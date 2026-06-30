import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { correctionForkV1Enabled } from '../../src/interface/ui/correction-fork-flag.ts';

describe('correctionForkV1Enabled', () => {
  it('defaults true', () => {
    assert.equal(correctionForkV1Enabled(undefined), true);
    assert.equal(correctionForkV1Enabled({}), true);
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
  });

  it('returns true for empty and ambiguous values', () => {
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: '' }), true);
    assert.equal(correctionForkV1Enabled({ MYSHELL_CORRECTION_FORK_V1: 'garbage' }), true);
  });

  it('returns true for hostile env access', () => {
    const hostile = { get MYSHELL_CORRECTION_FORK_V1() { throw new Error('boom'); } } as NodeJS.ProcessEnv;
    assert.equal(correctionForkV1Enabled(hostile), true);
  });
});
