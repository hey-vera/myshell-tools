/**
 * src/providers/grok.ts — xAI Grok CLI adapter implementing the Provider port.
 *
 * Spawns `grok --single --prompt-file <PATH> --output-format streaming-json -m <MODEL>`
 * via execa v9, delivers the prompt via a temporary prompt file (never as an argv
 * argument), and streams parsed ProviderEvents to the caller as they arrive.
 *
 * Why `--prompt-file` instead of STDIN:
 *  - grok's own help documents `--prompt-file <PATH>` for prompt-from-file.
 *  - It is the safer provisional default while the live transcript is pending:
 *    if `grok --single` does not consume stdin, an `input:` spawn would hang.
 *  - The prompt never appears in argv, preserving the "never as shell argument"
 *    contract from claude.ts.
 *  - This is one of the open items to reconcile during G2 live verification
 *    (DESIGN-GROK.md).
 *
 * Auth:
 *  Auth is exclusively grok's own OAuth subscription flow (`grok login --oauth` /
 *  `grok login --device-auth`). This adapter NEVER sets XAI_API_KEY, NEVER uses a
 *  `sk-` key, and NEVER passes `--xai-api-base-url`. Detection reads grok's auth
 *  state via `grok models`, which prints "You are not authenticated." when logged
 *  out. Creds live in `~/.grok/`; myshell never sees the secret.
 *
 * Sandbox / permission mapping:
 *  - read-only       → --permission-mode restrictive
 *  - workspace-write → --permission-mode acceptEdits
 *  - full-access     → --permission-mode bypassPermissions
 *  We never pass a "dangerously skip permissions" flag. The mapping is PROVISIONAL
 *  pending live verification of grok's exact permission-mode values (G2).
 *
 * Web search:
 *  grok enables web search by default. We add `--disable-web-search` UNLESS the
 *  orchestrator explicitly requested native search (`req.webSearch === true`).
 *
 * Execa v9 streaming:
 *  We use `subprocess[Symbol.asyncIterator]()` (i.e. `for await … of subprocess`)
 *  which by default iterates over stdout lines as strings.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider, ProviderRequest, ProviderEvent, SandboxLevel } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { parseGrokLine } from './grok-parse.js';
import { spawnGuarded, withHangCap, providerHangCapMs } from './hang-cap.js';

// ---------------------------------------------------------------------------
// Argv builder (pure)
// ---------------------------------------------------------------------------

/**
 * Map the abstract privilege ladder to Grok CLI permission flags. Pure.
 *
 *  - read-only       → --permission-mode restrictive
 *  - workspace-write → --permission-mode acceptEdits
 *  - full-access     → --permission-mode bypassPermissions
 *
 * PROVISIONAL: grok's permission-mode values are modeled on claude's verified set.
 * Confirm against `grok --help` and live behavior during G2.
 */
function grokSandboxArgs(sandbox: SandboxLevel): string[] {
  switch (sandbox) {
    case 'read-only':
      return ['--permission-mode', 'restrictive'];
    case 'full-access':
      return ['--permission-mode', 'bypassPermissions'];
    case 'workspace-write':
    default:
      return ['--permission-mode', 'acceptEdits'];
  }
}

/**
 * Build the `grok` CLI argv for a request. Pure and exported so flag
 * construction — model, native-session flags, effort, web search, and sandbox —
 * is unit-testable without spawning a real CLI.
 *
 * The prompt is delivered via `--prompt-file <PATH>` at spawn time (not in this
 * pure builder), so the prompt itself never appears in argv.
 *
 * Native session (opt-in): when `req.sessionId` is set, add `--resume <id>` to
 * continue an existing session, or `--session-id <id>` to establish a new one
 * with our chosen id. When unset, the run is a stateless one-shot (the default).
 */
export function buildGrokArgs(req: ProviderRequest): string[] {
  const args = [
    '--single',
    '--output-format',
    'streaming-json',
    '-m',
    req.model,
  ];

  if (req.sessionId !== undefined && req.sessionId.length > 0) {
    if (req.resume === true) {
      args.push('--resume', req.sessionId);
    } else {
      args.push('--session-id', req.sessionId);
    }
  }

  // Reasoning-effort knob. grok exposes `--effort <low|medium|high|xhigh|max>`
  // (verified in DESIGN-GROK.md). Thread the selected effort ONLY when one is set
  // AND it is a real "thinking" effort (not `none`). The effort is chosen upstream
  // by selectReasoningEffort, which returns ONLY an effort the chosen model's
  // ModelCapability declares it supports (or undefined).
  if (req.reasoningEffort !== undefined && req.reasoningEffort !== 'none') {
    args.push('--effort', req.reasoningEffort);
  }

  // Web search: grok has it ON by default. We disable it UNLESS the orchestrator
  // explicitly requested it, so ordinary local/coding turns do not silently hit
  // the web. This is the inverse of claude's opt-in --allowedTools.
  if (req.webSearch !== true) {
    args.push('--disable-web-search');
  }

  args.push(...grokSandboxArgs(req.sandbox));
  return args;
}

// ---------------------------------------------------------------------------
// Prompt-file helper
// ---------------------------------------------------------------------------

/**
 * Write the prompt to a temp file and return its absolute path. The caller is
 * responsible for deleting the file. Never throws — on any write failure we
 * still return a path so the spawn can surface the real error.
 */
async function writePromptFile(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-prompt-'));
  const path = join(dir, 'prompt.txt');
  try {
    await writeFile(path, prompt, 'utf8');
  } catch {
    // swallow — the spawn will fail with a clearer error
  }
  return path;
}

/** Best-effort cleanup of the temp prompt file and its parent directory. */
async function removePromptFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
    await rm(join(path, '..'), { recursive: true, force: true });
  } catch {
    // cleanup is best-effort
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Grok provider adapter.
 *
 * @param opts.bin - Override the binary name/path (default: `'grok'`).
 */
export function createGrokProvider(opts?: { bin?: string }): Provider {
  const bin = opts?.bin ?? 'grok';

  return {
    id: 'grok',

    detect(): Promise<ProviderStatus> {
      return detectProvider('grok');
    },

    run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
      // UNIVERSAL HANG CAP (hang-cap.ts): mirrors claude.ts/opencode.ts.
      const killers: Array<() => void> = [];
      const inner = runGrokRaw({
        req,
        signal,
        bin,
        register: (k) => killers.push(k),
      });
      return withHangCap(inner, {
        provider: 'grok',
        capMs: providerHangCapMs(req.timeoutMs),
        onCap: () => {
          for (const k of killers) k();
        },
      });
    },
  };
}

/**
 * The raw grok spawn + stdout drain — factored out so the public `run` can wrap
 * it with `withHangCap` while the happy path stays byte-identical.
 */
async function* runGrokRaw(args0: {
  req: ProviderRequest;
  signal: AbortSignal;
  bin: string;
  register: (killTree: () => void) => void;
}): AsyncIterable<ProviderEvent> {
  const { req, signal, bin, register } = args0;
  const args = buildGrokArgs(req);

  // Deliver the prompt via a temporary file, never as an argv argument.
  const promptFile = await writePromptFile(req.prompt);
  args.push('--prompt-file', promptFile);

  const { subprocess, killTree } = spawnGuarded(bin, args, {
    cwd: req.cwd,
    cancelSignal: signal,
    timeout: req.timeoutMs,
    reject: false,
    env: process.env,
  });
  register(killTree);

  {
    let emittedTerminal = false;

    try {
      stdoutLoop:
      for await (const line of subprocess) {
        const events = parseGrokLine(line);
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

    // Clean up the temp prompt file regardless of outcome.
    await removePromptFile(promptFile);

    if (!emittedTerminal) {
      if (result.timedOut === true) {
        const seconds = Math.round((req.timeoutMs ?? 0) / 1000);
        const base = classifyError('timed out', 1);
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
            message: 'grok produced no parseable output.',
          },
        };
      }
    }
  }
}
