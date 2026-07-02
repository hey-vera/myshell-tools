/**
 * src/core/turn-call-budget.ts — P1-09a turn-call budget and event-ledger domain.
 *
 * PURE, DARK module: defines reservation, attempt, settlement, denial, release,
 * and loss-preservation semantics. No provider, I/O, environment, session,
 * evidence, or UI imports.
 */

export type TurnCallBucket = 'work' | 'failover' | 'verification' | 'discretionary';

export type TurnCallPurpose =
  | 'route'
  | 'intent'
  | 'reextract-local'
  | 'reextract-web'
  | 'recap'
  | 'understanding'
  | 'work'
  | 'work-repair'
  | 'failover'
  | 'review'
  | 'verify-critic'
  | 'panel-candidate'
  | 'panel-synthesis'
  | 'panel-repair'
  | 'hedge-primary'
  | 'hedge-secondary'
  | 'hedge-review'
  | 'hedge-repair'
  | 'judgment'
  | 'tribunal-build'
  | 'tribunal-review'
  | 'goal-decompose'
  | 'goal-objective'
  | 'goal-plan'
  | 'goal-replan'
  | 'autostage'
  | 'meta'
  | 'research-web';

export type TurnCallBudgetMode = 'observe' | 'enforce';

export interface TurnCallBudgetSpec {
  readonly turnId: string;
  readonly mode: TurnCallBudgetMode;
  readonly totalUnits: number;
  readonly reserved: {
    readonly work: number;
    readonly failover: 0 | 1;
    readonly verification: 0 | 1;
  };
  readonly nextSeq?: () => number;
  readonly nextCallId?: () => string;
}

export interface TurnCallRequest {
  readonly purpose: TurnCallPurpose;
  readonly bucket: TurnCallBucket;
  readonly parentCallId?: string;
  readonly metadata?: Record<string, unknown>;
}

export type TurnCallOutcome =
  | 'succeeded'
  | 'provider-error'
  | 'threw'
  | 'cancelled'
  | 'empty'
  | 'abandoned';

export interface TurnCallDenial {
  readonly reason: string;
}

export type TurnCallBudgetEvent =
  | {
      readonly type: 'call-begun';
      readonly seq: number;
      readonly callId: string;
      readonly purpose: TurnCallPurpose;
      readonly bucket: TurnCallBucket;
      readonly parentCallId?: string;
      readonly metadata?: Record<string, unknown>;
    }
  | {
      readonly type: 'call-would-deny';
      readonly seq: number;
      readonly purpose: TurnCallPurpose;
      readonly bucket: TurnCallBucket;
      readonly reason: string;
    }
  | {
      readonly type: 'call-denied';
      readonly seq: number;
      readonly purpose: TurnCallPurpose;
      readonly bucket: TurnCallBucket;
      readonly reason: string;
    }
  | {
      readonly type: 'call-settled';
      readonly seq: number;
      readonly callId: string;
      readonly outcome: TurnCallOutcome;
    }
  | {
      readonly type: 'work-reservation-finalized';
      readonly seq: number;
      readonly fromUnits: number;
      readonly toUnits: number;
    }
  | {
      readonly type: 'loss-preservation-override-granted';
      readonly seq: number;
      readonly failedCallId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'loss-preservation-override-denied';
      readonly seq: number;
      readonly reason: string;
      readonly failedCallId?: string;
    }
  | {
      readonly type: 'budget-released';
      readonly seq: number;
    };

export interface TurnCallBudgetReceipt {
  readonly turnId: string;
  readonly mode: TurnCallBudgetMode;
  readonly totalUnits: number;
  readonly begun: number;
  readonly settled: number;
  readonly denied: number;
  readonly workRemaining: number;
  readonly failoverRemaining: 0 | 1;
  readonly verificationRemaining: 0 | 1;
  readonly discretionaryRemaining: number;
  readonly released: boolean;
  readonly events: readonly TurnCallBudgetEvent[];
}

export interface LossPreservationOverrideRequest {
  readonly failedCallId: string;
  readonly reason: string;
  readonly nextProviderDistinct: boolean;
  readonly sameIdempotencyKey: boolean;
}

export interface TurnCallBudget {
  readonly begin: (
    request: TurnCallRequest,
  ) =>
    | { readonly allowed: true; readonly callId: string; readonly finish: (outcome: TurnCallOutcome) => void }
    | { readonly allowed: false; readonly denial: TurnCallDenial };
  readonly finalizeWorkReservation: (units: number) => void;
  readonly requestLossPreservationOverride: (request: LossPreservationOverrideRequest) => boolean;
  readonly release: () => void;
  readonly snapshot: () => TurnCallBudgetReceipt;
}

const VALID_LOSS_OVERRIDE_REASONS = new Set([
  'rate-limit',
  'auth',
  'timeout',
  'transport-failure',
  'usable-partial-draft',
]);

interface CallRecord {
  readonly id: string;
  readonly purpose: TurnCallPurpose;
  readonly bucket: TurnCallBucket;
  readonly parentCallId?: string;
  readonly metadata?: Record<string, unknown>;
  outcome: TurnCallOutcome | undefined;
  settled: boolean;
}

const EVENTS_SNAPSHOT_LIMIT = 10_000;

function validateSpec(spec: TurnCallBudgetSpec): void {
  if (typeof spec.turnId !== 'string' || spec.turnId.length === 0) {
    throw new TypeError('turnId must be a nonempty string');
  }
  if (spec.mode !== 'observe' && spec.mode !== 'enforce') {
    throw new TypeError('mode must be "observe" or "enforce"');
  }
  if (!Number.isFinite(spec.totalUnits) || spec.totalUnits < 0 || !Number.isInteger(spec.totalUnits)) {
    throw new TypeError('totalUnits must be a finite nonnegative integer');
  }
  const { work, failover, verification } = spec.reserved;
  if (!Number.isFinite(work) || work < 0 || !Number.isInteger(work)) {
    throw new TypeError('reserved.work must be a finite nonnegative integer');
  }
  if (work !== 1) {
    throw new TypeError('initial preflight spec requires reserved.work === 1');
  }
  if (failover !== 0 && failover !== 1) {
    throw new TypeError('reserved.failover must be 0 or 1');
  }
  if (verification !== 0 && verification !== 1) {
    throw new TypeError('reserved.verification must be 0 or 1');
  }
  if (work + failover + verification > spec.totalUnits) {
    throw new RangeError('reservation sum exceeds totalUnits');
  }
  if (spec.nextSeq !== undefined) {
    const val = spec.nextSeq();
    if (!Number.isFinite(val) || val < 0 || !Number.isInteger(val)) {
      throw new TypeError('nextSeq must return a finite nonnegative integer');
    }
  }
  if (spec.nextCallId !== undefined) {
    const val = spec.nextCallId();
    if (typeof val !== 'string' || val.length === 0) {
      throw new TypeError('nextCallId must return a nonempty string');
    }
  }
}

export function createTurnCallBudget(spec: TurnCallBudgetSpec): TurnCallBudget {
  validateSpec(spec);

  const turnId = spec.turnId;
  const mode = spec.mode;
  const totalUnits = spec.totalUnits;

  let workRemaining = spec.reserved.work;
  let failoverRemaining: 0 | 1 = spec.reserved.failover;
  let verificationRemaining: 0 | 1 = spec.reserved.verification;
  let discretionaryRemaining =
    totalUnits - spec.reserved.work - spec.reserved.failover - spec.reserved.verification;

  let workFinalized = false;
  let workExecutionStarted = false;
  let lossOverrideUsed = false;
  let released = false;

  let begun = 0;
  let settled = 0;
  let denied = 0;

  let seq = 0;
  let callIdCounter = 0;

  const events: TurnCallBudgetEvent[] = [];
  const calls = new Map<string, CallRecord>();

  const getNextSeq = spec.nextSeq ?? (() => seq++);
  const getNextCallId = spec.nextCallId ?? (() => `call-${callIdCounter++}`);

  function emitEvent(event: TurnCallBudgetEvent): void {
    if (events.length >= EVENTS_SNAPSHOT_LIMIT) return;
    events.push(event);
  }

  function checkBucketCapacity(bucket: TurnCallBucket): number {
    switch (bucket) {
      case 'work':
        return workRemaining;
      case 'failover':
        return failoverRemaining;
      case 'verification':
        return verificationRemaining;
      case 'discretionary':
        return discretionaryRemaining;
    }
  }

  function consumeBucket(bucket: TurnCallBucket): void {
    switch (bucket) {
      case 'work':
        workRemaining--;
        break;
      case 'failover':
        failoverRemaining = 0;
        break;
      case 'verification':
        verificationRemaining = 0;
        break;
      case 'discretionary':
        discretionaryRemaining--;
        break;
    }
  }

  function snapshot(): TurnCallBudgetReceipt {
    return {
      turnId,
      mode,
      totalUnits,
      begun,
      settled,
      denied,
      workRemaining,
      failoverRemaining,
      verificationRemaining,
      discretionaryRemaining,
      released,
      events: [...events],
    };
  }

  function begin(
    request: TurnCallRequest,
  ):
    | { readonly allowed: true; readonly callId: string; readonly finish: (outcome: TurnCallOutcome) => void }
    | { readonly allowed: false; readonly denial: TurnCallDenial } {
    if (released) {
      const denial: TurnCallDenial = { reason: 'budget-released' };
      emitEvent({
        type: 'call-denied',
        seq: getNextSeq(),
        purpose: request.purpose,
        bucket: request.bucket,
        reason: denial.reason,
      });
      denied++;
      return { allowed: false, denial };
    }

    const capacity = checkBucketCapacity(request.bucket);
    const canAdmit = capacity > 0;

    if (mode === 'enforce' && !canAdmit) {
      const denial: TurnCallDenial = { reason: `insufficient-${request.bucket}-capacity` };
      emitEvent({
        type: 'call-denied',
        seq: getNextSeq(),
        purpose: request.purpose,
        bucket: request.bucket,
        reason: denial.reason,
      });
      denied++;
      return { allowed: false, denial };
    }

    if (mode === 'observe' && !canAdmit) {
      emitEvent({
        type: 'call-would-deny',
        seq: getNextSeq(),
        purpose: request.purpose,
        bucket: request.bucket,
        reason: `insufficient-${request.bucket}-capacity`,
      });
    }

    if (request.bucket === 'work') {
      workExecutionStarted = true;
    }

    consumeBucket(request.bucket);
    const callId = getNextCallId();

    const begunEvent: TurnCallBudgetEvent = {
      type: 'call-begun',
      seq: getNextSeq(),
      callId,
      purpose: request.purpose,
      bucket: request.bucket,
      ...(request.parentCallId !== undefined ? { parentCallId: request.parentCallId } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    };
    emitEvent(begunEvent);

    begun++;

    const record: CallRecord = {
      id: callId,
      purpose: request.purpose,
      bucket: request.bucket,
      outcome: undefined,
      settled: false,
      ...(request.parentCallId !== undefined ? { parentCallId: request.parentCallId } : {}),
      ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
    };
    calls.set(callId, record);

    let finished = false;
    const finish = (outcome: TurnCallOutcome): void => {
      if (finished) return;
      finished = true;
      record.outcome = outcome;
      record.settled = true;
      settled++;
      emitEvent({
        type: 'call-settled',
        seq: getNextSeq(),
        callId,
        outcome,
      });
    };

    return { allowed: true, callId, finish };
  }

  function finalizeWorkReservation(units: number): void {
    if (workFinalized) {
      throw new Error('work reservation already finalized');
    }
    if (workExecutionStarted) {
      throw new Error('cannot finalize work reservation after execution has started');
    }
    if (!Number.isFinite(units) || units < 1 || !Number.isInteger(units)) {
      throw new TypeError('finalizeWorkReservation requires a positive integer');
    }
    const transfer = units - workRemaining;
    if (transfer > discretionaryRemaining) {
      throw new RangeError('not enough discretionary units to finalize work reservation');
    }
    const fromUnits = workRemaining;
    workRemaining = units;
    discretionaryRemaining -= transfer;
    workFinalized = true;
    emitEvent({
      type: 'work-reservation-finalized',
      seq: getNextSeq(),
      fromUnits,
      toUnits: units,
    });
  }

  function requestLossPreservationOverride(request: LossPreservationOverrideRequest): boolean {
    if (lossOverrideUsed) {
      emitEvent({
        type: 'loss-preservation-override-denied',
        seq: getNextSeq(),
        reason: 'loss-override-already-used',
      });
      return false;
    }

    const failedCall = calls.get(request.failedCallId);
    if (failedCall === undefined) {
      emitEvent({
        type: 'loss-preservation-override-denied',
        seq: getNextSeq(),
        reason: 'failed-call-not-found',
        failedCallId: request.failedCallId,
      });
      return false;
    }

    if (failedCall.bucket !== 'work' && failedCall.bucket !== 'failover') {
      emitEvent({
        type: 'loss-preservation-override-denied',
        seq: getNextSeq(),
        reason: 'failed-call-bucket-not-eligible',
        failedCallId: request.failedCallId,
      });
      return false;
    }

    if (!VALID_LOSS_OVERRIDE_REASONS.has(request.reason)) {
      emitEvent({
        type: 'loss-preservation-override-denied',
        seq: getNextSeq(),
        reason: `invalid-override-reason:${request.reason}`,
        failedCallId: request.failedCallId,
      });
      return false;
    }

    if (request.nextProviderDistinct !== true) {
      emitEvent({
        type: 'loss-preservation-override-denied',
        seq: getNextSeq(),
        reason: 'next-provider-not-distinct',
        failedCallId: request.failedCallId,
      });
      return false;
    }

    if (request.sameIdempotencyKey !== true) {
      emitEvent({
        type: 'loss-preservation-override-denied',
        seq: getNextSeq(),
        reason: 'idempotency-key-not-retained',
        failedCallId: request.failedCallId,
      });
      return false;
    }

    lossOverrideUsed = true;
    failoverRemaining = 1;

    emitEvent({
      type: 'loss-preservation-override-granted',
      seq: getNextSeq(),
      failedCallId: request.failedCallId,
      reason: request.reason,
    });

    return true;
  }

  function release(): void {
    if (released) return;
    released = true;
    emitEvent({
      type: 'budget-released',
      seq: getNextSeq(),
    });
  }

  return {
    begin,
    finalizeWorkReservation,
    requestLossPreservationOverride,
    release,
    snapshot,
  };
}
