/**
 * src/providers/grok.ts — xAI Grok CLI adapter implementing the Provider port.
 *
 * Spawns `grok --output-format streaming-json -m <MODEL> --prompt-file <PATH>`
 * via execa v9, delivers the prompt via a temporary prompt file (never as an argv
 * argument), and streams parsed ProviderEvents to the caller as they arrive.
 *
 * Why `--prompt-file` (verified live, G2):
 *  - `--prompt-file <PATH>` is grok's file form of a single-turn headless prompt;
 *    providing it puts grok in headless mode (the same mode `-p/--single` use).
 *  - It does NOT combine with `--single`: `--single` requires an inline <PROMPT>
 *    value, and `grok --single --prompt-file …` errors. So we use `--prompt-file`
 *    alone.
 *  - The prompt never appears in argv, preserving the "never as shell argument"
 *    contract from claude.ts.
 *
 * Auth:
 *  Auth is exclusively grok's own OAuth subscription flow (`grok login --oauth` /
 *  `grok login --device-auth`). This adapter NEVER sets XAI_API_KEY, NEVER uses a
 *  `sk-` key, and NEVER passes `--xai-api-base-url`. Detection reads grok's auth
 *  state via `grok models`, which prints "You are not authenticated." when logged
 *  out. Creds live in `~/.grok/`; myshell never sees the secret.
 *
 * Sandbox / permission mapping (verified live, G2 — grok has BOTH an OS-level
 * `--sandbox` guardrail and a `--permission-mode` tool-approval knob; we pair them):
 *  - read-only       → --sandbox read-only --permission-mode dontAsk
 *  - workspace-write → --sandbox workspace  --permission-mode acceptEdits
 *  - full-access     → --sandbox off        --permission-mode bypassPermissions
 *  The sandbox does the real enforcement; the non-prompting permission mode keeps
 *  headless runs from hanging on an approval prompt.
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
import { createGrokParser } from './grok-parse.js';
import { replitPersistentEnv } from '../infra/credentials.js';
import { spawnGuarded, withHangCap, providerHangCapMs } from './hang-cap.js';

// ---------------------------------------------------------------------------
// Argv builder (pure)
// ---------------------------------------------------------------------------

/**
 * Map the abstract privilege ladder to Grok CLI sandbox + permission flags. Pure.
 *
 *  - read-only       → --sandbox read-only --permission-mode dontAsk
 *  - workspace-write → --sandbox workspace  --permission-mode acceptEdits
 *  - full-access     → --sandbox off        --permission-mode bypassPermissions
 *
 * Verified against `grok --help`/README + live behavior (G2): grok's
 * permission-mode set is default|acceptEdits|auto|dontAsk|bypassPermissions|plan
 * (no `restrictive`), and `--sandbox` profiles are off|workspace|read-only|strict.
 */
function grokSandboxArgs(sandbox: SandboxLevel): string[] {
  // grok enforces filesystem/network isolation via `--sandbox <PROFILE>`
  // (off | workspace | read-only | strict — an OS-level guardrail), and tool
  // auto-approval via `--permission-mode`. We pair them: the sandbox does the
  // real enforcement, and a NON-prompting permission mode keeps headless runs
  // from hanging on an approval prompt. (Verified live — grok's permission-mode
  // set is default|acceptEdits|auto|dontAsk|bypassPermissions|plan; there is no
  // `restrictive`.)
  switch (sandbox) {
    case 'read-only':
      // Read everywhere, write nowhere (OS-enforced); auto-approve read tools.
      return ['--sandbox', 'read-only', '--permission-mode', 'dontAsk'];
    case 'full-access':
      return ['--sandbox', 'off', '--permission-mode', 'bypassPermissions'];
    case 'workspace-write':
    default:
      // Read everywhere, write only to CWD + /tmp (OS-enforced); auto-accept edits.
      return ['--sandbox', 'workspace', '--permission-mode', 'acceptEdits'];
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
 *
 * @param effortEnabled - When true, the `reasoningEffort` field on the request is
 *   threaded onto `--effort <level>`. When false or absent (the DEFAULT), no
 *   `--effort` flag is emitted and argv is byte-for-byte unchanged. Controlled by
 *   `providerEffortEnabled` from src/providers/provider-effort-flag.ts.
 */
export function buildGrokArgs(req: ProviderRequest, effortEnabled?: boolean): string[] {
  // Single-turn headless mode is triggered by `--prompt-file` (appended by the
  // caller at spawn time), NOT `--single`: grok's `--single` REQUIRES an inline
  // <PROMPT> value and cannot be combined with `--prompt-file` (verified live —
  // doing so errors "a value is required for '--single'"). The prompt is
  // delivered via the file so it never appears in argv.
  const args = [
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

  // Reasoning-effort knob (MYSHELL_PROVIDER_EFFORT gate). grok exposes
  // `--effort <low|medium|high|xhigh|max>` (verified in DESIGN-GROK.md). Thread the
  // selected effort ONLY when the provider-effort flag is explicitly ON AND the effort
  // is a real "thinking" effort (not `none`). The effort is chosen upstream by
  // selectReasoningEffort, which returns ONLY an effort the chosen model's
  // ModelCapability declares it supports (or undefined). Default-OFF: absent/false
  // `effortEnabled` → no flag at all → byte-for-byte unchanged.
  if (effortEnabled === true && req.reasoningEffort !== undefined && req.reasoningEffort !== 'none') {
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
 * @param opts.bin          - Override the binary name/path (default: `'grok'`).
 * @param opts.effortEnabled - When true, `--effort <level>` is threaded onto the
 *   CLI invocation when `req.reasoningEffort` is set and not `'none'`. Default
 *   false (MYSHELL_PROVIDER_EFFORT gate; see provider-effort-flag.ts).
 */
export function createGrokProvider(opts?: { bin?: string; effortEnabled?: boolean }): Provider {
  const bin = opts?.bin ?? 'grok';
  const effortEnabled = opts?.effortEnabled === true;

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
        effortEnabled,
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
  effortEnabled: boolean;
  register: (killTree: () => void) => void;
}): AsyncIterable<ProviderEvent> {
  const { req, signal, bin, effortEnabled, register } = args0;
  const args = buildGrokArgs(req, effortEnabled);

  // Deliver the prompt via a temporary file, never as an argv argument.
  const promptFile = await writePromptFile(req.prompt);
  args.push('--prompt-file', promptFile);

  // Account-scoped env (GROK_HOME from subscription account) + Replit-persistent
  // env (matches codex.ts pattern). Account env is merged LAST so it overrides
  // any default — absent → byte-identical to today.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...replitPersistentEnv(process.env, req.cwd),
    ...(req.accountEnv ?? {}),
  };

  const { subprocess, killTree } = spawnGuarded(bin, args, {
    cwd: req.cwd,
    cancelSignal: signal,
    timeout: req.timeoutMs,
    reject: false,
    env: childEnv,
  });
  register(killTree);

  {
    let emittedTerminal = false;
    const parse = createGrokParser();

    try {
      stdoutLoop:
      for await (const line of subprocess) {
        const events = parse(line);
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
