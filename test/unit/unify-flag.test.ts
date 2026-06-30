/**
 * test/unit/unify-flag.test.ts — the rank-7 unified-preflight gate reader
 * (preflightUnifyEnabled, in core/router.ts). DEFAULT OFF; mirrors judgment-flag.ts
 * exactly. Truth table: env ∈ {1,true,on,yes} (trimmed, case-insensitive) OR
 * config.experimentalUnifyPreflight === true → true; everything else → false; never
 * throws. Pure — no I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  preflightUnifyEnabled,
  preflightRiskSignalsEnabled,
  preflightRequiredInvestigationEnabled,
} from '../../src/core/router.ts';

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

const RKEY = 'MYSHELL_RISK_SIGNALS';
const RIKEY = 'MYSHELL_REQUIRED_INVESTIGATION';

describe('preflightRiskSignalsEnabled', () => {
  it('defaults OFF: no env, no config', () => {
    assert.equal(preflightRiskSignalsEnabled(undefined, undefined), false);
    assert.equal(preflightRiskSignalsEnabled({}, {}), false);
  });

  it('true for each accepted env value (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' on ']) {
      assert.equal(
        preflightRiskSignalsEnabled({ [RKEY]: v }, undefined),
        true,
        `env=${JSON.stringify(v)}`,
      );
    }
  });

  it('true when config.experimentalRiskSignals === true', () => {
    assert.equal(preflightRiskSignalsEnabled(undefined, { experimentalRiskSignals: true }), true);
    assert.equal(preflightRiskSignalsEnabled({}, { experimentalRiskSignals: true }), true);
  });

  it('false for disabling / garbage env values', () => {
    for (const v of ['0', 'false', '', 'garbage', 'off', 'no', '2']) {
      assert.equal(
        preflightRiskSignalsEnabled({ [RKEY]: v }, undefined),
        false,
        `env=${JSON.stringify(v)}`,
      );
    }
  });

  it('false when config flag is explicitly false or absent', () => {
    assert.equal(preflightRiskSignalsEnabled({}, { experimentalRiskSignals: false }), false);
    assert.equal(preflightRiskSignalsEnabled({}, {}), false);
  });

  it('env opt-in wins even when config is false', () => {
    assert.equal(
      preflightRiskSignalsEnabled({ [RKEY]: 'yes' }, { experimentalRiskSignals: false }),
      true,
    );
  });

  it('never throws when the env getter itself throws', () => {
    const throwingEnv = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    ) as NodeJS.ProcessEnv;
    assert.doesNotThrow(() => preflightRiskSignalsEnabled(throwingEnv, undefined));
    assert.equal(preflightRiskSignalsEnabled(throwingEnv, undefined), false);
  });
});

describe('preflightRequiredInvestigationEnabled', () => {
  it('defaults OFF: no env, no config', () => {
    assert.equal(preflightRequiredInvestigationEnabled(undefined, undefined), false);
    assert.equal(preflightRequiredInvestigationEnabled({}, {}), false);
  });

  it('true for each accepted env value (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', ' On ', 'YES']) {
      assert.equal(
        preflightRequiredInvestigationEnabled({ [RIKEY]: v }, undefined),
        true,
        `env=${JSON.stringify(v)}`,
      );
    }
  });

  it('true when config.experimentalRequiredInvestigation === true', () => {
    assert.equal(
      preflightRequiredInvestigationEnabled(undefined, { experimentalRequiredInvestigation: true }),
      true,
    );
    assert.equal(
      preflightRequiredInvestigationEnabled({}, { experimentalRequiredInvestigation: true }),
      true,
    );
  });

  it('false for disabling / garbage env values', () => {
    for (const v of ['0', 'false', '', 'garbage', 'off', 'no', '2']) {
      assert.equal(
        preflightRequiredInvestigationEnabled({ [RIKEY]: v }, undefined),
        false,
        `env=${JSON.stringify(v)}`,
      );
    }
  });

  it('false when config flag is explicitly false or absent', () => {
    assert.equal(
      preflightRequiredInvestigationEnabled({}, { experimentalRequiredInvestigation: false }),
      false,
    );
    assert.equal(preflightRequiredInvestigationEnabled({}, {}), false);
  });

  it('env opt-in wins even when config is false', () => {
    assert.equal(
      preflightRequiredInvestigationEnabled(
        { [RIKEY]: 'yes' },
        { experimentalRequiredInvestigation: false },
      ),
      true,
    );
  });

  it('never throws when the env getter itself throws', () => {
    const throwingEnv = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    ) as NodeJS.ProcessEnv;
    assert.doesNotThrow(() => preflightRequiredInvestigationEnabled(throwingEnv, undefined));
    assert.equal(preflightRequiredInvestigationEnabled(throwingEnv, undefined), false);
  });
});
