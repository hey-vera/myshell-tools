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
 *  state via `grok models` and requires a positive versioned signature (logged-in
 *  banner / Available models list) — mere absence of "not authenticated" is not
 *  enough (R4.3). Creds live in `~/.grok/`; myshell never sees the secret.
 *
 * Prompt file (R4.3):
 *  Prompts are written under `os.tmpdir()/grok-prompt-*` with exclusive create
 *  and mode 0o600, always cleaned in a top-level `finally`, with a cheap stale
 *  `grok-prompt-*` scavenge on first provider create.
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

import { constants } from 'node:fs';
import { mkdtemp, open, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Provider, ProviderRequest, ProviderEvent, SandboxLevel } from './port.js';
import type { ProviderStatus } from './detect.js';
import { detectProvider } from './detect.js';
import { classifyError } from './errors.js';
import { createGrokParser } from './grok-parse.js';
import { replitPersistentEnv } from '../infra/credentials.js';
import { spawnGuarded, withHangCap, providerHangCapMs } from './hang-cap.js';

/** Prefix for temp dirs that hold Grok prompt files (scavenger key). */
export const GROK_PROMPT_DIR_PREFIX = 'grok-prompt-';

/** Prompt files older than this are eligible for startup scavenge (1 hour). */
export const GROK_PROMPT_STALE_MS = 60 * 60 * 1000;

/** Once-per-process flag so scavenge stays cheap. */
let grokPromptScavengeDone = false;

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
// Prompt-file helper (R4.3: exclusive + 0o600 + finally cleanup + scavenge)
// ---------------------------------------------------------------------------

/**
 * Write the prompt to a temp file with restrictive permissions and return its
 * absolute path. Creates `os.tmpdir()/grok-prompt-XXXX/prompt.txt` via:
 *   - `mkdtemp` for an exclusive unique directory
 *   - `open(O_WRONLY|O_CREAT|O_EXCL, 0o600)` so the file is never world-readable
 *     and never clobbers an existing path
 *
 * Never throws — on any write failure we still return a path so the spawn can
 * surface the real error. Caller MUST delete via `removePromptFile` (ideally
 * from a `finally`).
 */
export async function writePromptFile(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), GROK_PROMPT_DIR_PREFIX));
  const path = join(dir, 'prompt.txt');
  try {
    // Exclusive create + owner-only mode from the first open — no permissive window.
    const fh = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await fh.writeFile(prompt, 'utf8');
    } finally {
      await fh.close();
    }
  } catch {
    // swallow — the spawn will fail with a clearer error
  }
  return path;
}

/** Best-effort cleanup of the temp prompt file and its parent directory. */
export async function removePromptFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
    await rm(dirname(path), { recursive: true, force: true });
  } catch {
    // cleanup is best-effort
  }
}

/**
 * Best-effort scavenge of stale `grok-prompt-*` directories under `baseDir`
 * (default: `os.tmpdir()`). Only removes entries whose mtime is older than
 * `maxAgeMs` (default 1h) so in-flight runs are not disturbed.
 *
 * Cheap: single readdir + selective stat/rm. Safe to call repeatedly; errors
 * are swallowed. Exported for unit tests.
 *
 * @returns number of directories successfully removed
 */
export async function scavengeStaleGrokPromptFiles(opts?: {
  baseDir?: string;
  maxAgeMs?: number;
  nowMs?: number;
}): Promise<number> {
  const baseDir = opts?.baseDir ?? tmpdir();
  const maxAgeMs = opts?.maxAgeMs ?? GROK_PROMPT_STALE_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  let removed = 0;
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (!name.startsWith(GROK_PROMPT_DIR_PREFIX)) continue;
      const full = join(baseDir, name);
      try {
        const st = await stat(full);
        if (nowMs - st.mtimeMs < maxAgeMs) continue;
        await rm(full, { recursive: true, force: true });
        removed += 1;
      } catch {
        // skip entries we cannot stat/remove
      }
    }
  } catch {
    // tmpdir unreadable — ignore
  }
  return removed;
}

/** Fire-once process-local scavenge used by `createGrokProvider`. */
function maybeScavengeGrokPromptFilesOnce(): void {
  if (grokPromptScavengeDone) return;
  grokPromptScavengeDone = true;
  // Fire-and-forget: never block provider construction on cleanup.
  void scavengeStaleGrokPromptFiles();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Grok provider adapter.
 *
 * @param opts.bin          - Override the binary name/path (default: `'grok'`).
 * @param opts.binArgs      - Optional argv prefix before buildGrokArgs (default: `[]`).
 *   Used by hermetic tests to run `node path/to/fixture.mjs` as the child; production
 *   callers leave this empty so spawn is byte-identical to the bare `grok` binary.
 * @param opts.effortEnabled - When true, `--effort <level>` is threaded onto the
 *   CLI invocation when `req.reasoningEffort` is set and not `'none'`. Default
 *   false (MYSHELL_PROVIDER_EFFORT gate; see provider-effort-flag.ts).
 */
export function createGrokProvider(opts?: {
  bin?: string;
  binArgs?: readonly string[];
  effortEnabled?: boolean;
}): Provider {
  const bin = opts?.bin ?? 'grok';
  const binArgs = opts?.binArgs ?? [];
  const effortEnabled = opts?.effortEnabled === true;

  // Cheap once-per-process stale prompt-dir scavenge (R4.3).
  maybeScavengeGrokPromptFilesOnce();

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
        binArgs,
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
  binArgs: readonly string[];
  effortEnabled: boolean;
  register: (killTree: () => void) => void;
}): AsyncIterable<ProviderEvent> {
  const { req, signal, bin, binArgs, effortEnabled, register } = args0;
  const args = buildGrokArgs(req, effortEnabled);

  // Deliver the prompt via a temporary file, never as an argv argument.
  // Always cleaned in `finally` so crash / cancel / timeout leave no plaintext.
  const promptFile = await writePromptFile(req.prompt);
  args.push('--prompt-file', promptFile);

  try {
    // Account-scoped env (GROK_HOME from subscription account) + Replit-persistent
    // env (matches codex.ts pattern). Account env is merged LAST so it overrides
    // any default — absent → byte-identical to today.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...replitPersistentEnv(process.env, req.cwd),
      ...(req.accountEnv ?? {}),
    };

    const { subprocess, killTree } = spawnGuarded(bin, [...binArgs, ...args], {
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
  } finally {
    // Top-level finally: always scrub the prompt file (R4.3).
    await removePromptFile(promptFile);
  }
}
