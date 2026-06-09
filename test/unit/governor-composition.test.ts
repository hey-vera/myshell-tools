/**
 * test/unit/governor-composition.test.ts — THE ALL-FLAGS-ON COMPOSITION AUDIT for
 * the Performance Governor (src/core/governor.ts), the SPINE that coordinates every
 * expensive cross-vendor lever (verify-critic, judgment-poll, tribunal) and the
 * Oracle from ONE `turnCallBudget`.
 *
 * Eight master-build phases each proved "flag-off neutral" in ISOLATION. The config
 * the user will actually test is ALL flags ON together, and the levers all draw from
 * the ONE budget. This suite is the composition tripwire: it sweeps EVERY
 * shape × mode × vendorCount × pressure combination and asserts the load-bearing
 * budget invariants hold under EVERY combination — no double-spend, no over-budget
 * lever set, and the cross-vendor levers (critic / poll / tribunal) are MUTUALLY
 * EXCLUSIVE over the one cross-vendor unit (a sibling-class of the just-fixed
 * "tribunal grant never spent / poll preempted the tribunal" bug).
 *
 * PURE: the Governor is a pure function, so this is table-testable with ZERO live
 * model calls and zero harness flakiness — exactly the seam where a composition bug
 * would hide.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { allocate, type AllocateInput, type Lever, type TaskShape } from '../../src/core/governor.ts';
import type { Confidence } from '../../src/core/brain.ts';
import type { EngagementSignals, EngagementPlan } from '../../src/core/engagement.ts';
import { planEngagement } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Classification } from '../../src/core/types.ts';
import type { Mode } from '../../src/core/policy.ts';

// ---------------------------------------------------------------------------
// Builders — drive the Governor into each TaskShape via REAL signals (mirrors
// governor.test.ts), so the sweep exercises the genuine classifyTaskShape path.
// ---------------------------------------------------------------------------

function classification(over: Partial<Classification> = {}): Classification {
  return { tier: 'ic', risk: 'medium', rationale: 'test', ...over };
}

function signals(over: Partial<EngagementSignals> = {}): EngagementSignals {
  return {
    classification: classification(),
    routePlan: false,
    engagementBias: 0,
    task: 'do a substantial thing with several parts and tradeoffs',
    ...over,
  };
}

function frameWith(over: Partial<IntentFrame> = {}): IntentFrame {
  return { version: 1, goal: 'g', kind: 'coding', confidence: 'medium', source: 'model', ...over };
}

/** Build an AllocateInput that classifies to the requested shape via real predicates. */
function inputForShape(
  shape: TaskShape,
  mode: Mode,
  authedProviderCount: number,
  pressure: 0 | 1 | 2 | 3,
): AllocateInput {
  // conf carries the stakes the shape needs; the rest is driven by substantial/repoOriented.
  const highStakes = shape === 'risky';
  const conf: Confidence = {
    understanding: shape === 'investigate' ? 'low' : 'medium',
    groundedness: 'unread',
    stakes: highStakes ? 'high' : 'low',
  };
  // `decide` ← substantial; `build` ← repoOriented (and not substantial/decide);
  // `risky` ← high stakes (dominates). `quick` is forced via a trivial task.
  const substantial = shape === 'decide';
  // repoOriented true for build/risky/decide so the implementation-fork path is live;
  // it does not change the shape (stakes/substantial dominate the classification).
  const repoOriented = shape === 'build' || shape === 'risky' || shape === 'decide';
  const sig = signals({
    classification: classification({ risk: highStakes ? 'high' : 'medium' }),
    ...(shape === 'quick' ? { task: 'hi' } : {}),
  });
  const frame = shape === 'investigate' ? frameWith({ confidence: 'low' }) : frameWith();
  const plan: EngagementPlan = planEngagement(sig);
  return {
    conf,
    frame,
    signals: sig,
    plan,
    substantial,
    repoOriented,
    mode,
    authedProviderCount,
    pressure,
    maxRounds: 2,
  };
}

const CROSS_VENDOR: ReadonlySet<Lever> = new Set<Lever>(['critic', 'poll', 'tribunal']);
const MODES: Mode[] = ['quality-first', 'balanced', 'cost-saver'];
const PRESSURES: Array<0 | 1 | 2 | 3> = [0, 1, 2, 3];
const VENDORS = [1, 2, 3];
// We assert per-shape via the input builder; classifyTaskShape may map some inputs to
// a different shape (e.g. trivial), so we read plan.shape (the authority) for the
// invariant checks rather than assuming the requested shape.
const REQUESTED_SHAPES: TaskShape[] = ['quick', 'explain', 'build', 'investigate', 'decide', 'risky'];

// ---------------------------------------------------------------------------
// (1) THE HARD-CAP INVARIANT under EVERY combination
// ---------------------------------------------------------------------------

describe('Governor composition — hard cap holds for every shape × mode × vendors × pressure', () => {
  it('levers.length <= turnCallBudget and budget in [1,3] for every combination', () => {
    for (const reqShape of REQUESTED_SHAPES) {
      for (const mode of MODES) {
        for (const vendors of VENDORS) {
          for (const pressure of PRESSURES) {
            const plan = allocate(inputForShape(reqShape, mode, vendors, pressure));
            const label = `shape=${plan.shape} req=${reqShape} mode=${mode} vendors=${vendors} pressure=${pressure}`;

            // THE HARD CAP — the load-bearing promise.
            assert.ok(
              plan.levers.length <= plan.turnCallBudget,
              `${label}: levers.length=${plan.levers.length} exceeds turnCallBudget=${plan.turnCallBudget} (${plan.levers.join(',')})`,
            );
            // Budget is bounded [1,3].
            assert.ok(
              plan.turnCallBudget >= 1 && plan.turnCallBudget <= 3,
              `${label}: turnCallBudget=${plan.turnCallBudget} out of [1,3]`,
            );
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (2) NO DOUBLE-SPEND — each lever appears at most once
// ---------------------------------------------------------------------------

describe('Governor composition — no lever is double-counted', () => {
  it('every chosen lever is unique (no unit spent twice)', () => {
    for (const reqShape of REQUESTED_SHAPES) {
      for (const mode of MODES) {
        for (const vendors of VENDORS) {
          for (const pressure of PRESSURES) {
            const plan = allocate(inputForShape(reqShape, mode, vendors, pressure));
            const seen = new Set<Lever>();
            for (const lever of plan.levers) {
              assert.ok(
                !seen.has(lever),
                `shape=${plan.shape} mode=${mode} vendors=${vendors} pressure=${pressure}: lever "${lever}" chosen twice`,
              );
              seen.add(lever);
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (3) CROSS-VENDOR MUTUAL EXCLUSION — critic / poll / tribunal never co-fire
//     (the just-fixed bug class: they all draw the ONE cross-vendor unit).
// ---------------------------------------------------------------------------

describe('Governor composition — the cross-vendor levers are mutually exclusive', () => {
  it('at most ONE of {critic, poll, tribunal} is ever chosen on a turn', () => {
    for (const reqShape of REQUESTED_SHAPES) {
      for (const mode of MODES) {
        for (const vendors of VENDORS) {
          for (const pressure of PRESSURES) {
            const plan = allocate(inputForShape(reqShape, mode, vendors, pressure));
            const crossVendorChosen = plan.levers.filter((l) => CROSS_VENDOR.has(l));
            assert.ok(
              crossVendorChosen.length <= 1,
              `shape=${plan.shape} mode=${mode} vendors=${vendors} pressure=${pressure}: ` +
                `multiple cross-vendor levers fired: ${crossVendorChosen.join(', ')}`,
            );
          }
        }
      }
    }
  });

  it('the pollAllowed and tribunalAllowed gates are never BOTH true (poll/tribunal exclusion)', () => {
    for (const reqShape of REQUESTED_SHAPES) {
      for (const mode of MODES) {
        for (const vendors of VENDORS) {
          for (const pressure of PRESSURES) {
            const plan = allocate(inputForShape(reqShape, mode, vendors, pressure));
            assert.ok(
              !(plan.pollAllowed && plan.tribunalAllowed),
              `shape=${plan.shape} mode=${mode} vendors=${vendors} pressure=${pressure}: ` +
                `pollAllowed AND tribunalAllowed both true — they share the one cross-vendor unit`,
            );
          }
        }
      }
    }
  });

  it('a tribunal/critic that fires when verify=tests+critic never co-exists with the tribunal lever', () => {
    for (const reqShape of REQUESTED_SHAPES) {
      for (const mode of MODES) {
        for (const vendors of VENDORS) {
          for (const pressure of PRESSURES) {
            const plan = allocate(inputForShape(reqShape, mode, vendors, pressure));
            const hasCritic = plan.verify === 'tests+critic';
            const hasTribunal = plan.levers.includes('tribunal');
            const hasPoll = plan.levers.includes('poll');
            // The verify critic (when it fires) is THE cross-vendor unit for that turn,
            // so neither the tribunal nor the poll may also fire.
            if (hasCritic) {
              assert.ok(
                !hasTribunal && !hasPoll,
                `shape=${plan.shape} mode=${mode} vendors=${vendors} pressure=${pressure}: ` +
                  `verify critic fired alongside ${hasTribunal ? 'tribunal' : ''}${hasPoll ? 'poll' : ''}`,
              );
            }
            // When the critic IS in `levers`, verify MUST be tests+critic (consistency).
            if (plan.levers.includes('critic')) {
              assert.equal(
                plan.verify,
                'tests+critic',
                `shape=${plan.shape} mode=${mode} vendors=${vendors} pressure=${pressure}: ` +
                  `critic lever present but verify=${plan.verify}`,
              );
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (4) SINGLE-VENDOR LOCK — no cross-vendor lever is ever CHOSEN below 2 vendors
//     (it must sit in `locked`, never in `levers`).
// ---------------------------------------------------------------------------

describe('Governor composition — cross-vendor levers locked below 2 vendors', () => {
  it('no cross-vendor lever appears in `levers` when authedProviderCount < 2', () => {
    for (const reqShape of REQUESTED_SHAPES) {
      for (const mode of MODES) {
        for (const pressure of PRESSURES) {
          const plan = allocate(inputForShape(reqShape, mode, 1, pressure));
          const crossVendorChosen = plan.levers.filter((l) => CROSS_VENDOR.has(l));
          assert.deepEqual(
            crossVendorChosen,
            [],
            `shape=${plan.shape} mode=${mode} pressure=${pressure}: cross-vendor lever chosen with 1 vendor: ${crossVendorChosen.join(', ')}`,
          );
          // And the budget-authority gates agree.
          assert.equal(plan.pollAllowed, false, `${plan.shape}/${mode}: pollAllowed true with 1 vendor`);
          assert.equal(plan.tribunalAllowed, false, `${plan.shape}/${mode}: tribunalAllowed true with 1 vendor`);
          assert.equal(plan.verify === 'tests+critic', false, `${plan.shape}/${mode}: critic with 1 vendor`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (5) FRUGAL FLOOR — cost-saver never auto-opens ANY expensive lever
// ---------------------------------------------------------------------------

describe('Governor composition — cost-saver never auto-opens a paid lever', () => {
  it('cost-saver requests no oracle and no cross-vendor lever in any combination', () => {
    for (const reqShape of REQUESTED_SHAPES) {
      for (const vendors of VENDORS) {
        for (const pressure of PRESSURES) {
          const plan = allocate(inputForShape(reqShape, 'cost-saver', vendors, pressure));
          assert.notEqual(plan.tierRequest, 'oracle', `${plan.shape}: cost-saver requested oracle`);
          assert.equal(plan.pollAllowed, false, `${plan.shape}: cost-saver pollAllowed`);
          assert.equal(plan.tribunalAllowed, false, `${plan.shape}: cost-saver tribunalAllowed`);
          assert.notEqual(plan.verify, 'tests+critic', `${plan.shape}: cost-saver opened the critic`);
          const crossVendorChosen = plan.levers.filter((l) => CROSS_VENDOR.has(l));
          assert.deepEqual(crossVendorChosen, [], `${plan.shape}: cost-saver chose a cross-vendor lever`);
        }
      }
    }
  });
});
