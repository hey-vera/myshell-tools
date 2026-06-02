/**
 * src/providers/opencode.ts — opencode CLI adapter implementing the Provider port.
 *
 * Spawns `opencode run --format json -m <model>` via execa v9, delivers the
 * prompt via STDIN (`input: req.prompt` — never as an argv argument), and
 * streams parsed ProviderEvents to the caller as they arrive.
 *
 * Sandbox mapping:
 *  opencode has no sandbox flag analogous to `codex --sandbox`. We do NOT pass
 *  any permission-bypass flag. opencode's default behaviour is therefore used
 *  for all SandboxLevel values, which is conservative and appropriate.
 *
 * Authentication note:
 *  opencode ships free models (e.g. opencode/deepseek-v4-flash-free) that need
 *  no credentials. When installed, authenticated is always reported as true by
 *  detectProvider (see detect.ts). Premium providers require `opencode auth
 *  login -p <provider>`, but that is outside the scope of this adapter.
 *
 * Stream termination:
 *  opencode emits NO single terminal "done" line — the stdout stream simply ends
 *  after the last text/step_finish event. The adapter therefore calls
 *  `parser.finalize()` after the for-await loop to emit the accumulated `done`
 *  event, mirroring the pattern used in claude.ts for post-loop terminal events.
 *
 * costUsd note:
 *  Real cost is obtained by summing the `cost` field across all `step_finish`
 *  JSONL events (see opencode-parse.ts). This gives the ledger real numbers with
 *  no pricing-table dependency and accounts for any server-side discounts.
 *
 * Execa v9 streaming:
 *  We use `for await (const line of subprocess)` which iterates over stdout
 *  lines as strings. Confirmed from execa types: the subprocess IS an
 *  AsyncIterable<string>.
 */

import { execa } from 'execa';
import type { Provider, ProviderRequest, ProviderEvent } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { createOpencodeParser } from './opencode-parse.js';
import { replitPersistentEnv } from '../infra/credentials.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an opencode provider adapter.
 *
 * @param opts.bin - Override the binary name/path (default: `'opencode'`).
 */
export function createOpencodeProvider(opts?: { bin?: string }): Provider {
  const bin = opts?.bin ?? 'opencode';

  return {
    id: 'opencode',

    detect(): Promise<ProviderStatus> {
      return detectProvider('opencode');
    },

    async *run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // No `-m`: opencode is a subscription/free provider, so we let it use the
      // model the USER configured (a free opencode-zen model, or a premium one
      // they've added — e.g. Kimi K2). "Just use whatever opencode has." req.model
      // is the routing label ('opencode'); the actual model is opencode's own
      // default, which is exactly what the user wants here.
      const args = ['run', '--format', 'json'];

      // Point opencode at the Replit-persistent XDG dirs when present so your own
      // configured provider/subscription (Kimi etc.) is remembered across restarts.
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...replitPersistentEnv(process.env, req.cwd),
      };

      // Spawn with reject:false so we always get the result object (never throws).
      // cancelSignal wires our AbortSignal directly to execa's termination path.
      // Prompt is delivered via STDIN (input:), never as an argv argument.
      const subprocess = execa(bin, args, {
        cwd: req.cwd,
        input: req.prompt,      // deliver prompt via STDIN, not argv
        cancelSignal: signal,
        timeout: req.timeoutMs,
        reject: false,
        env: childEnv,
      });

      // One parser instance per run — holds the accumulated text/usage/cost closure.
      const parser = createOpencodeParser();

      let emittedTerminal = false;

      // Stream stdout line by line.
      // execa v9: the subprocess itself is an AsyncIterable that yields one
      // string per stdout line (from types/subprocess/subprocess.d.ts).
      try {
        for await (const line of subprocess) {
          const events = parser.parseLine(line);
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
          emittedTerminal = true;
        } else if (result.failed || (result.exitCode !== undefined && result.exitCode !== 0)) {
          yield {
            type: 'error',
            error: classifyError(
              typeof result.stderr === 'string' ? result.stderr : '',
              result.exitCode ?? 1,
            ),
          };
          emittedTerminal = true;
        }
      }

      // opencode has no terminal "done" line — emit the accumulated done event
      // from the parser after the stream ends, unless a terminal was already emitted.
      if (!emittedTerminal) {
        const finalEvents = parser.finalize();
        for (const ev of finalEvents) {
          yield ev;
        }
      }
    },
  };
}
