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

import type { Provider, ProviderRequest, ProviderEvent, SandboxLevel } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { createCodexParser } from './codex-parse.js';
import { replitPersistentEnv } from '../infra/credentials.js';
import { DECLARATIVE_MODEL_CAPABILITIES, findCapability } from '../core/model-capabilities.js';
import { spawnGuarded, withHangCap, providerHangCapMs } from './hang-cap.js';

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

/**
 * Build the `codex` CLI argv for a request. Pure and exported so arg
 * construction — including the EXPERIMENTAL native-session resume form — is
 * unit-testable without spawning a real CLI.
 *
 * Default (one-shot / establish): `exec --json -m <model> --sandbox <level>
 * --skip-git-repo-check`.
 * Resume (native session, opt-in): `exec resume <thread-id> …` — Codex generates
 * the thread id, so resume continues a thread captured from a prior turn (see
 * codex-parse `thread.started`). Prompt is delivered via STDIN in both cases.
 *
 * `--skip-git-repo-check` is REQUIRED: without it codex refuses to run unless the
 * cwd is inside a git repo ("Not inside a trusted directory…"), so myshell-tools
 * would fail for users invoking it outside a repo — claude has no such gate. The
 * privilege boundary is the explicit `--sandbox <level>`, not the git check, so
 * skipping it is safe. (Live audit: codex errored out in a non-repo cwd without it.)
 */
/**
 * PURE: does the chosen codex model support the native web_search tool? Resolved
 * against the declarative capability registry (id/alias match, case-insensitive).
 * Returns false ONLY when an entry exists and explicitly declares
 * `supportsSearchTool === false`; an unknown model (no registry entry) returns
 * true, since the codex CLI exposes the web_search tool regardless. No I/O.
 */
function codexModelSupportsSearch(model: string): boolean {
  const cap = findCapability(DECLARATIVE_MODEL_CAPABILITIES, 'codex', model);
  if (cap === undefined) return true;
  return cap.supportsSearchTool !== false;
}

export function buildCodexArgs(req: ProviderRequest): string[] {
  const opts = ['--json', '-m', req.model, '--sandbox', toSandboxArg(req.sandbox), '--skip-git-repo-check'];
  // Reasoning-effort knob (capability registry §5): thread the selected effort to
  // Codex's CLI ONLY when one is set AND it is a real "thinking" effort. The effort
  // is chosen upstream by selectReasoningEffort, which returns ONLY an effort the
  // chosen model's ModelCapability declares it supports (or undefined) — so a set
  // effort here is, by construction, a supported one. We still guard against the
  // degenerate `none` (no reasoning) so we never emit `model_reasoning_effort=none`,
  // and against the absent case (byte-for-byte unchanged: no `-c` flag at all).
  if (req.reasoningEffort !== undefined && req.reasoningEffort !== 'none') {
    opts.push('-c', `model_reasoning_effort=${req.reasoningEffort}`);
  }
  // Native web-search tool (provider-capability audit #3). `codex exec` REJECTS the
  // top-level `--search` flag, but enables live web search via the config override
  // `-c tools.web_search=true` (CLI-verified with --strict-config; runs under the
  // user's logged-in subscription — no api key / metered service). Append it ONLY
  // when the orchestrator asked for search AND the chosen codex model declares
  // supportsSearchTool. We gate on the declarative capability when KNOWN: an
  // explicit `false` omits the override; an unknown model (no registry entry) still
  // allows it, since the codex CLI tool exists. Absent/false req.webSearch → no
  // `-c tools.web_search` at all (byte-for-byte unchanged).
  if (req.webSearch === true && codexModelSupportsSearch(req.model)) {
    opts.push('-c', 'tools.web_search=true');
  }
  // Image attachments (provider-capability audit #4, image scope). `codex exec`
  // accepts `-i/--image <FILE>` (one flag per image; repeatable) to attach local
  // image(s) to the prompt under the user's logged-in subscription — no api key /
  // upload service. Append `-i <path>` for each attachment the orchestrator set
  // (only image-kind, only when it confirmed the file exists). Absent/empty
  // attachments → no `-i` flag at all (byte-for-byte unchanged).
  if (req.attachments !== undefined) {
    for (const att of req.attachments) {
      if (att.kind === 'image') opts.push('-i', att.path);
    }
  }
  if (req.sessionId !== undefined && req.sessionId.length > 0 && req.resume === true) {
    return ['exec', 'resume', req.sessionId, ...opts];
  }
  return ['exec', ...opts];
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

    run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // UNIVERSAL HANG CAP — see hang-cap.ts and the claude.ts adapter for the full
      // rationale. spawnGuarded makes the child a process-group leader; withHangCap
      // bounds the whole iteration and, on the safety ceiling, kills the tree and
      // emits the honest `timeout` event. Happy path is byte-identical.
      const killers: Array<() => void> = [];
      const inner = runCodexRaw({
        req,
        signal,
        bin,
        register: (k) => killers.push(k),
      });
      return withHangCap(inner, {
        provider: 'codex',
        capMs: providerHangCapMs(req.timeoutMs),
        onCap: () => {
          for (const k of killers) k();
        },
      });
    },
  };
}

/**
 * The raw Codex spawn + stdout drain — factored out so the public `run` can wrap it
 * with `withHangCap` while the happy path stays byte-identical.
 */
async function* runCodexRaw(args0: {
  req: ProviderRequest;
  signal: AbortSignal;
  bin: string;
  register: (killTree: () => void) => void;
}): AsyncIterable<ProviderEvent> {
  const { req, signal, bin, register } = args0;
  const args = buildCodexArgs(req);

  // Point codex at the Replit-persistent CODEX_HOME when present so a plainly-
  // launched run finds the durable one-time sign-in (matches replit-tools).
  // Account-scoped env (CODEX_HOME from subscription account) is merged LAST
  // so it overrides any default — absent → byte-identical to today.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...replitPersistentEnv(process.env, req.cwd),
    ...(req.accountEnv ?? {}),
  };

  // Spawn with reject:false so we always get the result object (never throws).
  // cancelSignal wires our AbortSignal directly to execa's termination path.
  const { subprocess, killTree } = spawnGuarded(bin, args, {
    cwd: req.cwd,
    input: req.prompt,      // deliver prompt via STDIN, not argv
    cancelSignal: signal,
    timeout: req.timeoutMs,
    reject: false,
    env: childEnv,
  });
  register(killTree);

  // One parser instance per run — holds the accumulated text closure.
  const parseCodexLine = createCodexParser();

  {
    let emittedTerminal = false;

      // Stream stdout line by line.
      // execa v9: the subprocess itself is an AsyncIterable that yields one
      // string per stdout line (from types/subprocess/subprocess.d.ts).
      try {
        stdoutLoop:
        for await (const line of subprocess) {
          const events = parseCodexLine(line);
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
              message: 'codex produced no parseable output.',
            },
          };
        }
      }
  }
}
