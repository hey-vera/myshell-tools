/**
 * test/unit/ink-flag.test.ts — pure-logic coverage for the Ink default-OFF flag.
 *
 * Runs under the REGULAR `npm test` (strip-types) — flag.ts has no JSX.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inkEnabled } from '../../src/interface/ui/flag.ts';

test('inkEnabled defaults OFF with no env and no config', () => {
  assert.equal(inkEnabled({}, {}), false);
  assert.equal(inkEnabled(undefined, undefined), false);
  assert.equal(inkEnabled({}, { experimentalInk: false }), false);
});

test('inkEnabled is ON when config.experimentalInk === true', () => {
  assert.equal(inkEnabled({}, { experimentalInk: true }), true);
});

test('inkEnabled is ON for truthy MYSHELL_INK values', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(inkEnabled({ MYSHELL_INK: v }, {}), true, `expected ${v} → true`);
  }
});

test('inkEnabled stays OFF for non-truthy MYSHELL_INK values', () => {
  for (const v of ['', '0', 'false', 'no', 'off', 'nope']) {
    assert.equal(inkEnabled({ MYSHELL_INK: v }, {}), false, `expected ${v} → false`);
  }
});
