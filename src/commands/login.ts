/**
 * src/commands/login.ts — `myshell-tools login [claude|codex] [--code|--browser]`.
 *
 * Frictionless authentication: rather than make the user remember each vendor's
 * CLI auth command, we delegate to the provider's OWN OAuth flow and inherit the
 * terminal so the browser/device sign-in works in place.
 *
 * Two sign-in methods:
 *   - 'browser': the provider's default flow, which spins up a localhost
 *     callback server and opens a browser. Great on a laptop; FAILS inside
 *     containers / over SSH (Replit, Codespaces, etc.) where localhost can't be
 *     reached from the user's browser.
 *   - 'code':   a no-localhost flow that works anywhere.
 *       · claude → `claude setup-token`: prints a link; the user signs in at
 *         claude.ai, copies the authorization code, and pastes it back here.
 *         We TEE the output so we can scan it for the minted token
 *         (sk-ant-oat…) automatically. If auto-capture finds the token, it is
 *         persisted immediately with no user action required. Otherwise we fall
 *         back to prompting the user to paste it (up to 3 retries, with helpful
 *         warnings for blank or wrong-type inputs).
 *       · codex  → `codex login --device-auth`: prints a URL + one-time code;
 *         the user authorizes their ChatGPT account on any device.
 *
 * When no method is forced, we auto-detect: headless/remote environments default
 * to 'code' (so the localhost trap is avoided), everything else to 'browser'.
 *
 * Security: myshell-tools never stores raw API keys or passwords.  The Claude
 * OAuth token (sk-ant-oat…) is either auto-captured from the tee'd output or
 * captured after the user explicitly pastes it, and is stored in
 * ~/.myshell-tools/credentials.json (mode 0o600).
 */

import readline from 'node:readline';
import { execa } from 'execa';
import type { OutputSink } from '../interface/render.js';
import type { ProviderId } from '../providers/port.js';
import { detectProvider, getInstallCommand } from '../providers/detect.js';
import { bold, dim, green, red, yellow } from '../ui/theme.js';
import {
  classifyPastedSecret,
  extractClaudeToken,
  saveClaudeToken,
  stripPastedSecretWrapper,
} from '../infra/credentials.js';

/** Which sign-in flow to run. See module docstring. */
export type LoginMethod = 'browser' | 'code';

/** Each provider's default (browser/localhost) sign-in command. */
const LOGIN_COMMAND: Record<ProviderId, { readonly bin: string; readonly args: readonly string[] }> = {
  claude: { bin: 'claude', args: ['auth', 'login'] },
  codex: { bin: 'codex', args: ['login'] },
  // opencode ships free models — no credentials required. `opencode auth login` adds
  // a premium provider/subscription (e.g. anthropic, openai, or opencode-zen).
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
    args: ['setup-token'],
    guidance:
      'A sign-in link will appear below.\n' +
      '  1. Open it in any browser and sign in at claude.ai.\n' +
      '  2. Copy the authorization code it shows you.\n' +
      '  3. Paste the code back here at the prompt and press Enter.\n' +
      '  We will capture the token automatically when possible.',
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
      'Free models need no login.\n' +
      '  This starts `opencode auth login` to add a premium provider or subscription\n' +
      '  (e.g. anthropic, openai, or opencode-zen).\n' +
      '  myshell-tools never sees the credentials — opencode manages them.',
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
 * Run the interactive sign-in flow for one provider (or all installed providers
 * when no argument is given). Returns 0 on success, 1 only for an invalid
 * argument — individual sign-in failures are reported but do not fail the command.
 *
 * @param opts.method   - Force 'browser' or 'code'. When omitted, the method is
 *   auto-detected from the environment via {@link resolveLoginMethod}.
 * @param opts.readLine - Injected line-reader for the token-paste prompt (used
 *   by the menu so it shares the single readline interface). When absent, a
 *   temporary readline interface is created and immediately closed after one line.
 */
export async function runLogin(
  out: OutputSink,
  providerArg?: string,
  opts?: { method?: LoginMethod; readLine?: () => Promise<string | null> },
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

    // stdio:'inherit' hands the terminal to the provider CLI so its OAuth /
    // device / paste flow runs in place. reject:false so we report rather than throw.
    //
    // For the claude code method we use a special tee-capture approach: stdout
    // and stderr are piped so we can scan for the token, but each line is also
    // written verbatim to the real terminal so the user sees the flow live.
    // stdin is still inherited so the user can interact (paste the auth code).
    let result;
    let capturedOutput = '';

    if (method === 'code' && id === 'claude') {
      const { bin, args, guidance } = LOGIN_CODE_COMMAND[id];
      out.write(bold(`\nSigning in to ${id} — code method (no localhost needed).\n`, out.color));
      out.write(dim(guidance + '\n', out.color));
      capturedOutput = await runWithTeeCapture(bin, [...args]);
      // We use a synthetic exit-code-0 result — tee-capture never throws, and
      // we treat the flow as complete regardless of the subprocess exit code
      // (the token presence is the real signal).
      result = { exitCode: 0 } as const;
    } else if (method === 'code') {
      const { bin, args, guidance } = LOGIN_CODE_COMMAND[id];
      out.write(bold(`\nSigning in to ${id} — code method (no localhost needed).\n`, out.color));
      out.write(dim(guidance + '\n', out.color));
      result = await execa(bin, [...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', reject: false });
    } else {
      const { bin, args } = LOGIN_COMMAND[id];
      out.write(bold(`\nSigning in to ${id} — a browser window may open…\n`, out.color));
      result = await execa(bin, [...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', reject: false });
    }

    if (result.exitCode === 0) {
      // --- Claude code-method token capture -----------------------------------
      // `claude setup-token` mints a long-lived token (sk-ant-oat01-…) and PRINTS
      // it to the terminal. We tee'd the output above and scan it first.
      // If auto-capture finds the token, we're done. Otherwise we fall back to
      // the paste prompt (up to 3 retries) so the user can paste it manually.
      if (id === 'claude' && method === 'code') {
        const autoToken = extractClaudeToken(capturedOutput);
        if (autoToken !== null) {
          try {
            await saveClaudeToken(autoToken);
            process.env['CLAUDE_CODE_OAUTH_TOKEN'] = autoToken;
            out.write(
              green(
                '✓ Claude token captured and saved — claude is now ready.\n',
                out.color,
              ),
            );
          } catch {
            out.write(
              dim(
                'Could not save token to disk — re-run `myshell-tools login claude --code` later.\n',
                out.color,
              ),
            );
          }
        } else {
          // Auto-capture found nothing — fall back to paste prompt.
          out.write(green(`✓ ${id} sign-in complete.\n`, out.color));
          await captureClaudeTokenWithPaste(out, opts?.readLine);
        }
      } else {
        out.write(green(`✓ ${id} sign-in complete.\n`, out.color));
      }
    } else {
      out.write(
        red(`✗ ${id} sign-in did not complete (exit ${result.exitCode ?? 'unknown'}).\n`, out.color),
      );
      // The classic container failure mode is a dead localhost callback. Point
      // the user at the code method, which sidesteps localhost entirely.
      if (method === 'browser') {
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

  return 0;
}

// ---------------------------------------------------------------------------
// Tee-capture helper (internal)
// ---------------------------------------------------------------------------

/**
 * Run a command with stdout and stderr piped (tee'd to the real terminal) and
 * stdin inherited. Returns the accumulated stdout+stderr text, or an empty
 * string on spawn failure. Never throws.
 *
 * Uses execa v9's `all: true` option to merge stdout+stderr into one stream,
 * then iterates it via `subprocess.iterable({ from: 'all', preserveNewlines: true })`
 * while mirroring each chunk to `process.stdout` so the user sees the output
 * live. stdin is inherited so the user can interact (e.g. paste an auth code).
 */
async function runWithTeeCapture(bin: string, args: readonly string[]): Promise<string> {
  try {
    const subprocess = execa(bin, [...args], {
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
      all: true,
      reject: false,
      timeout: 300_000,
    });

    const chunks: string[] = [];

    for await (const line of subprocess.iterable({ from: 'all', preserveNewlines: true })) {
      const text = typeof line === 'string' ? line : String(line);
      process.stdout.write(text);
      chunks.push(text);
    }

    await subprocess; // wait for exit (already resolved by the iteration above)
    return chunks.join('');
  } catch {
    // Spawn error or unexpected failure — return empty so the caller falls back
    // to the paste prompt.
    return '';
  }
}

// ---------------------------------------------------------------------------
// Paste-fallback token capture helper (internal)
// ---------------------------------------------------------------------------

/**
 * Prompt the user to paste the token shown by `claude setup-token`, extract
 * it, persist it, and inject it into `process.env.CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * Retries up to 3 times:
 *   - Blank input  → skip silently with a note.
 *   - API key      → print a specific warning (that's sk-ant-api, not sk-ant-oat).
 *   - Invalid      → warn and re-prompt.
 *   - Valid token  → save and set env.
 *
 * Uses the injected `readLine` when provided (menu shares its single readline
 * interface). Otherwise creates a temporary readline interface, reads ONE line,
 * and immediately closes it (so stdin is not held open).
 *
 * Never throws.
 */
async function captureClaudeTokenWithPaste(
  out: OutputSink,
  readLine?: () => Promise<string | null>,
): Promise<void> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    out.write(
      `\nPaste the token shown above (starts with sk-ant-oat) and press Enter` +
        ` — or leave blank to skip (attempt ${attempt}/${MAX_RETRIES}):\n> `,
    );

    let raw: string | null;

    if (readLine !== undefined) {
      // Menu injected its own reader — use it directly, do NOT create a second
      // readline interface (that would double-consume stdin).
      raw = await readLine();
    } else {
      // CLI direct path — create a temporary readline, read one line, close.
      raw = await readOneLineFromStdin();
    }

    const normalised = stripPastedSecretWrapper(raw ?? '');

    if (normalised === '') {
      out.write(dim('Skipped — no token entered.\n', out.color));
      return;
    }

    const kind = classifyPastedSecret(normalised);

    if (kind === 'api-key') {
      out.write(
        yellow(
          'That looks like an Anthropic API key (sk-ant-api…), not the setup-token\n' +
            'OAuth token. Please paste the sk-ant-oat… value instead.\n',
          out.color,
        ),
      );
      continue;
    }

    const token = extractClaudeToken(normalised);

    if (token !== null) {
      try {
        await saveClaudeToken(token);
        process.env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
        out.write(green('✓ Claude token saved — claude is now ready.\n', out.color));
      } catch {
        out.write(
          dim(
            'Could not save token to disk — you can re-run `myshell-tools login claude --code` later.\n',
            out.color,
          ),
        );
      }
      return;
    }

    // Not a recognised token format.
    if (attempt < MAX_RETRIES) {
      out.write(
        dim(
          'Token not recognised — expected sk-ant-oat… format. Please try again.\n',
          out.color,
        ),
      );
    } else {
      out.write(
        dim(
          'Token not captured after 3 attempts. Re-run `myshell-tools login claude --code`\n' +
            'and paste the sk-ant-oat… value (NOT an Anthropic API key starting with sk-ant-api).\n',
          out.color,
        ),
      );
    }
  }
}

/**
 * Create a temporary readline interface on process.stdin, read exactly one
 * line, and close the interface. Returns the trimmed line or null on EOF.
 *
 * This is used only from the `myshell-tools login` direct CLI path where no
 * shared readline interface exists.
 */
function readOneLineFromStdin(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    let resolved = false;

    rl.once('line', (raw: string) => {
      resolved = true;
      rl.close();
      resolve(raw.trim());
    });

    rl.once('close', () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
  });
}

// Re-export extractClaudeToken so test/unit/credentials.test.ts can import it
// directly from credentials.ts (where it is defined). No re-export needed here.
