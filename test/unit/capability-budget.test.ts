/**
 * test/unit/capability-budget.test.ts — the summed budget + quota-shed policy
 * (whole-tool-finish-5.5.md §0.3, §3, §3.4).
 *
 * The budget constants match the documented §3.1 ceilings (so a future feature
 * that quietly adds a SECOND blocking call FAILS this test — the budget is
 * enforced data, not just documentation); decideShed returns the exact ordered
 * ladder and the core answer ALWAYS survives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_BUDGET,
  MAX_ADDED_BLOCKING_CALLS,
  decideShed,
  pressureFromSignals,
  type TurnClass,
  type QuotaPressure,
} from '../../src/core/capability-budget.ts';

const CLASSES: readonly TurnClass[] = ['trivial', 'normal', 'substantial'];

// ---------------------------------------------------------------------------
// The enforced budget ceilings (§3.1)
// ---------------------------------------------------------------------------

describe('CAPABILITY_BUDGET — enforced ceilings (§3.1)', () => {
  it('matches the documented per-class budget EXACTLY', () => {
    assert.deepEqual(CAPABILITY_BUDGET.trivial, {
      addedBlockingCalls: 0,
      addedBackgroundCalls: 0,
      addedTokensCeiling: 80,
      addedDollars: 0,
    });
    assert.deepEqual(CAPABILITY_BUDGET.normal, {
      addedBlockingCalls: 1,
      addedBackgroundCalls: 0,
      addedTokensCeiling: 600,
      addedDollars: 0,
    });
    assert.deepEqual(CAPABILITY_BUDGET.substantial, {
      addedBlockingCalls: 1,
      addedBackgroundCalls: 1,
      addedTokensCeiling: 1200,
      addedDollars: 0,
    });
  });

  it('NEVER exceeds ONE added blocking call per turn (a 2nd would fail this)', () => {
    assert.equal(MAX_ADDED_BLOCKING_CALLS, 1);
    for (const c of CLASSES) {
      assert.ok(
        CAPABILITY_BUDGET[c].addedBlockingCalls <= MAX_ADDED_BLOCKING_CALLS,
        `${c} adds ≤1 blocking call — a second blocking call (non-background recap, 2nd extractor) must fail here`,
      );
    }
  });

  it('adds $0 on every class (flat-rate subscription, quota+latency only)', () => {
    for (const c of CLASSES) {
      assert.equal(CAPABILITY_BUDGET[c].addedDollars, 0, `${c} adds no dollars`);
    }
  });

  it('the common case (trivial) adds ZERO calls of any kind', () => {
    assert.equal(CAPABILITY_BUDGET.trivial.addedBlockingCalls, 0);
    assert.equal(CAPABILITY_BUDGET.trivial.addedBackgroundCalls, 0);
  });

  it('token ceilings are monotonic by class size', () => {
    assert.ok(
      CAPABILITY_BUDGET.trivial.addedTokensCeiling <= CAPABILITY_BUDGET.normal.addedTokensCeiling,
    );
    assert.ok(
      CAPABILITY_BUDGET.normal.addedTokensCeiling <= CAPABILITY_BUDGET.substantial.addedTokensCeiling,
    );
  });
});

// ---------------------------------------------------------------------------
// decideShed — the exact ordered ladder (§3.2), core always survives
// ---------------------------------------------------------------------------

describe('decideShed — ordered ladder; core answer always survives', () => {
  it('level 0 (no pressure): nothing shed', () => {
    const p = decideShed(0);
    assert.equal(p.recapRefresh, true);
    assert.equal(p.memoryWidth, 'full');
    assert.equal(p.intentPass, true);
    assert.equal(p.coreAnswer, true);
  });

  it('level 1: drops ONLY the recap refresh', () => {
    const p = decideShed(1);
    assert.equal(p.recapRefresh, false, 'recap refresh shed first');
    assert.equal(p.memoryWidth, 'full', 'memory still full');
    assert.equal(p.intentPass, true, 'intent still runs');
    assert.equal(p.coreAnswer, true);
  });

  it('level 2: ALSO narrows memory to identity/constraints', () => {
    const p = decideShed(2);
    assert.equal(p.recapRefresh, false);
    assert.equal(p.memoryWidth, 'identity-only', 'memory narrowed second');
    assert.equal(p.intentPass, true, 'intent still runs');
    assert.equal(p.coreAnswer, true);
  });

  it('level 3: ALSO skips the intent pass', () => {
    const p = decideShed(3);
    assert.equal(p.recapRefresh, false);
    assert.equal(p.memoryWidth, 'identity-only');
    assert.equal(p.intentPass, false, 'intent shed third');
    assert.equal(p.coreAnswer, true);
  });

  it('the CORE ANSWER flag stays true at EVERY pressure level', () => {
    for (let lvl = 0 as number; lvl <= 5; lvl++) {
      assert.equal(decideShed(lvl).coreAnswer, true, `core survives at level ${lvl}`);
    }
  });

  it('the ladder shed-order is strictly monotonic (recap → memory → intent)', () => {
    const recapOff = (p: ReturnType<typeof decideShed>) => !p.recapRefresh;
    const memNarrow = (p: ReturnType<typeof decideShed>) => p.memoryWidth === 'identity-only';
    const intentOff = (p: ReturnType<typeof decideShed>) => !p.intentPass;
    // memory is never narrowed before recap is shed; intent is never skipped
    // before memory is narrowed.
    for (let lvl = 0 as number; lvl <= 3; lvl++) {
      const p = decideShed(lvl);
      if (memNarrow(p)) assert.ok(recapOff(p), `lvl ${lvl}: memory narrowed implies recap shed`);
      if (intentOff(p)) assert.ok(memNarrow(p), `lvl ${lvl}: intent skipped implies memory narrowed`);
    }
  });

  it('identity/constraints are never narrowed out (memoryWidth is never "off")', () => {
    for (let lvl = 0 as number; lvl <= 5; lvl++) {
      const w = decideShed(lvl).memoryWidth;
      assert.ok(w === 'full' || w === 'identity-only', `lvl ${lvl}: identity always rides`);
    }
  });

  it('clamps out-of-range/garbage pressure (defensive, total)', () => {
    assert.equal(decideShed(-5).pressure, 0);
    assert.equal(decideShed(99).pressure, 3);
    assert.equal(decideShed(Number.NaN as unknown as QuotaPressure).pressure, 0);
    assert.equal(decideShed(2.7 as unknown as QuotaPressure).pressure, 2);
  });
});

// ---------------------------------------------------------------------------
// pressureFromSignals — reactive-after-429, no token readout (§3.3)
// ---------------------------------------------------------------------------

describe('pressureFromSignals — from renderer signals only', () => {
  it('no signal → no pressure', () => {
    assert.equal(pressureFromSignals({}), 0);
    assert.equal(pressureFromSignals({ rateLimitedProviderCount: 0 }), 0);
  });

  it('one rate-limited provider → light (1)', () => {
    assert.equal(pressureFromSignals({ rateLimitedProviderCount: 1 }), 1);
  });

  it('two rate-limited providers → moderate (2)', () => {
    assert.equal(pressureFromSignals({ rateLimitedProviderCount: 2 }), 2);
  });

  it('a recent quota error bumps the level by one', () => {
    assert.equal(pressureFromSignals({ recentQuotaError: true }), 1);
    assert.equal(pressureFromSignals({ rateLimitedProviderCount: 2, recentQuotaError: true }), 3);
  });

  it('clamps at 3 (heavy) and tolerates garbage', () => {
    assert.equal(pressureFromSignals({ rateLimitedProviderCount: 9 }), 3);
    assert.equal(
      pressureFromSignals({ rateLimitedProviderCount: Number.NaN as unknown as number }),
      0,
    );
    assert.equal(pressureFromSignals({ rateLimitedProviderCount: -2 }), 0);
  });

  it('end-to-end: one 429 sheds recap but keeps memory + intent + core', () => {
    const plan = decideShed(pressureFromSignals({ rateLimitedProviderCount: 1 }));
    assert.equal(plan.recapRefresh, false);
    assert.equal(plan.memoryWidth, 'full');
    assert.equal(plan.intentPass, true);
    assert.equal(plan.coreAnswer, true);
  });
});
