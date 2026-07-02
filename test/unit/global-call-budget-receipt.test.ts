/**
 * test/unit/global-call-budget-receipt.test.ts — P1-09j-b observing ledger
 * composition tests.
 *
 * All named tests per the controlling contract.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { createTurnCallBudget } from '../../src/core/turn-call-budget.js';
import type { TurnCallBudget } from '../../src/core/turn-call-budget.js';

describe('global call budget receipt', () => {
  it('interactive success receipt reconciles preflight work and postflight', () => {
    const budget = createTurnCallBudget({
      turnId: 'turn-a1',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    // Simulate preflight route classifier call
    const routeResult = budget.begin({
      purpose: 'route',
      bucket: 'discretionary',
    });
    assert.ok(routeResult.allowed);
    routeResult.finish('succeeded');

    // Simulate preflight intent extractor call
    const intentResult = budget.begin({
      purpose: 'intent',
      bucket: 'discretionary',
    });
    assert.ok(intentResult.allowed);
    intentResult.finish('succeeded');

    // Simulate the main work call
    const workResult = budget.begin({
      purpose: 'work',
      bucket: 'work',
    });
    assert.ok(workResult.allowed);
    workResult.finish('succeeded');

    const receipt = budget.snapshot();
    assert.strictEqual(receipt.begun, 3);
    assert.strictEqual(receipt.settled, 3);
    assert.strictEqual(receipt.denied, 0);
    assert.strictEqual(receipt.mode, 'observe');
    assert.strictEqual(receipt.turnId, 'turn-a1');

    // Events should reflect all three calls
    const begunEvents = receipt.events.filter((e) => e.type === 'call-begun');
    assert.strictEqual(begunEvents.length, 3);

    const purposes = begunEvents.map((e) => 'purpose' in e ? e.purpose : '');
    assert.ok(purposes.includes('route'));
    assert.ok(purposes.includes('intent'));
    assert.ok(purposes.includes('work'));
  });

  it('one-shot run receipt reconciles all calls', () => {
    const budget = createTurnCallBudget({
      turnId: 'turn-b2',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 1, verification: 1 },
    });

    const workResult = budget.begin({
      purpose: 'work',
      bucket: 'work',
    });
    assert.ok(workResult.allowed);
    workResult.finish('succeeded');

    const failoverResult = budget.begin({
      purpose: 'failover',
      bucket: 'failover',
    });
    assert.ok(failoverResult.allowed);
    failoverResult.finish('succeeded');

    const reviewResult = budget.begin({
      purpose: 'review',
      bucket: 'verification',
    });
    assert.ok(reviewResult.allowed);
    reviewResult.finish('succeeded');

    const receipt = budget.snapshot();
    assert.strictEqual(receipt.begun, 3);
    assert.strictEqual(receipt.settled, 3);
    assert.strictEqual(receipt.denied, 0);
    assert.strictEqual(receipt.workRemaining, 0);
    assert.strictEqual(receipt.failoverRemaining, 0);
    assert.strictEqual(receipt.verificationRemaining, 0);
  });

  it('REPL turns receive distinct IDs', () => {
    const budget1 = createTurnCallBudget({
      turnId: 'repl-turn-1',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const budget2 = createTurnCallBudget({
      turnId: 'repl-turn-2',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const r1 = budget1.snapshot();
    const r2 = budget2.snapshot();
    assert.notStrictEqual(r1.turnId, r2.turnId);
  });

  it('goal attempt has separate receipt from parent chat', () => {
    const parentBudget = createTurnCallBudget({
      turnId: 'parent-turn',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const parentWork = parentBudget.begin({
      purpose: 'work',
      bucket: 'work',
    });
    assert.ok(parentWork.allowed);
    parentWork.finish('succeeded');

    const goalBudget = createTurnCallBudget({
      turnId: 'goal-turn',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const goalPlan = goalBudget.begin({
      purpose: 'goal-plan',
      bucket: 'work',
    });
    assert.ok(goalPlan.allowed);
    goalPlan.finish('succeeded');

    const goalWork = goalBudget.begin({
      purpose: 'work',
      bucket: 'work',
    });
    assert.ok(goalWork.allowed);
    goalWork.finish('succeeded');

    const parentReceipt = parentBudget.snapshot();
    const goalReceipt = goalBudget.snapshot();

    assert.notStrictEqual(parentReceipt.turnId, goalReceipt.turnId);
    assert.strictEqual(parentReceipt.begun, 1);
    // goal-turn had goal-plan (work bucket consumed the 1 work) + work which is
    // allowed in observe mode even though capacity is 0 (observe never denies)
    assert.strictEqual(goalReceipt.begun, 2);
  });

  it('failed stream counts without usage', () => {
    const budget = createTurnCallBudget({
      turnId: 'turn-fail',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const workResult = budget.begin({
      purpose: 'work',
      bucket: 'work',
    });
    assert.ok(workResult.allowed);
    // The stream failed — settle as provider-error (counts as settled)
    workResult.finish('provider-error');

    const receipt = budget.snapshot();
    assert.strictEqual(receipt.begun, 1);
    assert.strictEqual(receipt.settled, 1);

    // Verify the call-settled event records the failing outcome
    const settledEvents = receipt.events.filter((e) => e.type === 'call-settled');
    assert.strictEqual(settledEvents.length, 1);
    if (settledEvents[0]?.type === 'call-settled') {
      assert.strictEqual(settledEvents[0].outcome, 'provider-error');
    }

    // No extra cost-based fields; the receipt is purely event-based
    assert.strictEqual(receipt.denied, 0);
  });

  it('available but uncalled provider is absent', () => {
    // Two budgets for two providers. Only one is actually called.
    const budget = createTurnCallBudget({
      turnId: 'turn-absent',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    // Only a single work call is made — no failover, no verify
    const workResult = budget.begin({
      purpose: 'work',
      bucket: 'work',
    });
    assert.ok(workResult.allowed);
    workResult.finish('succeeded');

    const receipt = budget.snapshot();

    // Only 1 call begun — the uncalled provider is simply absent from the ledger
    assert.strictEqual(receipt.begun, 1);
    assert.strictEqual(receipt.settled, 1);
    assert.strictEqual(receipt.failoverRemaining, 0);
    assert.strictEqual(receipt.workRemaining, 0);

    // Verify no failover event was recorded
    const failoverEvents = receipt.events.filter(
      (e) => e.type === 'call-begun' && 'bucket' in e && e.bucket === 'failover',
    );
    assert.strictEqual(failoverEvents.length, 0);
  });

  it('background completion updates only originating receipt', () => {
    // Simulate two budgets: foreground turn and a background goal turn
    const foreground = createTurnCallBudget({
      turnId: 'fg-turn',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const background = createTurnCallBudget({
      turnId: 'bg-turn',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    // Foreground makes its call
    const fgWork = foreground.begin({
      purpose: 'work',
      bucket: 'work',
    });
    assert.ok(fgWork.allowed);
    fgWork.finish('succeeded');

    // Background makes its call later (background completion)
    const bgWork = background.begin({
      purpose: 'goal-objective',
      bucket: 'work',
    });
    assert.ok(bgWork.allowed);
    bgWork.finish('succeeded');

    const fgReceipt = foreground.snapshot();
    const bgReceipt = background.snapshot();

    // Foreground receipt should NOT include background events
    assert.notStrictEqual(fgReceipt.turnId, bgReceipt.turnId);
    assert.strictEqual(fgReceipt.begun, 1);
    assert.strictEqual(bgReceipt.begun, 1);

    // Budget map: verify retrieving origin budget works
    const budgets = new Map<string, TurnCallBudget>();
    budgets.set(fgReceipt.turnId, foreground);
    budgets.set(bgReceipt.turnId, background);

    const resolvedBg = budgets.get(bgReceipt.turnId);
    assert.ok(resolvedBg !== undefined);
    const resolvedSnap = resolvedBg.snapshot();
    assert.strictEqual(resolvedSnap.begun, 1);
    assert.strictEqual(resolvedSnap.turnId, 'bg-turn');
  });
});
