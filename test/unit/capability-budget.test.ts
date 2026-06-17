/**
 * test/unit/capability-budget.test.ts — the summed budget + quota-shed policy
 * (whole-tool-finish-5.5.md §0.3, §3, §3.4).
 *
 * The budget constants are ADVISORY design targets, not a runtime governor.
 * This test pins THIS module's intended per-class overhead so a deliberate
 * change to it is required to alter the table (a regression tripwire — it does
 * NOT prove the live chat path makes only one blocking call). decideShed
 * returns the exact ordered ladder and the core answer ALWAYS survives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_BUDGET,
  MAX_ADDED_BLOCKING_CALLS,
  decideShed,
  pressureFromSignals,
  preflightAdmits,
  type TurnClass,
  type QuotaPressure,
} from '../../src/core/capability-budget.ts';

const CLASSES: readonly TurnClass[] = ['trivial', 'normal', 'substantial'];

// ---------------------------------------------------------------------------
// The enforced budget ceilings (§3.1)
// ---------------------------------------------------------------------------

describe('CAPABILITY_BUDGET — advisory intent targets (§3.1)', () => {
  it('matches this module\'s documented per-class intended overhead EXACTLY', () => {
    assert.deepEqual(CAPABILITY_BUDGET.trivial, {
      addedBlockingCalls: 0,
      addedBackgroundCalls: 0,
      addedTokensCeiling: 80,
    });
    assert.deepEqual(CAPABILITY_BUDGET.normal, {
      addedBlockingCalls: 1,
      addedBackgroundCalls: 0,
      addedTokensCeiling: 600,
    });
    assert.deepEqual(CAPABILITY_BUDGET.substantial, {
      addedBlockingCalls: 1,
      addedBackgroundCalls: 1,
      addedTokensCeiling: 1200,
    });
  });

  it('this module\'s own intended blocking overhead stays within its tripwire (advisory, not a runtime cap)', () => {
    assert.equal(MAX_ADDED_BLOCKING_CALLS, 1);
    for (const c of CLASSES) {
      assert.ok(
        CAPABILITY_BUDGET[c].addedBlockingCalls <= MAX_ADDED_BLOCKING_CALLS,
        `${c}: this module's intended blocking overhead exceeds its tripwire — change deliberately`,
      );
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

// ---------------------------------------------------------------------------
// preflightAdmits — rank-10 aggregate overhead guard (default-OFF, neutral)
// ---------------------------------------------------------------------------

describe('preflightAdmits — rank-10 guard truth table', () => {
  it('trivial class admits NO optional blocking preflights (budget 0)', () => {
    assert.equal(preflightAdmits({ blockingCallsSoFar: 0, pressure: 0 }, 'trivial'), false);
  });

  it('normal class admits exactly one optional blocking preflight (budget 1)', () => {
    assert.equal(preflightAdmits({ blockingCallsSoFar: 0, pressure: 0 }, 'normal'), true);
    assert.equal(preflightAdmits({ blockingCallsSoFar: 1, pressure: 0 }, 'normal'), false);
  });

  it('substantial class admits exactly one optional blocking preflight (budget 1)', () => {
    assert.equal(preflightAdmits({ blockingCallsSoFar: 0, pressure: 0 }, 'substantial'), true);
    assert.equal(preflightAdmits({ blockingCallsSoFar: 1, pressure: 0 }, 'substantial'), false);
  });

  it('heavy pressure (3) denies every optional preflight, matching decideShed', () => {
    for (const c of CLASSES) {
      assert.equal(preflightAdmits({ blockingCallsSoFar: 0, pressure: 3 }, c), false);
    }
  });

  it('defends against garbage counts (total, never throws)', () => {
    assert.equal(preflightAdmits({ blockingCallsSoFar: Number.NaN, pressure: 0 }, 'normal'), false);
    assert.equal(preflightAdmits({ blockingCallsSoFar: -1, pressure: 0 }, 'normal'), true);
    assert.equal(preflightAdmits({ blockingCallsSoFar: Number.POSITIVE_INFINITY, pressure: 0 }, 'normal'), false);
  });
});
