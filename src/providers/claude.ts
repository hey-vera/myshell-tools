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

// ---------------------------------------------------------------------------
// Runaway fan-out safety rail
// ---------------------------------------------------------------------------

/**
 * Global per-run dollar ceiling applied to EVERY `claude -p` invocation via the
 * CLI's `--max-budget-usd <amount>` flag (verified from `claude -p --help`:
 * "Maximum dollar amount to spend on API calls (only works with --print)").
 *
 * This is a last-resort backstop against the runaway-fan-out failure mode where
 * a manager-tier task spawns 70+ tool calls and blows the wall-clock timeout —
 * the model now self-halts once its own API spend crosses this line, before the
 * SIGKILL path is reached.
 *
 * The verified Claude binary (v2.1.x) exposes NO `--max-turns` flag for headless
 * `-p`; `--max-budget-usd` is the only built-in hard bound, so we use it.
 *
 * The ceiling is intentionally GENEROUS so that normal IC / worker runs never
 * trip it — it only catches genuine runaways. Note: `ProviderRequest` carries no
 * tier, so this adapter cannot scope the cap to manager-only; it is therefore a
 * single global ceiling applied uniformly to every run. (If per-tier caps are
 * ever wanted, the tier would have to be threaded onto ProviderRequest.)
 */
export const CLAUDE_MAX_BUDGET_USD = 25;

/**
 * Map the abstract privilege ladder to Claude CLI permission flags. Pure.
 *
 *  - read-only       → remove mutation/execution tools (reads still allowed)
 *  - workspace-write → --permission-mode acceptEdits (auto-accept file edits)
 *  - full-access     → --permission-mode bypassPermissions (explicit opt-in)
 *
 * `acceptEdits` is REQUIRED, not optional: in headless `-p` mode Claude's default
 * permission behaviour PROMPTS before every Write/Edit/Bash, and there is no human
 * to approve — so the run deadlocks ("waiting for permission") and never mutates a
 * file. (Live audit: a file-writing /goal spun for all 8 turns, writing nothing.)
 * `acceptEdits` auto-accepts edits to the workspace — exactly the "workspace-write"
 * contract — while staying short of the full `bypassPermissions` used by
 * full-access. We never emit `--dangerously-skip-permissions`. The read-only
 * mutation tool list uses the stable Claude Code tool names; `--disallowedTools`
 * is variadic so callers append it LAST.
 */
function claudeSandboxArgs(sandbox: SandboxLevel): string[] {
  switch (sandbox) {
    case 'read-only':
      return ['--disallowedTools', 'Write', 'Edit', 'NotebookEdit', 'Bash'];
    case 'full-access':
      return ['--permission-mode', 'bypassPermissions'];
    case 'workspace-write':
    default:
      return ['--permission-mode', 'acceptEdits'];
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
    // Runaway safety rail: a generous global spend ceiling so the model
    // self-halts before a fan-out can blow past the wall-clock timeout. Applies
    // to every run (ProviderRequest has no tier, so this can't be manager-only).
    '--max-budget-usd',
    String(CLAUDE_MAX_BUDGET_USD),
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
        // A wall-clock timeout SIGKILLs the child before the Claude CLI can emit
        // its terminal `result` event, so claude-parse.ts never produces usage or
        // a done/error event. execa flags this with `result.timedOut === true`.
        // Classify it explicitly as the recoverable `timeout` category (errors.ts)
        // rather than letting the empty stderr fall through to `unknown`
        // ("An unexpected error occurred."), which is both wrong and unactionable.
        //
        // NOTE on ordering: timedOut is checked BEFORE isCanceled. execa also sets
        // isCanceled when a timeout fires, but a real timeout is the more specific,
        // more actionable diagnosis, so it wins.
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
        } else if (result.isCanceled) {
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
