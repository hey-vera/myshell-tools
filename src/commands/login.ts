/**
 * src/commands/login.ts — `myshell-tools login [claude|codex] [--code|--browser]`.
 *
 * Frictionless authentication: rather than make the user remember each vendor's
 * CLI auth command, we delegate to the provider's OWN OAuth flow and inherit the
 * terminal so the browser/device sign-in works in place.
 *
 * Two sign-in methods:
 *   - 'browser': the provider's default flow — opens a browser locally. Great on
 *     a laptop.
 *   - 'code':   the same vendor sign-in, but with guidance tuned for a remote
 *     shell where no local browser opens.
 *       · claude → `claude /login`: launches claude's interactive TUI sign-in
 *         screen (with method selector: subscription / Console / 3rd-party).
 *         The user picks an option, follows the in-TUI prompts (open the link,
 *         authorize, paste the code into claude's own input box — which handles
 *         the paste robustly), and then exits claude (`/exit` or Ctrl+C) to
 *         return here. Claude persists the credential ITSELF
 *         (Keychain / ~/.claude/.credentials.json), so there is nothing for us
 *         to capture or store. (We do NOT use `claude setup-token` — per the
 *         docs that prints a 1-year token to stdout that you must
 *         `export CLAUDE_CODE_OAUTH_TOKEN=…` yourself; it does not persist, so
 *         it would either leave claude unauthenticated or force us to store a
 *         token.)
 *       · codex  → `codex login --device-auth`: prints a URL + one-time code;
 *         the user authorizes their ChatGPT account on any device.
 *       · opencode → `opencode auth login`: opens opencode's provider picker. The
 *         user picks "OpenCode Zen" (opencode's recommended gateway) or any
 *         provider they have access to, and authorizes/pastes its credential into
 *         opencode's own secure store. myshell never sees that credential —
 *         opencode stores it — and from it opencode brokers many models (e.g. Kimi
 *         via opencode-go). We keep the bare `auth login` (the provider picker)
 *         rather than `-p opencode` so the user can choose any provider.
 *
 * When no method is forced, we auto-detect: headless/remote environments default
 * to 'code' (so the guidance matches a no-local-browser shell), else 'browser'.
 *
 * Security: myshell-tools never stores raw API keys, tokens, or passwords. Each
 * vendor CLI manages its own credentials; we only orchestrate their sign-in.
 * After a successful claude sign-in we clear any token an OLDER setup-token flow
 * may have left in our store, so it can't shadow claude's own fresh credential.
 */

import type { OutputSink } from '../interface/render.js';
import { runInteractiveChild } from '../infra/controlling-tty.js';
import type { CommandGatePort } from '../core/command-gate.js';
import type { ProviderId } from '../providers/port.js';
import { detectProvider, getInstallCommand } from '../providers/detect.js';
import { bold, dim, green, red } from '../ui/theme.js';
import { parseYesNo, yesNoHint } from '../interface/menu-questions.js';
import { clearClaudeToken, loginPersistentEnv } from '../infra/credentials.js';

/** Which sign-in flow to run. See module docstring. */
export type LoginMethod = 'browser' | 'code';

export type LoginVerification = 'authenticated' | 'not-authenticated' | 'probe-error';

export type LoginAttemptOutcome = {
  readonly method: LoginMethod;
  readonly status: 'authenticated' | 'cancelled' | 'failed';
  readonly childExitCode: number | null;
  readonly verification: LoginVerification;
};

export type LoginProviderOutcome =
  | {
      readonly provider: ProviderId;
      readonly status: 'authenticated';
      readonly method: LoginMethod;
      readonly attempts: readonly LoginAttemptOutcome[];
      readonly fallbackUsed: boolean;
    }
  | {
      readonly provider: ProviderId;
      readonly status: 'cancelled' | 'failed' | 'skipped-not-installed';
      readonly method: null;
      readonly attempts: readonly LoginAttemptOutcome[];
      readonly fallbackUsed: boolean;
    };

export type LoginResult = {
  readonly status: 'success' | 'partial' | 'cancelled' | 'failed' | 'no-targets' | 'invalid-provider';
  readonly outcomes: readonly LoginProviderOutcome[];
  readonly invalidProvider?: string;
};

export type LoginOptions = {
  method?: LoginMethod;
  readLine?: () => Promise<string | null>;
  suspendStdin?: () => () => void;
  confirm?: (defaultYes: boolean, opts?: { requireExplicit?: boolean }) => Promise<boolean>;
  commandGate?: CommandGatePort;
  accountEnv?: Readonly<Partial<NodeJS.ProcessEnv>>;
};

export type LoginRunner = (out: OutputSink, providerArg?: string, opts?: LoginOptions) => Promise<LoginResult>;

export type LoginVerifyResult =
  | { kind: 'authenticated' }
  | { kind: 'not-authenticated' }
  | { kind: 'probe-error'; readonly error: unknown };

export type LoginRunnerDeps = {
  readonly detect: typeof detectProvider;
  readonly spawn: typeof runInteractiveChild;
  readonly verify: (id: ProviderId, childEnv: NodeJS.ProcessEnv, cwd: string) => Promise<LoginVerifyResult>;
  readonly clearToken: () => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly cwd: () => string;
};

/** Each provider's default (browser/localhost) sign-in command. */
const LOGIN_COMMAND: Record<ProviderId, { readonly bin: string; readonly args: readonly string[] }> = {
  claude: { bin: 'claude', args: ['/login'] },
  codex: { bin: 'codex', args: ['login'] },
  // Bare `auth login` (not `-p opencode`) opens the provider picker so the user can
  // choose any provider — OpenCode Zen (recommended) or one they have access to.
  // opencode stores the chosen credential itself; myshell never sees it.
  opencode: { bin: 'opencode', args: ['auth', 'login'] },
  // grok stores the OAuth subscription credential in ~/.grok/; myshell never sees it.
  grok: { bin: 'grok', args: ['login', '--oauth'] },
};

/**
 * Each provider's no-localhost ("code") sign-in command, plus the human steps
 * we print before handing over the terminal so the user knows what to expect.
 */
const LOGIN_CODE_COMMAND: Record<
  ProviderId,
  { readonly bin: string; readonly args: readonly string[]; readonly guidance: string }
> = {
  claude: {
    bin: 'claude',
    // We launch `claude /login` — the interactive TUI sign-in — for a robust,
    // selector-driven flow. It shows a method picker (subscription / Console /
    // 3rd-party), then guides the user through the browser-authorize + paste
    // steps in claude's own input box (which handles the paste correctly).
    // When sign-in is complete, the user exits claude (/exit or Ctrl+C / Esc)
    // to return here. Claude persists its own credential; we capture nothing.
    args: ['/login'],
    guidance:
      'claude opens its sign-in screen — choose "Claude account with subscription"\n' +
      '  (option 1) unless you use Console/Bedrock/Vertex.\n' +
      '  Follow the prompt: open the link it shows, authorize in your browser, and\n' +
      '  paste the code into claude\'s box. (This is claude\'s own screen, so the\n' +
      '  paste works.)\n' +
      '  IMPORTANT: when it says you\'re signed in, leave claude to come back here\n' +
      '  — type /exit or press Ctrl+C / Esc. myshell then continues.',
  },
  codex: {
    bin: 'codex',
    args: ['login', '--device-auth'],
    guidance:
      'A URL and a one-time code will appear below.\n' +
      '  1. On any device, open the URL.\n' +
      '  2. Enter the code shown and authorize your ChatGPT account.\n' +
      '  3. Sign-in completes here automatically once authorized.',
  },
  opencode: {
    bin: 'opencode',
    // Bare `auth login` (not `-p opencode`) opens the provider picker so the user can
    // choose any provider — OpenCode Zen (recommended) or one they have access to.
    // opencode stores the chosen credential itself; myshell never sees it.
    args: ['auth', 'login'],
    guidance:
      'opencode shows a provider picker. Pick "OpenCode Zen" (opencode\'s\n' +
      '  recommended gateway) or any provider you have access to, then authorize or\n' +
      '  paste its credential. opencode stores it securely — myshell never sees it —\n' +
      '  and from that one credential opencode brokers many models (e.g. Kimi via\n' +
      '  opencode-go).',
  },
  grok: {
    bin: 'grok',
    // Device-code flow for headless/remote shells where no local browser opens.
    // grok stores the OAuth subscription credential in ~/.grok/; myshell never sees it.
    args: ['login', '--device-auth'],
    guidance:
      'A URL and a one-time code will appear below.\n' +
      '  1. On any device, open the URL.\n' +
      '  2. Enter the code shown and authorize your X / SuperGrok account.\n' +
      '  3. Sign-in completes here automatically once authorized.',
  },
};

export function getLoginCommand(
  id: ProviderId,
  method: LoginMethod,
): { readonly bin: string; readonly args: readonly string[] } {
  const { bin, args } = method === 'code' ? LOGIN_CODE_COMMAND[id] : LOGIN_COMMAND[id];
  return { bin, args };
}

export function isProviderId(value: string): value is ProviderId {
  return value === 'claude' || value === 'codex' || value === 'opencode' || value === 'grok';
}

/**
 * Decide whether the current environment can actually reach a localhost OAuth
 * callback / open a browser. Pure (env + platform in, boolean out) so it is
 * hermetically testable.
 *
 * Returns true for environments where the browser/localhost flow typically
 * fails and the code method should be preferred:
 *   - Known cloud IDEs / containers (Replit, Codespaces, Gitpod).
 *   - SSH sessions (no local browser).
 *   - Linux with no X11/Wayland display (headless box — nothing to open).
 */
export function isHeadlessEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (
    env['REPL_ID'] !== undefined ||
    env['REPLIT_DEV_DOMAIN'] !== undefined ||
    env['CODESPACES'] !== undefined ||
    env['GITPOD_WORKSPACE_ID'] !== undefined
  ) {
    return true;
  }

  if (env['SSH_CONNECTION'] !== undefined || env['SSH_TTY'] !== undefined) {
    return true;
  }

  if (
    platform === 'linux' &&
    (env['DISPLAY'] === undefined || env['DISPLAY'] === '') &&
    (env['WAYLAND_DISPLAY'] === undefined || env['WAYLAND_DISPLAY'] === '')
  ) {
    return true;
  }

  return false;
}

/**
 * Resolve the sign-in method to use. An explicit choice always wins; otherwise
 * fall back to environment auto-detection (headless → 'code', else 'browser').
 * Pure / testable.
 */
export function resolveLoginMethod(
  explicit: LoginMethod | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): LoginMethod {
  if (explicit !== undefined) return explicit;
  return isHeadlessEnv(env, platform) ? 'code' : 'browser';
}

/**
 * Decide whether to retry a failed browser sign-in using the code method,
 * based on the user's answer to the interactive prompt.
 *
 * Wraps {@link parseYesNo} with `defaultYes=true` (pressing Enter accepts the
 * retry). Pure / hermetically testable.
 *
 * @param answer - Raw line from readLine(), or null on EOF.
 * @returns True if the code method should be retried; false if not.
 */
export function shouldRetryWithCode(answer: string | null): boolean {
  return parseYesNo(answer, true);
}

async function runSingleAttempt(
  out: OutputSink,
  id: ProviderId,
  method: LoginMethod,
  childEnv: NodeJS.ProcessEnv,
  cwd: string,
  opts: LoginOptions | undefined,
  deps: LoginRunnerDeps,
): Promise<LoginAttemptOutcome> {
  const { bin, args } = getLoginCommand(id, method);

  const resumeStdin = opts?.suspendStdin?.();
  let childExitCode: number | null;
  try {
    childExitCode = await deps.spawn(bin, args, {
      env: childEnv,
      ...(opts?.commandGate !== undefined ? { commandGate: opts.commandGate } : {}),
    }).done;
  } finally {
    resumeStdin?.();
  }

  const verifyResult = await deps.verify(id, childEnv, cwd);

  if (verifyResult.kind === 'authenticated') {
    if (id === 'claude') {
      try {
        await deps.clearToken();
      } catch {
        /* never downgrade authentication */
      }
      out.write(green('✓ Claude sign-in complete — claude is ready.\n', out.color));
    } else {
      out.write(green(`✓ ${id} sign-in complete.\n`, out.color));
    }
    return { method, status: 'authenticated', childExitCode, verification: 'authenticated' };
  }

  if (verifyResult.kind === 'probe-error') {
    out.write(red(`✗ ${id} sign-in did not complete (exit ${childExitCode ?? 'unknown'}).\n`, out.color));
    return { method, status: 'failed', childExitCode, verification: 'probe-error' };
  }

  const status: 'cancelled' | 'failed' =
    childExitCode === 130 || childExitCode === 143 ? 'cancelled' : 'failed';

  if (childExitCode === 0) {
    out.write(red(`✗ ${id} exited successfully, but is still not signed in.\n`, out.color));
  } else {
    out.write(red(`✗ ${id} sign-in did not complete (exit ${childExitCode ?? 'unknown'}).\n`, out.color));
  }

  return { method, status, childExitCode, verification: 'not-authenticated' };
}

export async function runProviderLogin(
  out: OutputSink,
  id: ProviderId,
  method: LoginMethod,
  opts: LoginOptions | undefined,
  deps: LoginRunnerDeps,
): Promise<LoginProviderOutcome> {
  let detectResult;
  try {
    detectResult = await deps.detect(id);
  } catch {
    return { provider: id, status: 'failed', method: null, attempts: [], fallbackUsed: false };
  }

  if (!detectResult.installed) {
    out.write(dim(`${id}: not installed — skipping. Install with: ${getInstallCommand(id)}\n`, out.color));
    return { provider: id, status: 'skipped-not-installed', method: null, attempts: [], fallbackUsed: false };
  }

  const cwd = deps.cwd();
  const childEnv = {
    ...deps.env,
    ...loginPersistentEnv(deps.env, cwd, [id]),
    ...(opts?.accountEnv ?? {}),
  };

  if (method === 'code') {
    out.write(bold(`\nSigning in to ${id} — no localhost needed.\n`, out.color));
    out.write(dim(LOGIN_CODE_COMMAND[id].guidance + '\n', out.color));

    const attempt = await runSingleAttempt(out, id, 'code', childEnv, cwd, opts, deps);

    if (attempt.status === 'authenticated') {
      return { provider: id, status: 'authenticated', method: 'code', attempts: [attempt], fallbackUsed: false };
    }
    if (attempt.status === 'cancelled') {
      return { provider: id, status: 'cancelled', method: null, attempts: [attempt], fallbackUsed: false };
    }
    return { provider: id, status: 'failed', method: null, attempts: [attempt], fallbackUsed: false };
  }

  out.write(bold(`\nSigning in to ${id} — a browser window may open…\n`, out.color));
  if (id === 'claude') {
    out.write(
      dim(
        "  If, after you click Authorize, the page shows a localhost / \"can't be\n" +
          '  reached" error, copy the full URL from your browser\'s address bar (it has\n' +
          '  a `code=…` part) and paste it back here — claude will finish the sign-in.\n',
        out.color,
      ),
    );
  }

  const browserAttempt = await runSingleAttempt(out, id, 'browser', childEnv, cwd, opts, deps);
  const attempts: LoginAttemptOutcome[] = [browserAttempt];
  let fallbackUsed = false;

  if (browserAttempt.status === 'authenticated') {
    return { provider: id, status: 'authenticated', method: 'browser', attempts, fallbackUsed: false };
  }

  const interactive = opts?.readLine !== undefined || opts?.confirm !== undefined;
  const browserFailed = browserAttempt.childExitCode !== 0;

  if (browserFailed && interactive) {
    out.write(`Browser sign-in failed. Try the no-localhost code method now? ${yesNoHint('yes', out.color)} `);

    const retry: boolean = await (async () => {
      if (opts?.confirm !== undefined) return opts.confirm(true);
      if (opts?.readLine !== undefined) return shouldRetryWithCode(await opts.readLine());
      return false;
    })();

    if (retry) {
      out.write(bold(`\nSigning in to ${id} — no localhost needed.\n`, out.color));
      out.write(dim(LOGIN_CODE_COMMAND[id].guidance + '\n', out.color));

      const codeAttempt = await runSingleAttempt(out, id, 'code', childEnv, cwd, opts, deps);
      attempts.push(codeAttempt);
      fallbackUsed = true;

      if (codeAttempt.status === 'authenticated') {
        return { provider: id, status: 'authenticated', method: 'code', attempts, fallbackUsed: true };
      }

      if (codeAttempt.status === 'cancelled') {
        return { provider: id, status: 'cancelled', method: null, attempts, fallbackUsed: true };
      }
      return { provider: id, status: 'failed', method: null, attempts, fallbackUsed: true };
    }

    out.write(
      dim(
        `If the browser/localhost step failed, try the code method instead:\n` +
          `  myshell-tools login ${id} --code\n`,
        out.color,
      ),
    );
  } else if (browserFailed && !interactive) {
    out.write(
      dim(
        `If the browser/localhost step failed, try the code method instead:\n` +
          `  myshell-tools login ${id} --code\n`,
        out.color,
      ),
    );
  }

  if (browserAttempt.status === 'cancelled') {
    return { provider: id, status: 'cancelled', method: null, attempts, fallbackUsed };
  }
  return { provider: id, status: 'failed', method: null, attempts, fallbackUsed };
}

export function createLoginRunner(deps: LoginRunnerDeps): LoginRunner {
  return async (out, providerArg, opts) => {
    if (providerArg !== undefined && !isProviderId(providerArg)) {
      out.write(red(`Unknown provider "${providerArg}". Use: claude, codex, opencode, or grok.\n`, out.color));
      return aggregateLoginOutcomes([], providerArg);
    }

    const targets: ProviderId[] =
      providerArg !== undefined ? [providerArg] : ['claude', 'codex', 'opencode', 'grok'];
    const method = resolveLoginMethod(opts?.method, deps.env, deps.platform);

    const outcomes: LoginProviderOutcome[] = [];
    for (const id of targets) {
      const outcome = await runProviderLogin(out, id, method, opts, deps);
      outcomes.push(outcome);
    }

    return aggregateLoginOutcomes(outcomes);
  };
}

export const defaultLoginRunner: LoginRunner = createLoginRunner({
  detect: detectProvider,
  spawn: runInteractiveChild,
  verify: async (id, childEnv, cwd) => {
    try {
      const status = await detectProvider(id, {
        env: childEnv,
        cwd,
        credentialFileFallback: false,
        storedCredentialInjection: false,
      });
      if (status?.authenticated === true) {
        return { kind: 'authenticated' };
      }
      return { kind: 'not-authenticated' };
    } catch (error) {
      return { kind: 'probe-error', error };
    }
  },
  clearToken: clearClaudeToken,
  env: process.env,
  platform: process.platform,
  cwd: () => process.cwd(),
});

export async function runLogin(
  out: OutputSink,
  providerArg?: string,
  opts?: LoginOptions,
): Promise<number> {
  return loginExitCode(await defaultLoginRunner(out, providerArg, opts));
}

export function aggregateLoginOutcomes(
  outcomes: readonly LoginProviderOutcome[],
  invalidProvider?: string,
): LoginResult {
  if (invalidProvider !== undefined) {
    return { status: 'invalid-provider', outcomes: [], invalidProvider };
  }

  if (outcomes.length === 0 || outcomes.every((o) => o.status === 'skipped-not-installed')) {
    return { status: 'no-targets', outcomes };
  }

  const nonSkipped = outcomes.filter((o) => o.status !== 'skipped-not-installed');
  const anyAuthenticated = outcomes.some((o) => o.status === 'authenticated');

  if (anyAuthenticated) {
    if (nonSkipped.every((o) => o.status === 'authenticated')) {
      return { status: 'success', outcomes };
    }
    return { status: 'partial', outcomes };
  }

  if (outcomes.some((o) => o.status === 'failed')) {
    return { status: 'failed', outcomes };
  }
  if (outcomes.some((o) => o.status === 'cancelled')) {
    return { status: 'cancelled', outcomes };
  }
  return { status: 'no-targets', outcomes };
}

export function loginExitCode(result: LoginResult): 0 | 1 {
  return result.status === 'success' ? 0 : 1;
}
