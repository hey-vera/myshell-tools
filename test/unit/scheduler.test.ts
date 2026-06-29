/**
 * test/unit/scheduler.test.ts — the BOUNDED CONCURRENT MULTI-GOAL SCHEDULER.
 *
 * Coverage:
 *  - PURE planSchedule: activeLimit math, pressure lowering, partition, clamps.
 *  - PURE requeueBackoffMs: exponential growth + cap.
 *  - schedulerEnabled flag: smart auto default ON (for /goal), explicit OFF supported.
 *  - runSchedule (fake per-goal generators, no real model calls):
 *      · 3 goals, activeLimit=2 → exactly 2 concurrent, 3rd queued then pulled in.
 *      · every event correctly goalId-tagged; goal-enqueue + goal-phase emitted.
 *      · ESC mid-run cancels all active + queued never start.
 *      · a 429 requeues-with-backoff (waits, not hammered).
 *      · the merged stream reduces (via the REAL reducer) to the correct
 *        multi-goal UiState (2 running + 1 queued → all done).
 *
 * Run: node --experimental-strip-types --test test/unit/scheduler.test.ts
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  planSchedule,
  runSchedule,
  requeueBackoffMs,
  BASE_ACTIVE_LIMIT,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  type GoalSpec,
  type ScheduleDeps,
} from '../../src/core/scheduler.ts';
import { schedulerEnabled } from '../../src/interface/ui/scheduler-flag.ts';
import { RATE_LIMIT_COOLDOWN_MS } from '../../src/core/cooldown.ts';
import { initialState, type UiState } from '../../src/interface/ui/state.ts';
import { reduce } from '../../src/interface/ui/reduce.ts';
import { coreEventToActions } from '../../src/interface/ui/core-event.ts';
import type { CoreEvent } from '../../src/core/types.ts';
import type { ProviderId } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// PURE: planSchedule
// ---------------------------------------------------------------------------

function specs(...ids: string[]): GoalSpec[] {
  return ids.map((id) => ({ id, title: `goal ${id}` }));
}

describe('planSchedule — activeLimit math + partition', () => {
  it('base limit is min(BASE_ACTIVE_LIMIT, authedProviderCount) with no pressure', () => {
    const plan = planSchedule({ goals: specs('a', 'b', 'c'), pressure: 0, authedProviderCount: 3 });
    assert.equal(plan.activeLimit, BASE_ACTIVE_LIMIT); // 2 (capped below 3 providers)
    assert.deepEqual(plan.running.map((g) => g.id), ['a', 'b']);
    assert.deepEqual(plan.queued.map((g) => g.id), ['c']);
  });

  it('one signed-in provider ceilings the limit to 1', () => {
    const plan = planSchedule({ goals: specs('a', 'b', 'c'), pressure: 0, authedProviderCount: 1 });
    assert.equal(plan.activeLimit, 1);
    assert.deepEqual(plan.running.map((g) => g.id), ['a']);
    assert.deepEqual(plan.queued.map((g) => g.id), ['b', 'c']);
  });

  it('zero signed-in providers → 0 active, everything queued', () => {
    const plan = planSchedule({ goals: specs('a', 'b'), pressure: 0, authedProviderCount: 0 });
    assert.equal(plan.activeLimit, 0);
    assert.equal(plan.running.length, 0);
    assert.deepEqual(plan.queued.map((g) => g.id), ['a', 'b']);
  });

  it('high pressure (>=2) lowers the limit to 1 even with many providers', () => {
    const plan = planSchedule({ goals: specs('a', 'b', 'c'), pressure: 2, authedProviderCount: 3 });
    assert.equal(plan.activeLimit, 1);
    const plan3 = planSchedule({ goals: specs('a', 'b', 'c'), pressure: 3, authedProviderCount: 3 });
    assert.equal(plan3.activeLimit, 1);
  });

  it('light pressure (1) does NOT lower below the base ceiling', () => {
    const plan = planSchedule({ goals: specs('a', 'b', 'c'), pressure: 1, authedProviderCount: 3 });
    assert.equal(plan.activeLimit, BASE_ACTIVE_LIMIT);
  });

  it('never schedules more concurrent goals than there are goals', () => {
    const plan = planSchedule({ goals: specs('a'), pressure: 0, authedProviderCount: 3 });
    assert.equal(plan.activeLimit, 1);
    assert.deepEqual(plan.running.map((g) => g.id), ['a']);
    assert.equal(plan.queued.length, 0);
  });

  it('is total/defensive on garbage authed count', () => {
    const plan = planSchedule({ goals: specs('a', 'b'), pressure: 0, authedProviderCount: NaN });
    assert.equal(plan.activeLimit, 0);
  });
});

describe('planSchedule — additive maxActive clamp (D3: absent === today, present clamps)', () => {
  it('ABSENT maxActive is byte-identical to the 3.127 numbers (neutrality)', () => {
    // Mirror the exact scenarios pinned above; assert maxActive-absent matches.
    assert.equal(
      planSchedule({ goals: specs('a', 'b', 'c'), pressure: 0, authedProviderCount: 3 }).activeLimit,
      BASE_ACTIVE_LIMIT,
    );
    assert.equal(
      planSchedule({ goals: specs('a', 'b', 'c'), pressure: 0, authedProviderCount: 1 }).activeLimit,
      1,
    );
    assert.equal(
      planSchedule({ goals: specs('a', 'b'), pressure: 0, authedProviderCount: 0 }).activeLimit,
      0,
    );
    assert.equal(
      planSchedule({ goals: specs('a', 'b', 'c'), pressure: 2, authedProviderCount: 3 }).activeLimit,
      1,
    );
    assert.equal(
      planSchedule({ goals: specs('a'), pressure: 0, authedProviderCount: 3 }).activeLimit,
      1,
    );
  });

  it('explicit undefined maxActive equals omitting it', () => {
    const omitted = planSchedule({ goals: specs('a', 'b', 'c'), pressure: 0, authedProviderCount: 3 });
    const explicit = planSchedule({
      goals: specs('a', 'b', 'c'),
      pressure: 0,
      authedProviderCount: 3,
      maxActive: undefined,
    });
    assert.deepEqual(explicit, omitted);
  });

  it('PRESENT maxActive can only LOWER the limit (and re-partitions running/queued)', () => {
    const plan = planSchedule({
      goals: specs('a', 'b', 'c'),
      pressure: 0,
      authedProviderCount: 3, // base limit would be 2
      maxActive: 1,
    });
    assert.equal(plan.activeLimit, 1);
    assert.deepEqual(plan.running.map((g) => g.id), ['a']);
    assert.deepEqual(plan.queued.map((g) => g.id), ['b', 'c']);
  });

  it('a maxActive ABOVE the computed limit never raises it', () => {
    const plan = planSchedule({
      goals: specs('a', 'b', 'c'),
      pressure: 0,
      authedProviderCount: 1, // limit ceilinged to 1 by providers
      maxActive: 5,
    });
    assert.equal(plan.activeLimit, 1);
  });

  it('maxActive 0 forces single-file off (nothing runs)', () => {
    const plan = planSchedule({
      goals: specs('a', 'b'),
      pressure: 0,
      authedProviderCount: 2,
      maxActive: 0,
    });
    assert.equal(plan.activeLimit, 0);
    assert.equal(plan.running.length, 0);
    assert.deepEqual(plan.queued.map((g) => g.id), ['a', 'b']);
  });

  it('a garbage maxActive (NaN/negative) degrades to 0, never uncapped', () => {
    assert.equal(
      planSchedule({ goals: specs('a', 'b'), pressure: 0, authedProviderCount: 2, maxActive: NaN }).activeLimit,
      0,
    );
    assert.equal(
      planSchedule({ goals: specs('a', 'b'), pressure: 0, authedProviderCount: 2, maxActive: -3 }).activeLimit,
      0,
    );
  });
});

describe('requeueBackoffMs — exponential growth + cap', () => {
  it('doubles each requeue from the base', () => {
    assert.equal(requeueBackoffMs(0), BASE_BACKOFF_MS);
    assert.equal(requeueBackoffMs(1), BASE_BACKOFF_MS * 2);
    assert.equal(requeueBackoffMs(2), BASE_BACKOFF_MS * 4);
  });
  it('caps at MAX_BACKOFF_MS', () => {
    assert.equal(requeueBackoffMs(100), MAX_BACKOFF_MS);
  });
  it('is total on garbage input', () => {
    assert.equal(requeueBackoffMs(-5), BASE_BACKOFF_MS);
    assert.equal(requeueBackoffMs(NaN), BASE_BACKOFF_MS);
  });
});

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

describe('schedulerEnabled — smart auto default (ON), explicit off supported', () => {
  it('defaults ON (smart auto) with no env and no config', () => {
    assert.equal(schedulerEnabled({}, {}), true);
    assert.equal(schedulerEnabled(undefined, undefined), true);
  });
  it('ON for explicit opt-in env values', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'yes', ' On ']) {
      assert.equal(schedulerEnabled({ MYSHELL_SCHEDULER: v }, {}), true, `expected ${v} → true`);
    }
  });
  it('OFF only for explicit opt-out values (forces sequential)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' Off ']) {
      assert.equal(schedulerEnabled({ MYSHELL_SCHEDULER: v }, {}), false, `expected ${v} → false`);
    }
  });
  it('ON when config.experimentalScheduler === true, OFF when false', () => {
    assert.equal(schedulerEnabled({}, { experimentalScheduler: true }), true);
    assert.equal(schedulerEnabled({}, { experimentalScheduler: false }), false);
  });
});

// ---------------------------------------------------------------------------
// runSchedule fakes
// ---------------------------------------------------------------------------

/** A mutable fake clock + sleep that advances it (deterministic, no real timers). */
function makeFakeTime(): { now: () => number; sleep: (ms: number) => Promise<void>; clock: { ms: number } } {
  const clock = { ms: 0 };
  return {
    clock,
    now: () => clock.ms,
    sleep: async (ms: number) => {
      clock.ms += Math.max(0, ms);
    },
  };
}

interface FakeGoalOpts {
  /** Emit a tier-start + N provider-events + tier-done before the final. */
  readonly providerEvents?: number;
  /** The final's success flag (default true). */
  readonly success?: boolean;
  /** Set a rate-limit failure final (errorCategory 'rate-limit'). */
  readonly rateLimit?: boolean;
  /** The provider blamed on a rate-limit final. */
  readonly provider?: ProviderId;
  /** Called the instant this goal's generator starts (for concurrency assertions). */
  readonly onStart?: () => void;
  /** A gate the generator awaits AFTER tier-start, before finishing (to hold a slot open). */
  readonly hold?: Promise<void>;
}

/**
 * Build a fake per-goal generator factory. It honestly emits the orchestrate-
 * shaped event sequence (tier-start → provider-event* → tier-done → final) with
 * NO goalId set (orchestrate never sets it — the scheduler stamps it). Respects
 * the child AbortSignal: if aborted it emits a canceled final and returns.
 */
function makeRunGoal(byId: Record<string, FakeGoalOpts>): ScheduleDeps['runGoal'] {
  return async function* runGoal(spec, signal) {
    const opts = byId[spec.id] ?? {};
    opts.onStart?.();
    const tier = 'ic' as const;
    const provider: ProviderId = opts.provider ?? 'claude';

    if (signal.aborted) {
      yield { type: 'final', success: false, output: 'cancelled', tier, totalCostUsd: 0, sessionId: 's', attempts: 0, canceled: true };
      return;
    }

    yield { type: 'tier-start', tier, provider, model: 'm', attempt: 1, title: spec.title };
    for (let i = 0; i < (opts.providerEvents ?? 0); i++) {
      yield { type: 'provider-event', tier, event: { type: 'text', delta: `chunk ${i}` } };
      if (signal.aborted) {
        yield { type: 'final', success: false, output: 'cancelled', tier, totalCostUsd: 0, sessionId: 's', attempts: 1, canceled: true };
        return;
      }
    }

    if (opts.hold !== undefined) await opts.hold;

    if (signal.aborted) {
      yield { type: 'final', success: false, output: 'cancelled', tier, totalCostUsd: 0, sessionId: 's', attempts: 1, canceled: true };
      return;
    }

    yield { type: 'tier-done', tier, success: opts.success ?? !opts.rateLimit, confidence: 0.9, costUsd: 0, inputTokens: 100, outputTokens: 50, durationMs: 10 };

    if (opts.rateLimit === true) {
      yield { type: 'final', success: false, output: 'rate limited', tier, totalCostUsd: 0, sessionId: 's', attempts: 1, errorCategory: 'rate-limit', provider };
      return;
    }
    yield { type: 'final', success: opts.success ?? true, output: `done ${spec.id}`, tier, totalCostUsd: 0, sessionId: 's', attempts: 1 };
  };
}

async function drain(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// runSchedule — bounded concurrency
// ---------------------------------------------------------------------------

describe('runSchedule — bounded concurrency (3 goals, activeLimit=2)', () => {
  it('runs exactly 2 concurrently, queues the 3rd, then pulls it into the freed slot', async () => {
    const time = makeFakeTime();
    // Hold goals a + b open until we release them, so the 3rd cannot start early.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const holdA = new Promise<void>((r) => (releaseA = r));
    const holdB = new Promise<void>((r) => (releaseB = r));

    const started: string[] = [];
    const runGoal = makeRunGoal({
      a: { hold: holdA, onStart: () => started.push('a') },
      b: { hold: holdB, onStart: () => started.push('b') },
      c: { onStart: () => started.push('c') },
    });

    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex', 'opencode'], // 3 providers → ceiling 2
      now: time.now,
      sleep: time.sleep,
    };

    const gen = runSchedule(specs('a', 'b', 'c'), deps, new AbortController().signal);

    // Pull events until both a and b have started but neither has finished. At
    // that point c MUST NOT have started (activeLimit=2 is saturated).
    const collected: CoreEvent[] = [];
    // Step the generator manually so we can release holds at the right moment.
    const next = async (): Promise<CoreEvent | undefined> => {
      const r = await gen.next();
      if (r.done) return undefined;
      collected.push(r.value);
      return r.value;
    };

    // Consume the up-front goal-enqueue/goal-phase + the first two tier-starts.
    // We loop until we've seen tier-start for both a and b.
    const seenTierStart = new Set<string>();
    while (seenTierStart.size < 2) {
      const ev = await next();
      assert.ok(ev !== undefined, 'stream ended before both goals started');
      if (ev.type === 'tier-start' && ev.goalId !== undefined) seenTierStart.add(ev.goalId);
    }
    assert.deepEqual([...seenTierStart].sort(), ['a', 'b']);
    // c must NOT have started yet — the pool is full at 2.
    assert.equal(started.includes('c'), false, 'goal c started before a slot freed');

    // Release a → its slot frees → c should be pulled in.
    releaseA();
    releaseB();
    // Drain the rest.
    for (;;) {
      const ev = await next();
      if (ev === undefined) break;
    }

    // c eventually started (pulled into a freed slot).
    assert.ok(started.includes('c'), 'goal c was never pulled into the freed slot');
    // All three reached a successful final.
    const finals = collected.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.equal(finals.length, 3);
    assert.deepEqual(finals.map((f) => f.goalId).sort(), ['a', 'b', 'c']);
    assert.ok(finals.every((f) => f.success === true));
  });

  it('tags EVERY tier-start/tier-done/provider-event/final with the right goalId; emits goal-enqueue + goal-phase', async () => {
    const time = makeFakeTime();
    const runGoal = makeRunGoal({
      a: { providerEvents: 2 },
      b: { providerEvents: 1 },
      c: {},
    });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'],
      now: time.now,
      sleep: time.sleep,
    };
    const events = await drain(runSchedule(specs('a', 'b', 'c'), deps, new AbortController().signal));

    // goal-enqueue for all three up front.
    const enqueued = events.filter((e) => e.type === 'goal-enqueue').map((e) => (e as Extract<CoreEvent, { type: 'goal-enqueue' }>).id);
    assert.deepEqual(enqueued.slice(0, 3).sort(), ['a', 'b', 'c']);

    // goal-phase emitted (seed 0/1 up front + 1/1 on completion).
    const phases = events.filter((e) => e.type === 'goal-phase');
    assert.ok(phases.length >= 3, 'expected at least one goal-phase per goal');
    assert.ok(phases.some((e) => (e as Extract<CoreEvent, { type: 'goal-phase' }>).current === 1));

    // EVERY tier-start/tier-done/provider-event/final carries a goalId.
    for (const ev of events) {
      if (ev.type === 'tier-start' || ev.type === 'tier-done' || ev.type === 'provider-event' || ev.type === 'final') {
        assert.ok(ev.goalId !== undefined, `event ${ev.type} missing goalId`);
        assert.ok(['a', 'b', 'c'].includes(ev.goalId), `unexpected goalId ${ev.goalId}`);
      }
    }
    // a's provider-events are tagged to a, not bleeding into b/c.
    const aProvEvents = events.filter((e) => e.type === 'provider-event' && e.goalId === 'a');
    assert.equal(aProvEvents.length, 2);
  });
});

// ---------------------------------------------------------------------------
// runSchedule — maxActive dep threading (D6)
// ---------------------------------------------------------------------------

describe('runSchedule — maxActive dep lowers the live active limit (D6)', () => {
  it('maxActive=1 forces single-file even with 3 providers + 3 goals', async () => {
    const time = makeFakeTime();
    // Hold the first goal open; with maxActive=1 NO second goal may start until
    // the held slot frees.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));

    const started: string[] = [];
    const runGoal = makeRunGoal({
      a: { hold, onStart: () => started.push('a') },
      b: { onStart: () => started.push('b') },
      c: { onStart: () => started.push('c') },
    });

    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex', 'opencode'], // raw ceiling would be 2
      now: time.now,
      sleep: time.sleep,
      maxActive: 1, // D6 cross-goal cap → single-file
    };

    const gen = runSchedule(specs('a', 'b', 'c'), deps, new AbortController().signal);
    const next = async (): Promise<CoreEvent | undefined> => {
      const r = await gen.next();
      return r.done ? undefined : r.value;
    };

    // Pull until the first goal has started.
    while (!started.includes('a')) {
      const ev = await next();
      assert.ok(ev !== undefined, 'stream ended before the first goal started');
    }
    // With maxActive=1, NO second goal may start while the first holds its slot.
    assert.equal(started.includes('b'), false, 'a second goal started despite maxActive=1');
    assert.equal(started.includes('c'), false, 'a third goal started despite maxActive=1');

    release();
    for (;;) {
      const ev = await next();
      if (ev === undefined) break;
    }
    // All three still complete — capping lowers concurrency, never drops goals.
    assert.deepEqual([...started].sort(), ['a', 'b', 'c']);
  });

  it('ABSENT maxActive keeps today\'s numbers — 2 concurrent with 3 providers + 3 goals', async () => {
    const time = makeFakeTime();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const holdA = new Promise<void>((r) => (releaseA = r));
    const holdB = new Promise<void>((r) => (releaseB = r));

    const started: string[] = [];
    const runGoal = makeRunGoal({
      a: { hold: holdA, onStart: () => started.push('a') },
      b: { hold: holdB, onStart: () => started.push('b') },
      c: { onStart: () => started.push('c') },
    });

    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex', 'opencode'],
      now: time.now,
      sleep: time.sleep,
      // maxActive ABSENT → byte-identical to the pre-D6 path (ceiling = 2).
    };

    const gen = runSchedule(specs('a', 'b', 'c'), deps, new AbortController().signal);
    const next = async (): Promise<CoreEvent | undefined> => {
      const r = await gen.next();
      return r.done ? undefined : r.value;
    };

    // Two goals start concurrently (raw ceiling 2); the 3rd is held back.
    while (started.length < 2) {
      const ev = await next();
      assert.ok(ev !== undefined, 'stream ended before two goals started');
    }
    assert.deepEqual([...started].sort(), ['a', 'b']);
    assert.equal(started.includes('c'), false, 'the 3rd goal started before a slot freed');

    releaseA();
    releaseB();
    for (;;) {
      const ev = await next();
      if (ev === undefined) break;
    }
    assert.deepEqual([...started].sort(), ['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// runSchedule — cancellation (ESC)
// ---------------------------------------------------------------------------

describe('runSchedule — ESC cancels all active + queued never start', () => {
  it('aborting mid-run stops active goals and never starts queued ones', async () => {
    const time = makeFakeTime();
    const ac = new AbortController();

    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => (releaseA = r));

    const started: string[] = [];
    const runGoal = makeRunGoal({
      a: { hold: holdA, onStart: () => started.push('a') },
      b: { hold: holdA, onStart: () => started.push('b') },
      c: { onStart: () => started.push('c') },
      d: { onStart: () => started.push('d') },
    });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'], // ceiling 2 → a,b active; c,d queued
      now: time.now,
      sleep: time.sleep,
    };

    const gen = runSchedule(specs('a', 'b', 'c', 'd'), deps, ac.signal);
    const collected: CoreEvent[] = [];

    // Step until both a and b have started.
    const seen = new Set<string>();
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      collected.push(r.value);
      if (r.value.type === 'tier-start' && r.value.goalId !== undefined) seen.add(r.value.goalId);
      if (seen.size >= 2) break;
    }
    assert.deepEqual([...seen].sort(), ['a', 'b']);

    // ESC: abort, then release the holds so the (now-aborted) gens can finish.
    ac.abort();
    releaseA();

    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      collected.push(r.value);
    }

    // Queued goals c and d NEVER started.
    assert.equal(started.includes('c'), false, 'queued goal c started after abort');
    assert.equal(started.includes('d'), false, 'queued goal d started after abort');

    // Active goals a and b ended in a canceled final.
    const finals = collected.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(finals.every((f) => f.canceled === true), 'active goals should be canceled');
    assert.deepEqual(finals.map((f) => f.goalId).sort(), ['a', 'b']);

    // An honest cancel notice was emitted.
    assert.ok(
      collected.some((e) => e.type === 'notice' && e.level === 'warn' && /cancel/i.test(e.message)),
      'expected a cancel notice',
    );
  });

  it('abort BEFORE any goal starts → no goal runs, cancel notice emitted', async () => {
    const time = makeFakeTime();
    const ac = new AbortController();
    ac.abort();
    const started: string[] = [];
    const runGoal = makeRunGoal({ a: { onStart: () => started.push('a') } });
    const deps: ScheduleDeps = { runGoal, authedProviders: ['claude'], now: time.now, sleep: time.sleep };
    const events = await drain(runSchedule(specs('a', 'b'), deps, ac.signal));
    assert.equal(started.length, 0, 'no goal should start when aborted up front');
    assert.ok(events.some((e) => e.type === 'notice' && /cancel/i.test((e as Extract<CoreEvent, { type: 'notice' }>).message)));
    // Cards still enqueued up front (honest: the user sees what was planned).
    assert.equal(events.filter((e) => e.type === 'goal-enqueue').length, 2);
  });
});

// ---------------------------------------------------------------------------
// runSchedule — 429 requeue-with-backoff (queue, don't hammer)
// ---------------------------------------------------------------------------

describe('runSchedule — a 429 requeues with backoff (not hammered)', () => {
  it('a rate-limited goal is requeued, waits a backoff, then succeeds on retry', async () => {
    const time = makeFakeTime();
    // Goal a fails with a rate-limit the FIRST time, succeeds the SECOND.
    let aAttempts = 0;
    const sleeps: number[] = [];
    const recordingSleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      time.clock.ms += Math.max(0, ms);
    };

    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, signal) {
      if (spec.id === 'a') {
        aAttempts++;
        if (aAttempts === 1) {
          yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
          yield { type: 'final', success: false, output: 'rl', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1, errorCategory: 'rate-limit', provider: 'claude' };
          return;
        }
      }
      if (signal.aborted) {
        yield { type: 'final', success: false, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 0, canceled: true };
        return;
      }
      yield { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'm', attempt: 1, title: spec.title };
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };

    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'],
      now: time.now,
      sleep: recordingSleep,
    };

    const events = await drain(runSchedule(specs('a'), deps, new AbortController().signal));

    // a ran twice (failed-soft once, then succeeded) — NOT hammered in a tight loop.
    assert.equal(aAttempts, 2, 'goal a should run exactly twice (one requeue)');

    // A backoff sleep of >= BASE_BACKOFF_MS happened (queue, don't hammer).
    assert.ok(sleeps.some((ms) => ms >= BASE_BACKOFF_MS), `expected a backoff wait >= ${BASE_BACKOFF_MS}, saw ${JSON.stringify(sleeps)}`);

    // A requeue notice was emitted, and a's final ultimately succeeded.
    assert.ok(events.some((e) => e.type === 'notice' && /rate limit|requeued/i.test((e as Extract<CoreEvent, { type: 'notice' }>).message)));
    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    const lastA = [...finals].reverse().find((f) => f.goalId === 'a');
    assert.ok(lastA !== undefined && lastA.success === true, 'goal a should ultimately succeed after backoff');
  });
});

// ---------------------------------------------------------------------------
// runSchedule — reduces (via the REAL reducer) to the correct multi-goal UiState
// ---------------------------------------------------------------------------

describe('runSchedule → real reducer → correct multi-goal UiState', () => {
  it('2 running + 1 queued resolves to 3 done goals, each keyed by its goalId', async () => {
    const time = makeFakeTime();
    const runGoal = makeRunGoal({ a: {}, b: {}, c: {} });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'], // ceiling 2 → a,b run; c queued
      now: time.now,
      sleep: time.sleep,
    };
    const events = await drain(runSchedule(specs('a', 'b', 'c'), deps, new AbortController().signal));

    // Fold the merged stream through the SAME core-event→action map + reducer the
    // live Ink UI uses.
    let state: UiState = initialState;
    for (const ev of events) {
      for (const action of coreEventToActions(ev)) {
        state = reduce(state, action);
      }
    }

    // Three distinct goal cards, keyed by the scheduler-assigned goalIds.
    const ids = state.goals.map((g) => g.id).sort();
    assert.deepEqual(ids, ['a', 'b', 'c']);
    // All three settled to done.
    assert.ok(state.goals.every((g) => g.state === 'done'), `expected all done, got ${state.goals.map((g) => `${g.id}:${g.state}`).join(', ')}`);
    // Labels carried through from the goal titles.
    assert.ok(state.goals.every((g) => g.label.includes('goal ')));
  });
});

// ===========================================================================
// ADVERSARIAL TESTS — the dangerous cases the happy-path suite did NOT cover.
// Each FAILS against the pre-fix scheduler and PASSES after the fix.
// ===========================================================================

// ---------------------------------------------------------------------------
// [CRITICAL-1] A goal generator that THROWS is ISOLATED.
// ---------------------------------------------------------------------------

describe('runSchedule — [CRITICAL-1] a throwing goal is isolated (siblings + queued still complete; no leak)', () => {
  it('a goal generator that throws becomes a tagged FAILED final; siblings + queued goals still finish; no controller leak', async () => {
    const time = makeFakeTime();
    const started: string[] = [];
    // Track every child signal the runner is handed, so we can prove on exit that
    // NO sibling controller was left un-aborted (leaked).
    const childSignals: Array<{ id: string; signal: AbortSignal }> = [];

    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, signal) {
      started.push(spec.id);
      childSignals.push({ id: spec.id, signal });
      if (spec.id === 'boom') {
        // THROW mid-stream — pre-fix this rejected the Promise.race, escaped
        // runSchedule, and stranded the siblings.
        yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
        throw new Error('kaboom');
      }
      if (signal.aborted) {
        yield { type: 'final', success: false, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 0, canceled: true };
        return;
      }
      yield { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'm', attempt: 1, title: spec.title };
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };

    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'], // ceiling 2 → boom + ok1 active, ok2 queued
      now: time.now,
      sleep: time.sleep,
    };

    // runSchedule must NOT reject — it must absorb the throw.
    const events = await drain(
      runSchedule(specs('boom', 'ok1', 'ok2'), deps, new AbortController().signal),
    );

    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    const byGoal = new Map(finals.map((f) => [f.goalId, f]));

    // The throwing goal got a SYNTHETIC tagged FAILED final (not a crash, not silent).
    const boomFinal = byGoal.get('boom');
    assert.ok(boomFinal !== undefined, 'boom must get a tagged final');
    assert.equal(boomFinal.success, false, 'boom final must be FAILED');
    assert.ok(/crash|kaboom/i.test(boomFinal.output), `boom final should mention the crash, got ${boomFinal.output}`);

    // Both siblings + the queued goal STILL completed successfully (not stranded).
    assert.ok(byGoal.get('ok1')?.success === true, 'sibling ok1 must still complete');
    assert.ok(byGoal.get('ok2')?.success === true, 'queued ok2 must still be pulled in + complete');
    assert.ok(started.includes('ok2'), 'queued goal ok2 was never started after the sibling threw');

    // NO leak: every child controller the scheduler created is aborted on exit
    // (the try/finally fan-out). A leaked sibling would still be un-aborted here.
    for (const { id, signal } of childSignals) {
      assert.equal(signal.aborted, true, `child controller for "${id}" was leaked (never aborted) on exit`);
    }
  });
});

// ---------------------------------------------------------------------------
// [CRITICAL-2] ESC + an UNCOOPERATIVE (never-returns) generator → prompt terminate.
// ---------------------------------------------------------------------------

describe('runSchedule — [CRITICAL-2] ESC terminates promptly even when a generator ignores the signal', () => {
  it('an uncooperative generator (ignores signal, never returns) is force-.return()-ed and runSchedule terminates', async () => {
    const time = makeFakeTime();
    const ac = new AbortController();

    // Track .return() INVOCATION (the scheduler called it) + finally execution
    // (the cleanup actually ran) per goal.
    const returnCalled = new Set<string>();
    const finallyRan = new Set<string>();

    // An UNCOOPERATIVE generator: it ignores signal.aborted entirely and would
    // loop forever emitting events on its own (never self-finalizes). Pre-fix the
    // scheduler trusted children to finalize and would drain this forever → hang.
    // We WRAP it so we can observe that the scheduler INVOKES .return() on it.
    const baseRunGoal: ScheduleDeps['runGoal'] = async function* (spec, _signal) {
      try {
        yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
        // Uncooperative: ignore abort, emit forever.
        for (;;) {
          yield { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: 'never-ending' } };
        }
      } finally {
        // .return() resumes us at the suspended yield → finally runs → cleanup.
        finallyRan.add(spec.id);
      }
    };
    const runGoal: ScheduleDeps['runGoal'] = (spec, signal) => {
      const inner = baseRunGoal(spec, signal);
      const origReturn = inner.return.bind(inner);
      inner.return = ((value?: unknown) => {
        returnCalled.add(spec.id); // observe the scheduler force-terminating us
        return origReturn(value as never);
      }) as typeof inner.return;
      return inner;
    };

    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'], // ceiling 2 → a,b active, c queued
      now: time.now,
      sleep: time.sleep,
    };

    const gen = runSchedule(specs('a', 'b', 'c'), deps, ac.signal);

    // Step until both a and b have started (tier-start each).
    const seen = new Set<string>();
    const collected: CoreEvent[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      collected.push(r.value);
      if (r.value.type === 'tier-start' && r.value.goalId !== undefined) seen.add(r.value.goalId);
      if (seen.size >= 2) break;
    }
    assert.deepEqual([...seen].sort(), ['a', 'b'], 'both uncooperative goals must have started');

    // ESC.
    ac.abort();

    // The scheduler MUST terminate promptly (drive to done) WITHOUT the children
    // ever self-finalizing. If CRITICAL-2 regressed this loops forever (timeout).
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      collected.push(r.value);
    }

    // Every live generator was force-.return()-ed (the scheduler called .return),
    // and because these were suspended at a YIELD the .return() ran their finally.
    assert.ok(returnCalled.has('a') && returnCalled.has('b'), `both gens must be .return()-ed, got ${[...returnCalled].join(',')}`);
    assert.ok(finallyRan.has('a') && finallyRan.has('b'), 'each gen finally/cleanup must have run');

    // Honest tagged canceled finals were emitted for the goals we terminated.
    const finals = collected.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.deepEqual(finals.map((f) => f.goalId).sort(), ['a', 'b']);
    assert.ok(finals.every((f) => f.canceled === true), 'forced-terminated goals should be canceled finals');

    // And a cancel notice.
    assert.ok(collected.some((e) => e.type === 'notice' && /cancel/i.test((e as Extract<CoreEvent, { type: 'notice' }>).message)));
  });
});

// ---------------------------------------------------------------------------
// [HIGH-3] Concurrency RECOVERS (activeLimit climbs back) after a cooldown lapses.
// ---------------------------------------------------------------------------

describe('runSchedule — [HIGH-3] concurrency recovers after a 429 cooldown lapses', () => {
  it('activeLimit returns to base once the cooldown window passes (degrade AND recover)', async () => {
    // We assert recovery via OBSERVED concurrency: with 2 providers the base
    // ceiling is 2. A single transient 429 (one provider cooling) raises pressure
    // to 1 (does NOT lower the base of 2 by planSchedule's math), but TWO
    // simultaneous cool-downs would raise pressure to >=2 → cap 1. We prove the
    // cap is NOT stuck at 1 forever: after the cooldown window elapses, two goals
    // run concurrently again.
    const time = makeFakeTime();

    // Phase 1: goals x and y BOTH hit a rate limit on their first run (two distinct
    // providers cooling → pressure >=2 → cap drops to 1). They then succeed on the
    // requeue AFTER the cooldown window has elapsed.
    const attempts = new Map<string, number>();
    const concurrentNow = { live: 0, max: 0 };

    let releaseLate!: () => void;
    const lateHold = new Promise<void>((r) => (releaseLate = r));

    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, signal) {
      const n = (attempts.get(spec.id) ?? 0) + 1;
      attempts.set(spec.id, n);
      const provider: ProviderId = spec.id === 'x' ? 'claude' : 'codex';
      if (n === 1) {
        // First run: 429 → cooldown that provider.
        yield { type: 'tier-start', tier: 'ic', provider, model: 'm', attempt: 1, title: spec.title };
        yield { type: 'final', success: false, output: 'rl', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1, errorCategory: 'rate-limit', provider };
        return;
      }
      // Requeued run: count concurrency to prove the cap recovered to >=2.
      concurrentNow.live++;
      concurrentNow.max = Math.max(concurrentNow.max, concurrentNow.live);
      if (signal.aborted) { concurrentNow.live--; yield { type: 'final', success: false, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 0, canceled: true }; return; }
      yield { type: 'tier-start', tier: 'ic', provider, model: 'm', attempt: 2, title: spec.title };
      // Hold both requeued goals open simultaneously so the concurrency counter
      // can observe 2-at-once IF the cap recovered.
      await lateHold;
      concurrentNow.live--;
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 2 };
    };

    // Advancing sleep: a backoff sleep pushes the clock PAST the 5-min cooldown so
    // by the time the goals are retried their providers are no longer cooling.
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      time.clock.ms += Math.max(0, ms) + RATE_LIMIT_COOLDOWN_MS; // ensure cooldown lapses
    };

    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'],
      now: time.now,
      sleep,
    };

    const gen = runSchedule(specs('x', 'y'), deps, new AbortController().signal);
    const collected: CoreEvent[] = [];
    // Drive until both requeued goals are live (concurrency observed) then release.
    const pump = (async () => {
      for (;;) {
        const r = await gen.next();
        if (r.done) break;
        collected.push(r.value);
      }
    })();
    // Let the microtask queue settle so both requeued goals reach the hold.
    for (let i = 0; i < 50 && concurrentNow.max < 2; i++) await Promise.resolve();
    releaseLate();
    await pump;

    // RECOVERY: two goals ran concurrently AGAIN after the cooldown lapsed — the
    // cap was NOT permanently pinned at 1.
    assert.equal(concurrentNow.max, 2, `expected concurrency to recover to 2 after cooldown, saw ${concurrentNow.max}`);
    // Both ultimately succeeded.
    const finals = collected.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(finals.filter((f) => f.success === true).length === 2, 'both goals should ultimately succeed');
  });
});

// ---------------------------------------------------------------------------
// [HIGH-4] Honest per-goal phase total across requeues.
// ---------------------------------------------------------------------------

describe('runSchedule — [HIGH-4] phase total is HONEST (grows with requeues, not hardcoded /1)', () => {
  it('a goal requeued once reports total >= 2 (not a false /1 denominator)', async () => {
    const time = makeFakeTime();
    let aAttempts = 0;
    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, _signal) {
      if (spec.id === 'a') {
        aAttempts++;
        if (aAttempts === 1) {
          yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
          yield { type: 'final', success: false, output: 'rl', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1, errorCategory: 'rate-limit', provider: 'claude' };
          return;
        }
      }
      yield { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'm', attempt: 1, title: spec.title };
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'],
      now: time.now,
      sleep: time.sleep,
    };
    const events = await drain(runSchedule(specs('a'), deps, new AbortController().signal));
    const aPhases = events.filter(
      (e): e is Extract<CoreEvent, { type: 'goal-phase' }> => e.type === 'goal-phase' && e.goalId === 'a',
    );
    // After one requeue, the planned total for a is >= 2 — an HONEST denominator,
    // never a hardcoded /1.
    const maxTotal = Math.max(...aPhases.map((p) => p.total));
    assert.ok(maxTotal >= 2, `expected honest total >= 2 after a requeue, saw ${maxTotal} in ${JSON.stringify(aPhases)}`);
    // The completed phase's current never exceeds its total (no dishonest 2/1).
    assert.ok(aPhases.every((p) => p.current <= p.total), `current must never exceed total: ${JSON.stringify(aPhases)}`);
  });
});

// ---------------------------------------------------------------------------
// [MED-5] Default real clock + multi-requeue backoff actually delays.
// ---------------------------------------------------------------------------

describe('runSchedule — [MED-5] backoff actually delays across multi-requeue (advancing clock)', () => {
  it('multiple requeues impose growing, real delays and the goal is never silently dropped', async () => {
    const time = makeFakeTime();
    let aAttempts = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      time.clock.ms += Math.max(0, ms); // the clock ACTUALLY advances
    };
    // Goal a 429s its first TWO runs, succeeds the third → two requeues w/ backoff.
    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, _signal) {
      if (spec.id === 'a') {
        aAttempts++;
        if (aAttempts <= 2) {
          yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: aAttempts, title: spec.title };
          yield { type: 'final', success: false, output: 'rl', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1, errorCategory: 'rate-limit', provider: 'claude' };
          return;
        }
      }
      yield { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'm', attempt: 1, title: spec.title };
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };
    const deps: ScheduleDeps = { runGoal, authedProviders: ['claude', 'codex'], now: time.now, sleep, maxTotalRuns: 10 };
    const events = await drain(runSchedule(specs('a'), deps, new AbortController().signal));

    // a ran 3 times (two requeues), NOT dropped after the first backoff.
    assert.equal(aAttempts, 3, `goal a should run exactly 3 times (two requeues), saw ${aAttempts}`);
    // Backoff GREW: the second requeue waited longer than the first (exponential).
    const backoffs = sleeps.filter((ms) => ms >= BASE_BACKOFF_MS);
    assert.ok(backoffs.length >= 2, `expected >=2 real backoff waits, saw ${JSON.stringify(sleeps)}`);
    assert.ok(backoffs[1] > backoffs[0], `second backoff (${backoffs[1]}) should exceed the first (${backoffs[0]})`);
    // The clock advanced past zero (the frozen-clock bug would leave it at 0).
    assert.ok(time.clock.ms > 0, 'the logical clock must have advanced');
    // a ultimately succeeded (never silently dropped).
    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok([...finals].reverse().find((f) => f.goalId === 'a')?.success === true, 'a should ultimately succeed');
  });

  it('with the DEFAULT clock (no injected now/sleep) a requeued goal still completes (no frozen-clock drop)', async () => {
    // No `now`/`sleep` injected → exercises the live-path performance.now default +
    // immediate-resolve sleep. The MED-5 bug (now:()=>0) would freeze readyAt and
    // silently drop the requeued goal.
    let aAttempts = 0;
    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, _signal) {
      if (spec.id === 'a') {
        aAttempts++;
        if (aAttempts === 1) {
          yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
          yield { type: 'final', success: false, output: 'rl', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1, errorCategory: 'rate-limit', provider: 'claude' };
          return;
        }
      }
      yield { type: 'tier-start', tier: 'ic', provider: 'codex', model: 'm', attempt: 1, title: spec.title };
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };
    const deps: ScheduleDeps = { runGoal, authedProviders: ['claude', 'codex'] };
    const events = await drain(runSchedule(specs('a'), deps, new AbortController().signal));
    assert.equal(aAttempts, 2, 'with the default clock the requeued goal must still be retried');
    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok([...finals].reverse().find((f) => f.goalId === 'a')?.success === true);
  });

  it('emits a total-runs CEILING notice when a goal is abandoned at the ceiling', async () => {
    const time = makeFakeTime();
    // Goal a always 429s; with maxTotalRuns=2 it is abandoned (ceiling), and the
    // honest notice must fire rather than the goal vanishing silently.
    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, _signal) {
      yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
      yield { type: 'final', success: false, output: 'rl', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1, errorCategory: 'rate-limit', provider: 'claude' };
    };
    const deps: ScheduleDeps = { runGoal, authedProviders: ['claude', 'codex'], now: time.now, sleep: time.sleep, maxTotalRuns: 2 };
    const events = await drain(runSchedule(specs('a'), deps, new AbortController().signal));
    assert.ok(
      events.some((e) => e.type === 'notice' && /ceiling/i.test((e as Extract<CoreEvent, { type: 'notice' }>).message)),
      'a ceiling notice must fire when a goal is abandoned at the total-runs ceiling',
    );
  });
});

// ---------------------------------------------------------------------------
// [LOW-8] Duplicate goal ids are rejected up front (no silent worker clobber).
// ---------------------------------------------------------------------------

describe('runSchedule — [LOW-8] duplicate goal ids are rejected (no silent leak)', () => {
  it('two specs sharing an id throws rather than clobbering the workers Map', async () => {
    const time = makeFakeTime();
    const runGoal = makeRunGoal({ dup: {} });
    const deps: ScheduleDeps = { runGoal, authedProviders: ['claude', 'codex'], now: time.now, sleep: time.sleep };
    const dupSpecs: GoalSpec[] = [
      { id: 'dup', title: 'first' },
      { id: 'dup', title: 'second' },
    ];
    await assert.rejects(
      async () => drain(runSchedule(dupSpecs, deps, new AbortController().signal)),
      /duplicate goal id/i,
      'duplicate goal ids must throw, not silently clobber a worker',
    );
  });
});

// ---------------------------------------------------------------------------
// Strict activeLimit bound holds under N >> limit with staggered completions.
// ---------------------------------------------------------------------------

describe('runSchedule — strict activeLimit bound under N >> limit (staggered completions)', () => {
  it('never exceeds activeLimit concurrent goals across 8 goals with staggered, interleaved completion', async () => {
    const time = makeFakeTime();
    const live = { now: 0, max: 0 };
    // Each goal holds open on its own gate; we release them in a scrambled order to
    // force genuine interleaving. The live counter must never exceed the ceiling.
    const releasers = new Map<string, () => void>();
    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, signal) {
      const hold = new Promise<void>((r) => releasers.set(spec.id, r));
      live.now++;
      live.max = Math.max(live.max, live.now);
      yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
      await hold;
      live.now--;
      if (signal.aborted) { yield { type: 'final', success: false, output: 'x', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 0, canceled: true }; return; }
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };
    const ids = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'];
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'], // ceiling 2
      now: time.now,
      sleep: time.sleep,
    };
    const gen = runSchedule(specs(...ids), deps, new AbortController().signal);
    const collected: CoreEvent[] = [];
    const pump = (async () => {
      for (;;) {
        const r = await gen.next();
        if (r.done) break;
        collected.push(r.value);
      }
    })();
    // Release goals in a scrambled order as they appear, a few microtasks apart.
    const scramble = ['g0', 'g1', 'g3', 'g2', 'g5', 'g4', 'g7', 'g6'];
    for (const id of scramble) {
      // Wait until this goal has actually started (its releaser exists).
      for (let i = 0; i < 100 && !releasers.has(id); i++) await Promise.resolve();
      releasers.get(id)?.();
      await Promise.resolve();
    }
    await pump;
    // STRICT bound: never more than 2 goals live at once, ever.
    assert.ok(live.max <= 2, `activeLimit bound violated: saw ${live.max} concurrent (ceiling 2)`);
    // All 8 completed.
    const finals = collected.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.equal(finals.filter((f) => f.success === true).length, 8);
    assert.deepEqual(finals.map((f) => f.goalId).sort(), [...ids].sort());
  });
});

// ---------------------------------------------------------------------------
// goalId tagging stays correct under genuine Promise.race interleaving.
// ---------------------------------------------------------------------------

describe('runSchedule — goalId tagging is correct under genuine race interleaving', () => {
  it('events from two goals interleaving step-by-step are each tagged to the RIGHT goal', async () => {
    const time = makeFakeTime();
    // Two goals each emit a distinct sequence of provider-events with goal-specific
    // payloads; we release them tick-by-tick so the Promise.race genuinely
    // interleaves their .next() resolutions. Every tagged event must carry the
    // goalId whose payload it actually contains.
    const gateA: Array<() => void> = [];
    const gateB: Array<() => void> = [];
    const mkGate = (arr: Array<() => void>) => new Promise<void>((r) => arr.push(r));

    const runGoal: ScheduleDeps['runGoal'] = async function* (spec, _signal) {
      const gates = spec.id === 'A' ? gateA : gateB;
      yield { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, title: spec.title };
      for (let i = 0; i < 3; i++) {
        await mkGate(gates);
        // Payload encodes the OWNING goal id — if tagging cross-wires, the goalId
        // won't match the embedded delta.
        yield { type: 'provider-event', tier: 'ic', event: { type: 'text', delta: `${spec.id}#${i}` } };
      }
      yield { type: 'final', success: true, output: `done ${spec.id}`, tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };
    const deps: ScheduleDeps = { runGoal, authedProviders: ['claude', 'codex'], now: time.now, sleep: time.sleep };
    const gen = runSchedule(specs('A', 'B'), deps, new AbortController().signal);
    const collected: CoreEvent[] = [];
    const pump = (async () => {
      for (;;) {
        const r = await gen.next();
        if (r.done) break;
        collected.push(r.value);
      }
    })();
    // Interleave releases: B, A, A, B, B, A — a scrambled order.
    const order = [gateB, gateA, gateA, gateB, gateB, gateA];
    for (const arr of order) {
      for (let i = 0; i < 100 && arr.length === 0; i++) await Promise.resolve();
      arr.shift()?.();
      await Promise.resolve();
    }
    await pump;
    // Every provider-event's goalId matches the goal id embedded in its delta.
    const provEvents = collected.filter(
      (e): e is Extract<CoreEvent, { type: 'provider-event' }> => e.type === 'provider-event',
    );
    assert.equal(provEvents.length, 6, 'expected 3 provider-events per goal');
    for (const ev of provEvents) {
      const delta = ev.event.type === 'text' ? ev.event.delta : '';
      assert.ok(delta.startsWith(`${ev.goalId}#`), `event tagged ${ev.goalId} but carried payload "${delta}" — tagging cross-wired`);
    }
  });
});

// ---------------------------------------------------------------------------
// runSchedule — DEPENDENCY-DAG scheduling
// ---------------------------------------------------------------------------

/** GoalSpecs with explicit dependsOn edges. */
function dep(id: string, title: string, dependsOn: string[] = []): GoalSpec {
  return dependsOn.length > 0 ? { id, title, dependsOn } : { id, title };
}

describe('runSchedule — DAG: a dependent goal QUEUES until its dependency finishes', () => {
  it('a depends on nothing; b depends on a → b starts only AFTER a finishes', async () => {
    const time = makeFakeTime();
    const order: string[] = [];
    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => (releaseA = r));
    const runGoal = makeRunGoal({
      a: { hold: holdA, onStart: () => order.push('a-start') },
      b: { onStart: () => order.push('b-start') },
    });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'], // ceiling 2 — but b must STILL wait on a
      now: time.now,
      sleep: time.sleep,
    };
    const gen = runSchedule([dep('a', 'goal a'), dep('b', 'goal b', ['a'])], deps, new AbortController().signal);

    const collected: CoreEvent[] = [];
    const next = async (): Promise<CoreEvent | undefined> => {
      const r = await gen.next();
      if (r.done) return undefined;
      collected.push(r.value);
      return r.value;
    };

    // Pull until a has started. Even with a free slot, b must NOT start (dep gate).
    let aStarted = false;
    while (!aStarted) {
      const ev = await next();
      assert.ok(ev !== undefined, 'stream ended before a started');
      if (ev.type === 'tier-start' && ev.goalId === 'a') aStarted = true;
    }
    assert.equal(order.includes('b-start'), false, 'b started before its dependency a finished');

    // Release a → it finishes → b becomes runnable and starts.
    releaseA();
    for (;;) {
      const ev = await next();
      if (ev === undefined) break;
    }

    // b ran strictly after a finished.
    assert.ok(order.includes('a-start'));
    assert.ok(order.includes('b-start'), 'b never ran after its dependency completed');
    const finals = collected.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.deepEqual(finals.map((f) => f.goalId).sort(), ['a', 'b']);
    assert.ok(finals.every((f) => f.success === true));
  });
});

describe('runSchedule — DAG: independent goals run CONCURRENTLY; dependents queue', () => {
  it('a, b independent (run together); c depends on both (runs last)', async () => {
    const time = makeFakeTime();
    const started: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const holdA = new Promise<void>((r) => (releaseA = r));
    const holdB = new Promise<void>((r) => (releaseB = r));
    const runGoal = makeRunGoal({
      a: { hold: holdA, onStart: () => started.push('a') },
      b: { hold: holdB, onStart: () => started.push('b') },
      c: { onStart: () => started.push('c') },
    });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'], // ceiling 2 → a and b run concurrently
      now: time.now,
      sleep: time.sleep,
    };
    const gen = runSchedule(
      [dep('a', 'goal a'), dep('b', 'goal b'), dep('c', 'goal c', ['a', 'b'])],
      deps,
      new AbortController().signal,
    );
    const collected: CoreEvent[] = [];
    const next = async (): Promise<CoreEvent | undefined> => {
      const r = await gen.next();
      if (r.done) return undefined;
      collected.push(r.value);
      return r.value;
    };

    const seenStart = new Set<string>();
    while (seenStart.size < 2) {
      const ev = await next();
      assert.ok(ev !== undefined, 'stream ended before both independent goals started');
      if (ev.type === 'tier-start' && ev.goalId !== undefined) seenStart.add(ev.goalId);
    }
    // a and b run concurrently; c has NOT started (both deps still open).
    assert.deepEqual([...seenStart].sort(), ['a', 'b']);
    assert.equal(started.includes('c'), false, 'c started before both prerequisites finished');

    releaseA();
    releaseB();
    for (;;) {
      const ev = await next();
      if (ev === undefined) break;
    }
    assert.ok(started.includes('c'), 'c never ran after both prerequisites completed');
    const finals = collected.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.deepEqual(finals.map((f) => f.goalId).sort(), ['a', 'b', 'c']);
    assert.ok(finals.every((f) => f.success === true));
  });
});

describe('runSchedule — DAG: a FAILED dependency BLOCKS its dependents (skip, never run)', () => {
  it('a fails → b (depends on a) is skipped with an honest final and never starts', async () => {
    const time = makeFakeTime();
    const started: string[] = [];
    const runGoal = makeRunGoal({
      a: { success: false, onStart: () => started.push('a') }, // fails (non-rate-limit)
      b: { onStart: () => started.push('b') },
    });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude', 'codex'],
      now: time.now,
      sleep: time.sleep,
    };
    const events = await drain(
      runSchedule([dep('a', 'goal a'), dep('b', 'goal b', ['a'])], deps, new AbortController().signal),
    );

    // b NEVER started (its prerequisite failed).
    assert.equal(started.includes('b'), false, 'b ran despite its dependency failing');
    assert.ok(started.includes('a'));

    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    const aFinal = finals.find((f) => f.goalId === 'a');
    const bFinal = finals.find((f) => f.goalId === 'b');
    assert.ok(aFinal !== undefined && aFinal.success === false, 'a should report a failed final');
    assert.ok(bFinal !== undefined && bFinal.success === false, 'b should report a skipped final');
    assert.match(bFinal.output, /prerequisite/i, 'b final should explain the prerequisite failure');
  });

  it('cascades transitively: a fails → b blocked → c (depends on b) also blocked', async () => {
    const time = makeFakeTime();
    const started: string[] = [];
    const runGoal = makeRunGoal({
      a: { success: false, onStart: () => started.push('a') },
      b: { onStart: () => started.push('b') },
      c: { onStart: () => started.push('c') },
    });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude'],
      now: time.now,
      sleep: time.sleep,
    };
    const events = await drain(
      runSchedule(
        [dep('a', 'goal a'), dep('b', 'goal b', ['a']), dep('c', 'goal c', ['b'])],
        deps,
        new AbortController().signal,
      ),
    );
    assert.deepEqual(started, ['a'], 'only a ran; b and c were blocked transitively');
    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.deepEqual(finals.map((f) => f.goalId).sort(), ['a', 'b', 'c']);
    assert.ok(finals.every((f) => f.success === false));
  });
});

describe('runSchedule — DAG: a crashed dependency BLOCKS its dependents', () => {
  it('a throws → b (depends on a) is skipped, never started', async () => {
    const time = makeFakeTime();
    const started: string[] = [];
    const runGoal: ScheduleDeps['runGoal'] = async function* (spec) {
      started.push(spec.id);
      if (spec.id === 'a') throw new Error('boom');
      yield { type: 'final', success: true, output: 'ok', tier: 'ic', totalCostUsd: 0, sessionId: 's', attempts: 1 };
    };
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude'],
      now: time.now,
      sleep: time.sleep,
    };
    const events = await drain(
      runSchedule([dep('a', 'goal a'), dep('b', 'goal b', ['a'])], deps, new AbortController().signal),
    );
    assert.equal(started.includes('b'), false, 'b ran despite a crashing');
    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(finals.every((f) => f.success === false));
    assert.deepEqual(finals.map((f) => f.goalId).sort(), ['a', 'b']);
  });
});

describe('runSchedule — DAG: an unknown dependency edge is treated defensively', () => {
  it('a goal whose dep id does not exist still runs (unknown deps are no-ops)', async () => {
    const time = makeFakeTime();
    const runGoal = makeRunGoal({ a: {} });
    const deps: ScheduleDeps = {
      runGoal,
      authedProviders: ['claude'],
      now: time.now,
      sleep: time.sleep,
    };
    // 'a' depends on 'ghost' which is not in the spec list — defensively ignored.
    const events = await drain(
      runSchedule([dep('a', 'goal a', ['ghost'])], deps, new AbortController().signal),
    );
    const finals = events.filter((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.equal(finals.length, 1);
    assert.equal(finals[0]?.goalId, 'a');
    assert.equal(finals[0]?.success, true);
  });
});
