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
import { createTurnCallBudget } from '../core/turn-call-budget.js';
import type { OutputSink } from './render.js';
import { runTask } from './run.js';
import { completeChat } from './menu-completion.js';
import { resolveImageAttachments } from '../infra/attachments.js';

/** Slash-commands offered by the REPL's Tab-completer. */
const REPL_SLASH_COMMANDS: readonly string[] = ['/help', '/exit', '/quit'];

const REPL_HELP = `\
Available commands:
  /help     Show this help message
  /exit     Exit the REPL
  /quit     Exit the REPL
  <task>    Run a task (any other non-empty line)
  (The full chat experience — memory, recap, /style — lives in the menu chat.)
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
      // Smart Tab — shares the chat completer engine (slash-name + path + @),
      // scoped to the REPL's own slash-command set. Async (readdir); any error
      // degrades to a safe no-op (never throws).
      completer: (line: string, cb: (err: null, result: [string[], string]) => void) => {
        completeChat(line, { commands: REPL_SLASH_COMMANDS }).then(
          (result) => cb(null, result),
          () => cb(null, [[], line]),
        );
      },
    });

    // Track the in-flight AbortController so SIGINT can cancel it.
    let currentAc: AbortController | null = null;

    rl.on('SIGINT', () => {
      if (currentAc !== null) {
        // Task in flight — abort it. The runTask settled handler owns re-prompting
        // so late renderer output cannot appear after a fresh prompt.
        currentAc.abort();
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

      // R5.1 / P1-09j-b: mint a distinct enforcing budget per REPL turn.
      const turnId = deps.clock.uuid();
      const turnBudget = createTurnCallBudget({
        turnId: turnId,
        mode: 'enforce',
        totalUnits: 64,
        reserved: {
          work: 1,
          failover: 0,
          verification: 0,
        },
      });

      // Image attachments (audit #4, image scope): resolve per-turn the SAME way the
      // chat menu does — the IMPURE existence check lives here in the interface layer
      // (fs allowed), reusing the shared resolveImageAttachments helper (no
      // reimplementation). Real images referenced in the line are threaded onto a
      // per-turn deps so orchestrate sets needsVision + routes to a vision-capable
      // provider. No real image → empty → field omitted → behaviour unchanged.
      const turnAttachments = resolveImageAttachments(line, { cwd: deps.cwd });
      const turnDeps: OrchestrateDeps =
        turnAttachments.length > 0
          ? { ...deps, attachments: turnAttachments, turnCallBudget: turnBudget }
          : { ...deps, turnCallBudget: turnBudget };

      runTask(line, turnDeps, out, ac.signal).then(() => {
        currentAc = null;
        // P1-09j-b: snap and invoke receipt callback if present.
        const receiptCb = turnDeps.onTurnCallBudgetReceipt;
        if (receiptCb !== undefined) {
          void (async () => {
            try {
              await receiptCb(turnBudget.snapshot());
            } catch {
              // diagnostic only — never block
            }
          })();
        }
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
