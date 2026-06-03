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
import type { Clock, LedgerWriter, OrchestrateDeps, Question, QuestionSet, SessionEntry } from '../core/types.js';
import { buildGoalTask, parseGoalSignal, decideGoalNext, DEFAULT_MAX_GOAL_ITERATIONS } from '../core/goal.js';
import type { GoalCeilings } from '../core/goal.js';
import { formatAnswers, isKeepGoingOffer } from '../core/questions.js';
import type { AppConfig } from '../infra/config.js';
import { saveConfig } from '../infra/config.js';
import type { ConversationMeta, ConversationStore } from '../infra/conversation-store.js';
import { readLedger } from '../infra/ledger.js';
import { summarizeSpend, formatTokens } from '../infra/insights.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { detectEnvironment, getInstallCommand } from '../providers/detect.js';
import { installProvider, installCommandFor } from '../providers/install.js';
import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import { listNativeSessions, importNativeSession } from '../providers/native-sessions.js';
import { POLICY_PRESETS, modeLabel, defaultModeForPlan, MODE_DESC } from '../core/policy.js';
import type { Mode } from '../core/policy.js';
import { planNativeSession } from '../core/native-session.js';
import type { OutputSink } from './render.js';
import { runTask } from './run.js';
import { runLogin } from '../commands/login.js';
import type { LoginMethod } from '../commands/login.js';
import { runDoctor } from '../commands/doctor.js';
import { runCost } from '../commands/cost.js';
import { runInstall } from '../commands/install.js';
import { box, separator, menu } from '../ui/tui.js';
import { dim, cyan, bold } from '../ui/theme.js';
import { makeRouteClassifier } from '../core/route-classifier.js';
import type { UpdateCheckResult } from '../infra/update-check.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import { loadClaudeTokenCapturedAt, claudeTokenStatus } from '../infra/credentials.js';
import type { HealthIssue } from '../infra/health.js';

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
    opts?: {
      method?: LoginMethod;
      readLine?: () => Promise<string | null>;
      suspendStdin?: () => () => void;
    },
  ) => Promise<number>;
  /**
   * Optional injected single-key confirm for testing. When provided, `startMenu`
   * uses this instead of the raw-mode keypress reader, so tests can drive yes/no
   * prompts deterministically without a TTY. Omit → the real reader is built
   * (raw single-key on a TTY, line-mode fallback otherwise).
   */
  readonly confirm?: (
    defaultYes: boolean,
    opts?: { requireExplicit?: boolean },
  ) => Promise<boolean>;
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
  /**
   * Optional pre-computed Claude token lifetime status for testing. When provided,
   * `startMenu` uses this instead of loading from disk, allowing tests to drive
   * the token-expiry header warning without touching the filesystem.
   *
   * Pass `null` explicitly to suppress any token warning; omit (undefined) to
   * trigger the real disk read via `loadClaudeTokenCapturedAt`.
   */
  readonly claudeTokenInfo?: ClaudeTokenStatus | null;
  /**
   * Optional override for npx-context detection (testing). When provided,
   * `startMenu` uses this instead of inspecting `process.argv[1]`, so tests can
   * drive the "running under npx" warning + auto-update suppression without a
   * real npx cache path. Omit (undefined) to trigger the real detection.
   */
  readonly runningUnderNpx?: boolean;
  /**
   * Pre-computed environment health issues (Node version, state-dir writable,
   * pricing staleness) surfaced automatically below the header — only when a
   * problem exists. Computed once at startup by cli.ts (the diagnostics don't
   * change in-session) so the user never has to run a separate health command.
   * Omit/empty → nothing is shown.
   */
  readonly healthIssues?: readonly HealthIssue[];
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
 * Never throws.  Callers render the hint via {@link yesNoHint}: `yes (enter) / no`
 * for a default-yes prompt, `yes (y) / no (n)` for a strict one.
 *
 * Strict mode (`requireExplicit`): for destructive/sensitive actions, ONLY an
 * explicit yes counts — Enter, EOF, and anything else cancel. This is the
 * line-mode (piped/test) twin of the strict single-key path, so a bare Enter can
 * never confirm a delete.
 *
 * @param input           - The raw line from readLine(), or null on EOF.
 * @param defaultYes      - True if pressing Enter (or EOF) means yes (ignored when strict).
 * @param requireExplicit - True to require an explicit `y`/`yes`; everything else is no.
 * @returns True for yes, false for no.
 */
export function parseYesNo(
  input: string | null,
  defaultYes: boolean,
  requireExplicit = false,
): boolean {
  const lower = (input ?? '').trim().toLowerCase();
  if (requireExplicit) {
    // Strict: only an explicit yes confirms; Enter/EOF/typos all cancel.
    return lower === 'y' || lower === 'yes';
  }
  if (input === null || lower.length === 0) return defaultYes;
  if (lower === 'y' || lower === 'yes') return true;
  if (lower === 'n' || lower === 'no') return false;
  return defaultYes;
}

/**
 * Interpret a single raw keypress for a yes/no prompt that accepts one key
 * (no Enter required).
 *
 *   - 'y' / 'Y'                → 'yes'
 *   - 'n' / 'N'                → 'no'
 *   - Ctrl-C (ETX) / Ctrl-D (EOT) → 'abort' (caller should bail out)
 *   - Enter (CR/LF)            → the default ('yes'/'no'), or 'ignore' when strict
 *   - anything else            → 'ignore' (do nothing; keep waiting for a key)
 *
 * Strict mode (`requireExplicit`): for destructive/sensitive actions there is NO
 * Enter default — Enter (and every key but y/n/Ctrl-C) is ignored, so the user
 * must consciously press `y` or `n`. A reflexive Enter can't confirm a delete.
 *
 * Pure / never throws. The I/O layer maps these verdicts onto behaviour; this
 * function is the testable decision core.
 */
export function interpretYesNoKey(
  key: string,
  defaultYes: boolean,
  requireExplicit = false,
): 'yes' | 'no' | 'ignore' | 'abort' {
  if (key === '\x03' || key === '\x04') return 'abort';
  const lower = key.toLowerCase();
  if (lower === 'y') return 'yes';
  if (lower === 'n') return 'no';
  if (key === '\r' || key === '\n') {
    return requireExplicit ? 'ignore' : defaultYes ? 'yes' : 'no';
  }
  return 'ignore';
}

/**
 * Render the trailing yes/no hint for a confirm prompt. The key cue is dimmed so
 * the eye lands on the words `yes` / `no`, not the annotation. Two shapes:
 *
 *   - `'yes'`    → default-yes: Enter or `y` confirms.   →  `yes (enter) / no`
 *   - `'strict'` → no default (sensitive/destructive):   →  `yes (y) / no (n)`
 *                  the user must press `y` or `n`; Enter does nothing.
 *
 * One predictable rule for the whole app — Enter means yes everywhere, except a
 * strict prompt has no Enter shortcut at all — so there's never a silent
 * default-no to second-guess.
 */
export function yesNoHint(mode: 'yes' | 'strict', color: boolean): string {
  const d = (s: string): string => dim(s, color);
  return mode === 'strict'
    ? `yes ${d('(y)')} / no ${d('(n)')}`
    : `yes ${d('(enter)')} / no`;
}

/**
 * The result of interpreting a user's raw answer to a single structured
 * question (the testable decision core for the question selector):
 *   - `{ kind: 'answer', text }` — a resolved answer string (one or more option
 *     labels joined by ', ', or free text) to feed back as the next turn.
 *   - `{ kind: 'cancel' }` — EOF/blank/Ctrl-C: skip this question.
 *   - `{ kind: 'retry' }` — the input made no valid selection; re-prompt.
 */
export type QuestionVerdict =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'retry' };

/**
 * Interpret a raw answer line for a single {@link Question} (pure decision core
 * used by the TTY and non-TTY selector paths alike).
 *
 * Selection rules (1-based indices match the rendered `[1] … [2] …` menu):
 *   - `null` (EOF) or empty/whitespace line → `cancel`.
 *   - Ctrl-C / Ctrl-D control bytes        → `cancel`.
 *   - A "type your own" sentinel index (options.length + 1) when `allowFreeText`
 *     is signalled by a non-empty `freeText` argument → that free text as the
 *     answer (the I/O layer collects the free text after the user picks it).
 *   - Single-select: the first valid index → that option's label.
 *   - Multi-select: comma/space-separated indices → the distinct labels in the
 *     order given, joined by ', '. Any wholly invalid set → `retry`.
 *   - Free text directly typed (non-numeric) when `allowFreeText` → that text.
 *   - Otherwise → `retry`.
 *
 * Pure / never throws.
 *
 * @param input    - The raw line from the reader, or null on EOF.
 * @param question - The question being answered (options + flags).
 */
export function interpretQuestionAnswer(
  input: string | null,
  question: Question,
): QuestionVerdict {
  if (input === null) return { kind: 'cancel' };
  // Control bytes (Ctrl-C / Ctrl-D) → cancel.
  if (input.includes('\x03') || input.includes('\x04')) return { kind: 'cancel' };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { kind: 'cancel' };

  const optionCount = question.options.length;
  const freeTextIndex = optionCount + 1; // the "[N] type your own" slot

  // Parse the line into 1-based indices (comma or whitespace separated).
  const tokens = trimmed.split(/[\s,]+/).filter((t) => t.length > 0);
  const allNumeric = tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));

  if (allNumeric) {
    const indices = tokens.map((t) => parseInt(t, 10));

    // "type your own" sentinel — only meaningful when free text is allowed.
    if (question.allowFreeText && indices.length === 1 && indices[0] === freeTextIndex) {
      // The I/O layer must collect the actual free text; signal via retry-free
      // is unnecessary — instead we return cancel here is wrong. We surface a
      // dedicated marker the caller recognises.
      return { kind: 'answer', text: FREE_TEXT_SENTINEL };
    }

    const valid = indices.filter((i) => i >= 1 && i <= optionCount);
    if (valid.length === 0) return { kind: 'retry' };

    if (!question.multiSelect) {
      const first = valid[0];
      const label = first !== undefined ? question.options[first - 1]?.label : undefined;
      return label !== undefined ? { kind: 'answer', text: label } : { kind: 'retry' };
    }

    // Multi-select: distinct labels in the order given.
    const labels: string[] = [];
    for (const i of valid) {
      const label = question.options[i - 1]?.label;
      if (label !== undefined && !labels.includes(label)) labels.push(label);
    }
    return labels.length > 0 ? { kind: 'answer', text: labels.join(', ') } : { kind: 'retry' };
  }

  // Non-numeric input: treat as free text when the question allows it.
  if (question.allowFreeText) {
    return { kind: 'answer', text: trimmed };
  }

  return { kind: 'retry' };
}

/**
 * Sentinel returned by {@link interpretQuestionAnswer} when the user picked the
 * "type your own" option by its index; the I/O layer then collects the actual
 * free-text line. Kept internal to the selector contract.
 */
export const FREE_TEXT_SENTINEL = '\x00__FREE_TEXT__\x00';

/**
 * The slash-commands available at the chat prompt. Tab-completion offers these;
 * keep in sync with the dispatch in runChatLoop (/back, /exit, /help).
 */
export const CHAT_SLASH_COMMANDS: readonly string[] = ['/help', '/back', '/exit'];

/**
 * Pure completer for a readline `completer` option, scoped to slash-commands.
 *
 * Returns `[hits, line]` per the Node readline contract. Only fires for a line
 * that starts with `/` (the chat prompt is otherwise free-form prose, where
 * shell-style completion would corrupt sentences), and only when there is more
 * than one candidate or a genuine prefix to extend — so pressing Tab on plain
 * text is a harmless no-op. Never throws.
 *
 * @param line     the current input line (substring up to the cursor)
 * @param commands the candidate command set (defaults to the chat commands)
 */
export function completeSlash(
  line: string,
  commands: readonly string[] = CHAT_SLASH_COMMANDS,
): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const hits = commands.filter((c) => c.startsWith(line));
  // Return all commands as the candidate list when the bare `/` is typed, so
  // readline lists them; otherwise the filtered prefix matches.
  return [hits.length > 0 ? hits : [], line];
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
export function renderHeaderLines(
  env: EnvironmentStatus,
  _version: string,
  claudeToken?: ReturnType<typeof claudeTokenStatus>,
): string[] {
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
  // authenticated reflects a real credential probe (`opencode auth list`) — ready
  // only when the user has logged a provider/subscription in. Free models alone
  // are not "ready" (they can't do serious work), so an unconfigured opencode is
  // shown as not signed in, with a hint to add a provider.
  if (env.opencode.installed) {
    const ps = env.opencode;
    const planSuffix = ps.plan != null ? ` (${ps.plan})` : '';
    if (ps.authenticated) {
      lines.push(`✅ ${ps.id}: ready${planSuffix}`);
    } else {
      lines.push(`⚠️  ${ps.id}: not signed in — press [o] to add your provider${planSuffix}`);
    }
  }

  // Token expiry warning — only when near-expiry or expired (not on every launch).
  if (claudeToken != null && (claudeToken.expired || claudeToken.nearExpiry)) {
    if (claudeToken.expired) {
      lines.push(`⚠️  claude token EXPIRED — run: myshell-tools login claude --code`);
    } else {
      lines.push(`⚠️  claude token expires in ${claudeToken.daysLeft} days — run: myshell-tools login claude --code`);
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
export function renderBudgetLine(spend: SpendSummary, _color: boolean): string {
  if (spend.calls === 0) {
    return 'No runs yet — press n to start';
  }
  const taskWord = spend.calls === 1 ? 'task' : 'tasks';
  const todayPart = 'Today: ' + String(spend.calls) + ' ' + taskWord + ' · ' + formatTokens(spend.todayTokens) + ' tokens';
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
  /**
   * Stop consuming `process.stdin` so an inherited-stdio child process (e.g.
   * `claude auth login`) becomes the SOLE reader of the terminal. Without this,
   * the readline interface and the child race for the same bytes and a pasted
   * value lands split/garbled on the child's prompt (the classic "first paste
   * fails, second works" bug). Idempotent.
   */
  suspend(): void;
  /** Resume consuming stdin after a {@link suspend}. Idempotent. */
  resume(): void;
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
export function createLineReader(
  rl: readline.Interface,
  input: KeyInputStream = process.stdin as unknown as KeyInputStream,
): LineReader {
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
    suspend(): void {
      // Pause readline AND hand the raw TTY back to cooked mode + stop Node
      // reading, so an inherited-stdio child owns stdin alone. Best-effort:
      // every step is guarded so a non-TTY / test stream never throws.
      try {
        rl.pause();
      } catch {
        /* readline may already be paused/closed */
      }
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') input.setRawMode(false);
      } catch {
        /* setRawMode unsupported on this platform */
      }
      try {
        input.pause();
      } catch {
        /* already paused */
      }
    },
    resume(): void {
      // Take stdin back after an inherited-stdio child (e.g. `claude auth login`)
      // owned the terminal. Two things must happen, or the NEXT prompt "dead-
      // pauses": it's written but the reader doesn't wake until the user presses
      // Enter to nudge the stream.
      //
      // 1. Drop any line the child left buffered — typically the trailing Enter
      //    the user pressed to submit a pasted code — so it can't bleed into or
      //    desync the next prompt.
      buffered.length = 0;
      // 2. Re-PRIME the TTY. A bare `input.resume()` is not enough: after a child
      //    held fd0, the tty read handle is left dormant and the next keypress
      //    won't emit 'data' until Enter kicks it. Cycling raw mode off→on forces
      //    libuv to re-arm the read handle. This also restores the raw mode a
      //    `terminal: true` readline needs for line editing (suspend() set cooked).
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') {
          input.setRawMode(false);
          input.setRawMode(true);
        }
      } catch {
        /* setRawMode unsupported on this platform */
      }
      try {
        input.resume();
      } catch {
        /* already flowing */
      }
      try {
        rl.resume();
      } catch {
        /* readline may be closed */
      }
    },
    close(): void {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Single-key yes/no confirm (TTY) with a line-mode fallback
// ---------------------------------------------------------------------------

/** A yes/no confirm: resolves true for yes, false for no, honouring a default. */
type Confirm = (
  defaultYes: boolean,
  opts?: { requireExplicit?: boolean },
) => Promise<boolean>;

/**
 * The slice of `process.stdin` the single-key reader touches. Declaring it as a
 * narrow interface (rather than `NodeJS.ReadStream`) lets tests inject a fake
 * stream and verify the listener detach/restore + raw-mode toggling without a
 * real TTY.
 */
export interface KeyInputStream {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  pause(): void;
  resume(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(event: string): unknown;
  listeners(event: string): Array<(...args: never[]) => void>;
}

/**
 * Read exactly one raw keypress from the TTY.
 *
 * The live `node:readline` interface is briefly detached (its `data`/`keypress`
 * listeners are removed and restored afterwards) so the byte isn't ALSO consumed
 * as line input or echoed. The previous raw-mode flag is always restored. On any
 * failure the promise rejects so the caller can fall back to line mode.
 *
 * `stdin` is injectable for testing; in production it is `process.stdin`.
 */
export function readSingleKey(
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const prevData = stdin.listeners('data');
    const prevKeypress = stdin.listeners('keypress');
    const wasRaw = stdin.isRaw === true;

    const onData = (buf: Buffer): void => {
      restore();
      resolve(buf.toString('utf8'));
    };

    function restore(): void {
      stdin.removeListener('data', onData as (...a: never[]) => void);
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      } catch {
        /* best-effort — never throw on mode restore */
      }
      for (const l of prevData) stdin.on('data', l);
      for (const l of prevKeypress) stdin.on('keypress', l);
    }

    try {
      // Detach readline's grip for the duration of this single read.
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('keypress');
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData as (...a: never[]) => void);
    } catch (err) {
      restore();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Drive a single-key yes/no confirm on a TTY: Enter accepts the default, `y`/`n`
 * decide immediately (no Enter), any other key is ignored, and Ctrl-C/Ctrl-D
 * re-raise SIGINT to exit. The chosen letter is echoed (raw mode suppresses the
 * terminal's own echo). Rejects if the raw read is unavailable so the caller can
 * fall back to line mode.
 *
 * When `requireExplicit` is set (strict / destructive prompts) there is no Enter
 * default — Enter and every key but y/n/Ctrl-C is ignored, so the user must
 * deliberately press `y` or `n`.
 *
 * `stdin` is injectable for testing; in production it is `process.stdin`.
 */
export async function confirmViaKey(
  out: OutputSink,
  defaultYes: boolean,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
  requireExplicit = false,
): Promise<boolean> {
  for (;;) {
    const key = await readSingleKey(stdin);
    const verdict = interpretYesNoKey(key, defaultYes, requireExplicit);
    if (verdict === 'ignore') continue;
    if (verdict === 'abort') {
      out.write('\n');
      // Honour Ctrl-C: re-raise SIGINT so the process exits as expected.
      process.kill(process.pid, 'SIGINT');
      return defaultYes;
    }
    const yes = verdict === 'yes';
    out.write((yes ? 'y' : 'n') + '\n');
    return yes;
  }
}

/**
 * Read the user's main-menu choice. On a real interactive TTY this resolves on a
 * SINGLE keypress — press `c`/`n`/`j`/a digit and it fires immediately, no Enter
 * (matching the muscle memory of session managers like DATA Tools). The pressed
 * key is echoed (raw mode suppresses the terminal's own echo). Falls back to a
 * full line read when stdin isn't a raw-capable TTY (pipes, tests), so scripted
 * input keeps working exactly as before.
 *
 * Returns:
 *   - the chosen key (a single lower-cased char) to act on,
 *   - `''` for Enter / arrow keys / other no-ops (caller just re-renders),
 *   - `null` for Ctrl-C / Ctrl-D / EOF (caller exits).
 *
 * `stdin` is injectable for testing.
 */
export async function readMenuKey(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
): Promise<string | null> {
  const canRawKey =
    out.isTty && stdin.isTTY === true && typeof stdin.setRawMode === 'function';
  if (!canRawKey) return readLine();
  try {
    const raw = await readSingleKey(stdin);
    if (raw === '\x03' || raw === '\x04') return null; // Ctrl-C / Ctrl-D → exit
    if (raw === '\r' || raw === '\n') return ''; // bare Enter → no-op (re-render)
    // Only a single printable char is a menu choice; ignore escape sequences
    // (arrow keys arrive as multi-byte '\x1b[A' and must not echo or match).
    if (raw.length === 1 && raw >= ' ') {
      const choice = raw.toLowerCase();
      out.write(choice + '\n'); // echo — raw mode suppressed the terminal's echo
      return choice;
    }
    return '';
  } catch {
    // Raw read unavailable → fall back to a line so the menu never wedges.
    return readLine();
  }
}

/**
 * Build the {@link Confirm} used for yes/no prompts.
 *
 *   - `injected` (tests) wins.
 *   - On a real interactive TTY → single-key reader (Enter = default, y/n decide
 *     instantly, other keys ignored) with a line-mode fallback if it ever fails.
 *   - Otherwise (piped input / tests / no setRawMode) → line read + parseYesNo,
 *     so EOF and scripted `y`/`n`/blank lines keep working exactly as before.
 */
function makeConfirm(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  injected?: Confirm,
): Confirm {
  if (injected !== undefined) return injected;

  const canRawKey =
    out.isTty &&
    process.stdin.isTTY === true &&
    typeof process.stdin.setRawMode === 'function';

  if (!canRawKey) {
    return async (defaultYes: boolean, opts?: { requireExplicit?: boolean }): Promise<boolean> =>
      parseYesNo(await readLine(), defaultYes, opts?.requireExplicit ?? false);
  }

  return async (defaultYes: boolean, opts?: { requireExplicit?: boolean }): Promise<boolean> => {
    const requireExplicit = opts?.requireExplicit ?? false;
    try {
      return await confirmViaKey(
        out,
        defaultYes,
        process.stdin as unknown as KeyInputStream,
        requireExplicit,
      );
    } catch {
      // Any raw-mode hiccup must never break onboarding — fall back to a line.
      return parseYesNo(await readLine(), defaultYes, requireExplicit);
    }
  };
}

// ---------------------------------------------------------------------------
// Welcome screen (first run)
// ---------------------------------------------------------------------------

async function runWelcome(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  suspendStdin: (() => () => void) | undefined,
  mutableConfig: AppConfig,
  installProviderFn: (id: ProviderId, out: OutputSink) => Promise<boolean>,
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: {
      method?: LoginMethod;
      readLine?: () => Promise<string | null>;
      suspendStdin?: () => () => void;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
): Promise<AppConfig> {
  // Use the mutable env so re-detection after installs is visible downstream.
  let env = ctx.env;

  const headerLines = renderHeaderLines(env, ctx.version);
  out.write('\n' + box(`🧠 myshell-tools v${ctx.version} — Setup`, headerLines) + '\n\n');

  // ---- Orientation header --------------------------------------------------
  out.write('Quick setup — a few questions, ~30 seconds. Enter takes the default (the side marked (enter)); or press y / n.\n\n');

  // ---- Offer to install any missing provider (claude / codex) --------------
  // Consent is required: we ask once per missing provider.
  // Display: (Y/n) — default YES, so Enter installs; explicit n skips.
  const providers: ProviderId[] = ['claude', 'codex'];
  let didInstallAny = false;

  for (const id of providers) {
    const ps = env[id];
    if (ps.installed) continue;

    const pkg = id === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
    out.write(`Install ${id} (${pkg})? ${yesNoHint('yes', out.color)} `);

    if (await confirm(true)) {
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
  // Enter = yes, consistent with the claude/codex install prompts above (adding a
  // CLI is additive and easily removed). Decline with n.
  if (!env.opencode.installed) {
    out.write(`Add opencode? (optional — bring your own provider/subscription) ${yesNoHint('yes', out.color)} `);
    if (await confirm(true)) {
      const ok = await installProviderFn('opencode', out);
      if (ok) {
        // Re-detect so downstream sign-in logic sees the freshly installed opencode.
        env = await detectEnvironmentFn();
      }
    }
    // No nag on skip — opencode is always discoverable via [o] in the main menu.
  }

  // ---- Offer sign-in for installed-but-unauthenticated providers -----------
  // opencode now reports authenticated from a real credential probe, so a freshly
  // installed opencode (0 credentials) is offered sign-in here too — bring your
  // subscription, log it in once, and it just works.
  for (const id of providers) {
    const ps = env[id];
    if (!ps.installed || ps.authenticated) continue;

    out.write(`\nSign in to ${id} now? ${yesNoHint('yes', out.color)} `);

    if (await confirm(true)) {
      // loginFn auto-detects the right method (code in containers/SSH where the
      // localhost OAuth callback can't be reached, browser on a desktop).
      // Pass readLine so the browser-failed "retry with code?" prompt shares the
      // menu's reader, and suspendStdin so the vendor CLI owns the terminal alone
      // during its interactive sign-in (no paste byte-race).
      await loginFn(out, id, {
        readLine,
        ...(suspendStdin !== undefined ? { suspendStdin } : {}),
      });
    }
  }

  // ---- Mode selection — single collapsed prompt ----------------------------
  // Accepts 1/2/3 directly; Enter keeps the auto default (derived from your plan).
  // Quality is never capped in any mode — this only tunes how eagerly we reach
  // for the strongest model.
  out.write(
    `\nMode — [1] ${modeLabel('cost-saver')}  [2] ${modeLabel('balanced')}  [3] ${modeLabel('quality-first')}  (Enter = auto from your subscription): `,
  );
  const modeKey = await readLine();

  // EOF during setup — save bare onboarded config and return
  if (modeKey === null) {
    const saved: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      ...(mutableConfig.mode !== undefined ? { mode: mutableConfig.mode } : {}),
    };
    await saveConfig(saved);
    return saved;
  }

  let newMode = mutableConfig.mode;
  if (modeKey === '1') newMode = 'cost-saver';
  else if (modeKey === '2') newMode = 'balanced';
  else if (modeKey === '3') newMode = 'quality-first';
  // Enter/empty/anything else → keep current (balanced default)

  const updated: AppConfig = {
    onboarded: mutableConfig.onboarded,
    setAsDefault: mutableConfig.setAsDefault,
    ...(newMode !== undefined ? { mode: newMode } : {}),
  };

  // Enter = yes (consistent with the rest of setup). Reversible later via Settings.
  out.write(`Set myshell-tools as your default shell tool? ${yesNoHint('yes', out.color)} `);
  const setAsDefault = await confirm(true);

  // Default is YES: check for updates at launch and OFFER to install (we ask
  // first — never a silent swap). Opt out with n or via Settings.
  out.write(`Check for updates at launch (I'll show the version and ask first)? ${yesNoHint('yes', out.color)} `);
  const autoUpdate = await confirm(true);

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
  autoMode: Mode = 'balanced',
): Promise<AppConfig> {
  // Effective mode = explicit choice, else the subscription-derived auto default.
  const effective = config.mode ?? autoMode;
  const mark = (m: Mode): string => (effective === m ? '  ‹active›' : '');
  // Plain lines (NOT box()) — the descriptions are long and would overflow a
  // fixed-width box border.
  const lines = [
    '',
    bold('Mode — how eagerly to reach for the strongest model', out.color),
    dim('Quality is never capped: routing always escalates to the best model when a turn needs it.', out.color),
    '',
    `  [1] ${bold(modeLabel('cost-saver'), out.color)} — ${MODE_DESC['cost-saver']}${mark('cost-saver')}`,
    `  [2] ${bold(modeLabel('balanced'), out.color)} — ${MODE_DESC['balanced']}${mark('balanced')}`,
    `  [3] ${bold(modeLabel('quality-first'), out.color)} — ${MODE_DESC['quality-first']}${mark('quality-first')}`,
    config.mode === undefined
      ? dim(`  (auto: ${modeLabel(autoMode)} — from your subscription; pick a number to pin it)`, out.color)
      : '',
  ];
  out.write('\n' + lines.filter((l) => l !== '').join('\n') + '\n\n');

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
    // Preserve other prefs so changing mode doesn't silently reset them.
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
  };

  await saveConfig(updated);
  out.write(`Mode: ${modeLabel(newMode ?? autoMode)}${newMode === undefined ? ' (auto)' : ''}\n`);
  return updated;
}

/**
 * Choose the output-detail (verbosity) level and persist it.
 *
 *   quiet   → model prose + errors only (no status line)
 *   normal  → clean conversation: prose, errors, one minimal completion line
 *   verbose → everything (tool/reasoning lines + per-tier telemetry)
 *
 * Default is 'normal' (undefined counts as normal). Preserves all other config
 * fields via conditional spread so changing detail doesn't reset other prefs.
 */
async function runVerbositySelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<AppConfig> {
  const current = config.verbosity ?? 'normal';
  const settingsLines = [
    '',
    'Output detail:',
    `  [1] quiet${current === 'quiet' ? ' (active)' : ''}`,
    `  [2] normal${current === 'normal' ? ' (active)' : ''}`,
    `  [3] verbose${current === 'verbose' ? ' (active)' : ''}`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('[1/2/3 to change, Enter to keep] ');
  const key = await readLine();

  // EOF / Enter → keep current
  let newVerbosity = config.verbosity;
  if (key === '1') newVerbosity = 'quiet';
  else if (key === '2') newVerbosity = 'normal';
  else if (key === '3') newVerbosity = 'verbose';

  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(newVerbosity !== undefined ? { verbosity: newVerbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
  };

  await saveConfig(updated);
  out.write(`Output detail set to: ${newVerbosity ?? 'normal'}\n`);
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
    // Preserve other prefs so toggling default-shell doesn't silently reset them.
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
  };
  await saveConfig(updated);
  return updated;
}

async function runSettings(
  _ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<void> {
  const cfg = mutableCtx.config;
  const autoMode = defaultModeForPlan(mutableCtx.env.claude.plan);
  const effMode = cfg.mode ?? autoMode;
  const settingsLines = [
    '',
    `  [1] Mode: ${modeLabel(effMode)}${cfg.mode === undefined ? ' (auto)' : ''}`,
    `  [2] Set as default shell: ${cfg.setAsDefault ? 'on' : 'off'}`,
    `  [3] Update on launch: ${cfg.autoUpdate !== false ? 'on' : 'off'}`,
    `  [4] Native sessions (experimental): ${cfg.nativeSessions === true ? 'on' : 'off'}`,
    `  [5] Output detail: ${cfg.verbosity ?? 'normal'}`,
    `  [6] Smart routing: ${cfg.smartRoute !== false ? 'on' : 'off'}`,
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
    mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode);
  } else if (key === '2') {
    mutableCtx.config = await toggleDefaultShell(mutableCtx.config, out);
  } else if (key === '3') {
    mutableCtx.config = await toggleAutoUpdate(mutableCtx.config, out);
  } else if (key === '4') {
    mutableCtx.config = await toggleNativeSessions(mutableCtx.config, out);
  } else if (key === '5') {
    mutableCtx.config = await runVerbositySelect(mutableCtx.config, out, readLine);
  } else if (key === '6') {
    mutableCtx.config = await toggleSmartRoute(mutableCtx.config, out);
  }
  // anything else → back
}

/**
 * Toggle smart routing and persist it.
 *
 * When on (the DEFAULT), turns the keyword classifier can't route (no tier
 * keyword matched) are handed to a cheap model that picks the tier; clear keyword
 * turns still route instantly with no model call. It adds ~5-10s on those
 * ambiguous turns only (a worker-tier classification spawn), so it can be turned
 * off here. See core/router.ts + core/route-classifier.ts.
 */
async function toggleSmartRoute(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  // Default-on: enabled unless explicitly false (mirrors auto-update).
  const currentlyEnabled = config.smartRoute !== false;
  const enable = !currentlyEnabled;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    // Persist only the explicit-OFF; absent means default-on.
    ...(!enable ? { smartRoute: false } : {}),
  };
  await saveConfig(updated);
  out.write(`Smart routing: ${enable ? 'on' : 'off'}\n`);
  return updated;
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
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
  };
  await saveConfig(updated);
  out.write(`Update on launch: ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL native-session preference and persist it.
 *
 * When on, conversations that stay on the same provider reuse that provider's
 * native session (Claude `--session-id`/`--resume`) instead of replaying a
 * compacted history block — better context fidelity and less re-sent context.
 * Default OFF; live behavior should be verified with the gated integration test
 * (`npm run test:integration`) before relying on it.
 */
async function toggleNativeSessions(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.nativeSessions !== true;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(enable ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
  };
  await saveConfig(updated);
  out.write(`Native sessions (experimental): ${enable ? 'on' : 'off'}\n`);
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
        // Strict confirm: deletion is irreversible, so there is NO Enter default —
        // only an explicit 'y' removes the conversation (a reflexive Enter cancels).
        out.write(`Delete "${conv.title}"? ${yesNoHint('strict', out.color)} `);
        const confirmAns = await readLine();
        if (parseYesNo(confirmAns, false, true)) {
          await ctx.store.remove(conv.id);
          out.write('Deleted.\n');
        } else {
          out.write('Cancelled.\n');
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
    opts?: {
      method?: LoginMethod;
      readLine?: () => Promise<string | null>;
      suspendStdin?: () => () => void;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  suspendStdin?: () => () => void,
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
  return runChatLoop(ctx, mutableCtx, id, out, readLine, loginFn, detectEnvironmentFn, suspendStdin);
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

// ---------------------------------------------------------------------------
// Structured-question selector
// ---------------------------------------------------------------------------

/**
 * Maximum number of consecutive question turns the selector will auto-resubmit
 * before handing control back to the human prompt. Prevents a model that keeps
 * asking from looping forever without the user ever typing.
 */
const MAX_CONSECUTIVE_QUESTION_TURNS = 3;

/**
 * Render a {@link QuestionSet} and collect the user's answers, returning the
 * deterministic next-turn text (via {@link formatAnswers}) to resubmit into the
 * same conversation, or `null` when the user cancelled every question (submit
 * nothing → return to the prompt).
 *
 * Behaviour (mirrors the existing numbered pickers in runImportNative/runManage):
 *   - For each question, print the prompt + numbered options
 *     (`[1] label — description`), plus an `[N] type your own` line when the
 *     question allows free text.
 *   - Read a full line via `readLine` and parse it through the pure decision
 *     core {@link interpretQuestionAnswer}. On the TTY this line comes from the
 *     same readline reader the chat prompt uses; in tests an injected readLine
 *     drives it deterministically (mirrors confirmViaKey's line fallback).
 *   - `retry` re-prompts the same question; `cancel` (EOF/blank/Ctrl-C) skips
 *     this question and submits nothing for it.
 *   - When the user picks "type your own", a follow-up line is read for the
 *     free text.
 *
 * The reader (and thus its EOF/Ctrl-C semantics) is injected, so this is
 * testable without a TTY.
 */
async function runQuestionSelector(
  questions: QuestionSet,
  out: OutputSink,
  readLine: () => Promise<string | null>,
): Promise<string | null> {
  const answers: Record<string, string> = {};

  for (const q of questions.questions) {
    out.write(`\n${q.prompt}\n`);
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i];
      if (opt === undefined) continue;
      const desc = opt.description !== undefined ? ` — ${opt.description}` : '';
      out.write(`  [${i + 1}] ${opt.label}${desc}\n`);
    }
    const freeTextIndex = q.options.length + 1;
    if (q.allowFreeText) {
      out.write(`  [${freeTextIndex}] type your own\n`);
    }
    const hint = q.multiSelect
      ? 'Pick one or more (comma-separated), or Enter to skip: '
      : 'Pick one, or Enter to skip: ';

    // Re-prompt on `retry`; resolve on `answer`/`cancel`.
    for (;;) {
      out.write(hint);
      const line = await readLine();
      const verdict = interpretQuestionAnswer(line, q);

      if (verdict.kind === 'cancel') break; // skip this question
      if (verdict.kind === 'retry') {
        out.write('  (please pick a listed number or type your own)\n');
        continue;
      }

      // answer
      if (verdict.text === FREE_TEXT_SENTINEL) {
        out.write('Type your answer: ');
        const free = await readLine();
        const freeTrimmed = (free ?? '').trim();
        if (freeTrimmed.length > 0) {
          answers[q.id] = freeTrimmed;
        }
        break;
      }
      answers[q.id] = verdict.text;
      break;
    }
  }

  const next = formatAnswers(questions, answers);
  return next.length > 0 ? next : null;
}

async function runChatLoop(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  convId: string,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: {
      method?: LoginMethod;
      readLine?: () => Promise<string | null>;
      suspendStdin?: () => () => void;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  suspendStdin?: () => () => void,
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

  // One quiet orientation line on entry — NOT a per-turn label. Real chat shells
  // (claude, gpt) don't relabel the prompt every turn; they show a clean caret and
  // let you just type. Shown once; the caret below carries every turn after. The
  // active mode is shown here too so it's always visible in-conversation.
  {
    const entryMode = modeLabel(
      mutableCtx.config.mode ?? defaultModeForPlan(mutableCtx.env.claude.plan),
    );
    out.write(
      dim(
        `Type a message and press Enter.  Mode: ${entryMode} (/mode)  ·  /goal  ·  /help  ·  /back\n`,
        out.color,
      ),
    );
  }

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
      // Clean caret — a colored chevron, no label. This is the partner-chat feel:
      // the prompt is just an invitation to type, not an instruction.
      out.write(cyan('❯ ', out.color));

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
          dim('  Just type to chat — I pick the right model for each message.\n', out.color) +
          '  /goal <text>  — work autonomously until the goal is done (Esc to stop)\n' +
          '  /mode         — quality vs speed (Efficient / Balanced / Max)\n' +
          '  /back, /exit  — return to the main menu\n' +
          '  /help         — show this help\n',
        );
        continue;
      }

      // Change the (single, global) mode from inside the chat — same knob as the
      // home [m], so there is one source of truth and never a global/per-chat drift.
      if (line === '/mode') {
        const autoMode = defaultModeForPlan(mutableCtx.env.claude.plan);
        mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode);
        continue;
      }

      // Effective mode: the user's explicit choice, else auto-detected from their
      // subscription plan (Max → top of the knob, etc.) — no interrogation.
      const effectiveMode: Mode =
        mutableCtx.config.mode ?? defaultModeForPlan(mutableCtx.env.claude.plan);
      const policy = POLICY_PRESETS[effectiveMode];

      // ---- Bug 4 fix: no-provider gate ----------------------------------------
      // Check whether any provider is actually authenticated before dispatching a
      // task that is doomed to fail. opencode now reports authenticated only when a
      // real provider/subscription is configured (no more installed-means-ready).
      const hasAuthenticatedProvider =
        mutableCtx.env.claude.authenticated ||
        mutableCtx.env.codex.authenticated ||
        mutableCtx.env.opencode.authenticated;

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
      // inline re-login with the refreshed env (bug 5 fix: no stale auth state),
      // and re-called with fresh history each turn of a /goal run.
      const buildDeps = (hist: readonly SessionEntry[]): OrchestrateDeps => {
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

        // EXPERIMENTAL native session plan (opt-in via config.nativeSessions).
        // Pure decision; null when disabled. When present, orchestrate uses the
        // provider's native session for matching tiers instead of replaying history.
        const nativeSession = planNativeSession({
          enabled: mutableCtx.config.nativeSessions === true,
          conversationId: convId,
          history: hist,
        });
        // planNativeSession returns [] when disabled / no conversation id.

        // Smart routing (opt-in): on ambiguous turns, let a cheap model pick the
        // tier. Capped at 20s so the worst-case fallback delay is bounded; the
        // classifier always runs worker-tier read-only (see route-classifier.ts).
        const ROUTER_TIMEOUT_MS = 20_000;
        const routeClassifier =
          mutableCtx.config.smartRoute !== false
            ? makeRouteClassifier({
                providers: ctx.providers,
                policy,
                cwd: ctx.cwd,
                timeoutMs: Math.min(ctx.timeoutMs, ROUTER_TIMEOUT_MS),
                ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
                ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
              })
            : undefined;

        return {
          clock: ctx.clock,
          session: ctx.store.writer(convId),
          ledger: ctx.ledger,
          policy,
          providers: ctx.providers,
          cwd: ctx.cwd,
          sandbox: ctx.sandbox,
          timeoutMs: ctx.timeoutMs,
          ...(hist.length > 0 ? { history: hist } : {}),
          ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
          ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
          ...(nativeSession.length > 0 ? { nativeSession } : {}),
          ...(routeClassifier !== undefined ? { routeClassifier } : {}),
        };
      };

      // Autonomous goal loop — shared by /goal AND by accepting the model's
      // in-chat "keep going?" offer. Runs turns toward `goalText`, reloading
      // history each turn so the model sees its own progress, bounded by a turn
      // ceiling and Esc. Returns true when the outer chat loop should break
      // (Ctrl+C → menu/exit). Closes over the per-turn buildDeps + the shared
      // currentAc/shouldExit/shouldMenu/loopResult flags.
      const runGoalLoop = async (goalText: string): Promise<boolean> => {
        // Title a still-untitled conversation from the goal (no-op if already set).
        const gMeta = (await ctx.store.list()).find((m) => m.id === convId);
        if (gMeta !== undefined && gMeta.title.trim().length === 0) {
          await ctx.store.rename(convId, goalText.length <= 80 ? goalText : goalText.slice(0, 80));
        }
        // Turns are the honest bound on a subscription (no per-token bill to cap).
        const ceilings: GoalCeilings = { maxIterations: DEFAULT_MAX_GOAL_ITERATIONS };
        out.write(
          dim(
            `\n  Working autonomously until it's done (up to ${ceilings.maxIterations} turns). Esc to stop.\n\n`,
            out.color,
          ),
        );
        let completed = 0;
        for (let i = 0; i < ceilings.maxIterations; i++) {
          out.write(dim(`  — turn ${i + 1}/${ceilings.maxIterations} —\n`, out.color));
          const goalDeps = buildDeps(await ctx.store.load(convId));
          const goalAc = new AbortController();
          currentAc = goalAc;
          const turn = await runTask(
            buildGoalTask(goalText, i),
            goalDeps,
            out,
            goalAc.signal,
            mutableCtx.config.verbosity ?? 'normal',
          );
          currentAc = null;
          completed = i + 1;
          if (shouldExit) { loopResult = 'exit'; return true; }
          if (shouldMenu) { loopResult = 'menu'; return true; }

          // A per-turn TIMEOUT isn't a hard failure here — a big goal legitimately
          // needs many turns, and a single long step shouldn't abort the whole run.
          // Keep chunking (bounded by the turn ceiling); next turn picks up where
          // this one left off via replayed history.
          if (
            turn.final?.success !== true &&
            turn.final?.errorCategory === 'timeout' &&
            completed < ceilings.maxIterations
          ) {
            out.write(dim('  (that step ran long — continuing with the next piece)\n', out.color));
            continue;
          }

          const step = decideGoalNext({
            signal: parseGoalSignal(turn.final?.output ?? ''),
            lastSucceeded: turn.final?.success === true,
            completedIterations: completed,
            ceilings,
            costSoFarUsd: 0, // no dollar ceiling on a subscription; turns bound the loop
          });
          if (step.action !== 'continue') {
            const mark = step.action === 'complete' ? '✓' : '■';
            out.write(dim(`\n  ${mark} ${step.reason}.\n`, out.color));
            break;
          }
        }
        return false;
      };

      // ---- /goal — explicit autonomous loop -----------------------------------
      if (line.startsWith('/goal')) {
        const goalText = line.slice('/goal'.length).trim();
        if (goalText.length === 0) {
          out.write(dim('  Usage: /goal <what you want achieved> — I work autonomously until it\'s done (Esc to stop).\n', out.color));
          continue;
        }
        if (await runGoalLoop(goalText)) break;
        continue;
      }

      const deps = buildDeps(priorHistory);

      const ac = new AbortController();
      currentAc = ac;
      const result = await runTask(line, deps, out, ac.signal, mutableCtx.config.verbosity ?? 'normal');
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
        out.write(`Sign in to ${failingProvider} now and retry? ${yesNoHint('yes', out.color)} `);
        const ans = await readLine();
        if (parseYesNo(ans, true)) {
          await loginFn(out, failingProvider, {
            readLine,
            ...(suspendStdin !== undefined ? { suspendStdin } : {}),
          });
          // Bug 5 fix: re-detect with the freshly-authenticated env so the retry
          // deps reflect the now-signed-in provider (not the stale pre-login state).
          mutableCtx.env = await detectEnvironmentFn();
          const retryDeps = buildDeps(await ctx.store.load(convId));
          // Retry the same task once.
          const retryAc = new AbortController();
          currentAc = retryAc;
          const retryResult = await runTask(line, retryDeps, out, retryAc.signal, mutableCtx.config.verbosity ?? 'normal');
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

      // ---- Big task hit the per-turn time limit → offer autonomous chunking ---
      // A single huge ask can blow the per-turn timeout (e.g. "build the whole
      // auth system now"). The autonomous goal loop does ONE concrete step per
      // turn, so it makes real progress instead of failing. This is the RELIABLE
      // trigger — a deterministic timeout signal, not dependent on the model
      // choosing to offer.
      if (
        result.final !== undefined &&
        !result.final.success &&
        result.final.errorCategory === 'timeout'
      ) {
        out.write('\n  ' + dim("That's a big one — it ran past the time limit for a single turn.", out.color) + '\n');
        out.write(`  Keep working on it autonomously, step by step, until it's done? ${yesNoHint('yes', out.color)} `);
        const ans = await readLine();
        if (parseYesNo(ans, true)) {
          if (await runGoalLoop(line)) break;
        }
        continue;
      }

      // ---- Natural autonomy: accept the model's "keep going?" offer -----------
      // For a big multi-step job the model does a first chunk and offers to finish
      // autonomously via an ask_user block with id 'keep_going' (see prompt.ts).
      // Render it as a clean confirm; on yes, run the autonomous goal loop on the
      // ORIGINAL task — so sustained work needs no command. Handled BEFORE the
      // generic selector so the offer isn't shown as a numbered list.
      if (result.final?.questions !== undefined && isKeepGoingOffer(result.final.questions)) {
        out.write('\n  ' + dim("I can keep working on this autonomously until it's done.", out.color) + '\n');
        out.write(`  Keep going? ${yesNoHint('yes', out.color)} `);
        const ans = await readLine();
        if (parseYesNo(ans, true)) {
          if (await runGoalLoop(line)) break;
        }
        continue;
      }

      // ---- Structured-question turns (ask_user) -------------------------------
      // When the model ended its turn by asking the user a structured question,
      // render the selector, build the deterministic answer line, and resubmit
      // it into the SAME conversation so history replay carries the question +
      // answer forward. The answer turn may itself end in another question; we
      // cap consecutive auto-resubmitted question turns at
      // MAX_CONSECUTIVE_QUESTION_TURNS so a model that keeps asking can't loop
      // forever without the human ever typing.
      let pending = result.final;
      let questionTurns = 0;
      while (
        pending !== undefined &&
        pending.success &&
        pending.questions !== undefined &&
        questionTurns < MAX_CONSECUTIVE_QUESTION_TURNS
      ) {
        const answerLine = await runQuestionSelector(pending.questions, out, readLine);
        // Cancelled every question → submit nothing, return to the prompt.
        if (answerLine === null) break;

        questionTurns++;

        // Reload history (the question turn was persisted by orchestrate) and
        // rebuild deps so the answer turn replays the full thread.
        const answerHistory = await ctx.store.load(convId);
        const answerDeps: OrchestrateDeps = buildDeps(answerHistory);

        const answerAc = new AbortController();
        currentAc = answerAc;
        const answerResult = await runTask(
          answerLine,
          answerDeps,
          out,
          answerAc.signal,
          mutableCtx.config.verbosity ?? 'normal',
        );
        currentAc = null;

        if (shouldExit) {
          loopResult = 'exit';
          break;
        }
        if (shouldMenu) {
          loopResult = 'menu';
          break;
        }

        pending = answerResult.final;
      }
      if (shouldExit) {
        loopResult = 'exit';
        break;
      }
      if (shouldMenu) {
        loopResult = 'menu';
        break;
      }
      if (
        questionTurns >= MAX_CONSECUTIVE_QUESTION_TURNS &&
        pending?.questions !== undefined
      ) {
        out.write(
          '\n[info] The assistant is still asking questions — over to you. Type a reply or /back.\n',
        );
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
  spend: SpendSummary,
  out: OutputSink,
  updateInfo?: UpdateCheckResult,
  claudeTokenInfo?: ClaudeTokenStatus | null,
  runningUnderNpx = false,
  healthIssues: readonly HealthIssue[] = [],
): Promise<void> {
  out.write('\n');

  // Header box — always box(), 🧠 emoji, real provider data.
  // Title carries the live version status so the user always knows whether they
  // are current: "(latest)" when up to date, "→ X.Y.Z available" when not.
  const headerLines = renderHeaderLines(mutableCtx.env, ctx.version, claudeTokenInfo ?? undefined);
  const versionLabel = versionStatusLabel(updateInfo);
  out.write(box(`🧠 myshell-tools v${ctx.version}${versionLabel}`, headerLines) + '\n\n');

  // Update banner — only shown when a newer version is genuinely available.
  if (updateInfo?.updateAvailable === true && updateInfo.latest !== null) {
    if (runningUnderNpx) {
      // Self-update can't persist under npx (it re-serves its own cache next run).
      // Be honest and point to the durable fix instead of a no-op "press u".
      out.write(
        `  ▲ Update available: ${updateInfo.current} → ${updateInfo.latest}\n` +
        `    You're running via npx, so updates won't stick. Install globally to stay current:\n` +
        `      npm install -g myshell-tools@latest\n\n`,
      );
    } else {
      out.write(
        `  ▲ Update available: ${updateInfo.current} → ${updateInfo.latest}  (press u)\n\n`,
      );
    }
  }

  // Health issues — surfaced automatically, only when something is actually
  // wrong (writable/Node/pricing). Silence means healthy; the user never runs a
  // diagnostic command. Errors get ✗, warnings get ⚠️.
  for (const issue of healthIssues) {
    const marker = issue.severity === 'error' ? '✗' : '⚠️ ';
    out.write(`  ${marker} ${issue.message}\n`);
  }
  if (healthIssues.length > 0) out.write('\n');

  // Budget line — real ledger data, never fabricated. The SpendSummary is
  // computed by the caller and cached across keystrokes (the ledger only
  // changes when a task completes), so navigating the menu never re-parses the
  // unbounded ledger.jsonl on every keypress.
  out.write('  ' + renderBudgetLine(spend, out.color) + '\n');

  // Mode line — visible and one keystroke to change (no settings dive). Shows the
  // effective mode: the user's explicit choice, else the subscription-derived auto
  // default. This is the default for NEW chats; each chat can override its own.
  {
    const autoMode = defaultModeForPlan(mutableCtx.env.claude.plan);
    const eff = mutableCtx.config.mode ?? autoMode;
    out.write(
      '  ' +
        dim(
          `Mode: ${modeLabel(eff)}${mutableCtx.config.mode === undefined ? ' (auto)' : ''}  ·  press m to change`,
          out.color,
        ) +
        '\n\n',
    );
  }

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

  // [u] Update now — shown only when a newer version is actually available AND
  // an in-place self-update can persist (not under npx, where it would be a no-op).
  const updateEntry =
    updateInfo?.updateAvailable === true && updateInfo.latest !== null && !runningUnderNpx
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
      { key: '$', label: 'Usage (tokens)', section: 'Options' },
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
  // npx context: real detection from the running script path, or test override.
  const runningUnderNpx =
    ctx.runningUnderNpx !== undefined
      ? ctx.runningUnderNpx
      : isRunningUnderNpx(process.argv[1], process.env);

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
      // Tab-completes slash-commands at the chat prompt. Dormant on non-`/`
      // input and ignored entirely when `terminal` is false (piped/test input).
      completer: (line: string) => completeSlash(line),
    });
    lineReader = createLineReader(rl);
    const reader = lineReader;
    // All prompt text is already written to `out` before readLine() is called.
    readLine = () => reader.nextLine();
  }

  // Single-key yes/no confirm (Enter = default, y/n decide instantly on a TTY)
  // with a line-mode fallback for piped input / tests.
  const confirm = makeConfirm(out, readLine, ctx.confirm);
  // Lets the login flow release stdin while an inherited-stdio child (e.g.
  // `claude auth login`) owns the terminal, then take it back. Returns the
  // resume callback. Only wired for the real reader — the injected/test path
  // shares no stdin, so there is nothing to suspend.
  const readerForSuspend = lineReader;
  const suspendStdin: (() => () => void) | undefined =
    readerForSuspend !== null
      ? () => {
          readerForSuspend.suspend();
          return () => readerForSuspend.resume();
        }
      : undefined;

  // Mutable local copy of config & env — updated as the user changes settings /
  // re-authenticates without mutating the immutable ctx parameter.
  const mutableCtx: { config: AppConfig; env: EnvironmentStatus } = {
    config: ctx.config,
    env: ctx.env,
  };

  try {
    // ---- Update check FIRST (before onboarding) -----------------------------
    // The very first thing each launch is "are you on the latest?" — the explicit
    // ask. On a fresh install of the latest there's nothing to offer, so we fall
    // through to first-run setup; on an outdated install we offer the update up
    // front so you set up on the newest version.
    // Fast path: uses the cache when fresh, so it never hangs. Injected seam keeps
    // tests hermetic (no real npm registry calls).
    let updateInfo: UpdateCheckResult | undefined;
    if (checkForUpdateFn !== undefined) {
      updateInfo = await checkForUpdateFn().catch(() => undefined);
    }

    // ---- Update at launch — check first, then ASK (clean: show the version) --
    // The first thing each launch is an update check. If one is available we tell
    // you the version and ASK before installing — never a silent swap. Power users
    // who never want the prompt can set `autoUpdate: true` to install silently.
    // Skipped under npx (a global install won't be picked up by the next npx run),
    // when updates are off (autoUpdate:false / MYSHELL_NO_UPDATE), and on
    // non-interactive sessions (we never auto-install on an EOF — the menu's
    // banner shows instead).
    if (
      autoUpdateEnabled(mutableCtx.config, process.env) &&
      !runningUnderNpx &&
      updateInfo?.updateAvailable === true &&
      updateInfo.latest !== null &&
      updateSelfFn !== undefined
    ) {
      const fromV = updateInfo.current;
      const toV = updateInfo.latest;
      const doUpdate = updateSelfFn;
      // Install + relaunch; returns true when startMenu should hand off to the new
      // version, false on failure (with an actionable message).
      const install = async (): Promise<boolean> => {
        const ok = await doUpdate(out).catch(() => false);
        if (ok) {
          if (relaunchFn !== undefined) await relaunchFn().catch(() => 1);
          return true;
        }
        out.write(
          `\n  ⚠️  Update to ${toV} didn't complete.\n` +
            `     This is usually a global-install permission issue. Fix it with one of:\n` +
            `       npm install -g myshell-tools@latest\n` +
            `       sudo npm install -g myshell-tools@latest      (macOS/Linux, if you saw EACCES)\n` +
            `     Staying on ${fromV} for now.\n\n`,
        );
        return false;
      };

      if (mutableCtx.config.autoUpdate === true) {
        // Power-user opt-in: install automatically, no prompt.
        out.write(`▲ Auto-updating ${fromV} → ${toV}…  (disable: Settings → Update on launch)\n`);
        if (await install()) return; // handed off to the freshly-installed version
      } else if (out.isTty) {
        // DEFAULT, interactive: name the version and ask.
        out.write(`\n▲ Update available: ${bold(fromV, out.color)} → ${bold(toV, out.color)}\n`);
        out.write(`  Install it now? ${yesNoHint('yes', out.color)} `);
        if (await confirm(true)) {
          out.write(`  Updating to ${toV}…\n`);
          if (await install()) return;
        } else {
          out.write(dim(`  Staying on ${fromV}. (Press u in the menu to update anytime.)\n\n`, out.color));
        }
      }
      // else: default + non-interactive → skip; the menu's update banner remains.
    }

    // ---- First-run welcome (AFTER the update check) -------------------------
    if (!mutableCtx.config.onboarded) {
      mutableCtx.config = await runWelcome(ctx, out, readLine, confirm, suspendStdin, mutableCtx.config, installProviderFn, loginFn, detectEnvironmentFn);
      // Re-detect after onboarding so the first main screen shows the REAL post-login
      // status (e.g. codex now "ready" if the user signed in during setup).
      mutableCtx.env = await detectEnvironmentFn();
    }

    // ---- B. Main screen loop -------------------------------------------------
    // Compute Claude token lifetime once per launch (real disk read, or injected
    // value from ctx for tests). Passed to renderMainScreen so renderHeaderLines
    // stays pure.
    let claudeTokenInfo: ClaudeTokenStatus | null | undefined;
    if (ctx.claudeTokenInfo !== undefined) {
      // Injected by tests (including explicit null to suppress warning).
      claudeTokenInfo = ctx.claudeTokenInfo;
    } else {
      // Real path: load from disk. Never throws; null when no capture date stored.
      const capturedAt = await loadClaudeTokenCapturedAt().catch(() => undefined);
      claudeTokenInfo = claudeTokenStatus(capturedAt, Date.now());
    }

    // Spend summary is cached and only recomputed when the ledger may have
    // changed (after a task runs). Avoids re-reading the unbounded ledger.jsonl
    // on every keystroke — the menu hot path stays O(1) in ledger size.
    let spend = summarizeSpend(await readLedger(ctx.cwd), ctx.clock.isoNow());
    let spendDirty = false;

    while (true) {
      if (spendDirty) {
        spend = summarizeSpend(await readLedger(ctx.cwd), ctx.clock.isoNow());
        spendDirty = false;
      }
      const metas = await ctx.store.list();
      await renderMainScreen(ctx, mutableCtx, metas, spend, out, updateInfo, claudeTokenInfo, runningUnderNpx, ctx.healthIssues ?? []);

      out.write('> ');
      // Single keypress on a real TTY (press the letter, no Enter); line read in
      // pipes/tests. '' = Enter/no-op → re-render; null = Ctrl-C/EOF → exit.
      const key = await readMenuKey(out, readLine);

      // ---- EOF / close — exit gracefully (FIX 1: no ERR_USE_AFTER_CLOSE) ----
      if (key === null) {
        break;
      }

      // ---- Enter / no-op key → just re-render the menu ------------------------
      if (key === '') {
        continue;
      }

      // ---- [q] Quit -----------------------------------------------------------
      if (key === 'q') {
        break;
      }

      // ---- [n] New conversation -----------------------------------------------
      if (key === 'n') {
        // No up-front "name your chat" prompt — a real chat shell just opens and
        // lets you type. The title is derived silently from the first user message
        // (conversations.ts append()), so create an untitled conversation and drop
        // straight into it.
        const meta = await ctx.store.create('');
        const chatResult = await runChatLoop(ctx, mutableCtx, meta.id, out, readLine, loginFn, detectEnvironmentFn, suspendStdin);
        spendDirty = true; // a task may have run — refresh the spend summary
        if (chatResult === 'exit') break;
        continue;
      }

      // ---- [c] Continue most-recent conversation ------------------------------
      if (key === 'c') {
        const all = await ctx.store.list();
        const latest = all[0];
        if (latest !== undefined) {
          const chatResult = await runChatLoop(ctx, mutableCtx, latest.id, out, readLine, loginFn, detectEnvironmentFn, suspendStdin);
          spendDirty = true; // a task may have run — refresh the spend summary
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
          const chatResult = await runChatLoop(ctx, mutableCtx, target.id, out, readLine, loginFn, detectEnvironmentFn, suspendStdin);
          spendDirty = true; // a task may have run — refresh the spend summary
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
        const importResult = await runImportNative(ctx, mutableCtx, out, readLine, loginFn, detectEnvironmentFn, suspendStdin);
        spendDirty = true; // an imported session may run a task — refresh spend
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
        await loginFn(out, 'claude', {
          readLine,
          ...(suspendStdin !== undefined ? { suspendStdin } : {}),
        });
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
          out.write(`Install opencode (${installCommandFor('opencode').replace('npm install -g ', '')})? ${yesNoHint('yes', out.color)} `);
          const ans = await readLine();
          // EOF (null) means no interactive user — never auto-install on a closed
          // pipe. Otherwise honor the (Y/n) default-yes (Enter = install).
          const skip = ans === null || !parseYesNo(ans, true);
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

      // ---- [m] Change mode (direct — no settings dive) ------------------------
      if (key === 'm') {
        const autoMode = defaultModeForPlan(mutableCtx.env.claude.plan);
        mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode);
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
