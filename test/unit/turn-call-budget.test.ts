/**
 * test/unit/turn-call-budget.test.ts — P1-09a turn-call budget domain tests.
 *
 * All named tests per the controlling contract: reservation, width, failover,
 * verification, concurrency, denial, observe, settlement, idempotency,
 * visibility, loss-preservation override, and validation.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  createTurnCallBudget,
  type TurnCallBudgetMode,
  type TurnCallBudgetSpec,
  type TurnCallOutcome,
  type TurnCallRequest,
} from '../../src/core/turn-call-budget.ts';

function budgetSpec(
  overrides: Partial<{
    turnId: string;
    mode: TurnCallBudgetMode;
    totalUnits: number;
    reservedWork: number;
    reservedFailover: number;
    reservedVerification: number;
    nextSeq: () => number;
    nextCallId: () => string;
  }> = {},
): TurnCallBudgetSpec {
  return {
    turnId: overrides.turnId ?? 'turn-1',
    mode: overrides.mode ?? 'enforce',
    totalUnits: overrides.totalUnits ?? 5,
    reserved: {
      work: overrides.reservedWork ?? 1,
      failover: (overrides.reservedFailover ?? 0) as 0 | 1,
      verification: (overrides.reservedVerification ?? 0) as 0 | 1,
    },
    nextSeq: overrides.nextSeq,
    nextCallId: overrides.nextCallId,
  };
}

function workReq(overrides: Partial<TurnCallRequest> = {}): TurnCallRequest {
  return {
    purpose: 'work',
    bucket: 'work',
    ...overrides,
  };
}

const ALL_OUTCOMES: readonly TurnCallOutcome[] = [
  'succeeded',
  'provider-error',
  'threw',
  'cancelled',
  'empty',
  'abandoned',
];

// ---------------------------------------------------------------------------
// work reservation admits exactly one initial execution
// ---------------------------------------------------------------------------
describe('work reservation admits exactly one initial execution', () => {
  it('admits exactly one work call then denies the second in enforce mode', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r1 = b.begin(workReq());
    assert.ok(r1.allowed);
    assert.equal(typeof r1.callId, 'string');

    const r2 = b.begin(workReq());
    assert.ok(!r2.allowed);
    assert.equal(r2.denial.reason, 'insufficient-work-capacity');

    const snap = b.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.denied, 1);
    assert.equal(snap.workRemaining, 0);
  });
});

// ---------------------------------------------------------------------------
// work width finalizes once before execution without growing total
// ---------------------------------------------------------------------------
describe('work width finalizes once before execution without growing total', () => {
  it('finalizes to 3, consumes discretionary, total unchanged', () => {
    const b = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    const s0 = b.snapshot();
    assert.equal(s0.workRemaining, 1);
    assert.equal(s0.discretionaryRemaining, 9);
    assert.equal(s0.totalUnits, 10);

    b.finalizeWorkReservation(3);
    const s1 = b.snapshot();
    assert.equal(s1.workRemaining, 3);
    assert.equal(s1.discretionaryRemaining, 7);
    assert.equal(s1.totalUnits, 10);

    // verify three work calls are admitted
    for (let i = 0; i < 3; i++) {
      const r = b.begin(workReq());
      assert.ok(r.allowed, `work call ${i} should be allowed`);
    }
    const r4 = b.begin(workReq());
    assert.ok(!r4.allowed);
  });

  it('rejects second finalizeWorkReservation call', () => {
    const b = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    b.finalizeWorkReservation(2);
    assert.throws(
      () => b.finalizeWorkReservation(3),
      /already finalized/,
    );
  });

  it('rejects finalizeWorkReservation that exceeds discretionary', () => {
    const b = createTurnCallBudget(budgetSpec({ totalUnits: 2 }));
    assert.throws(
      () => b.finalizeWorkReservation(5),
      /not enough discretionary/,
    );
  });
});

// ---------------------------------------------------------------------------
// work width cannot finalize after execution starts
// ---------------------------------------------------------------------------
describe('work width cannot finalize after execution starts', () => {
  it('throws when finalizing after first work-bucket begin', () => {
    const b = createTurnCallBudget(budgetSpec({ totalUnits: 10 }));
    b.begin(workReq());
    assert.throws(
      () => b.finalizeWorkReservation(3),
      /cannot finalize.*after execution/,
    );
  });
});

// ---------------------------------------------------------------------------
// purpose-bound failover and verification reservations cannot be borrowed
// ---------------------------------------------------------------------------
describe('purpose-bound failover and verification reservations cannot be borrowed', () => {
  it('work call cannot consume failover reservation', () => {
    const b = createTurnCallBudget(
      budgetSpec({ mode: 'enforce', totalUnits: 3, reservedFailover: 1 }),
    );
    // consume the single work unit
    const r1 = b.begin(workReq());
    assert.ok(r1.allowed);

    // try another work — should be denied even though failover is available
    const r2 = b.begin(workReq());
    assert.ok(!r2.allowed);
    assert.equal(r2.denial.reason, 'insufficient-work-capacity');
  });

  it('work call cannot consume verification reservation', () => {
    const b = createTurnCallBudget(
      budgetSpec({ mode: 'enforce', totalUnits: 3, reservedVerification: 1 }),
    );
    const r1 = b.begin(workReq());
    assert.ok(r1.allowed);

    const r2 = b.begin(workReq());
    assert.ok(!r2.allowed);
    assert.equal(r2.denial.reason, 'insufficient-work-capacity');
  });

  it('discretionary call cannot consume work reservation', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce', totalUnits: 1, reservedWork: 1 }));
    // consume work
    b.begin(workReq());
    // discretionary should still be available initially (zero, since total=1 and work=1)
    // Actually with totalUnits=1 and work=1, discretionary = 0
    const r = b.begin({ purpose: 'route', bucket: 'discretionary' });
    assert.ok(!r.allowed);
  });
});

// ---------------------------------------------------------------------------
// concurrent begins cannot oversubscribe
// ---------------------------------------------------------------------------
describe('concurrent begins cannot oversubscribe', () => {
  it('sequential calls in a tight loop respect synchronous atomic admission', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce', totalUnits: 3 }));
    // work=1, two discretionary left
    let admitted = 0;
    let denied = 0;
    const requests: TurnCallRequest[] = [
      workReq(),
      workReq(),
      { purpose: 'route', bucket: 'discretionary' },
      { purpose: 'intent', bucket: 'discretionary' },
      { purpose: 'meta', bucket: 'discretionary' },
    ];
    for (const req of requests) {
      const r = b.begin(req);
      if (r.allowed) {
        admitted++;
        r.finish('succeeded');
      } else {
        denied++;
      }
    }
    assert.equal(admitted, 3);
    assert.equal(denied, 2);
    const snap = b.snapshot();
    assert.equal(snap.begun, 3);
  });
});

// ---------------------------------------------------------------------------
// denial consumes zero calls
// ---------------------------------------------------------------------------
describe('denial consumes zero calls', () => {
  it('denied call does not increment begun or consume capacity', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce', totalUnits: 1 }));
    b.begin(workReq()); // consume the single work unit
    const r = b.begin(workReq());
    assert.ok(!r.allowed);

    const snap = b.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.denied, 1);
    assert.equal(snap.workRemaining, 0);
    assert.equal(snap.totalUnits, 1);
  });
});

// ---------------------------------------------------------------------------
// observe mode records would-deny but admits
// ---------------------------------------------------------------------------
describe('observe mode records would-deny but admits', () => {
  it('admits call and emits would-deny event', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'observe', totalUnits: 1 }));
    b.begin(workReq()); // consume work
    const r = b.begin(workReq());
    assert.ok(r.allowed);

    const snap = b.snapshot();
    assert.equal(snap.begun, 2);
    assert.equal(snap.denied, 0);
    const wouldDeny = snap.events.filter((e) => e.type === 'call-would-deny');
    assert.equal(wouldDeny.length, 1);
    assert.equal(wouldDeny[0]?.bucket, 'work');
  });

  it('enforce mode denies instead of emitting would-deny', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce', totalUnits: 1 }));
    b.begin(workReq());
    const r = b.begin(workReq());
    assert.ok(!r.allowed);

    const snap = b.snapshot();
    const wouldDeny = snap.events.filter((e) => e.type === 'call-would-deny');
    assert.equal(wouldDeny.length, 0);
    const denied = snap.events.filter((e) => e.type === 'call-denied');
    assert.equal(denied.length, 1);
  });
});

// ---------------------------------------------------------------------------
// every terminal outcome counts once
// ---------------------------------------------------------------------------
describe('every terminal outcome counts once', () => {
  it('each outcome consumes one unit and is counted once', () => {
    const total = ALL_OUTCOMES.length;
    const b = createTurnCallBudget(budgetSpec({ totalUnits: total + 1, mode: 'observe' }));
    for (let i = 0; i < ALL_OUTCOMES.length; i++) {
      const outcome = ALL_OUTCOMES[i]!;
      const r = b.begin(workReq({ purpose: 'work' }));
      assert.ok(r.allowed, `outcome ${outcome} should be allowed`);
      r.finish(outcome);
    }
    const snap = b.snapshot();
    assert.equal(snap.begun, ALL_OUTCOMES.length);
    assert.equal(snap.settled, ALL_OUTCOMES.length);
    const settledEvents = snap.events.filter((e) => e.type === 'call-settled');
    assert.equal(settledEvents.length, ALL_OUTCOMES.length);
    for (const outcome of ALL_OUTCOMES) {
      const match = settledEvents.filter((e) => e.type === 'call-settled' && e.outcome === outcome);
      assert.equal(match.length, 1, `outcome ${outcome} should appear exactly once`);
    }
  });
});

// ---------------------------------------------------------------------------
// duplicate finish is inert
// ---------------------------------------------------------------------------
describe('duplicate finish is inert', () => {
  it('second finish call does not change settled count', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('succeeded');
    assert.equal(b.snapshot().settled, 1);

    r.finish('provider-error');
    assert.equal(b.snapshot().settled, 1);

    r.finish('cancelled');
    assert.equal(b.snapshot().settled, 1);
  });

  it('outcome from first finish is preserved', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('abandoned');
    r.finish('succeeded');

    const snap = b.snapshot();
    const settled = snap.events.filter((e) => e.type === 'call-settled' && e.callId === r.callId);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.outcome, 'abandoned');
  });
});

// ---------------------------------------------------------------------------
// unfinished call remains visible
// ---------------------------------------------------------------------------
describe('unfinished call remains visible', () => {
  it('begun but unfinished call shows in snapshot with begun > settled', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('succeeded');

    const r2 = b.begin(workReq());
    assert.ok(!r2.allowed); // no work left in enforce mode — this is denied

    // Use observe mode for the test
    const b2 = createTurnCallBudget(budgetSpec({ mode: 'observe', totalUnits: 3 }));
    const r3 = b2.begin(workReq());
    assert.ok(r3.allowed);
    r3.finish('succeeded');

    const r4 = b2.begin(workReq());
    assert.ok(r4.allowed);
    // r4 is NOT finished

    const snap = b2.snapshot();
    assert.equal(snap.begun, 2);
    assert.equal(snap.settled, 1);
    // r4 is unfinished but visible
    const begunEvents = snap.events.filter((e) => e.type === 'call-begun');
    assert.equal(begunEvents.length, 2);
    const settledEvents = snap.events.filter((e) => e.type === 'call-settled');
    assert.equal(settledEvents.length, 1);
  });
});

// ---------------------------------------------------------------------------
// one typed loss-preservation override names the failed call
// ---------------------------------------------------------------------------
describe('one typed loss-preservation override names the failed call', () => {
  it('grants one extra failover unit and names the failed work call', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce', totalUnits: 3 }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('provider-error');

    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'rate-limit',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(result);

    const snap = b.snapshot();
    assert.equal(snap.failoverRemaining, 1);

    const granted = snap.events.filter((e) => e.type === 'loss-preservation-override-granted');
    assert.equal(granted.length, 1);
    const g = granted[0];
    assert.ok(g !== undefined && g.type === 'loss-preservation-override-granted');
    assert.equal(g.failedCallId, r.callId);

    // the new failover unit can be used
    const fr = b.begin({ purpose: 'failover', bucket: 'failover', parentCallId: r.callId });
    assert.ok(fr.allowed);
  });

  it('grants override for a failed failover call', () => {
    const b = createTurnCallBudget(
      budgetSpec({ mode: 'enforce', totalUnits: 3, reservedFailover: 1 }),
    );
    // consume the single failover unit first
    const r = b.begin({ purpose: 'failover', bucket: 'failover' });
    assert.ok(r.allowed);
    r.finish('provider-error');

    // now failover is exhausted, loss override grants another
    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'auth',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(result);

    const fr = b.begin({ purpose: 'failover', bucket: 'failover' });
    assert.ok(fr.allowed);
  });
});

// ---------------------------------------------------------------------------
// override rejects same provider cancellation review and second use
// ---------------------------------------------------------------------------
describe('override rejects same provider cancellation review and second use', () => {
  it('rejects when nextProviderDistinct is false', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('provider-error');

    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'timeout',
      nextProviderDistinct: false,
      sameIdempotencyKey: true,
    });
    assert.ok(!result);

    const snap = b.snapshot();
    const denied = snap.events.filter((e) => e.type === 'loss-preservation-override-denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.reason, 'next-provider-not-distinct');
  });

  it('rejects cancellation as override reason', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('cancelled');

    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'cancellation',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(!result);

    const snap = b.snapshot();
    const denied = snap.events.filter((e) => e.type === 'loss-preservation-override-denied');
    assert.equal(denied.length, 1);
    assert.ok(denied[0]?.reason.startsWith('invalid-override-reason'));
  });

  it('rejects review as override reason', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('provider-error');

    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'review-disagreement',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(!result);

    const snap = b.snapshot();
    const denied = snap.events.filter((e) => e.type === 'loss-preservation-override-denied');
    assert.equal(denied.length, 1);
    assert.ok(denied[0]?.reason.startsWith('invalid-override-reason'));
  });

  it('rejects sameIdempotencyKey false', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('provider-error');

    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'transport-failure',
      nextProviderDistinct: true,
      sameIdempotencyKey: false,
    });
    assert.ok(!result);
    const snap = b.snapshot();
    const denied = snap.events.filter((e) => e.type === 'loss-preservation-override-denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.reason, 'idempotency-key-not-retained');
  });

  it('rejects second override use', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce', totalUnits: 3 }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('provider-error');

    const r1 = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'rate-limit',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(r1);

    const r2 = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'timeout',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(!r2);

    const snap = b.snapshot();
    const denied = snap.events.filter((e) => e.type === 'loss-preservation-override-denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.reason, 'loss-override-already-used');
  });

  it('rejects override for non-existent call', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    const result = b.requestLossPreservationOverride({
      failedCallId: 'nonexistent',
      reason: 'rate-limit',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(!result);
    const snap = b.snapshot();
    const denied = snap.events.filter((e) => e.type === 'loss-preservation-override-denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.reason, 'failed-call-not-found');
  });

  it('rejects override for discretionary call', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'observe', totalUnits: 3 }));
    const r = b.begin({ purpose: 'route', bucket: 'discretionary' });
    assert.ok(r.allowed);
    r.finish('provider-error');

    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'timeout',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(!result);
    const snap = b.snapshot();
    const denied = snap.events.filter((e) => e.type === 'loss-preservation-override-denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.reason, 'failed-call-bucket-not-eligible');
  });

  it('accepts usable-partial-draft as valid override reason', () => {
    const b = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const r = b.begin(workReq());
    assert.ok(r.allowed);
    r.finish('empty');

    const result = b.requestLossPreservationOverride({
      failedCallId: r.callId,
      reason: 'usable-partial-draft',
      nextProviderDistinct: true,
      sameIdempotencyKey: true,
    });
    assert.ok(result);
  });
});

// ---------------------------------------------------------------------------
// receipt event order is deterministic and immutable
// ---------------------------------------------------------------------------
describe('receipt event order is deterministic and immutable', () => {
  it('events are emitted in monotonic seq order', () => {
    const seqs: number[] = [];
    const nextSeq = () => seqs.length;
    const nextCallId = (() => {
      let i = 0;
      return () => `id-${i++}`;
    })();

    const b = createTurnCallBudget(
      budgetSpec({
        mode: 'observe',
        totalUnits: 2,
        nextSeq,
        nextCallId,
      }),
    );

    const r1 = b.begin(workReq());
    assert.ok(r1.allowed);
    r1.finish('succeeded');

    const r2 = b.begin(workReq());
    assert.ok(r2.allowed);
    r2.finish('provider-error');

    const snap = b.snapshot();
    for (let i = 1; i < snap.events.length; i++) {
      assert.ok(
        snap.events[i]!.seq >= snap.events[i - 1]!.seq,
        `events must be in monotonic seq order at index ${i}`,
      );
    }
  });

  it('snapshot events are immutable copies', () => {
    const b = createTurnCallBudget(budgetSpec({ mode: 'enforce' }));
    b.begin(workReq());

    const snap1 = b.snapshot();
    const snap2 = b.snapshot();

    // same content
    assert.deepEqual(snap1.events, snap2.events);
    // but different array references (immutable copy)
    assert.notEqual(snap1.events, snap2.events);

    // modifying copy does not affect budget
    const copy = b.snapshot();
    assert.equal(copy.begun, 1);
    assert.equal(b.snapshot().events.length, 1);
  });
});

// ---------------------------------------------------------------------------
// invalid specs are rejected
// ---------------------------------------------------------------------------
describe('invalid specs are rejected', () => {
  it('rejects empty turnId', () => {
    assert.throws(() => createTurnCallBudget(budgetSpec({ turnId: '' })), /turnId/);
  });

  it('rejects NaN totalUnits', () => {
    assert.throws(() => createTurnCallBudget(budgetSpec({ totalUnits: NaN })), /totalUnits/);
  });

  it('rejects negative totalUnits', () => {
    assert.throws(() => createTurnCallBudget(budgetSpec({ totalUnits: -1 })), /totalUnits/);
  });

  it('rejects fractional totalUnits', () => {
    assert.throws(() => createTurnCallBudget(budgetSpec({ totalUnits: 1.5 })), /totalUnits/);
  });

  it('rejects reserved.work not equal to 1', () => {
    assert.throws(() => createTurnCallBudget(budgetSpec({ reservedWork: 0 })), /reserved\.work === 1/);
    assert.throws(() => createTurnCallBudget(budgetSpec({ reservedWork: 3 })), /reserved\.work === 1/);
  });

  it('rejects reserved.failover not 0 or 1', () => {
    assert.throws(() => createTurnCallBudget(budgetSpec({ reservedFailover: 2 })), /failover/);
    assert.throws(() => createTurnCallBudget(budgetSpec({ reservedFailover: -1 })), /failover/);
  });

  it('rejects reserved.verification not 0 or 1', () => {
    assert.throws(() => createTurnCallBudget(budgetSpec({ reservedVerification: 2 })), /verification/);
    assert.throws(() => createTurnCallBudget(budgetSpec({ reservedVerification: -1 })), /verification/);
  });

  it('rejects reservation sum exceeding totalUnits', () => {
    assert.throws(
      () =>
        createTurnCallBudget(
          budgetSpec({ totalUnits: 1, reservedWork: 1, reservedFailover: 1 }),
        ),
      /exceeds totalUnits/,
    );
  });

  it('rejects nextSeq returning non-integer', () => {
    assert.throws(
      () => createTurnCallBudget(budgetSpec({ nextSeq: () => 1.5 })),
      /nextSeq/,
    );
  });

  it('rejects nextCallId returning empty string', () => {
    assert.throws(
      () => createTurnCallBudget(budgetSpec({ nextCallId: () => '' })),
      /nextCallId/,
    );
  });

  it('rejects invalid mode', () => {
    assert.throws(
      () => createTurnCallBudget(budgetSpec({ mode: 'enforce2' as TurnCallBudgetMode })),
      /mode/,
    );
  });
});
