/**
 * src/providers/claude.ts — Claude CLI adapter implementing the Provider port.
 *
 * Spawns `claude -p --output-format stream-json --verbose` via execa v9,
 * delivers the prompt via STDIN (never as an argv argument), and streams
 * parsed ProviderEvents to the caller as they arrive.
 *
 * Sandbox enforcement note (Phase-4 item):
 *  The `req.sandbox` level is accepted but NOT yet translated into Claude CLI
 *  flags. Default headless `claude -p` is inherently safe — tool calls that
 *  would require elevated permissions are auto-denied by the Claude CLI. Full
 *  sandbox→flag mapping (e.g. `--allowedTools` restrictions) is deferred to
 *  Phase 4. Do NOT pass `--dangerously-skip-permissions` or any
 *  permission-bypass flag here.
 *
 * Authentication note:
 *  Auth state is probed at detect() time by spawning `claude auth status` and
 *  parsing its JSON output (see detect.ts / parseClaudeAuth). An unauthenticated
 *  run will also surface at run time: the stderr is classified as category 'auth'
 *  by classifyError().
 *
 * Execa v9 streaming:
 *  We use `subprocess[Symbol.asyncIterator]()` (i.e. `for await … of subprocess`)
 *  which by default iterates over stdout lines as strings. Confirmed from
 *  types/subprocess/subprocess.d.ts: the subprocess IS an AsyncIterable that
 *  yields one string per stdout line.
 */

import { execa } from 'execa';
import type { Provider, ProviderRequest, ProviderEvent } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { parseClaudeLine } from './claude-parse.js';

// ---------------------------------------------------------------------------
// Model alias mapping
// ---------------------------------------------------------------------------

/**
 * Map a concrete model id to a CLI-safe alias so a stale full id never 404s.
 *
 * Patterns:
 *  - claude-opus-*   → 'opus'
 *  - claude-sonnet-* → 'sonnet'
 *  - claude-haiku-*  → 'haiku'
 *  - anything else   → returned unchanged
 */
function toClaudeModelArg(model: string): string {
  if (model.startsWith('claude-opus')) return 'opus';
  if (model.startsWith('claude-sonnet')) return 'sonnet';
  if (model.startsWith('claude-haiku')) return 'haiku';
  return model;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Claude provider adapter.
 *
 * @param opts.bin - Override the binary name/path (default: `'claude'`).
 */
export function createClaudeProvider(opts?: { bin?: string }): Provider {
  const bin = opts?.bin ?? 'claude';

  return {
    id: 'claude',

    detect(): Promise<ProviderStatus> {
      return detectProvider('claude');
    },

    async *run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        toClaudeModelArg(req.model),
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

      let emittedTerminal = false;

      // Stream stdout line by line.
      // execa v9: the subprocess itself is an AsyncIterable that yields one
      // string per stdout line (from types/subprocess/subprocess.d.ts).
      try {
        for await (const line of subprocess) {
          const events = parseClaudeLine(line);
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
