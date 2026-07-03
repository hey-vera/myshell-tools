/**
 * src/core/scheduler.ts — the BOUNDED CONCURRENT MULTI-GOAL SCHEDULER.
 *
 * Mirrors the established ensemble.ts / hedge.ts split exactly:
 *  - PURE planning: {@link planSchedule} decides the `activeLimit` (how many goals
 *    may run truly concurrently) and partitions the goal set into running/queued.
 *    No I/O, no time, no randomness — unit-testable in isolation.
 *  - IMPURE executor: {@link runSchedule} is an `async function*` that holds a
 *    worker pool of up to `activeLimit` live per-goal generators, merges their
 *    CoreEvent streams (the `mergeCandidates` fan-in mechanic one level up),
 *    TAGS every yielded event with its owning `goalId`, and pulls the next queued
 *    goal into a freed slot when one finishes. It does I/O ONLY through injected
 *    deps (the per-goal `runGoal` factory + clock + sleep) — the SAME purity
 *    contract runPanel/runHedged hold (allowed: see test/arch/guards.test.ts).
 *
 * Why this shape — honest concurrency on ONE subscription:
 *  Each goal-phase is exactly ONE `orchestrate()` call (orchestrate stays
 *  UNTOUCHED — the scheduler is one level up). There are ≤3 provider CLIs, each
 *  mapped to one subscription's rate-limit bucket, so the honest steady state is
 *  ~1 heavy call per provider. We therefore bound concurrency to
 *  `activeLimit = min(2, authedProviderCount)` (lowered to 1 under pressure) and
 *  QUEUE the rest. "20 goals flat-out" is not realistic on one subscription;
 *  "2–4 active, the rest queued, honest progress on all" is.
 *
 * Cancellation (ESC): a parent AbortController owns per-goal CHILD controllers
 * (the hedge.ts fan-out pattern). The caller's `signal` aborting fans out to
 * every active child → each goal's orchestrate sees `signal.aborted` and stops
 * cleanly; queued goals simply never start.
 *
 * Degrade under pressure (queue, don't hammer): before pulling a queued goal we
 * recompute `pressureFromSignals` from the rate-limited-provider set the run has
 * observed and lower `activeLimit`; a goal whose phase failed with a rate-limit
 * error is REQUEUED with exponential backoff (it waits, it does not retry-hammer)
 * and `availableAfterCooldown` biases which queued goal we start next toward a
 * provider that is not throttled. We never exceed the honest concurrency ceiling
 * (≤ authed providers).
 *
 * SCOPE: the scheduler ENGINE for bounded concurrent multi-goal runs. It is now
 * smart-auto by default for /goal (see scheduler-flag.ts and menu.ts wiring).
 * Decompose is always called for goals (cost-honest: returns 1 for sequential).
 * It does NOT render the plan-panel UI. Runs the goal specs it is GIVEN, with
 * pressure/provider caps, DAG queuing, per-goal re-validation via orchestrate.
 *
 * This module is PURE except for the injected-deps I/O in {@link runSchedule}
 * (same as ensemble/hedge): no fs/child_process, no Date.now/Math.random.
 */

import type { CoreEvent } from './types.js';
import type { ProviderId } from '../providers/port.js';
import { pressureFromSignals, type QuotaPressure } from './capability-budget.js';
import { availableAfterCooldown, cooldownExpiry } from './cooldown.js';
import { buildBlockedRecord } from './blocked.js';

// ---------------------------------------------------------------------------
// Goal specs + plan types
// ---------------------------------------------------------------------------

/**
 * A single goal the scheduler is asked to run. The caller (the NEXT-PHASE
 * /goal-runner wiring) supplies these.
 *
 * HARD CONSTRAINT (owner): a goal promoted from a PARKED / inactive state must be
 * RE-VALIDATED by the brain before it gets here. The scheduler runs goal specs
 * verbatim; it has NO path that auto-executes a stale parked roadmap. The caller
 * must pass only brain-validated specs. See {@link runSchedule}.
 */
export interface GoalSpec {
  /** Stable, caller-assigned goal id — stamped onto every event for this goal. */
  readonly id: string;
  /** Human, one-line card label (becomes the goal card's title). */
  readonly title: string;
  /**
   * GOAL-LEVEL parent id (Phase 4): when this spec was decomposed out of an
   * originating persisted goal, its id. Purely additive; absent keeps the
   * scheduler and receipt behavior byte-identical.
   */
  readonly parentGoalId?: string;
  /**
   * The provider this goal PREFERS, when known. Used only to spread goals across
   * distinct subscription buckets and to bias queued-goal selection away from a
   * throttled provider. Absent → no preference (scheduled on availability order).
   */
  readonly preferredProvider?: ProviderId;
  /**
   * The isolated git-worktree cwd this goal runs IN, when the Rival Tribunal
   * (master-plan PHASE 9; core/tribunal.ts) built one for it. ABSENT → the goal
   * runs in the shared repo cwd, today's behavior — fully additive/optional, so a
   * non-tribunal goal is byte-for-byte unchanged. The live runGoal wrapper threads
   * this onto `deps.cwd` so a per-rival build never touches the shared tree.
   */
  readonly worktreeCwd?: string;
  /**
   * The ids of the goals this goal DEPENDS ON. A goal is RUNNABLE only once every
   * goal in `dependsOn` has finished SUCCESSFULLY; until then it stays queued (it
   * is never one of the `activeLimit` started up front). If ANY dependency FAILS
   * (a non-rate-limit failure or a crash), this goal is BLOCKED — it never runs,
   * and the scheduler emits an honest skipped `final` for it (don't run a goal
   * whose prerequisite failed). Absent/empty → no dependencies (a root goal that
   * can start immediately). The DAG is validated by {@link decompose} before it
   * reaches here (cycles rejected, unknown deps dropped); the scheduler is also
   * defensive (an unknown dep id is treated as a never-satisfied edge that the
   * decompose-side validation should already have removed).
   */
  readonly dependsOn?: readonly string[];
}

/** Input to the PURE {@link planSchedule}. */
export interface SchedulePlanInput {
  /** The goals to schedule, in caller-supplied priority order. */
  readonly goals: readonly GoalSpec[];
  /** Current quota pressure (0–3) from {@link pressureFromSignals}. */
  readonly pressure: QuotaPressure;
  /** The count of providers currently signed in (the honest concurrency ceiling). */
  readonly authedProviderCount: number;
  /**
   * ADDITIVE optional cross-goal ceiling (Phase D `crossGoalCap`). When ABSENT,
   * the activeLimit math is EXACTLY today's (byte-identical). When PRESENT, the
   * computed activeLimit is additionally clamped by `Math.min(limit, maxActive)`
   * — a non-negative integer ceiling from the call site (tuning/budget/demand).
   * A negative/NaN value degrades to 0 (nothing runs), never an uncapped run.
   */
  readonly maxActive?: number;
}

/** Result of the PURE {@link planSchedule}: the bound + the running/queued split. */
export interface SchedulePlan {
  /**
   * How many goals may run TRULY concurrently this round. Honest ceiling:
   * `min(BASE_ACTIVE_LIMIT, authedProviderCount)`, lowered to 1 under high
   * pressure, never below 1 (unless there are zero authed providers → 0), never
   * above the number of goals.
   */
  readonly activeLimit: number;
  /** The goals that start now (the first `activeLimit` goals). */
  readonly running: readonly GoalSpec[];
  /** The goals held back (everything past `activeLimit`), in priority order. */
  readonly queued: readonly GoalSpec[];
}

/**
 * The base active-goal limit before the authed-provider ceiling and pressure are
 * applied. Two, per the vision's honest steady state: ~1 heavy call per provider,
 * with a brief 2-way overlap being the most a single subscription tolerates
 * before 429s. Raising this to 3–4 is a later-phase tuning step gated on ≥3
 * signed-in providers + Max mode (vision Phase 4), NOT done here.
 */
export const BASE_ACTIVE_LIMIT = 2;

// ---------------------------------------------------------------------------
// PURE: planSchedule
// ---------------------------------------------------------------------------

/**
 * Decide the active-goal limit and partition the goals into running/queued.
 *
 * activeLimit math (honest, conservative):
 *  - Start from `min(BASE_ACTIVE_LIMIT, authedProviderCount)` — never schedule
 *    more concurrent goals than there are subscription buckets to spread them
 *    across (the honest ceiling; ≤ authed providers).
 *  - Under HIGH pressure (≥2: two providers throttled, or a 429 + a throttle)
 *    lower the cap to 1 — let the system breathe instead of double-booking a
 *    contended bucket.
 *  - Clamp to `[0, goals.length]`: never above the goals we have, and 0 only when
 *    there are no signed-in providers (nothing can run).
 *
 * Partition: the first `activeLimit` goals (caller priority order) run; the rest
 * queue. PURE; total; never throws.
 */
export function planSchedule(input: SchedulePlanInput): SchedulePlan {
  const goals = input.goals;
  const authed = Number.isFinite(input.authedProviderCount)
    ? Math.max(0, Math.floor(input.authedProviderCount))
    : 0;

  // Honest ceiling: never more concurrent goals than subscription buckets.
  let limit = Math.min(BASE_ACTIVE_LIMIT, authed);
  // Degrade under pressure: high pressure → single-file (but never below 1 while
  // at least one provider is signed in).
  if (input.pressure >= 2 && limit > 1) limit = 1;
  // ADDITIVE Phase-D clamp: when a cross-goal ceiling is supplied, it can only
  // LOWER the limit (never raise it). Absent ⇒ this line is a no-op and the math
  // is byte-identical to before. A non-finite/negative maxActive degrades to 0.
  if (input.maxActive !== undefined) {
    const cap = Number.isFinite(input.maxActive) ? Math.max(0, Math.floor(input.maxActive)) : 0;
    limit = Math.min(limit, cap);
  }
  // Never schedule more than we have goals for; never negative.
  limit = Math.max(0, Math.min(limit, goals.length));

  return {
    activeLimit: limit,
    running: goals.slice(0, limit),
    queued: goals.slice(limit),
  };
}

// ---------------------------------------------------------------------------
// Executor deps + types
// ---------------------------------------------------------------------------

/**
 * The per-goal phase runner: produces the CoreEvent generator for ONE goal-phase.
 * Defaults (in the live wiring) to a thin wrapper around `orchestrate(task, deps,
 * signal)` — but injected here so the scheduler is fully test-drivable with fake
 * generators (no real model calls). It MUST yield exactly one `final` event per
 * phase (the orchestrate contract); the scheduler treats that `final` as the
 * phase boundary.
 */
export type RunGoalPhase = (
  spec: GoalSpec,
  signal: AbortSignal,
) => AsyncGenerator<CoreEvent>;

/** Injected ports for {@link runSchedule}. Same purity contract as runPanel/runHedged. */
export interface ScheduleDeps {
  /** Per-goal phase runner (wraps orchestrate in the live path). */
  readonly runGoal: RunGoalPhase;
  /** Providers currently signed in — the honest concurrency ceiling. */
  readonly authedProviders: readonly ProviderId[];
  /**
   * Delay port for requeue backoff. Injected (never a global timer) so tests are
   * deterministic. Absent → backoff degrades to no-wait (still requeues, just
   * without the pause — fail-soft, never a hang).
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Monotonic clock (ms) for cooldown bookkeeping. Injected for determinism.
   * Absent → cooldown tracking degrades to "nothing cooling" (fail-soft).
   */
  readonly now?: () => number;
  /**
   * Hard ceiling on TOTAL goal-phase runs across the whole schedule (the
   * schedule-level analogue of decideGoalNext's maxIterations). Stops + reports
   * honestly when hit rather than burning quota silently. Absent → derived as a
   * generous multiple of the goal count.
   */
  readonly maxTotalRuns?: number;
  /**
   * ADDITIVE Phase-D cross-goal cap (D6): an upper bound on the live active-goal
   * limit, forwarded into every `planSchedule` re-derivation in
   * `currentActiveLimit`. It can only LOWER the limit (planSchedule mins it with
   * the live pressure/provider ceiling), never raise it. Absent ⇒ every
   * planSchedule call is byte-identical to before and the scheduler behaves
   * exactly as it did pre-D6. The live wiring computes it as
   * `min(tuningCeiling, callBudgetCeiling, genuineParallelGoalCount)`
    * (see `interface/menu.ts`); combined with planSchedule's clamp this yields the
    * exact `crossGoalCap` (capacity-allocator.ts).
    */
  readonly maxActive?: number;
  /**
   * Blocked-state terminal flag (MYSHELL_BLOCKED_STATE_V1 — unconditional).
   * Dependency skip finals include a blocked record with dependency_blocked code.
   */
  readonly blockedStateV1?: boolean;
}

/**
 * Base backoff (ms) for a rate-limited goal's FIRST requeue; doubles each
 * subsequent requeue of the same goal, capped at {@link MAX_BACKOFF_MS}. Pure +
 * deterministic (no jitter) so tests can assert the exact wait. The live path
 * injects `sleep`; tests inject a fake that records the requested delay.
 */
export const BASE_BACKOFF_MS = 1_000;
/** Cap on a single requeue backoff wait. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * PURE deterministic exponential backoff for the Nth requeue of a goal (0-based).
 * No jitter (kept pure for the arch guard + deterministic tests). Exposed for
 * unit coverage.
 */
export function requeueBackoffMs(requeueCount: number): number {
  const n = Number.isFinite(requeueCount) ? Math.max(0, Math.floor(requeueCount)) : 0;
  return Math.min(BASE_BACKOFF_MS * 2 ** n, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// IMPURE executor: runSchedule
// ---------------------------------------------------------------------------

/** Internal: a live worker holding one goal's generator + its child controller. */
interface Worker {
  readonly spec: GoalSpec;
  readonly gen: AsyncGenerator<CoreEvent>;
  readonly ac: AbortController;
}

/** Internal: a queued goal, carrying how many times it has been requeued (for backoff). */
interface QueuedGoal {
  readonly spec: GoalSpec;
  readonly requeueCount: number;
  /** Epoch-ms before which this goal must NOT be restarted (backoff). 0 = ready now. */
  readonly readyAt: number;
}

/**
 * Run a bounded, concurrent multi-goal schedule, yielding ONE merged stream of
 * goalId-tagged {@link CoreEvent}s the existing reducer/StatusBlock already
 * render.
 *
 * Lifecycle:
 *  1. Emit a `goal-enqueue` for EVERY goal up front (so all goal cards appear,
 *     queued, immediately) and a `goal-phase {current:0,total:1}` seed.
 *  2. Compute the initial plan via {@link planSchedule}; start the first
 *     `activeLimit` goals (one child generator each).
 *  3. Merge the active generators with the `mergeCandidates` race mechanic one
 *     level up: `Promise.race` over each worker's `.next()`, re-emitting every
 *     event TAGGED with its goalId. When a worker's `final` arrives the goal's
 *     phase is done; we then either requeue (rate-limit) or retire it, recompute
 *     the plan/pressure, and pull the next READY queued goal into the freed slot.
 *  4. Stop when no workers and no queued goals remain, or the total-runs ceiling
 *     is hit, or the caller aborts.
 *
 * Cancellation: the caller `signal` aborting fans out to every active child
 * controller (hedge pattern); active goals stop cleanly and queued goals never
 * start. One honest cancel `notice` is emitted.
 *
 * Honesty: never exceeds `min(BASE_ACTIVE_LIMIT, authedProviders.length)` live
 * goals; under pressure lowers to 1; a 429'd goal is REQUEUED with backoff, not
 * hammered.
 *
 * RE-VALIDATION (owner hard constraint): the scheduler runs `goalSpecs`
 * verbatim. A goal promoted from a PARKED state MUST be re-validated by the brain
 * BEFORE being passed here — the caller (next phase) owns that gate. There is NO
 * path in this module that auto-executes a stale parked roadmap.
 *
 * @param goalSpecs - brain-validated goals to run, in priority order.
 * @param deps      - injected ports (per-goal runner, authed providers, sleep, clock).
 * @param signal    - caller AbortSignal (ESC). Fans out to all active goals.
 */
export async function* runSchedule(
  goalSpecs: readonly GoalSpec[],
  deps: ScheduleDeps,
  signal: AbortSignal,
): AsyncGenerator<CoreEvent> {
  // [MED-5] Default to a REAL monotonic clock in the live path (performance.now —
  // not forbidden by the purity guard, unlike Date.now). A frozen `() => 0` would
  // make backoff/readyAt never advance, silently dropping a requeued goal. Tests
  // inject a logical clock that ACTUALLY advances (sleep bumps it).
  const now = deps.now ?? ((): number => performance.now());
  // [MED-5] In the live path `sleep` must ACTUALLY wait so a requeue's backoff
  // window genuinely elapses against the real `performance.now()` clock — a no-op
  // resolve would leave `now()` < `readyAt` and silently drop the requeued goal.
  // A setTimeout-based delay is not forbidden by the purity guard (only fs/proc/
  // Date.now/Math.random are). Tests inject a logical clock+sleep instead.
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      }));
  const authedCount = deps.authedProviders.length;

  // [LOW-8] Reject duplicate goal ids up front: two specs sharing an id would
  // silently clobber the workers Map (leaking a goal) and cross-tag events. Fail
  // loud at the boundary rather than corrupt the run.
  const seenIds = new Set<string>();
  for (const spec of goalSpecs) {
    if (seenIds.has(spec.id)) {
      throw new Error(`runSchedule: duplicate goal id "${spec.id}" — goal ids must be unique`);
    }
    seenIds.add(spec.id);
  }

  // Honest total-runs ceiling: stop + report rather than burn quota silently.
  const maxTotalRuns =
    typeof deps.maxTotalRuns === 'number' && Number.isFinite(deps.maxTotalRuns)
      ? Math.max(1, Math.floor(deps.maxTotalRuns))
      : Math.max(1, goalSpecs.length * 4);

  // [HIGH-4] Real per-goal phase counts. A goal runs ≥1 phase; each requeue/
  // continuation increments its total so "phase X/Y" carries a TRUTHFUL
  // denominator (the count of phases this goal has actually been run) rather than
  // a hardcoded /1. Seeded to 1 (every goal is planned to run at least once).
  const phaseTotal = new Map<string, number>();
  const phaseCurrent = new Map<string, number>();
  for (const spec of goalSpecs) {
    phaseTotal.set(spec.id, 1);
    phaseCurrent.set(spec.id, 0);
  }

  // 1. Declare every goal up front so all cards appear (queued) immediately, with
  //    an honest 0/<planned> seed.
  for (const spec of goalSpecs) {
    yield { type: 'goal-enqueue', id: spec.id, title: spec.title, ...(spec.dependsOn && spec.dependsOn.length ? { dependsOn: spec.dependsOn } : {}) };
    yield { type: 'goal-phase', goalId: spec.id, current: 0, total: phaseTotal.get(spec.id) ?? 1 };
  }

  // Early abort: nothing ran yet.
  if (signal.aborted) {
    yield { type: 'notice', level: 'warn', message: 'cancelled' };
    return;
  }

  // Per-conversation cooldown memory (monotonic-ms expiry per throttled provider).
  // [HIGH-3] This Map is the SINGLE source of pressure truth: a provider is
  // "rate-limited" only while its cooldown is still in the future. We never keep a
  // sticky boolean or an add-only Set — pressure is recomputed from live cooldowns
  // (pruning expired entries) so concurrency degrades on a 429 AND recovers once
  // the cooldown lapses.
  const cooldownUntil = new Map<ProviderId, number>();

  // The queue (priority order preserved) and the live worker pool (≤ activeLimit).
  const queue: QueuedGoal[] = goalSpecs.map((spec) => ({ spec, requeueCount: 0, readyAt: 0 }));
  const workers = new Map<string, Worker>();
  let totalRuns = 0;
  let ceilingHit = false;

  // ---- DEPENDENCY-DAG bookkeeping ---------------------------------------
  // A goal is RUNNABLE only when every id in its `dependsOn` has finished
  // SUCCESSFULLY. If any dependency FAILS, the goal is BLOCKED (never run). We
  // track each goal's terminal outcome here; `depsSatisfied`/`depFailed` read it.
  //
  // HONESTY: a failed prerequisite must NOT silently drop its dependents — we
  // emit an explicit skipped `final` for each blocked goal so the user sees that
  // it did not run and WHY. The block CASCADES transitively (a dependent of a
  // blocked goal is itself blocked).
  type Outcome = 'ok' | 'failed';
  const goalOutcome = new Map<string, Outcome>();
  const blocked = new Set<string>();
  // The set of valid goal ids — an unknown dep edge is treated as never-satisfied
  // (decompose-side validation should already have dropped it; we are defensive).
  const knownIds = new Set<string>(goalSpecs.map((s) => s.id));
  // Map a spec's dependsOn to the known subset (ignore self/unknown ids defensively).
  const depsOf = (spec: GoalSpec): readonly string[] =>
    (spec.dependsOn ?? []).filter((d) => d !== spec.id && knownIds.has(d));

  // True when EVERY dependency of `spec` has finished successfully.
  const depsSatisfied = (spec: GoalSpec): boolean =>
    depsOf(spec).every((d) => goalOutcome.get(d) === 'ok');
  // True when AT LEAST ONE dependency of `spec` has FAILED (→ this goal is blocked).
  const depFailed = (spec: GoalSpec): boolean =>
    depsOf(spec).some((d) => goalOutcome.get(d) === 'failed' || blocked.has(d));

  // Parent/child cancellation fan-out (hedge.ts:556 pattern): the caller's signal
  // aborting cancels EVERY active child; queued goals then never start.
  const onAbort = (): void => {
    for (const w of workers.values()) w.ac.abort();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  // [HIGH-3] Count providers whose cooldown is STILL active (prune expired ones
  // in place), and derive the quota-error signal from "any cooldown still
  // active" — never a sticky boolean. Once cooldowns lapse this returns 0 and
  // pressure falls, so the cap climbs back up (degrade AND recover).
  const liveRateLimitedCount = (nowMs: number): number => {
    let count = 0;
    for (const [provider, until] of cooldownUntil) {
      if (until > nowMs) count++;
      else cooldownUntil.delete(provider); // prune expired so it stops counting
    }
    return count;
  };

  // Re-derive the current activeLimit from the live signals (pressure + authed
  // ceiling). Called whenever a slot frees so the cap can drop under pressure AND
  // recover once cooldowns lapse.
  const currentActiveLimit = (): number => {
    const nowMs = now();
    const rlCount = liveRateLimitedCount(nowMs);
    const pressure = pressureFromSignals({
      rateLimitedProviderCount: rlCount,
      recentQuotaError: rlCount > 0,
    });
    // Reuse planSchedule's exact math over the goals still in flight/queued so the
    // ceiling logic lives in ONE pure place.
    const remaining = workers.size + queue.length;
    const fakeGoals: GoalSpec[] = Array.from({ length: remaining }, (_v, i) => ({
      id: `_${i}`,
      title: '',
    }));
    return planSchedule({
      goals: fakeGoals,
      pressure,
      authedProviderCount: authedCount,
      ...(deps.maxActive !== undefined ? { maxActive: deps.maxActive } : {}),
    }).activeLimit;
  };

  // EVERY child controller ever created — so the try/finally can guarantee NONE
  // is left un-aborted on exit, even a goal that has already been retired (e.g. a
  // generator that threw). Leaking an un-aborted controller is a resource leak.
  const allControllers: AbortController[] = [];

  // Start a goal: create its child controller + generator, count the run.
  const startGoal = (spec: GoalSpec): void => {
    const ac = new AbortController();
    // Link the child to the parent so a caller abort fans out (hedge pattern).
    if (signal.aborted) ac.abort();
    const gen = deps.runGoal(spec, ac.signal);
    workers.set(spec.id, { spec, gen, ac });
    allControllers.push(ac);
    totalRuns++;
  };

  // Pick the next READY queued goal, biased toward an un-throttled preferred
  // provider (availableAfterCooldown), preserving priority order otherwise.
  const takeNextReady = (nowMs: number): GoalSpec | undefined => {
    const available = availableAfterCooldown(deps.authedProviders, cooldownUntil, nowMs);
    const availableSet = new Set<ProviderId>(available);
    // A queued goal is RUNNABLE only when its backoff window has elapsed AND all of
    // its dependencies have finished successfully (DAG gate). A goal whose deps have
    // FAILED is already removed from the queue (cascaded to blocked); we re-check
    // depsSatisfied here defensively so a not-yet-ready dependency never starts.
    const ready = (q: QueuedGoal): boolean => q.readyAt <= nowMs && depsSatisfied(q.spec);
    // First pass: a ready goal whose preferred provider is NOT cooling down.
    let idx = queue.findIndex(
      (q) =>
        ready(q) &&
        (q.spec.preferredProvider === undefined || availableSet.has(q.spec.preferredProvider)),
    );
    // Second pass: any ready goal (don't strand work just because every provider
    // is cooling — availableAfterCooldown already never strands).
    if (idx === -1) idx = queue.findIndex((q) => ready(q));
    if (idx === -1) return undefined;
    const [picked] = queue.splice(idx, 1);
    return picked?.spec;
  };

  // Fill freed slots up to the current (pressure-aware) activeLimit. Honors the
  // total-runs ceiling. Returns once no more goals can start right now.
  const fillSlots = (): void => {
    if (signal.aborted) return;
    while (workers.size < currentActiveLimit() && queue.length > 0) {
      if (totalRuns >= maxTotalRuns) {
        ceilingHit = true;
        return;
      }
      const next = takeNextReady(now());
      if (next === undefined) return; // all remaining queued goals are backing off
      startGoal(next);
    }
  };

  // Count of prior requeues per goal id → grows the exponential backoff.
  const requeueLog = new Map<string, number>();

  // Requeue a rate-limited goal with exponential backoff (queue, don't hammer).
  // [HIGH-3] The 429 signal lives ONLY in cooldownUntil (with a real expiry) — no
  // sticky boolean. [HIGH-4] A requeue is another planned phase for this goal, so
  // bump its phase total to keep the denominator honest.
  const requeueWithBackoff = (spec: GoalSpec, provider: ProviderId | undefined): void => {
    const nowMs = now();
    if (provider !== undefined) {
      cooldownUntil.set(provider, cooldownExpiry(nowMs));
    }
    // Count prior requeues of THIS goal to grow the backoff.
    const priorRequeues = requeueLog.get(spec.id) ?? 0;
    const nextCount = priorRequeues + 1;
    requeueLog.set(spec.id, nextCount);
    // Another phase is planned for this goal → honest /total bump.
    phaseTotal.set(spec.id, (phaseTotal.get(spec.id) ?? 1) + 1);
    queue.push({
      spec,
      requeueCount: nextCount,
      readyAt: nowMs + requeueBackoffMs(priorRequeues),
    });
  };

  // Record a goal's TERMINAL outcome (ok / failed) and CASCADE the DAG: any queued
  // goal that now has a failed-or-blocked dependency is BLOCKED — removed from the
  // queue and reported with an honest skipped `final` so it never runs and the user
  // sees WHY. The block propagates transitively (a dependent of a blocked goal is
  // itself blocked). PURE bookkeeping + queue mutation; returns the skipped finals
  // to yield (this helper cannot itself yield — it is called from the generator).
  const recordOutcome = (id: string, kind: Outcome): CoreEvent[] => {
    goalOutcome.set(id, kind);
    const events: CoreEvent[] = [];
    // Fixpoint: keep blocking dependents until no queued goal newly qualifies.
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (q === undefined) continue;
        if (depFailed(q.spec)) {
          // This queued goal has a failed/blocked prerequisite → block it.
          queue.splice(i, 1);
          blocked.add(q.spec.id);
          changed = true;
          // Advance its phase counter to its (planned) total so the card reads
          // done-not-run rather than stuck mid-phase.
          phaseCurrent.set(q.spec.id, phaseTotal.get(q.spec.id) ?? 1);
          const blockedTag = deps.blockedStateV1 === true
            ? buildBlockedRecord({
                reason: 'Prerequisite goal did not complete.',
                nextAction: 'Resolve the prerequisite goal or revise the dependency.',
                preservedWork: 'No work was started for this goal; prior completed work is preserved.',
                code: 'dependency_blocked',
              })
            : null;
          events.push(
            tagEvent(
              {
                type: 'final',
                success: false,
                output: `goal "${q.spec.title}" skipped — a prerequisite goal failed`,
                tier: 'ic',
                totalCostUsd: 0,
                sessionId: '',
                attempts: 0,
                ...(blockedTag !== null ? { blocked: blockedTag } : {}),
              },
              q.spec.id,
            ),
          );
          events.push({
            type: 'goal-phase',
            goalId: q.spec.id,
            current: phaseCurrent.get(q.spec.id) ?? 1,
            total: phaseTotal.get(q.spec.id) ?? 1,
          });
        }
      }
    }
    return events;
  };

  // Initial fill.
  fillSlots();

  // 3. Merge loop — the mergeCandidates race mechanic, one level up. Each pending
  //    entry races its worker's next step, tagged by goalId so a settled worker is
  //    dropped and the rest keep running concurrently.
  //
  // [CRITICAL-1] step() ISOLATES a generator rejection: a throwing goal generator
  //   must NOT reject the Promise.race and tear down its siblings. We catch the
  //   throw and surface it as a tagged result so the loop can emit a synthetic
  //   FAILED final for THAT goal and retire it, keeping every sibling + queued goal
  //   running.
  type StepOutcome =
    | { readonly id: string; readonly kind: 'result'; readonly result: IteratorResult<CoreEvent> }
    | { readonly id: string; readonly kind: 'threw'; readonly error: unknown };
  type Pending = Promise<StepOutcome>;
  const step = (id: string, gen: AsyncGenerator<CoreEvent>): Pending =>
    gen.next().then(
      (result): StepOutcome => ({ id, kind: 'result', result }),
      (error): StepOutcome => ({ id, kind: 'threw', error }),
    );

  const pending = new Map<string, Pending>();
  for (const [id, w] of workers) pending.set(id, step(id, w.gen));

  // [CRITICAL-2] Abort is a FIRST-CLASS loop exit, never a thing we trust children
  // to honor. This promise resolves the instant the caller aborts; we race it
  // against the pending steps so an UNCOOPERATIVE generator (one that ignores
  // signal.aborted and never returns) cannot wedge the loop. When abort wins we
  // break and let the `finally` force .return() on every live generator.
  const ABORT = Symbol('abort');
  const abortPromise: Promise<typeof ABORT> = signal.aborted
    ? Promise.resolve(ABORT)
    : new Promise<typeof ABORT>((resolve) => {
        signal.addEventListener('abort', () => resolve(ABORT), { once: true });
      });

  // [CRITICAL-1] Wrap the WHOLE merge loop so that on ANY exit (normal completion,
  // a throw, an early return from the consumer, or abort) we abort every live
  // child controller and call .return() on every still-pending generator — running
  // their finally/cleanup so nothing leaks.
  try {
    while (pending.size > 0) {
      // [CRITICAL-2] STRICT priority: if the caller has already aborted, exit NOW
      // without racing — an uncooperative generator whose .next() resolves
      // synchronously could otherwise keep winning the race ahead of the
      // already-resolved abortPromise and spin the loop. Checking the flag first
      // makes abort an unconditional, prompt loop exit.
      if (signal.aborted) {
        for (const [wid, w] of workers) {
          yield tagEvent(
            {
              type: 'final',
              success: false,
              output: `goal "${w.spec.title}" canceled`,
              tier: 'ic',
              totalCostUsd: 0,
              sessionId: '',
              attempts: 0,
              canceled: true,
            },
            wid,
          );
        }
        break;
      }
      // Race the pending steps against the abort signal. On abort, bail out of the
      // loop immediately — the finally cleans up the live generators.
      const winner = await Promise.race<StepOutcome | typeof ABORT>([
        ...pending.values(),
        abortPromise,
      ]);
      if (winner === ABORT) {
        // [CRITICAL-2] Abort won the race: emit an HONEST tagged canceled `final`
        // for every goal we are about to forcibly terminate (we no longer wait for
        // the child to voluntarily emit its own cancel final — it may never do so).
        // Then break; the `finally` aborts controllers + .return()s the generators.
        for (const [wid, w] of workers) {
          yield tagEvent(
            {
              type: 'final',
              success: false,
              output: `goal "${w.spec.title}" canceled`,
              tier: 'ic',
              totalCostUsd: 0,
              sessionId: '',
              attempts: 0,
              canceled: true,
            },
            wid,
          );
        }
        break;
      }

      const outcome = winner;
      const { id } = outcome;
      const worker = workers.get(id);

      // [CRITICAL-1] A generator that THREW: isolate it. Emit a synthetic tagged
      // FAILED final for THIS goal, retire it, keep siblings + queue going.
      if (outcome.kind === 'threw') {
        pending.delete(id);
        workers.delete(id);
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        yield tagEvent(
          {
            type: 'final',
            success: false,
            output: `goal "${worker?.spec.title ?? id}" crashed: ${message}`,
            tier: 'ic',
            totalCostUsd: 0,
            sessionId: '',
            attempts: 0,
          },
          id,
        );
        if (worker !== undefined) {
          phaseCurrent.set(id, (phaseCurrent.get(id) ?? 0) + 1);
          yield {
            type: 'goal-phase',
            goalId: id,
            current: phaseCurrent.get(id) ?? 1,
            total: phaseTotal.get(id) ?? 1,
          };
        }
        // A crash is a TERMINAL failure → record it and CASCADE: block + skip any
        // dependents (don't run a goal whose prerequisite failed).
        for (const blockedEv of recordOutcome(id, 'failed')) yield blockedEv;
        if (!signal.aborted) {
          fillSlots();
          for (const [wid, w] of workers) if (!pending.has(wid)) pending.set(wid, step(wid, w.gen));
        }
        continue;
      }

      const { result } = outcome;

      if (result.done) {
        // Generator returned without a `final` (defensive: orchestrate always emits
        // one, but a fake/edge generator may not). Retire the goal. With NO success
        // evidence we treat it as a failed prerequisite (HONESTY: never run a
        // dependent off a goal that produced no verified completion) — record +
        // cascade-block any dependents.
        pending.delete(id);
        workers.delete(id);
        for (const blockedEv of recordOutcome(id, 'failed')) yield blockedEv;
        if (!signal.aborted) {
          fillSlots();
          for (const [wid, w] of workers) if (!pending.has(wid)) pending.set(wid, step(wid, w.gen));
        }
        continue;
      }

      const ev = result.value;

      // TAG every event with its owning goalId (the one type seam). orchestrate
      // never sets goalId; we stamp it as we re-emit. We do NOT override a goalId a
      // (future) nested producer already set.
      yield tagEvent(ev, id);

      if (ev.type === 'final') {
        // This goal's phase finished. Decide: requeue (rate-limit) or retire.
        pending.delete(id);
        workers.delete(id);

        const isRateLimited = ev.success === false && ev.errorCategory === 'rate-limit';
        if (isRateLimited && !signal.aborted) {
          // 429 → requeue with backoff (queue, don't hammer). Re-enqueue its card.
          if (worker !== undefined) {
            requeueWithBackoff(worker.spec, ev.provider);
            yield { type: 'goal-enqueue', id: worker.spec.id, title: worker.spec.title, ...(worker.spec.dependsOn && worker.spec.dependsOn.length ? { dependsOn: worker.spec.dependsOn } : {}) };
            yield {
              type: 'notice',
              level: 'warn',
              message: `goal "${worker.spec.title}" hit a rate limit — requeued with backoff`,
            };
          }
        } else if (worker !== undefined) {
          // Phase complete (success or non-rate-limit failure). [HIGH-4] Advance
          // this goal's HONEST phase counter against its real (requeue-grown) total.
          phaseCurrent.set(worker.spec.id, (phaseCurrent.get(worker.spec.id) ?? 0) + 1);
          yield {
            type: 'goal-phase',
            goalId: worker.spec.id,
            current: phaseCurrent.get(worker.spec.id) ?? 1,
            total: phaseTotal.get(worker.spec.id) ?? 1,
          };
          // TERMINAL outcome for the DAG: a SUCCESSFUL final UNLOCKS dependents; a
          // non-rate-limit FAILURE BLOCKS them (skip + honest final). Recorded
          // BEFORE fillSlots so a freed dependent only starts once its deps are ok.
          for (const blockedEv of recordOutcome(worker.spec.id, ev.success ? 'ok' : 'failed')) {
            yield blockedEv;
          }
        }

        if (!signal.aborted) {
          // Pull the next ready queued goal(s) into freed slot(s).
          fillSlots();
          // Arm any newly started worker's first step.
          for (const [wid, w] of workers) if (!pending.has(wid)) pending.set(wid, step(wid, w.gen));

          // If everything in flight is done but goals remain in the queue backing
          // off, wait out the shortest backoff then try to fill again (don't busy-
          // spin, don't hammer). Bounded by the loop's normal termination.
          if (pending.size === 0 && queue.length > 0 && totalRuns < maxTotalRuns) {
            const soonest = queue.reduce((m, q) => Math.min(m, q.readyAt), Number.POSITIVE_INFINITY);
            const waitMs = Math.max(0, soonest - now());
            await sleep(waitMs);
            // [MED-5] We DELIBERATELY waited out the soonest backoff, so any goal
            // due by `soonest` is now ready BY CONSTRUCTION. Clamp its readyAt to
            // the post-sleep clock so a sub-millisecond skew between the timer
            // (`sleep`) and the monotonic clock (`now`) can't leave it perpetually
            // "not quite ready" and silently strand it (the frozen/skewed-clock
            // drop). Goals with a LATER readyAt stay backing off.
            const afterSleep = now();
            for (let i = 0; i < queue.length; i++) {
              const q = queue[i];
              if (q !== undefined && q.readyAt <= soonest) {
                queue[i] = { spec: q.spec, requeueCount: q.requeueCount, readyAt: afterSleep };
              }
            }
            fillSlots();
            for (const [wid, w] of workers) if (!pending.has(wid)) pending.set(wid, step(wid, w.gen));
          }
        }
        continue;
      }

      // A liveness event — re-arm this worker's next step so it keeps streaming.
      // We never requeue or fill new slots once aborted (the next race iteration's
      // abortPromise wins and breaks the loop).
      const liveWorker = workers.get(id);
      if (liveWorker !== undefined) {
        pending.set(id, step(id, liveWorker.gen));
      } else {
        pending.delete(id);
      }
    }
  } finally {
    // [CRITICAL-1]/[CRITICAL-2] On ANY exit, leave NOTHING leaked: abort every live
    // child controller and force .return() on every still-pending generator so its
    // finally/cleanup runs. This is what makes ESC + an uncooperative generator
    // TERMINATE promptly instead of waiting for a child to voluntarily finalize.
    for (const ac of allControllers) {
      try {
        ac.abort();
      } catch {
        /* AbortController.abort never throws; defensive only */
      }
    }
    for (const w of workers.values()) {
      // .return() resumes the generator at its suspension point as if `return` ran
      // there — running its finally/cleanup blocks. We FIRE it but DO NOT await: an
      // uncooperative generator stuck on a never-resolving `await` would otherwise
      // re-wedge us in the finally, defeating the whole point of CRITICAL-2. The
      // cleanup is initiated (and completes when/if the await settles); runSchedule
      // returns promptly regardless. Rejections are swallowed (best-effort).
      void Promise.resolve(w.gen.return(undefined as never)).catch(() => undefined);
    }
    workers.clear();
    pending.clear();
  }

  // 4. Termination notices (honest).
  if (signal.aborted) {
    yield { type: 'notice', level: 'warn', message: 'cancelled — stopped all running goals' };
    return;
  }
  if (ceilingHit) {
    yield {
      type: 'notice',
      level: 'warn',
      message: `stopped at the ${maxTotalRuns}-run ceiling — ${queue.length} goal(s) left queued`,
    };
  }
}

/**
 * Stamp a goalId onto the multi-goal-relevant CoreEvent variants (tier-start,
 * tier-done, provider-event, final) so the reducer keys each card by goal. Other
 * event types pass through unchanged (they carry no goalId field). Never
 * overwrites a goalId already present. PURE; total.
 */
function tagEvent(ev: CoreEvent, goalId: string): CoreEvent {
  switch (ev.type) {
    case 'tier-start':
    case 'tier-done':
    case 'provider-event':
    case 'final':
      return ev.goalId === undefined ? { ...ev, goalId } : ev;
    default:
      return ev;
  }
}
