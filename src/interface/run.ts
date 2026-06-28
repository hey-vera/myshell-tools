/**
 * src/interface/run.ts — single-task runner for the CLI `run` command.
 *
 * Bridges the orchestration core to the terminal output: calls orchestrate(),
 * pipes the event stream through renderStream(), and returns a numeric exit
 * code so that src/cli.ts — the only file allowed to call process.exit() —
 * can terminate the process appropriately.
 */

import type { CoreEvent, OrchestrateDeps } from '../core/types.js';
import { orchestrate } from '../core/orchestrate.js';
import type { OutputSink, TurnInputSurface, Verbosity } from './render.js';
import { renderStream } from './render.js';

/**
 * The streaming-render seam runTask drives a turn through. `renderStream` (the
 * legacy terminal renderer) is the default; the Ink path injects
 * `handle.renderTurn` (the reducer-backed renderStreamInk driver), which has the
 * SAME `{ success, final?, rateLimitedProviders }` return shape. Parameterizing
 * here — rather than forking runChatLoop — is what lets ONE conversation loop be
 * driven by either renderer.
 */
export type TurnRenderer = (
  events: AsyncIterable<CoreEvent>,
  out: OutputSink,
  verbosity: Verbosity,
  turnInput: TurnInputSurface | null | undefined,
  timeoutContinuation?: 'automatic' | 'prompt',
) => Promise<{
  success: boolean;
  final?: Extract<CoreEvent, { type: 'final' }>;
  rateLimitedProviders: readonly import('../providers/port.js').ProviderId[];
  rateLimitedAccounts: readonly string[];
}>;

/** Result returned by {@link runTask}. */
export interface RunTaskResult {
  /** Exit code: 0 on success, 1 on failure or error. */
  readonly code: number;
  /** The final CoreEvent, when one was emitted by orchestrate(). */
  readonly final?: Extract<CoreEvent, { type: 'final' }>;
  /**
   * Providers that hit a rate-limit at any point during the run (even when a
   * failover later rescued the turn into success). The conversation layer cools
   * these down for the next turn. Empty when none were throttled.
   */
  readonly rateLimitedProviders?: readonly import('../providers/port.js').ProviderId[];
  /**
   * OpenCode subscription accounts that hit a rate-limit. The conversation layer
   * cools these down per-account so sibling accounts stay available.
   */
  readonly rateLimitedAccounts?: readonly string[];
}

/**
 * Run a single task end-to-end, rendering every CoreEvent to the OutputSink.
 *
 * @param task   - The raw user task description.
 * @param deps   - Injected orchestration dependencies.
 * @param out    - Where rendered output is written.
 * @param signal - AbortSignal; abort to cancel the in-flight task.
 * @param verbosity - How much status chrome to render. Optional; defaults to
 *                    'normal' (clean conversation) so existing callers compile
 *                    unchanged.
 * @returns      { code, final } — code is 0 on success, 1 on failure or error.
 */
export async function runTask(
  task: string,
  deps: OrchestrateDeps,
  out: OutputSink,
  signal: AbortSignal,
  verbosity: Verbosity = 'normal',
  turnInput?: TurnInputSurface | null,
  // Optional render seam. Defaults to the legacy renderStream so every existing
  // caller is unchanged; the Ink path passes a renderStreamInk-backed renderer.
  render?: TurnRenderer,
  // Optional CoreEvent producer override. Defaults to a single `orchestrate(...)`
  // call (today's path, byte-for-byte). The bounded multi-goal SCHEDULER wiring
  // passes its merged goalId-tagged `runSchedule(...)` stream here so the SAME
  // renderer/return-shape drives the multi-goal StatusBlock. Purely additive: when
  // absent, behaviour is identical to before.
  events?: AsyncIterable<CoreEvent>,
  timeoutContinuation: 'automatic' | 'prompt' = 'prompt',
): Promise<RunTaskResult> {
  try {
    const renderTurn: TurnRenderer =
      render ??
      ((evs, sink, v, ti, continuation) =>
        renderStream(evs, sink, v, undefined, ti, continuation));
    const result = await renderTurn(
      events ?? orchestrate(task, deps, signal),
      out,
      verbosity,
      turnInput,
      timeoutContinuation,
    );
    return {
      code: result.success ? 0 : 1,
      ...(result.final !== undefined ? { final: result.final } : {}),
      ...(result.rateLimitedProviders.length > 0
        ? { rateLimitedProviders: result.rateLimitedProviders }
        : {}),
      ...(result.rateLimitedAccounts.length > 0
        ? { rateLimitedAccounts: result.rateLimitedAccounts }
        : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.write(`[error] ${msg}\n`);
    return { code: 1 };
  }
}
