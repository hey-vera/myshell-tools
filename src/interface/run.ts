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
import type { OutputSink, Verbosity } from './render.js';
import { renderStream } from './render.js';

/** Result returned by {@link runTask}. */
export interface RunTaskResult {
  /** Exit code: 0 on success, 1 on failure or error. */
  readonly code: number;
  /** The final CoreEvent, when one was emitted by orchestrate(). */
  readonly final?: Extract<CoreEvent, { type: 'final' }>;
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
): Promise<RunTaskResult> {
  try {
    const result = await renderStream(orchestrate(task, deps, signal), out, verbosity);
    return { code: result.success ? 0 : 1, ...(result.final !== undefined ? { final: result.final } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.write(`[error] ${msg}\n`);
    return { code: 1 };
  }
}
