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
 *
 * When no method is forced, we auto-detect: headless/remote environments default
 * to 'code' (so the guidance matches a no-local-browser shell), else 'browser'.
 *
 * Security: myshell-tools never stores raw API keys, tokens, or passwords. Each
 * vendor CLI manages its own credentials; we only orchestrate their sign-in.
 * After a successful claude sign-in we clear any token an OLDER setup-token flow
 * may have left in our store, so it can't shadow claude's own fresh credential.
 */

import { execa } from 'execa';
import type { OutputSink } from '../interface/render.js';
import type { ProviderId } from '../providers/port.js';
import { detectProvider, getInstallCommand } from '../providers/detect.js';
import { bold, dim, green, red } from '../ui/theme.js';
import { parseYesNo, yesNoHint } from '../interface/menu.js';
import { clearClaudeToken } from '../infra/credentials.js';

/** Which sign-in flow to run. See module docstring. */
export type LoginMethod = 'browser' | 'code';

/** Each provider's default (browser/localhost) sign-in command. */
const LOGIN_COMMAND: Record<ProviderId, { readonly bin: string; readonly args: readonly string[] }> = {
  claude: { bin: 'claude', args: ['/login'] },
  codex: { bin: 'codex', args: ['login'] },
  // `opencode auth login` logs in your provider/subscription (anthropic, openai,
  // opencode-zen, …) — that's what makes opencode actually useful for real work.
  opencode: { bin: 'opencode', args: ['auth', 'login'] },
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
    args: ['auth', 'login'],
    guidance:
      'This starts `opencode auth login` — opencode is multi-provider, so it shows\n' +
      '  a list. Pick the one you pay for:\n' +
      '  • OpenCode Go ($10/mo subscription — Kimi, GLM, DeepSeek, Qwen…): select\n' +
      '    "opencode" and paste the API key from your OpenCode account.\n' +
      '  • Or a provider you have (anthropic, openai, …) / OpenCode Zen credits.\n' +
      '  myshell then auto-picks the best model you have per task. Free models alone\n' +
      '  are not enough. myshell never sees the credentials — opencode manages them.',
  },
};

export function isProviderId(value: string): value is ProviderId {
  return value === 'claude' || value === 'codex' || value === 'opencode';
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

/**
 * Run the code sign-in method for a single provider.
 *
 * Factored out so both the initial `--code` path and the browser-fail retry
 * path can invoke it without duplicating the spawn + paste-capture logic.
 * Never throws.
 */
async function runCodeMethodForProvider(
  out: OutputSink,
  id: ProviderId,
  suspendStdin?: () => () => void,
): Promise<void> {
  const { bin, args, guidance } = LOGIN_CODE_COMMAND[id];
  out.write(bold(`\nSigning in to ${id} — no localhost needed.\n`, out.color));
  out.write(dim(guidance + '\n', out.color));
  // Release our readline's grip on stdin so the provider CLI is the SOLE reader
  // of the terminal during its interactive sign-in (claude auth login prints a
  // "Paste code here" prompt for its OOB code flow; codex --device-auth waits on
  // the same TTY). Without this, our readline and the child race for the same
  // bytes and a pasted value lands split/garbled.
  const resumeStdin = suspendStdin?.();
  try {
    // Run the vendor sign-in interactively. We intentionally ignore the exit code
    // (it's unreliable — see below) and verify via a real credential probe instead.
    await execa(bin, [...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', reject: false });
  } finally {
    resumeStdin?.();
  }

  // Verify with a REAL credential probe rather than trusting the exit code:
  // `claude auth login` can exit 0 even when the pasted code was rejected, so the
  // only honest "are you signed in?" answer is to re-detect. This makes the flow
  // self-correcting — a failed paste is reported as such, with the next step.
  const status = await detectProvider(id).catch(() => null);
  if (status?.authenticated === true) {
    if (id === 'claude') await finishClaudeSignIn(out);
    else out.write(green(`✓ ${id} sign-in complete.\n`, out.color));
    return;
  }

  // Not authenticated. Be specific for claude's OOB "Invalid code" failure and
  // point at the guaranteed fallback (a direct `claude /login` that myshell then
  // picks up via the persistent credentials dir).
  out.write(red(`✗ ${id} is still not signed in.\n`, out.color));
  if (id === 'claude') {
    out.write(
      dim(
        '  If claude said "Invalid code": that code is single-use and short-lived —\n' +
          '  re-run this and authorize + paste promptly (press only y at the prompt,\n' +
          '  no extra Enter). Or sign in directly with `claude /login`; myshell reads\n' +
          '  that sign-in automatically.\n',
        out.color,
      ),
    );
  } else {
    out.write(dim(`  Re-run \`myshell-tools login ${id}\` to try again.\n`, out.color));
  }
}

/**
 * Finalise a successful `claude auth login`. Claude has already persisted its
 * own credential (Keychain / ~/.claude/.credentials.json), so there is nothing
 * for us to capture. We only clear any token a PREVIOUS `setup-token` flow left
 * in our store: a stale `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over the
 * fresh subscription login and would silently shadow it once it expires.
 * Never throws.
 */
async function finishClaudeSignIn(out: OutputSink): Promise<void> {
  await clearClaudeToken();
  out.write(green('✓ Claude sign-in complete — claude is ready.\n', out.color));
}

/**
 * Run the interactive sign-in flow for one provider (or all installed providers
 * when no argument is given). Returns 0 on success, 1 only for an invalid
 * argument — individual sign-in failures are reported but do not fail the command.
 *
 * @param opts.method   - Force 'browser' or 'code'. When omitted, the method is
 *   auto-detected from the environment via {@link resolveLoginMethod}.
 * @param opts.readLine - Injected line-reader the menu shares so the
 *   browser-failed "retry with code?" prompt reuses the single readline interface.
 * @param opts.suspendStdin - Releases our readline's grip on stdin while the
 *   vendor CLI owns the terminal, then restores it (prevents a paste byte-race).
 */
export async function runLogin(
  out: OutputSink,
  providerArg?: string,
  opts?: {
    method?: LoginMethod;
    readLine?: () => Promise<string | null>;
    suspendStdin?: () => () => void;
    confirm?: (defaultYes: boolean, opts?: { requireExplicit?: boolean }) => Promise<boolean>;
  },
): Promise<number> {
  let targets: ProviderId[];
  if (providerArg !== undefined) {
    if (!isProviderId(providerArg)) {
      out.write(red(`Unknown provider "${providerArg}". Use: claude, codex, or opencode.\n`, out.color));
      return 1;
    }
    targets = [providerArg];
  } else {
    targets = ['claude', 'codex', 'opencode'];
  }

  const method = resolveLoginMethod(opts?.method, process.env, process.platform);

  for (const id of targets) {
    const status = await detectProvider(id);
    if (!status.installed) {
      out.write(
        dim(`${id}: not installed — skipping. Install with: ${getInstallCommand(id)}\n`, out.color),
      );
      continue;
    }

    if (method === 'code') {
      // stdio:'inherit' hands the terminal to the provider CLI so its OAuth /
      // device / paste flow runs in place.
      await runCodeMethodForProvider(out, id, opts?.suspendStdin);
    } else {
      // Browser method
      const { bin, args } = LOGIN_COMMAND[id];
      out.write(bold(`\nSigning in to ${id} — a browser window may open…\n`, out.color));
      // Prime the user for the classic localhost trap BEFORE it happens, so a
      // "can't be reached" redirect error reads as a known step, not a failure.
      // claude itself accepts the pasted address-bar URL (which carries the code).
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
      const resumeStdin = opts?.suspendStdin?.();
      let result;
      try {
        result = await execa(bin, [...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', reject: false });
      } finally {
        resumeStdin?.();
      }

      if (result.exitCode === 0) {
        if (id === 'claude') await finishClaudeSignIn(out);
        else out.write(green(`✓ ${id} sign-in complete.\n`, out.color));
      } else {
        out.write(
          red(`✗ ${id} sign-in did not complete (exit ${result.exitCode ?? 'unknown'}).\n`, out.color),
        );
        // The classic container failure mode is a dead localhost callback.
        // When an interactive readline is available, offer to immediately retry
        // using the no-localhost code method. Otherwise print the manual hint.
        if (opts?.readLine !== undefined) {
          out.write(
            `Browser sign-in failed. Try the no-localhost code method now? ${yesNoHint('yes', out.color)} `,
          );
          const retryWithCode =
            opts.confirm !== undefined
              ? await opts.confirm(true)
              : shouldRetryWithCode(await opts.readLine());
          if (retryWithCode) {
            await runCodeMethodForProvider(out, id, opts.suspendStdin);
          } else {
            out.write(
              dim(
                `If the browser/localhost step failed, try the code method instead:\n` +
                  `  myshell-tools login ${id} --code\n`,
                out.color,
              ),
            );
          }
        } else {
          // Non-interactive path: print the hint as before.
          out.write(
            dim(
              `If the browser/localhost step failed, try the code method instead:\n` +
                `  myshell-tools login ${id} --code\n`,
              out.color,
            ),
          );
        }
      }
    }
  }

  return 0;
}
