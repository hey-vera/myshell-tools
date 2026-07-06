/**
 * src/interface/ui/mount.tsx — the Node-side mount path for the Ink chat UI
 * (Step 1, behind the default-OFF MYSHELL_INK flag).
 *
 * Owns three concerns kept OUT of the React tree so the pure App stays testable:
 *   1. the width-backfill bootstrap (headless/odd PTYs report columns===0, which
 *      makes Ink wrap everything to one column — MANDATORY before render());
 *   2. the {@link OutputSink} adapter that pushes committed transcript lines into
 *      the App via the {@link InkAppBridge};
 *   3. {@link createInkLineReader}, a {@link LineReader}-shaped adapter whose
 *      `nextLine()` resolves with the App's submitted input. The suspend/resume/
 *      capture/drain semantics are minimal stubs in Step 1 — full child-handoff
 *      and typed-ahead capture land in Step 2.
 *
 * Nothing here runs unless `inkEnabled(...)` is true, and that is wired behind a
 * dynamic import at the menu launch site so the default (flag-off) path pays no
 * startup cost.
 */

import React from 'react';
import { render } from 'ink';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { OutputSink } from '../stream-filter.js';
import type { LineReader, KeyInputStream } from '../menu-readline.js';
import type { CoreEvent } from '../../core/types.js';
import type { ProviderId } from '../../providers/port.js';
import { App, createInkAppBridge, type InkAppBridge, type InputBoxInfo } from './App.js';
import {
  reduce,
  initialState,
  renderStreamInk,
  type Action,
  type GoalBoardRow,
  type UiCapacityState,
  type UiSettingsSnapshot,
  type UiState,
  type Verbosity,
} from './index.js';

// ---------------------------------------------------------------------------
// 1. Width-backfill bootstrap
// ---------------------------------------------------------------------------

/**
 * Backfill `process.stdout.columns`/`rows` when a headless/odd PTY reports a
 * width < 2 (commonly 0 under `script`/CI), which would make Ink wrap every line
 * to a single column. Prefer the `COLUMNS`/`LINES` env, else default to 80×24.
 * Idempotent and side-effect-scoped to the stdout dimensions; never throws.
 *
 * Exported so the PTY smoke + tests can assert the backfill independently of a
 * real render().
 */
export function backfillTerminalSize(
  stream: { columns?: number; rows?: number } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const envCols = Number.parseInt(env['COLUMNS'] ?? '', 10);
    const envRows = Number.parseInt(env['LINES'] ?? '', 10);
    if (!(typeof stream.columns === 'number' && stream.columns >= 2)) {
      stream.columns = Number.isFinite(envCols) && envCols >= 2 ? envCols : 80;
    }
    if (!(typeof stream.rows === 'number' && stream.rows >= 2)) {
      stream.rows = Number.isFinite(envRows) && envRows >= 2 ? envRows : 24;
    }
  } catch {
    /* dimensions are best-effort; never block the mount */
  }
}

// ---------------------------------------------------------------------------
// 1b. Persistent reducer store (ONE UiState across the whole session)
// ---------------------------------------------------------------------------

/**
 * The single persistent reducer store the mount owns: ONE {@link UiState} that
 * spans EVERY turn of the session, plus a `dispatch` that folds an {@link Action}
 * and pushes the new snapshot to the App. This is the C1/C2 fix: the transcript
 * (`committed[]`) and the session-cumulative token total live HERE and are NEVER
 * reset to `initialState` between turns — a `turn/start` action resets only the
 * per-turn slice. The OutputSink chrome (`commit/raw`) and the streaming turn
 * driver BOTH dispatch into this same store, so there is ONE growing transcript
 * feeding `<Static>` (it only ever GROWS — append-only).
 */
export interface InkStore {
  /** The current persistent snapshot. */
  getState(): UiState;
  /** Fold one action and push the new snapshot to the App. */
  dispatch(action: Action): void;
}

export interface InkDispatchObservation {
  readonly action: Action;
  readonly before: UiState;
  readonly after: UiState;
  readonly stateChanged: boolean;
  readonly pushed: true;
}

export type InkStoreObserver = (observation: InkDispatchObservation) => void;

/** Build the persistent store, seeding the App with the initial snapshot so the
 *  structured (committed[]-backed) branch is the single `<Static>` source from
 *  mount — never the pre-first-state string fallback once a turn or chrome
 *  arrives. */
export function createInkStore(bridge: InkAppBridge, observer?: InkStoreObserver): InkStore {
  let state: UiState = initialState;
  bridge.pushState(state);
  return {
    getState: () => state,
    dispatch(action: Action): void {
      const before = state;
      state = reduce(state, action);
      const after = state;
      bridge.pushState(after);
      if (observer) {
        try {
          observer({ action, before, after, stateChanged: after !== before, pushed: true });
        } catch {
          /* swallow observer errors so instrumentation can never break the UI */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 2. OutputSink adapter
// ---------------------------------------------------------------------------

/**
 * An {@link OutputSink} whose `write(s)` commits chrome transcript lines into the
 * SAME persistent {@link InkStore} the streaming turn driver folds into (via a
 * `commit/raw` action), so out.write chrome and reducer prose share ONE growing
 * `committed[]` transcript — no chrome is lost between turns (C1) and `<Static>`
 * only ever grows (C2). Writes are split on newlines so each committed line is a
 * separate `<Static>` item; a trailing partial line (no newline yet) is buffered
 * and flushed when its newline arrives. `color`/`isTty` mirror the real stdout.
 */
export function createInkOutputSink(
  store: InkStore,
  opts: { readonly color: boolean; readonly isTty: boolean },
): OutputSink {
  let pending = '';
  // EPHEMERAL FRAME state. When `frame !== null`, write() routes whole lines into
  // `frame` (the live-frame buffer) instead of committing them; endFrame() flushes
  // it as ONE `chrome/replace` (replace, not append) so a fully-redrawn-every-key
  // surface (the menu) repaints in a bounded NON-<Static> region. This is the
  // menu-lag fix: committed[] no longer grows ~30 items per keypress.
  let frame: string[] | null = null;
  return {
    write(s: string): void {
      pending += s;
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        if (frame !== null) frame.push(line);
        else store.dispatch({ type: 'commit/raw', text: line });
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
    },
    // Open an ephemeral frame: subsequent write() lines accumulate in `frame`
    // (replacing the prior frame's content) rather than committing. Re-entrant-safe
    // (a second beginFrame keeps the buffer); the menu loop pairs each begin/end.
    beginFrame(): void {
      if (frame === null) frame = [];
    },
    // Flush the ephemeral frame: any buffered partial line is folded in, then the
    // whole frame REPLACES state.chrome (NON-<Static>, repaints in place). An empty
    // frame clears the region. After this, write() resumes committing as normal.
    endFrame(): void {
      if (frame === null) return;
      if (pending !== '') {
        frame.push(pending);
        pending = '';
      }
      const lines = frame;
      frame = null;
      store.dispatch({ type: 'chrome/replace', lines });
    },
    // Promote the painted live-frame region into the permanent transcript (and
    // clear it) — the menu→sub-flow handoff so the menu lingers in scrollback like
    // the legacy TTY. No-op when no frame is painted.
    promoteFrame(): void {
      store.dispatch({ type: 'chrome/promote' });
    },
    // Elite-partner Phase 1: REPLACE the persistent goal board with a fresh
    // GoalStore snapshot and flip the board ON. The menu calls this ONLY when the
    // board flag is on (it builds `rows` from goalStore.list() via the pure
    // goal-todo.ts shapers), so the action — and thus boardEnabled — never fires
    // when the flag is off. Pure replace into the same persistent store.
    syncBoard(rows: readonly GoalBoardRow[]): void {
      store.dispatch({ type: 'board/sync', rows, enabled: true });
    },
    // Phase 4C: replace the capacity snapshot with a fresh observation built from
    // real menu-loop signals. The menu calls this whenever real signals change
    // (chat entry, rate-limit updates, account/config changes).
    syncCapacity(capacity: UiCapacityState): void {
      store.dispatch({ type: 'capacity/sync', capacity });
    },
    // Phase 4D: replace the settings snapshot with a fresh projection of
    // AppConfig, pushed by the menu loop after initial load and every
    // successful settings mutation.
    syncSettings(settings: UiSettingsSnapshot): void {
      store.dispatch({ type: 'settings/sync', settings });
    },
    // Commit any buffered partial line (a prompt written WITHOUT a trailing
    // newline) as its own committed `<Static>` item so it becomes visible before
    // we block on input; a no-op when nothing is pending. Without this, trailing-
    // space prompts (e.g. "Sign in to claude? ") would sit in `pending` forever
    // and the question would never render on the Ink path.
    flush(): void {
      if (pending === '') return;
      // Inside a frame, the trailing partial belongs to the live-frame region (e.g.
      // the menu's "> " prompt), not the permanent transcript — buffer it in the
      // frame so endFrame() paints it in place. Outside a frame, commit as before.
      if (frame !== null) {
        frame.push(pending);
      } else {
        store.dispatch({ type: 'commit/raw', text: pending });
      }
      pending = '';
    },
    get color(): boolean {
      return opts.color;
    },
    get isTty(): boolean {
      return opts.isTty;
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Ink-backed LineReader
// ---------------------------------------------------------------------------

/**
 * Build a {@link LineReader} whose `nextLine()` resolves with the next line the
 * user submits in the Ink input box. This is the Step-2a READ-SIDE: it matches
 * the legacy {@link createLineReader} semantics exactly for the line/capture/
 * drain surface; only `suspend()`/`resume()` remain Step-2b stubs.
 *
 * Semantics mirrored from menu-readline.ts `createLineReader`:
 *  - Submitted lines are `.trim()`-ed (the legacy `rl.on('line')` trims `raw`).
 *  - A blank line is DROPPED while capture is active (a bare Enter is not a
 *    queued turn), and is delivered as `''` to a normal `nextLine()` waiter (the
 *    legacy reader delivers the trimmed empty string when capture is off).
 *  - `beginCapture(onLine)` is EXCLUSIVE — it throws if a capture is already
 *    active — and routes every non-blank submitted line to `onLine` instead of
 *    the buffer/waiters. Returns an idempotent detach.
 *  - `currentLine()` returns the InputBox's in-progress edit buffer.
 *  - `drainBuffered()`/`clearBuffered()` operate on the unconsumed line buffer.
 *  - `close()` resolves every pending/future `nextLine()` with `null`.
 *  - Each submitted non-blank line is also seeded into the InputBox history so a
 *    fresh box (e.g. after a remount) keeps Up/Down history.
 *
 * `suspend()`/`resume()` stay as Step-1/2b stubs (the inherited-stdio child
 * handoff is Step 2b); the read-side works without them.
 */
export function createInkLineReader(bridge: InkAppBridge): LineReader {
  const buffered: string[] = [];
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;
  // When non-null, a model turn is active and full non-blank lines typed
  // mid-turn are routed here (typed-ahead capture) instead of buffer/waiters.
  let capture: ((line: string) => void) | null = null;
  // Suspend/resume state for the inherited-stdio child handoff (Step 2b).
  let suspended = false;
  // The ~250ms blank-line suppression window after resume(): an inherited-stdio
  // child (e.g. `claude auth login`) often leaves its submit Enter queued as it
  // exits; drop only that immediate blank line so it never auto-answers the next
  // prompt. Mirrors menu-readline.ts `suppressEmptyUntil`/`suppressGeneration`.
  let suppressEmptyUntil = 0;
  let suppressGeneration = 0;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSuppressTimer(): void {
    if (suppressTimer !== null) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  bridge.onSubmit((raw: string) => {
    if (closed) return;
    const line = raw.trim();
    if (line === '' && Date.now() <= suppressEmptyUntil) {
      // The child's trailing submit-Enter (or a stray newline from re-priming raw
      // mode). Drop exactly this one blank line so the next prompt is not auto-
      // answered with an empty submission. Matches the legacy rl.on('line') quirk.
      suppressEmptyUntil = 0;
      suppressGeneration += 1;
      return;
    }
    suppressEmptyUntil = 0;
    suppressGeneration += 1;
    if (capture !== null) {
      // Mid-turn typed-ahead: blank lines dropped (a bare Enter is not a queued
      // turn); non-blank lines go to the capture sink, never to buffer/waiters.
      if (line !== '') capture(line);
      return;
    }
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else buffered.push(line);
  });

  return {
    nextLine(): Promise<string | null> {
      if (buffered.length > 0) {
        const next = buffered.shift();
        return Promise.resolve(next ?? null);
      }
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    // Release the TTY so an inherited-stdio child (e.g. `claude auth login`)
    // becomes the SOLE reader of fd0. The Ink analogue of menu-readline.ts
    // `suspend()`.
    //
    // Ink 6 reads input via a `'readable'` listener (NOT flowing-mode `data`):
    // its `useInput` raw-mode refcount, when it hits 0, REMOVES that listener,
    // sets cooked mode and `unref()`s — so flipping the InputBox's `useInput` to
    // isActive:false is what truly releases the stream. We therefore do NOT
    // `pause()`/`resume()` the stream (that would switch it to flowing mode and
    // break Ink's readable-mode reads — the cause of a dead input after resume),
    // and we drive INK's OWN `setRawMode` (never process.stdin's, which Ink
    // re-applies on its next render and would fight the child).
    //
    // Idempotent: a no-op second call.
    suspend(): void {
      if (suspended) return;
      suspended = true;
      // 1. Make the input hook inactive. On Ink's next effect pass its raw-mode
      //    refcount drops to 0 → readable listener removed, cooked mode, unref:
      //    the child becomes the sole reader of fd0.
      bridge.setSuspended(true);
      // 2. Belt-and-suspenders: force cooked mode NOW via Ink's setRawMode so the
      //    child sees a cooked TTY even before React re-renders. This decrements
      //    Ink's refcount to 0 (removing the readable listener immediately); the
      //    pending isActive:false effect's own setRawMode(false) then no-ops
      //    (Ink guards refcount===0), so the count stays consistent. Best-effort.
      bridge.stdinControl?.setRawMode(false);
      // 3. Drop any line we'd already buffered (e.g. a stray Enter) so it can't
      //    bleed into the next prompt after the child exits. Matches legacy.
      buffered.length = 0;
    },
    // Take the TTY back after the inherited-stdio child exited. The Ink analogue
    // of menu-readline.ts `resume()`: re-activate the input hook (Ink re-adds its
    // `'readable'` listener + re-takes raw mode + `ref()`s on the refcount 0→1
    // transition — this IS the re-prime, replacing the legacy setRawMode off→on
    // cycle that re-armed libuv's flowing read handle), and arm the ~250ms
    // blank-line suppression so the child's trailing submit-Enter doesn't
    // auto-submit an empty line. Idempotent.
    resume(): void {
      if (!suspended) return;
      suspended = false;
      // 1. Drop any line the child left buffered (typically the trailing Enter the
      //    user pressed to submit a pasted code) so it can't desync the next prompt.
      buffered.length = 0;
      // 2. Arm the blank-line suppression window. TTY-only in legacy; here we gate
      //    on Ink's raw-mode support (its TTY signal). A bare Enter that lands in
      //    this window is dropped, not delivered as an empty submission.
      const control = bridge.stdinControl;
      if (control === null || control.isRawModeSupported) {
        suppressEmptyUntil = Date.now() + 250;
        const generation = suppressGeneration;
        clearSuppressTimer();
        suppressTimer = setTimeout(() => {
          suppressTimer = null;
          if (suppressGeneration === generation) {
            suppressEmptyUntil = 0;
            buffered.length = 0;
          }
        }, 250);
        suppressTimer.unref?.();
      }
      // 3. Re-activate Ink's input hook. On the refcount 0→1 transition Ink
      //    re-adds the `'readable'` listener and re-enables raw mode, so the FIRST
      //    keypress after resume is read (the historical first-paste-after-login
      //    regression guard). No manual stream resume — that would break readable
      //    mode.
      bridge.setSuspended(false);
      // Eager re-arm (for resume lag on Replit etc): force raw true immediately
      // after the transition so first keystroke after attach is captured without
      // kill/retype. Best-effort, matches legacy off→on cycle intent.
      if (control && control.isRawModeSupported) {
        try {
          control.setRawMode(true);
        } catch {
          /* unsupported or transient */
        }
      }
    },
    close(): void {
      closed = true;
      clearSuppressTimer();
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(null);
      }
    },
    beginCapture(onLine: (line: string) => void): () => void {
      // Exclusive: a second concurrent capture owner would be a real bug (two
      // turns claiming mid-turn input at once). Throw rather than silently steal.
      if (capture !== null) {
        throw new Error('createInkLineReader: capture already active');
      }
      capture = onLine;
      let detached = false;
      return (): void => {
        if (detached) return;
        detached = true;
        if (capture === onLine) capture = null;
      };
    },
    currentLine(): string {
      // Mirror the InputBox's in-progress edit buffer (the legacy reader returns
      // readline's `.line`).
      return bridge.input.currentLine();
    },
    drainBuffered(): string[] {
      const drained = buffered.slice();
      buffered.length = 0;
      return drained;
    },
    clearBuffered(): void {
      buffered.length = 0;
    },
    cancelPending(): void {
      // Resolve+drop every orphaned awaiter so a line typed after an abandoned
      // nextLine() await isn't delivered FIFO to a dead resolver and swallowed.
      // Parity with menu-readline.ts createLineReader.cancelPending. Does NOT
      // touch buffer/capture/closed state.
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(null);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Streaming turn driver (STEP 3b)
// ---------------------------------------------------------------------------

/**
 * Drive ONE model turn through the pure reducer and mirror each snapshot into the
 * Ink App (committed lines → `<Static>`, live answer → `<Stream>`). This is the
 * Ink-side equivalent of calling render.ts `renderStream`: it consumes the same
 * `AsyncIterable<CoreEvent>` and returns the SAME `{ success, final?,
 * rateLimitedProviders }` shape, so the menu loop can swap it in 1:1.
 *
 * The reducer state is the SINGLE persistent {@link InkStore} the mount owns (NOT
 * a fresh per-turn fold) — the C1/C2 fix. Each turn begins with a `turn/start`
 * action that resets ONLY the per-turn slice (live stream, goals, turnActive, the
 * per-turn token counter) while PRESERVING `committed[]` and the session token
 * total, so the transcript carries forward and `<Static>` only ever grows.
 * `renderStreamInk` owns the throttle (so high-frequency prose deltas coalesce
 * before they reach React). `elapsedSecs` is injected by the caller (the menu's
 * spinner clock) so the success line's `· Ns` suffix stays honest and the driver
 * stays hermetically testable.
 */
export function createTurnDriver(
  store: InkStore,
  base: { readonly color: boolean; readonly isTty: boolean },
): (
  events: AsyncIterable<CoreEvent>,
  opts?: {
    readonly verbosity?: Verbosity;
    readonly elapsedSecs?: () => number;
    readonly timeoutContinuation?: 'automatic' | 'prompt';
  },
) => Promise<{
  success: boolean;
  final?: Extract<CoreEvent, { type: 'final' }>;
  rateLimitedProviders: readonly ProviderId[];
  rateLimitedAccounts: readonly string[];
}> {
  return async (events, opts = {}) => {
    // Reset ONLY the per-turn slice; committed[] and tokens.session carry forward.
    // An optimistic beginTurn() may already have dispatched turn/start while the
    // menu was still building dependencies; do not reset the live turn twice.
    if (!store.getState().turnActive) {
      store.dispatch({ type: 'turn/start' });
    }
    return renderStreamInk(events, store.dispatch, {
      color: base.color,
      isTty: base.isTty,
      ...(opts.verbosity !== undefined ? { verbosity: opts.verbosity } : {}),
      ...(opts.elapsedSecs !== undefined ? { elapsedSecs: opts.elapsedSecs } : {}),
      ...(opts.timeoutContinuation !== undefined
        ? { timeoutContinuation: opts.timeoutContinuation }
        : {}),
    });
  };
}

// ---------------------------------------------------------------------------
// 5. Watchdog heartbeat sampler
// ---------------------------------------------------------------------------

export type WatchdogReason = 'hard-stall' | 'active-stale';

export interface WatchdogSnapshot {
  readonly reason: WatchdogReason;
  readonly consecutiveBadSamples: number;
  readonly msSinceLastUiCommit: number;
  readonly msSinceLastInput: number;
  readonly msSinceLastTurnActivity: number;
  readonly lastSampleDriftMs: number;
  readonly lastHistogramMaxMs: number;
  readonly lastHistogramP99Ms: number;
}

export interface WatchdogHeartbeat {
  recordUiCommit(): void;
  recordInput(): void;
  recordTurnActivity(): void;
  setChatActive(active: boolean): void;
  setSuspended(suspended: boolean): void;
  stop(): void;
}

export interface WatchdogOptions {
  readonly samplerIntervalMs: number;
  readonly badSampleThresholdMs: number;
  readonly badSampleP99ThresholdMs: number;
  readonly consecutiveBadSamplesRequired: number;
  readonly staleWindowMs: number;
  readonly hardStallThresholdMs: number;
  readonly armCooldownMs: number;
  readonly isTty: boolean;
  readonly onUnresponsive: (snapshot: WatchdogSnapshot) => void;
  readonly now: () => number;
  /**
   * When `true`, the watchdog will not arm until both the normal
   * `armCooldownMs` has elapsed AND at least one successful UI commit has
   * been recorded via `recordUiCommit()`. This prevents immediate recovery
   * loops when the recovered conversation is still rendering.
   */
  readonly recoveryRelaunch: boolean;
}

const DEFAULT_WATCHDOG: Omit<WatchdogOptions, 'onUnresponsive' | 'isTty'> = {
  samplerIntervalMs: 500,
  badSampleThresholdMs: 2_000,
  badSampleP99ThresholdMs: 750,
  consecutiveBadSamplesRequired: 3,
  staleWindowMs: 8_000,
  hardStallThresholdMs: 10_000,
  armCooldownMs: 15_000,
  now: () => Date.now(),
  recoveryRelaunch: false,
};

export function createWatchdog(opts: WatchdogOptions): WatchdogHeartbeat {
  if (!opts.isTty) {
    return {
      recordUiCommit() {},
      recordInput() {},
      recordTurnActivity() {},
      setChatActive() {},
      setSuspended() {},
      stop() {},
    };
  }

  const now = opts.now;
  let lastUiCommitMs = now();
  let lastInputMs = 0;
  let lastTurnActivityMs = 0;
  let chatActive = false;
  let suspended = false;
  let consecutiveBadSamples = 0;
  let fired = false;
  let hasUiCommit = false;

  const armedAtMs = now() + opts.armCooldownMs;
  let expectedNextSampleMs = now() + opts.samplerIntervalMs;

  let histogram: IntervalHistogram | null = null;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    histogram = null;
  }

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || fired) return;

    const sampleMs = now();
    const drift = sampleMs - expectedNextSampleMs;
    expectedNextSampleMs = sampleMs + opts.samplerIntervalMs;

    let histMax = 0;
    let histP99 = 0;
    if (histogram !== null) {
      // monitorEventLoopDelay reports nanoseconds. The watchdog contract and
      // snapshots are expressed in milliseconds, so normalize before applying
      // thresholds (otherwise an ordinary 20 ms sample looks like 20,000,000 ms).
      histMax = histogram.max / 1_000_000;
      histP99 = histogram.percentile(99) / 1_000_000;
      histogram.reset();
    }

    const isBadSample =
      drift >= opts.badSampleThresholdMs ||
      histMax >= opts.badSampleThresholdMs ||
      histP99 >= opts.badSampleP99ThresholdMs;

    if (isBadSample) {
      consecutiveBadSamples++;
    } else {
      consecutiveBadSamples = 0;
    }

    if (sampleMs < armedAtMs) return;
    if (opts.recoveryRelaunch && !hasUiCommit) return;
    if (suspended) return;

    const watchedActive =
      chatActive &&
      (lastInputMs > 0 || lastTurnActivityMs > 0) &&
      (sampleMs - Math.max(lastInputMs, lastTurnActivityMs) < 60_000);

    if (!watchedActive) return;

    if (drift >= opts.hardStallThresholdMs) {
      fired = true;
      opts.onUnresponsive({
        reason: 'hard-stall',
        consecutiveBadSamples,
        msSinceLastUiCommit: sampleMs - lastUiCommitMs,
        msSinceLastInput: lastInputMs > 0 ? sampleMs - lastInputMs : -1,
        msSinceLastTurnActivity: lastTurnActivityMs > 0 ? sampleMs - lastTurnActivityMs : -1,
        lastSampleDriftMs: drift,
        lastHistogramMaxMs: histMax,
        lastHistogramP99Ms: histP99,
      });
      return;
    }

    if (
      consecutiveBadSamples >= opts.consecutiveBadSamplesRequired &&
      sampleMs - lastUiCommitMs >= opts.staleWindowMs
    ) {
      const lastActivity = Math.max(lastInputMs, lastTurnActivityMs);
      if (lastActivity > 0 && sampleMs - lastActivity >= opts.staleWindowMs) {
        fired = true;
        opts.onUnresponsive({
          reason: 'active-stale',
          consecutiveBadSamples,
          msSinceLastUiCommit: sampleMs - lastUiCommitMs,
          msSinceLastInput: lastInputMs > 0 ? sampleMs - lastInputMs : -1,
          msSinceLastTurnActivity: lastTurnActivityMs > 0 ? sampleMs - lastTurnActivityMs : -1,
          lastSampleDriftMs: drift,
          lastHistogramMaxMs: histMax,
          lastHistogramP99Ms: histP99,
        });
      }
    }
  }, opts.samplerIntervalMs);

  timer.unref?.();

  return {
    recordUiCommit(): void {
      hasUiCommit = true;
      lastUiCommitMs = now();
    },
    recordInput(): void {
      lastInputMs = now();
    },
    recordTurnActivity(): void {
      lastTurnActivityMs = now();
    },
    setChatActive(active: boolean): void {
      chatActive = active;
    },
    setSuspended(s: boolean): void {
      suspended = s;
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
      if (histogram !== null) {
        try {
          histogram.disable();
        } catch {
          /* best-effort */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mount entry point
// ---------------------------------------------------------------------------

export interface InkMountHandle {
  readonly out: OutputSink;
  readonly reader: LineReader;
  /**
   * Read EXACTLY ONE keypress through Ink's own input pipeline (the menu/confirm
   * single-key nav on the Ink path). Resolves with a legacy-`readSingleKey`-shaped
   * string (`'n'`, `'\r'`, `'\x1b'`, `'\x03'`, …) so `readMenuKey`/`confirmViaKey`
   * interpret it unchanged. The InputBox editor goes inactive for the duration and
   * resumes cleanly after exactly one key. See {@link InkAppBridge.readKey}.
   */
  readKey(): Promise<string>;
  /**
   * Install (or clear with `null`) the turn-interrupt handler on the App bridge.
   * The menu loop sets it to abort the in-flight turn for the duration of each Ink
   * turn; the `<InputBox>` routes a bare ESC to it (H1). See
   * {@link InkAppBridge.setInterrupt}.
   */
  setInterrupt(handler: (() => void) | null): void;
  setInputInfo(info: InputBoxInfo | null): void;
  /**
   * Flip whether an active chat conversation is in progress. `true` shows the chat
   * composer; `false` (the default — menu / auth-login / settings) hides it. The
   * menu loop calls this `true` at `runChatLoop` entry and `false` on exit. See
   * {@link InkAppBridge.setChatActive}.
   */
  setChatActive(active: boolean): void;
  /** Optimistically enter the live-turn state before expensive preflight awaits. */
  beginTurn(): void;
  /** Clear an optimistic preflight turn that never reached renderTurn(). */
  resetTurn(): void;
  /**
   * Enable or disable the main-menu key-capture window (BUG 2 fix). While active,
   * printable keys arriving while no readKey resolver is pending are queued in a
   * FIFO instead of falling into the hidden InputBox editor, so the menu loop
   * processes them in order. The menu loop arms this before paint and disarms
   * before sub-flows (chat, settings, login). No-op on the legacy path.
   */
  setMenuCaptureActive(active: boolean): void;
  /**
   * Register (or clear with `null`) the handler for Control Panel settings
   * intents. The menu loop registers this once at startup so the bridge can route
   * settings mutations into the menu-settings helpers. (Phase 4D)
   */
  onControlPanelSettingAction(
    handler: ((action: { readonly key: string; readonly value?: string | boolean }) => void) | null,
  ): void;
  /**
   * Drive one model turn's CoreEvent stream into the reducer-backed transcript
   * (the STEP-3b streaming path). Same return shape as render.ts `renderStream`.
   */
  renderTurn(
    events: AsyncIterable<CoreEvent>,
    opts?: {
      readonly verbosity?: Verbosity;
      readonly elapsedSecs?: () => number;
      readonly timeoutContinuation?: 'automatic' | 'prompt';
    },
  ): Promise<{
    success: boolean;
    final?: Extract<CoreEvent, { type: 'final' }>;
    rateLimitedProviders: readonly ProviderId[];
    rateLimitedAccounts: readonly string[];
  }>;
  /** Resolves when the Ink app unmounts (e.g. Ctrl-C / explicit unmount). */
  waitUntilExit(): Promise<void>;
  /** Tear down the Ink render and the LineReader. */
  unmount(): void;
  /** Stop the watchdog sampler. Called on unmount; exposed for explicit early stop. */
  stopWatchdog(): void;
  /** Disable/enable watchdog detection (e.g. while an inherited-stdio child owns the TTY). */
  setWatchdogSuspended(suspended: boolean): void;
}

export interface InkMountOptions {
  readonly color: boolean;
  readonly isTty: boolean;
  readonly stdin?: KeyInputStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly onUnresponsive?: (snapshot: WatchdogSnapshot) => void;
}

/**
 * Bootstrap + mount the Ink chat app. Backfills the terminal size FIRST (Ink
 * reads stdout dimensions at render time), then renders the App and returns the
 * OutputSink + LineReader adapters plus lifecycle handles for the menu loop.
 */
export function mountInk(opts: InkMountOptions): InkMountHandle {
  backfillTerminalSize();

  const bridge = createInkAppBridge();
  const env = opts.env ?? process.env;
  const recoveryRelaunch = env['MYSHELL_RECOVERY_RELAUNCH'] === '1';

  let watchdog: WatchdogHeartbeat | null = null;

  const store = createInkStore(bridge, (obs) => {
    if (obs.stateChanged && watchdog !== null) {
      watchdog.recordUiCommit();
    }
  });
  bridge.onControlPanelAction((a) => store.dispatch(a));
  const out = createInkOutputSink(store, { color: opts.color, isTty: opts.isTty });
  const reader = createInkLineReader(bridge);
  const renderTurn = createTurnDriver(store, { color: opts.color, isTty: opts.isTty });
  const beginTurn = (): void => {
    if (!store.getState().turnActive) store.dispatch({ type: 'turn/start' });
    watchdog?.recordTurnActivity();
  };
  const resetTurn = (): void => {
    if (store.getState().turnActive) store.dispatch({ type: 'turn/reset' });
  };

  const noopUnresponsive = (_snapshot: WatchdogSnapshot): void => {};
  watchdog = createWatchdog({
    ...DEFAULT_WATCHDOG,
    isTty: opts.isTty,
    onUnresponsive: opts.onUnresponsive ?? noopUnresponsive,
    recoveryRelaunch,
  });

  // The ErrorBoundary's teardown needs reader.close() + instance.unmount(), but the
  // Ink instance doesn't exist until render() returns. A forward-declared holder
  // lets the App's onFatalError reach it once it's assigned (the boundary only
  // fires on a later render throw, by which time instance is set).
  let inkInstance: ReturnType<typeof render> | null = null;
  const onFatalError = (_error: Error): void => {
    // Resolve every pending/future nextLine() with null and tear down the React
    // tree — the same teardown unmount() runs. Best-effort; never re-throws.
    try {
      reader.close();
    } catch {
      /* best-effort */
    }
    try {
      inkInstance?.unmount();
    } catch {
      /* best-effort */
    }
  };

  const instance = render(
    <App
      bridge={bridge}
      color={opts.color}
      isTty={opts.isTty}
      {...(typeof process.stdout.columns === 'number' ? { columns: process.stdout.columns } : {})}
      {...(typeof process.stdout.rows === 'number' ? { rows: process.stdout.rows } : {})}
      clock={() => Date.now()}
      onFatalError={onFatalError}
    />,
    {
      // Pass a custom stdin (e.g. the /dev/tty ReadStream) when supplied so Ink
      // reads raw input from the controlling terminal. `render` accepts a Node
      // ReadStream; the KeyInputStream slice is a structural superset for our use.
      ...(opts.stdin !== undefined
        ? { stdin: opts.stdin as unknown as NodeJS.ReadStream }
        : {}),
    },
  );
  inkInstance = instance;

  return {
    out,
    reader,
    readKey: () => {
      watchdog?.recordInput();
      return bridge.readKey();
    },
    setInterrupt: (handler) => bridge.setInterrupt(handler),
    setInputInfo: (info) => bridge.setInputInfo(info),
    setChatActive: (active) => {
      bridge.setChatActive(active);
      watchdog?.setChatActive(active);
    },
    setMenuCaptureActive: (active) => bridge.setMenuCaptureActive(active),
    onControlPanelSettingAction: (handler) => bridge.onControlPanelSettingAction(handler),
    beginTurn,
    resetTurn,
    renderTurn,
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
    stopWatchdog(): void {
      watchdog?.stop();
    },
    setWatchdogSuspended: (suspended) => {
      watchdog?.setSuspended(suspended);
    },
    unmount(): void {
      watchdog?.stop();
      const pendingKey = bridge._keyResolver;
      bridge._keyResolver = null;
      bridge._menuKeyQueue.length = 0;
      bridge._menuCaptureActive = false;
      if (pendingKey != null) pendingKey('\x03');
      reader.close();
      instance.unmount();
    },
  };
}
