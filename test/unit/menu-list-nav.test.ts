/**
 * Pure list-selection helpers for accounts menus (A1):
 * classifyMenuKey up/down, moveListHighlight, listIndexFromDigit, interpretListKey.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  classifyMenuKey,
  NAV_ESC,
  NAV_LEFT,
  NAV_UP,
  NAV_DOWN,
  moveListHighlight,
  listIndexFromDigit,
  interpretListKey,
} from '../../src/interface/menu-key-confirm.js';

describe('classifyMenuKey — arrow/list sentinels', () => {
  it('maps up/down arrows to NAV_UP / NAV_DOWN', () => {
    assert.equal(classifyMenuKey('\x1b[A'), NAV_UP);
    assert.equal(classifyMenuKey('\x1b[B'), NAV_DOWN);
  });

  it('keeps ESC / left / Enter / digits / letters', () => {
    assert.equal(classifyMenuKey('\x1b'), NAV_ESC);
    assert.equal(classifyMenuKey('\x1b[D'), NAV_LEFT);
    assert.equal(classifyMenuKey('\r'), '');
    assert.equal(classifyMenuKey('\n'), '');
    assert.equal(classifyMenuKey('3'), '3');
    assert.equal(classifyMenuKey('C'), 'c');
    assert.equal(classifyMenuKey('\x03'), null);
  });

  it('right arrow and tab remain no-op empty', () => {
    assert.equal(classifyMenuKey('\x1b[C'), '');
    assert.equal(classifyMenuKey('\x1b[tab]'), '');
  });
});

describe('moveListHighlight', () => {
  it('clamps at ends and is identity at delta 0', () => {
    assert.equal(moveListHighlight(0, -1, 3), 0);
    assert.equal(moveListHighlight(2, 1, 3), 2);
    assert.equal(moveListHighlight(1, 0, 3), 1);
    assert.equal(moveListHighlight(5, 0, 3), 2); // clamp high index
  });

  it('empty list → 0', () => {
    assert.equal(moveListHighlight(0, 1, 0), 0);
    assert.equal(moveListHighlight(2, -1, 0), 0);
  });
});

describe('listIndexFromDigit', () => {
  it('maps 1-9 when in range', () => {
    assert.equal(listIndexFromDigit('1', 5), 0);
    assert.equal(listIndexFromDigit('5', 5), 4);
    assert.equal(listIndexFromDigit('9', 9), 8);
  });

  it('rejects out of range / non-digit', () => {
    assert.equal(listIndexFromDigit('6', 5), null);
    assert.equal(listIndexFromDigit('0', 5), null);
    assert.equal(listIndexFromDigit('a', 5), null);
    assert.equal(listIndexFromDigit('1', 0), null);
  });
});

describe('interpretListKey', () => {
  it('up/down only move highlight', () => {
    assert.deepEqual(interpretListKey(NAV_UP, 2, 4), { kind: 'highlight', index: 1 });
    assert.deepEqual(interpretListKey(NAV_DOWN, 2, 4), { kind: 'highlight', index: 3 });
    assert.deepEqual(interpretListKey(NAV_UP, 0, 4), { kind: 'highlight', index: 0 });
  });

  it('Enter activates selection or create-empty', () => {
    assert.deepEqual(interpretListKey('', 1, 3), { kind: 'activate', index: 1 });
    assert.deepEqual(interpretListKey('', 0, 0), { kind: 'create-empty' });
  });

  it('digits activate row when in range', () => {
    assert.deepEqual(interpretListKey('2', 0, 3), { kind: 'activate', index: 1 });
    assert.deepEqual(interpretListKey('9', 0, 3), { kind: 'other', key: '9' });
  });

  it('letters and nav pass through as other', () => {
    assert.deepEqual(interpretListKey('c', 0, 2), { kind: 'other', key: 'c' });
    assert.deepEqual(interpretListKey('e', 0, 2), { kind: 'other', key: 'e' });
    assert.deepEqual(interpretListKey('b', 0, 2), { kind: 'other', key: 'b' });
    assert.deepEqual(interpretListKey(NAV_LEFT, 0, 2), { kind: 'other', key: NAV_LEFT });
    assert.deepEqual(interpretListKey(null, 0, 2), { kind: 'other', key: null });
  });
});
