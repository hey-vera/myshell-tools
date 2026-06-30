/**
 * test/unit/role-flag.test.ts — the DEFAULT-OFF / explicit-opt-IN contract for the
 * logical ROLE abstraction (redesign Phase 0, slice 1). env OR config, default
 * FALSE, rollback forces off, never throws. Mirrors the verify/governor flag shape.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { roleMappingEnabled } from '../../src/interface/ui/role-flag.ts';

describe('roleMappingEnabled — default OFF, explicit opt-IN via env or config', () => {
  it('absent env + absent config ⇒ false (scaffolding is off by default)', () => {
    assert.equal(roleMappingEnabled(undefined, undefined), false);
    assert.equal(roleMappingEnabled({}, {}), false);
  });

  it('explicit env opt-IN ⇒ true (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(roleMappingEnabled({ MYSHELL_ROLES: v }, undefined), true, `MYSHELL_ROLES=${v}`);
    }
  });

  it('config opt-IN (experimentalRoles === true) ⇒ true', () => {
    assert.equal(roleMappingEnabled({}, { experimentalRoles: true }), true);
  });

  it('ambiguous / opt-out env values ⇒ false (default holds)', () => {
    for (const v of ['0', 'false', 'off', 'no', '', '   ', 'maybe']) {
      assert.equal(
        roleMappingEnabled({ MYSHELL_ROLES: v }, undefined),
        false,
        `MYSHELL_ROLES=${v}`,
      );
    }
  });

  it('rollback forces it OFF even with an opt-in', () => {
    assert.equal(roleMappingEnabled({ MYSHELL_ROLES: '1' }, { rollback: true }), false);
    assert.equal(roleMappingEnabled({}, { experimentalRoles: true, rollback: true }), false);
    assert.equal(
      roleMappingEnabled({ MYSHELL_ROLLBACK: '1', MYSHELL_ROLES: '1' }, undefined),
      false,
    );
  });

  it('never throws on a hostile env bag (defaults OFF)', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    ) as NodeJS.ProcessEnv;
    assert.equal(roleMappingEnabled(hostile, undefined), false);
  });
});
