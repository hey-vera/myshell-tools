import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { itemParkingEnabled } from '../../src/interface/ui/item-park-flag.ts';

describe('itemParkingEnabled', () => {
  it('defaults off', () => {
    assert.equal(itemParkingEnabled(undefined, undefined), false);
    assert.equal(itemParkingEnabled({}, {}), false);
    assert.equal(itemParkingEnabled({}, { experimentalItemParking: false }), false);
  });

  it('opts in through env (case-insensitive, trimmed) or config', () => {
    for (const value of ['1', 'true', 'on', 'yes', ' TRUE ', 'On']) {
      assert.equal(itemParkingEnabled({ MYSHELL_ITEM_PARK: value }, undefined), true);
    }
    assert.equal(itemParkingEnabled({}, { experimentalItemParking: true }), true);
  });

  it('treats opt-out / ambiguous env values as off', () => {
    for (const value of ['0', 'false', 'off', 'no', '', 'maybe']) {
      assert.equal(itemParkingEnabled({ MYSHELL_ITEM_PARK: value }, undefined), false);
    }
  });

  it('config opt-in still wins when env is absent', () => {
    assert.equal(itemParkingEnabled({}, { experimentalItemParking: true }), true);
  });
});
