/**
 * test/unit/ink-flag.test.ts — pure-logic coverage for the Ink default-ON flag.
 *
 * Runs under the REGULAR `npm test` (strip-types) — flag.ts has no JSX.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inkEnabled } from '../../src/interface/ui/flag.ts';

test('inkEnabled defaults ON with no env and no config', () => {
  assert.equal(inkEnabled({}, {}), true);
  assert.equal(inkEnabled(undefined, undefined), true);
});

test('inkEnabled stays ON when config.experimentalInk === true (explicit opt-in, harmless)', () => {
  assert.equal(inkEnabled({}, { experimentalInk: true }), true);
});

test('inkEnabled is OFF when config.experimentalInk === false (explicit opt-out)', () => {
  assert.equal(inkEnabled({}, { experimentalInk: false }), false);
});

test('inkEnabled is OFF for explicit opt-out MYSHELL_INK values', () => {
  for (const v of ['0', 'false', 'FALSE', 'off', 'no', ' Off ', '  no  ']) {
    assert.equal(inkEnabled({ MYSHELL_INK: v }, {}), false, `expected ${JSON.stringify(v)} → false`);
  }
});

test('inkEnabled stays ON for truthy/other MYSHELL_INK values', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ', 'nope', '']) {
    assert.equal(inkEnabled({ MYSHELL_INK: v }, {}), true, `expected ${JSON.stringify(v)} → true`);
  }
});

test('env opt-out overrides a config opt-in', () => {
  // MYSHELL_INK=0 wins even if config asked for Ink — opt-out is the safety lever.
  assert.equal(inkEnabled({ MYSHELL_INK: '0' }, { experimentalInk: true }), false);
});
