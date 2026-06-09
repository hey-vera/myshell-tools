/**
 * src/interface/ui/run-stream.ts — the IMPURE consumer that wires the
 * CoreEvent stream to the PURE MVU reducer (STEP 3b of the Ink migration).
 *
 * `renderStreamInk` is the faithful, Ink-side re-expression of render.ts's
 * `renderStream`: it consumes the same `AsyncIterable<CoreEvent>` and dispatches
 * `Action`s into the pure `reduce` reducer, returning EXACTLY the same shape as
 * `renderStream` — `{ success, final?, rateLimitedProviders }`.
 *
 * It owns the impure machinery the pure reducer deliberately excludes (see the
 * 3a report's boundary section):
 *   - the per-tier stateful {@link EnvelopeFilter} (text deltas → cleaned
 *     `stream/prose` actions, via a CAPTURING OutputSink);
 *   - the live panel state (panelMode && synthesizing===null) → `panelCandidate`
 *     on each tier-done;
 *   - the rate-limited-provider set (a 429 against the running provider survives
 *     a later rescuing failover);
 *   - the injected CLOCK → `elapsedSecs` on the success final;
 *   - the pre-rendered actionable CLI-error string → `actionableError` on a
 *     failing final;
 *   - a THROTTLE that coalesces high-frequency prose/token deltas to a single
 *     React-state tick (so hundreds of deltas/sec never thrash Ink).
 *
 * EVERYTHING that decides VISIBLE TEXT lives in the pure reducer; this module is
 * only plumbing + the impure inputs the reducer needs. That split is what the
 * parity harness (run-stream-parity.test.ts) proves against legacy renderStream.
 */

import type { CoreEvent } from '../../core/types.js';
import type { ProviderId } from '../../providers/port.js';
import type { CliError, ErrorCategory } from '../../providers/errors.js';
import { classifyError, formatErrorMessage } from '../../providers/errors.js';
import { EnvelopeFilter, type OutputSink } from '../stream-filter.js';
import { styleInlineMarkdown } from '../../ui/theme.js';
import { coreEventToActions, isDebugEnv } from './core-event.js';
import type { Action, Verbosity } from './state.js';

// ---------------------------------------------------------------------------
// Capturing sink — turns EnvelopeFilter's emitted prose into plain chunks.
// ---------------------------------------------------------------------------

/**
 * A non-TTY {@link OutputSink} that captures everything the {@link EnvelopeFilter}
 * writes (already envelope-/goal-stripped, markdown styled if a styler is set)
 * into an in-memory buffer the consumer drains into `stream/prose` actions.
 *
 * `color`/`isTty` mirror the REAL OutputSink the legacy renderer ran under so the
 * EnvelopeFilter behaves identically (e.g. whether the markdown styler is line-
 * safe). The capture itself is direction-only — no terminal control bytes.
 */
interface CaptureSink extends OutputSink {
  /** Drain and clear everything written since the last drain. */
  drain(): string;
}

function makeCaptureSink(color: boolean, isTty: boolean): CaptureSink {
  let pending = '';
  return {
    color,
    isTty,
    write(s: string): void {
      pending += s;
    },
    drain(): string {
      const out = pending;
      pending = '';
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// actionable CLI error (mirrors render.ts cliErrorForCategory exactly)
// ---------------------------------------------------------------------------

/**
 * Reconstruct a {@link CliError} for a known {@link ErrorCategory} via a probe
 * string, REUSING errors.ts's classification + descriptor tables — byte-for-byte
 * the same table render.ts uses. Returns null for 'unknown' (no actionable
 * suggestion) or when the probe fails to reproduce the category.
 */
function cliErrorForCategory(category: ErrorCategory): CliError | null {
  const PROBES: Record<ErrorCategory, { stderr: string; exit: number }> = {
    auth: { stderr: 'authentication failed', exit: 1 },
    'rate-limit': { stderr: 'rate limit exceeded', exit: 1 },
    timeout: { stderr: 'request timed out', exit: 1 },
    network: { stderr: 'network error', exit: 1 },
    model: { stderr: 'model not found', exit: 1 },
    permission: { stderr: 'permission denied', exit: 126 },
    unknown: { stderr: '', exit: 1 },
  };
  const probe = PROBES[category];
  const err = classifyError(probe.stderr, probe.exit);
  return err.category === category && category !== 'unknown' ? err : null;
}

/** The provider-prefixed actionable error string for a failing final, or
 *  undefined when the category has no actionable suggestion. Mirrors the
 *  render.ts `final` non-timeout error branch. */
function actionableErrorFor(
  errorCategory: ErrorCategory | undefined,
  provider: ProviderId | undefined,
): string | undefined {
  if (errorCategory === undefined) return undefined;
  const cliErr = cliErrorForCategory(errorCategory);
  if (cliErr === null) return undefined;
  return formatErrorMessage(cliErr, provider);
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface RenderStreamInkOptions {
  readonly verbosity?: Verbosity;
  /**
   * Whether the surface emits colour. Threaded into the per-tier EnvelopeFilter
   * (so the markdown styler is enabled exactly as in render.ts: colour on AND
   * MYSHELL_NO_MARKDOWN unset) and into the capture sink. The Ink VIEW applies
   * colour-by-kind itself; the reducer text is colour-free, so this only governs
   * the envelope filter's styler, matching legacy. Default false (pipe parity).
   */
  readonly color?: boolean;
  /** Whether the surface is a TTY (threaded into the capture sink). Default
   *  false. The spinner/elapsed live in the impure clock below, not here. */
  readonly isTty?: boolean;
  /**
   * The injected clock → the success completion line's `· Ns` suffix. Returns the
   * elapsed SECONDS the turn was visible (legacy reads spinner.elapsed()). Inject
   * so tests are hermetic; absent → 0 (suffix omitted), matching a non-TTY run
   * where no ticks fire.
   */
  readonly elapsedSecs?: () => number;
  /** The env bag for MYSHELL_DEBUG (gates the classified line). Default
   *  process.env. Threaded so the consumer stays hermetically testable. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Schedule a coalesced flush of buffered prose/token actions into the reducer.
   * The default uses a ~40ms timer so hundreds of deltas/sec become a handful of
   * React-state ticks. Tests inject a SYNCHRONOUS scheduler so the harness can
   * compare final state deterministically. The returned function cancels a
   * pending flush (idempotent).
   */
  readonly scheduleFlush?: (flush: () => void) => () => void;
}

/** The default ~40ms coalescing scheduler (between the 30–60ms target band). */
function defaultScheduleFlush(flush: () => void): () => void {
  const handle = setTimeout(flush, 40);
  if (typeof handle === 'object' && typeof handle.unref === 'function') handle.unref();
  return () => clearTimeout(handle);
}

// ---------------------------------------------------------------------------
// renderStreamInk
// ---------------------------------------------------------------------------

/**
 * Consume the CoreEvent stream and dispatch reducer actions, returning the same
 * `{ success, final?, rateLimitedProviders }` shape as legacy `renderStream`.
 *
 * `dispatch` is the store's dispatch (Ink's `useReducer` dispatch in production,
 * a plain fold in tests). The THROTTLE coalesces prose + token updates: text
 * deltas accumulate cleaned prose in a pending buffer; a scheduled tick flushes
 * the merged `stream/prose` action. Structural events (which decide chrome) flush
 * any pending prose first, then dispatch immediately so ordering is preserved.
 */
export async function renderStreamInk(
  events: AsyncIterable<CoreEvent>,
  dispatch: (action: Action) => void,
  opts: RenderStreamInkOptions = {},
): Promise<{
  success: boolean;
  final?: Extract<CoreEvent, { type: 'final' }>;
  rateLimitedProviders: readonly ProviderId[];
}> {
  const verbosity: Verbosity = opts.verbosity ?? 'normal';
  const color = opts.color ?? false;
  const isTty = opts.isTty ?? false;
  const env = opts.env ?? process.env;
  const debug = isDebugEnv(env);
  const scheduleFlush = opts.scheduleFlush ?? defaultScheduleFlush;

  // The per-tier EnvelopeFilter's markdown styler is enabled exactly as render.ts
  // gates it: colour on AND MYSHELL_NO_MARKDOWN unset. Identity off-colour.
  const markdownEnabled = color && env['MYSHELL_NO_MARKDOWN'] === undefined;
  const proseStyler = markdownEnabled
    ? (text: string, atLineStart: boolean): string => styleInlineMarkdown(text, color, atLineStart)
    : undefined;

  // The capture sink + the current tier's EnvelopeFilter. We make a NEW filter at
  // each tier boundary (render.ts: prose = new EnvelopeFilter(...)) so a tier's
  // held-back control fragment never bleeds into the next tier.
  const sink = makeCaptureSink(color, isTty);
  let prose = new EnvelopeFilter(sink, proseStyler);

  // --- impure side state the pure reducer cannot derive ---
  const rateLimitedProviders = new Set<ProviderId>();
  let currentProvider: ProviderId | undefined;
  // Live panel state, mirroring render.ts. The reducer infers candidate-vs-normal
  // from stream.phase, but render.ts keys it off (panelMode && synthesizing===null)
  // at DISPATCH time — so we compute panelCandidate here and override the pure
  // mapping's default-false before dispatch.
  let panelMode = false;
  let synthesizing = false;
  let finalEvent: Extract<CoreEvent, { type: 'final' }> | undefined;

  // --- throttle: coalesce prose chunks into one merged stream/prose action, AND
  //     coalesce bursts of NON-VERBOSE tool-step bumps into the same flush tick ---
  let pendingProse = '';
  // Buffered NON-VERBOSE `stream/tool` actions. In normal/quiet verbosity a tool
  // event only bumps `stream.stepCount` (a live-status counter; it commits NO
  // transcript line — see reduce.ts), so its dispatch is order-INDEPENDENT of the
  // transcript. A burst of 28 tool calls otherwise fired 28 immediate dispatches =
  // 28 full re-renders. Buffering them and dispatching the whole burst inside ONE
  // scheduled flush callback lets React batch the setStates into a SINGLE re-render
  // while preserving the EXACT final state (still one +1 per tool event). Verbose
  // tool events commit a `[tool]` line and stay immediate via dispatchStructural so
  // their transcript ordering is untouched.
  let pendingSteps: Action[] = [];
  let cancelPending: (() => void) | null = null;

  function flushPending(): void {
    if (cancelPending !== null) {
      cancelPending();
      cancelPending = null;
    }
    if (pendingProse.length > 0) {
      const text = pendingProse;
      pendingProse = '';
      dispatch({ type: 'stream/prose', text });
    }
    if (pendingSteps.length > 0) {
      const steps = pendingSteps;
      pendingSteps = [];
      for (const step of steps) dispatch(step);
    }
  }

  function ensureScheduled(): void {
    if (cancelPending === null) {
      cancelPending = scheduleFlush(flushPending);
    }
  }

  function queueProse(chunk: string): void {
    if (chunk.length === 0) return;
    pendingProse += chunk;
    ensureScheduled();
  }

  /** Buffer a coalescable NON-VERBOSE tool-step bump so a burst flushes as one
   *  re-render. The action carries no transcript commit, so deferring it never
   *  reorders the committed transcript. */
  function queueStep(action: Action): void {
    pendingSteps.push(action);
    ensureScheduled();
  }

  /** Drain whatever the EnvelopeFilter just emitted into the throttle buffer. */
  function drainProse(): void {
    queueProse(sink.drain());
  }

  /** Dispatch a structural action, flushing any throttled prose + steps FIRST so
   *  the transcript ordering (prose then chrome) is preserved exactly as render.ts
   *  writes it. */
  function dispatchStructural(action: Action): void {
    flushPending();
    dispatch(action);
  }

  try {
    for await (const ev of events) {
    if (ev.type === 'provider-event') {
      const pe = ev.event;
      if (pe.type === 'text') {
        // Feed the raw delta through the per-tier EnvelopeFilter; whatever it
        // emits (cleaned, possibly markdown-styled) is queued as throttled prose.
        prose.push(pe.delta);
        drainProse();
        continue;
      }
      if (pe.type === 'error' && pe.error.category === 'rate-limit' && currentProvider !== undefined) {
        // Remember a 429 against the running provider (survives a rescuing
        // failover) — invisible side state, no reducer action.
        rateLimitedProviders.add(currentProvider);
        continue;
      }
      // tool / reasoning → structural actions; usage/done produce none. A
      // NON-VERBOSE `stream/tool` is a pure stepCount bump (no transcript commit),
      // so it is COALESCED via queueStep — a burst of tool calls flushes as one
      // re-render. Every other action (incl. verbose tool, which commits a `[tool]`
      // line) keeps its immediate, order-preserving dispatchStructural.
      for (const action of coreEventToActions(ev, verbosity, debug)) {
        if (action.type === 'stream/tool' && action.verbosity !== 'verbose') {
          queueStep(action);
        } else {
          dispatchStructural(action);
        }
      }
      continue;
    }

    switch (ev.type) {
      case 'tier-start': {
        currentProvider = ev.provider;
        for (const action of coreEventToActions(ev, verbosity, debug)) {
          dispatchStructural(action);
        }
        break;
      }

      case 'phase': {
        if (ev.phase === 'panel') {
          panelMode = true;
          synthesizing = false;
        } else if (ev.phase === 'synthesis') {
          synthesizing = true;
        }
        for (const action of coreEventToActions(ev, verbosity, debug)) {
          dispatchStructural(action);
        }
        break;
      }

      case 'tier-done': {
        // panelCandidate iff we're in panel mode and synthesis hasn't started —
        // exactly render.ts's (panelMode && synthesizing===null) gate. A candidate
        // tier-done flips a panelist + accounts tokens but does NOT flush prose.
        const panelCandidate = panelMode && !synthesizing;
        if (!panelCandidate) {
          // A real tier boundary: flush the per-tier EnvelopeFilter (envelope/goal
          // stripped at the boundary) and rotate to a fresh filter for the next
          // tier, mirroring render.ts (prose.finishAttempt(); prose = new …).
          prose.finishAttempt();
          drainProse();
          flushPending();
          prose = new EnvelopeFilter(sink, proseStyler);
        }
        // Map then override panelCandidate (the pure mapper defaults it false).
        for (const base of coreEventToActions(ev, verbosity, debug)) {
          const action =
            base.type === 'stream/flush-tier' ? { ...base, panelCandidate } : base;
          dispatchStructural(action);
        }
        break;
      }

      case 'final': {
        finalEvent = ev;
        // Flush held-back prose (envelope already stripped) BEFORE the completion
        // line, exactly as render.ts does (prose.flush() then the line).
        prose.flush();
        drainProse();
        flushPending();
        // Enrich the pure turn/final action with the impure inputs the reducer
        // cannot derive: the real elapsed seconds and the actionable error string.
        const [base] = coreEventToActions(ev, verbosity, debug);
        if (base !== undefined && base.type === 'turn/final') {
          const elapsedSecs = ev.success && ev.canceled !== true ? (opts.elapsedSecs?.() ?? 0) : 0;
          const actionableError =
            !ev.success && ev.canceled !== true && ev.errorCategory !== 'timeout'
              ? actionableErrorFor(ev.errorCategory, ev.provider)
              : undefined;
          const enriched: Action = {
            ...base,
            ...(elapsedSecs > 0 ? { elapsedSecs } : {}),
            ...(actionableError !== undefined ? { actionableError } : {}),
          };
          dispatchStructural(enriched);
        }
        break;
      }

      default: {
        // classified / intent / engagement / escalate / failover / notice.
        for (const action of coreEventToActions(ev, verbosity, debug)) {
          dispatchStructural(action);
        }
        break;
      }
    }
    }
  } finally {
    // Guaranteed cleanup on BOTH the normal end-of-stream AND a thrown event
    // stream (mirrors render.ts's finally): flush the per-tier EnvelopeFilter and
    // drain/flush any throttled prose so nothing held back is lost even when the
    // loop throws. All three are idempotent (flush no-ops once exhausted; drain
    // returns '' which queueProse ignores; flushPending no-ops with empty buffers),
    // so the normal-path flush in the `final` case is not double-emitted.
    // The error (if any) re-propagates after this block so runTask still sees it.
    prose.flush();
    drainProse();
    flushPending();
  }

  const rl = [...rateLimitedProviders];
  if (finalEvent !== undefined) {
    return { success: finalEvent.success, final: finalEvent, rateLimitedProviders: rl };
  }
  return { success: false, rateLimitedProviders: rl };
}
