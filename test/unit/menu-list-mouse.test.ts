/**
 * Pure list-row mouse hit math for accounts menus (residual accounts mouse).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  ACCOUNTS_LIST_FIRST_DATA_ROW,
  listIndexFromMouseKey,
  listIndexFromMouseRow,
} from '../../src/interface/ui/mouse.js';
import { classifyMenuKey } from '../../src/interface/menu-key-confirm.js';

describe('listIndexFromMouseRow', () => {
  it('maps absolute row to 0-based index within data band', () => {
    assert.equal(listIndexFromMouseRow(4, 4, 3), 0);
    assert.equal(listIndexFromMouseRow(5, 4, 3), 1);
    assert.equal(listIndexFromMouseRow(6, 4, 3), 2);
  });

  it('returns null outside the data range', () => {
    assert.equal(listIndexFromMouseRow(3, 4, 3), null); // header
    assert.equal(listIndexFromMouseRow(7, 4, 3), null); // past last row
    assert.equal(listIndexFromMouseRow(0, 4, 3), null);
  });

  it('empty list or invalid geometry → null', () => {
    assert.equal(listIndexFromMouseRow(4, 4, 0), null);
    assert.equal(listIndexFromMouseRow(-1, 4, 3), null);
    assert.equal(listIndexFromMouseRow(4, -1, 3), null);
  });

  it('ACCOUNTS_LIST_FIRST_DATA_ROW is the shared chrome offset', () => {
    assert.equal(ACCOUNTS_LIST_FIRST_DATA_ROW, 4);
    assert.equal(listIndexFromMouseRow(ACCOUNTS_LIST_FIRST_DATA_ROW + 1, ACCOUNTS_LIST_FIRST_DATA_ROW, 5), 1);
  });
});

describe('listIndexFromMouseKey', () => {
  it('primary left press on data row activates that index', () => {
    // SGR 1-based row 5 → 0-based row 4 → first data row when firstDataRow=4
    assert.equal(listIndexFromMouseKey('[<0;1;5M', 4, 3), 0);
    assert.equal(listIndexFromMouseKey('\x1b[<0;10;6M', 4, 3), 1);
    assert.equal(listIndexFromMouseKey('[<0;3;7M', 4, 3), 2);
  });

  it('release / wheel / miss / non-mouse → null', () => {
    assert.equal(listIndexFromMouseKey('[<0;1;5m', 4, 3), null); // release
    assert.equal(listIndexFromMouseKey('[<64;1;5M', 4, 3), null); // wheel
    assert.equal(listIndexFromMouseKey('[<0;1;3M', 4, 3), null); // header row
    assert.equal(listIndexFromMouseKey('e', 4, 3), null);
    assert.equal(listIndexFromMouseKey(null, 4, 3), null);
    assert.equal(listIndexFromMouseKey('', 4, 3), null);
  });
});

describe('classifyMenuKey preserves SGR mouse', () => {
  it('does not collapse mouse CSI to Enter empty', () => {
    const raw = '[<0;5;6M';
    assert.equal(classifyMenuKey(raw), raw);
    assert.notEqual(classifyMenuKey(raw), '');
  });
});
