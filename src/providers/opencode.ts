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
 *  authenticated reflects a REAL credential probe (`opencode auth list`) — a
 *  user must connect a provider/subscription (OpenCode Go, Zen, or another) for
 *  serious work; see detect.ts. The model passed to `-m` is the best of the
 *  user's REAL available models for the routed tier (selectOpencodeModel); when
 *  none was resolved we omit -m and opencode uses its own configured default.
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
      // Pass `-m <provider/model>` when the router resolved a real opencode model
      // for this tier (selectOpencodeModel picks the best of the user's REAL
      // available models — free, OpenCode Go, or Zen). A real id contains a slash
      // (e.g. `opencode-go/kimi-k2.6`); the `'opencode'` pricing placeholder does
      // not. Fail-safe: when no concrete model was resolved we omit -m and let
      // opencode use its own configured default — never spawn an invalid -m.
      const args = ['run', '--format', 'json'];
      if (req.model.includes('/')) {
        args.push('-m', req.model);
      }

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
        if (result.timedOut === true) {
          const seconds = Math.round((req.timeoutMs ?? 0) / 1000);
          const base = classifyError('timed out', 1); // → category 'timeout', recoverable
          yield {
            type: 'error',
            error: {
              ...base,
              message: `Hit the ${seconds}-second limit before the model finished.`,
            },
          };
          emittedTerminal = true;
        } else if (result.isCanceled) {
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
