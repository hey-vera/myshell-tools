/**
 * test/unit/experimental-default.test.ts — the composition-root default-ON resolver.
 *
 * Proves the full truth table for `experimentalEnabledByDefault`, which COMPOSES a
 * subsystem's own pure opt-IN helper (governorEnabled/verifyEnabled/…) with the global
 * basic-mode switch:
 *
 *   1. nothing set (absent)                         ⇒ ON  (frictionless default)
 *   2. explicit per-feature opt-IN                  ⇒ ON  — even when basic mode is set
 *      (env ∈ {1,true,on,yes} OR config.experimentalX===true), per-feature override
 *   3. explicit per-feature opt-OUT                 ⇒ OFF
 *      (env ∈ {0,false,off,no} OR config.experimentalX===false)
 *   4. global basic mode set, X not opted-in        ⇒ OFF
 *
 * Never throws (default-on → true on hostile input).
 *
 * The resolver CONSUMES the real per-feature helpers (no fake), so the helpers stay
 * genuinely production-used and the no-orphan arch guard holds without any exemption.
 * Those helpers keep their own opt-IN semantics, exercised by their dedicated unit
 * tests + the flag-off neutrality suites; this module flips only the boolean SOURCE
 * used at the menu wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  experimentalEnabledByDefault,
  basicModeEnabled,
} from '../../src/interface/ui/experimental-default.ts';
import { governorEnabled } from '../../src/interface/ui/governor-flag.ts';
import { verifyEnabled } from '../../src/interface/ui/verify-flag.ts';
import { trustEnabled } from '../../src/interface/ui/trust-flag.ts';
import { tribunalEnabled } from '../../src/interface/ui/tribunal-flag.ts';
import { tasteEnabled } from '../../src/core/taste-flag.ts';
import { judgmentEnabled } from '../../src/core/judgment-flag.ts';

type OptIn = (
  env: NodeJS.ProcessEnv | undefined,
  config: Record<string, boolean | undefined> | undefined,
) => boolean;

// Each subsystem: its env key, its config key, and its REAL pure opt-in helper. The
// resolver is exercised against the genuine helpers (the production wiring), not a stub.
const SUBSYSTEMS: ReadonlyArray<{
  readonly envKey: string;
  readonly configKey: string;
  readonly optIn: OptIn;
}> = [
  { envKey: 'MYSHELL_GOVERNOR', configKey: 'experimentalGovernor', optIn: governorEnabled },
  { envKey: 'MYSHELL_VERIFY', configKey: 'experimentalVerify', optIn: verifyEnabled },
  { envKey: 'MYSHELL_TASTE', configKey: 'experimentalTaste', optIn: tasteEnabled },
  { envKey: 'MYSHELL_JUDGMENT', configKey: 'experimentalJudgment', optIn: judgmentEnabled },
  { envKey: 'MYSHELL_TRUST', configKey: 'experimentalTrust', optIn: trustEnabled },
  { envKey: 'MYSHELL_TRIBUNAL', configKey: 'experimentalTribunal', optIn: tribunalEnabled },
];

describe('experimentalEnabledByDefault — DEFAULT ON, composing the real opt-in helper', () => {
  it('1. absent env + absent config ⇒ true (intelligence on by default)', () => {
    for (const { envKey, optIn } of SUBSYSTEMS) {
      assert.equal(experimentalEnabledByDefault(undefined, undefined, envKey, undefined, optIn), true, envKey);
      assert.equal(experimentalEnabledByDefault({}, {}, envKey, undefined, optIn), true, envKey);
    }
  });

  it('2. explicit per-feature env opt-in ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      for (const { envKey, optIn } of SUBSYSTEMS) {
        assert.equal(experimentalEnabledByDefault({ [envKey]: v }, undefined, envKey, undefined, optIn), true, `${envKey}=${v}`);
      }
    }
  });

  it('2. explicit per-feature config opt-in (===true) ⇒ true', () => {
    for (const { envKey, configKey, optIn } of SUBSYSTEMS) {
      assert.equal(
        experimentalEnabledByDefault({}, { [configKey]: true } as Record<string, boolean>, envKey, true, optIn),
        true,
        envKey,
      );
    }
  });

  it('2. per-feature OPT-IN OVERRIDES basic mode (env opt-in wins over MYSHELL_BASIC)', () => {
    for (const { envKey, optIn } of SUBSYSTEMS) {
      assert.equal(
        experimentalEnabledByDefault({ MYSHELL_BASIC: '1', [envKey]: '1' }, undefined, envKey, undefined, optIn),
        true,
        `basic+${envKey}=1`,
      );
    }
  });

  it('2. per-feature OPT-IN OVERRIDES basic mode (config opt-in wins over config.experimentalBasic)', () => {
    for (const { envKey, configKey, optIn } of SUBSYSTEMS) {
      assert.equal(
        experimentalEnabledByDefault(
          {},
          { experimentalBasic: true, [configKey]: true } as Record<string, boolean>,
          envKey,
          true,
          optIn,
        ),
        true,
        `basic+${configKey}`,
      );
    }
  });

  it('3. explicit per-feature env opt-out ⇒ false (case-insensitive, trimmed)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
      for (const { envKey, optIn } of SUBSYSTEMS) {
        assert.equal(experimentalEnabledByDefault({ [envKey]: v }, undefined, envKey, undefined, optIn), false, `${envKey}=${v}`);
      }
    }
  });

  it('3. explicit per-feature config opt-out (===false) ⇒ false', () => {
    for (const { envKey, optIn } of SUBSYSTEMS) {
      assert.equal(experimentalEnabledByDefault({}, undefined, envKey, false, optIn), false, envKey);
    }
  });

  it('4. MYSHELL_BASIC truthy (not opted-in) ⇒ false (global escape hatch)', () => {
    for (const b of ['1', 'true', 'on', 'yes', ' TRUE ']) {
      for (const { envKey, optIn } of SUBSYSTEMS) {
        assert.equal(
          experimentalEnabledByDefault({ MYSHELL_BASIC: b }, undefined, envKey, undefined, optIn),
          false,
          `basic=${b} ${envKey}`,
        );
      }
    }
  });

  it('4. config.experimentalBasic===true (not opted-in) ⇒ false (global escape hatch)', () => {
    for (const { envKey, optIn } of SUBSYSTEMS) {
      assert.equal(
        experimentalEnabledByDefault({}, { experimentalBasic: true }, envKey, undefined, optIn),
        false,
        envKey,
      );
    }
  });

  it('unrelated env values (not opt-in/out) still ⇒ true (default-on respected)', () => {
    for (const { envKey, optIn } of SUBSYSTEMS) {
      assert.equal(experimentalEnabledByDefault({ [envKey]: '' }, undefined, envKey, undefined, optIn), true, envKey);
    }
  });

  it('never throws on hostile input (default-on ⇒ true)', () => {
    const throwingHelper: OptIn = () => {
      throw new Error('boom');
    };
    for (const { envKey, optIn } of SUBSYSTEMS) {
      assert.equal(experimentalEnabledByDefault({ [envKey]: undefined }, undefined, envKey, undefined, optIn), true, envKey);
    }
    // A helper that throws is swallowed → default ON.
    assert.equal(experimentalEnabledByDefault({}, undefined, 'MYSHELL_GOVERNOR', undefined, throwingHelper), true);
  });
});

describe('basicModeEnabled — the global plain-mode switch', () => {
  it('absent ⇒ false (full intelligence)', () => {
    assert.equal(basicModeEnabled(undefined, undefined), false);
    assert.equal(basicModeEnabled({}, {}), false);
  });

  it('MYSHELL_BASIC truthy ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' On ']) {
      assert.equal(basicModeEnabled({ MYSHELL_BASIC: v }, undefined), true, v);
    }
  });

  it('falsey / unknown MYSHELL_BASIC ⇒ false', () => {
    for (const v of ['0', 'false', 'off', 'no', '', 'nope']) {
      assert.equal(basicModeEnabled({ MYSHELL_BASIC: v }, undefined), false, v);
    }
  });

  it('config.experimentalBasic toggles directly', () => {
    assert.equal(basicModeEnabled({}, { experimentalBasic: true }), true);
    assert.equal(basicModeEnabled({}, { experimentalBasic: false }), false);
  });
});
