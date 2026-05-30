/**
 * src/interface/repl.ts — interactive REPL for myshell-tools.
 *
 * Presents a `myshell-tools> ` prompt, dispatching each line as a task via runTask().
 * Built-in commands: /exit, /quit, /help.
 *
 * SIGINT behaviour:
 *   - If a task is in flight → abort it and keep the REPL alive.
 *   - If idle → close the readline interface and resolve.
 *
 * Never calls process.exit() — that responsibility belongs exclusively to
 * src/cli.ts.
 */

import readline from 'node:readline';
import type { OrchestrateDeps } from '../core/types.js';
import type { OutputSink } from './render.js';
import { runTask } from './run.js';

const REPL_HELP = `\
Available commands:
  /help     Show this help message
  /exit     Exit the REPL
  /quit     Exit the REPL
  <task>    Run a task (any other non-empty line)
`;

/**
 * Start an interactive REPL session. Resolves when the user exits or when the
 * readline interface is closed.
 *
 * @param deps - Injected orchestration dependencies.
 * @param out  - Where rendered output is written.
 */
export async function startRepl(deps: OrchestrateDeps, out: OutputSink): Promise<void> {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'myshell-tools> ',
      terminal: out.isTty,
    });

    // Track the in-flight AbortController so SIGINT can cancel it.
    let currentAc: AbortController | null = null;

    rl.on('SIGINT', () => {
      if (currentAc !== null) {
        // Task in flight — abort it, keep the REPL alive.
        currentAc.abort();
        out.write('\n[warn] Task cancelled.\n');
        rl.prompt();
      } else {
        // Idle — close and resolve.
        out.write('\n');
        rl.close();
      }
    });

    rl.on('close', () => {
      resolve();
    });

    rl.on('line', (rawLine: string) => {
      const line = rawLine.trim();

      if (line.length === 0) {
        rl.prompt();
        return;
      }

      if (line === '/exit' || line === '/quit') {
        rl.close();
        return;
      }

      if (line === '/help') {
        out.write(REPL_HELP);
        rl.prompt();
        return;
      }

      // Pause readline while the task runs to avoid interleaved output.
      rl.pause();

      const ac = new AbortController();
      currentAc = ac;

      runTask(line, deps, out, ac.signal).then(() => {
        currentAc = null;
        rl.resume();
        rl.prompt();
      }).catch((err: unknown) => {
        currentAc = null;
        const msg = err instanceof Error ? err.message : String(err);
        out.write(`[error] ${msg}\n`);
        rl.resume();
        rl.prompt();
      });
    });

    rl.prompt();
  });
}
