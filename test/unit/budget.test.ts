/**
 * Unit tests for src/core/budget.ts
 *
 * Pure function tests — no I/O, no providers, no fakes needed.
 * Tests cover all boundary conditions for budgetExceeded() and remainingBudget().
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { budgetExceeded, remainingBudget } from '../../src/core/budget.ts';

// ---------------------------------------------------------------------------
// budgetExceeded
// ---------------------------------------------------------------------------

describe('budgetExceeded — null / undefined cap → never exceeded', () => {
  it('returns false when maxCostUsd is null', () => {
    assert.equal(budgetExceeded(100, null), false);
  });

  it('returns false when maxCostUsd is undefined', () => {
    assert.equal(budgetExceeded(100, undefined), false);
  });

  it('returns false when maxCostUsd is null and spentUsd is 0', () => {
    assert.equal(budgetExceeded(0, null), false);
  });

  it('returns false when maxCostUsd is undefined and spentUsd is 0', () => {
    assert.equal(budgetExceeded(0, undefined), false);
  });
});

describe('budgetExceeded — zero and negative cap → treated as uncapped', () => {
  it('returns false when maxCostUsd is 0 (non-positive treated as uncapped)', () => {
    assert.equal(budgetExceeded(0, 0), false);
  });

  it('returns false when maxCostUsd is 0 and spentUsd > 0', () => {
    assert.equal(budgetExceeded(1, 0), false);
  });

  it('returns false when maxCostUsd is negative', () => {
    assert.equal(budgetExceeded(0, -1), false);
  });

  it('returns false when maxCostUsd is negative and spentUsd > 0', () => {
    assert.equal(budgetExceeded(5, -0.5), false);
  });
});

describe('budgetExceeded — positive cap, below threshold', () => {
  it('returns false when spentUsd is below maxCostUsd', () => {
    assert.equal(budgetExceeded(0.3, 0.5), false);
  });

  it('returns false when spentUsd is 0 and cap > 0', () => {
    assert.equal(budgetExceeded(0, 1), false);
  });

  it('returns false when spentUsd is small and cap is large', () => {
    assert.equal(budgetExceeded(0.001, 100), false);
  });
});

describe('budgetExceeded — positive cap, exactly at threshold (inclusive)', () => {
  it('returns true when spentUsd equals maxCostUsd exactly', () => {
    assert.equal(budgetExceeded(0.5, 0.5), true);
  });

  it('returns true when spentUsd equals maxCostUsd (1.0)', () => {
    assert.equal(budgetExceeded(1.0, 1.0), true);
  });

  it('returns true when spentUsd equals maxCostUsd (very small values)', () => {
    assert.equal(budgetExceeded(0.0001, 0.0001), true);
  });
});

describe('budgetExceeded — positive cap, above threshold', () => {
  it('returns true when spentUsd is above maxCostUsd', () => {
    assert.equal(budgetExceeded(0.6, 0.5), true);
  });

  it('returns true when spentUsd greatly exceeds maxCostUsd', () => {
    assert.equal(budgetExceeded(99, 1), true);
  });

  it('returns true when spentUsd is barely above maxCostUsd', () => {
    assert.equal(budgetExceeded(0.5001, 0.5), true);
  });
});

// ---------------------------------------------------------------------------
// remainingBudget
// ---------------------------------------------------------------------------

describe('remainingBudget — null / undefined cap → returns null (uncapped)', () => {
  it('returns null when maxCostUsd is null', () => {
    assert.equal(remainingBudget(0.3, null), null);
  });

  it('returns null when maxCostUsd is undefined', () => {
    assert.equal(remainingBudget(0.3, undefined), null);
  });

  it('returns null when spentUsd is 0 and cap is null', () => {
    assert.equal(remainingBudget(0, null), null);
  });
});

describe('remainingBudget — zero and negative cap → returns null (uncapped)', () => {
  it('returns null when maxCostUsd is 0', () => {
    assert.equal(remainingBudget(0, 0), null);
  });

  it('returns null when maxCostUsd is negative', () => {
    assert.equal(remainingBudget(0, -5), null);
  });
});

describe('remainingBudget — positive cap, below threshold', () => {
  it('returns positive remaining when spentUsd < maxCostUsd', () => {
    const remaining = remainingBudget(0.2, 0.5);
    assert.ok(remaining !== null);
    assert.ok(Math.abs(remaining - 0.3) < 1e-9, `Expected ~0.3 but got ${remaining}`);
  });

  it('returns full cap when spentUsd is 0', () => {
    const remaining = remainingBudget(0, 1.0);
    assert.ok(remaining !== null);
    assert.ok(Math.abs(remaining - 1.0) < 1e-9, `Expected 1.0 but got ${remaining}`);
  });
});

describe('remainingBudget — at or above cap', () => {
  it('returns 0 when spentUsd equals maxCostUsd', () => {
    const remaining = remainingBudget(0.5, 0.5);
    assert.ok(remaining !== null);
    assert.ok(Math.abs(remaining - 0) < 1e-9, `Expected 0 but got ${remaining}`);
  });

  it('returns negative value when spentUsd exceeds maxCostUsd', () => {
    const remaining = remainingBudget(0.7, 0.5);
    assert.ok(remaining !== null);
    assert.ok(remaining < 0, `Expected negative but got ${remaining}`);
    assert.ok(Math.abs(remaining - (-0.2)) < 1e-9, `Expected ~-0.2 but got ${remaining}`);
  });
});
