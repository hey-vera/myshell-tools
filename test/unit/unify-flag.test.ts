/**
 * test/unit/unify-flag.test.ts — the rank-7 unified-preflight gate reader
 * (preflightUnifyEnabled, in core/router.ts). DEFAULT OFF; mirrors judgment-flag.ts
 * exactly. Truth table: env ∈ {1,true,on,yes} (trimmed, case-insensitive) OR
 * config.experimentalUnifyPreflight === true → true; everything else → false; never
 * throws. Pure — no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { preflightUnifyEnabled } from '../../src/core/router.ts';

const KEY = 'MYSHELL_UNIFY_PREFLIGHT';

describe('preflightUnifyEnabled', () => {
  it('defaults OFF: no env, no config', () => {
    assert.equal(preflightUnifyEnabled(undefined, undefined), false);
    assert.equal(preflightUnifyEnabled({}, {}), false);
  });

  it('true for each accepted env value (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ', 'YES']) {
      assert.equal(preflightUnifyEnabled({ [KEY]: v }, undefined), true, `env=${JSON.stringify(v)}`);
    }
  });

  it('true when config.experimentalUnifyPreflight === true', () => {
    assert.equal(preflightUnifyEnabled(undefined, { experimentalUnifyPreflight: true }), true);
    assert.equal(preflightUnifyEnabled({}, { experimentalUnifyPreflight: true }), true);
  });

  it('false for disabling / garbage env values', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '  ', 'enabled', 'maybe', '2']) {
      assert.equal(preflightUnifyEnabled({ [KEY]: v }, undefined), false, `env=${JSON.stringify(v)}`);
    }
  });

  it('false when config flag is explicitly false or absent', () => {
    assert.equal(preflightUnifyEnabled({}, { experimentalUnifyPreflight: false }), false);
    assert.equal(preflightUnifyEnabled({}, {}), false);
  });

  it('env opt-in wins even when config is false', () => {
    assert.equal(
      preflightUnifyEnabled({ [KEY]: 'yes' }, { experimentalUnifyPreflight: false }),
      true,
    );
  });
});
