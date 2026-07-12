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

import type { Provider, ProviderRequest, ProviderEvent } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { createOpencodeParser } from './opencode-parse.js';
import { replitPersistentEnv } from '../infra/credentials.js';
import type { ReasoningEffort } from '../core/model-capabilities.js';
import { spawnGuarded, withHangCap, providerHangCapMs } from './hang-cap.js';

// ---------------------------------------------------------------------------
// Argv builder (pure)
// ---------------------------------------------------------------------------

/**
 * Map our ReasoningEffort onto an opencode `--variant <level>` string. opencode's
 * variant keys ARE the level names (verified via `opencode models --verbose`:
 * variants `{ low, medium, high, max }`). We map only the levels opencode declares;
 * `none` and our Claude-only `xhigh` (which opencode never advertises as a variant)
 * map to null → no flag. This is conservative: the only efforts ever passed are ones
 * the chosen model's ModelCapability declared (its variant keys), since
 * selectReasoningEffort returns ONLY a supported effort. Unknown/unsupported → null.
 */
function effortToVariant(effort: ReasoningEffort): string | null {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'max':
      return 'max';
    // 'none' = no reasoning; 'xhigh' is not an opencode variant level → omit.
    case 'none':
    case 'xhigh':
      return null;
  }
}

/**
 * Build the `opencode run` argv for a request. PURE (no spawn, no env).
 *
 * `--variant <level>` is appended ONLY when `req.reasoningEffort` is set, not `none`,
 * and maps to a level opencode exposes as a variant. By the capability contract
 * (port.ts ProviderRequest.reasoningEffort) a set effort is already one the chosen
 * model's ModelCapability declares it supports — and for OpenCode those efforts are
 * derived from the model's own `variants` keys (model-capability-refresh.ts), so a
 * passed variant is, by construction, a declared one. Absent/none/unsupported →
 * omit the flag (byte-for-byte unchanged: just `run --format json [-m model]`).
 *
 * `-m <provider/model>` is passed only for a concrete resolved id (contains a slash);
 * the `'opencode'` pricing placeholder omits it so opencode uses its configured default.
 */
export function buildOpencodeArgs(req: ProviderRequest): string[] {
  const args = ['run', '--format', 'json'];
  if (req.model.includes('/')) {
    args.push('-m', req.model);
  }
  if (req.reasoningEffort !== undefined && req.reasoningEffort !== 'none') {
    const variant = effortToVariant(req.reasoningEffort);
    if (variant !== null) args.push('--variant', variant);
  }
  // Image attachments (provider-capability audit #4, image scope). `opencode run`
  // accepts `-f/--file <path>` (repeatable) to attach a local file to the prompt
  // under the user's connected subscription — no api key / upload service. Append
  // `-f <path>` for each image attachment the orchestrator set (only when it
  // confirmed the file exists). Absent/empty → no `-f` flag (byte-for-byte
  // unchanged: just `run --format json [-m model] [--variant …]`).
  if (req.attachments !== undefined) {
    for (const att of req.attachments) {
      if (att.kind === 'image') args.push('-f', att.path);
    }
  }
  return args;
}

/**
 * Build the child env for an opencode spawn. PURE — merges process.env,
 * replitPersistentEnv, and optional account env overrides (XDG_DATA_HOME).
 * Extracted so tests can assert env composition without spawning a real process.
 */
export function buildOpencodeEnv(
  req: ProviderRequest,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    ...replitPersistentEnv(parentEnv, req.cwd),
    ...(req.accountEnv ?? {}),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an opencode provider adapter.
 *
 * @param opts.bin - Override the binary name/path (default: `'opencode'`).
 */
export function createOpencodeProvider(opts?: { bin?: string; binArgs?: readonly string[] }): Provider {
  const bin = opts?.bin ?? 'opencode';
  const binArgs = opts?.binArgs ?? [];

  return {
    id: 'opencode',

    detect(): Promise<ProviderStatus> {
      return detectProvider('opencode');
    },

    run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // UNIVERSAL HANG CAP — see hang-cap.ts and the claude.ts adapter for the full
      // rationale. spawnGuarded makes the child a process-group leader; withHangCap
      // bounds the whole iteration and, on the safety ceiling, kills the tree and
      // emits the honest `timeout` event. Happy path is byte-identical.
      const killers: Array<() => void> = [];
      const inner = runOpencodeRaw({
        req,
        signal,
        bin,
        binArgs,
        register: (k) => killers.push(k),
      });
      return withHangCap(inner, {
        provider: 'opencode',
        capMs: providerHangCapMs(req.timeoutMs),
        onCap: () => {
          for (const k of killers) k();
        },
      });
    },
  };
}

/**
 * The raw opencode spawn + stdout drain — factored out so the public `run` can wrap
 * it with `withHangCap` while the happy path stays byte-identical.
 */
async function* runOpencodeRaw(args0: {
  req: ProviderRequest;
  signal: AbortSignal;
  bin: string;
  binArgs: readonly string[];
  register: (killTree: () => void) => void;
}): AsyncIterable<ProviderEvent> {
  const { req, signal, bin, binArgs, register } = args0;
  // Build argv (pure). Pass `-m <provider/model>` when the router resolved a real
  // opencode model for this tier (selectOpencodeModel picks the best of the user's
  // REAL available models — free, OpenCode Go, or Zen); a real id contains a slash
  // (e.g. `opencode-go/kimi-k2.6`), the `'opencode'` placeholder does not, so we
  // omit -m and let opencode use its configured default. `--variant <level>` is
  // appended only when a supported reasoning effort was selected (see buildOpencodeArgs).
  const args = buildOpencodeArgs(req);

  // Point opencode at the Replit-persistent XDG dirs when present so your own
  // configured provider/subscription (Kimi etc.) is remembered across restarts.
  // accountEnv (e.g. XDG_DATA_HOME) overrides Replit/global XDG values so the
  // account-scoped auth.json is resolved.
  const childEnv = buildOpencodeEnv(req);

  // Spawn with reject:false so we always get the result object (never throws).
  // cancelSignal wires our AbortSignal directly to execa's termination path.
  // Prompt is delivered via STDIN (input:), never as an argv argument.
  const { subprocess, killTree } = spawnGuarded(bin, [...binArgs, ...args], {
    cwd: req.cwd,
    input: req.prompt,      // deliver prompt via STDIN, not argv
    cancelSignal: signal,
    timeout: req.timeoutMs,
    reject: false,
    env: childEnv,
  });
  register(killTree);

  // One parser instance per run — holds the accumulated text/usage/cost closure.
  const parser = createOpencodeParser();

  {
    let emittedTerminal = false;

      // Stream stdout line by line.
      // execa v9: the subprocess itself is an AsyncIterable that yields one
      // string per stdout line (from types/subprocess/subprocess.d.ts).
      try {
        stdoutLoop:
        for await (const line of subprocess) {
          const events = parser.parseLine(line);
          for (const ev of events) {
            yield ev;
            if (ev.type === 'done') {
              emittedTerminal = true;
              break stdoutLoop;
            }
            if (ev.type === 'error') {
              if (parser.hasSubstantiveText()) {
                continue;
              }
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
          emittedTerminal = true;
        } else if (result.isCanceled) {
          yield {
            type: 'error',
            error: classifyError('cancelled', 1),
          };
          emittedTerminal = true;
        } else if (result.failed || (result.exitCode !== undefined && result.exitCode !== 0)) {
          if (!parser.hasSubstantiveText()) {
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
      }

      // opencode has no terminal "done" line — emit the accumulated done event
      // from the parser after the stream ends, unless a terminal was already emitted.
      if (!emittedTerminal) {
        const finalEvents = parser.finalize();
        for (const ev of finalEvents) {
          yield ev;
        }
      }
  }
}
