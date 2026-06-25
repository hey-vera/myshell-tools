/**
 * test/unit/provider-effort-flag.test.ts — unit tests for the
 * providerEffortEnabled() predicate (MYSHELL_PROVIDER_EFFORT gate).
 * Pure: no spawn, no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { providerEffortEnabled } from '../../src/providers/provider-effort-flag.ts';

describe('providerEffortEnabled', () => {
  // ---- Default OFF -----------------------------------------------------------

  it('returns false when both env and config are absent (default off)', () => {
    assert.strictEqual(providerEffortEnabled(undefined, undefined), false);
  });

  it('returns false when env is empty object and config is absent', () => {
    assert.strictEqual(providerEffortEnabled({}, undefined), false);
  });

  it('returns false when MYSHELL_PROVIDER_EFFORT is absent', () => {
    assert.strictEqual(providerEffortEnabled({ OTHER: '1' }, undefined), false);
  });

  it('returns false when config.experimentalProviderEffort is absent', () => {
    assert.strictEqual(providerEffortEnabled({}, {}), false);
  });

  // ---- Env var opt-in --------------------------------------------------------

  it('returns true when MYSHELL_PROVIDER_EFFORT=1', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: '1' }, undefined), true);
  });

  it('returns true when MYSHELL_PROVIDER_EFFORT=true', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'true' }, undefined), true);
  });

  it('returns true when MYSHELL_PROVIDER_EFFORT=on', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'on' }, undefined), true);
  });

  it('returns true when MYSHELL_PROVIDER_EFFORT=yes', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'yes' }, undefined), true);
  });

  it('is case-insensitive for the env var value', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'TRUE' }, undefined), true);
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'ON' }, undefined), true);
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'YES' }, undefined), true);
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'True' }, undefined), true);
  });

  it('trims whitespace from the env var value', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: ' 1 ' }, undefined), true);
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: ' true ' }, undefined), true);
  });

  // ---- Env var opt-out values (return false) ---------------------------------

  it('returns false when MYSHELL_PROVIDER_EFFORT=0', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: '0' }, undefined), false);
  });

  it('returns false when MYSHELL_PROVIDER_EFFORT=false', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'false' }, undefined), false);
  });

  it('returns false when MYSHELL_PROVIDER_EFFORT=off', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'off' }, undefined), false);
  });

  it('returns false when MYSHELL_PROVIDER_EFFORT is an empty string', () => {
    assert.strictEqual(providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: '' }, undefined), false);
  });

  // ---- Config opt-in ---------------------------------------------------------

  it('returns true when config.experimentalProviderEffort === true', () => {
    assert.strictEqual(providerEffortEnabled(undefined, { experimentalProviderEffort: true }), true);
  });

  it('returns true when config.experimentalProviderEffort === true and no env var', () => {
    assert.strictEqual(providerEffortEnabled({}, { experimentalProviderEffort: true }), true);
  });

  // ---- Config false explicitly -----------------------------------------------

  it('returns false when config.experimentalProviderEffort === false', () => {
    assert.strictEqual(providerEffortEnabled({}, { experimentalProviderEffort: false }), false);
  });

  it('env var true wins over config false', () => {
    // Env var takes precedence; if MYSHELL_PROVIDER_EFFORT=1, it's on regardless
    assert.strictEqual(
      providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: '1' }, { experimentalProviderEffort: false }),
      true,
    );
  });

  // ---- Never throws ----------------------------------------------------------

  it('never throws on unusual input', () => {
    assert.doesNotThrow(() => providerEffortEnabled(undefined, undefined));
    assert.doesNotThrow(() => providerEffortEnabled({}, {}));
    assert.doesNotThrow(() =>
      providerEffortEnabled({ MYSHELL_PROVIDER_EFFORT: 'garbage' }, undefined),
    );
  });
});
