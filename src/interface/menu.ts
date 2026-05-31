/**
 * src/interface/menu.ts — Sessions-first interactive control panel.
 *
 * Implements the dual-brain UX design bible:
 *   - A boxed header with provider status (real, from EnvironmentStatus).
 *   - Recent conversations (up to 7, relative timestamps from the store).
 *   - A sectioned menu with letter-key dispatch.
 *   - First-run welcome / 10-second setup flow.
 *   - Per-conversation chat loop backed by runTask().
 *
 * Architecture rules:
 *   - NO process.exit() — caller (cli.ts) owns process lifetime.
 *   - NO Math.random() — all ids / timestamps via injected Clock.
 *   - NO fabricated data — every displayed value is real (env, store, clock).
 *   - NO digit-% literals — percentages are always computed, never hardcoded.
 *   - All rendering goes through ui/tui.ts primitives.
 */

import readline from 'node:readline';
import { execa } from 'execa';
import type { Clock, LedgerWriter, OrchestrateDeps } from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import { saveConfig } from '../infra/config.js';
import type { ConversationMeta, ConversationStore } from '../infra/conversation-store.js';
import { readLedger } from '../infra/ledger.js';
import { summarizeSpend, formatUsd } from '../infra/insights.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { detectEnvironment, getInstallCommand } from '../providers/detect.js';
import { installProvider, installCommandFor } from '../providers/install.js';
import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import { listNativeSessions, importNativeSession } from '../providers/native-sessions.js';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../core/policy.js';
import type { OutputSink } from './render.js';
import { runTask } from './run.js';
import { runLogin } from '../commands/login.js';
import type { LoginMethod } from '../commands/login.js';
import { runDoctor } from '../commands/doctor.js';
import { runCost } from '../commands/cost.js';
import { runInstall } from '../commands/install.js';
import { box, separator, menu, prompt } from '../ui/tui.js';
import type { UpdateCheckResult } from '../infra/update-check.js';

// ---------------------------------------------------------------------------
// MenuContext
// ---------------------------------------------------------------------------

export interface MenuContext {
  readonly version: string;
  readonly clock: Clock;
  readonly ledger: LedgerWriter;
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly env: EnvironmentStatus;
  readonly store: ConversationStore;
  readonly config: AppConfig;
  readonly cwd: string;
  readonly sandbox: SandboxLevel;
  readonly timeoutMs: number;
  /**
   * Optional injected line reader for testing. When provided, `startMenu` uses
   * this instead of the real `node:readline` interface, allowing tests to drive
   * the menu with scripted input without a TTY.
   *
   * Returns the next trimmed line of input, or `null` on EOF/close.
   */
  readonly readLine?: () => Promise<string | null>;
  /**
   * Optional injected installProvider for testing. When provided, `startMenu`
   * uses this instead of the real `installProvider` from providers/install.ts,
   * preventing real `npm install -g …` subprocesses from spawning during tests.
   */
  readonly installProvider?: (id: ProviderId, out: OutputSink) => Promise<boolean>;
  /**
   * Optional injected login function for testing. When provided, `startMenu`
   * uses this instead of the real `runLogin` from commands/login.ts, preventing
   * real `claude`/`codex login` subprocesses from spawning during tests.
   *
   * The third argument mirrors the `opts` parameter of `runLogin` so the menu
   * can pass the shared `readLine` function for the token-paste prompt.
   */
  readonly login?: (
    out: OutputSink,
    providerArg?: string,
    opts?: { method?: LoginMethod; readLine?: () => Promise<string | null> },
  ) => Promise<number>;
  /**
   * Optional injected detectEnvironment for testing. When provided, `startMenu`
   * uses this instead of the real `detectEnvironment` from providers/detect.ts,
   * preventing real `claude`/`codex`/`opencode --version` subprocesses from
   * spawning during tests (e.g. after first-run onboarding or [j]/[k]/[o] login).
   */
  readonly detectEnvironment?: () => Promise<EnvironmentStatus>;
  /**
   * Optional injected update-check for testing. When provided, `startMenu` uses
   * this instead of the real `checkForUpdate` from infra/update-check.ts,
   * preventing real npm registry requests from being made during tests.
   *
   * Returns the update check result (current, latest, updateAvailable).
   */
  readonly checkForUpdate?: () => Promise<UpdateCheckResult>;
  /**
   * Optional injected self-update function for testing. When provided, `startMenu`
   * uses this instead of the real `npm install -g myshell-tools@latest` subprocess.
   *
   * Returns true when the update succeeded (exit code 0), false otherwise.
   * Never throws.
   */
  readonly updateSelf?: (out: OutputSink) => Promise<boolean>;
  /**
   * Optional injected relaunch function for testing. When provided, `startMenu`
   * uses this instead of the real `execa('myshell-tools', …)` re-exec.
   *
   * Returns the exit code of the relaunched process (or 1 on spawn failure).
   * Used only for the opt-in auto-update path.
   */
  readonly relaunch?: () => Promise<number>;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Parse a yes/no answer from a raw input line, with a configurable default.
 *
 * Accepts (case-insensitive, trimmed):
 *   - `"y"` or `"yes"`           → true
 *   - `"n"` or `"no"`            → false
 *   - empty string or `null` (EOF) → `defaultYes`
 *   - anything else              → `defaultYes` (lenient)
 *
 * Never throws.  Callers should display `(Y/n)` when `defaultYes` is true and
 * `(y/N)` when `defaultYes` is false so the user knows which choice Enter gives.
 *
 * @param input      - The raw line from readLine(), or null on EOF.
 * @param defaultYes - True if pressing Enter (or EOF) means yes.
 * @returns True for yes, false for no.
 */
export function parseYesNo(input: string | null, defaultYes: boolean): boolean {
  if (input === null || input.trim().length === 0) return defaultYes;
  const lower = input.trim().toLowerCase();
  if (lower === 'y' || lower === 'yes') return true;
  if (lower === 'n' || lower === 'no') return false;
  return defaultYes;
}

/**
 * Decide whether auto-update is enabled for this launch.
 *
 * Auto-update is considered ENABLED when:
 *   - `config.autoUpdate` is `true` or `undefined` (absent = default-on), AND
 *   - `env['MYSHELL_NO_UPDATE']` is not set (any non-empty value disables it).
 *
 * A user who explicitly set `autoUpdate: false` in their config keeps it off.
 * Setting `MYSHELL_NO_UPDATE=1` (or any non-empty value) in the environment
 * overrides even an explicit `autoUpdate: true`.
 *
 * Pure — no I/O, no side effects, never throws.
 *
 * @param config - The loaded AppConfig (only `autoUpdate` field is read).
 * @param env    - A `NodeJS.ProcessEnv`-shaped object to read `MYSHELL_NO_UPDATE` from.
 * @returns True when auto-update should run at launch.
 */
export function autoUpdateEnabled(
  config: { autoUpdate?: boolean },
  env: NodeJS.ProcessEnv,
): boolean {
  if (env['MYSHELL_NO_UPDATE'] !== undefined && env['MYSHELL_NO_UPDATE'].length > 0) {
    return false;
  }
  return config.autoUpdate !== false;
}

/**
 * Return the shell alias hint the user can add to their shell profile to make
 * `myshell-tools` the default command-line assistant.
 *
 * This is a pure, I/O-free helper — it never reads or writes any file. The
 * caller is responsible for printing the result. No claim is made that the
 * system has been changed; the output is a copy-pasteable suggestion only.
 *
 * @param shell    - The value of `process.env.SHELL` (e.g. '/bin/bash'), or
 *                   empty/undefined on Windows where SHELL is absent.
 * @param platform - The `process.platform` string (e.g. 'win32', 'linux').
 * @returns A human-readable string containing the exact alias line to add.
 */
export function defaultAliasHint(shell: string | undefined, platform: string): string {
  if (platform === 'win32') {
    return (
      'Add to your PowerShell profile ($PROFILE):\n' +
      "  function mst { myshell-tools @args }"
    );
  }
  const shellName = typeof shell === 'string' && shell.length > 0
    ? shell.split('/').at(-1) ?? 'bash'
    : 'bash';
  if (shellName === 'fish') {
    return (
      'Add to ~/.config/fish/config.fish:\n' +
      '  alias mst="myshell-tools"'
    );
  }
  const rcFile = shellName === 'zsh' ? '~/.zshrc' : '~/.bashrc';
  return (
    `Add to ${rcFile}:\n` +
    '  alias mst="myshell-tools"'
  );
}

/**
 * Format a relative time string from a past epoch-ms to a now epoch-ms.
 * Returns "just now", "Nm ago" (minutes), "Nh ago" (hours), or "Nd ago" (days).
 * All arithmetic is pure — no Date, no Math.random.
 */
export function relativeTime(thenMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - thenMs);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return `${days}d ago`;
}

/**
 * Build the header box lines (provider status) from real EnvironmentStatus.
 * Returns string[] safe to pass as the `lines` arg to box().
 *
 * Per-provider logic (uses REAL authenticated + plan fields):
 *   ✅  when ps.installed && ps.authenticated
 *   ⚠️  when ps.installed && !ps.authenticated  (append " not signed in")
 *   ❌  when !ps.installed                       (append install command)
 * Plan label appended when ps.plan is non-null (e.g. " (Max x5)").
 */
export function renderHeaderLines(env: EnvironmentStatus, _version: string): string[] {
  const lines: string[] = [];

  for (const ps of [env.claude, env.codex]) {
    const planSuffix = ps.plan != null ? ` (${ps.plan})` : '';

    if (!ps.installed) {
      lines.push(`❌ ${ps.id}: not installed — ${getInstallCommand(ps.id)}`);
    } else if (ps.authenticated) {
      lines.push(`✅ ${ps.id}: ready${planSuffix}`);
    } else {
      lines.push(`⚠️  ${ps.id}: not signed in${planSuffix}`);
    }
  }

  // opencode: only show when installed (never nag users who only use claude/codex).
  // opencode is authenticated-when-installed (free models, no credentials required).
  if (env.opencode.installed) {
    const ps = env.opencode;
    const planSuffix = ps.plan != null ? ` (${ps.plan})` : '';
    if (ps.authenticated) {
      lines.push(`✅ ${ps.id}: ready${planSuffix}`);
    } else {
      lines.push(`⚠️  ${ps.id}: not signed in${planSuffix}`);
    }
  }

  return lines;
}

/**
 * Render the budget/spend status line shown beneath the provider header.
 *
 * Uses real numbers only — all values come from the SpendSummary which is
 * derived from `readLedger`. No digit-% literals appear in this function; it
 * shows dollar amounts only.
 *
 * @param spend - Output of summarizeSpend() over real ledger entries.
 * @param color - When false, no ANSI escape codes are emitted.
 */
export function renderBudgetLine(spend: SpendSummary, _color: boolean): string {
  if (spend.calls === 0) {
    return 'Today: ' + formatUsd(0) + ' · no runs yet';
  }
  const todayPart = 'Today: ' + formatUsd(spend.todayUsd) + ' · ' + String(spend.calls) + ' calls';
  const totalPart = 'Total: ' + formatUsd(spend.totalUsd);
  return todayPart + '   ·   ' + totalPart;
}

/**
 * Build the conversation list lines from real ConversationMeta[].
 * Format: "[N] <pin> <relative-time>  <title>[  [<category>]]"
 *
 * Pin prefix: "📌 " for pinned, "   " (3 spaces) for alignment when not pinned.
 * Category suffix: "  [<category>]" appended when category is set, omitted otherwise.
 * Returns string[] (no ANSI — pure string building, safe for tests).
 */
export function renderConversationList(metas: ConversationMeta[], nowMs: number): string[] {
  return metas.slice(0, 7).map((m, i) => {
    const thenMs = new Date(m.updatedAt).getTime();
    const rel = relativeTime(thenMs, nowMs);
    const idx = i + 1;
    const pin = m.pinned ? '📌 ' : '   ';
    const categorySuffix = m.category != null ? `  [${m.category}]` : '';
    return `[${idx}] ${pin}${rel}  ${m.title}${categorySuffix}`;
  });
}

// ---------------------------------------------------------------------------
// Ctrl+C escape model — pure helpers
// ---------------------------------------------------------------------------

/**
 * Count how many timestamps in `times` fall within the half-open window
 * `[now - windowMs, now]` (both endpoints inclusive).
 *
 * Pure — no I/O, no side effects, never throws.
 *
 * @param times    - Immutable array of epoch-ms timestamps (e.g. from ctx.clock.now()).
 * @param now      - The current epoch-ms (e.g. from ctx.clock.now()).
 * @param windowMs - Width of the sliding window in milliseconds (e.g. 1500).
 * @returns Number of entries within the window.
 */
export function countRecentInterrupts(
  times: readonly number[],
  now: number,
  windowMs: number,
): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const t of times) {
    if (t >= cutoff && t <= now) count += 1;
  }
  return count;
}

/**
 * Decide what action to take based on the number of recent Ctrl+C presses and
 * whether a task is currently running.
 *
 * Rules:
 *   count >= 3 → `'exit-app'`
 *   count === 2 → `'to-menu'`
 *   count === 1 && taskRunning → `'cancel-task'`
 *   count === 1 && !taskRunning → `'hint'`
 *   count <= 0  → `'hint'` (defensive)
 *
 * Pure — never throws, no I/O, no side effects.
 *
 * @param count       - Number of recent interrupt presses (from countRecentInterrupts).
 * @param taskRunning - Whether a task is currently in-flight.
 * @returns The action to take.
 */
export function interpretInterrupt(
  count: number,
  taskRunning: boolean,
): 'cancel-task' | 'to-menu' | 'exit-app' | 'hint' {
  if (count >= 3) return 'exit-app';
  if (count === 2) return 'to-menu';
  if (count === 1) return taskRunning ? 'cancel-task' : 'hint';
  return 'hint';
}

// ---------------------------------------------------------------------------
// Internal readline helpers
// ---------------------------------------------------------------------------

/**
 * An event-driven line reader over a single readline interface.
 *
 * This is the proven-correct pattern (mirrors `repl.ts`): instead of a
 * per-prompt `rl.question()` — which (a) throws `ERR_USE_AFTER_CLOSE` if the
 * interface has already closed and (b) loses lines that `readline` eagerly
 * drains from a pipe before the first prompt is even written — we attach a
 * single `'line'` listener that buffers every line and a single `'close'`
 * listener that marks EOF.
 *
 * `nextLine()` returns the next buffered/awaited line, or `null` once the
 * stream is closed/EOF. It NEVER throws and returns `null` for every call after
 * close, so callers can treat `null` as a clean end-of-input sentinel.
 */
interface LineReader {
  /** Resolve with the next line, or `null` on EOF (and for every call after). */
  nextLine(): Promise<string | null>;
  /** Close the underlying readline interface (idempotent). */
  close(): void;
}

/**
 * Build a {@link LineReader} backed by a single `node:readline` interface.
 *
 * Lines that arrive before they are awaited are buffered (fixing the eager
 * pipe-drain line loss); awaiters that arrive before a line block on a queued
 * resolver. On `close`, every pending and future awaiter resolves to `null`.
 */
function createLineReader(rl: readline.Interface): LineReader {
  // Lines received but not yet consumed by a nextLine() caller.
  const buffered: string[] = [];
  // nextLine() callers waiting for a line that hasn't arrived yet.
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      buffered.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    // Drain every pending awaiter with the EOF sentinel.
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(null);
    }
  });

  return {
    nextLine(): Promise<string | null> {
      // Deliver any buffered line first (FIFO).
      if (buffered.length > 0) {
        const next = buffered.shift();
        return Promise.resolve(next ?? null);
      }
      // Once closed with nothing buffered, every call yields EOF — never throws.
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close(): void {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Welcome screen (first run)
// ---------------------------------------------------------------------------

async function runWelcome(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  mutableConfig: AppConfig,
  installProviderFn: (id: ProviderId, out: OutputSink) => Promise<boolean>,
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: { method?: LoginMethod; readLine?: () => Promise<string | null> },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
): Promise<AppConfig> {
  // Use the mutable env so re-detection after installs is visible downstream.
  let env = ctx.env;

  const headerLines = renderHeaderLines(env, ctx.version);
  out.write('\n' + box(`🧠 myshell-tools v${ctx.version} — Setup`, headerLines) + '\n\n');

  // ---- Offer to install any missing provider (claude / codex) --------------
  // Consent is required: we ask once per missing provider.
  // Display: (Y/n) — default YES, so Enter installs; explicit n skips.
  const providers: ProviderId[] = ['claude', 'codex'];
  let didInstallAny = false;

  for (const id of providers) {
    const ps = env[id];
    if (ps.installed) continue;

    const pkg = id === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
    out.write(`Install ${id} (${pkg})? (Y/n) `);
    const ans = await readLine();

    if (parseYesNo(ans, true)) {
      const ok = await installProviderFn(id, out);
      if (ok) {
        didInstallAny = true;
      }
    } else {
      out.write(`Skipping ${id} install. You can run it yourself: ${installCommandFor(id)}\n`);
    }
  }

  // ---- Re-detect if anything was installed so sign-in offers are accurate --
  if (didInstallAny) {
    env = await detectEnvironmentFn();
  }

  // ---- Offer opencode (optional, free models + more providers) -------------
  // opencode defaults to NO — it is optional and users may prefer claude/codex only.
  if (!env.opencode.installed) {
    out.write('Add opencode? (optional — free models + more providers) (y/N) ');
    const ans = await readLine();
    if (parseYesNo(ans, false)) {
      const ok = await installProviderFn('opencode', out);
      if (ok) {
        // Re-detect so downstream sign-in logic sees the freshly installed opencode.
        env = await detectEnvironmentFn();
      }
    }
    // No nag on skip — opencode is always discoverable via [o] in the main menu.
  }

  // ---- Offer sign-in for installed-but-unauthenticated providers -----------
  // opencode reports authenticated:true when installed (free models, no keys needed),
  // so it is never double-prompted here.
  for (const id of providers) {
    const ps = env[id];
    if (!ps.installed || ps.authenticated) continue;

    out.write(`\nSign in to ${id} now? (Y/n) `);
    const ans = await readLine();

    if (parseYesNo(ans, true)) {
      // loginFn auto-detects the right method (code in containers/SSH where the
      // localhost OAuth callback can't be reached, browser on a desktop).
      // Pass readLine so the claude token-paste prompt shares the menu's reader.
      await loginFn(out, id, { readLine });
    }
  }

  // ---- Mode / default-shell options ----------------------------------------
  out.write('\n');
  out.write('  [c]     Customize mode\n');
  out.write('  [Enter] Continue\n\n');
  out.write('> ');
  const key = await readLine();

  // EOF during setup — save bare onboarded config and return
  if (key === null) {
    const saved: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      ...(mutableConfig.mode !== undefined ? { mode: mutableConfig.mode } : {}),
    };
    await saveConfig(saved);
    return saved;
  }

  let updated = mutableConfig;

  if (key === 'c') {
    updated = await runModeSelect(updated, out, readLine);
  }
  // [Enter] or anything else → fall through to save & go

  // Default is NO for set-as-default — require explicit 'y' to enable.
  out.write('Set myshell-tools as your default shell tool? (y/N) ');
  const defaultAns = await readLine();

  const setAsDefault = parseYesNo(defaultAns, false);

  // Default is YES for auto-update (recommended; user can opt out with n or via Settings).
  out.write('Keep myshell-tools up to date automatically? (Y/n) ');
  const autoUpdateAns = await readLine();
  const autoUpdate = parseYesNo(autoUpdateAns, true);

  const saved: AppConfig = {
    onboarded: true,
    setAsDefault,
    ...(updated.mode !== undefined ? { mode: updated.mode } : {}),
    ...(!autoUpdate ? { autoUpdate: false } : {}),
  };

  await saveConfig(saved);

  // When the user opts in, actually write the shell startup hook (real install,
  // not just a hint). runInstall reports what it wrote and how to reverse.
  if (setAsDefault) {
    await runInstall(out);
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

async function runModeSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<AppConfig> {
  const currentMode = config.mode ?? 'balanced';
  const settingsLines = [
    '',
    'Mode:',
    `  [1] cost-saver${currentMode === 'cost-saver' ? ' (active)' : ''}`,
    `  [2] balanced${currentMode === 'balanced' ? ' (active)' : ''}`,
    `  [3] quality-first${currentMode === 'quality-first' ? ' (active)' : ''}`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('[1/2/3 to change, Enter to keep] ');
  const key = await readLine();

  // EOF → keep current mode
  let newMode = config.mode;
  if (key === '1') newMode = 'cost-saver';
  else if (key === '2') newMode = 'balanced';
  else if (key === '3') newMode = 'quality-first';

  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(newMode !== undefined ? { mode: newMode } : {}),
  };

  await saveConfig(updated);
  out.write(`Mode set to: ${newMode ?? 'balanced'}\n`);
  return updated;
}

/**
 * Toggle the "set as default shell" preference and actually install/uninstall
 * the shell startup hook to match. The config flag is only flipped when the
 * hook write succeeds, so the stored value never lies about the real state.
 */
async function toggleDefaultShell(
  config: AppConfig,
  out: OutputSink,
): Promise<AppConfig> {
  const enable = !config.setAsDefault;
  // runInstall reports exactly what it wrote (or removed) and how to reverse.
  const code = await runInstall(out, enable ? undefined : { uninstall: true });

  // Only adopt the new state if the hook write succeeded; otherwise keep the old.
  const setAsDefault = code === 0 ? enable : config.setAsDefault;

  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
  };
  await saveConfig(updated);
  return updated;
}

async function runSettings(
  _ctx: MenuContext,
  mutableCtx: { config: AppConfig },
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<void> {
  const cfg = mutableCtx.config;
  const settingsLines = [
    '',
    `  [1] Mode: ${cfg.mode ?? 'balanced'}`,
    `  [2] Set as default shell: ${cfg.setAsDefault ? 'on' : 'off'}`,
    `  [3] Auto-update: ${cfg.autoUpdate !== false ? 'on' : 'off'}`,
    '',
    '  [Enter] Back',
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('> ');
  const key = await readLine();

  // EOF or Enter → back, no change
  if (key === null || key.length === 0) return;

  if (key === '1') {
    mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine);
  } else if (key === '2') {
    mutableCtx.config = await toggleDefaultShell(mutableCtx.config, out);
  } else if (key === '3') {
    mutableCtx.config = await toggleAutoUpdate(mutableCtx.config, out);
  }
  // anything else → back
}

/**
 * Toggle the auto-update preference and persist the updated config.
 * Reports the new state so the user knows what changed.
 *
 * Since auto-update now defaults to ON (undefined → enabled), toggling when
 * currently enabled (true or undefined) sets it explicitly to false; toggling
 * when currently disabled (false) removes the explicit flag (restores default-on).
 */
async function toggleAutoUpdate(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  // Currently enabled when autoUpdate !== false (undefined counts as on)
  const currentlyEnabled = config.autoUpdate !== false;
  const enable = !currentlyEnabled;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(!enable ? { autoUpdate: false } : {}),
  };
  await saveConfig(updated);
  out.write(`Auto-update: ${enable ? 'on' : 'off'}\n`);
  return updated;
}

// ---------------------------------------------------------------------------
// Manage conversations screen
// ---------------------------------------------------------------------------

async function runManage(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<void> {
  // Inner helper to re-fetch and re-render the conversation list.
  async function renderList(): Promise<ConversationMeta[]> {
    const latest = await ctx.store.list();
    const nowMs = ctx.clock.now();
    const lines = renderConversationList(latest, nowMs);
    out.write('\n' + separator('Conversations') + '\n');
    for (const line of lines) {
      out.write(`  ${line}\n`);
    }
    out.write('\n  [p] Pin/unpin  [t] Set category  [r] Rename  [x] Delete  [Enter] Back\n\n');
    return latest;
  }

  let metas = await ctx.store.list();

  if (metas.length === 0) {
    out.write('No conversations yet.\n');
    out.write('[Enter to go back] ');
    await readLine();
    return;
  }

  metas = await renderList();

  out.write('> ');
  const key = await readLine();

  // EOF → treat as back
  if (key === null) return;

  if (key === 'p') {
    out.write('Pin/unpin conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        const newPinned = !conv.pinned;
        await ctx.store.setPinned(conv.id, newPinned);
        out.write(newPinned ? `📌 Pinned "${conv.title}"\n` : `Unpinned "${conv.title}"\n`);
        await renderList();
      }
    }
  } else if (key === 't') {
    out.write('Set category for conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        out.write(`Category tag for "${conv.title}" (empty to clear): `);
        const tag = await readLine() ?? '';
        await ctx.store.setCategory(conv.id, tag.length > 0 ? tag : null);
        out.write(tag.length > 0 ? `Category set to "${tag}"\n` : 'Category cleared.\n');
        await renderList();
      }
    }
  } else if (key === 'r') {
    out.write('Rename conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        out.write(`New name for "${conv.title}": `);
        const newTitle = await readLine() ?? '';
        if (newTitle.length > 0) {
          await ctx.store.rename(conv.id, newTitle);
          out.write(`Renamed to "${newTitle}"\n`);
          await renderList();
        }
      }
    }
  } else if (key === 'x') {
    out.write('Delete conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        out.write(`Delete "${conv.title}"? (y/n) `);
        const confirmAns = await readLine();
        if ((confirmAns ?? '').toLowerCase() === 'y') {
          await ctx.store.remove(conv.id);
          out.write('Deleted.\n');
        }
      }
    }
  }
  // else: back
}

// ---------------------------------------------------------------------------
// Import a native conversation
// ---------------------------------------------------------------------------

/**
 * Ask the user which provider to import from, list its native sessions, let the
 * user pick one, then import it into a new myshell-tools conversation and enter
 * the chat loop for that conversation.
 *
 * Follows the injected `readLine` seam so it is fully testable without TTY.
 * Never modifies the native CLI's files.
 */
async function runImportNative(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  out: OutputSink,
  readLine: () => Promise<string | null>,
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: { method?: LoginMethod; readLine?: () => Promise<string | null> },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
): Promise<'menu' | 'exit'> {
  out.write('\nImport from:\n  [1] Claude\n  [2] Codex\n\n> ');
  const choice = await readLine();
  if (choice === null) return 'menu';

  let provider: ProviderId;
  if (choice === '1') {
    provider = 'claude';
  } else if (choice === '2') {
    provider = 'codex';
  } else {
    out.write('Cancelled.\n');
    return 'menu';
  }

  const sessions = await listNativeSessions(provider);

  if (sessions.length === 0) {
    out.write(`No ${provider} conversations found.\n`);
    return 'menu';
  }

  // Render a numbered picker
  const nowMs = ctx.clock.now();
  out.write('\n' + separator(`${provider} conversations`) + '\n');
  for (let idx = 0; idx < sessions.length; idx++) {
    const s = sessions[idx];
    if (s === undefined) continue;
    const thenMs = new Date(s.updatedAt).getTime();
    const rel = relativeTime(thenMs, nowMs);
    const titleDisplay = s.title.length > 0 ? s.title : '(untitled)';
    out.write(`  [${idx + 1}] ${rel}  ${titleDisplay}  (${s.messageCount} msgs)\n`);
  }
  out.write('\nPick a conversation number (or Enter to cancel): ');

  const pick = await readLine();
  if (pick === null || pick.length === 0) return 'menu';

  const num = parseInt(pick, 10);
  if (Number.isNaN(num) || num < 1 || num > sessions.length) {
    out.write('Invalid selection.\n');
    return 'menu';
  }

  const session = sessions[num - 1];
  if (session === undefined) return 'menu';

  const { id, imported } = await importNativeSession(session, ctx.store);
  const convTitle = session.title.length > 0 ? session.title : '(untitled)';
  out.write(`Imported ${imported} messages into a new conversation: "${convTitle}"\n`);

  // Enter the chat loop for the newly imported conversation.
  // Return value propagates the 'exit' signal to the caller (startMenu).
  return runChatLoop(ctx, mutableCtx, id, out, readLine, loginFn, detectEnvironmentFn);
}

// ---------------------------------------------------------------------------
// Raw provider passthrough
// ---------------------------------------------------------------------------

/**
 * Decide whether a raw-session SIGINT count warrants escaping back to the menu.
 *
 * Returns true when count >= 2 (rapid double Ctrl+C), false otherwise.
 * A single press (count === 1) is left entirely to the child process — the
 * terminal already delivers SIGINT to the whole foreground process group, so
 * claude/codex/opencode handles its own cancel without interference from us.
 *
 * Pure — no I/O, no side effects, never throws.
 *
 * @param count - Number of recent Ctrl+C presses (from countRecentInterrupts).
 * @returns True when the user should be returned to the myshell-tools menu.
 */
export function shouldEscapeRawSession(count: number): boolean {
  return count >= 2;
}

/**
 * Launch the native `claude`, `codex`, or `opencode` interactive CLI directly
 * (stdio:inherit), so the user gets a raw provider session. The session is owned
 * by the native CLI (not by myshell-tools); we simply hand over the terminal and wait.
 *
 * On Unix, a best-effort "Ctrl+C twice → back to menu" escape is registered:
 *   - A single Ctrl+C is left entirely to the child (the terminal delivers SIGINT
 *     to the whole foreground group; we must NOT interfere with single presses).
 *   - Two presses within 1 500 ms → SIGTERM the child and return to the menu.
 * On Windows the SIGINT handler is NOT registered (process-group semantics differ
 * and forced interception risks a broken console) — behaviour is exactly as today.
 *
 * The SIGINT listener is always removed in a finally block so it never leaks back
 * to the menu loop. This is best-effort: forcibly terminating the child to return
 * to the menu may leave the terminal in a non-ideal state; the existing
 * "Returned from <bin>." message and menu re-render happen on return regardless.
 *
 * On exit (any exit code), control returns to the myshell-tools menu.
 */
async function runRawProviderSession(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  env: EnvironmentStatus,
): Promise<void> {
  // Build the choice list dynamically: opencode only when installed.
  const choices: Array<{ label: string; bin: string }> = [
    { label: 'Claude', bin: 'claude' },
    { label: 'Codex', bin: 'codex' },
  ];
  if (env.opencode.installed) {
    choices.push({ label: 'opencode', bin: 'opencode' });
  }

  const choiceLines = choices.map((c, i) => `  [${i + 1}] ${c.label}`).join('\n');
  out.write(`\nOpen raw session with:\n${choiceLines}\n\n> `);
  const choice = await readLine();
  if (choice === null) return;

  const idx = parseInt(choice, 10) - 1;
  const selected = choices[idx];
  if (selected === undefined) {
    out.write('Cancelled.\n');
    return;
  }

  const bin = selected.bin;
  out.write(`\nLaunching ${bin} — press Ctrl+C or type /exit inside ${bin} to return.\n`);

  // Best-effort escape hint (Unix only — on Windows we skip the handler).
  if (process.platform !== 'win32') {
    out.write('(Ctrl+C twice quickly → back to the myshell menu)\n');
  }

  // stdio:'inherit' hands the terminal to the native CLI so its interactive
  // session runs in place. reject:false so we return to menu on any exit code.
  const subprocess = execa(bin, [], { stdio: 'inherit', reject: false });

  // Unix-only: register the rapid-double-Ctrl+C escape handler.
  // On Windows: skip entirely — SIGINT/process-group semantics differ and
  // forced interception risks a broken console. Behaviour is as before today.
  if (process.platform !== 'win32') {
    const INTERRUPT_WINDOW_MS = 1_500;
    const interruptTimes: number[] = [];

    const rawSigintHandler = (): void => {
      const now = Date.now();
      interruptTimes.push(now);
      const count = countRecentInterrupts(interruptTimes, now, INTERRUPT_WINDOW_MS);

      // count === 1: do nothing — let the single Ctrl+C reach the child via the
      // terminal's foreground-group delivery. Do NOT kill or write anything here.
      if (shouldEscapeRawSession(count)) {
        // Rapid double press → user wants to return to the menu.
        out.write('\n[info] Returning to menu…\n');
        subprocess.kill('SIGTERM');
      }
    };

    process.on('SIGINT', rawSigintHandler);
    try {
      await subprocess;
    } finally {
      process.removeListener('SIGINT', rawSigintHandler);
    }
  } else {
    // Windows: no SIGINT handler — await the child normally.
    await subprocess;
  }

  out.write(`\nReturned from ${bin}.\n`);
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

/**
 * Run the interactive chat loop for a single conversation.
 *
 * Returns `'menu'` when the user exits normally (/back, /exit, EOF, or 2×Ctrl+C)
 * and `'exit'` when the user presses Ctrl+C three times within the 1 500 ms window,
 * signalling that the entire app should quit.
 *
 * The SIGINT handler uses a press-counting model (window ~1 500 ms, timestamps from
 * `ctx.clock.now()`):
 *   1 press while a task runs  → cancel the task, stay in chat.
 *   1 press at the prompt      → print a hint, stay in chat.
 *   2 presses within the window → abort any running task, break to menu.
 *   3 presses within the window → abort any running task, break and signal exit.
 *
 * The handler is registered on entry and removed in the `finally` block so it
 * never leaks between chat sessions. NO process.exit() is called here; cli.ts
 * owns process lifetime.
 */
async function runChatLoop(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  convId: string,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: { method?: LoginMethod; readLine?: () => Promise<string | null> },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
): Promise<'menu' | 'exit'> {
  // Print a short recap of the conversation (last entry) if history exists
  const history = await ctx.store.load(convId);
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last !== undefined) {
      out.write(
        `\n  Resuming — last message (${last.role}): ${last.content.slice(0, 80)}${last.content.length > 80 ? '…' : ''}\n\n`,
      );
    }
  }

  out.write(prompt('task or /help', out.color) + '\n');

  let currentAc: AbortController | null = null;

  // Interrupt timestamps — populated on each SIGINT; checked against the
  // 1 500 ms sliding window. Using ctx.clock.now() (not Date.now) so tests
  // can drive time with a fake clock.
  const interruptTimes: number[] = [];
  const INTERRUPT_WINDOW_MS = 1_500;

  // The 'exit' and 'menu' signals are communicated from the SIGINT handler to
  // the main loop via these flags (the handler can't break the outer while directly).
  let shouldExit = false;
  let shouldMenu = false;

  // Handle Ctrl+C with the press-counting model.
  const sigintHandler = (): void => {
    const now = ctx.clock.now();
    interruptTimes.push(now);
    const count = countRecentInterrupts(interruptTimes, now, INTERRUPT_WINDOW_MS);
    const action = interpretInterrupt(count, currentAc !== null);

    if (action === 'cancel-task') {
      currentAc?.abort();
      currentAc = null;
      out.write('\n[warn] Task cancelled. (Ctrl+C again → menu, ×3 → exit)\n');
    } else if (action === 'hint') {
      out.write('\n[info] Ctrl+C again → back to menu, ×3 → exit to shell.\n');
    } else if (action === 'to-menu') {
      // Abort any running task, then tell the main loop to break back to menu.
      if (currentAc !== null) {
        currentAc.abort();
        currentAc = null;
      }
      // Set shouldMenu so the loop returns 'menu' after any running task settles.
      shouldMenu = true;
      // For the readLine case (idle prompt) we can interrupt the await immediately
      // via the loopBreaker resolver.
      loopBreaker?.('menu');
    } else {
      // exit-app
      if (currentAc !== null) {
        currentAc.abort();
        currentAc = null;
      }
      shouldExit = true;
      loopBreaker?.('exit');
    }
  };

  // loopBreaker lets the SIGINT handler resolve the loop-level promise so the
  // `while (true)` can break immediately even when awaiting readLine().
  let loopBreaker: ((result: 'menu' | 'exit') => void) | null = null;

  process.on('SIGINT', sigintHandler);

  let loopResult: 'menu' | 'exit' = 'menu';

  try {
    while (true) {
      out.write('> ');

      // Race readLine() against a loopBreak signal from the SIGINT handler.
      // When Ctrl+C fires (to-menu or exit-app), loopBreaker is called with the
      // desired result, which wins the race and breaks the loop.
      const line = await new Promise<string | null | 'menu' | 'exit'>((resolve) => {
        loopBreaker = resolve;
        readLine().then(resolve).catch(() => resolve(null));
      });
      loopBreaker = null;

      // SIGINT-driven exit signals
      if (line === 'menu') {
        loopResult = 'menu';
        break;
      }
      if (line === 'exit') {
        loopResult = 'exit';
        break;
      }

      // EOF → exit the chat loop gracefully
      if (line === null) break;

      if (line.length === 0) continue;

      if (line === '/exit' || line === '/back') {
        break;
      }

      if (line === '/help') {
        out.write(
          '  /back or /exit — return to main menu\n' +
          '  /help          — show this help\n' +
          '  <anything>     — run as a task in this conversation\n',
        );
        continue;
      }

      const policy =
        mutableCtx.config.mode !== undefined
          ? POLICY_PRESETS[mutableCtx.config.mode]
          : DEFAULT_POLICY;

      // ---- Bug 4 fix: no-provider gate ----------------------------------------
      // Check whether any provider is actually authenticated before dispatching a
      // task that is doomed to fail.  opencode counts as authenticated-when-installed.
      const hasAuthenticatedProvider =
        mutableCtx.env.claude.authenticated ||
        mutableCtx.env.codex.authenticated ||
        mutableCtx.env.opencode.authenticated ||
        mutableCtx.env.opencode.installed;

      if (!hasAuthenticatedProvider) {
        out.write(
          '\n[info] No signed-in provider yet — press Ctrl+C to go back, then [j] Claude / [k] Codex / [o] opencode to sign in.\n',
        );
        continue;
      }

      // Load prior history before each turn so the provider receives conversation
      // context. load() returns only the entries persisted so far — the current
      // user turn is appended by orchestrate() after this point, so there is no
      // double-inclusion risk.
      const priorHistory = await ctx.store.load(convId);

      // ---- Build deps from the live mutableCtx.env ----------------------------
      // This helper is inlined as a function so it can be called again after
      // inline re-login with the refreshed env (bug 5 fix: no stale auth state).
      const buildDeps = (): OrchestrateDeps => {
        // Build per-provider advertised model sets from the live env so route()
        // can prefer a model the CLI actually advertises. Only include installed
        // providers (exactOptionalPropertyTypes is ON).
        // Use mutableCtx.env (not ctx.env) so post-login re-detect is reflected.
        const availableModels: Partial<Record<ProviderId, readonly string[]>> = {};
        if (mutableCtx.env.claude.installed && mutableCtx.env.claude.availableModels.length > 0) {
          availableModels['claude'] = mutableCtx.env.claude.availableModels;
        }
        if (mutableCtx.env.codex.installed && mutableCtx.env.codex.availableModels.length > 0) {
          availableModels['codex'] = mutableCtx.env.codex.availableModels;
        }
        if (mutableCtx.env.opencode.installed && mutableCtx.env.opencode.availableModels.length > 0) {
          availableModels['opencode'] = mutableCtx.env.opencode.availableModels;
        }

        // Collect authenticated providers from the live env so route() prefers
        // signed-in providers over signed-out ones. Uses mutableCtx.env so
        // post-login re-detection is reflected without restart.
        const authenticatedProviders: ProviderId[] = [];
        if (mutableCtx.env.claude.authenticated) authenticatedProviders.push('claude');
        if (mutableCtx.env.codex.authenticated) authenticatedProviders.push('codex');
        if (mutableCtx.env.opencode.authenticated) authenticatedProviders.push('opencode');

        return {
          clock: ctx.clock,
          session: ctx.store.writer(convId),
          ledger: ctx.ledger,
          policy,
          providers: ctx.providers,
          cwd: ctx.cwd,
          sandbox: ctx.sandbox,
          timeoutMs: ctx.timeoutMs,
          ...(priorHistory.length > 0 ? { history: priorHistory } : {}),
          ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
          ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
        };
      };

      const deps = buildDeps();

      const ac = new AbortController();
      currentAc = ac;
      const result = await runTask(line, deps, out, ac.signal);
      currentAc = null;

      // Check for SIGINT-driven signals that fired while runTask was awaited.
      if (shouldExit) {
        loopResult = 'exit';
        break;
      }
      // Bug 3 fix: shouldMenu may have been set by a 2×Ctrl+C during the task.
      if (shouldMenu) {
        loopResult = 'menu';
        break;
      }

      // Inline re-login on auth failure: offer to sign in and retry once.
      if (
        result.final !== undefined &&
        !result.final.success &&
        result.final.errorCategory === 'auth' &&
        result.final.provider !== undefined
      ) {
        const failingProvider = result.final.provider;
        out.write(`\n[warn] ${failingProvider} isn't signed in.\n`);
        out.write(`Sign in to ${failingProvider} now and retry? (Y/n) `);
        const ans = await readLine();
        if (parseYesNo(ans, true)) {
          await loginFn(out, failingProvider, { readLine });
          // Bug 5 fix: re-detect with the freshly-authenticated env so the retry
          // deps reflect the now-signed-in provider (not the stale pre-login state).
          mutableCtx.env = await detectEnvironmentFn();
          const retryDeps = buildDeps();
          // Retry the same task once.
          const retryAc = new AbortController();
          currentAc = retryAc;
          const retryResult = await runTask(line, retryDeps, out, retryAc.signal);
          currentAc = null;
          if (shouldExit) {
            loopResult = 'exit';
            break;
          }
          if (shouldMenu) {
            loopResult = 'menu';
            break;
          }
          // If still auth failure after retry, inform and continue to prompt.
          if (
            retryResult.final !== undefined &&
            !retryResult.final.success &&
            retryResult.final.errorCategory === 'auth'
          ) {
            out.write(`\n[warn] Still not signed in to ${failingProvider}. Returning to prompt.\n`);
          }
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    loopBreaker = null;
  }

  return loopResult;
}

// ---------------------------------------------------------------------------
// Main screen render
// ---------------------------------------------------------------------------

async function renderMainScreen(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  metas: ConversationMeta[],
  out: OutputSink,
  updateInfo?: UpdateCheckResult,
): Promise<void> {
  out.write('\n');

  // Header box — always box(), 🧠 emoji, real provider data
  const headerLines = renderHeaderLines(mutableCtx.env, ctx.version);
  out.write(box(`🧠 myshell-tools v${ctx.version}`, headerLines) + '\n\n');

  // Update banner — only shown when a newer version is genuinely available
  if (updateInfo?.updateAvailable === true && updateInfo.latest !== null) {
    out.write(
      `  ▲ Update available: ${updateInfo.current} → ${updateInfo.latest}  (press u)\n\n`,
    );
  }

  // Budget line — real ledger data, never fabricated
  const entries = await readLedger(ctx.cwd);
  const spend = summarizeSpend(entries, ctx.clock.isoNow());
  out.write('  ' + renderBudgetLine(spend, out.color) + '\n\n');

  // Recent conversations — separator() then list
  out.write(separator('Recent Conversations') + '\n');
  const nowMs = ctx.clock.now();
  const convLines = renderConversationList(metas, nowMs);
  if (convLines.length === 0) {
    out.write('  (no conversations yet — press n to start one)\n');
  } else {
    for (const line of convLines) {
      out.write(`  ${line}\n`);
    }
  }
  out.write('\n');

  // Auth section — always include the opencode [o] entry so users can discover
  // and connect opencode even before it is installed. Label parallels the other
  // two providers; when opencode isn't installed yet, the handler offers to
  // install it (with consent) before signing in.
  const opencodeLabel = mutableCtx.env.opencode.installed
    ? 'Login opencode'
    : 'Login opencode (installs it first)';
  const authEntries: Array<{ key: string; label: string; section: string }> = [
    { key: 'j', label: 'Login Claude', section: 'Auth' },
    { key: 'k', label: 'Login Codex', section: 'Auth' },
    { key: 'o', label: opencodeLabel, section: 'Auth' },
  ];

  // [u] Update now — shown only when a newer version is actually available
  const updateEntry =
    updateInfo?.updateAvailable === true && updateInfo.latest !== null
      ? [{ key: 'u', label: `Update now (→ ${updateInfo.latest})`, section: 'Options' }]
      : [];

  // Menu — sectioned via menu()
  out.write(
    menu([
      { key: 'c', label: 'Continue last conversation', section: 'Conversations' },
      { key: 'n', label: 'New conversation', section: 'Conversations' },
      { key: '1-9', label: 'Resume numbered conversation', section: 'Conversations' },
      { key: 'e', label: 'Manage conversations', section: 'Conversations' },
      { key: 'i', label: 'Import a conversation', section: 'Conversations' },
      { key: 'r', label: 'Open a raw provider session', section: 'Conversations' },
      ...authEntries,
      { key: 's', label: 'Settings', section: 'Options' },
      { key: 'd', label: 'Doctor', section: 'Options' },
      { key: '$', label: 'Cost', section: 'Options' },
      ...updateEntry,
      { key: 'q', label: 'Quit', section: 'Options' },
    ]) + '\n\n',
  );
}

// ---------------------------------------------------------------------------
// startMenu — public entry point
// ---------------------------------------------------------------------------

/**
 * Start the sessions-first interactive menu.
 *
 * Follows the dual-brain UX design bible:
 *   A. First run: welcome / 10-second setup → mark onboarded.
 *   B. Main screen loop: header + recent conversations + sectioned menu.
 *   C. Per-conversation chat loop backed by runTask().
 *
 * Never calls process.exit() — resolves when the user presses [q] or when
 * stdin reaches EOF (resolves cleanly, no ERR_USE_AFTER_CLOSE thrown).
 *
 * When `ctx.readLine` is provided (e.g. in tests), it is used directly in
 * place of a real readline interface. When absent, a readline interface is
 * created from `process.stdin` as usual; the `close` event is wired up so
 * that EOF resolves gracefully instead of throwing.
 */
export async function startMenu(ctx: MenuContext, out: OutputSink): Promise<void> {
  // Resolve injected seams — use the real implementations when not provided.
  const installProviderFn = ctx.installProvider !== undefined ? ctx.installProvider : installProvider;
  const loginFn = ctx.login !== undefined ? ctx.login : runLogin;
  const detectEnvironmentFn = ctx.detectEnvironment !== undefined ? ctx.detectEnvironment : detectEnvironment;
  const checkForUpdateFn = ctx.checkForUpdate;
  const updateSelfFn = ctx.updateSelf;
  const relaunchFn = ctx.relaunch;

  // Build the readLine function — either injected (for tests) or backed by a
  // real readline interface driven by the event-driven LineReader queue.
  let readLine: () => Promise<string | null>;
  let lineReader: LineReader | null = null;

  if (ctx.readLine !== undefined) {
    // Injected reader — no real readline needed.
    readLine = ctx.readLine;
  } else {
    // Create ONE readline interface for the whole menu lifecycle and drive it
    // through the event-driven queue (NOT per-prompt rl.question). This buffers
    // lines that arrive before they're awaited (fixing pipe eager-drain loss)
    // and resolves to `null` on EOF instead of throwing ERR_USE_AFTER_CLOSE.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: out.isTty,
    });
    lineReader = createLineReader(rl);
    const reader = lineReader;
    // All prompt text is already written to `out` before readLine() is called.
    readLine = () => reader.nextLine();
  }

  // Mutable local copy of config & env — updated as the user changes settings /
  // re-authenticates without mutating the immutable ctx parameter.
  const mutableCtx: { config: AppConfig; env: EnvironmentStatus } = {
    config: ctx.config,
    env: ctx.env,
  };

  try {
    // ---- A. First-run welcome -----------------------------------------------
    if (!mutableCtx.config.onboarded) {
      mutableCtx.config = await runWelcome(ctx, out, readLine, mutableCtx.config, installProviderFn, loginFn, detectEnvironmentFn);
      // Re-detect after onboarding so the first main screen shows the REAL post-login
      // status (e.g. codex now "ready" if the user signed in during setup).
      mutableCtx.env = await detectEnvironmentFn();
    }

    // ---- Update check (once per launch, after onboarding) --------------------
    // Fast path: uses the cache when fresh, so it never hangs.
    // Injected seam allows tests to stay hermetic (no real npm registry calls).
    let updateInfo: UpdateCheckResult | undefined;
    if (checkForUpdateFn !== undefined) {
      updateInfo = await checkForUpdateFn().catch(() => undefined);
    }

    // ---- Auto-update at launch (default ON) ----------------------------------
    // Guard: only runs once; requires both the update and relaunch seams to be wired.
    // Disabled when MYSHELL_NO_UPDATE is set in the environment or autoUpdate===false.
    if (
      autoUpdateEnabled(mutableCtx.config, process.env) &&
      updateInfo?.updateAvailable === true &&
      updateInfo.latest !== null &&
      updateSelfFn !== undefined
    ) {
      out.write(
        `▲ Auto-updating ${updateInfo.current} → ${updateInfo.latest}…` +
        `  (disable: Settings → Auto-update, or MYSHELL_NO_UPDATE=1)\n`,
      );
      const ok = await updateSelfFn(out).catch(() => false);
      if (ok) {
        if (relaunchFn !== undefined) {
          await relaunchFn().catch(() => 1);
        }
        return; // Relinquish control to the freshly-installed version.
      }
      out.write('Auto-update failed — continuing with current version.\n');
    }

    // ---- B. Main screen loop -------------------------------------------------
    while (true) {
      const metas = await ctx.store.list();
      await renderMainScreen(ctx, mutableCtx, metas, out, updateInfo);

      out.write('> ');
      const key = await readLine();

      // ---- EOF / close — exit gracefully (FIX 1: no ERR_USE_AFTER_CLOSE) ----
      if (key === null) {
        break;
      }

      // ---- [q] Quit -----------------------------------------------------------
      if (key === 'q') {
        break;
      }

      // ---- [n] New conversation -----------------------------------------------
      if (key === 'n') {
        out.write('First message (becomes the title): ');
        const firstMsg = await readLine();
        if (firstMsg !== null && firstMsg.length > 0) {
          const meta = await ctx.store.create(firstMsg);
          const chatResult = await runChatLoop(ctx, mutableCtx, meta.id, out, readLine, loginFn, detectEnvironmentFn);
          if (chatResult === 'exit') break;
        }
        continue;
      }

      // ---- [c] Continue most-recent conversation ------------------------------
      if (key === 'c') {
        const all = await ctx.store.list();
        const latest = all[0];
        if (latest !== undefined) {
          const chatResult = await runChatLoop(ctx, mutableCtx, latest.id, out, readLine, loginFn, detectEnvironmentFn);
          if (chatResult === 'exit') break;
        } else {
          out.write('No conversations yet. Press n to start one.\n');
        }
        continue;
      }

      // ---- [1-9] Resume numbered conversation ---------------------------------
      const digit = parseInt(key, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
        const target = metas[digit - 1];
        if (target !== undefined) {
          const chatResult = await runChatLoop(ctx, mutableCtx, target.id, out, readLine, loginFn, detectEnvironmentFn);
          if (chatResult === 'exit') break;
        } else {
          out.write(`No conversation at position ${digit}.\n`);
        }
        continue;
      }

      // ---- [e] Manage conversations -------------------------------------------
      if (key === 'e') {
        await runManage(ctx, out, readLine);
        continue;
      }

      // ---- [i] Import a native conversation -----------------------------------
      if (key === 'i') {
        const importResult = await runImportNative(ctx, mutableCtx, out, readLine, loginFn, detectEnvironmentFn);
        if (importResult === 'exit') break;
        continue;
      }

      // ---- [r] Open a raw provider session ------------------------------------
      if (key === 'r') {
        await runRawProviderSession(out, readLine, mutableCtx.env);
        continue;
      }

      // ---- [j] Login Claude ---------------------------------------------------
      // loginFn auto-detects the right sign-in method (code in containers/SSH,
      // browser on a desktop). Force either with `myshell-tools login claude --code|--browser`.
      // Pass readLine so the token-paste prompt shares the menu's single reader
      // (avoids creating a second readline interface that would double-consume stdin).
      if (key === 'j') {
        await loginFn(out, 'claude', { readLine });
        mutableCtx.env = await detectEnvironmentFn();
        continue;
      }

      // ---- [k] Login Codex ----------------------------------------------------
      if (key === 'k') {
        await loginFn(out, 'codex');
        mutableCtx.env = await detectEnvironmentFn();
        continue;
      }

      // ---- [o] Connect / Login opencode ---------------------------------------
      // Always handles the key. When opencode is not yet installed, asks for
      // consent then installs it (using the injected installProviderFn seam so
      // tests stay hermetic). If install succeeds, proceeds to sign in.
      if (key === 'o') {
        if (!mutableCtx.env.opencode.installed) {
          out.write(`Install opencode (${installCommandFor('opencode').replace('npm install -g ', '')})? [Enter] yes · [n] no\n`);
          out.write('> ');
          const ans = await readLine();
          const skip = ans === null || ans.toLowerCase() === 'n' || ans.toLowerCase() === 'no';
          if (skip) {
            out.write(`[2mSkipped. You can install it later: ${installCommandFor('opencode')}[0m\n`);
            continue;
          }
          const ok = await installProviderFn('opencode', out);
          mutableCtx.env = await detectEnvironmentFn();
          if (!ok || !mutableCtx.env.opencode.installed) {
            out.write(`Install failed. Run it yourself: ${installCommandFor('opencode')}\n`);
            continue;
          }
        }
        // opencode is (now) installed — proceed to sign in
        await loginFn(out, 'opencode');
        mutableCtx.env = await detectEnvironmentFn();
        continue;
      }

      // ---- [u] Update now -----------------------------------------------------
      // Only active when an update is actually available and the seam is wired.
      if (key === 'u' && updateInfo?.updateAvailable === true && updateSelfFn !== undefined) {
        const ok = await updateSelfFn(out).catch(() => false);
        if (ok && updateInfo.latest !== null) {
          out.write(`✓ Updated to ${updateInfo.latest} — restart myshell-tools to use it.\n`);
        } else if (!ok) {
          out.write('Update failed. Run: npm install -g myshell-tools@latest\n');
        }
        continue;
      }

      // ---- [s] Settings -------------------------------------------------------
      if (key === 's') {
        await runSettings(ctx, mutableCtx, out, readLine);
        continue;
      }

      // ---- [d] Doctor ---------------------------------------------------------
      if (key === 'd') {
        await runDoctor(out);
        continue;
      }

      // ---- [$] Cost -----------------------------------------------------------
      if (key === '$') {
        await runCost(ctx.cwd, out);
        continue;
      }

      // ---- Unknown key --------------------------------------------------------
      if (key.length > 0) {
        out.write(`Unknown option: "${key}". Press q to quit.\n`);
      }
    }
  } finally {
    lineReader?.close();
  }
}
