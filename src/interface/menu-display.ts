/**
 * src/interface/menu-display.ts
 *
 * Extracted from menu.ts — behavior-preserving.
 *
 * Pure rendering + classification helpers for the interactive menu: header /
 * budget / conversation-list rendering, version + alias hints, and the pure
 * keypress/interrupt classification helpers. All take injected inputs and do no
 * I/O of their own.
 */

import type { UpdateCheckResult } from '../infra/update-check.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { getInstallCommand } from '../providers/detect.js';
import type { SpendSummary } from '../infra/insights.js';
import { formatTokens } from '../infra/insights.js';
import type { ConversationMeta } from '../infra/conversation-store.js';
import { dim } from '../ui/theme.js';
import { claudeTokenStatus } from '../infra/credentials.js';

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
 * Build the short version-status suffix shown next to the version number in the
 * header title — so the user always knows, at a glance, whether they are current.
 *
 * Pure — no I/O. Returns a leading-space string ready to append to the title:
 *   - update available + known latest → ` → 3.1.0 available`
 *   - up to date (latest known, no update) → ` (latest)`
 *   - check failed / offline (latest unknown) → `` (claim nothing)
 *
 * @param updateInfo - Result of the update check, or undefined when not run.
 */
export function versionStatusLabel(updateInfo?: UpdateCheckResult): string {
  if (updateInfo === undefined) return '';
  if (updateInfo.updateAvailable && updateInfo.latest !== null) {
    return ` → ${updateInfo.latest} available`;
  }
  if (updateInfo.latest !== null) return ' (latest)';
  return '';
}

/**
 * Detect whether myshell-tools is running via `npx` rather than a global install.
 *
 * Pure — takes the running script path (process.argv[1]) and the environment.
 * npx executes packages from a cache directory containing a `_npx` segment
 * (e.g. ~/.npm/_npx/<hash>/node_modules/myshell-tools/dist/cli.js), so the
 * presence of that segment in the script path is the reliable signal. Handles
 * both POSIX and Windows separators. Never throws.
 *
 * Why it matters: self-update runs `npm install -g`, which an npx invocation
 * will ignore on the next run (npx re-serves its own cache). So under npx we
 * skip silent auto-update and instead tell the user to install globally.
 *
 * @param scriptPath - The running script path (typically process.argv[1]).
 * @param env        - Environment to read npm_* hints from.
 */
export function isRunningUnderNpx(
  scriptPath: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (scriptPath !== undefined && (scriptPath.includes('/_npx/') || scriptPath.includes('\\_npx\\'))) {
    return true;
  }
  const execpath = env['npm_execpath'];
  if (execpath !== undefined && (execpath.includes('/_npx/') || execpath.includes('\\_npx\\'))) {
    return true;
  }
  return false;
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
 *
 * @param claudeToken - Optional pre-computed token lifetime status. When the token
 *   is near expiry or expired, ONE concise warning line is appended. Computed by
 *   the caller (startMenu) so this function stays pure and I/O-free.
 */
/**
 * True when AT LEAST ONE provider (claude / codex / opencode) is signed in.
 *
 * Pure — reads only the per-provider `authenticated` flags from EnvironmentStatus
 * (the same real fields the header box renders). Used to decide whether the menu
 * shows the "you must sign in" call-to-action: a brand-new user with no signed-in
 * provider needs a clear next step, but once any provider is authed the CTA is
 * silenced.
 */
export function hasAnyAuthenticatedProvider(env: EnvironmentStatus): boolean {
  return env.claude.authenticated || env.codex.authenticated || env.opencode.authenticated;
}

export function renderHeaderLines(
  env: EnvironmentStatus,
  _version: string,
  claudeToken?: ReturnType<typeof claudeTokenStatus>,
): string[] {
  const lines: string[] = [];

  for (const ps of [env.claude, env.codex]) {
    const planSuffix = ps.plan != null ? ` (${ps.plan})` : '';

    if (!ps.installed) {
      lines.push(`${ps.id}: not installed — ${getInstallCommand(ps.id)}`);
    } else if (ps.authenticated) {
      lines.push(`${ps.id}: ready${planSuffix}`);
    } else {
      lines.push(`${ps.id}: not signed in${planSuffix}`);
    }
  }

  // opencode: only show when installed (never nag users who only use claude/codex).
  // authenticated reflects a real credential probe (`opencode auth list`) — ready
  // only when the user has logged a provider/subscription in. Free models alone
  // are not "ready" (they can't do serious work), so an unconfigured opencode is
  // shown as not signed in, with a hint to add a provider.
  if (env.opencode.installed) {
    const ps = env.opencode;
    const planSuffix = ps.plan != null ? ` (${ps.plan})` : '';
    if (ps.authenticated) {
      lines.push(`${ps.id}: ready${planSuffix}`);
    } else {
      // Concise status only — the [o] action lives in the menu below, so repeating
      // it here is redundant (and overflowed the box).
      lines.push(`${ps.id}: not signed in${planSuffix}`);
    }
  }

  // Token expiry warning — only when near-expiry or expired (not on every launch).
  if (claudeToken != null && (claudeToken.expired || claudeToken.nearExpiry)) {
    if (claudeToken.expired) {
      lines.push(`claude token EXPIRED — run: myshell-tools login claude --code`);
    } else {
      lines.push(`claude token expires in ${claudeToken.daysLeft} days — run: myshell-tools login claude --code`);
    }
  }

  return lines;
}

/**
 * Render the activity status line shown beneath the provider header.
 *
 * This is a SUBSCRIPTION tool, not an API-key tool — per-token dollar figures
 * don't map to flat subscription billing and read as misleading bloat, so the
 * always-on line shows REAL, measured signals only: task count and tokens. The
 * estimated-dollar view lives on-demand in `myshell-tools cost`, clearly
 * captioned there as an API-equivalent (not your actual bill).
 *
 * Uses real numbers only — all values come from the SpendSummary derived from
 * `readLedger`. No digit-% literals appear here.
 *
 * @param spend - Output of summarizeSpend() over real ledger entries.
 * @param color - When false, no ANSI escape codes are emitted.
 */
export function renderBudgetLine(
  spend: SpendSummary,
  _color: boolean,
  authed = true,
  loading = false,
): string {
  // Transient first-paint placeholder: the unbounded ledger sum is computed
  // async AFTER the first frame, so the very first paint shows this instead of
  // blocking on disk. Replaced in place once the real summary resolves.
  if (loading) {
    return 'Loading usage…';
  }
  if (spend.calls === 0) {
    // When no provider is signed in yet, "press n to start" is a trap: [n]
    // bounces a brand-new user into an auth prompt. Point them at sign-in
    // instead; the prominent CTA above carries the per-provider keys.
    return authed ? 'No runs yet — press n to start' : 'Sign in to begin';
  }
  const callWord = spend.todayCalls === 1 ? 'call' : 'calls';
  const todayPart = 'Today: ' + String(spend.todayCalls) + ' ' + callWord + ' · ' + formatTokens(spend.todayTokens) + ' tokens';
  const totalPart = formatTokens(spend.totalTokens) + ' tokens all-time';
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
export function renderConversationList(
  metas: ConversationMeta[],
  nowMs: number,
  color = false,
): string[] {
  return metas.slice(0, 7).map((m, i) => {
    const thenMs = new Date(m.updatedAt).getTime();
    const rel = relativeTime(thenMs, nowMs);
    const idx = i + 1;
    const pin = m.pinned ? '📌 ' : '   ';
    const categorySuffix = m.category != null ? `  [${m.category}]` : '';
    // At-a-glance message count (real-chat gap #4): a dim "· N msgs" cue from the
    // already-stored messageCount, so the picker shows how much is in each thread.
    // Only when there's at least one message; degrades under no-color (dim is a
    // no-op when color:false → plain " · N msgs"). Singular/plural kept honest.
    const count = typeof m.messageCount === 'number' ? m.messageCount : 0;
    const countSuffix =
      count > 0 ? `  ${dim(`· ${count} msg${count === 1 ? '' : 's'}`, color)}` : '';
    const row = `[${idx}] ${pin}${rel}  ${m.title}${categorySuffix}${countSuffix}`;
    // Optional second dim line = the cached ※ recap (state, not just the opening
    // words). Only when a non-empty recap exists; legacy rows show the title alone
    // (docs/recap-feature-5.5.md §5.3). Truncated; indented to align under the title.
    const recap = typeof m.recap === 'string' ? m.recap.trim() : '';
    if (recap.length === 0) return row;
    const shown = recap.length > 72 ? recap.slice(0, 71) + '…' : recap;
    return `${row}\n         ${dim(shown, color)}`;
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

/**
 * Classify a single raw keypress observed DURING a streaming model turn.
 *
 * The mid-turn key listener (see {@link attachChatTurnKeyListener}) observes the
 * terminal while a turn runs. The only key it acts on is a bare ESC (`'\x1b'`),
 * which means "interrupt this turn and stay at the chat prompt" — distinct from
 * the SIGINT/Ctrl+C escape model ({@link interpretInterrupt}). Everything else
 * is ignored so printable input and line editing stay owned by readline:
 *
 *   - a bare ESC while a turn is running → `'interrupt-task'`
 *   - a bare ESC while idle (no turn) → `'ignore'` (no interrupt message at idle)
 *   - an arrow-key / function-key escape sequence (`'\x1b[A'`, `'\x1bOP'`, …) →
 *     `'ignore'` (the leading ESC is part of a longer sequence, not a deliberate
 *     ESC press)
 *   - any printable byte, Enter, Ctrl+C, etc. → `'ignore'`
 *
 * Pure — never throws, no I/O, no side effects.
 *
 * @param raw         - The raw keypress bytes as a string (one or more bytes).
 * @param taskRunning - Whether a model turn is currently in-flight.
 */
export function interpretChatKey(
  raw: string,
  taskRunning: boolean,
): 'interrupt-task' | 'ignore' {
  // Only an isolated ESC byte is the interrupt. A longer string starting with
  // ESC is an arrow/function-key escape sequence and must be ignored so it does
  // not steal cursor navigation from readline's line editor.
  if (raw !== '\x1b') return 'ignore';
  return taskRunning ? 'interrupt-task' : 'ignore';
}
