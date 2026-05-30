/**
 * src/providers/codex.ts — Codex CLI adapter implementing the Provider port.
 *
 * Spawns `codex exec --json -m <model> --sandbox <level>` via execa v9,
 * delivers the prompt via STDIN (never as an argv argument), and streams
 * parsed ProviderEvents to the caller as they arrive.
 *
 * Sandbox mapping:
 *  read-only        → '--sandbox read-only'
 *  workspace-write  → '--sandbox workspace-write'
 *  full-access      → '--sandbox danger-full-access'
 *
 * Authentication note:
 *  Auth state is probed at detect() time by spawning `codex login status` and
 *  inspecting both stdout and stderr (see detect.ts / parseCodexAuth). In
 *  practice codex writes "Logged in using ChatGPT" to stderr. An unauthenticated
 *  run will also surface at run time: the stderr/event is classified as category
 *  'auth' by classifyError().
 *
 * costUsd note:
 *  Codex does NOT report a USD cost. The `done` event therefore omits
 *  `costUsd` entirely. The orchestrator will fall back to pricing-table
 *  estimation from the usage tokens — this is the documented behaviour.
 *
 * Execa v9 streaming:
 *  We use `for await (const line of subprocess)` which iterates over stdout
 *  lines as strings. Confirmed from execa types: the subprocess IS an
 *  AsyncIterable<string>.
 */

import { execa } from 'execa';
import type { Provider, ProviderRequest, ProviderEvent, SandboxLevel } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { createCodexParser } from './codex-parse.js';

// ---------------------------------------------------------------------------
// Sandbox argument mapping
// ---------------------------------------------------------------------------

/**
 * Map the abstract {@link SandboxLevel} to the concrete `--sandbox` argument
 * that the Codex CLI accepts.
 *
 * NEVER default to 'danger-full-access' — always require the caller to opt in
 * explicitly by passing SandboxLevel 'full-access'.
 */
function toSandboxArg(level: SandboxLevel): string {
  switch (level) {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace-write';
    case 'full-access':
      return 'danger-full-access';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Codex provider adapter.
 *
 * @param opts.bin - Override the binary name/path (default: `'codex'`).
 */
export function createCodexProvider(opts?: { bin?: string }): Provider {
  const bin = opts?.bin ?? 'codex';

  return {
    id: 'codex',

    detect(): Promise<ProviderStatus> {
      return detectProvider('codex');
    },

    async *run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const args = [
        'exec',
        '--json',
        '-m',
        req.model,
        '--sandbox',
        toSandboxArg(req.sandbox),
      ];

      // Spawn with reject:false so we always get the result object (never throws).
      // cancelSignal wires our AbortSignal directly to execa's termination path.
      const subprocess = execa(bin, args, {
        cwd: req.cwd,
        input: req.prompt,      // deliver prompt via STDIN, not argv
        cancelSignal: signal,
        timeout: req.timeoutMs,
        reject: false,
      });

      // One parser instance per run — holds the accumulated text closure.
      const parseCodexLine = createCodexParser();

      let emittedTerminal = false;

      // Stream stdout line by line.
      // execa v9: the subprocess itself is an AsyncIterable that yields one
      // string per stdout line (from types/subprocess/subprocess.d.ts).
      try {
        for await (const line of subprocess) {
          const events = parseCodexLine(line);
          for (const ev of events) {
            yield ev;
            if (ev.type === 'done' || ev.type === 'error') {
              emittedTerminal = true;
            }
          }
        }
      } catch {
        // Iteration errors (e.g. stream abort) are handled below via the result.
      }

      // Wait for the subprocess to fully exit and collect the result.
      const result = await subprocess;

      if (!emittedTerminal) {
        if (result.isCanceled) {
          yield {
            type: 'error',
            error: classifyError('cancelled', 1),
          };
        } else if (result.failed || (result.exitCode !== undefined && result.exitCode !== 0)) {
          yield {
            type: 'error',
            error: classifyError(
              typeof result.stderr === 'string' ? result.stderr : '',
              result.exitCode ?? 1,
            ),
          };
        }
      }
    },
  };
}
