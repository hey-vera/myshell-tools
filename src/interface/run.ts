/**
 * src/interface/run.ts — single-task runner for the CLI `run` command.
 *
 * Bridges the orchestration core to the terminal output: calls orchestrate(),
 * pipes the event stream through renderStream(), and returns a numeric exit
 * code so that src/cli.ts — the only file allowed to call process.exit() —
 * can terminate the process appropriately.
 */

import type { OrchestrateDeps } from '../core/types.js';
import { orchestrate } from '../core/orchestrate.js';
import type { OutputSink } from './render.js';
import { renderStream } from './render.js';

/**
 * Run a single task end-to-end, rendering every CoreEvent to the OutputSink.
 *
 * @param task   - The raw user task description.
 * @param deps   - Injected orchestration dependencies.
 * @param out    - Where rendered output is written.
 * @param signal - AbortSignal; abort to cancel the in-flight task.
 * @returns      0 on success, 1 on failure or error.
 */
export async function runTask(
  task: string,
  deps: OrchestrateDeps,
  out: OutputSink,
  signal: AbortSignal,
): Promise<number> {
  try {
    const result = await renderStream(orchestrate(task, deps, signal), out);
    return result.success ? 0 : 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    out.write(`[error] ${msg}\n`);
    return 1;
  }
}
