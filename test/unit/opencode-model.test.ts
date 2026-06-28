/**
 * test/unit/opencode-model.test.ts — selectOpencodeModel (thin fallback).
 *
 * Thin fallback for the opt-out legacy path: returns the first model.
 * The default vendor-neutral router uses opencodeTierRank() instead.
 * Contract: only ever returns a model from the supplied list, or undefined.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectOpencodeModel } from '../../src/core/opencode-model.ts';

describe('selectOpencodeModel — thin fallback contract', () => {
  it('returns undefined for an empty / undefined list (caller omits -m)', () => {
    assert.equal(selectOpencodeModel('manager', []), undefined);
    assert.equal(selectOpencodeModel('manager', undefined), undefined);
  });

  it('returns the only model when the list has one (every tier)', () => {
    const one = ['opencode-go/kimi-k2.6'];
    assert.equal(selectOpencodeModel('worker', one), 'opencode-go/kimi-k2.6');
    assert.equal(selectOpencodeModel('ic', one), 'opencode-go/kimi-k2.6');
    assert.equal(selectOpencodeModel('manager', one), 'opencode-go/kimi-k2.6');
  });

  it('only ever returns a model from the supplied list', () => {
    const list = ['opencode/a', 'opencode/b', 'opencode/c'];
    for (const tier of ['worker', 'ic', 'manager'] as const) {
      const pick = selectOpencodeModel(tier, list)!;
      assert.ok(list.includes(pick), `thin/${tier}: ${pick} not in list`);
    }
  });

  it('returns the first model for all tiers (thin fallback)', () => {
    const list = ['opencode-go/alpha', 'opencode-go/beta', 'opencode-go/gamma'];
    assert.equal(selectOpencodeModel('worker', list), 'opencode-go/alpha');
    assert.equal(selectOpencodeModel('ic', list), 'opencode-go/alpha');
    assert.equal(selectOpencodeModel('manager', list), 'opencode-go/alpha');
  });
});
