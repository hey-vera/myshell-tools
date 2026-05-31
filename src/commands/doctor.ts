/**
 * src/commands/doctor.ts — `myshell-tools doctor` health-check command.
 *
 * Probes the runtime environment (providers, filesystem, pricing) and prints
 * an honest, human-readable report to an OutputSink. All displayed data comes
 * from real detection results — no fabricated values.
 *
 * Honesty contract: authentication status is based on real CLI probes
 * (`claude auth status`, `codex login status`). Plan labels are only shown
 * when the CLI output clearly provides them; plan is never fabricated.
 *
 * --fix mode: after printing the normal report, prompts to install missing
 * providers and sign in to installed-but-unauthenticated ones. All I/O seams
 * (detectEnvironment, installProvider, login, readLine) are injectable so tests
 * remain hermetic — no real npm/login/detect spawned in tests.
 */

import readline from 'node:readline';
import { access, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutputSink } from '../interface/render.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { detectEnvironment, getInstallCommand } from '../providers/detect.js';
import { installProvider } from '../providers/install.js';
import { runLogin } from './login.js';
import { isPricingStale } from '../infra/pricing.js';
import { loadClaudeTokenCapturedAt, claudeTokenStatus } from '../infra/credentials.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import { parseYesNo } from '../interface/menu.js';
import { bold, green, red, yellow, dim, divider, label } from '../ui/theme.js';

// ---------------------------------------------------------------------------
// Pure builder — testable with a fake EnvironmentStatus
// ---------------------------------------------------------------------------

export interface DoctorExtras {
  readonly nodeVersion: string;
  readonly stateWritable: boolean;
  readonly pricingStale: boolean;
}

/**
 * Build the doctor report lines from pre-collected data.
 *
 * Pure function: no I/O, no process.exit, no side effects.
 * Used by runDoctor after it collects the real data, and by unit tests with
 * hand-built inputs.
 *
 * @param env              - Full environment status (from detectEnvironment or a fake).
 * @param extras           - Supplemental runtime info (node version, write probe, etc.).
 * @param color            - Whether to emit ANSI colour codes.
 * @param claudeTokenInfo  - Optional pre-computed token lifetime status (from claudeTokenStatus()).
 */
export function buildDoctorReport(
  env: EnvironmentStatus,
  extras: DoctorExtras,
  color: boolean,
  claudeTokenInfo?: ClaudeTokenStatus | null,
): string[] {
  const lines: string[] = [];

  lines.push(bold('myshell-tools doctor', color));
  lines.push(divider(color));

  // ---- Platform & Node -------------------------------------------------------
  lines.push(`${label('Platform', color)}: ${env.platform}`);
  lines.push(`${label('Node', color)}:     ${extras.nodeVersion}`);

  // ---- .myshell-tools writability ---------------------------------------------------
  const writableText = extras.stateWritable
    ? green('writable', color)
    : red('not writable', color);
  lines.push(`${label('.myshell-tools dir', color)}: ${writableText}`);

  // ---- Pricing staleness -----------------------------------------------------
  const pricingText = extras.pricingStale
    ? yellow('stale — consider updating myshell-tools', color)
    : green('up to date', color);
  lines.push(`${label('Pricing table', color)}: ${pricingText}`);

  lines.push(divider(color));

  // ---- Providers -------------------------------------------------------------
  lines.push(bold('Providers', color));

  for (const ps of [env.claude, env.codex, env.opencode]) {
    if (ps.installed) {
      const versionStr = ps.version !== null ? ps.version : 'unknown';
      lines.push(
        `  ${green('✓', color)} ${bold(ps.id, color)} — installed, version: ${versionStr}`,
      );
      if (ps.id === 'opencode') {
        // opencode auth was never probed — it is usable via free models without
        // sign-in. Saying "signed in" would be dishonest.
        lines.push(
          `    ${label('auth', color)}: ${green('free models (no sign-in needed)', color)}`,
        );
      } else if (ps.authenticated) {
        const planLabel = ps.plan !== null ? ` (${ps.plan})` : '';
        lines.push(
          `    ${label('auth', color)}: ${green('signed in', color)}${planLabel}`,
        );
        // Token lifetime line — only for claude, only when we have a captured-at date.
        if (ps.id === 'claude' && claudeTokenInfo != null) {
          const info = claudeTokenInfo;
          if (info.expired) {
            lines.push(
              `    ${label('token', color)}: ${red('EXPIRED — run: myshell-tools login claude --code', color)}`,
            );
          } else if (info.nearExpiry) {
            const expiryDate = info.expiresAt.slice(0, 10);
            lines.push(
              `    ${label('token', color)}: ${yellow(`expires soon (${info.daysLeft} days, ~${expiryDate}) — re-run login when convenient`, color)}`,
            );
          } else {
            const expiryDate = info.expiresAt.slice(0, 10);
            lines.push(
              `    ${label('token', color)}: expires ~${expiryDate} (${info.daysLeft} days left)`,
            );
          }
        }
      } else {
        lines.push(
          `    ${label('auth', color)}: ${yellow('not signed in', color)} — run: myshell-tools login`,
        );
      }
    } else {
      lines.push(
        `  ${red('✗', color)} ${bold(ps.id, color)} — ${red('not installed', color)}`,
      );
      lines.push(
        `    ${dim(`Install: ${getInstallCommand(ps.id)}`, color)}`,
      );
    }
  }

  lines.push(divider(color));

  // ---- Overall status --------------------------------------------------------
  if (env.hasAnyProvider) {
    lines.push(green('Ready — at least one provider is available.', color));
  } else {
    lines.push(
      red('No providers found.', color) +
        ' Install claude, codex, or opencode to use myshell-tools.',
    );
  }

  return lines;
}

// ---------------------------------------------------------------------------
// I/O runner — called by cli.ts
// ---------------------------------------------------------------------------

/**
 * Probe the .myshell-tools directory for writability.
 *
 * Creates .myshell-tools/ if needed, writes a temp file, then removes it.
 * Returns true when successful, false on any I/O error.
 */
async function probestateWritable(cwd: string): Promise<boolean> {
  const stateDir = join(cwd, '.myshell-tools');
  const probe = join(stateDir, '.doctor-probe');
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(probe, '');
    await rm(probe, { force: true });
    await access(stateDir);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fix-mode options (injectable seams for hermetic testing)
// ---------------------------------------------------------------------------

export interface DoctorFixOpts {
  /** When true, run an interactive fix pass after the report. */
  readonly fix?: boolean;
  /**
   * Read one line of user input. Used for Y/n prompts in fix mode.
   * When absent, a temporary readline interface is created (real CLI path).
   */
  readonly readLine?: () => Promise<string | null>;
  /**
   * Install a provider. Injected in tests to avoid real npm spawns.
   * Defaults to the real installProvider from providers/install.ts.
   */
  readonly installProvider?: (id: 'claude' | 'codex' | 'opencode', out: OutputSink) => Promise<boolean>;
  /**
   * Sign in to a provider. Injected in tests to avoid real login spawns.
   * Defaults to the real runLogin from commands/login.ts.
   */
  readonly login?: (out: OutputSink, providerArg?: string) => Promise<number>;
  /**
   * Detect the environment. Injected in tests to avoid real spawns.
   * Defaults to the real detectEnvironment from providers/detect.ts.
   */
  readonly detectEnvironment?: () => Promise<EnvironmentStatus>;
  /**
   * Load the Claude token capture timestamp (ISO 8601). Injected in tests to
   * drive the token-expiry refresh prompt hermetically (no disk read).
   * Defaults to the real loadClaudeTokenCapturedAt from infra/credentials.ts.
   */
  readonly loadClaudeTokenCapturedAt?: () => Promise<string | undefined>;
  /**
   * Current epoch-ms, used for deterministic token-expiry computation in tests.
   * Defaults to Date.now().
   */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// I/O runner — called by cli.ts
// ---------------------------------------------------------------------------

/**
 * Detect the environment, probe I/O, build the report, and write it to `out`.
 *
 * When `opts.fix` is true, runs an interactive fix pass after the report:
 * prompts to install missing providers, re-detects, then prompts to sign in
 * to any installed-but-unauthenticated providers. All I/O seams are injectable
 * via `opts` so tests stay hermetic.
 *
 * Returns 0 when at least one provider is installed, 1 otherwise.
 * Never calls process.exit — that is handled exclusively by src/cli.ts.
 * Never throws — any step failure is reported and the pass continues.
 */
export async function runDoctor(out: OutputSink, opts?: DoctorFixOpts): Promise<number> {
  const detectEnvironmentFn = opts?.detectEnvironment ?? detectEnvironment;
  const installProviderFn = opts?.installProvider ?? installProvider;
  const loginFn = opts?.login ?? ((o, id) => runLogin(o, id));

  const env = await detectEnvironmentFn();
  const stateWritable = await probestateWritable(process.cwd());

  const extras: DoctorExtras = {
    nodeVersion: process.version,
    stateWritable,
    pricingStale: isPricingStale(),
  };

  // Compute token lifetime info when claude is signed in and a capture date is stored.
  let claudeTokenInfo: ClaudeTokenStatus | null | undefined;
  if (env.claude.installed && env.claude.authenticated) {
    const capturedAt = await loadClaudeTokenCapturedAt();
    claudeTokenInfo = claudeTokenStatus(capturedAt, Date.now());
  }

  const lines = buildDoctorReport(env, extras, out.color, claudeTokenInfo);
  for (const line of lines) {
    out.write(line + '\n');
  }

  if (!opts?.fix) {
    return env.hasAnyProvider ? 0 : 1;
  }

  // ---- Fix pass --------------------------------------------------------------
  // Create a temporary readline if no readLine seam was injected (real CLI path).
  let rlClose: (() => void) | undefined;
  let readLineFn = opts.readLine;
  if (readLineFn === undefined) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    readLineFn = () =>
      new Promise<string | null>((resolve) => {
        rl.once('line', (raw: string) => resolve(raw.trim()));
        rl.once('close', () => resolve(null));
      });
    rlClose = () => rl.close();
  }

  const loadCapturedAtFn = opts.loadClaudeTokenCapturedAt ?? loadClaudeTokenCapturedAt;
  const nowFn = opts.now ?? (() => Date.now());

  try {
    await runFixPass(
      out,
      env,
      readLineFn,
      installProviderFn,
      loginFn,
      detectEnvironmentFn,
      loadCapturedAtFn,
      nowFn,
    );
  } finally {
    rlClose?.();
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Fix pass (internal — separated for clarity and testability)
// ---------------------------------------------------------------------------

/**
 * Interactive fix pass:
 *   1. Offer to install each missing provider (claude, codex, opencode).
 *   2. Re-detect to pick up any newly installed ones.
 *   3. Offer to sign in to each installed-but-unauthenticated provider.
 *      (opencode is always authenticated when installed, so it is never
 *       offered a sign-in prompt — that is by design, not an omission.)
 *   4. Re-detect once more and print a brief final status line.
 *
 * Never throws — any step failure is caught and reported via `out`.
 */
async function runFixPass(
  out: OutputSink,
  initialEnv: EnvironmentStatus,
  readLine: () => Promise<string | null>,
  installProviderFn: (id: 'claude' | 'codex' | 'opencode', out: OutputSink) => Promise<boolean>,
  loginFn: (out: OutputSink, providerArg?: string) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  loadCapturedAtFn: () => Promise<string | undefined>,
  nowFn: () => number,
): Promise<void> {
  const providers: Array<'claude' | 'codex' | 'opencode'> = ['claude', 'codex', 'opencode'];

  // ---- Step 1: offer installs for missing providers -------------------------
  const missingIds = providers.filter((id) => !initialEnv[id].installed);
  let didInstallAny = false;

  for (const id of missingIds) {
    const pkg = getInstallCommand(id).replace('npm install -g ', '');
    out.write(`\nInstall ${id} (${pkg})? (Y/n) `);
    const ans = await readLine();
    if (parseYesNo(ans, true)) {
      try {
        await installProviderFn(id, out);
        didInstallAny = true;
      } catch {
        out.write(red(`✗ Install of ${id} failed.\n`, out.color));
      }
    }
  }

  // ---- Step 2: re-detect if anything was installed --------------------------
  let env = initialEnv;
  if (didInstallAny || missingIds.length > 0) {
    try {
      env = await detectEnvironmentFn();
    } catch {
      // If re-detection fails, continue with the original env — never throw.
    }
  }

  // ---- Step 3: offer sign-in for installed-but-unauthenticated providers ----
  // opencode.authenticated is always true when installed (free models, no creds
  // needed) so it naturally won't appear here — the condition is honest.
  const needsAuth = providers.filter((id) => env[id].installed && !env[id].authenticated);

  for (const id of needsAuth) {
    out.write(`\nSign in to ${id} now? (Y/n) `);
    const ans = await readLine();
    if (parseYesNo(ans, true)) {
      try {
        await loginFn(out, id);
      } catch {
        out.write(red(`✗ Sign-in for ${id} did not complete.\n`, out.color));
      }
    }
  }

  // ---- Step 3b: offer a Claude token refresh when it is expiring -------------
  // The sk-ant-oat… token from `claude setup-token` is ~1-year-lived. Proactively
  // offer to refresh it when expired or inside the warning window so users aren't
  // surprised by a mid-session auth failure (a real reported confusion).
  if (env.claude.installed && env.claude.authenticated) {
    const capturedAt = await loadCapturedAtFn().catch(() => undefined);
    const tokenInfo = claudeTokenStatus(capturedAt, nowFn());
    if (tokenInfo !== null && (tokenInfo.expired || tokenInfo.nearExpiry)) {
      const when = tokenInfo.expired ? 'has expired' : `expires in ${tokenInfo.daysLeft} days`;
      out.write(`\nYour Claude token ${when}. Refresh it now? (Y/n) `);
      const ans = await readLine();
      if (parseYesNo(ans, true)) {
        try {
          await loginFn(out, 'claude');
        } catch {
          out.write(red(`✗ Claude re-login did not complete.\n`, out.color));
        }
      }
    }
  }

  // ---- Step 4: final re-detect and brief summary ----------------------------
  let finalEnv = env;
  try {
    finalEnv = await detectEnvironmentFn();
  } catch {
    // Best-effort — report from last known state if this fails.
  }

  out.write('\n');
  for (const id of providers) {
    const ps = finalEnv[id];
    if (ps.installed && ps.authenticated) {
      out.write(green(`✓ ${id}: installed, signed in.\n`, out.color));
    } else if (ps.installed) {
      out.write(yellow(`~ ${id}: installed, not signed in.\n`, out.color));
    } else {
      out.write(red(`✗ ${id}: not installed.\n`, out.color));
    }
  }
}
