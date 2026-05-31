/**
 * src/providers/claude.ts — Claude CLI adapter implementing the Provider port.
 *
 * Spawns `claude -p --output-format stream-json --verbose` via execa v9,
 * delivers the prompt via STDIN (never as an argv argument), and streams
 * parsed ProviderEvents to the caller as they arrive.
 *
 * Sandbox enforcement:
 *  The `req.sandbox` privilege level is mapped to real Claude CLI flags (see
 *  claudeSandboxArgs):
 *   - read-only       → --disallowedTools Write Edit NotebookEdit Bash
 *                       (mutation/execution tools removed; reads still allowed)
 *   - workspace-write → no permission flag — Claude's default headless behavior
 *                       (the verified default working mode)
 *   - full-access     → --permission-mode bypassPermissions (only when the
 *                       caller explicitly opts into full access)
 *  We never pass `--dangerously-skip-permissions`; `bypassPermissions` is the
 *  supported, intentional opt-in used solely for the full-access level.
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
import type { Provider, ProviderRequest, ProviderEvent, SandboxLevel } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { parseClaudeLine } from './claude-parse.js';
import { loadClaudeToken, claudeEnv } from '../infra/credentials.js';

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

/**
 * Map the abstract privilege ladder to Claude CLI permission flags. Pure.
 *
 *  - read-only       → remove mutation/execution tools (reads still allowed)
 *  - workspace-write → no flag (Claude's default headless behavior)
 *  - full-access     → --permission-mode bypassPermissions (explicit opt-in)
 *
 * Never emits `--dangerously-skip-permissions`. The mutation tool list uses the
 * stable Claude Code tool names (Write/Edit/NotebookEdit/Bash); unknown names
 * are harmless. `--disallowedTools` is variadic, so callers append it LAST.
 */
function claudeSandboxArgs(sandbox: SandboxLevel): string[] {
  switch (sandbox) {
    case 'read-only':
      return ['--disallowedTools', 'Write', 'Edit', 'NotebookEdit', 'Bash'];
    case 'full-access':
      return ['--permission-mode', 'bypassPermissions'];
    case 'workspace-write':
    default:
      return [];
  }
}

/**
 * Build the `claude` CLI argv for a request. Pure and exported so flag
 * construction — model alias, native-session flags, and sandbox/permission
 * flags — is unit-testable without spawning a real CLI.
 *
 * Native session (opt-in): when `req.sessionId` is set, add `--resume <id>` to
 * continue an existing session, or `--session-id <id>` to establish a new one
 * with our chosen id. When unset, the run is a stateless one-shot (the default).
 *
 * Sandbox flags are appended LAST because `--disallowedTools` is variadic.
 */
export function buildClaudeArgs(req: ProviderRequest): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    toClaudeModelArg(req.model),
  ];
  if (req.sessionId !== undefined && req.sessionId.length > 0) {
    if (req.resume === true) {
      args.push('--resume', req.sessionId);
    } else {
      args.push('--session-id', req.sessionId);
    }
  }
  args.push(...claudeSandboxArgs(req.sandbox));
  return args;
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
      const args = buildClaudeArgs(req);

      // Load the stored Claude OAuth token and scope it to this child process
      // only — never written into the global process.env.
      let childEnv: NodeJS.ProcessEnv = process.env;
      try {
        const token = await loadClaudeToken();
        childEnv = claudeEnv(process.env, token);
      } catch {
        // Never throw — fall back to the unmodified env
      }

      // Spawn with reject:false so we always get the result object (never throws).
      // cancelSignal wires our AbortSignal directly to execa's termination path.
      const subprocess = execa(bin, args, {
        cwd: req.cwd,
        input: req.prompt,      // deliver prompt via STDIN, not argv
        cancelSignal: signal,
        timeout: req.timeoutMs,
        reject: false,
        env: childEnv,
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
