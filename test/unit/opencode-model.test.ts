/**
 * test/unit/opencode-model.test.ts — selectOpencodeModel / opencodeModelScore.
 *
 * Pure heuristic over the user's REAL `opencode models` list. We assert the
 * tier ORDERING properties (manager ≥ ic ≥ worker capability) and the fail-safe
 * contract (only ever returns a model from the supplied list, or undefined),
 * rather than brittle exact picks — except for the live free roster, which we
 * pin since detection actually returns it here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectOpencodeModel,
  opencodeModelScore,
} from '../../src/core/opencode-model.ts';

// The live free roster (captured from `opencode models` with 0 credentials).
const FREE = [
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/mimo-v2.5-free',
  'opencode/minimax-m3-free',
  'opencode/nemotron-3-super-free',
];

// A representative OpenCode Go roster (documented open models).
const GO = [
  'opencode-go/kimi-k2.6',
  'opencode-go/glm-5.1',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/deepseek-v4-flash',
  'opencode-go/qwen3.7-max',
  'opencode-go/mimo-v2.5-pro',
  'opencode-go/mimo-v2.5',
  'opencode-go/minimax-m3',
];

describe('selectOpencodeModel — fail-safe contract', () => {
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
    for (const tier of ['worker', 'ic', 'manager'] as const) {
      assert.ok(FREE.includes(selectOpencodeModel(tier, FREE)!), `free/${tier}`);
      assert.ok(GO.includes(selectOpencodeModel(tier, GO)!), `go/${tier}`);
    }
  });
});

describe('selectOpencodeModel — tier ordering (manager ≥ ic ≥ worker capability)', () => {
  for (const [name, roster] of [['free', FREE], ['go', GO]] as const) {
    it(`${name}: manager picks a stronger model than worker`, () => {
      const manager = selectOpencodeModel('manager', roster)!;
      const worker = selectOpencodeModel('worker', roster)!;
      assert.ok(
        opencodeModelScore(manager) > opencodeModelScore(worker),
        `${name}: manager(${manager}) should outrank worker(${worker})`,
      );
    });

    it(`${name}: ic sits between worker and manager (inclusive)`, () => {
      const manager = opencodeModelScore(selectOpencodeModel('manager', roster)!);
      const ic = opencodeModelScore(selectOpencodeModel('ic', roster)!);
      const worker = opencodeModelScore(selectOpencodeModel('worker', roster)!);
      assert.ok(ic <= manager && ic >= worker, `${name}: worker ${worker} ≤ ic ${ic} ≤ manager ${manager}`);
    });
  }

  it('free roster: manager → big-pickle, worker → a free/flash model', () => {
    assert.equal(selectOpencodeModel('manager', FREE), 'opencode/big-pickle');
    const worker = selectOpencodeModel('worker', FREE)!;
    assert.ok(/free|flash/.test(worker), `worker should be a free/flash model, got ${worker}`);
  });

  it('go roster: manager → a top model (qwen-max / kimi / deepseek-pro)', () => {
    const manager = selectOpencodeModel('manager', GO)!;
    assert.ok(/max|kimi|pro/.test(manager), `manager should be a top Go model, got ${manager}`);
  });
});

describe('opencodeModelScore — sanity', () => {
  it('penalises free/flash variants below their pro/max siblings', () => {
    assert.ok(
      opencodeModelScore('opencode-go/deepseek-v4-pro') >
        opencodeModelScore('opencode-go/deepseek-v4-flash'),
    );
    assert.ok(
      opencodeModelScore('opencode-go/qwen3.7-max') >
        opencodeModelScore('opencode/mimo-v2.5-free'),
    );
  });
});
