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
import fs from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import tty from 'node:tty';
import { execa } from 'execa';
import type { Clock, CoreEvent, LedgerWriter, OrchestrateDeps, Question, QuestionSet, SessionEntry, SessionWriter, Tier } from '../core/types.js';
import { buildGoalTask, parseGoalSignal, parseGoalContinueText, decideGoalNext, formatGoalProgress, DEFAULT_MAX_GOAL_ITERATIONS, stripTrailingGoalConfidenceEnvelope } from '../core/goal.js';
import type { GoalCeilings } from '../core/goal.js';
import { appendCheckpointFromContinue, capContract } from '../core/work-contract.js';
import { formatAnswers, isKeepGoingOffer } from '../core/questions.js';
import { decideAutonomyOffer } from '../core/autonomy.js';
import { classify } from '../core/classify.js';
import { resolveMemoryContextDetailed } from '../core/memory-injection.js';
import { buildEnvironmentContext } from '../core/repo-map.js';
import { nodeRepoScanPort } from '../infra/repo-scan.js';
import { createFileUserMemoryStore, resolveProjectKey } from '../infra/user-memory-store.js';
import {
  runRemember,
  runForget,
  runMemoryList,
  runMemoryLoaded,
  runMemoryExport,
  runMemoryApproval,
} from '../commands/memory.js';
import type { UserMemoryFact } from '../core/user-memory.js';
import type { AppConfig } from '../infra/config.js';
import { saveConfig, resolvePartnerStyle } from '../infra/config.js';
import type { PartnerStyle } from '../core/prompt-context.js';
import type { ConversationMeta, ConversationStore } from '../infra/conversation-store.js';
import { readLedger } from '../infra/ledger.js';
import { summarizeSpend, formatTokens } from '../infra/insights.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { detectEnvironment, getInstallCommand } from '../providers/detect.js';
import { installProvider, installCommandFor } from '../providers/install.js';
import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import { listRecentNativeSessions, importNativeSession } from '../providers/native-sessions.js';
import { replitPersistentEnv } from '../infra/credentials.js';
import {
  POLICY_PRESETS,
  modeLabel,
  autoModeForPlanInfos,
  classifyPlan,
  describePlanSet,
  planTierLabel,
  MODE_DESC,
} from '../core/policy.js';
import type { PlanInfo } from '../core/policy.js';
import type { Mode } from '../core/policy.js';
import { planNativeSession } from '../core/native-session.js';
import { availableAfterCooldown, cooldownExpiry } from '../core/cooldown.js';
import { learnProviderOrder } from '../core/routing-memory.js';
import type { OutputSink, Verbosity } from './render.js';
import { renderResumeTranscript, pickCopyText, renderConversationMarkdown } from './render.js';
import { deriveTitleFromRecap, isStubTitle } from '../infra/conversations.js';
import { systemClipboardPort, type ClipboardPort } from '../infra/clipboard.js';
import { resolveStateHome } from '../infra/state-dir.js';
import { runTask } from './run.js';
import { runLogin } from '../commands/login.js';
import type { LoginMethod } from '../commands/login.js';
import { runDoctor } from '../commands/doctor.js';
import { runCost } from '../commands/cost.js';
import { runInstall, isHookInstalled } from '../commands/install.js';
import { box, separator, menu } from '../ui/tui.js';
import { dim, cyan, bold, green, formatRecapLine } from '../ui/theme.js';
import { makeRecapGenerator } from '../core/recap-generator.js';
import { isRecapStale, recapEligible, parseRecap } from '../core/recap.js';
import { createSpinner } from '../ui/spinner.js';
import { makeRouteClassifier } from '../core/route-classifier.js';
import { makeIntentExtractor } from '../core/intent-extractor.js';
import { shouldShowFirstTouch, markSeen, FIRST_TOUCH_LINES } from '../core/first-touch.js';
import { teach } from '../core/teach.js';
import { decideShed, pressureFromSignals } from '../core/capability-budget.js';
import type { UpdateCheckResult } from '../infra/update-check.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import { loadClaudeTokenCapturedAt, claudeTokenStatus } from '../infra/credentials.js';
import type { HealthIssue } from '../infra/health.js';

// ---------------------------------------------------------------------------
// Auto-mode helpers (multi-provider)
// ---------------------------------------------------------------------------

const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * One authenticated provider's classified plan, paired with its display label.
 * The honest unit the Auto decision and the "Auto detected" screen share.
 */
interface ProviderPlanInfo {
  readonly label: string;
  readonly info: PlanInfo;
}

/**
 * Classify the plan of every AUTHENTICATED provider. Providers that are signed
 * out are excluded (they contribute no signal). The result preserves duplicates
 * (multiple Max plans show up as multiple entries) — that is what lets the Auto
 * decision and its reason account for "all of them, and what kind".
 */
function authedProviderPlans(env: EnvironmentStatus): ProviderPlanInfo[] {
  return [env.claude, env.codex, env.opencode]
    .filter((p) => p.authenticated)
    .map((p) => ({
      label: PROVIDER_LABEL[p.id] ?? p.id,
      info: classifyPlan(p.plan),
    }));
}

/**
 * Resolve the auto mode across ALL authenticated providers (strongest KIND wins).
 * Classifies each provider's plan then delegates to autoModeForPlanInfos, so
 * Claude, Codex and opencode subscriptions are all included in the decision.
 */
function resolveAutoMode(env: EnvironmentStatus): Mode {
  return autoModeForPlanInfos(authedProviderPlans(env).map((p) => p.info));
}

function hasAuthenticatedProvider(env: EnvironmentStatus): boolean {
  return env.claude.authenticated || env.codex.authenticated || env.opencode.authenticated;
}

/**
 * Compact reason for the MAIN status line when auto is active. Summarises only
 * the OBSERVED plans (e.g. "auto · 2 Max, 1 Pro"); when no provider reported a
 * plan it stays clean ("auto") rather than nagging "no plan reported" on every
 * screen — the full per-provider story (including who reported nothing) lives on
 * the mode screen's "Auto detected" breakdown, not here.
 */
function autoModeReason(env: EnvironmentStatus): string {
  const observed = authedProviderPlans(env)
    .map((p) => p.info)
    .filter((i) => i.confidence === 'observed');
  return observed.length === 0 ? 'auto' : `auto · ${describePlanSet(observed)}`;
}

/**
 * One-line, per-provider honest description of a classified plan for the
 * "Auto detected" breakdown. Shows the reported tier + the raw label when the
 * CLI gave one, or an explicit "no plan reported" when it didn't — never a guess.
 */
function planLineFor(p: ProviderPlanInfo): string {
  if (p.info.confidence === 'none') {
    return `${p.label} — no plan reported`;
  }
  const tierLabel = planTierLabel(p.info.tier);
  // Show the raw label alongside the tier when they differ (e.g. tier Max,
  // raw "claude_max_20x") so the breakdown is fully traceable.
  const raw = p.info.raw;
  const detail = raw !== null && raw.toLowerCase() !== tierLabel.toLowerCase() ? ` (${raw})` : '';
  return `${p.label} — ${tierLabel}${detail} · observed`;
}

/**
 * Render the "Auto detected" breakdown: every authenticated provider with its
 * classified plan, the resulting mode, and the deciding rule. This is the honest
 * answer to "account for all of them and what kind" — it shows exactly what was
 * detected per provider (including providers that report nothing) and why Auto
 * landed where it did. Returns lines (no trailing newline) for the caller to write.
 */
function renderAutoDetected(env: EnvironmentStatus, color: boolean): string[] {
  const plans = authedProviderPlans(env);
  const mode = autoModeForPlanInfos(plans.map((p) => p.info));
  const lines: string[] = [dim('  Auto detected:', color)];

  if (plans.length === 0) {
    lines.push(dim('    (no providers signed in)', color));
  } else {
    for (const p of plans) {
      lines.push(dim(`    • ${planLineFor(p)}`, color));
    }
  }

  lines.push(
    dim(`    → ${describePlanSet(plans.map((p) => p.info))} ⇒ ${modeLabel(mode)}`, color),
  );
  return lines;
}

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
   * Optional injected clipboard port for `/copy` (real-chat gap #3). When absent,
   * the real {@link systemClipboardPort} (platform shell-out, fail-soft) is used.
   * Tests inject a fake to drive the success/headless-fallback paths hermetically.
   */
  readonly clipboard?: ClipboardPort;
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
      confirm?: Confirm;
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
   * Optional injected active-version reader for testing. Production runs
   * `myshell-tools --version` through the same PATH resolution the relaunch uses.
   *
   * Returns the active binary version, or null when it cannot be verified.
   */
  readonly activeVersion?: () => Promise<string | null>;
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
  /**
   * Optional injected hook-presence check for testing. When provided, `startMenu`
   * uses this instead of the real `isHookInstalled` from commands/install.ts,
   * preventing real rc-file reads during tests (which would find the real hook
   * on a developer machine and desync scripted readers).
   *
   * Defaults to the real check: `() => isHookInstalled(process.env, process.platform)`.
   */
  readonly isHookInstalled?: () => Promise<boolean>;
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
 * the eye lands on the words `yes` / `no`, not the annotation. Three shapes:
 *
 *   - `'yes'`    → default-yes: Enter or `y` confirms.   →  `yes (enter) / no`
 *   - `'no'`     → default-no (opt-in): Enter declines.  →  `yes / no (enter)`
 *   - `'strict'` → no default (sensitive/destructive):   →  `yes (y) / no (n)`
 *                  the user must press `y` or `n`; Enter does nothing.
 *
 * Enter means yes for the helpful, reversible defaults; the few invasive/opt-in
 * choices use `'no'` so we never change the user's environment on a reflexive
 * Enter; destructive actions use `'strict'`.
 */
export function yesNoHint(mode: 'yes' | 'no' | 'strict', color: boolean): string {
  const d = (s: string): string => dim(s, color);
  if (mode === 'strict') return `yes ${d('(y)')} / no ${d('(n)')}`;
  if (mode === 'no') return `yes / no ${d('(enter)')}`;
  return `yes ${d('(enter)')} / no`;
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
 * The slash-commands available at the chat prompt — the canonical command set
 * (Tab T1, docs/tab-completion-5.5.md). Tab-completion offers exactly these;
 * keep in sync with the dispatch in `runOneChatInput` (/retry, /edit, /style,
 * /mode, /goal, /recap, /remember, /forget, /memory, /help, /back, /exit).
 * Ordered most-used first.
 */
export const CHAT_SLASH_COMMANDS: readonly string[] = [
  '/help',
  '/retry',
  '/edit',
  '/style',
  '/mode',
  '/goal',
  '/recap',
  '/copy',
  '/export',
  '/remember',
  '/forget',
  '/memory',
  '/back',
  '/exit',
];

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

// ===========================================================================
// Smart Tab completion T2–T4 (docs/tab-completion-5.5.md).
//
// A pure dispatcher `classifyCompletion` inspects the line and routes Tab to
// one of: slash-name (T1), slash-ARGUMENT (T2), file/PATH or @-MENTION (T3),
// with FUZZY ranking (T4) layered over slash-name/arg. The single impure
// async completer `completeChat` composes these over an injected `fs.readdir`
// port so unit tests stay filesystem-free. No model call: instant, local,
// deterministic. Plain prose → strict no-op (never corrupt a sentence).
// ===========================================================================

/**
 * Per-command argument candidate sets for slash-argument completion (T2).
 * Keyed by the canonical command. A command absent from this map (or mapped to
 * `null`) takes FREE-TEXT args and is never completed — e.g. `/goal` (a goal
 * sentence) and `/remember`/`/forget`/`/edit` (free text / numeric id), so Tab
 * never mangles them. The values are the user-facing labels accepted by the
 * dispatch (`/mode` → the tiers, `/style` → the styles, `/memory` → its
 * subcommands).
 */
export const CHAT_SLASH_ARG_MAP: Readonly<Record<string, readonly string[]>> = {
  '/mode': ['Efficient', 'Balanced', 'Max'],
  '/style': ['Direct', 'Balanced', 'Collaborative'],
  '/memory': ['list', 'all', 'loaded', 'export', 'edit'],
};

/** A classified Tab-completion request. PURE output of {@link classifyCompletion}. */
export type CompletionKind = 'slash-name' | 'slash-arg' | 'path' | 'mention' | 'none';
export interface Completion {
  readonly kind: CompletionKind;
  /** For 'slash-arg': the canonical command (e.g. '/mode'). */
  readonly command?: string;
  /** The trailing token the candidates are matched against (the readline `substring`). */
  readonly token: string;
  /** Index where the trailing token starts in `line` (so `substring` covers exactly it). */
  readonly prefixLen: number;
}

/** True when a token looks like a filesystem path (conservative — drives prose no-op). */
function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  return (
    token.startsWith('./') ||
    token.startsWith('../') ||
    token.startsWith('/') ||
    token.startsWith('~/') ||
    token === '~' ||
    token === '.' ||
    token === '..' ||
    // An embedded slash anywhere (e.g. `src/inter`) — a clear path signal, but
    // NOT a bare slash-command (handled separately) and NOT plain prose.
    (token.includes('/') && !token.startsWith('/'))
  );
}

/**
 * Pure dispatcher: classify the trailing token of `line` into a completion kind.
 *
 * The single load-bearing safety property is that ordinary prose returns
 * `kind: 'none'` — only a clear signal (`/` command, a path-shaped token, or a
 * leading `@`) routes to an active completer. PURE; never throws.
 */
export function classifyCompletion(
  line: string,
  argMap: Readonly<Record<string, readonly string[]>> = CHAT_SLASH_ARG_MAP,
): Completion {
  const text = typeof line === 'string' ? line : '';
  // The trailing token = text after the last whitespace run.
  const lastWs = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\t'));
  const token = lastWs === -1 ? text : text.slice(lastWs + 1);
  const prefixLen = lastWs === -1 ? 0 : lastWs + 1;

  // @-mention: trailing token starts with '@' (Claude-Code-style file mention).
  if (token.startsWith('@')) {
    return { kind: 'mention', token, prefixLen };
  }

  // Slash command name vs argument. A slash only counts when it's the FIRST
  // token of the line (a leading-`/` line); a mid-sentence `/` is prose/path.
  const trimmedStart = text.replace(/^\s+/, '');
  if (trimmedStart.startsWith('/')) {
    const firstSpace = text.search(/\s/);
    if (firstSpace === -1) {
      // No space yet → completing the command NAME itself.
      return { kind: 'slash-name', token: text, prefixLen: 0 };
    }
    // There is a space → completing the ARGUMENT of a known command.
    const command = text.slice(0, firstSpace);
    if (Object.prototype.hasOwnProperty.call(argMap, command)) {
      return { kind: 'slash-arg', command, token, prefixLen };
    }
    // Known-shaped but free-text / unknown command arg → no completion.
    return { kind: 'none', token, prefixLen };
  }

  // File/path token.
  if (looksLikePath(token)) {
    return { kind: 'path', token, prefixLen };
  }

  // Plain prose → strict no-op.
  return { kind: 'none', token, prefixLen };
}

/**
 * Complete a slash command's ARGUMENT from its candidate set (T2). PURE.
 *
 * Returns the candidates matching `partial` (fuzzy: prefix first, then
 * substring/subsequence). A command with no arg set (free text) → `[]`, so a
 * `/goal <sentence>` is never mangled.
 */
export function completeSlashArg(
  command: string,
  partial: string,
  argMap: Readonly<Record<string, readonly string[]>> = CHAT_SLASH_ARG_MAP,
): string[] {
  const candidates = argMap[command];
  if (candidates === undefined) return [];
  return fuzzyRank(partial, candidates);
}

/**
 * Rank `candidates` against `partial` (T4 fuzzy). PURE; case-insensitive.
 *
 * Order: exact-prefix matches first (so readline's longest-common-prefix
 * insertion works), then substring matches, then subsequence matches. Within a
 * tier the original candidate order is preserved (stable). An empty `partial`
 * returns all candidates unchanged; no match → `[]`.
 */
export function fuzzyRank(partial: string, candidates: readonly string[]): string[] {
  const list = Array.isArray(candidates) ? candidates.filter((c) => typeof c === 'string') : [];
  const p = (partial ?? '').toLowerCase();
  if (p.length === 0) return [...list];
  const prefix: string[] = [];
  const substr: string[] = [];
  const subseq: string[] = [];
  for (const c of list) {
    const lc = c.toLowerCase();
    if (lc.startsWith(p)) prefix.push(c);
    else if (lc.includes(p)) substr.push(c);
    else if (isSubsequence(p, lc)) subseq.push(c);
  }
  return [...prefix, ...substr, ...subseq];
}

/** True when `needle`'s chars appear in `hay` in order (gaps allowed). PURE. */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Split a path-ish token into the directory to `readdir`, the basename prefix to
 * filter by, and the display prefix to re-prepend to each hit. PURE — does all
 * the `~`/`cwd` math but touches NO filesystem. Handles a leading `@` mention by
 * carrying it in `displayPrefix` (so the completed mention stays well-formed).
 *
 * @param token the trailing token (may start with `@`, `~/`, `./`, `../`, `/`)
 * @param home  the home directory used for `~` expansion (defaults to os.homedir)
 * @param cwd   the directory relative paths resolve against (defaults to cwd)
 */
export function expandPathToken(
  token: string,
  home: string = os.homedir(),
  cwd: string = process.cwd(),
): { dir: string; base: string; displayPrefix: string } {
  let raw = token;
  let mention = '';
  if (raw.startsWith('@')) {
    mention = '@';
    raw = raw.slice(1);
  }
  // Split into the typed directory portion and the basename fragment.
  const slash = raw.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : raw.slice(0, slash + 1); // includes trailing '/'
  const base = slash === -1 ? raw : raw.slice(slash + 1);
  // displayPrefix is exactly what the user typed up to the basename — we
  // re-prepend it to each hit so readline's `substring` (the whole token) is
  // replaced by a well-formed token.
  const displayPrefix = mention + dirPart;

  // Resolve the directory to actually read.
  let resolveBase: string;
  if (dirPart.startsWith('~')) {
    // ~ or ~/...  → expand home for the fs read only.
    const afterTilde = dirPart.slice(1); // '' or '/...'
    resolveBase = join(home, afterTilde.replace(/^\//, ''));
  } else if (dirPart.startsWith('/')) {
    resolveBase = dirPart;
  } else {
    resolveBase = join(cwd, dirPart);
  }
  // Normalize away a trailing slash (except the filesystem root) so `dir` is a
  // clean directory path for `readdir`.
  resolveBase = resolveBase.length > 1 ? resolveBase.replace(/\/+$/, '') : resolveBase;
  const dir = resolveBase === '' ? cwd : resolveBase;
  return { dir, base, displayPrefix };
}

/**
 * Filter+sort a `readdir` result against a basename prefix (T3). PURE.
 *
 * `entries` is the raw `readdir(..., {withFileTypes:true})` output (or plain
 * names). Directory hits get a trailing `/` and sort before files. Fuzzy:
 * prefix first, then substring. Hidden entries (dot-files) are only shown when
 * the basename itself starts with `.`. Capped at `limit` to avoid flooding.
 */
export function matchPathEntries(
  base: string,
  entries: readonly PathEntry[],
  limit = 50,
): string[] {
  const wantHidden = base.startsWith('.');
  const dirs: { name: string; rank: number }[] = [];
  const files: { name: string; rank: number }[] = [];
  const b = base.toLowerCase();
  for (const e of entries) {
    const name = typeof e === 'string' ? e : e?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (!wantHidden && name.startsWith('.')) continue;
    const ln = name.toLowerCase();
    let rank: number;
    if (b.length === 0) rank = 0;
    else if (ln.startsWith(b)) rank = 0;
    else if (ln.includes(b)) rank = 1;
    else continue;
    const isDir = typeof e !== 'string' && (e?.isDirectory?.() ?? false);
    (isDir ? dirs : files).push({ name: isDir ? `${name}/` : name, rank });
  }
  const byRankThenName = (
    x: { name: string; rank: number },
    y: { name: string; rank: number },
  ): number => (x.rank !== y.rank ? x.rank - y.rank : x.name.localeCompare(y.name));
  dirs.sort(byRankThenName);
  files.sort(byRankThenName);
  return [...dirs, ...files].slice(0, limit).map((h) => h.name);
}

/** A `readdir` entry: a bare name or a `Dirent`-like object. */
export type PathEntry = string | { name: string; isDirectory?: () => boolean };

/** Injected ports for the impure {@link completeChat} — defaults to real fs/cwd. */
export interface CompleteChatDeps {
  /** Lists a directory; should resolve to Dirent-like entries. Errors → no completions. */
  readdir: (dir: string) => Promise<PathEntry[]>;
  cwd: string;
  home: string;
  commands: readonly string[];
  argMap: Readonly<Record<string, readonly string[]>>;
}

const defaultCompleteChatDeps = (): CompleteChatDeps => ({
  readdir: (dir: string) => fs.promises.readdir(dir, { withFileTypes: true }),
  cwd: process.cwd(),
  home: os.homedir(),
  commands: CHAT_SLASH_COMMANDS,
  argMap: CHAT_SLASH_ARG_MAP,
});

/**
 * The single async completer for the chat prompt (T2–T4). Composes the pure
 * seams over an injected `readdir` port. Returns the Node readline
 * `[completions, substring]` pair where `substring` is the trailing token so
 * readline replaces only that token. FAIL-SOFT: a throwing/rejecting `readdir`
 * (or any error) degrades to the safe no-op `[[], line]` — never throws.
 */
export async function completeChat(
  line: string,
  deps: Partial<CompleteChatDeps> = {},
): Promise<[string[], string]> {
  try {
    const d = { ...defaultCompleteChatDeps(), ...deps };
    const c = classifyCompletion(line, d.argMap);
    switch (c.kind) {
      case 'none':
        return [[], line];
      case 'slash-name': {
        const hits = fuzzyRank(c.token.slice(1), d.commands.map((x) => x.slice(1)));
        // Re-prepend '/'; preserve "bare slash lists all" via completeSlash for
        // the exact-prefix case so today's contract is unchanged.
        const [prefixHits] = completeSlash(line, d.commands);
        const ranked = prefixHits.length > 0 ? prefixHits : hits.map((h) => `/${h}`);
        return [ranked, line];
      }
      case 'slash-arg': {
        const hits = completeSlashArg(c.command ?? '', c.token, d.argMap);
        return [hits, c.token];
      }
      case 'path':
      case 'mention': {
        const { dir, base, displayPrefix } = expandPathToken(c.token, d.home, d.cwd);
        let entries: PathEntry[];
        try {
          entries = await d.readdir(dir);
        } catch {
          return [[], line]; // fail-soft: readdir error → no completions
        }
        const hits = matchPathEntries(base, entries).map((h) => displayPrefix + h);
        return [hits, c.token];
      }
      default:
        return [[], line];
    }
  } catch {
    return [[], line];
  }
}

// ---------------------------------------------------------------------------
// /retry + /edit — message-level redo (real-chat gap #2). The truncate POINTS
// are computed by these PURE helpers so they're hermetically testable; the menu
// applies them via the store's controlled `truncateAfter` and re-runs the turn.
// ---------------------------------------------------------------------------

/**
 * Plan a `/retry` from a loaded conversation log.
 *
 * Finds the LAST user message whose turn produced an answer (i.e. there is at
 * least one assistant entry after it), then returns the truncation point and the
 * user line to replay: keep everything BEFORE that user message (`keepCount`),
 * drop the user message AND the assistant answer(s) that followed, and re-run
 * `replayLine`. The user message is dropped from the kept prefix because the
 * re-run re-appends it via orchestrate — keeping it too would duplicate the user
 * turn. System control entries are ignored when deciding "was there an answer."
 *
 * Returns null when there is nothing to retry — an empty log, or a log whose tail
 * is a user message with no assistant answer yet (the turn is still the user's).
 * PURE; never throws.
 */
export function planRetryTruncation(
  entries: readonly SessionEntry[],
): { readonly keepCount: number; readonly replayLine: string } | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // Walk back to the last assistant entry (the answer we'd regenerate).
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return null; // no answer to retry
  // The user message that PROMPTED that answer is the last user entry before it.
  let userIdx = -1;
  for (let i = lastAssistant - 1; i >= 0; i--) {
    if (entries[i]?.role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx === -1) return null; // answer with no preceding user turn
  const replayLine = entries[userIdx]?.content ?? '';
  if (replayLine.trim().length === 0) return null;
  // Keep everything BEFORE the user message; it (and the answer after it) are
  // dropped, because the re-run re-appends the user turn via orchestrate.
  return { keepCount: userIdx, replayLine };
}

/** A recent user message offered in the `/edit` picker — its log index + text. */
export interface EditableUserMessage {
  /** The entry's index in the full loaded log (the truncate boundary basis). */
  readonly index: number;
  /** The user message body. */
  readonly content: string;
}

/**
 * The recent USER messages eligible for `/edit`, most-recent first, bounded to
 * `max`. Empty-bodied and non-user entries are skipped. PURE; never throws.
 */
export function recentUserMessages(
  entries: readonly SessionEntry[],
  max = 8,
): EditableUserMessage[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const out: EditableUserMessage[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < Math.max(1, max); i--) {
    const e = entries[i];
    if (e?.role === 'user' && e.content.trim().length > 0) {
      out.push({ index: i, content: e.content });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// /copy + /export — real-chat gap #3 (local-only, fail-soft). The dispatch is a
// thin wrapper over these testable helpers so the clipboard/fs I/O is injected.
// ---------------------------------------------------------------------------

/** A short, deterministic, fs-safe slug for an export filename. PURE. */
export function exportFileSlug(title: string | undefined): string {
  const base = (typeof title === 'string' ? title : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'conversation';
}

export interface CopyCommandInput {
  readonly entries: readonly SessionEntry[];
  readonly out: OutputSink;
  /** Injected clipboard port (real one shells out; tests inject a fake). */
  readonly clipboard: ClipboardPort;
}

/**
 * Run `/copy`: pick the last assistant answer (stripped), try the injected
 * clipboard port, and on success print a confirmation. On a headless host (no
 * clipboard tool → port returns false) print an honest "clipboard unavailable —
 * here's the text:" fallback block the user can mouse-select. When there is
 * nothing to copy, print a gentle notice. Fully fail-soft — never throws.
 */
export async function runCopyCommand(input: CopyCommandInput): Promise<void> {
  const { out } = input;
  const text = pickCopyText(input.entries);
  if (text === null) {
    out.write(dim('  Nothing to copy yet — ask me something first.\n', out.color));
    return;
  }
  let ok = false;
  try {
    ok = await input.clipboard(text);
  } catch {
    ok = false; // a misbehaving port must still reach the fallback, never crash
  }
  if (ok) {
    out.write(dim('  Copied my last answer to your clipboard.\n', out.color));
    return;
  }
  // Headless / no clipboard tool: be honest and print the text to select.
  out.write(
    dim("  Clipboard unavailable here — here's the text to select:\n\n", out.color) +
      text +
      '\n',
  );
}

export interface ExportCommandInput {
  readonly meta: { readonly title?: string } | undefined;
  readonly entries: readonly SessionEntry[];
  readonly out: OutputSink;
  /** Absolute path to write the Markdown transcript to. */
  readonly path: string;
  /** Injected file writer (so the command is testable without disk). */
  readonly writeFile: (path: string, data: string) => Promise<void>;
}

/**
 * Run `/export`: render the conversation to Markdown via the pure
 * `renderConversationMarkdown` seam and write it to `path` through the injected
 * writer (mirrors `/memory export`). Prints the path on success, a gentle note
 * on failure. Fail-soft — never throws.
 */
export async function runExportCommand(input: ExportCommandInput): Promise<void> {
  const { out } = input;
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    out.write(dim('  Nothing to export yet — this conversation is empty.\n', out.color));
    return;
  }
  const md = renderConversationMarkdown(input.meta ?? {}, input.entries);
  try {
    await input.writeFile(input.path, md);
    out.write(dim(`  Exported this conversation to ${input.path}\n`, out.color));
  } catch {
    out.write(dim(`  Couldn't write the export to ${input.path} just now.\n`, out.color));
  }
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
export function renderBudgetLine(spend: SpendSummary, _color: boolean): string {
  if (spend.calls === 0) {
    return 'No runs yet — press n to start';
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

// ---------------------------------------------------------------------------
// Post-turn ordering — the one canonical sequence (MASTER-PLAN MF3)
// ---------------------------------------------------------------------------

/**
 * One action in the canonical post-turn sequence. See {@link decidePostTurn}.
 *
 *   - `discard-typeahead` — drop lines typed during the turn (they never saw the
 *     selector that may follow), always emitted before any selector.
 *   - `question-flow` — run the `ask_user` structured-question selector.
 *   - `memory-approval` — run the `remember_user` Save/Skip/Edit selector
 *     (Phase 5; a no-op stub until then).
 *   - `drain-queue` — run queued chat lines as the next turns, FIFO.
 */
export type PostTurnAction =
  | 'discard-typeahead'
  | 'question-flow'
  | 'memory-approval'
  | 'drain-queue';

/** Inputs to {@link decidePostTurn} — see MASTER-PLAN MF3. */
export interface PostTurnInputs {
  /** `final.questions` present (the model asked a structured question). */
  readonly hasQuestions: boolean;
  /** `final.memoryProposal` present AND passed the worth gate (Phase 5). */
  readonly hasMemoryProposal: boolean;
  /** Chat-turn queue length (lines typed-ahead during the turn). */
  readonly queuedCount: number;
  /** Whether ESC or Ctrl+C cancelled this turn. */
  readonly interrupted: boolean;
}

/**
 * The single canonical post-turn sequence (red-team Axis-9 / MASTER-PLAN MF3).
 * Returns the ordered actions to perform after a turn settles. PURE +
 * table-tested. chat-ux owns the implementation; memory and question flow both
 * route through it so a queued line can NEVER answer an unseen selector.
 *
 *   settle
 *     → discard queued typeahead            (always, before any selector)
 *     → IF hasQuestions: question-flow      (mutually exclusive with memory-approval per turn)
 *     → ELSE IF hasMemoryProposal: memory-approval
 *     → drain-queue                         (only if NOT interrupted; interrupt discards)
 *
 * Rules: a selector is never fed a queued line (`discard-typeahead` always
 * precedes it). On interrupt, the queue is discarded and not drained.
 * `question-flow` and `memory-approval` never both run in one turn (the model
 * never emits `ask_user` alongside `remember_user` — memory doc §8).
 *
 * Pure — never throws, no I/O, no side effects.
 */
export function decidePostTurn(inputs: PostTurnInputs): readonly PostTurnAction[] {
  const actions: PostTurnAction[] = [];
  // Always discard typed-ahead lines first: they were entered before any
  // selector below was rendered, so they must never be misread as answers.
  actions.push('discard-typeahead');

  if (inputs.hasQuestions) {
    actions.push('question-flow');
  } else if (inputs.hasMemoryProposal) {
    actions.push('memory-approval');
  }

  // Drain the queue only on a clean settle AND when the turn did NOT end in a
  // structured question. When questions are present the answer turn re-enters
  // the loop and the queued lines were discarded above (they never saw the
  // selector) — so there is nothing to drain (MASTER-PLAN MF3 table row 2). An
  // interrupt (ESC / Ctrl+C) likewise means "stop": the queue is discarded, not
  // drained.
  if (!inputs.interrupted && !inputs.hasQuestions) {
    actions.push('drain-queue');
  }

  return actions;
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
export interface LineReader {
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
  /**
   * Begin capturing lines typed DURING a model turn (typed-ahead queueing). While
   * a capture is active, every non-blank line goes to `onLine` instead of the
   * `nextLine()` buffer/waiters, so mid-turn input can NEVER leak into a later
   * question/auth/menu prompt or auto-answer an unseen selector. Returns a detach
   * function; call it (in a `finally`) when the turn settles.
   *
   * Exclusive: throwing if a capture is already active is a real-bug guard — two
   * concurrent owners of mid-turn input would be a logic error.
   */
  beginCapture(onLine: (line: string) => void): () => void;
  /**
   * Remove and return any lines buffered by `nextLine()` (incidental stale input,
   * e.g. a stray Enter) so a selector or child handoff starts from a clean slate.
   */
  drainBuffered(): string[];
  /** Drop any buffered lines without returning them. */
  clearBuffered(): void;
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
  let suppressEmptyUntil = 0;
  let suppressGeneration = 0;
  // When non-null, a model turn is active and full lines typed mid-turn are
  // routed here (typed-ahead capture) instead of the nextLine() buffer/waiters.
  // This keeps mid-turn input out of question/auth/menu prompts entirely.
  let capture: ((line: string) => void) | null = null;

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    if (line === '' && Date.now() <= suppressEmptyUntil) {
      // Some inherited-stdio CLIs leave the submit Enter queued as they exit.
      // Drop only that immediate blank line so the next prompt is not auto-answered.
      // The blank-line suppression intentionally wins over capture: a leftover
      // submit Enter must never be queued as a typed-ahead turn.
      suppressEmptyUntil = 0;
      suppressGeneration += 1;
      return;
    }
    suppressEmptyUntil = 0;
    suppressGeneration += 1;
    if (capture !== null) {
      // Mid-turn typed-ahead. Blank lines are dropped (a bare Enter is not a
      // queued turn); non-blank lines go to the capture sink, never to the
      // buffer/waiters. This is the single line-mode owner — no second
      // stdin.on('data') consumer is added.
      if (line !== '') capture(line);
      return;
    }
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
      // Drop any line we'd already buffered (e.g. a stray Enter) so it can't bleed
      // into the next prompt after the child exits.
      buffered.length = 0;
      // NOTE: we deliberately do NOT call stdin.read() to "drain" here. On a TTY,
      // read() can leave a pending libuv read on fd0 that competes with the
      // inherited child — siphoning off the first chunk of a paste so it reaches
      // the child split/truncated (seen as claude's "Invalid code" / a paste
      // landing in the wrong spot in its TUI). Just pause; the child owns fd0.
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
      if (input.isTTY === true) {
        suppressEmptyUntil = Date.now() + 250;
        const generation = suppressGeneration;
        setTimeout(() => {
          if (suppressGeneration === generation) {
            suppressEmptyUntil = 0;
            buffered.length = 0;
          }
        }, 250).unref?.();
      }
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
    beginCapture(onLine: (line: string) => void): () => void {
      // Exclusive: a second concurrent capture owner would be a real bug (two
      // turns claiming mid-turn input at once). Throw rather than silently steal.
      if (capture !== null) {
        throw new Error('createLineReader: capture already active');
      }
      capture = onLine;
      let detached = false;
      return (): void => {
        if (detached) return;
        detached = true;
        // Only clear OUR capture — never another owner's (defensive against an
        // out-of-order detach).
        if (capture === onLine) capture = null;
      };
    },
    drainBuffered(): string[] {
      const drained = buffered.slice();
      buffered.length = 0;
      return drained;
    },
    clearBuffered(): void {
      buffered.length = 0;
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

let controllingTtyInput: KeyInputStream | null | undefined;

function canReadRawKey(out: OutputSink, stdin: KeyInputStream): boolean {
  return out.isTty && stdin.isTTY === true && typeof stdin.setRawMode === 'function';
}

function controllingTtyRawInput(out: OutputSink): KeyInputStream | null {
  if (!out.isTty || process.platform === 'win32') return null;
  if (controllingTtyInput !== undefined) return controllingTtyInput;
  try {
    const fd = fs.openSync('/dev/tty', 'r');
    controllingTtyInput = new tty.ReadStream(fd) as unknown as KeyInputStream;
  } catch {
    controllingTtyInput = null;
  }
  return controllingTtyInput;
}

function rawKeyInputs(
  out: OutputSink,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
): KeyInputStream[] {
  if (!out.isTty) return [];
  if (canReadRawKey(out, stdin)) return [stdin];
  const fallback = controllingTtyRawInput(out);
  return fallback !== null && canReadRawKey(out, fallback) ? [fallback] : [];
}

export function normalizeMenuKey(input: string | null): string | null {
  if (input === null) return null;
  return input.trim().toLowerCase();
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
    let settled = false;

    const onData = (buf: Buffer): void => {
      restore();
      resolve(buf.toString('utf8'));
    };
    const onClose = (): void => {
      restore();
      reject(new Error('stdin closed while waiting for a keypress'));
    };
    const onError = (err: Error): void => {
      restore();
      reject(err);
    };

    function restore(): void {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData as (...a: never[]) => void);
      stdin.removeListener('end', onClose as (...a: never[]) => void);
      stdin.removeListener('close', onClose as (...a: never[]) => void);
      stdin.removeListener('error', onError as (...a: never[]) => void);
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
      stdin.on('end', onClose as (...a: never[]) => void);
      stdin.on('close', onClose as (...a: never[]) => void);
      stdin.on('error', onError as (...a: never[]) => void);
    } catch (err) {
      restore();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * A keypress event object as emitted by `readline.emitKeypressEvents`. `name`
 * is the logical key (`'escape'`, `'up'`, …); `sequence` is the raw bytes. We
 * declare the slice we read so a fake can drive the listener without a real TTY.
 */
export interface KeypressEvent {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * Attach a SCOPED key listener for the duration of one streaming model turn.
 *
 * Semantics (chat-ux audit §"ESC Interrupt"): the only key it acts on is a bare
 * ESC, which calls `onEscape()` — "interrupt this turn and stay at the chat
 * prompt". It OBSERVES esc only; every printable byte, arrow/function-key escape
 * sequence, Enter, and Ctrl+C is left untouched so line buffering stays owned by
 * readline (no double-submit / stolen-byte class of bug).
 *
 * 3.12.x coexistence — this is a deliberately narrow, non-destructive listener:
 *   - It uses ONLY the given `stdin` (default `process.stdin`); it never reaches
 *     for `/dev/tty` (a second mid-turn reader would violate the single-owner rule).
 *   - It NEVER calls `removeAllListeners`, never `stdin.read()`, never `suspend()`/
 *     `resume()`. It adds exactly one `keypress` listener and removes only that
 *     listener on detach.
 *   - It records `wasRaw`; if raw mode was not already on it enables it for the
 *     turn and restores the prior state on detach. In normal terminal-readline
 *     mode raw is already on, so this is a no-op and ownership stays with readline.
 *   - Off-TTY (no `out.isTty` / `stdin.isTTY` / `setRawMode`) it returns a no-op
 *     detach immediately, so normal line input keeps working unchanged. Mid-turn
 *     interruption is then covered by Ctrl+C / direct helper tests.
 *
 * Returns a detach function; wrap the turn in `try/finally` so detach always runs.
 *
 * @param out     - Output sink (used only for the TTY capability check).
 * @param stdin   - The key stream (injectable for tests; default `process.stdin`).
 * @param onEscape - Invoked once per bare-ESC press while attached.
 */
export function attachChatTurnKeyListener(
  out: OutputSink,
  stdin: KeyInputStream = process.stdin as unknown as KeyInputStream,
  onEscape: () => void = (): void => {},
): () => void {
  // Degrade cleanly off-TTY: no raw keypresses available → no-op detach. Normal
  // line input (and Ctrl+C) keep working; ESC simply isn't observed.
  if (!out.isTty || stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') {
    return (): void => {};
  }

  // Make readline-style keypress events flow from this stream. Idempotent — safe
  // to call alongside the live readline interface, which already enables them.
  try {
    readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadableStream);
  } catch {
    // If keypress events can't be enabled, fall back to a no-op rather than a
    // raw 'data' parser (which could steal/duplicate bytes from readline).
    return (): void => {};
  }

  const wasRaw = stdin.isRaw === true;
  try {
    if (!wasRaw) stdin.setRawMode(true);
  } catch {
    // Raw mode unavailable → don't risk a half-attached listener; no-op.
    return (): void => {};
  }

  const handler = (str: string | undefined, key: KeypressEvent | undefined): void => {
    // Observe ONLY a bare ESC. A bare ESC arrives as name 'escape' with sequence
    // '\x1b'; arrow/function keys ('up', 'f1', …) carry a longer '\x1b[…' sequence
    // and must be ignored. interpretChatKey is the single classification truth.
    const seq = key?.sequence ?? str ?? '';
    const isBareEscape = key?.name === 'escape' && seq === '\x1b';
    if (!isBareEscape) return;
    onEscape();
  };

  stdin.on('keypress', handler as (...a: never[]) => void);

  let detached = false;
  return (): void => {
    if (detached) return;
    detached = true;
    // Remove ONLY our listener — never removeAllListeners (that destructive
    // pattern is safe only for the isolated readSingleKey prompt).
    stdin.removeListener('keypress', handler as (...a: never[]) => void);
    // Restore only the raw-mode state we changed. If readline already owned raw
    // mode, leave it; we never took ownership.
    if (!wasRaw) {
      try {
        if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      } catch {
        /* best-effort — never throw on mode restore */
      }
    }
  };
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
  const inputs = rawKeyInputs(out, stdin);
  if (inputs.length === 0) return normalizeMenuKey(await readLine());
  for (const input of inputs) {
    try {
      const raw = await readSingleKey(input);
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
      // Try the next raw-capable stream, then fall back to a normalized line.
    }
  }
  return normalizeMenuKey(await readLine());
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

  return async (defaultYes: boolean, opts?: { requireExplicit?: boolean }): Promise<boolean> => {
    const requireExplicit = opts?.requireExplicit ?? false;
    for (const input of rawKeyInputs(out)) {
      try {
        return await confirmViaKey(out, defaultYes, input, requireExplicit);
      } catch {
        // Any raw-mode hiccup must never break onboarding — try the fallback TTY,
        // then fall back to a line.
      }
    }
    return parseYesNo(normalizeMenuKey(await readLine()), defaultYes, requireExplicit);
  };
}

async function promptForAuthBeforeChat(
  out: OutputSink,
  readLine: () => Promise<string | null>,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: {
      method?: LoginMethod;
      readLine?: () => Promise<string | null>;
      suspendStdin?: () => () => void;
      confirm?: Confirm;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  confirm: Confirm,
  suspendStdin?: () => () => void,
): Promise<boolean> {
  if (hasAuthenticatedProvider(mutableCtx.env)) return true;

  const choices: Array<{ key: 'j' | 'k' | 'o'; id: ProviderId; label: string }> = [];
  if (mutableCtx.env.claude.installed) choices.push({ key: 'j', id: 'claude', label: 'Claude' });
  if (mutableCtx.env.codex.installed) choices.push({ key: 'k', id: 'codex', label: 'Codex' });
  if (mutableCtx.env.opencode.installed) choices.push({ key: 'o', id: 'opencode', label: 'opencode' });

  if (choices.length === 0) {
    out.write('\nNo provider signed in yet, and no provider is installed. Install one from the Auth section first.\n');
    return false;
  }

  if (choices.length === 1) {
    const onlyChoice = choices[0];
    if (onlyChoice === undefined) return false;
    out.write(`\nNo provider signed in yet. Signing in to ${onlyChoice.label}...\n`);
    await loginFn(out, onlyChoice.id, {
      readLine,
      confirm,
      ...(suspendStdin !== undefined ? { suspendStdin } : {}),
    });
    mutableCtx.env = await detectEnvironmentFn();
    if (hasAuthenticatedProvider(mutableCtx.env)) return true;
    out.write('No provider is signed in yet. Returning to menu.\n');
    return false;
  }

  const choiceText = choices.map((c) => `[${c.key}] ${c.label}`).join('  ');
  out.write(`\nNo provider signed in yet. Sign in now? ${choiceText}  [Enter] back\n> `);
  const key = await readMenuKey(out, readLine);
  if (key === null || key.length === 0) return false;

  const choice = choices.find((c) => c.key === key);
  if (choice === undefined) {
    out.write('Cancelled.\n');
    return false;
  }

  await loginFn(out, choice.id, {
    readLine,
    confirm,
    ...(suspendStdin !== undefined ? { suspendStdin } : {}),
  });
  mutableCtx.env = await detectEnvironmentFn();

  if (hasAuthenticatedProvider(mutableCtx.env)) return true;

  out.write('No provider is signed in yet. Returning to menu.\n');
  return false;
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
      confirm?: Confirm;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
): Promise<AppConfig> {
  // Use the mutable env so re-detection after installs is visible downstream.
  let env = ctx.env;

  const headerLines = renderHeaderLines(env, ctx.version);
  out.write('\n' + box(`myshell-tools v${ctx.version} — Setup`, headerLines) + '\n\n');

  // ---- Orientation header --------------------------------------------------
  out.write('Quick setup — a few questions, ~30 seconds. Press Enter for the default (marked (enter)), or y / n.\n\n');

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
      const resumeStdin = suspendStdin?.();
      let ok = false;
      try {
        ok = await installProviderFn(id, out);
      } finally {
        resumeStdin?.();
      }
      if (ok) {
        didInstallAny = true;
      }
    } else {
      out.write(`Skipping ${id} install. Install later: ${installCommandFor(id)}\n`);
    }
  }

  // ---- Re-detect if anything was installed so sign-in offers are accurate --
  if (didInstallAny) {
    env = await detectEnvironmentFn();
  }

  // ---- Offer opencode (optional OpenCode account gateway) ------------------
  // Enter = yes, consistent with the claude/codex install prompts above (adding a
  // CLI is additive and easily removed). Decline with n.
  if (!env.opencode.installed) {
    out.write(`Add opencode? (optional — connect an OpenCode account) ${yesNoHint('yes', out.color)} `);
    if (await confirm(true)) {
      const resumeStdin = suspendStdin?.();
      let ok = false;
      try {
        ok = await installProviderFn('opencode', out);
      } finally {
        resumeStdin?.();
      }
      if (ok) {
        // Re-detect so downstream sign-in logic sees the freshly installed opencode.
        env = await detectEnvironmentFn();
      }
    }
    // No nag on skip — opencode is always discoverable via [o] in the main menu.
  }

  // ---- Offer sign-in for installed-but-unauthenticated providers -----------
  // opencode now reports authenticated from a real credential probe, so a freshly
  // installed opencode (0 credentials) is offered sign-in here too. The default
  // login connects the OpenCode account gateway directly.
  for (const id of ['claude', 'codex', 'opencode'] as const) {
    const ps = env[id];
    if (!ps.installed || ps.authenticated) continue;

    out.write(`\nSign in to ${id}? ${yesNoHint('yes', out.color)} `);

    if (await confirm(true)) {
      // loginFn auto-detects the right method (code in containers/SSH where the
      // localhost OAuth callback can't be reached, browser on a desktop).
      // Pass readLine so the browser-failed "retry with code?" prompt shares the
      // menu's reader, and suspendStdin so the vendor CLI owns the terminal alone
      // during its interactive sign-in (no paste byte-race).
      await loginFn(out, id, {
        readLine,
        confirm,
        ...(suspendStdin !== undefined ? { suspendStdin } : {}),
      });
      // Keep onboarding's auth loop in sync with the credential the vendor just
      // persisted, so a completed sign-in cannot be offered again from stale env.
      env = await detectEnvironmentFn();
    }
  }

  // ---- Mode selection — single collapsed prompt ----------------------------
  // Accepts 1/2/3 directly; Enter keeps the auto default (derived from your plan).
  // flagshipAdmission governs the strongest model: Efficient never auto-opens it,
  // Balanced earns one pass per turn when warranted, Max opens it on demand.
  out.write(
    `\nMode — [1] ${modeLabel('cost-saver')}  [2] ${modeLabel('balanced')}  [3] ${modeLabel('quality-first')}  (Enter = auto from your subscription): `,
  );
  const modeKey = await readMenuKey(out, readLine);

  // EOF during setup — save bare onboarded config and return
  if (modeKey === null) {
    const saved: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      ...(mutableConfig.mode !== undefined ? { mode: mutableConfig.mode } : {}),
      ...(mutableConfig.autoGoal === true ? { autoGoal: true } : {}),
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
    ...(mutableConfig.autoGoal === true ? { autoGoal: true } : {}),
  };

  // Detect whether we're already the default shell BEFORE asking — show a quick
  // spinner, then a checkmark if so (no redundant prompt).
  const checkHook = ctx.isHookInstalled ?? (() => isHookInstalled(process.env, process.platform));
  const spinner = createSpinner(out);
  spinner.start('Checking your shell setup…');
  const alreadyDefault = await checkHook().catch(() => false);
  spinner.stop();
  let setAsDefault: boolean;
  if (alreadyDefault) {
    out.write(green('✓ Already set as your default shell tool.\n', out.color));
    setAsDefault = true;
  } else {
    // Opt-IN (default NO): making myshell your default shell hook edits your shell
    // startup and can collide with another launcher you already use, so we never
    // do it on a reflexive Enter — you have to choose it explicitly.
    out.write(`Set myshell-tools as your default shell tool? (optional) ${yesNoHint('no', out.color)} `);
    setAsDefault = await confirm(false);
  }

  // Default is YES: check for updates at launch and OFFER to install (we ask
  // first — never a silent swap). Opt out with n or via Settings.
  out.write(`Check for updates at launch (I'll show the version and ask first)? ${yesNoHint('yes', out.color)} `);
  const autoUpdate = await confirm(true);

  // The one setup-time disclosure (whole-tool-finish §1.1, §1.4): memory is the
  // only always-on surface that writes durable state about the user, so it gets a
  // single honest "memory is on; here's how to manage/turn it off" line — the
  // other four surfaces self-explain just-in-time via first-touch. Gated inside
  // runWelcome (so it's structurally once-only for fresh users; upgraders skip
  // runWelcome and meet memory via the first-touch line at their first approval).
  out.write(
    dim(
      "\nMemory is on — I'll remember preferences you approve. Turn it off or see what's stored anytime with /memory.\n",
      out.color,
    ),
  );

  const saved: AppConfig = {
    onboarded: true,
    setAsDefault,
    ...(updated.mode !== undefined ? { mode: updated.mode } : {}),
    ...(!autoUpdate ? { autoUpdate: false } : {}),
    ...(updated.autoGoal === true ? { autoGoal: true } : {}),
  };

  await saveConfig(saved);

  // When the user opts in, actually write the shell startup hook (real install,
  // not just a hint). runInstall reports what it wrote and how to reverse.
  // Skip re-running the installer when the hook is already present.
  if (setAsDefault && !alreadyDefault) {
    await runInstall(out);
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

/**
 * Preserve the USER MEMORY config keys (Phase 4, §9) across a Settings toggle
 * that reconstructs `AppConfig` from scratch. The toggle functions deliberately
 * rebuild config with only the keys they know so unknown keys stay minimal; this
 * spread keeps the memory keys from being silently dropped when another setting
 * is flipped. Only explicit memory:false (the kill-switch) and any set advanced
 * keys are carried — absence means defaults (memory on).
 */
function preserveMemoryKeys(config: AppConfig): Partial<AppConfig> {
  return {
    ...(config.memory === false ? { memory: false } : {}),
    ...(config.memoryDefaultScope !== undefined ? { memoryDefaultScope: config.memoryDefaultScope } : {}),
    ...(config.memoryApproval !== undefined ? { memoryApproval: config.memoryApproval } : {}),
    ...(config.memoryDecayDays !== undefined ? { memoryDecayDays: config.memoryDecayDays } : {}),
    ...(config.memoryMaxFactsPerScope !== undefined
      ? { memoryMaxFactsPerScope: config.memoryMaxFactsPerScope }
      : {}),
    // Intent engine is default-ON, so only the explicit-OFF kill-switch is
    // persisted; carried through every settings toggle so flipping an unrelated
    // setting never silently re-enables it (same discipline as memory:false).
    ...(config.intentEngine === false ? { intentEngine: false } : {}),
  };
}

async function runModeSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  autoMode: Mode = 'balanced',
  env?: EnvironmentStatus,
): Promise<AppConfig> {
  // Effective mode = explicit choice, else the subscription-derived auto default.
  const effective = config.mode ?? autoMode;
  const mark = (m: Mode): string => (effective === m && config.mode !== undefined ? '  ‹active›' : '');
  const autoActive = config.mode === undefined;
  const autoEntry = autoActive
    ? `  [4] Auto — picks from your subscriptions (now: ${modeLabel(autoMode)})  ‹active›`
    : `  [4] Auto — picks from your subscriptions`;
  // Plain lines (NOT box()) — the descriptions are long and would overflow a
  // fixed-width box border.
  const lines = [
    '',
    bold('Mode — how readily routing reaches the strongest model', out.color),
    dim('Efficient never auto-opens it; Balanced earns one pass when a turn proves it needs it; Max opens it whenever asked.', out.color),
    '',
    `  [1] ${bold(modeLabel('cost-saver'), out.color)} — ${MODE_DESC['cost-saver']}${mark('cost-saver')}`,
    `  [2] ${bold(modeLabel('balanced'), out.color)} — ${MODE_DESC['balanced']}${mark('balanced')}`,
    `  [3] ${bold(modeLabel('quality-first'), out.color)} — ${MODE_DESC['quality-first']}${mark('quality-first')}`,
    autoActive ? autoEntry : dim(autoEntry, out.color),
    // Honest per-provider breakdown of what Auto saw and why it decided.
    ...(env !== undefined ? ['', ...renderAutoDetected(env, out.color)] : []),
  ];
  out.write('\n' + lines.filter((l) => l !== '').join('\n') + '\n\n');

  out.write('[1/2/3/4 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine);

  // EOF / Enter → keep current mode
  let newMode = config.mode;
  if (key === '1') newMode = 'cost-saver';
  else if (key === '2') newMode = 'balanced';
  else if (key === '3') newMode = 'quality-first';
  else if (key === '4') newMode = undefined; // clear pin → auto

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
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
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
  const key = await readMenuKey(out, readLine);

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
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
  };

  await saveConfig(updated);
  out.write(`Output detail set to: ${newVerbosity ?? 'normal'}\n`);
  return updated;
}

/**
 * Choose the partner posture (soft bias) and persist it.
 *
 *   direct        → lean toward executing on a reasonable default
 *   balanced      → reflect briefly on substantial work, ask at genuine forks
 *   collaborative → align on the approach before heavy execution
 *
 * It is a SOFT BIAS, not a hard mode (APE §2): it nudges the engagement
 * thresholds and never forces an action the turn's signals contradict. Absent →
 * resolved from the effective mode (`resolvePartnerStyle`). "Auto" clears the
 * explicit override so the style follows the mode again. Preserves all other
 * config fields via conditional spread.
 */
async function runStyleSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  autoMode: Mode,
): Promise<AppConfig> {
  const effMode = config.mode ?? autoMode;
  const resolved = resolvePartnerStyle(config, effMode);
  const isAuto = config.partnerStyle === undefined;
  const settingsLines = [
    '',
    'Partner style (how I engage — a soft bias, not a hard mode):',
    `  [1] direct${resolved === 'direct' ? ' (active)' : ''} — prefer a sensible default and proceed`,
    `  [2] balanced${resolved === 'balanced' ? ' (active)' : ''} — reflect briefly, ask at genuine forks`,
    `  [3] collaborative${resolved === 'collaborative' ? ' (active)' : ''} — align on the approach first`,
    `  [4] auto${isAuto ? ' (active)' : ''} — follow the mode (${resolved})`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('[1/2/3/4 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine);

  // EOF / Enter → keep current.
  let newStyle: PartnerStyle | undefined = config.partnerStyle;
  if (key === '1') newStyle = 'direct';
  else if (key === '2') newStyle = 'balanced';
  else if (key === '3') newStyle = 'collaborative';
  else if (key === '4') newStyle = undefined; // clear explicit override → auto

  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(newStyle !== undefined ? { partnerStyle: newStyle } : {}),
    ...preserveMemoryKeys(config),
  };

  await saveConfig(updated);
  out.write(
    `Partner style set to: ${newStyle ?? `auto (${resolvePartnerStyle(updated, effMode)})`}\n`,
  );
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
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
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
  const autoMode = resolveAutoMode(mutableCtx.env);
  const effMode = cfg.mode ?? autoMode;
  const settingsLines = [
    '',
    `  [1] Mode: ${modeLabel(effMode)}${cfg.mode === undefined ? ' (auto)' : ''}`,
    `  [2] Set as default shell: ${cfg.setAsDefault ? 'on' : 'off'}`,
    `  [3] Update on launch: ${cfg.autoUpdate !== false ? 'on' : 'off'}`,
    `  [4] Native sessions (experimental): ${cfg.nativeSessions === true ? 'on' : 'off'}`,
    `  [5] Output detail: ${cfg.verbosity ?? 'normal'}`,
    `  [6] Smart routing: ${cfg.smartRoute !== false ? 'on' : 'off'}`,
    `  [7] Panel (experimental): ${cfg.panel === true ? 'on' : 'off'}`,
    `  [8] Learned routing (experimental): ${cfg.learnRouting === true ? 'on' : 'off'}`,
    `  [9] Hedged escalation (experimental): ${cfg.hedge === true ? 'on' : 'off'}`,
    `  [a] Auto-goal (quality-first): ${cfg.autoGoal === true ? 'on' : 'off'} — only takes effect under quality-first mode`,
    `  [b] Partner style: ${resolvePartnerStyle(cfg, effMode)}${cfg.partnerStyle === undefined ? ' (auto)' : ''}`,
    `  [c] Memory: ${cfg.memory !== false ? 'on' : 'off'}`,
    `  [d] Intent engine: ${cfg.intentEngine !== false ? 'on' : 'off'}`,
    '',
    '  [Enter] Back',
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('> ');
  const key = await readMenuKey(out, readLine);

  // EOF or Enter → back, no change
  if (key === null || key.length === 0) return;

  if (key === '1') {
    mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode, mutableCtx.env);
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
  } else if (key === '7') {
    mutableCtx.config = await togglePanel(mutableCtx.config, out);
  } else if (key === '8') {
    mutableCtx.config = await toggleLearnRouting(mutableCtx.config, out);
  } else if (key === '9') {
    mutableCtx.config = await toggleHedge(mutableCtx.config, out);
  } else if (key === 'a') {
    mutableCtx.config = await toggleAutoGoal(mutableCtx.config, out);
  } else if (key === 'b') {
    mutableCtx.config = await runStyleSelect(mutableCtx.config, out, readLine, autoMode);
  } else if (key === 'c') {
    mutableCtx.config = await toggleMemory(mutableCtx.config, out);
  } else if (key === 'd') {
    mutableCtx.config = await toggleIntentEngine(mutableCtx.config, out);
  }
  // anything else → back
}

/**
 * Toggle the INTENT ENGINE master switch (intent-engine §4) and persist it.
 *
 * Default-on but GATED: when enabled, orchestrate runs ONE cheap, read-only,
 * short-timeout extractor pass ONLY on substantial/ambiguous turns; trivial turns
 * skip it (zero overhead). Toggling when on writes `intentEngine:false` (no
 * extractor wired — orchestrate uses the deterministic rules frame, and the
 * engagement policy still runs from {tier,risk}/route.plan); toggling when off
 * removes the flag (restores default-on). Preserves all other keys.
 */
async function toggleIntentEngine(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currentlyEnabled = config.intentEngine !== false;
  const enable = !currentlyEnabled;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
    // Persist only the explicit-OFF; absent means default-on.
    ...(!enable ? { intentEngine: false } : {}),
  };
  // preserveMemoryKeys carried the OLD intentEngine flag; the trailing spread
  // above is authoritative (or its absence when re-enabling).
  if (enable) delete (updated as { intentEngine?: boolean }).intentEngine;
  await saveConfig(updated);
  out.write(`Intent engine: ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the USER MEMORY master switch (memory-architecture §9) and persist it.
 *
 * Default-on: memory is enabled unless `memory` is explicitly false. Toggling
 * when on writes `memory:false` (the privacy kill-switch — no retrieval, no
 * injection, no proposals); toggling when off removes the flag (restores
 * default-on). The advanced memory keys are config-file-only and preserved.
 */
async function toggleMemory(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currentlyEnabled = config.memory !== false;
  const enable = !currentlyEnabled;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
    // Persist only the explicit-OFF; absent means default-on.
    ...(!enable ? { memory: false } : {}),
  };
  // preserveMemoryKeys carried the OLD memory flag; the trailing spread above is
  // the authoritative new value (or its absence when re-enabling).
  if (enable) delete (updated as { memory?: boolean }).memory;
  await saveConfig(updated);
  out.write(`Memory: ${enable ? 'on' : 'off'}\n`);
  return updated;
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
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
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
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
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
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
  };
  await saveConfig(updated);
  out.write(`Native sessions (experimental): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL Parallel Subscription Panel and persist it.
 *
 * When on, high/critical-risk turns run as a CONCURRENT panel of your signed-in
 * providers, then a cross-vendor synthesizer reconciles their answers into one.
 * Flat-rate makes the extra concurrent runs free in dollars — the cost is quota
 * + latency. Needs ≥2 signed-in providers to do anything. Default OFF.
 */
async function togglePanel(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.panel !== true;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
    ...(enable ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
  };
  await saveConfig(updated);
  out.write(`Panel (experimental): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL Latency-Hedged Escalation and persist it.
 *
 * When on, high/critical-risk turns hedge against latency: if the cheap primary
 * attempt is slow, a flagship attempt is started IN PARALLEL and whichever
 * finishes first with adequate confidence wins (the slower branch is cancelled).
 * Flat-rate makes the cancelled branch free in dollars — it spends quota to buy
 * wall-clock. Needs ≥1 signed-in provider. Default OFF.
 */
async function toggleHedge(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.hedge !== true;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(enable ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
  };
  await saveConfig(updated);
  out.write(`Hedged escalation (experimental): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL Local Outcome Learner and persist it.
 *
 * When on, routing learns from YOUR ledger which provider finishes your work
 * best per tier (observed success rate, tie-broken by latency) and prefers it.
 * Observed-only; needs real history before it changes anything. Default OFF.
 */
async function toggleLearnRouting(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.learnRouting !== true;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
    ...(config.panel === true ? { panel: true } : {}),
    ...(enable ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(config.autoGoal === true ? { autoGoal: true } : {}),
    ...(config.partnerStyle !== undefined ? { partnerStyle: config.partnerStyle } : {}),
    ...preserveMemoryKeys(config),
  };
  await saveConfig(updated);
  out.write(`Learned routing (experimental): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle opt-in auto-goal and persist it.
 *
 * When on, quality-first mode may automatically enter the existing /goal loop
 * for conservatively detected multi-step work. Other modes ignore it. Default
 * OFF; absent/false means unchanged single-turn dispatch.
 */
async function toggleAutoGoal(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.autoGoal !== true;
  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
    ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
    ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.smartRoute === false ? { smartRoute: false } : {}),
    ...(config.panel === true ? { panel: true } : {}),
    ...(config.learnRouting === true ? { learnRouting: true } : {}),
    ...(config.hedge === true ? { hedge: true } : {}),
    ...(enable ? { autoGoal: true } : {}),
  };
  await saveConfig(updated);
  out.write(`Auto-goal (quality-first): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

// ---------------------------------------------------------------------------
// Manage conversations screen
// ---------------------------------------------------------------------------

async function runManage(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
): Promise<void> {
  // Inner helper to re-fetch and re-render the conversation list.
  async function renderList(): Promise<ConversationMeta[]> {
    const latest = await ctx.store.list();
    const nowMs = ctx.clock.now();
    const lines = renderConversationList(latest, nowMs, out.color);
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
    return;
  }

  metas = await renderList();

  out.write('> ');
  const key = await readMenuKey(out, readLine);

  // EOF → treat as back
  if (key === null) return;
  if (key.length === 0) return;

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
        if (await confirm(false, { requireExplicit: true })) {
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
 * Show ONE merged, numbered list of recent Claude AND Codex sessions (newest
 * first, each tagged with its tool), let the user pick a number, then bring that
 * session into myshell — import its history into a new conversation and drop into
 * the chat loop so it continues under myshell's orchestration. No
 * pick-the-provider-first step (mirrors DATA Tools' cross-tool instant resume).
 *
 * Resolves CLAUDE_CONFIG_DIR/CODEX_HOME (incl. the Replit-persistent dirs) so it
 * finds your real sessions. Follows the injected `readLine` seam so it is fully
 * testable without a TTY. Never modifies the native CLI's files.
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
      confirm?: Confirm;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  confirm: Confirm,
  suspendStdin?: () => () => void,
  lineReader?: LineReader | null,
): Promise<'menu' | 'exit'> {
  const env = { ...process.env, ...replitPersistentEnv(process.env, ctx.cwd) };
  const sessions = await listRecentNativeSessions({ env, limit: 9 });

  if (sessions.length === 0) {
    out.write('\nNo Claude or Codex sessions found to resume.\n');
    return 'menu';
  }

  // One merged, numbered list — newest first, each tagged claude/codex.
  const nowMs = ctx.clock.now();
  out.write('\n' + separator('Resume a Claude / Codex session') + '\n');
  for (let idx = 0; idx < sessions.length; idx++) {
    const s = sessions[idx];
    if (s === undefined) continue;
    const rel = relativeTime(new Date(s.updatedAt).getTime(), nowMs);
    const tag = s.provider === 'codex' ? 'codex' : 'claude';
    const titleDisplay = s.title.length > 0 ? s.title : '(untitled)';
    out.write(`  [${idx + 1}] ${tag.padEnd(6)} ${rel.padEnd(8)} ${titleDisplay}  (${s.messageCount} msgs)\n`);
  }
  out.write('\nPick a number to resume (or Enter to cancel): ');

  const pick = await readLine();
  if (pick === null || pick.trim().length === 0) return 'menu';

  const num = parseInt(pick.trim(), 10);
  if (Number.isNaN(num) || num < 1 || num > sessions.length) {
    out.write('Invalid selection.\n');
    return 'menu';
  }

  const session = sessions[num - 1];
  if (session === undefined) return 'menu';

  const { id, imported } = await importNativeSession(session, ctx.store);
  const convTitle = session.title.length > 0 ? session.title : '(untitled)';
  out.write(`Resuming ${session.provider} session "${convTitle}" (${imported} messages)…\n`);

  // Enter the chat loop for the newly imported conversation.
  // Return value propagates the 'exit' signal to the caller (startMenu).
  return runChatLoop(ctx, mutableCtx, id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader);
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
  suspendStdin?: () => () => void,
): Promise<void> {
  const choices: Array<{ label: string; bin: string }> = [];
  for (const ps of [env.claude, env.codex, env.opencode]) {
    if (!ps.installed) continue;
    const label = ps.id === 'claude' ? 'Claude' : ps.id === 'codex' ? 'Codex' : 'opencode';
    choices.push({ label, bin: ps.binaryPath ?? ps.id });
  }

  if (choices.length === 0) {
    out.write('\nNo provider CLI is installed yet. Install one from the Auth section or run: myshell-tools doctor --fix\n');
    return;
  }

  const choiceLines = choices.map((c, i) => `  [${i + 1}] ${c.label}`).join('\n');
  out.write(`\nOpen raw session with:\n${choiceLines}\n\n> `);
  const choice = await readMenuKey(out, readLine);
  if (choice === null) return;
  if (choice.length === 0) return;

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
  // Suspend the menu reader so it cannot race the inherited-stdio child for keys.
  const resumeStdin = suspendStdin?.();
  try {
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
  } finally {
    // Resume the menu reader only after the inherited child and SIGINT handler are gone.
    resumeStdin?.();
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

// ---------------------------------------------------------------------------
// Typed-ahead queue — UI chrome notices (verbosity = render chrome only)
// ---------------------------------------------------------------------------

/**
 * Render a dim "queued" hint after a line is typed-ahead during a turn. UI
 * chrome: shown in `normal`/`verbose`, suppressed in `quiet` (it is not
 * data-loss-relevant). Printed on its own line so it never corrupts the spinner.
 */
function renderQueuedHint(
  out: OutputSink,
  verbosity: Verbosity,
  queueLength: number,
  preview: string,
): void {
  if (verbosity === 'quiet') return;
  const short = preview.length > 48 ? `${preview.slice(0, 48)}…` : preview;
  out.write(dim(`  (queued ${queueLength} message${queueLength === 1 ? '' : 's'}: ${short})\n`, out.color));
}

/**
 * Render a dim "discarded N queued" notice. Shown in EVERY verbosity (including
 * `quiet`) because dropping typed-ahead input silently is a data-loss surprise.
 */
function renderDiscardedQueue(
  out: OutputSink,
  count: number,
  reason: 'interrupt' | 'question' | 'memory',
): void {
  if (count <= 0) return;
  const tail =
    reason === 'question'
      ? '; answer the question first'
      : reason === 'memory'
        ? '; respond to the memory prompt first'
        : '';
  out.write(dim(`  (discarded ${count} queued message${count === 1 ? '' : 's'}${tail})\n`, out.color));
}

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
export async function runQuestionSelector(
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
      confirm?: Confirm;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  confirm: Confirm,
  suspendStdin?: () => () => void,
  // The real LineReader (when stdin is owned by readline). Enables typed-ahead
  // capture/queueing during a turn. Null on the injected-readLine test path —
  // queueing then degrades off (no second stdin owner is invented for tests).
  lineReader?: LineReader | null,
): Promise<'menu' | 'exit'> {
  // -------------------------------------------------------------------------
  // RECAP (Phase 7, docs/recap-feature-5.5.md) — a ※ orientation line on resume
  // and on /recap, replacing the old raw-tail-echo. The recap is conversation-
  // scoped orientation (DISTINCT from durable user memory), cached on the meta,
  // and regenerated only when stale. Generation is a single gated, cheap, read-
  // only worker-tier pass behind the injected generator port; fail-soft so a
  // missing/failed/timed-out recap NEVER blocks resume.
  // -------------------------------------------------------------------------

  /**
   * Build the cheap worker-tier recap generator from the LIVE env, or null when
   * no provider is authenticated (→ no model touch, fall back to prior behaviour).
   * Mirrors the worker-tier provider selection in buildDeps.
   */
  const buildRecapGenerator = ():
    | ((history: readonly SessionEntry[], signal: AbortSignal) => Promise<string | null>)
    | null => {
    if (!hasAuthenticatedProvider(mutableCtx.env)) return null;
    const effectiveMode: Mode = mutableCtx.config.mode ?? resolveAutoMode(mutableCtx.env);
    const policy = POLICY_PRESETS[effectiveMode];

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
    const authenticatedProviders: ProviderId[] = [];
    if (mutableCtx.env.claude.authenticated) authenticatedProviders.push('claude');
    if (mutableCtx.env.codex.authenticated) authenticatedProviders.push('codex');
    if (mutableCtx.env.opencode.authenticated) authenticatedProviders.push('opencode');

    const RECAP_TIMEOUT_MS = 8_000;
    return makeRecapGenerator({
      providers: ctx.providers,
      policy,
      cwd: ctx.cwd,
      timeoutMs: Math.min(ctx.timeoutMs, RECAP_TIMEOUT_MS),
      ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
      ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
    });
  };

  // Per-conversation rate-limit cooldown (declared early so the quota-shed plan
  // below — consumed by the recap-on-resume path and per-turn buildDeps — can read
  // it). When a turn fails with a rate-limit on a provider, remember it (expiry
  // epoch ms) so the next turn prefers an un-throttled provider; noteRateLimit
  // (below) populates it, availableAfterCooldown filters on it.
  const providerCooldownUntil = new Map<ProviderId, number>();

  // Quota-shed (whole-tool-finish §3.2): derive the per-turn shed plan from the
  // ONE pressure signal the renderer already tracks — how many providers are in
  // rate-limit cooldown right now — with NO new probe and NO token-budget readout
  // (subscription-auth has none). The pure decideShed returns the ordered ladder:
  // recap refresh → narrow memory to identity/constraints → skip the intent pass
  // → CORE ANSWER always survives. Recomputed each turn so a cooldown expiring
  // restores full capability. Shared by resolveRecap (recap rung), buildDeps
  // (intent rung) and resolveTurnMemory (memory rung).
  const currentShedPlan = (): ReturnType<typeof decideShed> => {
    const nowMs = ctx.clock.now();
    let cooledCount = 0;
    for (const until of providerCooldownUntil.values()) {
      if (until > nowMs) cooledCount++;
    }
    return decideShed(pressureFromSignals({ rateLimitedProviderCount: cooledCount }));
  };

  /**
   * Produce the recap text to show: the fresh cache when not stale, otherwise a
   * best-effort regeneration that is cached via setRecap. Always fail-soft —
   * returns null (caller falls back) rather than throwing/blocking. When `force`
   * (the /recap command), regenerate regardless of staleness.
   */
  const resolveRecap = async (force: boolean): Promise<string | null> => {
    let meta: ConversationMeta | undefined;
    try {
      meta = (await ctx.store.list()).find((m) => m.id === convId);
    } catch {
      meta = undefined;
    }
    const messageCount = meta?.messageCount ?? 0;
    if (!recapEligible(messageCount)) return null;

    const cached = typeof meta?.recap === 'string' ? meta.recap.trim() : '';
    const stale = meta === undefined ? true : isRecapStale(meta);
    if (!force && cached.length > 0 && !stale) return cached;
    // Quota-shed rung 1 (whole-tool-finish §3.2): under ANY pressure, skip the
    // background recap REFRESH (the most-expensive, least-valuable add) and show
    // the cached line instead. `/recap` (force) always regenerates — an explicit
    // ask overrides the shed. Cosmetic orientation only; never blocks the answer.
    if (!force && !currentShedPlan().recapRefresh && cached.length > 0) return cached;

    const generate = buildRecapGenerator();
    if (generate === null) return cached.length > 0 ? cached : null;

    let entries: SessionEntry[];
    try {
      entries = await ctx.store.load(convId);
    } catch {
      return cached.length > 0 ? cached : null;
    }
    let fresh: string | null = null;
    try {
      fresh = await generate(entries, new AbortController().signal);
    } catch {
      fresh = null;
    }
    const normalised = parseRecap(fresh);
    if (normalised === null) {
      // Generation failed/empty — fall back to a stale cache or nothing. NEVER block.
      return cached.length > 0 ? cached : null;
    }
    try {
      await ctx.store.setRecap(convId, normalised, messageCount);
    } catch {
      // Caching is best-effort; show the recap even if persisting it failed.
    }
    // Semantic auto-naming (real-chat gap #5): the recap is the existing topic
    // summary, so when we just (re)generated one and the title is still an
    // auto-derived STUB (first-words of the opening message), upgrade the title
    // to a clean topic phrase distilled from the recap — NO new model call, it
    // rides the recap we already made. Fail-soft + guarded so a deliberate name
    // is never clobbered and there is no churn (only rename when it differs).
    try {
      const semantic = deriveTitleFromRecap(normalised);
      if (semantic !== null) {
        const firstUser = entries.find((e) => e.role === 'user')?.content ?? null;
        const currentTitle = meta?.title ?? '';
        if (isStubTitle(currentTitle, firstUser) && semantic !== currentTitle.trim()) {
          await ctx.store.rename(convId, semantic);
        }
      }
    } catch {
      // Auto-naming is pure polish; a failure must never affect the recap or loop.
    }
    return normalised;
  };

  // First-touch helper (whole-tool-finish §1.2): print a single dim, shown-once
  // explainer the first time a surface occurs, then persist `markSeen` best-effort
  // (a failed save only risks showing the line once more — never blocks). The
  // pure `shouldShowFirstTouch` decides; this only renders + persists. Fail-soft.
  const showFirstTouch = async (
    key: Parameters<typeof shouldShowFirstTouch>[0],
  ): Promise<void> => {
    if (!shouldShowFirstTouch(key, mutableCtx.config.seen)) return;
    out.write(dim('  ' + FIRST_TOUCH_LINES[key] + '\n', out.color));
    mutableCtx.config = markSeen(key, mutableCtx.config);
    try {
      await saveConfig(mutableCtx.config);
    } catch {
      // Best-effort: a failed save only risks re-showing the line once more.
    }
  };

  // Resume transcript: SHOW the user where they left off so reopening a saved
  // conversation reads like a real chat instead of a blank prompt. Renders a
  // bounded, glyph-styled view of the recent turns (● assistant / › user, dim
  // relative timestamps) via the pure render seam — NO model call (subscription-
  // auth) and NO raw-mode/input touch (Phase 0). Fail-soft: a load/render error
  // must never block resume. Bounded so a long thread doesn't flood the screen.
  {
    let priorEntries: SessionEntry[] = [];
    try {
      priorEntries = await ctx.store.load(convId);
    } catch {
      priorEntries = []; // fail-soft: never block resume on a load error
    }
    if (priorEntries.length > 0) {
      const transcript = renderResumeTranscript(priorEntries, {
        color: out.color,
        nowMs: ctx.clock.now(),
      });
      if (transcript.length > 0) {
        out.write('\n' + transcript + '\n');
      }
    }
  }

  // Recap on resume: replace the weak tail-echo with a real ※ recap line when one
  // is available; otherwise stay silent (prior behaviour with no recap).
  {
    let recapText: string | null = null;
    try {
      recapText = await resolveRecap(false);
    } catch {
      recapText = null; // fail-soft: a recap failure must never block resume
    }
    if (recapText !== null) {
      // First-touch explainer for the ※ glyph, once ever, printed ABOVE the recap.
      await showFirstTouch('recap');
      out.write('\n  ' + formatRecapLine(recapText, out.color) + '\n\n');
    }
  }

  // One quiet orientation line on entry — NOT a per-turn label. Real chat shells
  // (claude, gpt) don't relabel the prompt every turn; they show a clean caret and
  // let you just type. Shown once; the caret below carries every turn after. The
  // active mode is shown here too so it's always visible in-conversation.
  {
    const entryMode = modeLabel(
      mutableCtx.config.mode ?? resolveAutoMode(mutableCtx.env),
    );
    out.write(
      dim(
        `Type a message and press Enter.  Mode: ${entryMode} (/mode)  ·  /goal  ·  /help  ·  /back\n`,
        out.color,
      ),
    );
  }

  // EXPERIMENTAL Local Outcome Learner (opt-in via config.learnRouting; default
  // off → this whole block is skipped, zero behaviour change). Read the ledger
  // ONCE here, before the chat loop, and learn a per-tier provider-preference
  // order from this user's own recorded outcomes. We compute it once per chat
  // session (not per turn) so a long ledger isn't re-read every message; the
  // closure below spreads it into deps. We pre-filter to the most recent 500
  // entries so stale history doesn't dominate, then learn each tier
  // independently (omitting tiers with insufficient signal → learnProviderOrder
  // returns null). Observed-only; never fabricated.
  const learnedProviderOrder: Partial<Record<Tier, readonly ProviderId[]>> = {};
  if (mutableCtx.config.learnRouting === true) {
    const allEntries = await readLedger(ctx.cwd);
    const recent = allEntries.slice(-500);
    for (const tier of ['worker', 'ic', 'manager'] as const) {
      const order = learnProviderOrder(recent, tier);
      if (order !== null) learnedProviderOrder[tier] = order;
    }
  }

  let currentAc: AbortController | null = null;
  // Set true when the in-flight turn was interrupted by ESC (distinct from the
  // Ctrl+C escape model). Read by the post-turn slot to discard the typed-ahead
  // queue (per decidePostTurn) and print the ESC status once.
  let interruptedByEsc = false;

  // Typed-ahead queue: full lines the user submits DURING a turn. Captured by
  // the LineReader (single owner — no second stdin consumer), drained FIFO after
  // a clean settle, discarded on interrupt / before any selector (decidePostTurn).
  const queuedTurns: string[] = [];

  // Interrupt timestamps — populated on each SIGINT; checked against the
  // 1 500 ms sliding window. Using ctx.clock.now() (not Date.now) so tests
  // can drive time with a fake clock.
  const interruptTimes: number[] = [];
  const INTERRUPT_WINDOW_MS = 1_500;

  // Stdin used by the scoped ESC listener. Only the real readLine path (where
  // the LineReader owns process.stdin) gets a live listener; the injected-test
  // path leaves this absent so attachChatTurnKeyListener degrades to a no-op.
  const turnKeyStdin: KeyInputStream | undefined =
    lineReader !== undefined && lineReader !== null
      ? (process.stdin as unknown as KeyInputStream)
      : undefined;

  /**
   * Run ONE model turn with the chat-ux input hooks: a scoped ESC listener
   * (ESC = interrupt this turn, stay at the prompt) and typed-ahead capture
   * (full lines submitted mid-turn are queued, not fed to the next prompt).
   * Always detaches both in `finally`. Returns runTask's result.
   */
  const runTaskWithInputHooks = async (
    taskLine: string,
    taskDeps: OrchestrateDeps,
    signal: AbortSignal,
    verbosity: Verbosity,
  ): Promise<Awaited<ReturnType<typeof runTask>>> => {
    // Fresh interrupt state for THIS task (a prior turn's ESC must not leak).
    interruptedByEsc = false;
    // Typed-ahead capture (only when the real LineReader owns stdin).
    const stopCapture =
      lineReader !== undefined && lineReader !== null
        ? lineReader.beginCapture((captured: string) => {
            queuedTurns.push(captured);
            renderQueuedHint(out, verbosity, queuedTurns.length, captured);
          })
        : null;
    // Scoped ESC listener (no-op off-TTY / injected-test path).
    const detachEsc =
      turnKeyStdin !== undefined
        ? attachChatTurnKeyListener(out, turnKeyStdin, () => {
            // ESC: interrupt THIS turn and stay at the chat prompt. It never
            // touches the Ctrl+C window and never returns to the menu.
            interruptedByEsc = true;
            currentAc?.abort();
          })
        : (): void => {};
    try {
      return await runTask(taskLine, taskDeps, out, signal, verbosity);
    } finally {
      detachEsc();
      if (stopCapture !== null) stopCapture();
    }
  };

  /**
   * The canonical post-turn slot (MASTER-PLAN MF3 / decidePostTurn). Computes the
   * ordered actions from the settled turn and runs them: discard typed-ahead
   * (always, before any selector), question-flow (the existing selector),
   * memory-approval (Phase-5 stub), drain-queue (clean settle only). The actual
   * question-flow and drain are wired by the caller via the supplied callbacks so
   * this helper stays the single ordering authority.
   */
  const runPostTurnSlot = async (
    finalEvent: Extract<CoreEvent, { type: 'final' }> | undefined,
    runQuestionFlow: () => Promise<void>,
    drainQueue: () => Promise<void>,
    runMemoryApprovalFlow?: () => Promise<void>,
  ): Promise<void> => {
    const hasQuestions =
      finalEvent?.success === true && finalEvent.questions !== undefined;
    // A memory proposal is present when the turn succeeded WITHOUT questions and
    // carries a `memoryProposal` with ≥1 fact. The facts on the event already
    // passed `worthGate` in orchestrate (`memoryProposalFor`), so "present" ==
    // "passed gate" here (MASTER-PLAN MF3 `hasMemoryProposal`). Memory is OFF →
    // never surface a proposal.
    const hasMemoryProposal =
      runMemoryApprovalFlow !== undefined &&
      finalEvent?.success === true &&
      finalEvent.questions === undefined &&
      finalEvent.memoryProposal !== undefined &&
      finalEvent.memoryProposal.facts.length > 0;
    const actions = decidePostTurn({
      hasQuestions,
      hasMemoryProposal,
      queuedCount: queuedTurns.length,
      interrupted: interruptedByEsc || shouldExit || shouldMenu,
    });
    for (const action of actions) {
      if (action === 'discard-typeahead') {
        // Discard before any selector so a queued line can never auto-answer an
        // unseen question/memory selector. Notice the user it was dropped.
        if (queuedTurns.length > 0) {
          const reason = hasQuestions ? 'question' : hasMemoryProposal ? 'memory' : 'interrupt';
          // Annotate as a data-loss notice when something is dropped that the
          // user could otherwise expect to run (interrupt, a pending question,
          // or a pending memory-approval selector). On a clean settle with no
          // selector, drain-queue runs and there is nothing to discard.
          if (interruptedByEsc || shouldExit || shouldMenu || hasQuestions || hasMemoryProposal) {
            renderDiscardedQueue(out, queuedTurns.length, reason);
            queuedTurns.length = 0;
          }
        }
      } else if (action === 'question-flow') {
        await runQuestionFlow();
      } else if (action === 'memory-approval') {
        // The remember_user Save/Skip/Edit selector. It runs HERE — after
        // discard-typeahead, before drain-queue (MASTER-PLAN MF3) — so a queued
        // "1" can never be misread as "Save". Reuses the injected line reader,
        // never the raw menu input internals.
        if (runMemoryApprovalFlow !== undefined) await runMemoryApprovalFlow();
      } else if (action === 'drain-queue') {
        await drainQueue();
      }
    }
  };

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

  // Record rate-limit cooldowns from a completed turn. Cools down EVERY provider
  // that hit a 429 during the run (result.rateLimitedProviders) — including one
  // that failed but was rescued by failover into a success final — plus the final
  // failing provider as a fallback. No-op when nothing was throttled.
  const noteRateLimit = (result: {
    final?: Extract<CoreEvent, { type: 'final' }>;
    rateLimitedProviders?: readonly ProviderId[];
  }): void => {
    const throttled = new Set<ProviderId>(result.rateLimitedProviders ?? []);
    const final = result.final;
    if (
      final !== undefined &&
      !final.success &&
      final.errorCategory === 'rate-limit' &&
      final.provider !== undefined
    ) {
      throttled.add(final.provider);
    }
    if (throttled.size === 0) return;

    const now = ctx.clock.now();
    const newlyCooled: ProviderId[] = [];
    for (const id of throttled) {
      // Only announce providers entering cooldown fresh — refreshing an active
      // cooldown (e.g. a repeat 429 within a goal loop) must not spam the notice.
      if ((providerCooldownUntil.get(id) ?? 0) <= now) newlyCooled.push(id);
      providerCooldownUntil.set(id, cooldownExpiry(now));
    }
    // Be legible: if another signed-in provider can absorb the load, say so.
    const others = [mutableCtx.env.claude, mutableCtx.env.codex, mutableCtx.env.opencode].filter(
      (p) => p.authenticated && !throttled.has(p.id),
    );
    if (newlyCooled.length > 0 && others.length > 0) {
      out.write(
        dim(
          `  (${newlyCooled.join(', ')} rate-limited — preferring your other provider${others.length > 1 ? 's' : ''} for a few minutes)\n`,
          out.color,
        ),
      );
    }
  };

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

      // One input → one turn (+ its post-turn slot). Drain-queue re-enters this
      // SAME helper so a typed-ahead line is handled identically to a fresh
      // prompt line (including queued slash commands like /back). Returns a
      // control signal for the outer loop.
      const signal = await runOneChatInput(line);
      if (signal === 'menu') {
        loopResult = 'menu';
        break;
      }
      if (signal === 'exit') {
        loopResult = 'exit';
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    loopBreaker = null;
  }

  return loopResult;

  // -------------------------------------------------------------------------
  // runOneChatInput — process a single chat input (prompt OR queued), run its
  // turn, then drive the canonical post-turn slot (decidePostTurn). Hoisted as a
  // function declaration so the loop above can call it before its definition;
  // it closes over the loop's mutable state (currentAc, shouldExit/Menu, queue).
  // -------------------------------------------------------------------------
  async function runOneChatInput(line: string): Promise<'continue' | 'menu' | 'exit'> {
    if (line === '/exit' || line === '/back') {
      return 'menu';
    }

    if (line === '/help') {
      // Unified menu /help (whole-tool-finish §1.3): the full command list PLUS a
      // grouped "about what you'll see" block that introduces every new surface in
      // one place (memory, recap, intent reflection, the parallel-models panel).
      out.write(
        dim('  Just type to chat — I pick the right model for each message.\n', out.color) +
        '  /retry        — regenerate my last answer\n' +
        '  /edit         — edit one of your recent messages and re-run from there\n' +
        '  /goal <text>  — work autonomously until the goal is done (Ctrl+C to stop)\n' +
        '  /mode         — quality vs speed (Efficient / Balanced / Max)\n' +
        '  /memory       — see, edit, export, or delete what I remember (/forget to remove)\n' +
        '  /recap        — short recap of where this conversation left off\n' +
        '  /copy         — copy my last answer to your clipboard\n' +
        '  /export       — save this conversation to a Markdown file\n' +
        '  /style        — how forward I am: ask-first vs just-do-it\n' +
        '  /back, /exit  — return to the main menu\n' +
        '  /help         — show this help\n' +
        '\n' +
        dim('  About what you\'ll see:\n', out.color) +
        dim('    ※                      a recap of where we left off (on resume)\n', out.color) +
        dim('    "what I understood…"    I restate the task before big work — correct me anytime\n', out.color) +
        dim('    "Waiting on N models"   your models running in parallel (no extra cost on your plan)\n', out.color) +
        dim('    Save / Skip             I asked to remember something — Save keeps it\n', out.color),
      );
      return 'continue';
    }

    // ※ Recap on demand (Phase 7): orient mid-conversation or before a hand-off.
    // Always regenerate (force) so /recap reflects the latest state, fail-soft so a
    // generation failure prints a gentle note instead of throwing.
    if (line === '/recap') {
      let recapText: string | null = null;
      try {
        recapText = await resolveRecap(true);
      } catch {
        recapText = null;
      }
      if (recapText !== null) {
        out.write('\n  ' + formatRecapLine(recapText, out.color) + '\n\n');
      } else {
        out.write(
          dim('  Not enough yet to recap — keep going and I\'ll have one for you.\n', out.color),
        );
      }
      return 'continue';
    }

    // ---- /copy — last answer → system clipboard (real-chat gap #3) ----------
    // Local-only, fail-soft: pick the last assistant answer (stripped) and try
    // the injected clipboard port; on a headless host with no clipboard tool the
    // helper prints the text to select instead. NO network, NO hosted share.
    if (line === '/copy') {
      let entries: SessionEntry[] = [];
      try {
        entries = await ctx.store.load(convId);
      } catch {
        entries = [];
      }
      await runCopyCommand({ entries, out, clipboard: ctx.clipboard ?? systemClipboardPort });
      return 'continue';
    }

    // ---- /export — conversation → Markdown file (real-chat gap #3) -----------
    // Mirror /memory export: render via the pure renderConversationMarkdown seam
    // and write under the state dir (durable, co-located with conversations).
    // Fail-soft: a load/render/write error prints a gentle note, never crashes.
    if (line === '/export') {
      let entries: SessionEntry[] = [];
      try {
        entries = await ctx.store.load(convId);
      } catch {
        entries = [];
      }
      let meta: ConversationMeta | undefined;
      try {
        meta = (await ctx.store.list()).find((m) => m.id === convId);
      } catch {
        meta = undefined;
      }
      const exportDir = join(resolveStateHome(process.env, ctx.cwd), '.myshell-tools', 'exports');
      const exportPath = join(exportDir, `myshell-${exportFileSlug(meta?.title)}-${convId}.md`);
      const writeFile = async (p: string, data: string): Promise<void> => {
        await fs.promises.mkdir(exportDir, { recursive: true });
        await fs.promises.writeFile(p, data, 'utf8');
      };
      await runExportCommand({ meta, entries, out, path: exportPath, writeFile });
      return 'continue';
    }

    // Change the partner posture (soft bias) from inside the chat — same knob as
    // Settings → Partner style, one source of truth.
    if (line === '/style') {
      mutableCtx.config = await runStyleSelect(
        mutableCtx.config,
        out,
        readLine,
        resolveAutoMode(mutableCtx.env),
      );
      return 'continue';
    }

    // Change the (single, global) mode from inside the chat — same knob as the
    // home [m], so there is one source of truth and never a global/per-chat drift.
    if (line === '/mode') {
      const autoMode = resolveAutoMode(mutableCtx.env);
      mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode, mutableCtx.env);
      return 'continue';
    }

    // ---- /retry — regenerate the LAST assistant answer ----------------------
    // Truncate the last assistant turn off the log (back to just after the last
    // user message), then re-run that user message as a fresh turn by recursing
    // into runOneChatInput — so the new turn loads the now-truncated history and
    // flows through the SAME ESC/queue/post-turn machinery as any normal turn.
    // Fully fail-soft: a load/truncate error never corrupts the log or the loop.
    if (line === '/retry') {
      let entries: SessionEntry[] = [];
      try {
        entries = await ctx.store.load(convId);
      } catch {
        entries = [];
      }
      const plan = planRetryTruncation(entries);
      if (plan === null) {
        out.write(dim('  Nothing to retry yet — ask me something first.\n', out.color));
        return 'continue';
      }
      try {
        await ctx.store.truncateAfter(convId, plan.keepCount);
      } catch {
        // Truncate must never crash the loop; if it failed the log is intact —
        // re-running would duplicate the answer, so bail with a gentle note.
        out.write(dim("  Couldn't reset the last answer just now — try again.\n", out.color));
        return 'continue';
      }
      out.write(dim('  Regenerating…\n', out.color));
      return runOneChatInput(plan.replayLine);
    }

    // ---- /edit — edit a PRIOR user message + regenerate ---------------------
    // Show the recent USER messages numbered, let the user pick one, edit its
    // text (the original is offered as the starting point), truncate the log from
    // that message onward, then submit the edited text as a NEW turn (recurse so
    // it replays the truncated history through the normal machinery). `/edit`
    // with no arg opens the picker. Reuses ONLY the injected readLine seam — no
    // raw-mode/input internals (Phase 0). Fail-soft throughout.
    if (line === '/edit' || line.startsWith('/edit ')) {
      let entries: SessionEntry[] = [];
      try {
        entries = await ctx.store.load(convId);
      } catch {
        entries = [];
      }
      const candidates = recentUserMessages(entries);
      if (candidates.length === 0) {
        out.write(dim("  Nothing to edit yet — you haven't sent a message in this chat.\n", out.color));
        return 'continue';
      }
      // Render the picker (oldest-of-the-recent last reads naturally top-to-
      // bottom; we number most-recent = [1] so the common "edit my last message"
      // is a single keystroke).
      out.write('\n' + dim('  Which message do you want to edit?', out.color) + '\n');
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (c === undefined) continue;
        const preview = c.content.replace(/\s+/g, ' ').trim();
        const shown = preview.length > 72 ? `${preview.slice(0, 72)}…` : preview;
        out.write(`  [${i + 1}] ${shown}\n`);
      }
      out.write('  Pick a number, or Enter to cancel: ');
      const pickRaw = await readLine();
      const pickTrimmed = (pickRaw ?? '').trim();
      if (pickTrimmed.length === 0) {
        out.write(dim('  Cancelled.\n', out.color));
        return 'continue';
      }
      const pickNum = Number.parseInt(pickTrimmed, 10);
      const chosen =
        Number.isInteger(pickNum) && pickNum >= 1 && pickNum <= candidates.length
          ? candidates[pickNum - 1]
          : undefined;
      if (chosen === undefined) {
        out.write(dim('  Not a listed number — nothing edited.\n', out.color));
        return 'continue';
      }
      // Offer the original as the starting point; Enter keeps it unchanged.
      out.write('\n  ' + dim('Current:', out.color) + ' ' + chosen.content.replace(/\s+/g, ' ').trim() + '\n');
      out.write('  New message (Enter to keep it as-is): ');
      const editedRaw = await readLine();
      const edited = (editedRaw ?? '').trim();
      const newText = edited.length > 0 ? edited : chosen.content;
      // Truncate the log to BEFORE the chosen message (its index), then resubmit
      // the edited text as a fresh turn — orchestrate appends the new user entry.
      try {
        await ctx.store.truncateAfter(convId, chosen.index);
      } catch {
        out.write(dim("  Couldn't rewind to that message just now — try again.\n", out.color));
        return 'continue';
      }
      out.write(dim('  Regenerating…\n', out.color));
      return runOneChatInput(newText);
    }

    // Effective mode: the user's explicit choice, else auto-detected from their
    // subscription plan (Max → top of the knob, etc.) — no interrogation.
    const effectiveMode: Mode =
        mutableCtx.config.mode ?? resolveAutoMode(mutableCtx.env);
      // EXPERIMENTAL: opt-in Parallel Subscription Panel (config.panel) maps to
      // policy.panelPolicy 'hard-turns'. Absent/false → unchanged sequential
      // behaviour (panelPolicy stays absent → 'off'). Opt-in Latency-Hedged
      // Escalation (config.hedge) maps to policy.hedgePolicy 'on' (absent → 'off').
      const policy = {
        ...POLICY_PRESETS[effectiveMode],
        ...(mutableCtx.config.panel === true ? { panelPolicy: 'hard-turns' as const } : {}),
        ...(mutableCtx.config.hedge === true ? { hedgePolicy: 'on' as const } : {}),
      };

      // ---- Bug 4 fix: no-provider gate ----------------------------------------
      // Check whether any provider is actually authenticated before dispatching a
      // task that is doomed to fail. opencode now reports authenticated only when a
      // real provider/subscription is configured (no more installed-means-ready).
      if (!hasAuthenticatedProvider(mutableCtx.env)) {
        out.write(
          '\n[info] No signed-in provider yet — type /back or press Ctrl+C twice to return, then [j] Claude / [k] Codex / [o] opencode to sign in.\n',
        );
        return 'continue';
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
      const buildDeps = (
        hist: readonly SessionEntry[],
        // Pre-rendered, capped USER MEMORY block (Phase 4, memory §7), computed
        // per-turn by resolveTurnMemory below. Threaded once so it rides
        // sequential, hedge, AND panel prompts via assembleContextBlocks.
        memoryContext?: string,
        // Pre-rendered, capped ENVIRONMENT / repo-map orientation block (E1,
        // codebase-awareness §1.2). Gathered ONCE per session (the map is stable
        // within a session — see resolveEnvironmentOnce below) and threaded here so
        // orientation rides sequential, hedge, AND panel prompts. Absent → omit.
        environmentContext?: string,
      ): OrchestrateDeps => {
        // Build per-provider advertised model sets from the live env so route()
        // can prefer a model the CLI actually advertises. Only include installed
        // providers (exactOptionalPropertyTypes is ON).
        // Use mutableCtx.env (not ctx.env) so post-login re-detect is reflected.
        // ---- Quota-shed (whole-tool-finish §3.2) --------------------------------
        // The pure decideShed ladder for this turn (see currentShedPlan above):
        // recap refresh → narrow memory to identity/constraints → skip the intent
        // pass → CORE ANSWER always survives. We honour the deps-level rungs here
        // (intent rung below; the memory rung rides resolveTurnMemory); the
        // un-sheddable core answer always runs.
        const shedPlan = currentShedPlan();

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
        const authedAll: ProviderId[] = [];
        if (mutableCtx.env.claude.authenticated) authedAll.push('claude');
        if (mutableCtx.env.codex.authenticated) authedAll.push('codex');
        if (mutableCtx.env.opencode.authenticated) authedAll.push('opencode');

        // Bias away from providers that recently hit a rate limit this session,
        // so a second signed-in provider absorbs the load. Never strands the user:
        // if every authed provider is cooling down, the full list is returned.
        const authenticatedProviders = availableAfterCooldown(
          authedAll,
          providerCooldownUntil,
          ctx.clock.now(),
        );

        // Observed plan classification per authenticated provider — an immutable
        // snapshot for adaptive flagship admission (core/flagship.ts), which vetoes
        // auto-opening the flagship on an observed `free` plan. Never fabricated:
        // providers whose CLI reports no plan classify to confidence 'none'.
        const planInfos: Partial<Record<ProviderId, PlanInfo>> = {};
        for (const p of [mutableCtx.env.claude, mutableCtx.env.codex, mutableCtx.env.opencode]) {
          if (p.authenticated) planInfos[p.id] = classifyPlan(p.plan);
        }

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

        // Intent engine (default ON, gated): the cheap, read-only, short-timeout
        // extractor that populates an IntentFrame ONLY on substantial/ambiguous
        // turns (see shouldExtractIntent). Capped like the router so the worst-case
        // pause is bounded; absent → orchestrate uses the deterministic rules frame.
        const INTENT_TIMEOUT_MS = 8_000;
        const intentExtractor =
          // Quota-shed rung 3: under heavy pressure the intent pass is skipped
          // (orchestrate falls back to the deterministic rules frame — no call, no
          // latency), exactly the timeout-fallback path. Absent extractor → rules.
          mutableCtx.config.intentEngine !== false && shedPlan.intentPass
            ? makeIntentExtractor({
                providers: ctx.providers,
                policy,
                cwd: ctx.cwd,
                timeoutMs: Math.min(ctx.timeoutMs, INTENT_TIMEOUT_MS),
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
          ...(Object.keys(planInfos).length > 0 ? { planInfos } : {}),
          ...(nativeSession.length > 0 ? { nativeSession } : {}),
          ...(routeClassifier !== undefined ? { routeClassifier } : {}),
          ...(intentExtractor !== undefined ? { intentExtractor } : {}),
          ...(Object.keys(learnedProviderOrder).length > 0 ? { learnedProviderOrder } : {}),
          // Partner posture (soft bias, APE §2). Explicit config wins; else the
          // default is derived from the effective mode. Threaded once per turn so
          // it rides sequential, hedge, AND panel prompts via assembleContextBlocks.
          partnerStyle: resolvePartnerStyle(mutableCtx.config, effectiveMode),
          // Latency-Hedged Escalation needs an injected delay port (so its timing
          // stays out of the pure core). Provide a setTimeout-based impl only when
          // hedging is enabled — when off, the dep is absent and planHedge returns
          // null, so the sequential path is unchanged.
          ...(mutableCtx.config.hedge === true
            ? { sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)) }
            : {}),
          // USER MEMORY block (Phase 4, §7) — present only when memory is on AND
          // facts survived the inject-time gate + relevance selection.
          ...(memoryContext !== undefined && memoryContext.length > 0 ? { memoryContext } : {}),
          // ENVIRONMENT / repo-map orientation block (E1) — gathered once per
          // session, present only when codebase awareness is on AND the scan
          // produced a non-empty block (fail-soft → '' otherwise).
          ...(environmentContext !== undefined && environmentContext.length > 0
            ? { environmentContext }
            : {}),
        };
      };

      // ---- USER MEMORY (Phase 4, §7) — per-turn retrieval/injection ----------
      // Resolve the rendered MEMORY block for one turn: open the store (lazy
      // decay sweep), gate prefs/corrections/project behind a real work request
      // (identity+constraints always ride), select the relevant facts, markUsed
      // the relevance-selected ids, and render. The project key is resolved once
      // per chat session (it can't change mid-conversation). Fully fail-soft: any
      // store error → '' (no memory), the turn proceeds. Skipped entirely when
      // the kill-switch is set (config.memory===false). No model call.
      // The store is always created (so /memory list/forget/export work even when
      // memory is OFF — the kill-switch only suppresses READ/inject + WRITE, not
      // the user's ability to inspect/delete/export what is already stored, §9).
      // Surface a memory index REBUILD (a terminal-for-the-feature recovery the
      // user should know about) in the unified teach voice, ONCE per session
      // (whole-tool-finish §2.3 — corrupt index → warn once). Lock contention and
      // other transients stay silent (the store only calls onWarning on recovery).
      let memoryRebuildWarned = false;
      const memoryStore = createFileUserMemoryStore({
        clock: ctx.clock,
        onWarning: (): void => {
          if (memoryRebuildWarned) return;
          memoryRebuildWarned = true;
          out.write(
            '  ' +
              teach(
                {
                  what: 'Memory index was damaged',
                  did: 'I rebuilt it from your saved facts (a backup was kept)',
                  you: 'Run /memory to verify.',
                  severity: 'warn',
                },
                out.color,
              ) +
              '\n',
          );
        },
      });
      let memoryProjectKey: string | null | undefined;
      let memorySwept = false;
      // Facts ACTUALLY injected into a prompt this session — the `/memory loaded`
      // transparency source (§8). De-duplicated by id, newest-first.
      const loadedThisSession: UserMemoryFact[] = [];
      const resolveProjectKeyOnce = async (): Promise<string | null> => {
        if (memoryProjectKey === undefined) {
          memoryProjectKey = await resolveProjectKey(ctx.cwd).catch(() => null);
        }
        return memoryProjectKey;
      };
      const resolveTurnMemory = async (task: string): Promise<string> => {
        // Kill-switch: no read/inject when memory is off.
        if (mutableCtx.config.memory === false) return '';
        const projectKey = await resolveProjectKeyOnce();
        // Quota-shed rung 2: under moderate+ pressure, narrow injection to
        // identity + hard constraints only (drop ranked prefs). The load-bearing
        // identity/constraints always ride; only the nice-to-have prefs are shed.
        const identityOnly = currentShedPlan().memoryWidth === 'identity-only';
        const resolved = await resolveMemoryContextDetailed({
          store: memoryStore,
          task,
          projectKey,
          partnerStyle: resolvePartnerStyle(mutableCtx.config, effectiveMode),
          nowIso: ctx.clock.isoNow(),
          config: mutableCtx.config,
          // Sweep once per chat session (the "store open"), not every turn.
          sweep: !memorySwept,
          ...(identityOnly ? { identityOnly: true } : {}),
        }).catch(() => ({ block: '', facts: [] as readonly UserMemoryFact[] }));
        memorySwept = true;
        // Record what loaded (de-dup by id; most-recent injection wins position).
        for (const f of resolved.facts) {
          const existing = loadedThisSession.findIndex((x) => x.id === f.id);
          if (existing >= 0) loadedThisSession.splice(existing, 1);
          loadedThisSession.unshift(f);
        }
        return resolved.block;
      };

      // ---- ENVIRONMENT / repo-map (E1, codebase-awareness §1.2) ---------------
      // Gather the deterministic orientation block ONCE per chat session — the
      // repo map is stable within a session, so (unlike memory) we do NOT regather
      // it every turn. Mirrors resolveProjectKeyOnce's memoize-once pattern. Fully
      // fail-soft: any scan error → '' (no block), the turn proceeds. NO model
      // call. Kill-switch: config.codebaseAwareness === false → skip entirely.
      let environmentContext: string | undefined;
      const resolveEnvironmentOnce = async (): Promise<string> => {
        if (environmentContext !== undefined) return environmentContext;
        if (mutableCtx.config.codebaseAwareness === false) {
          environmentContext = '';
          return environmentContext;
        }
        environmentContext = await buildEnvironmentContext(ctx.cwd, nodeRepoScanPort).catch(
          () => '',
        );
        return environmentContext;
      };

      const runStructuredQuestionFlow = async (
        initialFinal: Extract<CoreEvent, { type: 'final' }> | undefined,
      ): Promise<void> => {
        let pending = initialFinal;
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
          const answerDeps: OrchestrateDeps = buildDeps(
            answerHistory,
            await resolveTurnMemory(answerLine),
            await resolveEnvironmentOnce(),
          );

          const answerAc = new AbortController();
          currentAc = answerAc;
          const answerResult = await runTaskWithInputHooks(
            answerLine,
            answerDeps,
            answerAc.signal,
            mutableCtx.config.verbosity ?? 'normal',
          );
          currentAc = null;

          if (shouldExit || shouldMenu || interruptedByEsc) break;

          pending = answerResult.final;
        }
        if (
          questionTurns >= MAX_CONSECUTIVE_QUESTION_TURNS &&
          pending?.questions !== undefined
        ) {
          out.write(
            '\n[info] The assistant is still asking questions — over to you. Type a reply or /back.\n',
          );
        }
      };

      // Autonomous goal loop — shared by /goal AND by accepting the model's
      // in-chat "keep going?" offer. Runs turns toward `goalText`, reloading
      // history each turn so the model sees its own progress, bounded by a turn
      // ceiling and Esc. Returns true when the outer chat loop should break
      // (Ctrl+C → menu/exit). Closes over the per-turn buildDeps + the shared
      // currentAc/shouldExit/shouldMenu/loopResult flags.
      const runGoalLoop = async (goalText: string): Promise<boolean> => {
        let goalContract = capContract({ version: 1, objective: goalText });
        // Title a still-untitled conversation from the goal (no-op if already set).
        const gMeta = (await ctx.store.list()).find((m) => m.id === convId);
        if (gMeta !== undefined && gMeta.title.trim().length === 0) {
          await ctx.store.rename(convId, goalText.length <= 80 ? goalText : goalText.slice(0, 80));
        }
        // Turns are the honest bound on a subscription (no per-token bill to cap).
        const ceilings: GoalCeilings = { maxIterations: DEFAULT_MAX_GOAL_ITERATIONS };
        out.write(
          dim(
            `\n  Working autonomously until it's done (up to ${ceilings.maxIterations} turns). Ctrl+C to stop.\n\n`,
            out.color,
          ),
        );
        // Baseline for the live progress panel: wall-clock start + the ledger's
        // token total before this run, so each turn can show REAL turn/elapsed/
        // tokens-this-goal (never an estimate).
        const goalStartMs = ctx.clock.now();
        const baseTokens = summarizeSpend(await readLedger(ctx.cwd), ctx.clock.isoNow()).totalTokens;
        let completed = 0;
        for (let i = 0; i < ceilings.maxIterations; i++) {
          const tokensThisRun =
            summarizeSpend(await readLedger(ctx.cwd), ctx.clock.isoNow()).totalTokens - baseTokens;
          out.write(
            dim(
              `  ▸ ${formatGoalProgress({
                turn: i + 1,
                maxTurns: ceilings.maxIterations,
                elapsedMs: ctx.clock.now() - goalStartMs,
                tokensThisRun,
              })}\n`,
              out.color,
            ),
          );
          const goalDeps = buildDeps(
            await ctx.store.load(convId),
            await resolveTurnMemory(goalText),
            await resolveEnvironmentOnce(),
          );
          const contractedGoalTask = buildGoalTask(goalText, i, goalContract);
          const replayGoalTask = buildGoalTask(goalText, i);
          const goalSession: SessionWriter = {
            id: goalDeps.session.id,
            async append(entry) {
              await goalDeps.session.append(
                entry.role === 'user' && entry.content === contractedGoalTask
                  ? { ...entry, content: replayGoalTask }
                  : entry,
              );
            },
          };
          const goalAc = new AbortController();
          currentAc = goalAc;
          const turn = await runTaskWithInputHooks(
            contractedGoalTask,
            { ...goalDeps, session: goalSession, workContract: goalContract, goalTurn: true },
            goalAc.signal,
            mutableCtx.config.verbosity ?? 'normal',
          );
          currentAc = null;
          noteRateLimit(turn);
          completed = i + 1;
          if (shouldExit) { loopResult = 'exit'; return true; }
          if (shouldMenu) { loopResult = 'menu'; return true; }
          // ESC interrupts the goal loop and returns to the chat prompt (it does
          // not exit/menu). Discard any typed-ahead so it can't run unexpectedly.
          if (interruptedByEsc) {
            if (queuedTurns.length > 0) {
              renderDiscardedQueue(out, queuedTurns.length, 'interrupt');
              queuedTurns.length = 0;
            }
            return false;
          }

          if (turn.final?.success === true && turn.final.questions !== undefined) {
            out.write(dim('\n  The goal run needs your input before it can continue.\n', out.color));
            await runStructuredQuestionFlow(turn.final);
            if (shouldExit) { loopResult = 'exit'; return true; }
            if (shouldMenu) { loopResult = 'menu'; return true; }
            break;
          }

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

          const turnOutput = turn.final?.output ?? '';
          const goalControlOutput = stripTrailingGoalConfidenceEnvelope(turnOutput);
          const signal = parseGoalSignal(goalControlOutput);
          if (signal === 'continue') {
            goalContract = appendCheckpointFromContinue(
              goalContract,
              parseGoalContinueText(goalControlOutput),
              i,
            );
          }
          const step = decideGoalNext({
            signal,
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

      // ---- Memory commands (Phase 5, memory doc §8) ---------------------------
      // Dispatched here (after the per-turn memory machinery is in scope) so they
      // share the single store + project key + the `/memory loaded` tracker. They
      // use the SAME injected line reader as the chat prompt (not raw input
      // internals); no model call (subscription-auth).
      if (line === '/remember' || line.startsWith('/remember ')) {
        const fact = line.slice('/remember'.length).trim();
        out.write(
          `${await runRemember({
            text: fact,
            store: memoryStore,
            config: mutableCtx.config,
            projectKey: await resolveProjectKeyOnce(),
          })}\n`,
        );
        return 'continue';
      }

      if (line === '/forget' || line.startsWith('/forget ')) {
        const id = line.slice('/forget'.length).trim();
        out.write(
          `${await runForget({
            store: memoryStore,
            projectKey: await resolveProjectKeyOnce(),
            out,
            readLine,
            ...(id.length > 0 ? { id } : {}),
          })}\n`,
        );
        return 'continue';
      }

      if (line === '/memory' || line.startsWith('/memory ')) {
        const arg = line.slice('/memory'.length).trim();
        const projectKey = await resolveProjectKeyOnce();
        if (arg === '' || arg === 'list') {
          await runMemoryList({ store: memoryStore, projectKey, out });
        } else if (arg === 'all') {
          await runMemoryList({ store: memoryStore, projectKey, out, all: true });
        } else if (arg === 'loaded') {
          runMemoryLoaded({ out, loaded: loadedThisSession });
        } else if (arg === 'export') {
          const exportPath = join(ctx.cwd, 'myshell-memory.md');
          out.write(
            `${await runMemoryExport({
              store: memoryStore,
              out,
              path: exportPath,
              writeFile: (p, data) => fs.promises.writeFile(p, data, 'utf8'),
            })}\n`,
          );
        } else if (arg.startsWith('edit ')) {
          // Edit = forget the chosen id then re-add via /remember. v1 routes the
          // user to the explicit two-step (forget + remember) rather than an
          // in-place editor (kept lean); show the fact so they can copy it.
          const id = arg.slice('edit '.length).trim();
          const fact = await memoryStore.get(id).catch(() => null);
          if (fact === null) {
            out.write(`No memory with id ${id}.\n`);
          } else {
            out.write(
              dim(
                `  ${fact.text}\n  To change it: /forget ${id}  then  /remember <new fact>\n`,
                out.color,
              ),
            );
          }
        } else {
          out.write(
            dim('  Usage: /memory [all | loaded | export | edit <id>]\n', out.color),
          );
        }
        return 'continue';
      }

      // ---- /goal — explicit autonomous loop -----------------------------------
      if (line.startsWith('/goal')) {
        const goalText = line.slice('/goal'.length).trim();
        if (goalText.length === 0) {
          out.write(dim('  Usage: /goal <what you want achieved> — I work autonomously until it\'s done (Ctrl+C to stop).\n', out.color));
          return 'continue';
        }
        if (await runGoalLoop(goalText)) return loopResult;
        return 'continue';
      }

      const deps = buildDeps(
        priorHistory,
        await resolveTurnMemory(line),
        await resolveEnvironmentOnce(),
      );

      if (mutableCtx.config.autoGoal === true && effectiveMode === 'quality-first') {
        const autoClassification = classify(line);
        const autonomy = decideAutonomyOffer({
          mode: effectiveMode,
          classification: autoClassification,
          autoGoalEnabled: true,
        });
        if (autonomy.kind === 'auto_engage') {
          if (await runGoalLoop(line)) return loopResult;
          return 'continue';
        }
      }

      const ac = new AbortController();
      currentAc = ac;
      const result = await runTaskWithInputHooks(line, deps, ac.signal, mutableCtx.config.verbosity ?? 'normal');
      currentAc = null;
      noteRateLimit(result);

      // ESC interrupt during the turn: discard typed-ahead, print a calm status
      // once, and return to the chat prompt (NOT menu). decidePostTurn guarantees
      // the queue is discarded (not drained) on interrupt; we surface it here.
      if (interruptedByEsc) {
        await runPostTurnSlot(result.final, async () => {}, async () => {});
        out.write('\nInterrupted.\n');
        return 'continue';
      }

      // Check for SIGINT-driven signals that fired while runTask was awaited.
      if (shouldExit) {
        loopResult = 'exit';
        return 'exit';
      }
      // Bug 3 fix: shouldMenu may have been set by a 2×Ctrl+C during the task.
      if (shouldMenu) {
        loopResult = 'menu';
        return 'menu';
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
        if (await confirm(true)) {
          await loginFn(out, failingProvider, {
            readLine,
            confirm,
            ...(suspendStdin !== undefined ? { suspendStdin } : {}),
          });
          // Bug 5 fix: re-detect with the freshly-authenticated env so the retry
          // deps reflect the now-signed-in provider (not the stale pre-login state).
          mutableCtx.env = await detectEnvironmentFn();
          const retryDeps = buildDeps(
            await ctx.store.load(convId),
            await resolveTurnMemory(line),
            await resolveEnvironmentOnce(),
          );
          // Retry the same task once.
          const retryAc = new AbortController();
          currentAc = retryAc;
          const retryResult = await runTaskWithInputHooks(line, retryDeps, retryAc.signal, mutableCtx.config.verbosity ?? 'normal');
          currentAc = null;
          if (interruptedByEsc) {
            if (queuedTurns.length > 0) {
              renderDiscardedQueue(out, queuedTurns.length, 'interrupt');
              queuedTurns.length = 0;
            }
            out.write('\nInterrupted.\n');
            return 'continue';
          }
          if (shouldExit) {
            loopResult = 'exit';
            return 'exit';
          }
          if (shouldMenu) {
            loopResult = 'menu';
            return 'menu';
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
        // A confirm/goal-loop branch supersedes the post-turn slot; drop any
        // typed-ahead so it can't surprise-run after the confirm.
        if (queuedTurns.length > 0) {
          renderDiscardedQueue(out, queuedTurns.length, 'interrupt');
          queuedTurns.length = 0;
        }
        out.write('\n  ' + dim("That's a big one — it ran past the time limit for a single turn.", out.color) + '\n');
        out.write(`  Keep working on it autonomously, step by step, until it's done? ${yesNoHint('yes', out.color)} `);
        if (await confirm(true)) {
          if (await runGoalLoop(line)) return loopResult;
        }
        return 'continue';
      }

      // ---- Natural autonomy: accept the model's "keep going?" offer -----------
      // For a big multi-step job the model does a first chunk and offers to finish
      // autonomously via an ask_user block with id 'keep_going' (see prompt.ts).
      // Render it as a clean confirm; on yes, run the autonomous goal loop on the
      // ORIGINAL task — so sustained work needs no command. Handled BEFORE the
      // generic selector so the offer isn't shown as a numbered list.
      if (result.final?.questions !== undefined && isKeepGoingOffer(result.final.questions)) {
        if (queuedTurns.length > 0) {
          renderDiscardedQueue(out, queuedTurns.length, 'interrupt');
          queuedTurns.length = 0;
        }
        out.write('\n  ' + dim("I can keep working on this autonomously until it's done.", out.color) + '\n');
        out.write(`  Keep going? ${yesNoHint('yes', out.color)} `);
        if (await confirm(true)) {
          if (await runGoalLoop(line)) return loopResult;
        }
        return 'continue';
      }

      // ---- Post-turn slot (decidePostTurn / MASTER-PLAN MF3) ------------------
      // The single canonical post-turn order: discard typed-ahead (before any
      // selector) → question-flow (the ask_user selector) → memory-approval
      // (the remember_user Save/Skip/Edit selector) → drain-queue (FIFO, clean
      // settle only). question-flow wires the EXISTING runStructuredQuestionFlow;
      // memory-approval wires runMemoryApproval (same injected reader); drain
      // re-enters runOneChatInput per queued line. A queued line can NEVER answer
      // an unseen selector (discard always precedes both selectors).
      await runPostTurnSlot(
        result.final,
        () => runStructuredQuestionFlow(result.final),
        async () => {
          while (queuedTurns.length > 0 && !shouldExit && !shouldMenu) {
            const next = queuedTurns.shift();
            if (next === undefined) break;
            const drainSignal = await runOneChatInput(next);
            if (drainSignal === 'menu') { shouldMenu = true; loopResult = 'menu'; break; }
            if (drainSignal === 'exit') { shouldExit = true; loopResult = 'exit'; break; }
          }
        },
        // Memory-approval: only when memory writes are ON and the (already
        // gated) proposal carries facts. Non-TTY ignores proposals (the slot is
        // never reached off-TTY because runChatLoop only runs interactively).
        result.final?.memoryProposal !== undefined && mutableCtx.config.memory !== false
          ? async (): Promise<void> => {
              const proposal = result.final?.memoryProposal;
              if (proposal === undefined) return;
              // First-touch (whole-tool-finish §1.2): print the one-line
              // explainer ABOVE the first Save/Skip selector, once ever. It adds
              // no new interaction — the user was going to act on the selector
              // anyway. Fail-soft (a save miss only risks re-showing it).
              await showFirstTouch('memorySave');
              await runMemoryApproval({
                proposal,
                store: memoryStore,
                projectKey: await resolveProjectKeyOnce(),
                out,
                readLine,
                config: mutableCtx.config,
              });
            }
          : undefined,
      );
      if (shouldExit) {
        loopResult = 'exit';
        return 'exit';
      }
      if (shouldMenu) {
        loopResult = 'menu';
        return 'menu';
      }
      return 'continue';
  }
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

  // Header box — always box(), real provider data.
  // Title carries the live version status so the user always knows whether they
  // are current: "(latest)" when up to date, "→ X.Y.Z available" when not.
  const headerLines = renderHeaderLines(mutableCtx.env, ctx.version, claudeTokenInfo ?? undefined);
  const versionLabel = versionStatusLabel(updateInfo);
  out.write(box(`myshell-tools v${ctx.version}${versionLabel}`, headerLines) + '\n\n');

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
    const autoMode = resolveAutoMode(mutableCtx.env);
    const eff = mutableCtx.config.mode ?? autoMode;
    const autoSuffix = mutableCtx.config.mode === undefined
      ? ` (${autoModeReason(mutableCtx.env)})`
      : '';
    out.write(
      '  ' +
        dim(
          `Mode: ${modeLabel(eff)}${autoSuffix}  ·  press m to change`,
          out.color,
        ) +
        '\n\n',
    );
  }

  // Recent conversations — separator() then list. Header is just "Recent" so it
  // doesn't repeat the "Conversations" action header that follows.
  out.write(separator('Recent') + '\n');
  const nowMs = ctx.clock.now();
  const convLines = renderConversationList(metas, nowMs, out.color);
  if (convLines.length === 0) {
    out.write('  (no conversations yet)\n');
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
      // Under the "Conversations" header, so items don't repeat the noun.
      { key: 'c', label: 'Continue last', section: 'Conversations' },
      { key: 'n', label: 'New', section: 'Conversations' },
      { key: '1-9', label: 'Resume numbered', section: 'Conversations' },
      { key: 'e', label: 'Manage', section: 'Conversations' },
      { key: 'i', label: 'Resume a Claude/Codex session', section: 'Conversations' },
      { key: 'r', label: 'Raw provider session', section: 'Conversations' },
      ...authEntries,
      { key: 's', label: 'Settings', section: 'Options' },
      { key: 'd', label: 'Diagnose', section: 'Options' },
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
  const activeVersionFn = ctx.activeVersion;
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
      // Smart Tab at the chat prompt (T2–T4, docs/tab-completion-5.5.md):
      // slash-name + slash-argument + file/path + @-mention, fuzzy-ranked,
      // async (readdir). Lives entirely inside readline's own callback — adds
      // NO new stdin consumer and touches no raw-mode / suspend-resume / Phase-0
      // internals. Plain prose → no-op; any error → safe no-op (never throws).
      // Ignored entirely when `terminal` is false (piped/test input).
      completer: (line: string, cb: (err: null, result: [string[], string]) => void) => {
        completeChat(line).then(
          (result) => cb(null, result),
          () => cb(null, [[], line]),
        );
      },
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
        let handedOff = false;
        // Release the parent's stdin/readline so the npm child AND the relaunched
        // child own the TTY alone — otherwise the parent's reader races the relaunched
        // process for keypresses and the new menu falls back to line mode (needs Enter).
        // Mirrors the login flow, which suspends stdin before any inherited-stdio child.
        const resumeStdin = suspendStdin?.();
        try {
          const ok = await doUpdate(out).catch(() => false);
          if (ok) {
            if (activeVersionFn !== undefined) {
              const activeVersion = await activeVersionFn().catch(() => null);
              if (activeVersion !== toV) {
                const activeLine = activeVersion !== null
                  ? `the active \`myshell-tools\` on your PATH is still ${activeVersion}.`
                  : 'the active `myshell-tools` on your PATH could not be verified.';
                out.write(
                  `\n  ⚠️  Updated to ${toV}, but ${activeLine}\n` +
                    `     Fix your PATH or run: which myshell-tools\n` +
                    `     Staying on ${fromV} in this process for now.\n\n`,
                );
                return false;
              }
            }
            if (relaunchFn !== undefined) {
              await relaunchFn().catch(() => 1);
              handedOff = true;
            }
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
        } finally {
          // After a successful relaunch handoff, the child owns fd0. Re-priming
          // the parent's readline here can steal keys or degrade the child's TTY.
          if (!handedOff) resumeStdin?.();
        }
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
        if (!(await promptForAuthBeforeChat(out, readLine, mutableCtx, loginFn, detectEnvironmentFn, confirm, suspendStdin))) {
          continue;
        }
        // No up-front "name your chat" prompt — a real chat shell just opens and
        // lets you type. The title is derived silently from the first user message
        // (conversations.ts append()), so create an untitled conversation and drop
        // straight into it.
        const meta = await ctx.store.create('');
        const chatResult = await runChatLoop(ctx, mutableCtx, meta.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader);
        spendDirty = true; // a task may have run — refresh the spend summary
        if (chatResult === 'exit') break;
        continue;
      }

      // ---- [c] Continue most-recent conversation ------------------------------
      if (key === 'c') {
        const all = await ctx.store.list();
        const latest = all[0];
        if (latest !== undefined) {
          if (!(await promptForAuthBeforeChat(out, readLine, mutableCtx, loginFn, detectEnvironmentFn, confirm, suspendStdin))) {
            continue;
          }
          const chatResult = await runChatLoop(ctx, mutableCtx, latest.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader);
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
          if (!(await promptForAuthBeforeChat(out, readLine, mutableCtx, loginFn, detectEnvironmentFn, confirm, suspendStdin))) {
            continue;
          }
          const chatResult = await runChatLoop(ctx, mutableCtx, target.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader);
          spendDirty = true; // a task may have run — refresh the spend summary
          if (chatResult === 'exit') break;
        } else {
          out.write(`No conversation at position ${digit}.\n`);
        }
        continue;
      }

      // ---- [e] Manage conversations -------------------------------------------
      if (key === 'e') {
        await runManage(ctx, out, readLine, confirm);
        continue;
      }

      // ---- [i] Import a native conversation -----------------------------------
      if (key === 'i') {
        const importResult = await runImportNative(ctx, mutableCtx, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader);
        spendDirty = true; // an imported session may run a task — refresh spend
        if (importResult === 'exit') break;
        continue;
      }

      // ---- [r] Open a raw provider session ------------------------------------
      if (key === 'r') {
        await runRawProviderSession(out, readLine, mutableCtx.env, suspendStdin);
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
          confirm,
          ...(suspendStdin !== undefined ? { suspendStdin } : {}),
        });
        mutableCtx.env = await detectEnvironmentFn();
        continue;
      }

      // ---- [k] Login Codex ----------------------------------------------------
      if (key === 'k') {
        await loginFn(out, 'codex', {
          readLine,
          confirm,
          ...(suspendStdin !== undefined ? { suspendStdin } : {}),
        });
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
          // Preserve the install-safety rule from the line-mode path: EOF means
          // there is no interactive user, so never auto-install on a closed pipe.
          const canRawConfirm =
            out.isTty &&
            process.stdin.isTTY === true &&
            typeof process.stdin.setRawMode === 'function';
          const shouldInstall = canRawConfirm
            ? await confirm(true)
            : (() => readLine().then((ans) => ans !== null && parseYesNo(ans, true)))();
          if (!(await shouldInstall)) {
            out.write(`[2mSkipped. You can install it later: ${installCommandFor('opencode')}[0m\n`);
            continue;
          }
          const resumeStdin = suspendStdin?.();
          let ok = false;
          try {
            ok = await installProviderFn('opencode', out);
          } finally {
            resumeStdin?.();
          }
          mutableCtx.env = await detectEnvironmentFn();
          if (!ok || !mutableCtx.env.opencode.installed) {
            out.write(`Install failed. Run it yourself: ${installCommandFor('opencode')}\n`);
            continue;
          }
        }
        // opencode is (now) installed — proceed to sign in
        await loginFn(out, 'opencode', {
          readLine,
          confirm,
          ...(suspendStdin !== undefined ? { suspendStdin } : {}),
        });
        mutableCtx.env = await detectEnvironmentFn();
        continue;
      }

      // ---- [u] Update now -----------------------------------------------------
      // Only active when an update is actually available and the seam is wired.
      if (key === 'u' && updateInfo?.updateAvailable === true && updateSelfFn !== undefined) {
        const resumeStdin = suspendStdin?.();
        let ok = false;
        try {
          ok = await updateSelfFn(out).catch(() => false);
        } finally {
          resumeStdin?.();
        }
        if (ok && updateInfo.latest !== null) {
          out.write(`✓ Updated to ${updateInfo.latest} — restart myshell-tools to use it.\n`);
        } else if (!ok) {
          out.write('Update failed. Run: npm install -g myshell-tools@latest\n');
        }
        continue;
      }

      // ---- [m] Change mode (direct — no settings dive) ------------------------
      if (key === 'm') {
        const autoMode = resolveAutoMode(mutableCtx.env);
        mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode, mutableCtx.env);
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
