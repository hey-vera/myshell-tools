/**
 * src/providers/claude.ts — Claude CLI adapter implementing the Provider port.
 *
 * Spawns `claude -p --output-format stream-json --verbose
 * --include-partial-messages` via execa v9, delivers the prompt via STDIN
 * (never as an argv argument), and streams parsed ProviderEvents to the caller
 * as they arrive. `--include-partial-messages` makes the CLI emit raw API SSE
 * token deltas (wrapped in `stream_event`) so prose streams live word-by-word
 * instead of arriving all-at-once in the terminal `result`.
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

import type { Provider, ProviderRequest, ProviderEvent, SandboxLevel } from './port.js';
import type { ProviderStatus } from './detect.js';
import { claudeEnvWithStoredFallback, detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { parseClaudeLine } from './claude-parse.js';
import { spawnGuarded, withHangCap, providerHangCapMs } from './hang-cap.js';

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
 *
 * @param effortEnabled - When true, the `reasoningEffort` field on the request is
 *   threaded onto `--effort <level>`. When false or absent (the DEFAULT), no
 *   `--effort` flag is emitted and argv is byte-for-byte unchanged. Controlled by
 *   `providerEffortEnabled` from src/providers/provider-effort-flag.ts.
 */
export function buildClaudeArgs(req: ProviderRequest, effortEnabled?: boolean): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // Emit raw API SSE token deltas (wrapped in `stream_event`) so prose streams
    // live word-by-word in the TUI instead of arriving all-at-once in the
    // terminal `result`. Requires --output-format=stream-json (we pass it above).
    '--include-partial-messages',
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
  // Reasoning-effort knob (capability registry §5, MYSHELL_PROVIDER_EFFORT gate):
  // the Claude CLI exposes `--effort <low|medium|high|xhigh|max>`. Thread the
  // selected effort ONLY when the provider-effort flag is explicitly ON AND the
  // effort is a real "thinking" effort (not `none`). The effort is chosen upstream
  // by selectReasoningEffort, which returns ONLY an effort the chosen model's
  // ModelCapability declares it supports (or undefined) — so a set effort here is,
  // by construction, a supported one. Default-OFF: absent/false `effortEnabled` →
  // no flag at all → byte-for-byte unchanged. Placed BEFORE the variadic sandbox
  // args so the trailing --disallowedTools list stays the tail of argv.
  if (effortEnabled === true && req.reasoningEffort !== undefined && req.reasoningEffort !== 'none') {
    args.push('--effort', req.reasoningEffort);
  }
  // Native web search (provider-capability audit #3). LIVE-VERIFIED: WITHOUT this
  // allow-list the Claude CLI denies its own WebSearch tool ("permission denied")
  // in headless `-p`; WITH it the search executes (web_search_requests:1, no
  // denials), running under the user's logged-in subscription — no api key / metered
  // service. Append `--allowedTools WebSearch WebFetch` ONLY when the orchestrator
  // asked for search (the EXISTING engagement WEB_RESEARCH determination, so it never
  // fires on ordinary local/coding turns). Placed BEFORE the variadic sandbox args so
  // the trailing --disallowedTools list stays the tail of argv (it does not overlap —
  // sandbox controls Write/Edit/Bash, this adds read-only search tools). Absent/false
  // req.webSearch → NO flag at all → byte-for-byte unchanged. (Codex path unchanged.)
  if (req.webSearch === true) {
    args.push('--allowedTools', 'WebSearch', 'WebFetch');
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
 * @param opts.bin          - Override the binary name/path (default: `'claude'`).
 * @param opts.effortEnabled - When true, `--effort <level>` is threaded onto the
 *   CLI invocation when `req.reasoningEffort` is set and not `'none'`. Default
 *   false (MYSHELL_PROVIDER_EFFORT gate; see provider-effort-flag.ts).
 */
export function createClaudeProvider(opts?: { bin?: string; effortEnabled?: boolean }): Provider {
  const bin = opts?.bin ?? 'claude';
  const effortEnabled = opts?.effortEnabled === true;

  return {
    id: 'claude',

    detect(): Promise<ProviderStatus> {
      return detectProvider('claude');
    },

    run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // UNIVERSAL HANG CAP (hang-cap.ts): the raw spawn+drain below relies on
      // execa's `timeout`, which SIGKILLs only the DIRECT child — a grandchild
      // (tool subprocess / MCP server / PTY) holding the stdout pipe can keep the
      // `for await` from ever resolving. `spawnGuarded` makes the child a process-
      // group leader so the whole TREE can be force-killed, and `withHangCap` bounds
      // the ENTIRE iteration: if the safety ceiling elapses with no terminal event,
      // it kills the tree and emits the honest `timeout` event (never a fake `done`).
      // The cap is strictly ABOVE req.timeoutMs, so the happy path is byte-identical.
      const killers: Array<() => void> = [];
      const inner = runClaudeRaw({
        req,
        signal,
        bin,
        effortEnabled,
        register: (k) => killers.push(k),
      });
      return withHangCap(inner, {
        provider: 'claude',
        capMs: providerHangCapMs(req.timeoutMs),
        onCap: () => {
          for (const k of killers) k();
        },
      });
    },
  };
}

/**
 * Pure helper: build the account-scoped base env with req.accountEnv merged in.
 * Exported for testing so callers can assert env composition without spawning.
 */
export function buildAccountScopedBase(
  parentEnv: NodeJS.ProcessEnv,
  accountEnv: Readonly<Partial<NodeJS.ProcessEnv>> | undefined,
): NodeJS.ProcessEnv {
  if (accountEnv === undefined) return parentEnv;
  return {
    ...parentEnv,
    ...accountEnv,
  };
}

/**
 * Pure helper: apply accountEnv LAST on top of a fallback result so
 * CLAUDE_CONFIG_DIR from accountEnv is never shadowed.
 * Exported for testing.
 */
export function applyAccountEnvOverride(
  fallbackEnv: NodeJS.ProcessEnv,
  accountEnv: Readonly<Partial<NodeJS.ProcessEnv>> | undefined,
): NodeJS.ProcessEnv {
  if (accountEnv === undefined) return fallbackEnv;
  return {
    ...fallbackEnv,
    ...accountEnv,
  };
}

/**
 * Build the child env for a claude spawn.
 *
 * When req.accountEnv is present (account-scoped run), CLAUDE_CONFIG_DIR
 * overrides the global env AND is re-merged LAST so it is NOT shadowed by
 * claudeEnvWithStoredFallback. Stored credential fallback is also disabled
 * so a legacy CLAUDE_CODE_OAUTH_TOKEN never shadows the selected account.
 *
 * When req.accountEnv is absent, behaviour is byte-identical to the current
 * claudeEnvWithStoredFallback(process.env, req.cwd) path.
 *
 * PURE / fail-soft: never throws — falls back to the account-scoped base on
 * any error (exactly replicating today's catch-clause behaviour).
 */
export async function buildClaudeEnv(
  req: ProviderRequest,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  if (req.accountEnv !== undefined) {
    const accountScopedBase = buildAccountScopedBase(parentEnv, req.accountEnv);
    try {
      const withFallback = await claudeEnvWithStoredFallback(
        accountScopedBase,
        req.cwd,
        false, // disable stored credential injection for account-scoped runs
      );
      return applyAccountEnvOverride(withFallback, req.accountEnv);
    } catch {
      return accountScopedBase;
    }
  }

  // Flag-off / global path: byte-identical to today
  try {
    return await claudeEnvWithStoredFallback(parentEnv, req.cwd);
  } catch {
    return parentEnv;
  }
}

/**
 * The raw Claude spawn + stdout drain — the exact behaviour that existed before the
 * hang cap, factored out so the public `run` can wrap it with `withHangCap` while the
 * happy path stays byte-identical. `register` hands the caller a `killTree` for the
 * spawned process group so the cap can force-stop a hung grandchild.
 */
async function* runClaudeRaw(args0: {
  req: ProviderRequest;
  signal: AbortSignal;
  bin: string;
  effortEnabled: boolean;
  register: (killTree: () => void) => void;
}): AsyncIterable<ProviderEvent> {
  const { req, signal, bin, effortEnabled, register } = args0;
  const args = buildClaudeArgs(req, effortEnabled);

  const childEnv = await buildClaudeEnv(req);

  // Spawn with reject:false so we always get the result object (never throws).
  // cancelSignal wires our AbortSignal directly to execa's termination path.
  // spawnGuarded adds detached:true (process-group leader) + forceKillAfterDelay so a
  // timed-out grandchild can be reaped via the whole-group kill the hang cap triggers.
  const { subprocess, killTree } = spawnGuarded(bin, args, {
    cwd: req.cwd,
    input: req.prompt,      // deliver prompt via STDIN, not argv
    cancelSignal: signal,
    timeout: req.timeoutMs,
    reject: false,
    env: childEnv,
  });
  register(killTree);

  {
    let emittedTerminal = false;

      // Stream stdout line by line.
      // execa v9: the subprocess itself is an AsyncIterable that yields one
      // string per stdout line (from types/subprocess/subprocess.d.ts).
      try {
        stdoutLoop:
        for await (const line of subprocess) {
          const events = parseClaudeLine(line);
          for (const ev of events) {
            yield ev;
            if (ev.type === 'done' || ev.type === 'error') {
              emittedTerminal = true;
              break stdoutLoop;
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
        } else {
          yield {
            type: 'error',
            error: {
              ...classifyError('', result.exitCode ?? 0),
              message: 'claude produced no parseable output.',
            },
          };
        }
      }
  }
}
