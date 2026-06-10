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
import { Writable } from 'node:stream';
import type { Clock, CoreEvent, LedgerWriter, OrchestrateDeps, SessionEntry, SessionWriter, Tier } from '../core/types.js';
import { buildGoalTask, parseGoalSignal, parseGoalContinueText, decideGoalNext, formatGoalProgress, DEFAULT_MAX_GOAL_ITERATIONS, stripTrailingGoalConfidenceEnvelope, formConciseGoalLabel } from '../core/goal.js';
import type { GoalCeilings } from '../core/goal.js';
import { appendCheckpointFromContinue, capContract } from '../core/work-contract.js';
import type { RoadmapItem, RoadmapItemVerdict } from '../core/work-contract.js';
import { managerCycleEnabled } from './ui/manager-flag.js';
import {
  pickNextTodo,
  buildTodoTask,
  managerCycleComplete,
  fixItTodo,
} from '../core/goal-manager.js';
import { deriveWorkStateFromHistory, renderWorkStateBlock } from '../core/work-state.js';
import { isKeepGoingOffer } from '../core/questions.js';
import { decideAutonomyOffer } from '../core/autonomy.js';
import { classify, hasWorkIntent } from '../core/classify.js';
import { resolveMemoryContextDetailed } from '../core/memory-injection.js';
import { buildEnvironmentContext } from '../core/repo-map.js';
import {
  buildToolStateContext,
  buildCapabilitySummary,
  type ToolStateProvider,
  type CapabilitySelfAwarenessSummary,
} from '../core/tool-state.js';
import { refreshCapabilities } from '../core/model-capability-refresh.js';
import { createCapabilityRefreshPort } from '../infra/model-capability-port.js';
import { nodeRepoScanPort } from '../infra/repo-scan.js';
import { createFileUserMemoryStore, resolveProjectKey } from '../infra/user-memory-store.js';
import { createFileTasteLedger } from '../infra/taste-ledger.js';
import { tasteEnabled } from '../core/taste-flag.js';
import { judgmentEnabled } from '../core/judgment-flag.js';
import { researchEnabled } from '../core/research-flag.js';
import { createNodeResearchPort } from '../infra/research-port.js';
import { renderSystemModelContext } from '../core/understanding.js';
import { isPushBackQuestionSet, classifyPushBackAnswer } from '../core/brain.js';
import { renderTastePlaybook, isImmediateRephrase, type TasteSignal } from '../core/taste.js';
import { createFileGoalStore } from '../infra/goal-store.js';
import { goalGlyph, roadmapProgress, goalVerdictTag, goalVerdictFromOutcome, isGoalVerifiedDone, isDuplicateGoalTitle, formatGoalsForContext, ROADMAP_LIMIT } from '../core/goal-todo.js';
import { buildVerifyReceipt } from '../core/verify.js';
import type { Goal, GoalState } from '../core/goal-todo.js';
import { boardEnabled } from './ui/board-flag.js';
import { autoStageEnabled } from './ui/auto-goal-flag.js';
import type { GoalBoardRow } from './ui/state.js';
import {
  runGoalsList,
  runTodoCreate,
  runTodoAdd,
  renderGoalExpanded,
  parseGoalsCommand,
  parseTodoCommand,
  listParked,
  parkedAt,
} from '../commands/goals.js';
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
import type { ConversationMeta, ConversationStore } from '../infra/conversation-store.js';
import { readLedger } from '../infra/ledger.js';
import { summarizeSpend } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { detectEnvironment } from '../providers/detect.js';
import { installProvider, installCommandFor } from '../providers/install.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import { route } from '../core/route.js';
import {
  POLICY_PRESETS,
  modeLabel,
  classifyPlan,
  tunePolicyForMaxSubTier,
} from '../core/policy.js';
import type { PlanInfo } from '../core/policy.js';
import type { Mode } from '../core/policy.js';
import { planNativeSession } from '../core/native-session.js';
import { decideHistoryPolicy } from '../core/turn-directive.js';
import { historyTruncationInfo } from '../core/history.js';
import { availableAfterCooldown, cooldownExpiry } from '../core/cooldown.js';
import { learnProviderOrder, learnModelOutcomeOrder } from '../core/routing-memory.js';
import type { OutputSink, TurnInputSurface, Verbosity } from './render.js';
import {
  canRenderInputBox,
  createTurnInputSurface,
  renderInputPrompt,
  renderQueuedIndicator,
  renderResumeTranscript,
} from './render.js';
import { isStubTitle } from '../infra/conversations.js';
import { systemClipboardPort, type ClipboardPort } from '../infra/clipboard.js';
import { resolveStateHome } from '../infra/state-dir.js';
import { resolveImageAttachments } from '../infra/attachments.js';
import { runTask } from './run.js';
import { runLogin } from '../commands/login.js';
import type { LoginMethod } from '../commands/login.js';
import { runDoctor } from '../commands/doctor.js';
import { runCost } from '../commands/cost.js';
import { dim, bold, formatRecapLine } from '../ui/theme.js';
import { makeRecapGenerator } from '../core/recap-generator.js';
import { makeGoalObjectiveGenerator } from '../core/goal-objective-generator.js';
import { makeGoalPlanner } from '../core/goal-plan-generator.js';
import type { GoalPlan, GoalPlanTodo } from '../core/goal-plan.js';
import { planTodosToRoadmap } from '../core/goal-plan.js';
import { formatGoalProposal, formatHeadsUp, formatAutoStageNote } from '../core/goal-proposal.js';
import { makeReplanner, applyReplanEditsViaStore } from '../core/goal-replan-generator.js';
import type { RoadmapEdit } from '../core/goal-replan.js';
import { makeUnderstandingPass } from '../core/understanding-generator.js';
import type { SystemModel } from '../core/understanding.js';
import { understandingEnabled } from './ui/understanding-flag.js';
import { verifiedDoneEnabled } from './ui/truly-complete-flag.js';
import { verifyStage } from '../core/work-call.js';
import { isRecapStale, recapEligible, type RecapResult } from '../core/recap.js';
import { makeRouteClassifier } from '../core/route-classifier.js';
import { makeIntentExtractor } from '../core/intent-extractor.js';
import { shouldShowFirstTouch, markSeen, FIRST_TOUCH_LINES } from '../core/first-touch.js';
import { teach } from '../core/teach.js';
import { decideShed, pressureFromSignals, type QuotaPressure } from '../core/capability-budget.js';
import type { UpdateCheckResult } from '../infra/update-check.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import { loadClaudeTokenCapturedAt, claudeTokenStatus } from '../infra/credentials.js';
import type { HealthIssue } from '../infra/health.js';
import {
  PROVIDER_LABEL,
  resolveAutoMode,
  hasAuthenticatedProvider,
} from './menu-auto-mode.js';
import { decidePostTurn } from './menu-post-turn.js';
import { planRetryTruncation, recentUserMessages } from './menu-message-redo.js';
import { completeChat } from './menu-completion.js';
import {
  runCopyCommand,
  runExportCommand,
  exportFileSlug,
} from './menu-io-commands.js';
import {
  autoUpdateEnabled,
  isRunningUnderNpx,
  countRecentInterrupts,
  interpretInterrupt,
} from './menu-display.js';
import {
  type LineReader,
  type ReadlineEchoController,
  type KeyInputStream,
  createLineReader,
  resolveRawKeyInput,
} from './menu-readline.js';
import { inkEnabled } from './ui/flag.js';
import { schedulerEnabled } from './ui/scheduler-flag.js';
import { governorEnabled } from './ui/governor-flag.js';
import { verifyEnabled } from './ui/verify-flag.js';
import { trustEnabled } from './ui/trust-flag.js';
import { tribunalEnabled } from './ui/tribunal-flag.js';
import { experimentalEnabledByDefault } from './ui/experimental-default.js';
import { nodeVerifyPort } from '../infra/verify-port.js';
import { nodeWorktreePort } from '../infra/worktree.js';
import { runSchedule, type GoalSpec, type RunGoalPhase } from '../core/scheduler.js';
import { decompose } from '../core/decompose.js';
import { orchestrate } from '../core/orchestrate.js';
import {
  type Confirm,
  attachChatTurnKeyListener,
  readMenuKey,
  makeConfirm,
} from './menu-key-confirm.js';
import { renderMainScreen } from './menu-render.js';
import {
  parseYesNo,
  yesNoHint,
} from './menu-questions.js';
import { runQuestionSelector } from './menu-question-flow.js';
import { runRawProviderSession } from './menu-raw-session.js';
import { runManage, runImportNative, runManageGoals } from './menu-conversations.js';
import { runWelcome } from './menu-welcome.js';
import {
  runModeSelect,
  runStyleSelect,
  runSettings,
} from './menu-settings.js';

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
   * Optional injected resolver for the filesystem path of the active
   * `myshell-tools` on PATH (production: `which`/`where myshell-tools`). Used
   * ONLY to enrich the post-update version-mismatch message so the user can see
   * WHERE the stale binary lives. Additive — never affects the success path.
   *
   * Returns the active binary path, or null when it cannot be resolved.
   */
  readonly activeBinPath?: () => Promise<string | null>;
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
// Internal readline helpers
// ---------------------------------------------------------------------------

class ReadlineOutputProxy extends Writable {
  readonly isTTY: boolean | undefined;
  // NB: explicit fields, NOT constructor parameter properties — the test runner
  // strips types in strip-only mode and rejects `constructor(private x)`.
  private readonly target: NodeJS.WriteStream;
  private readonly controller: ReadlineEchoController;
  constructor(target: NodeJS.WriteStream, controller: ReadlineEchoController) {
    super();
    this.target = target;
    this.controller = controller;
    this.isTTY = target.isTTY;
  }
  get columns(): number | undefined {
    return this.target.columns;
  }
  get rows(): number | undefined {
    return this.target.rows;
  }
  _write(chunk: Buffer | string, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (this.controller.muted) {
      cb();
      return;
    }
    // Forward the chunk as-is. With decodeStrings (the Writable default) Node hands
    // us a Buffer and passes `_encoding: 'buffer'`, so `chunk.toString(encoding)`
    // would throw ERR_UNKNOWN_ENCODING. stdout.write accepts a Buffer or string
    // directly, preserving the already-encoded bytes.
    this.target.write(chunk, cb);
  }
  getColorDepth(...args: Parameters<NodeJS.WriteStream['getColorDepth']>): number {
    return this.target.getColorDepth(...args);
  }
  hasColors(...args: Parameters<NodeJS.WriteStream['hasColors']>): boolean {
    return this.target.hasColors(...args);
  }
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
  // Single-key reader for the provider-pick keypress on the Ink path (read ONE key
  // through Ink's own input pipeline instead of the raw TTY, which Ink owns).
  // Absent → the legacy single-key pick is unchanged.
  inkReadKey?: () => Promise<string>,
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
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
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
  turnInput?: TurnInputSurface | null,
): void {
  if (verbosity === 'quiet') return;
  if (turnInput !== undefined && turnInput !== null) {
    turnInput.setQueued(queueLength);
    return;
  }
  const short = preview.length > 48 ? `${preview.slice(0, 48)}…` : preview;
  const indicator = renderQueuedIndicator(queueLength, out.color);
  out.write(dim(`  (${indicator}; ${short})\n`, out.color));
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

export async function runChatLoop(
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
  // EXPERIMENTAL Ink path. When provided, turns render through this driver (the
  // reducer-backed renderStreamInk) INSTEAD of the legacy renderStream, and the
  // legacy raw-mode turn chrome (the process.stdin ESC listener + the ANSI
  // overlay TurnInputSurface) is SUPPRESSED because Ink owns that surface. Absent
  // (the default, flag-off and test paths) → the legacy turn path is unchanged.
  inkRenderTurn?: import('./run.js').TurnRenderer,
  // Single-key reader for the Ink path (the same reader the main menu uses). When
  // provided, the in-chat /mode and /style menu choices resolve on a SINGLE
  // keypress through Ink's own input pipeline (matching the menu's single-key
  // feel). Chat-message input stays on the full line editor. Absent → the legacy
  // line-mode path is byte-identical.
  inkReadKey?: () => Promise<string>,
  // Ink turn-interrupt seam. When provided (the Ink path), runTaskWithInputHooks
  // installs a handler that aborts the in-flight turn's AbortController for the
  // duration of each turn and clears it after — the Ink twin of the legacy
  // raw-mode ESC→`currentAc.abort()` listener (the InputBox routes a bare ESC to
  // the installed handler). Absent (legacy/test paths) → no-op, byte-identical.
  inkSetInterrupt?: (handler: (() => void) | null) => void,
  inkSetInputInfo?: (info: { readonly mode: string; readonly hints: readonly string[] } | null) => void,
  // Ink chat-active seam. When provided (the Ink path), the App shows the full chat
  // composer ONLY while this is true. Set true at entry (below) and false in the
  // loop's finally on exit so returning to the menu hides the composer. Absent
  // (legacy/test paths) → no-op, byte-identical. Mirrors inkSetInputInfo.
  inkSetChatActive?: (active: boolean) => void,
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
    | ((history: readonly SessionEntry[], signal: AbortSignal) => Promise<RecapResult | null>)
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

  // Build a MANAGER-tier goal-objective former from the SAME env→deps machinery as
  // the recap generator (above). The objective is the most-seen string of an
  // autonomous run — the visible `goal: <…>` line, the anti-drift contract
  // OBJECTIVE, and the conversation title — so it must be named by a CAPABLE model
  // against the product-vision / quality bar (the reused ELITE_VOICE persona),
  // never the cheapest worker that echoes the user's raw text. Subscription-clean
  // (no new flag, no metered service). Returns null when no provider is signed in
  // so the caller degrades to the deterministic shaper. TIGHT timeout — this runs
  // ONCE at goal start and must never stall it.
  const buildGoalObjectiveGenerator = ():
    | ((rawText: string, signal: AbortSignal) => Promise<string | null>)
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

    // TIGHT cap: this gates goal START, so keep it shorter than the recap's 8s so a
    // slow model can't visibly delay the goal beginning. Fail-soft on timeout.
    const GOAL_OBJECTIVE_TIMEOUT_MS = 6_000;
    return makeGoalObjectiveGenerator({
      providers: ctx.providers,
      policy,
      cwd: ctx.cwd,
      timeoutMs: Math.min(ctx.timeoutMs, GOAL_OBJECTIVE_TIMEOUT_MS),
      ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
      ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
    });
  };

  // Build a MANAGER-tier PLANNING BRAIN (Elite-partner Phase 6) from the SAME
  // env→deps machinery as the recap / goal-objective generators (above). It judges
  // a substantial owner turn POST-reply and emits a GoalPlan: stage real parked
  // goals, surface ONE sharp clarifying question, or do nothing. Read by a CAPABLE
  // model against the reused ELITE_VOICE persona — judging WHAT is real work + how
  // to decompose it like a senior IS the headline behaviour, not a worker echo.
  // Subscription-clean (no metered service). Returns null when no provider is
  // signed in so the caller does nothing. TIGHT timeout — it runs post-turn,
  // non-blocking, and must never stall the conversation.
  const buildGoalPlanner = (
    systemModel?: SystemModel,
  ):
    | ((userMessage: string, signal: AbortSignal) => Promise<GoalPlan | null>)
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

    // TIGHT cap: it runs post-turn (non-blocking), so keep it short enough that a
    // slow model never delays the next prompt. Fail-soft on timeout → null.
    const GOAL_PLAN_TIMEOUT_MS = 8_000;
    return makeGoalPlanner({
      providers: ctx.providers,
      policy,
      cwd: ctx.cwd,
      timeoutMs: Math.min(ctx.timeoutMs, GOAL_PLAN_TIMEOUT_MS),
      ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
      ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
      // When the understanding pass produced a SystemModel, GROUND the planner in
      // it; absent → the planner prompt is byte-for-byte today's.
      ...(systemModel !== undefined ? { systemModel } : {}),
    });
  };

  // Build a MANAGER-tier AUTOMATIC RE-PLANNER (Elite-partner Part 1 "re-validate +
  // re-plan" + Part 4 living plan) from the SAME env→deps machinery as the planner
  // above. It maintains an ACTIVATED goal's to-do list like a senior PM — add /
  // edit / reorder / prune the PENDING steps so the plan stays the smartest path to
  // done — and is the AUTOMATIC consumer of the store's update/reorder/remove CRUD
  // (replacing the retired manual /todo edit/move/rm). Read by a CAPABLE model
  // against the reused ELITE_VOICE persona; NEVER touches a verified-done item;
  // NEVER fabricates a verdict. Subscription-clean (no metered service). Returns
  // null when no provider is signed in so the cycle proceeds unchanged. TIGHT
  // timeout — it runs inside the cycle and must never stall it.
  const buildReplanner = (
    systemModel?: SystemModel,
  ): ((goal: Goal, signal: AbortSignal) => Promise<RoadmapEdit[] | null>) | null => {
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

    // TIGHT cap: it runs inside the manager cycle (gated + bounded per activation),
    // so keep it short enough that a slow model never stalls execution. Fail-soft
    // on timeout → null → the roadmap is left unchanged.
    const GOAL_REPLAN_TIMEOUT_MS = 8_000;
    return makeReplanner({
      providers: ctx.providers,
      policy,
      cwd: ctx.cwd,
      timeoutMs: Math.min(ctx.timeoutMs, GOAL_REPLAN_TIMEOUT_MS),
      ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
      ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
      // When the understanding pass produced a SystemModel, GROUND the re-plan in
      // it; absent → the prompt is the ungrounded form.
      ...(systemModel !== undefined ? { systemModel } : {}),
    });
  };

  // ---- WHOLE-PICTURE UNDERSTANDING PASS (Elite-partner Part 2) -------------
  // Build a manager-tier, READ-ONLY investigation of the REAL system that runs
  // FIRST (before the planner) when MYSHELL_UNDERSTANDING is on — mapping the
  // relevant modules + interconnections, conventions, hard constraints, and the
  // genuinely-open questions into a SystemModel that grounds the planner. Mirrors
  // buildGoalPlanner exactly (same authed-pool / policy / tight-timeout shape).
  // Returns null when no provider is signed in → the caller plans ungrounded.
  // `repoContext` is the deterministic repo-map block (resolved once per session);
  // `highStakes` rides the EXISTING classify() risk signal so web search fires only
  // on genuinely high-stakes work (and only on a web-capable provider, inside the
  // generator). Subscription-clean: webSearch via the provider's native tool only.
  const buildUnderstandingPass = (
    repoContext: string,
    highStakes: boolean,
    timeoutMs?: number,
  ): ((task: string, signal: AbortSignal) => Promise<SystemModel | null>) | null => {
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
    // The BOUNDED map-grounded pass (understanding.ts) reads at most a couple of
    // files and reasons primarily from the repo orientation. Caller picks the budget:
    // the CACHE-AHEAD warm runs in the BACKGROUND (never blocks a turn), so it gets a
    // generous default; a (legacy) synchronous caller can pass a tighter one. A
    // timeout yields no 'done' event → null → ungrounded, so finishing is what matters.
    const UNDERSTANDING_TIMEOUT_MS = timeoutMs ?? 120_000;
    return makeUnderstandingPass({
      providers: ctx.providers,
      policy,
      cwd: ctx.cwd,
      timeoutMs: Math.min(ctx.timeoutMs, UNDERSTANDING_TIMEOUT_MS),
      ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
      ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
      ...(repoContext.trim().length > 0 ? { repoContext } : {}),
      ...(highStakes ? { highStakes: true } : {}),
    });
  };

  // Per-conversation rate-limit cooldown (declared early so the quota-shed plan
  // below — consumed by the recap-on-resume path and per-turn buildDeps — can read
  // it). When a turn fails with a rate-limit on a provider, remember it (expiry
  // epoch ms) so the next turn prefers an un-throttled provider; noteRateLimit
  // (below) populates it, availableAfterCooldown filters on it.
  const providerCooldownUntil = new Map<ProviderId, number>();

  // ---- MODEL CAPABILITY REGISTRY (Stage 1, §4) ----------------------------
  // Refresh the objective capability facts ONCE per chat session (the local Codex
  // cache + advertised model set are stable within a session, like the repo map)
  // and feed the capped summary into the self-awareness block via buildToolStateContext.
  // Cheap + FULLY fail-soft (any error / missing cache → undefined → the ABOUT
  // block renders exactly as before; reasoning efforts stay "unknown"). NO model
  // call, NO network. Reads mutableCtx.env so it reflects the detected providers.
  // PER-SESSION capability cache (Stage 1/3). The objective capability summary +
  // the STRUCTURED registry it was derived from, both resolved ONCE per chat
  // session from the SAME snapshot (REUSED, never recomputed) and memoized behind
  // `resolved`. `summary` feeds the self-awareness ABOUT block; `registry` is
  // threaded into orchestrate's route()/selectReasoningEffort. Either absent on a
  // fail-soft refresh failure → unchanged routing / the ABOUT block renders as
  // before. Grouped into one object so the three cross-turn fields share one
  // explicit holder instead of three free closure `let`s.
  const caps: {
    summary: CapabilitySelfAwarenessSummary | undefined;
    registry: import('../core/model-capabilities.js').CapabilityRegistry | undefined;
    resolved: boolean;
  } = { summary: undefined, registry: undefined, resolved: false };
  const resolveCapabilitySummaryOnce = async (): Promise<
    CapabilitySelfAwarenessSummary | undefined
  > => {
    if (caps.resolved) return caps.summary;
    caps.resolved = true;
    try {
      const { registry } = await refreshCapabilities(
        {
          providers: [
            mutableCtx.env.claude,
            mutableCtx.env.codex,
            mutableCtx.env.opencode,
          ].map((p) => ({
            provider: p.id,
            authenticated: p.authenticated,
            availableModels: p.availableModels,
          })),
          nowIso: ctx.clock.isoNow(),
        },
        createCapabilityRefreshPort(process.env, ctx.cwd),
      );
      caps.registry = registry;
      caps.summary = buildCapabilitySummary(
        registry,
        {
          claude: mutableCtx.env.claude.authenticated,
          codex: mutableCtx.env.codex.authenticated,
          opencode: mutableCtx.env.opencode.authenticated,
        },
        (p) => PROVIDER_LABEL[p] ?? p,
      );
    } catch {
      caps.summary = undefined;
      caps.registry = undefined;
    }
    return caps.summary;
  };

  // Quota-shed (whole-tool-finish §3.2): derive the per-turn shed plan from the
  // ONE pressure signal the renderer already tracks — how many providers are in
  // rate-limit cooldown right now — with NO new probe and NO token-budget readout
  // (subscription-auth has none). The pure decideShed returns the ordered ladder:
  // recap refresh → narrow memory to identity/constraints → skip the intent pass
  // → CORE ANSWER always survives. Recomputed each turn so a cooldown expiring
  // restores full capability. Shared by resolveRecap (recap rung), buildDeps
  // (intent rung) and resolveTurnMemory (memory rung).
  // The REAL live quota pressure (0–3) the conversation layer observes — the count
  // of providers currently in rate-limit cooldown (real 429s this session), mapped
  // by the SAME pure `pressureFromSignals` the shed plan uses. This is the ONE real,
  // free, in-process pressure dimension available on subscription CLIs (there is no
  // token-budget readout, so that dimension stays an honest 0 inside
  // `pressureFromSignals`). Shared by `currentShedPlan` (the quota-shed ladder) and
  // `buildDeps` (the Governor's `governorPressure`), so both read the SAME signal and
  // the governor shrinks its per-turn budget under the same genuine pressure.
  const currentPressure = (): QuotaPressure => {
    const nowMs = ctx.clock.now();
    let cooledCount = 0;
    for (const until of providerCooldownUntil.values()) {
      if (until > nowMs) cooledCount++;
    }
    return pressureFromSignals({ rateLimitedProviderCount: cooledCount });
  };
  const currentShedPlan = (): ReturnType<typeof decideShed> => decideShed(currentPressure());

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
    let fresh: RecapResult | null = null;
    try {
      fresh = await generate(entries, new AbortController().signal);
    } catch {
      fresh = null;
    }
    if (fresh === null) {
      // Generation failed/empty — fall back to a stale cache or nothing. NEVER block.
      return cached.length > 0 ? cached : null;
    }
    const normalised = fresh.recap;
    try {
      await ctx.store.setRecap(convId, normalised, messageCount);
    } catch {
      // Caching is best-effort; show the recap even if persisting it failed.
    }
    // Smart auto-naming: the SAME manager pass that wrote the state line also
    // produced a professional TITLE (a crisp objective, not an echo of the user's
    // phrasing). When the title is still an auto-derived STUB (the first-words
    // truncation of the opening message), upgrade it to the model title — no extra
    // model call, it rides the one pass we already made. Fail-soft + guarded so a
    // deliberate name is never clobbered and there is no churn (only rename when it
    // differs).
    try {
      const smartTitle = fresh.title;
      if (smartTitle !== null) {
        const firstUser = entries.find((e) => e.role === 'user')?.content ?? null;
        const currentTitle = meta?.title ?? '';
        if (isStubTitle(currentTitle, firstUser) && smartTitle !== currentTitle.trim()) {
          await ctx.store.rename(convId, smartTitle);
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
      // Honesty: the transcript above shows the WHOLE scrollback, but the model
      // only receives compactHistory's recent window. When that compaction drops
      // whole turns, say so once — quietly — so the user knows the model isn't
      // seeing everything above. Uses the same bounds as the actual replay, so
      // the note can't disagree with what was sent. Non-alarming, dim, one line.
      const trunc = historyTruncationInfo(priorEntries);
      if (trunc.truncated) {
        const turnWord = trunc.droppedTurns === 1 ? 'turn' : 'turns';
        out.write(
          dim(
            `  ※ ${trunc.droppedTurns} older ${turnWord} above are outside the model's context window — it sees the recent part.\n`,
            out.color,
          ),
        );
      }
    }
  }

  // Conversation-live guard: true while this resume's chat loop is active, cleared
  // in the loop's finally. Read by the concurrent recap write below so a recap that
  // resolves AFTER the user has already left the conversation can't print into the
  // menu/sub-flow that replaced it.
  let conversationLive = true;

  // One quiet orientation line on entry — NOT a per-turn label. Real chat shells
  // (claude, gpt) don't relabel the prompt every turn; they show a clean caret and
  // let you just type. Shown once; the caret below carries every turn after. The
  // active mode is shown here too so it's always visible in-conversation.
  //
  // Ordered BEFORE the recap (below) so the composer goes live INSTANTLY on resume —
  // the recap can require a MANAGER-tier model call (up to RECAP_TIMEOUT_MS) and must
  // never block the user from typing. The recap resolves concurrently and prints when
  // ready (a beat after the prompt is already live; instant input beats perfect order).
  {
    const entryMode = modeLabel(
      mutableCtx.config.mode ?? resolveAutoMode(mutableCtx.env),
    );
    // Show the chat composer now that an active conversation is starting (the
    // menu/sub-flows ran with it hidden). Cleared in the loop's finally on exit.
    inkSetChatActive?.(true);
    if (inkSetInputInfo !== undefined) {
      inkSetInputInfo({ mode: entryMode, hints: ['/goal', '/help', '/back'] });
    } else {
      out.write(
        dim(
          `Type a message and press Enter.  Mode: ${entryMode} (/mode)  ·  /goal  ·  /help  ·  /back\n`,
          out.color,
        ),
      );
    }
  }

  // Recap on resume: replace the weak tail-echo with a real ※ recap line when one
  // is available; otherwise stay silent (prior behaviour with no recap). Resolved
  // CONCURRENTLY (NOT awaited here) so a stale-cache recap's MANAGER-tier model call
  // can't stall input — the composer is already live (above). resolveRecap's side
  // effects (storing the fresh recap + the smart title) still happen. Fail-soft: any
  // error is swallowed, never thrown, never blocks. The write is gated on the
  // conversation still being live (`conversationLive`, cleared in the loop's finally)
  // so a late recap that resolves AFTER the user has left can't corrupt the menu.
  const recapResolved: Promise<void> = (async (): Promise<void> => {
    let recapText: string | null = null;
    try {
      recapText = await resolveRecap(false);
    } catch {
      recapText = null; // fail-soft: a recap failure must never block resume
    }
    if (recapText !== null && conversationLive) {
      // First-touch explainer for the ※ glyph, once ever, printed ABOVE the recap.
      await showFirstTouch('recap');
      if (conversationLive) {
        out.write('\n  ' + formatRecapLine(recapText, out.color) + '\n\n');
      }
    }
  })();
  // Surface (and swallow) any rejection so the floating promise never trips an
  // unhandled-rejection; the loop awaits it in finally to settle side effects.
  recapResolved.catch(() => {});

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
  // Stage 4 (§2 Layer 3): learned MODEL-level outcome order per task kind, from the
  // SAME recent-ledger slice. Weakest signal; below-threshold task kinds get no
  // entry (learnModelOutcomeOrder → null) so routing is unchanged.
  const modelOutcomeOrderByTaskKind: Partial<
    Record<
      import('../core/model-capabilities.js').TaskKind,
      readonly import('../core/model-capabilities.js').ModelPreference[]
    >
  > = {};
  if (mutableCtx.config.learnRouting === true) {
    const allEntries = await readLedger(ctx.cwd);
    const recent = allEntries.slice(-500);
    for (const tier of ['worker', 'ic', 'manager'] as const) {
      const order = learnProviderOrder(recent, tier);
      if (order !== null) learnedProviderOrder[tier] = order;
    }
    for (const kind of [
      'trivial', 'implementation', 'debug', 'review', 'architecture', 'large-context', 'unknown',
    ] as const) {
      const order = learnModelOutcomeOrder(recent, kind);
      if (order !== null) modelOutcomeOrderByTaskKind[kind] = order;
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

  // True on the EXPERIMENTAL Ink path — turns render via inkRenderTurn and Ink
  // owns the input surface, so the legacy raw-mode turn chrome (process.stdin ESC
  // listener + ANSI overlay) must NOT engage (it would fight Ink's render).
  const inkPath = inkRenderTurn !== undefined;

  // Stdin used by the scoped ESC listener. Only the real readLine path (where
  // the LineReader owns process.stdin) gets a live listener; the injected-test
  // path leaves this absent so attachChatTurnKeyListener degrades to a no-op. On
  // the Ink path it is also absent (Ink owns process.stdin; a raw listener here
  // would fight it).
  const turnKeyStdin: KeyInputStream | undefined =
    !inkPath && lineReader !== undefined && lineReader !== null
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
    // Optional CoreEvent producer override — the bounded scheduler passes its
    // merged goalId-tagged stream here so it rides the SAME renderer + input
    // hooks as a normal turn. Absent → the default single-orchestrate path.
    events?: AsyncIterable<CoreEvent>,
  ): Promise<Awaited<ReturnType<typeof runTask>>> => {
    // Fresh interrupt state for THIS task (a prior turn's ESC must not leak).
    interruptedByEsc = false;
    // The ANSI overlay TurnInputSurface paints directly to `out` with cursor
    // moves — correct over the legacy renderer, but it would corrupt the Ink
    // render (Ink owns the live region). On the Ink path it stays null; the Ink
    // StatusBlock/Stream render the spinner + queued indicator instead.
    const turnInput = inkPath
      ? null
      : createTurnInputSurface(out, { columns: process.stdout.columns });
    // Typed-ahead capture (only when the real LineReader owns stdin).
    const stopCapture =
      lineReader !== undefined && lineReader !== null
        ? lineReader.beginCapture((captured: string) => {
            queuedTurns.push(captured);
            renderQueuedHint(out, verbosity, queuedTurns.length, captured, turnInput);
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
          }, () => {
            if (lineReader !== undefined && lineReader !== null) {
              turnInput?.setValue(lineReader.currentLine());
            }
          })
        : (): void => {};
    // Ink-path interrupt: install a handler the InputBox routes a bare ESC to. It
    // mirrors the legacy ESC semantics exactly — mark the turn interrupted-by-ESC
    // (so decidePostTurn discards the typed-ahead queue) and abort THIS turn's
    // AbortController, staying at the chat prompt (never the Ctrl+C window, never
    // back to the menu). Cleared in `finally` so an idle-prompt ESC is a no-op.
    // No-op off the Ink path (inkSetInterrupt undefined).
    if (inkSetInterrupt !== undefined) {
      inkSetInterrupt(() => {
        interruptedByEsc = true;
        currentAc?.abort();
      });
    }
    try {
      return await runTask(taskLine, taskDeps, out, signal, verbosity, turnInput, inkRenderTurn, events);
    } finally {
      detachEsc();
      if (inkSetInterrupt !== undefined) inkSetInterrupt(null);
      if (stopCapture !== null) stopCapture();
      turnInput?.clear();
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
      interrupted: interruptedByEsc || control.exit || control.menu,
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
          if (interruptedByEsc || control.exit || control.menu || hasQuestions || hasMemoryProposal) {
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

  // Loop-control signal state, grouped into one explicit holder. The 'exit' and
  // 'menu' signals are communicated from the SIGINT handler to the main loop via
  // `exit`/`menu` (the handler can't break the outer while directly); `result` is
  // the value runChatLoop returns once the loop settles. One object instead of
  // three free closure `let`s — same fields, same timing.
  const control: { exit: boolean; menu: boolean; result: 'menu' | 'exit' } = {
    exit: false,
    menu: false,
    result: 'menu',
  };

  // Handle Ctrl+C with the press-counting model.
  const sigintHandler = (): void => {
    const now = ctx.clock.now();
    interruptTimes.push(now);
    // Prune entries older than the window so the array can't grow unbounded over
    // a long session — countRecentInterrupts only ever looks at the recent window,
    // so anything older is dead weight. Keep it tiny and in place.
    const cutoff = now - INTERRUPT_WINDOW_MS;
    let writeIdx = 0;
    for (let readIdx = 0; readIdx < interruptTimes.length; readIdx += 1) {
      const t = interruptTimes[readIdx];
      if (t !== undefined && t >= cutoff) interruptTimes[writeIdx++] = t;
    }
    interruptTimes.length = writeIdx;
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
      // Set control.menu so the loop returns 'menu' after any running task settles.
      control.menu = true;
      // For the readLine case (idle prompt) we can interrupt the await immediately
      // via the loopBreaker resolver.
      loopBreaker?.('menu');
    } else {
      // exit-app
      if (currentAc !== null) {
        currentAc.abort();
        currentAc = null;
      }
      control.exit = true;
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

  try {
    while (true) {
      const promptColumns = process.stdout.columns;
      const promptIsBoxed = canRenderInputBox({
        color: out.color,
        isTty: out.isTty,
        columns: promptColumns,
      });
      // On the Ink path the real <InputBox> composer renders the prompt; writing
      // the legacy multi-line box string (embedded ANSI cursor moves + borders)
      // into the Ink sink would commit broken <Static> chrome above it each turn.
      if (!inkPath) {
        out.write(renderInputPrompt({
          color: out.color,
          isTty: out.isTty,
          columns: promptColumns,
        }));
      }

      // Race readLine() against a loopBreak signal from the SIGINT handler.
      // When Ctrl+C fires (to-menu or exit-app), loopBreaker is called with the
      // desired result, which wins the race and breaks the loop.
      const line = await new Promise<string | null | 'menu' | 'exit'>((resolve) => {
        loopBreaker = resolve;
        readLine().then(resolve).catch(() => resolve(null));
      });
      loopBreaker = null;

      // SIGINT-driven exit signals. The loopBreaker resolver won the race against
      // readLine(), so the nextLine() awaiter it raced is still parked in the
      // shared LineReader's waiters[] — drop it (resolve null), or the first line
      // typed in the menu we're about to break to is delivered FIFO to that dead
      // resolver and silently swallowed.
      if (line === 'menu') {
        lineReader?.cancelPending();
        control.result = 'menu';
        break;
      }
      if (line === 'exit') {
        lineReader?.cancelPending();
        control.result = 'exit';
        break;
      }

      // EOF → exit the chat loop gracefully
      if (line === null) break;
      if (!inkPath && promptIsBoxed) out.write('\n');

      if (line.length === 0) continue;

      // One input → one turn (+ its post-turn slot). Drain-queue re-enters this
      // SAME helper so a typed-ahead line is handled identically to a fresh
      // prompt line (including queued slash commands like /back). Returns a
      // control signal for the outer loop.
      const signal = await runOneChatInput(line);
      if (signal === 'menu') {
        control.result = 'menu';
        break;
      }
      if (signal === 'exit') {
        control.result = 'exit';
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    loopBreaker = null;
    // Mark the conversation no longer live FIRST so a still-pending concurrent recap
    // (fired on resume) sees the gate closed and skips its write into the menu.
    conversationLive = false;
    // Let the concurrent recap settle so its side effects (storing the fresh recap +
    // the smart title) complete; the write itself is already gated out above. Never
    // throws (the promise swallows its own errors).
    await recapResolved;
    // Hide the chat composer on exit (back to the menu / app exit) so it never
    // lingers in the menu or sub-flows. Mirrors the entry inkSetChatActive(true).
    inkSetChatActive?.(false);
  }

  return control.result;

  // -------------------------------------------------------------------------
  // runOneChatInput — process a single chat input (prompt OR queued), run its
  // turn, then drive the canonical post-turn slot (decidePostTurn). Hoisted as a
  // function declaration so the loop above can call it before its definition;
  // it closes over the loop's mutable state (currentAc, control.exit/menu, queue).
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
        '  /todo <text>  — park a goal + its to-do for later (/goals to manage)\n' +
        '  /todo add|done|block <g> ... — capture a to-do or check one off\n' +
        '  /goals        — list goals by state; show/go/drop a parked one\n' +
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
        dim('    ※ Staged N goals        I plan real work into goals on the board as we talk;\n', out.color) +
        dim('                            turn it off with MYSHELL_AUTO_GOAL=0 (board: MYSHELL_BOARD=0)\n', out.color) +
        dim('    "what I understood…"    I restate the task before big work — correct me anytime\n', out.color) +
        dim('    "Waiting on N models"   models running in parallel — no dollar charge on a\n', out.color) +
        dim('                            subscription, but each run draws on your plan\'s rate\n', out.color) +
        dim('                            limit/quota and adds some latency\n', out.color) +
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
        inkReadKey,
      );
      return 'continue';
    }

    // Change the (single, global) mode from inside the chat — same knob as the
    // home [m], so there is one source of truth and never a global/per-chat drift.
    if (line === '/mode') {
      const autoMode = resolveAutoMode(mutableCtx.env);
      mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode, mutableCtx.env, inkReadKey);
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
      // Concurrency (panel / hedge) is now owned by the mode preset: Balanced and
      // Max auto-engage them on hard turns, Efficient leaves them off (see
      // POLICY_PRESETS). config.panel / config.hedge remain as explicit power-user
      // overrides that FORCE the strategy on regardless of mode — e.g. force a panel
      // even under Efficient. (Absent → the preset's default stands; there is no
      // force-OFF override yet — a user who wants neither picks Efficient.)
      // Quota-aware auto tuning: when mode is AUTO (no explicit /mode), narrow the
      // Max panel to 2 providers for a detected Max 5x account (gentler on its
      // smaller quota); 20x / generic Max / explicit-mode users are unchanged.
      const autoTunedPreset =
        mutableCtx.config.mode === undefined
          ? tunePolicyForMaxSubTier(
              POLICY_PRESETS[effectiveMode],
              [mutableCtx.env.claude, mutableCtx.env.codex, mutableCtx.env.opencode]
                .filter((p) => p.authenticated)
                .map((p) => p.plan),
            )
          : POLICY_PRESETS[effectiveMode];
      const policy = {
        ...autoTunedPreset,
        ...(mutableCtx.config.panel === true ? { panelPolicy: 'hard-turns' as const } : {}),
        ...(mutableCtx.config.hedge === true ? { hedgePolicy: 'on' as const } : {}),
      };

      // NOTE (Bug 4 / FIX 3): the no-provider gate used to sit HERE, BEFORE the
      // local-only slash dispatch (/memory, /forget, /goals, /todo, /remember) below.
      // Those commands run entirely LOCALLY (no model call), so gating them here made
      // them print "No signed-in provider yet" and do nothing. The gate now lives just
      // before the metered orchestrate/work path (search "no-provider gate" below) so
      // the local commands work even when no provider is authed, while every command
      // that actually needs a model still gates. (Goal loops are model-needing and
      // self-gate inside runGoalLoop.)

      // Load prior history before each turn so the provider receives conversation
      // context. load() returns only the entries persisted so far — the current
      // user turn is appended by orchestrate() after this point, so there is no
      // double-inclusion risk. Fail-soft: a corrupt/unreadable store must degrade
      // to an empty thread with a one-line dim notice, never crash runChatLoop /
      // startMenu (matches the resume-path load guard above).
      let priorHistory: SessionEntry[] = [];
      try {
        priorHistory = await ctx.store.load(convId);
      } catch {
        priorHistory = [];
        out.write(dim("  Couldn't read prior history — continuing without it.\n", out.color));
      }

      // Resolve the capability summary once per session (await here so the
      // synchronous buildDeps below can read the memoized value). Fail-soft → undefined.
      await resolveCapabilitySummaryOnce();

      // ---- CURRENT GOALS / PLAN snapshot (the partner's OWN plan) -------------
      // The persisted goalStore is created LATER (after buildDeps is defined), so
      // buildDeps cannot read it directly. We hold the latest rendered plan block in
      // this mutable string and expose a lazy `currentGoalContext` closure that
      // buildDeps captures by reference and only CALLS at turn time. The snapshot is
      // refreshed fail-soft at the start of every turn (refreshGoalContext, defined
      // alongside the board sync below — INDEPENDENT of the board flag so the model
      // always knows its plan). Empty until a goal exists → byte-identical prompts.
      let goalContextSnapshot = '';
      const currentGoalContext = (): string => goalContextSnapshot;

      // ---- SYSTEM UNDERSTANDING snapshot (Phase 3a) --------------------------
      // The warm SystemModel cache is created LATER (the goal/auto-stage flow), so —
      // exactly like currentGoalContext — buildDeps reads it through a lazy closure
      // captured by reference and only CALLED at turn time. It renders the MOST
      // RECENTLY warmed SystemModel into the WORK-prompt SYSTEM UNDERSTANDING block.
      // Empty until a model is warm → byte-identical prompts. Fail-soft: any error → ''.
      const currentUnderstandingContext = (): string => {
        try {
          let latest: SystemModel | undefined;
          let latestTurn = -1;
          for (const entry of systemModelCache.values()) {
            if (entry.atTurn >= latestTurn) {
              latest = entry.model;
              latestTurn = entry.atTurn;
            }
          }
          return renderSystemModelContext(latest);
        } catch {
          return '';
        }
      };

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
        // LEARNED-TASTE recall for this turn (Phase-7 free layer), computed per-turn
        // by resolveTurnTaste below ONLY when the taste flag is ON. `tasteContext` is
        // the distilled playbook prompt block; `memoryBias` is the ±1 ask-vs-proceed
        // dial fed into EngagementSignals.memoryBias. Absent → byte-identical path.
        taste?: {
          tasteContext?: string;
          memoryBias?: -1 | 0 | 1;
          tastePlaybookLines?: readonly string[];
        },
      ): OrchestrateDeps => {
        // CURRENT GOALS / PLAN block (the partner's OWN plan). `goalStore` is created
        // AFTER buildDeps is defined, so we read it through the lazy
        // `currentGoalContext` closure (defined below, captured by reference): the
        // closure is only CALLED here at turn time, after goalStore exists. It returns
        // the latest fail-soft snapshot string (refreshed each turn alongside the
        // board) or '' — so a goalless tool yields a byte-identical prompt. PURE read.
        const goalContext = currentGoalContext();
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
        //
        // STALE-HISTORY HARDENING (AP2-F / Stage 6, §3): decide the history policy
        // ONCE here (over the prior assistant turns + their engine-behavior version
        // markers) and pass it to planNativeSession. On a quarantined turn — a prior
        // assistant turn was a generic menu OR predates the enforced-ask engine
        // version — planNativeSession withholds the plan, so orchestrate replays the
        // CLEANED history rather than resuming the provider's server-side memory of
        // the poisoned/legacy prose. Clean turns are unaffected (native as before).
        const nativeHistoryPolicy = decideHistoryPolicy(
          hist
            .filter((e) => e.role === 'assistant')
            .map((e) => ({
              content: e.content,
              ...(e.engineBehaviorVersion !== undefined
                ? { engineBehaviorVersion: e.engineBehaviorVersion }
                : {}),
            })),
        );
        const nativeSession = planNativeSession({
          enabled: mutableCtx.config.nativeSessions === true,
          conversationId: convId,
          history: hist,
          historyPolicy: nativeHistoryPolicy,
        });
        // planNativeSession returns [] when disabled / no conversation id / quarantined.

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

        // ---- TOOL SELF-AWARENESS (tool-state §) ---------------------------------
        // Render the authoritative "ABOUT THIS TOOL" block from the LIVE env + the
        // effective mode (explicit vs auto) + config, so the partner answers "how
        // many subscriptions am I authed / what mode am I in" from truth, not a
        // guess. Pure assembly, NO model call. modeIsAuto = no explicit config.mode.
        const toolStateProviders: ToolStateProvider[] = [
          mutableCtx.env.claude,
          mutableCtx.env.codex,
          mutableCtx.env.opencode,
        ].map((p) => ({
          label: PROVIDER_LABEL[p.id] ?? p.id,
          installed: p.installed,
          authenticated: p.authenticated,
          plan: p.plan,
        }));
        // ---- WORK-STATE AWARENESS (adaptive-partner-v2-5.6.md §2.3 B) ----------
        // Derive a TRUTHFUL "what's done / what's next" snapshot from the
        // already-loaded history's persisted workTrace and pre-render the WORK STATE
        // block. PURE, NO model call (subscription-cost clean). This is task/session
        // CONTINUITY seeded ONLY from workTrace — kept distinct from USER MEMORY.
        // Threaded into deps below so it rides sequential, hedge, AND panel prompts
        // (orchestrate re-derives identically when absent). Truthful or absent.
        const workStateContext = renderWorkStateBlock(deriveWorkStateFromHistory(hist));

        const toolStateContext = buildToolStateContext({
          version: ctx.version,
          providers: toolStateProviders,
          mode: effectiveMode,
          modeIsAuto: mutableCtx.config.mode === undefined,
          smartRoute: mutableCtx.config.smartRoute !== false,
          // Objective capability summary (Stage 1, §4) — memoized once per session
          // by resolveCapabilitySummaryOnce; absent → the block renders as before.
          ...(caps.summary !== undefined ? { capabilitySummary: caps.summary } : {}),
        });

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
          // Structured capability registry (Stage 3) — the SAME snapshot the
          // self-awareness summary was derived from (resolveCapabilitySummaryOnce),
          // REUSED here so orchestrate's route()/selectReasoningEffort can use it.
          // Absent → no capability context, no effort flag (unchanged routing).
          ...(caps.registry !== undefined ? { capabilityRegistry: caps.registry } : {}),
          ...(nativeSession.length > 0 ? { nativeSession } : {}),
          ...(routeClassifier !== undefined ? { routeClassifier } : {}),
          ...(intentExtractor !== undefined ? { intentExtractor } : {}),
          ...(Object.keys(learnedProviderOrder).length > 0 ? { learnedProviderOrder } : {}),
          ...(Object.keys(modelOutcomeOrderByTaskKind).length > 0
            ? { modelOutcomeOrderByTaskKind }
            : {}),
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
          // LEARNED-TASTE playbook block + ask-vs-proceed dial (Phase-7 free layer).
          // Present ONLY when the taste flag is ON and the distill produced a
          // non-empty playbook / non-zero bias (resolveTurnTaste returns {} when the
          // flag is off → byte-identical prompts + unmoved engagement). The block
          // rides sequential/hedge/panel via assembleContextBlocks; memoryBias feeds
          // EngagementSignals.memoryBias (the wired-but-unfed dial).
          ...(taste?.tasteContext !== undefined && taste.tasteContext.length > 0
            ? { tasteContext: taste.tasteContext }
            : {}),
          ...(taste?.memoryBias !== undefined && taste.memoryBias !== 0
            ? { memoryBias: taste.memoryBias }
            : {}),
          // THE FREE JUDGMENT LAYER (master-plan PHASE 5). Enable the brain's
          // `push_back` capability ONLY when the judgment flag is ON; pass the
          // structured taste lines so the taste-violation source can name the
          // specific recorded call. Both absent when the flag is off → the brain's
          // decideNextMove is byte-for-byte today's path (the OFF-GUARANTEE).
          ...(judgmentOn ? { judgmentEnabled: true } : {}),
          ...(taste?.tastePlaybookLines !== undefined && taste.tastePlaybookLines.length > 0
            ? { tastePlaybookLines: taste.tastePlaybookLines }
            : {}),
          // WORK STATE block (AP2-B §2.3 B) — present only when an accepted prior
          // turn carried a trusted workTrace (resumed/continuing chat). Truthful or
          // absent; pure derivation from the loaded history, no model call.
          ...(workStateContext.length > 0 ? { workStateContext } : {}),
          // CURRENT GOALS / PLAN block (the partner's OWN plan) — present only when the
          // goalStore holds at least one in-scope goal (currentGoalContext returns ''
          // otherwise → byte-identical). Rides sequential, hedge, AND panel prompts via
          // assembleContextBlocks (rendered right after WORK STATE). Fail-soft snapshot.
          ...(goalContext.length > 0 ? { goalContext } : {}),
          // ENVIRONMENT / repo-map orientation block (E1) — gathered once per
          // session, present only when codebase awareness is on AND the scan
          // produced a non-empty block (fail-soft → '' otherwise).
          ...(environmentContext !== undefined && environmentContext.length > 0
            ? { environmentContext }
            : {}),
          // TOOL-STATE / ABOUT block (tool self-awareness) — present only when the
          // pure renderer produced a non-empty block (it always does given a version).
          ...(toolStateContext.length > 0 ? { toolStateContext } : {}),
          // PERFORMANCE GOVERNOR (Phase 2 skeleton) — DEFAULT ON at the entry point
          // (frictionless). Resolved by the composition-root default-on resolver;
          // disabled only by an explicit opt-out (MYSHELL_GOVERNOR ∈ {0,false,off,no}
          // OR config.experimentalGovernor===false) or global basic mode. When off,
          // orchestrate short-circuits before consulting the governor so the
          // admission path is byte-for-byte unchanged. Present only when true (so the
          // off state keeps the field off entirely).
          ...(experimentalEnabledByDefault(
            process.env,
            mutableCtx.config,
            'MYSHELL_GOVERNOR',
            mutableCtx.config.experimentalGovernor,
            governorEnabled,
          )
            ? {
                governorEnabled: true,
                // REAL live pressure (master-plan PHASE 4 — closing the Phase-2
                // honest-zero gap). The governor's per-turn budget shrinks under
                // genuine 429 pressure. The ONE real, observable dimension on
                // subscription CLIs: how many providers are in rate-limit cooldown
                // right now (the SAME `currentPressure` signal `decideShed` reads).
                // There is NO token-budget readout on subscription auth, so that
                // dimension stays an honest 0 inside `pressureFromSignals` — never
                // fabricated. Only set when the Governor flag is ON, so the off path
                // is byte-for-byte unchanged. A 0 here is the same as absent (the
                // consult falls back to the honest zero either way), so it never
                // changes a no-pressure turn.
                governorPressure: currentPressure(),
              }
            : {}),
          // VERIFICATION CENTERPIECE (master-plan PHASE 3) — DEFAULT ON at the entry
          // point (frictionless). Resolved by the composition-root default-on resolver;
          // disabled only by an explicit opt-out (MYSHELL_VERIFY ∈ {0,false,off,no} OR
          // config.experimentalVerify===false) or global basic mode. When ON, inject the
          // impure VerifyPort (git-diff + bounded test-runner) + the conservative
          // built-in floor level ('tests' — tests-first, the free signal). The verify
          // stage runs at the turn's accept point and surfaces an honest four-state
          // receipt. When OFF the port is absent → verifyStage returns
          // undefined → the accept path is byte-for-byte unchanged (the
          // characterization + oracle suites prove that neutrality). The Governor's
          // `verify` lever, when its flag is also on, refines the level per turn.
          ...(experimentalEnabledByDefault(
            process.env,
            mutableCtx.config,
            'MYSHELL_VERIFY',
            mutableCtx.config.experimentalVerify,
            verifyEnabled,
          )
            ? {
                verifyPort: nodeVerifyPort,
                verifyLevel: 'tests' as const,
                verifyTestTimeoutMs: Math.min(ctx.timeoutMs, 120_000),
              }
            : {}),
          // THE TRUST SURFACE (master-plan PHASE 8) — DEFAULT ON at the entry point
          // (frictionless). Resolved by the composition-root default-on resolver;
          // disabled only by an explicit opt-out (MYSHELL_TRUST ∈ {0,false,off,no} OR
          // config.experimentalTrust===false) or global basic mode. When ON, the
          // accept-point receipt is UPGRADED from the bare verify line into the
          // consolidated, auditable trust receipt (auditable confidence + verify + an
          // honest self-audit), composed PURELY from the real signals already on the
          // turn (no new model call). When OFF the accept path emits EXACTLY today's
          // single verify line — byte-for-byte neutrality. The underlying signals are
          // themselves resolved the same way, so in global basic mode the surface is
          // doubly dark.
          ...(experimentalEnabledByDefault(
            process.env,
            mutableCtx.config,
            'MYSHELL_TRUST',
            mutableCtx.config.experimentalTrust,
            trustEnabled,
          )
            ? { trustEnabled: true }
            : {}),
          // THE RIVAL TRIBUNAL (master-plan PHASE 9) — DEFAULT ON at the entry point
          // (frictionless). Resolved by the composition-root default-on resolver;
          // disabled only by an explicit opt-out (MYSHELL_TRIBUNAL ∈ {0,false,off,no}
          // OR config.experimentalTribunal===false) or global basic mode. When ON,
          // inject the flag + the impure WorktreePort (git-worktree isolation) so a
          // genuine load-bearing implementation fork with ≥2 distinct authed vendors
          // can be settled by a build-off (each vendor builds its approach in its own
          // worktree; tests + cross-review pick an honest winner). When OFF both are
          // absent
          // → orchestrate's tribunal branch is structurally unreachable → the turn
          // delegates to the normal work-call BYTE-FOR-BYTE as today (the
          // characterization + oracle suites prove that neutrality). It still degrades
          // honestly at runtime (no fabricated rival) whenever any precondition fails.
          ...(experimentalEnabledByDefault(
            process.env,
            mutableCtx.config,
            'MYSHELL_TRIBUNAL',
            mutableCtx.config.experimentalTribunal,
            tribunalEnabled,
          )
            ? {
                tribunalEnabled: true,
                worktreePort: nodeWorktreePort,
              }
            : {}),
          // RESEARCH-UNTIL-CONFIDENT (master-plan Phase 3a/3b) — DEFAULT OFF (opt-in;
          // core/research-flag.ts). The REAL Read/Grep retrieval that enriches the
          // always-on codebase round rides `researchPort` (present here so a
          // low-confidence investigable turn actually dives into the relevant files,
          // not just the static map). The SECOND-ANGLE web move is additionally gated
          // by `researchEnabled` (the flag) — when off, the brain's `decideNextMove`
          // never emits the `'web'` move so the loop is byte-for-byte today's. The
          // port's native web search is wired from the cheapest authed provider (the
          // subscription tool — no api key); absent capability degrades honestly.
          researchPort: researchPort,
          ...(researchOn ? { researchEnabled: true } : {}),
          // SYSTEM UNDERSTANDING block (Phase 3a) — inject the warmed whole-picture
          // SystemModel into the WORK prompt (it previously grounded only the goal
          // planner). Lazy read of the warm cache (populated by warmUnderstanding);
          // '' when no model is warm yet → omitted → byte-identical prompt.
          ...((): { understandingContext?: string } => {
            const block = currentUnderstandingContext();
            return block.length > 0 ? { understandingContext: block } : {};
          })(),
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

      // ---- Goal / to-do store (Phase 5a, .tmp-vision-todos.md) ----------------
      // The persistent home for goals in any lifecycle state. A "to-do list" is a
      // PARKED goal's roadmap — nothing floats. Fail-soft, shares the two-scope
      // project key with memory. No model call to create/manage a manual to-do.
      const goalStore = createFileGoalStore({ clock: ctx.clock });

      // ---- Persistent goal BOARD (Elite-partner Phase 1) ----------------------
      // DEFAULT OFF. When the board flag is ON (MYSHELL_BOARD or
      // config.experimentalBoard), the live UI suppresses the fake per-turn
      // "GOALS ▸ <message>" card and paints a REAL persistent board projected from
      // this store. The board is purely a UI/menu concern: we snapshot the store and
      // push it into the reducer via `out.syncBoard?.()` (a no-op on legacy/test
      // sinks, so the flag-off path stays byte-identical). Cheap: a local store read,
      // no model call. Fully fail-soft (a board read never blocks/breaks a turn).
      const boardOn = boardEnabled(process.env, mutableCtx.config);
      // Map one persisted Goal → a flat board row using the PURE goal-todo.ts shapers
      // (goalGlyph for the lifecycle glyph, roadmapProgress for the to-do counts), so
      // the projection reuses the same vocabulary as the /goals menu rows. `agents`
      // is seeded 0 here; the reducer re-derives the LIVE running-agent count from
      // its own attach-by-goalId truth, so a running goal shows its real agent count.
      const toBoardRow = (g: Goal): GoalBoardRow => {
        const prog = roadmapProgress(g.roadmap);
        // The honest verdict tag (Elite-partner Part 3) rides on the row ONLY when the
        // goal has a REAL recorded verdict (goalVerdictTag returns undefined otherwise)
        // — completion honesty made visible, never a fabricated tag.
        const verdict = goalVerdictTag(g);
        return {
          id: g.id,
          title: g.title,
          state: g.state,
          done: prog.done,
          total: prog.total,
          glyph: goalGlyph(g),
          scope: g.scope,
          agents: 0,
          ...(verdict !== undefined ? { verdict } : {}),
        };
      };
      // Snapshot the store and push it into the live board. Scoped to the current
      // project + globals so the board mirrors what /goals lists. Fail-soft: any
      // store/sink error degrades to no board update (never throws into the turn).
      const syncBoard = async (): Promise<void> => {
        if (!boardOn || typeof out.syncBoard !== 'function') return;
        try {
          const projectKey = await resolveProjectKeyOnce();
          const all = await goalStore.list();
          // Show this project's goals + global goals (drop other projects' rows), so
          // the board is relevant without leaking unrelated repos' work.
          const relevant = all.filter(
            (g) => g.scope === 'global' || g.projectKey === null || g.projectKey === projectKey,
          );
          // Order LIVE work (running/queued/parked) ahead of terminal (done/failed)
          // before the layout caps the board to the viewport — otherwise a just-
          // finished goal (its lastTouched freshly bumped → newest-first from the
          // store) jumps to the top and crowds the active goals into "+K more".
          // Stable within a rank, so recency order is preserved among peers.
          const stateRank: Record<GoalState, number> = {
            running: 0,
            queued: 1,
            parked: 2,
            done: 3,
            failed: 4,
          };
          const ordered = relevant
            .map((g, i) => ({ g, i }))
            .sort((a, b) => stateRank[a.g.state] - stateRank[b.g.state] || a.i - b.i)
            .map((x) => x.g);
          out.syncBoard(ordered.map(toBoardRow));
        } catch {
          /* board is best-effort chrome — never block or break a turn */
        }
      };
      // Refresh the CURRENT GOALS / PLAN snapshot (the partner's OWN plan) from the
      // real store, scoped to the current project + globals — the SAME filter the
      // board uses, so the prompt and the board agree on what's in scope. Renders the
      // compact block via the PURE formatGoalsForContext; an empty store → '' (the
      // prompt stays byte-identical). Runs REGARDLESS of the board flag (the model
      // should always know its plan). Fail-soft: any store error leaves the snapshot
      // empty rather than breaking the turn. buildDeps reads this via currentGoalContext.
      const refreshGoalContext = async (): Promise<void> => {
        try {
          const projectKey = await resolveProjectKeyOnce();
          const all = await goalStore.list();
          const relevant = all.filter(
            (g) => g.scope === 'global' || g.projectKey === null || g.projectKey === projectKey,
          );
          goalContextSnapshot = formatGoalsForContext(relevant);
        } catch {
          goalContextSnapshot = '';
        }
      };

      // Sync the board + refresh the plan snapshot at the START of this turn (the
      // chat-loop entry point), so the persistent board AND the model's plan context
      // reflect the real store before any work streams. The board sync is a no-op when
      // the flag is off → byte-identical; the plan refresh is goal-gated (empty store
      // → empty snapshot → byte-identical prompt).
      await syncBoard();
      await refreshGoalContext();

      // ---- VERIFIED-DONE goal-completion GATE (Elite-partner Part 3) -----------
      // DEFAULT OFF. When the truly-complete flag is ON, a goal can NO LONGER be
      // marked `done` just because the model SAID GOAL_COMPLETE — the model's claim
      // is DEMOTED to a "request to verify". Before a goal settles `done`, a REAL
      // verification runs over the goal's cumulative changes via the existing
      // verify.ts engine (git-diff change-capture + the project's own test command →
      // the honest four-state passing|failing|reviewed|unverified). The goal is
      // `done` ONLY when the verdict is passing/reviewed; failing/unverified (incl.
      // an empty diff) keeps it open with an honest receipt — never fake green. The
      // verdict is the SOLE source of `lastGoalCompleted` when this is on.
      const verifiedDoneOn = verifiedDoneEnabled(process.env, mutableCtx.config);
      // Run a REAL verification for the goal-completion gate and map it to a
      // GoalVerdict, reusing verifyStage (the same change-capture + tests-first +
      // honest four-state engine the work-call accept point uses). Tests-only
      // (no critic): the honesty boundary (real test run → real four-state) is fully
      // preserved without the work-call loop's provider/critic machinery. FAIL-SOFT:
      // verifyStage wraps every step in try/catch and degrades a crash to `unverified`
      // (and we belt-and-suspender catch here too) so a verification can never crash
      // the goal loop and can never fake-pass. `acceptance` (the goal's goalAcceptance,
      // when set) orients the diff-scoped task. Returns the honest VerifyOutcome.
      // The per-to-do / goal-level verification. HARD-BOUNDED so it can NEVER hang the
      // manager cycle: the test runner is given an explicit timeout, AND the whole
      // verifyStage call is raced against a wall-clock cap. A hanging test command
      // (e.g. one that spawns sub-processes the runner's own timeout can't fully tear
      // down) would otherwise stall the cycle forever (observed live: a goal stuck
      // `running`, no verdict, 360s+). On the cap we degrade to an HONEST `unverified`
      // ("verification timed out") and the cycle moves on — never a fabricated pass,
      // never a hang. (The losing test process is abandoned; it's reaped on CLI exit.)
      const VERIFY_TEST_TIMEOUT_MS = Math.min(ctx.timeoutMs, 120_000);
      const VERIFY_HARD_CAP_MS = Math.min(ctx.timeoutMs, 150_000);
      const runGoalVerification = async (
        acceptance: string | undefined,
      ): Promise<import('../core/verify.js').VerifyOutcome> => {
        try {
          const authed: ProviderId[] = [];
          if (mutableCtx.env.claude.authenticated) authed.push('claude');
          if (mutableCtx.env.codex.authenticated) authed.push('codex');
          if (mutableCtx.env.opencode.authenticated) authed.push('opencode');
          let capTimer: ReturnType<typeof setTimeout> | undefined;
          const capped = new Promise<import('../core/verify.js').VerifyOutcome>((resolve) => {
            capTimer = setTimeout(
              () => resolve({ verified: 'unverified', changedFiles: 0, note: 'verification timed out' }),
              VERIFY_HARD_CAP_MS,
            );
          });
          const verify = verifyStage({
            output: '',
            provider: authed[0] ?? 'claude',
            tier: 'worker',
            port: nodeVerifyPort,
            level: 'tests', // tests-first only — the honest free signal (no critic call)
            cwd: ctx.cwd,
            testTimeoutMs: VERIFY_TEST_TIMEOUT_MS, // bound the test runner itself
            ...(acceptance !== undefined && acceptance.length > 0 ? { task: acceptance } : {}),
            available: authed,
          }).then((o) => o ?? { verified: 'unverified' as const, changedFiles: 0, note: 'verification did not run' });
          // Race: whichever settles first wins; clear the cap timer either way so it
          // can't keep the event loop alive.
          const outcome = await Promise.race([verify, capped]);
          if (capTimer !== undefined) clearTimeout(capTimer);
          return outcome;
        } catch {
          return { verified: 'unverified', changedFiles: 0, note: 'verification could not complete' };
        }
      };
      // The gate at the goal's would-be completion point. Runs the real verification,
      // PERSISTS the honest verdict via the store's single evidence-write path
      // (setGoalVerdict), and returns whether the goal is TRULY done (verdict ∈
      // {passing, reviewed}). Emits an honest one-line receipt either way. When the
      // verdict is NOT verified-done, the goal stays open (the caller leaves it
      // running) — the model's word is never enough. `goalId` is optional: when the
      // run isn't tied to a stored goal (e.g. an ephemeral `/goal <text>` run) the
      // verdict still gates completion, it just isn't persisted.
      const gateGoalCompletion = async (
        goalId: string | undefined,
        acceptance: string | undefined,
      ): Promise<boolean> => {
        const outcome = await runGoalVerification(acceptance);
        const verdict = goalVerdictFromOutcome(outcome, ctx.clock.isoNow());
        if (goalId !== undefined) {
          // The ONLY evidence-write path — the verdict is the real VerifyOutcome's,
          // never the model's claim. Fail-soft: a store error never breaks the loop.
          await goalStore.setGoalVerdict(goalId, verdict).catch(() => null);
          await syncBoard(); // the verdict landed → reflect completion honesty on the board
        }
        const trulyDone = isGoalVerifiedDone(verdict);
        if (trulyDone) {
          out.write(dim(`\n  ✓ verified done — ${verdict.receipt}\n`, out.color));
        } else {
          out.write(
            dim(`\n  ⚠ not verified done — ${verdict.receipt}. Keeping the goal open.\n`, out.color),
          );
        }
        return trulyDone;
      };

      // ---- Planning brain / AUTO-STAGE (Elite-partner Phase 6) -----------------
      // DEFAULT OFF. When the auto-goal flag is ON, the partner JUDGES a SUBSTANTIAL
      // owner turn AFTER the reply settles (post-turn, non-blocking, fail-soft) and
      // — when confident there is real work — auto-stages professional goals (each
      // with its to-do list) as PARKED goals (non-destructive), or surfaces ONE
      // sharp clarifying question when the turn is genuinely ambiguous. A trivial /
      // conversational turn ("sounds good?") stages NOTHING. Parked-only: activation
      // stays the judged/explicit gate (never run/executed here).
      const autoStageOn = autoStageEnabled(process.env, mutableCtx.config);
      // WHOLE-PICTURE UNDERSTANDING PASS (Elite-partner Part 2). DEFAULT OFF. When
      // ON, a manager-tier READ-ONLY investigation maps the REAL system FIRST and
      // its SystemModel grounds the planner so the staged goals reflect whole-picture
      // depth. OFF → never invoked, SystemModel stays undefined → the planner prompt
      // is byte-for-byte today's.
      const understandingOn = understandingEnabled(process.env, mutableCtx.config);
      // Mint sequential roadmap ids (r1, r2, …) for a freshly-staged goal's todos
      // and translate each todo's 1-based dependsOn indices into the corresponding
      // sibling ids (planTodosToRoadmap — the PURE, table-tested translation). The
      // store-write / capRoadmap path then runs normalizeRoadmapRelations to dedupe/
      // cycle-strip/cap (the single source of truth — never duplicated here). A todo
      // with no deps yields a {id, text, status} item byte-identical to before.
      const todosToRoadmap = (todos: readonly GoalPlanTodo[]): RoadmapItem[] =>
        planTodosToRoadmap(todos);
      // Run an EXPLICIT goal (`/goal <text>`) through the ADAPTIVE JUDGMENT — the front
      // of the elite-pro loop. It's NOT a rigid decompose+execute pipeline: a senior
      // first DIGESTS the goal (grounded in the whole-picture system model when one is
      // warm) and JUDGES it — either asks ONE sharp clarifying question (a genuine fork
      // a pro would never guess on) or forms a professional objective + ordered to-dos
      // to act on. Reuses the same manager-tier planner the chat brain uses. Returns the
      // judged plan: { judgment, title, roadmap, clarifyingQuestion? }. Fail-soft: any
      // miss → a 'stage' result with a formGoalLabel title + single-item roadmap, so the
      // caller can always proceed. Grounds future turns by warming the model when cold.
      const judgeGoal = async (
        goalText: string,
      ): Promise<{
        judgment: GoalPlan['judgment'];
        title: string;
        roadmap: RoadmapItem[];
        clarifyingQuestion?: string;
        /** The goal's best-approach (chosen + why), when the planner stated one. */
        approach?: GoalPlan['goals'][number]['approach'];
        /** The FULL judged plan (vision + every goal's todos/deps/approach), when the
         *  planner produced one — the raw material the PROPOSAL renderer renders.
         *  Absent on the smart-label fallback (no model plan to show). */
        plan?: GoalPlan;
        /** The warm whole-picture SystemModel used to ground this judgment (when one
         *  was cached) — the source of the proactive heads-up findings. */
        systemModel?: SystemModel;
      }> => {
        const cacheKey = (await resolveProjectKeyOnce()) ?? '∅global';
        const warm = systemModelCache.get(cacheKey)?.model;
        if (understandingOn && warm === undefined) warmUnderstanding(cacheKey, goalText);
        const roadmapFor = (todos: readonly GoalPlanTodo[]): RoadmapItem[] =>
          todos.length > 0
            ? todosToRoadmap(todos.slice(0, ROADMAP_LIMIT))
            : todosToRoadmap([{ text: goalText }]);
        const planner = buildGoalPlanner(warm);
        if (planner !== null) {
          try {
            const plan = await planner(goalText, new AbortController().signal);
            if (plan !== null) {
              const g0 = plan.goals[0];
              const title = g0?.title.trim();
              if (plan.judgment === 'clarify') {
                const q = plan.clarifyingQuestion?.trim();
                return {
                  judgment: 'clarify',
                  title: title !== undefined && title.length > 0 ? title : await formGoalLabel(goalText),
                  roadmap: roadmapFor(g0?.todos ?? []),
                  ...(q !== undefined && q.length > 0 ? { clarifyingQuestion: q } : {}),
                  ...(g0?.approach !== undefined ? { approach: g0.approach } : {}),
                  plan,
                  ...(warm !== undefined ? { systemModel: warm } : {}),
                };
              }
              if (g0 !== undefined && title !== undefined && title.length > 0 && g0.todos.length > 0) {
                return {
                  judgment: 'stage',
                  title,
                  roadmap: roadmapFor(g0.todos),
                  ...(g0.approach !== undefined ? { approach: g0.approach } : {}),
                  plan,
                  ...(warm !== undefined ? { systemModel: warm } : {}),
                };
              }
            }
          } catch {
            /* fall through to the smart-label + single-item fallback */
          }
        }
        return { judgment: 'stage', title: await formGoalLabel(goalText), roadmap: todosToRoadmap([{ text: goalText }]) };
      };
      // CACHE-AHEAD SystemModel (per project, session-scoped, in-memory). The
      // understanding pass is a manager-tier investigation with VARIABLE latency
      // (live-measured 20s..>30s on a real repo) — far too unreliable to run on a
      // turn's critical path. So we NEVER block on it: the planner grounds THIS turn
      // from a warm cache (or runs ungrounded if cold, exactly as today), and a
      // BACKGROUND warm (generous budget, not awaited, fail-soft, deduped per key)
      // grounds the NEXT planning moment. Understanding writes ONLY to this cache (no
      // UI output), so a background run can never race the visible turn. Refresh
      // every UNDERSTANDING_REFRESH_TURNS auto-stage attempts to catch in-session
      // drift. This is what lets whole-picture grounding ride WITHOUT latency.
      const UNDERSTANDING_REFRESH_TURNS = 5;
      const systemModelCache = new Map<string, { model: SystemModel; atTurn: number }>();
      const understandingWarmInFlight = new Set<string>();
      let autoStageTurns = 0;
      // Kick off a NON-BLOCKING background warm of the project's SystemModel. Deduped
      // (one warm per key at a time), fail-soft (any error → stays ungrounded until a
      // later warm lands), generous timeout (it never blocks a turn). Pure side effect
      // into systemModelCache; emits nothing to the UI.
      const warmUnderstanding = (cacheKey: string, line: string): void => {
        if (understandingWarmInFlight.has(cacheKey)) return;
        understandingWarmInFlight.add(cacheKey);
        void (async (): Promise<void> => {
          try {
            const risk = classify(line).risk;
            const highStakes = risk === 'high' || risk === 'critical';
            const repoContext = await resolveEnvironmentOnce().catch(() => '');
            const pass = buildUnderstandingPass(repoContext, highStakes); // generous bg budget
            if (pass !== null) {
              const model = (await pass(line, new AbortController().signal)) ?? undefined;
              if (model !== undefined) systemModelCache.set(cacheKey, { model, atTurn: autoStageTurns });
            }
          } catch {
            /* fail-soft: stays ungrounded until a future warm lands */
          } finally {
            understandingWarmInFlight.delete(cacheKey);
          }
        })();
      };
      // Run the planning brain for ONE settled turn and act on its verdict. Gated
      // (by the caller) on: the flag, a WORK-INTENT turn (hasWorkIntent — a manager/IC
      // signal, never a "sounds good?" or a pure lookup question), and quota pressure
      // below the ceiling (we skip the extra manager call when every provider is
      // throttled, so auto-staging never piles onto a quota wall). One manager call per
      // qualifying turn. Fully fail-soft: ANY error/timeout/empty → do nothing, never block,
      // never crash the turn.
      const resolveAutoStage = async (line: string): Promise<void> => {
        if (!autoStageOn) return;
        // Quota gate: skip when ALL detected providers are in rate-limit cooldown
        // (pressure at the 3 ceiling) — honest cost discipline. (We do not have a
        // dedicated Governor allocate() poll at this post-turn seam; this is the
        // honest, in-process pressure signal the rest of the loop already reads.)
        if (currentPressure() >= 3) return;
        autoStageTurns += 1;
        // WHOLE-PICTURE UNDERSTANDING (Part 2) — CACHE-AHEAD, never blocking. When the
        // flag is on, the planner is grounded from a WARM per-project SystemModel if
        // one is fresh; otherwise it runs UNGROUNDED this turn (exactly as when
        // understanding is off) and we kick off a BACKGROUND warm to ground the NEXT
        // planning moment. The understanding pass is NEVER awaited on the turn's
        // critical path (its latency is too variable), so it adds ZERO latency here.
        let systemModel: SystemModel | undefined;
        if (understandingOn) {
          const cacheKey = (await resolveProjectKeyOnce()) ?? '∅global';
          const cached = systemModelCache.get(cacheKey);
          const fresh =
            cached !== undefined && autoStageTurns - cached.atTurn < UNDERSTANDING_REFRESH_TURNS;
          if (fresh) {
            systemModel = cached.model; // ground THIS turn from the warm cache
          } else {
            warmUnderstanding(cacheKey, line); // ungrounded now; grounded next time
          }
        }
        const planner = buildGoalPlanner(systemModel);
        if (planner === null) return;
        let plan: GoalPlan | null = null;
        try {
          plan = await planner(line, new AbortController().signal);
        } catch {
          plan = null;
        }
        if (plan === null || plan.judgment === 'none') return; // frictionless, zero noise

        if (plan.judgment === 'clarify') {
          // Surface the single sharp question — do NOT auto-create goals here.
          // LIVENESS GUARD: this runs fire-and-forget (~up to 8s after the turn), so
          // the user may already have left to the menu — never paint a stray question
          // into it (mirrors the concurrent-recap guard).
          const q = plan.clarifyingQuestion?.trim();
          if (conversationLive && q !== undefined && q.length > 0) {
            out.write('\n' + dim('? ', out.color) + q + '\n');
          }
          return;
        }

        // judgment === 'stage' → born-parked goals (non-destructive), then board sync.
        const projectKey = await resolveProjectKeyOnce();
        // SMART DEDUP (not a dumb cap): an elite partner recognizes "we already have
        // a goal for that" instead of stamping out near-duplicate parked goals when
        // the owner circles the same topic across turns. Gather the titles of the
        // LIVE goals (parked/queued/running — not the historical done/failed) in this
        // scope, plus whatever we stage in THIS batch, and skip any candidate that is
        // a near-duplicate. Fail-soft: a list error just means we dedup within-batch.
        const seenTitles: string[] = [];
        try {
          const existing = await goalStore.list(
            projectKey !== null ? { scope: 'project', projectKey } : { scope: 'global' },
          );
          for (const e of existing) {
            if (e.state === 'parked' || e.state === 'queued' || e.state === 'running') {
              seenTitles.push(e.title);
            }
          }
        } catch {
          /* no existing snapshot → still dedup within this batch */
        }
        let staged = 0;
        // Track what actually LANDED (titles + total to-dos) so the note can say
        // something REAL — the confident "here's what I parked, shall I start?" that
        // replaces the old content-free "※ Staged N goals" whisper.
        const stagedTitles: string[] = [];
        let stagedTodos = 0;
        for (const g of plan.goals) {
          const title = g.title.trim();
          if (title.length === 0) continue;
          // Skip a goal we already track (or already staged this turn) — no clutter.
          if (isDuplicateGoalTitle(title, seenTitles)) continue;
          seenTitles.push(title);
          try {
            await goalStore.create({
              title,
              roadmap: todosToRoadmap(g.todos),
              scope: projectKey !== null ? 'project' : 'global',
              projectKey,
              conversationId: convId,
              // HONEST provenance: these were judged + staged by the planning
              // brain, NOT typed by the owner — the audit trail must say so.
              source: 'auto-staged',
              // The best-approach the planner stated for this goal (when any).
              ...(g.approach !== undefined ? { approach: g.approach } : {}),
            });
            staged += 1;
            stagedTitles.push(title);
            stagedTodos += g.todos.length;
          } catch {
            /* one create miss must not block the rest — best-effort staging */
          }
        }
        if (staged === 0) return; // nothing landed → no note (honest)
        // LIVENESS GUARD: this runs fire-and-forget, so the user may already have left
        // to the menu by the time the planner resolves. The goals are persisted either
        // way (they'll appear on the board next turn); but never paint the board/note
        // into the menu or smear the next prompt (mirrors the concurrent-recap guard).
        if (!conversationLive) return;
        await syncBoard(); // the new parked goals landed → refresh the board
        // Brief but REAL one-line note — names the goal(s) + to-do count + the
        // frictionless go-ahead, replacing the dim content-free whisper. Still a
        // single non-blocking line (we never block on the answer here — the owner
        // promotes from the board / `/goal` when ready). Fail-soft: an empty render
        // (defensive) degrades to the prior bare count.
        const note = formatAutoStageNote(stagedTitles, stagedTodos);
        if (note.length > 0) {
          out.write('\n' + dim(`※ ${note}`, out.color) + '\n');
        } else {
          const noun = staged === 1 ? 'goal' : 'goals';
          out.write('\n' + dim(`※ Staged ${String(staged)} ${noun} on the board.`, out.color) + '\n');
        }
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

      // ---- LEARNED-TASTE LEDGER (Phase-7 free layer, judgment doc Part 4) ------
      // Append-only JSONL of OBSERVED decisions (fork choices, push-back outcomes,
      // accept-unchanged vs. immediate-edit/rephrase). FLAG-GATED OFF by default
      // (core/taste-flag.ts): when off, recall returns the EMPTY playbook (no
      // tasteContext block, memoryBias 0 → byte-identical path) AND recording is
      // skipped before it ever touches disk. Fully fail-soft: a corrupt/missing
      // ledger degrades to no-bias, never breaks a turn. No model call, no
      // embeddings, no metered service — subscription-clean.
      const tasteOn = experimentalEnabledByDefault(
        process.env,
        mutableCtx.config,
        'MYSHELL_TASTE',
        mutableCtx.config.experimentalTaste,
        tasteEnabled,
      );
      // THE FREE JUDGMENT LAYER flag (master-plan PHASE 5; core/judgment-flag.ts).
      // DEFAULT ON at the entry point (frictionless): resolved by the composition-root
      // default-on resolver. Disabled only by explicit opt-out (MYSHELL_JUDGMENT ∈
      // {0,false,off,no} OR config.experimentalJudgment===false) or global basic mode.
      // When off, deps.judgmentEnabled is never set → the brain's `decideNextMove`
      // returns BYTE-FOR-BYTE today's moves (no push_back).
      const judgmentOn = experimentalEnabledByDefault(
        process.env,
        mutableCtx.config,
        'MYSHELL_JUDGMENT',
        mutableCtx.config.experimentalJudgment,
        judgmentEnabled,
      );
      // RESEARCH-UNTIL-CONFIDENT flag (master-plan Phase 3b; core/research-flag.ts).
      // DEFAULT OFF (opt-in; this is the newest, darkest lever). Enabled only by an
      // explicit MYSHELL_RESEARCH ∈ {1,true,on,yes} OR config.experimentalResearch.
      // When off, deps.researchEnabled is never set → the brain's decideNextMove never
      // emits the second-angle `'web'` move → byte-for-byte today's loop.
      const researchOn = researchEnabled(process.env, mutableCtx.config);
      // The injected READ-ONLY retrieval port (grep/readFile + a native web search).
      // The web-search callback routes the cheapest authed provider with webSearch:true
      // (the subscription tool — no api key); both Claude (after the 3c allow-list) and
      // Codex honour it, opencode ignores it. Built ONCE per session; the brain reads
      // it inside its investigation arms only. Fail-soft throughout.
      const researchWebSearch = async (query: string, signal: AbortSignal): Promise<string> => {
        try {
          const pool = (Object.keys(ctx.providers) as ProviderId[]).filter(
            (id) => ctx.providers[id] !== undefined,
          );
          if (pool.length === 0) return '';
          const effMode: Mode = mutableCtx.config.mode ?? resolveAutoMode(mutableCtx.env);
          const pol = POLICY_PRESETS[effMode];
          const avail: Partial<Record<ProviderId, readonly string[]>> = {};
          if (mutableCtx.env.claude.installed && mutableCtx.env.claude.availableModels.length > 0)
            avail['claude'] = mutableCtx.env.claude.availableModels;
          if (mutableCtx.env.codex.installed && mutableCtx.env.codex.availableModels.length > 0)
            avail['codex'] = mutableCtx.env.codex.availableModels;
          if (mutableCtx.env.opencode.installed && mutableCtx.env.opencode.availableModels.length > 0)
            avail['opencode'] = mutableCtx.env.opencode.availableModels;
          const authed: ProviderId[] = [];
          if (mutableCtx.env.claude.authenticated) authed.push('claude');
          if (mutableCtx.env.codex.authenticated) authed.push('codex');
          if (mutableCtx.env.opencode.authenticated) authed.push('opencode');
          const decision = route('worker', pool, pol, avail, authed);
          const provider = ctx.providers[decision.provider];
          if (provider === undefined) return '';
          const req: ProviderRequest = {
            model: decision.model,
            prompt:
              `Search the web for current, authoritative information on the following and reply with a SHORT plain-text summary of what you found, with sources. Do not restate the question.\n\n${query}`,
            cwd: ctx.cwd,
            sandbox: 'read-only',
            timeoutMs: Math.min(ctx.timeoutMs, 90_000),
            webSearch: true,
          };
          let finalText = '';
          for await (const ev of provider.run(req, signal)) {
            if (ev.type === 'done') finalText = ev.text;
            else if (ev.type === 'error') return '';
          }
          return finalText.trim();
        } catch {
          return '';
        }
      };
      const researchPort = createNodeResearchPort({ webSearch: researchWebSearch });

      const tasteLedger = createFileTasteLedger({ clock: ctx.clock });
      // The subject of the last surfaced fork/proposal — so an observed answer can
      // be recorded against the decision it resolved. Set when a question/confirm
      // is surfaced; consumed when the user answers. Bounded, observed-only.
      let lastDecisionSubject: string | undefined;
      // Recall is project-scoped + task-agnostic in the free layer (the playbook is
      // the user's recurring calls, not task-relevance-filtered); no `task` arg.
      const resolveTurnTaste = async (): Promise<{
        tasteContext?: string;
        memoryBias?: -1 | 0 | 1;
        tastePlaybookLines?: readonly string[];
      }> => {
        if (!tasteOn) return {}; // flag OFF → zero behavior change
        try {
          const projectKey = await resolveProjectKeyOnce();
          const playbook = await tasteLedger.recall(projectKey);
          const block = renderTastePlaybook(playbook);
          return {
            ...(block.length > 0 ? { tasteContext: block } : {}),
            ...(playbook.memoryBias !== 0 ? { memoryBias: playbook.memoryBias } : {}),
            // The STRUCTURED playbook lines feed the push_back taste-violation source
            // (master-judgment §2.2 source 2) — but ONLY when the judgment flag is
            // also ON. When judgment is off, omit them (no effect; the brain never
            // reaches the taste-violation arm anyway).
            ...(judgmentOn && playbook.lines.length > 0
              ? { tastePlaybookLines: playbook.lines }
              : {}),
          };
        } catch {
          return {}; // fail-soft: any recall failure → no bias, turn proceeds
        }
      };
      // Record one OBSERVED taste signal (never inferred). Flag-gated + fail-soft;
      // the ledger's own normalizeTasteEvent drops anything unvalidatable, so no
      // fabricated fact can land. subject/choice are bounded at the write boundary.
      const recordTaste = async (
        signal: TasteSignal,
        subject: string,
        choice: string,
        detail?: string,
      ): Promise<void> => {
        if (!tasteOn) return; // flag OFF → recording inert (file never created)
        try {
          const projectKey = await resolveProjectKeyOnce();
          await tasteLedger.record({
            signal,
            subject,
            choice,
            ...(detail !== undefined ? { detail } : {}),
            projectKey,
          });
        } catch {
          // A failed taste write must never break a turn (fail-soft).
        }
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

          // OBSERVED taste signal (Phase-7 free layer + master-judgment §2/§4.2):
          // the user just made a real call on a decision the engine surfaced. Record
          // subject=the decision (first question's prompt), choice=their actual
          // answer. Flag-gated + fail-soft; never inferred. Remember the subject so
          // an immediate edit/rephrase next turn can be attributed to this decision.
          const forkSubject = pending.questions.questions[0]?.prompt;
          if (forkSubject !== undefined && forkSubject.length > 0) {
            lastDecisionSubject = forkSubject;
            if (isPushBackQuestionSet(pending.questions)) {
              // THE PUSH-BACK RESOLUTION POINT (master-judgment §4.2): the partner
              // fired a grounded `push_back`; the user just resolved it. Record
              // whether its judgment was TRUSTED — accept (took our call) /
              // reject (stuck with theirs). This is how the partner LEARNS whether
              // its push-backs are valued (the pushback_accept/reject signals that
              // shipped INERT in 3.39.0 — activated here). An ambiguous answer
              // (Explain / free text) is classified null and NOT recorded (no
              // fabricated signal) — we still log a plain fork_choice for it so the
              // decision itself is captured.
              const verdict = classifyPushBackAnswer(answerLine);
              if (verdict === 'accept') {
                void recordTaste('pushback_accept', forkSubject, answerLine);
              } else if (verdict === 'reject') {
                void recordTaste('pushback_reject', forkSubject, answerLine);
              } else {
                void recordTaste('fork_choice', forkSubject, answerLine);
              }
            } else {
              void recordTaste('fork_choice', forkSubject, answerLine);
            }
          }

          // Reload history (orchestrate persisted the question turn with the
          // question TEXT as its assistant content) and rebuild deps so the answer
          // turn replays the full thread — the model sees what it asked. Fail-soft:
          // a corrupt store degrades to an empty thread + a dim notice, never crashes.
          let answerHistory: SessionEntry[] = [];
          try {
            answerHistory = await ctx.store.load(convId);
          } catch {
            answerHistory = [];
            out.write(dim("  Couldn't read prior history — continuing without it.\n", out.color));
          }
          const answerDeps: OrchestrateDeps = buildDeps(
            answerHistory,
            await resolveTurnMemory(answerLine),
            await resolveEnvironmentOnce(),
            await resolveTurnTaste(),
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

          if (control.exit || control.menu || interruptedByEsc) break;

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
      // currentAc/control.exit/control.menu/control.result flags.
      //
      // NEXT PHASE: the BOUNDED CONCURRENT MULTI-GOAL SCHEDULER wires in HERE.
      // When `schedulerEnabled(process.env, mutableCtx.config)` is true (see
      // src/interface/ui/scheduler-flag.ts) AND a confirmed plan has been
      // decomposed into >1 brain-validated GoalSpec, this single-goal sequential
      // loop is replaced by a call to `runSchedule(goalSpecs, deps, signal)`
      // (src/core/scheduler.ts): build `deps.runGoal = (spec, sig) =>
      // orchestrate(buildGoalTask(spec.title, 0, contract), buildDeps(...), sig)`,
      // pass `deps.authedProviders` from the env, `deps.sleep`/`deps.now` from
      // ctx.clock, and thread `currentAc.signal` for ESC fan-out. The merged
      // goalId-tagged CoreEvent stream is fed to the SAME renderStreamInk path
      // this loop already uses, so the multi-goal StatusBlock renders it.
      //
      // HARD CONSTRAINT (owner): goals promoted from a PARKED state MUST be
      // re-validated by the brain BEFORE being assembled into goalSpecs here —
      // the scheduler runs specs verbatim and has no path that auto-executes a
      // stale parked roadmap. The decomposition/validation step (a separate next
      // phase) owns that gate. Until that lands, the flag is dark and this
      // sequential loop is the only goal runner.
      // Set true when the most recent runGoalLoop reached GOAL_COMPLETE (the model
      // verified the goal is done). Used by the PROMOTE path to mark a promoted
      // parked goal `done` ONLY on real completion evidence — never inferred from a
      // clean return / ESC / ceiling. Reset at the top of each runGoalLoop call.
      let lastGoalCompleted = false;
      // Form a SMART, PROFESSIONAL goal OBJECTIVE from the raw user text — used
      // ONLY for the displayed `goal: <…>` progress line, the conversation title,
      // and the anti-drift contract OBJECTIVE. The actual work still receives the
      // FULL raw text as its task, so no user intent is lost.
      //
      // 4th-report fix: the user kept seeing their OWN raw phrasing as the goal
      // ("noob" goals). The cause was that this formed the label at the WORKER tier
      // with a terse non-vision intent extractor (and the explicit /goal path didn't
      // form one at all — it echoed the raw text verbatim). Now it routes a MANAGER-
      // tier pass with the product-vision / quality-bar persona (the SAME machinery
      // the recap uses) so the objective reads the way a senior engineer/PM would
      // name it — NEVER an echo of the user's words.
      //
      // Latency/cost: ONE pass at goal start, behind a TIGHT timeout
      // (GOAL_OBJECTIVE_TIMEOUT_MS) and FULLY fail-soft — any error / timeout / no
      // provider / unusable reply degrades to the deterministic
      // formConciseGoalLabel(deriveGoal(raw)) shaper, so goal start NEVER blocks or
      // crashes. Subscription-clean (no new flag, no metered service). Never throws.
      const formGoalLabel = async (rawText: string): Promise<string> => {
        try {
          const formObjective = buildGoalObjectiveGenerator();
          if (formObjective === null) return formConciseGoalLabel(undefined, rawText);
          const labelAc = new AbortController();
          const objective = await formObjective(rawText, labelAc.signal);
          // The pure shaper is the final bound/fallback: feed it the SMART objective
          // (capped/cleaned), or null → it derives from raw text (today's fallback).
          return formConciseGoalLabel(objective, rawText);
        } catch {
          return formConciseGoalLabel(undefined, rawText);
        }
      };
      // `runGoalLoop(goalText, goalLabel?)`:
      //   • goalText  — the FULL work input, passed verbatim to every goal turn
      //                 (buildGoalTask) so the model never loses the user's intent.
      //   • goalLabel — the CONCISE one-line title used ONLY for the panel/card
      //                 title, the conversation title, and the anti-drift contract
      //                 OBJECTIVE. When omitted (explicit `/goal <text>` and the
      //                 brain-validated promote path, where the text is already a
      //                 deliberate, concise goal) it defaults to goalText — today's
      //                 behaviour. The chat AUTO-ENGAGE / timeout-chunk / keep-going
      //                 sites pass a concise label formed from RAW chat text via
      //                 formGoalLabel(), fixing the "raw ramble as title" bug.
      //   • opts.goalId / opts.goalAcceptance — the stored goal this run completes
      //                 (the PROMOTE path) + its goal-level definition of done. Used
      //                 ONLY by the verified-done gate (Elite-partner Part 3): when
      //                 the flag is ON and the loop reaches the model's GOAL_COMPLETE,
      //                 a REAL verification runs and its honest verdict — persisted
      //                 against goalId — decides `lastGoalCompleted`, not the model's
      //                 word. Omitted (ephemeral `/goal <text>` runs) ⇒ the verdict
      //                 still gates completion, it just isn't persisted. When the flag
      //                 is OFF these are inert and the path is byte-for-byte today's.
      const runGoalLoop = async (
        goalText: string,
        goalLabel: string = goalText,
        opts?: { readonly goalId?: string; readonly goalAcceptance?: string },
      ): Promise<boolean> => {
        // FIX 3: a goal loop is model-needing. /goal and /goals go dispatch BEFORE the
        // relocated no-provider gate, so self-gate here — no provider means the loop
        // would only fail. Returns false (don't break the chat loop) after a notice.
        if (!hasAuthenticatedProvider(mutableCtx.env)) {
          out.write(
            '\n[info] No signed-in provider yet — type /back or press Ctrl+C twice to return, then [j] Claude / [k] Codex / [o] opencode to sign in.\n',
          );
          return false;
        }
        lastGoalCompleted = false;
        let goalContract = capContract({ version: 1, objective: goalLabel });
        // Title a still-untitled conversation from the concise goal label (no-op if
        // already set).
        const gMeta = (await ctx.store.list()).find((m) => m.id === convId);
        if (gMeta !== undefined && gMeta.title.trim().length === 0) {
          await ctx.store.rename(convId, goalLabel.length <= 80 ? goalLabel : goalLabel.slice(0, 80));
        }

        // ---- FLAG-GATED: bounded concurrent multi-goal SCHEDULER --------------
        // DEFAULT OFF. When the user has opted in (MYSHELL_SCHEDULER / config), run
        // the goal through `runSchedule` instead of the sequential loop. This phase
        // DECOMPOSES TO EXACTLY ONE brain-validated GoalSpec (the confirmed goal the
        // user just typed) — so the live behaviour matches today's single-goal path
        // (one goal, one phase, the same renderStreamInk path), only routed through
        // the scheduler's merge/cancel machinery so the seam is exercised end-to-end
        // ahead of real >1-goal decomposition.
        //
        // HARD CONSTRAINT (owner): the scheduler runs specs VERBATIM. We pass ONLY
        // the goal the user explicitly confirmed THIS turn — there is NO path here
        // that promotes a parked/stale roadmap into a spec. Multi-goal decomposition
        // (a separate next phase) must brain-revalidate any parked goal BEFORE it
        // becomes a GoalSpec; this single-spec wiring deliberately does not.
        if (schedulerEnabled(process.env, mutableCtx.config)) {
          const authedProviders: ProviderId[] = [];
          if (mutableCtx.env.claude.authenticated) authedProviders.push('claude');
          if (mutableCtx.env.codex.authenticated) authedProviders.push('codex');
          if (mutableCtx.env.opencode.authenticated) authedProviders.push('opencode');

          const schedAc = new AbortController();
          currentAc = schedAc;

          // ---- PLAN DECOMPOSITION ------------------------------------------
          // Turn the CONFIRMED plan into N brain-validated GoalSpecs + a dependency
          // DAG via ONE model call at the strongest admissible tier (decompose()
          // reuses route()/the provider machinery; subscription-clean, fail-soft).
          // COST HONESTY: decompose() returns ONE goal for a genuinely
          // sequential/single plan — it never forces fan-out — so a non-splittable
          // confirmed plan runs exactly like today's single-goal path, just routed
          // through the scheduler's merge/cancel machinery.
          const decomposeBaseDeps = buildDeps([]);
          let goalSpecs: GoalSpec[];
          try {
            goalSpecs = await decompose(
              goalText,
              {
                ...(decomposeBaseDeps.environmentContext !== undefined &&
                decomposeBaseDeps.environmentContext.length > 0
                  ? { repoMap: decomposeBaseDeps.environmentContext }
                  : {}),
              },
              {
                providers: decomposeBaseDeps.providers,
                policy: decomposeBaseDeps.policy,
                cwd: decomposeBaseDeps.cwd,
                timeoutMs: decomposeBaseDeps.timeoutMs,
                ...(decomposeBaseDeps.availableModels !== undefined
                  ? { availableModels: decomposeBaseDeps.availableModels }
                  : {}),
                ...(decomposeBaseDeps.authenticatedProviders !== undefined
                  ? { authenticatedProviders: decomposeBaseDeps.authenticatedProviders }
                  : {}),
              },
              schedAc.signal,
            );
          } catch {
            // decompose() is fail-soft, but never let a decomposition hiccup abort
            // the goal run — degrade to the single-goal whole-plan spec. The
            // scheduler runs specs VERBATIM and `spec.title` doubles as this fallback
            // spec's WORK INPUT (buildGoalTask(spec.title, …) in runGoal below), so it
            // MUST stay the full raw text here — never the concise label — or the
            // work would lose the user's full intent. (Concise-label titling for the
            // flag-off-by-default scheduler path is out of scope for this fix.)
            goalSpecs = [{ id: 'g0', title: goalText }];
          }

          // Per-goal phase runner: ONE orchestrate() per phase (orchestrate stays
          // the per-phase engine, untouched). Reloads history per phase like the
          // sequential loop so the model sees its own progress.
          //
          // HARD CONSTRAINT (owner): each goal is run THROUGH THE BRAIN — every
          // spec is handed to orchestrate (goalTurn:true), which re-runs intent/
          // brain validation on the spec title before acting. So a goal carved out
          // of a plan (or, later, promoted from a parked roadmap) is re-validated
          // here at run time; the scheduler never executes a raw stored roadmap.
          // Each goal gets its OWN per-goal contract seeded from its own title.
          const runGoal: RunGoalPhase = (spec, sig) => {
            const phaseDeps = (async (): Promise<OrchestrateDeps> => {
              let hist: SessionEntry[] = [];
              try {
                hist = await ctx.store.load(convId);
              } catch {
                hist = [];
              }
              return buildDeps(
                hist,
                await resolveTurnMemory(spec.title),
                await resolveEnvironmentOnce(),
              );
            })();
            // Wrap the async-deps resolution into the generator (orchestrate needs
            // resolved deps); keep the per-phase task contracted like the loop. The
            // per-goal contract is seeded from THIS goal's title (not the whole
            // plan), so the brain validates + works each goal on its own terms.
            const goalSpecContract = capContract({ version: 1, objective: spec.title });
            return (async function* (): AsyncGenerator<CoreEvent> {
              const d = await phaseDeps;
              const task = buildGoalTask(spec.title, 0, goalSpecContract);
              yield* orchestrate(
                task,
                {
                  ...d,
                  workContract: goalSpecContract,
                  goalTurn: true,
                  // PHASE 9: when a goal carries an isolated worktree cwd (the Rival
                  // Tribunal built one for it), run the goal IN that worktree so a
                  // per-rival build never touches the shared tree. Absent → the shared
                  // repo cwd, today's behavior (fully additive — byte-for-byte unchanged
                  // for every non-tribunal goal).
                  ...(spec.worktreeCwd !== undefined ? { cwd: spec.worktreeCwd } : {}),
                },
                sig,
              );
            })();
          };

          out.write(
            dim('\n  Working autonomously (concurrent scheduler). Ctrl+C / Esc to stop.\n\n', out.color),
          );
          try {
            await runTaskWithInputHooks(
              goalText,
              buildDeps([]),
              schedAc.signal,
              mutableCtx.config.verbosity ?? 'normal',
              // Feed the merged goalId-tagged scheduler stream to the SAME renderer.
              runSchedule(
                goalSpecs,
                { runGoal, authedProviders },
                schedAc.signal,
              ),
            );
          } finally {
            currentAc = null;
          }
          if (control.exit) { control.result = 'exit'; return true; }
          if (control.menu) { control.result = 'menu'; return true; }
          if (interruptedByEsc && queuedTurns.length > 0) {
            renderDiscardedQueue(out, queuedTurns.length, 'interrupt');
            queuedTurns.length = 0;
          }
          return false;
        }

        // ---- FLAG-GATED: PER-GOAL MANAGER CYCLE (elite-partner Part 7) --------
        // DEFAULT OFF. When the manager flag is ON *and* this run is tied to a
        // stored goal that has a REAL, non-empty roadmap (a to-do list), DRIVE
        // execution by that to-do list instead of the free GOAL_COMPLETE loop.
        // Each cycle: pickNextTodo → ONE worker turn scoped to that to-do → a REAL
        // tests-only verification (the SAME verify seam the goal-completion gate
        // uses) → record the honest per-item verdict (evidence-only, via
        // setRoadmapItemVerdict) → mark it done when passing/reviewed, else spawn a
        // bounded fix-it to-do. When every item is verified-done, run the EXISTING
        // goal-level verified-done gate before the goal can settle `done`.
        //
        // BOUNDEDNESS: the loop is hard-capped by the SAME turn ceiling the free
        // loop uses (maxIterations) — every worker turn AND every verification
        // counts against it, so a multi-todo goal can never run away — plus a
        // per-item fix-it depth cap (fixItTodo returns null at the cap). HONESTY:
        // an item is `done` ONLY when its verdict.state ∈ {passing,reviewed} from a
        // REAL VerifyOutcome (empty diff ⇒ unverified ⇒ NOT done); a worker/verify
        // error degrades to `unverified` (fix-it or move on), never a fake pass,
        // never a crash, never an infinite loop. Flag OFF or no roadmap ⇒ this
        // block is skipped entirely → today's free loop, byte-for-byte.
        const managerOn = managerCycleEnabled(process.env, mutableCtx.config);
        const cycleGoalId = opts?.goalId;
        if (managerOn && cycleGoalId !== undefined) {
          const stored = (await goalStore.get(cycleGoalId).catch(() => null)) ?? null;
          if (stored !== null && stored.roadmap.length > 0) {
            // Build the per-item verdict from a REAL VerifyOutcome — the SOLE honest
            // source (mirrors goalVerdictFromOutcome but carries the real
            // changedPaths so the per-item receipt is fully grounded). Never
            // upgrades the state; never fabricates a path.
            const verdictFromOutcome = (
              outcome: import('../core/verify.js').VerifyOutcome,
            ): RoadmapItemVerdict => ({
              state: outcome.verified,
              receipt: buildVerifyReceipt(outcome),
              at: ctx.clock.isoNow(),
              ...(outcome.changedPaths !== undefined && outcome.changedPaths.length > 0
                ? { changedPaths: outcome.changedPaths }
                : {}),
            });
            // Run ONE worker turn scoped to a single to-do, reusing the SAME
            // machinery the free loop uses (history reload + memory + env →
            // buildDeps → runTaskWithInputHooks). Returns the turn result. Fully
            // honors Ctrl+C / Esc via the shared control flags (checked by the
            // caller after each turn).
            const runOneWorkerTurn = async (
              task: string,
            ): Promise<Awaited<ReturnType<typeof runTaskWithInputHooks>>> => {
              let hist: SessionEntry[] = [];
              try {
                hist = await ctx.store.load(convId);
              } catch {
                hist = [];
              }
              const deps = buildDeps(
                hist,
                await resolveTurnMemory(task),
                await resolveEnvironmentOnce(),
              );
              const ac = new AbortController();
              currentAc = ac;
              const result = await runTaskWithInputHooks(
                task,
                { ...deps, workContract: goalContract, goalTurn: true },
                ac.signal,
                mutableCtx.config.verbosity ?? 'normal',
              );
              currentAc = null;
              noteRateLimit(result);
              return result;
            };

            out.write(
              dim(
                `\n  Executing the to-do list (${String(stored.roadmap.length)} to-dos, manager cycle). Ctrl+C / Esc to stop.\n\n`,
                out.color,
              ),
            );

            // The live working copy of the roadmap — refreshed from the store after
            // every mutation so pickNextTodo always sees the truth (incl. spawned
            // fix-it items). Bounded by the turn ceiling: each worker turn consumes
            // one unit of the SAME budget the free loop uses.
            let roadmap: readonly RoadmapItem[] = stored.roadmap;
            let usedTurns = 0;
            let stoppedEarly = false;

            // ---- AUTOMATIC LIVING-PLAN MAINTENANCE (re-plan) ------------------
            // The partner maintains its OWN to-do list: before working a step, a
            // manager-tier re-plan pass may ADD/EDIT/REORDER/PRUNE the PENDING
            // to-dos so the plan stays the smartest path to done. This is the
            // automatic consumer of the store's update/reorder/remove CRUD (the
            // retired manual /todo edit/move/rm). BOUNDED: gated (cycle start +
            // after a failure, never every iteration) AND hard-capped per
            // activation so it can never churn forever. FAIL-SOFT: a null/errored
            // re-plan leaves the roadmap exactly as-is (today's P7 behaviour).
            // HONESTY: it can never set a verdict or touch a verified-done item
            // (enforced in applyReplanEditsViaStore + the store's verified-retain).
            const replanner = buildReplanner();
            const MAX_REPLANS_PER_ACTIVATION = 3;
            let replansUsed = 0;
            const maybeReplan = async (reason: 'start' | 'after-failure'): Promise<void> => {
              if (replanner === null) return; // no provider → unchanged
              if (replansUsed >= MAX_REPLANS_PER_ACTIVATION) return; // bounded
              const live = await goalStore.get(cycleGoalId).catch(() => null);
              if (live === null) return;
              replansUsed += 1;
              const ac = new AbortController();
              currentAc = ac;
              const edits = await replanner(live, ac.signal).catch(() => null);
              currentAc = null;
              const applied = await applyReplanEditsViaStore(goalStore, cycleGoalId, edits).catch(
                () => null,
              );
              if (applied !== null) {
                const touched =
                  applied.added +
                  applied.edited +
                  applied.reordered +
                  applied.pruned +
                  applied.structured;
                if (touched > 0) {
                  const struct =
                    applied.structured > 0 ? ` ⤷${String(applied.structured)}` : '';
                  out.write(
                    dim(
                      `  ↻ re-planned (${reason}): +${String(applied.added)} ~${String(applied.edited)} ⇄${String(applied.reordered)} −${String(applied.pruned)}${struct} to-dos.\n`,
                      out.color,
                    ),
                  );
                  // Refresh the live roadmap + the board so the edits are visible
                  // immediately and pickNextTodo sees the new plan.
                  const refreshed = await goalStore.get(cycleGoalId).catch(() => null);
                  if (refreshed !== null && refreshed !== undefined) roadmap = refreshed.roadmap;
                  await syncBoard();
                }
              }
            };

            // Re-plan ONCE at cycle start (re-validate the parked roadmap against
            // the current reality before the first step) — bounded + fail-soft.
            await maybeReplan('start');
            if (control.exit) { control.result = 'exit'; return true; }
            if (control.menu) { control.result = 'menu'; return true; }

            for (; usedTurns < DEFAULT_MAX_GOAL_ITERATIONS; ) {
              const next = pickNextTodo(roadmap);
              if (next === null) break; // every item verified-done (or only-blocked)

              const prog = roadmapProgress(roadmap);
              out.write(
                dim(
                  `  ▸ to-do ${String(prog.done + 1)}/${String(prog.total)}: ${next.text}\n`,
                  out.color,
                ),
              );

              // ONE worker turn on this to-do.
              const turn = await runOneWorkerTurn(buildTodoTask(stored, next));
              usedTurns += 1;
              if (control.exit) { control.result = 'exit'; return true; }
              if (control.menu) { control.result = 'menu'; return true; }
              if (interruptedByEsc) {
                if (queuedTurns.length > 0) {
                  renderDiscardedQueue(out, queuedTurns.length, 'interrupt');
                  queuedTurns.length = 0;
                }
                stoppedEarly = true;
                break;
              }
              // A worker turn that asks a question can't be auto-verified — surface
              // it and stop the cycle honestly (the goal stays open). Name the BLOCKER
              // (the to-do) and the sharp fork, the elite way — never a content-free
              // "needs your input"; the selector below carries the actual choice.
              if (turn.final?.success === true && turn.final.questions !== undefined) {
                const fork = turn.final.questions.questions[0]?.prompt.trim();
                out.write(
                  dim(
                    `\n  I hit a fork on "${next.text}"${fork !== undefined && fork.length > 0 ? `: ${fork}` : ''} — which way?\n`,
                    out.color,
                  ),
                );
                await runStructuredQuestionFlow(turn.final);
                if (control.exit) { control.result = 'exit'; return true; }
                if (control.menu) { control.result = 'menu'; return true; }
                stoppedEarly = true;
                break;
              }

              // REAL tests-only verification of THIS to-do, anchored to its
              // acceptanceCriterion when present. Same engine, same honesty: empty
              // diff ⇒ unverified; a crash ⇒ unverified. Never a fabricated pass.
              const outcome = await runGoalVerification(next.acceptanceCriterion);
              const verdict = verdictFromOutcome(outcome);
              // The ONLY per-item evidence write. Fail-soft: a store miss never
              // breaks the cycle.
              await goalStore
                .setRoadmapItemVerdict(cycleGoalId, next.id, verdict)
                .catch(() => null);

              const itemDone = verdict.state === 'passing' || verdict.state === 'reviewed';
              if (itemDone) {
                // Mark the item done by its CURRENT index (the verdict already
                // landed via the itemId-keyed write above). Fail-soft.
                const idx = roadmap.findIndex((it) => it.id === next.id);
                if (idx >= 0) {
                  await goalStore.setRoadmapItemStatus(cycleGoalId, idx, 'done').catch(() => null);
                }
                out.write(dim(`    ✓ verified — ${verdict.receipt}\n`, out.color));
              } else {
                // failing / unverified ⇒ the to-do is NOT done. Self-heal with a
                // bounded fix-it to-do carrying the failure note; at the depth cap
                // fixItTodo returns null and we stop honestly on this item (move on
                // to the next actionable one — but mark this one so pickNextTodo
                // won't pick it forever: a fix-it failure with no spawn left means
                // the item can't be auto-advanced, so we leave it as-is and the
                // cap/ceiling ends the run honestly).
                const fix = fixItTodo(next, verdict.receipt);
                if (fix !== null) {
                  await goalStore.addRoadmapItem(cycleGoalId, fix).catch(() => null);
                  out.write(
                    dim(
                      `    ⚠ not verified — ${verdict.receipt}. Spawned a fix-it to-do.\n`,
                      out.color,
                    ),
                  );
                } else {
                  // Cap reached for this item: can't spawn another fix. Block it so
                  // pickNextTodo skips it (needs user input) — never an infinite
                  // retry of the same unverifiable step.
                  const idx = roadmap.findIndex((it) => it.id === next.id);
                  if (idx >= 0) {
                    await goalStore
                      .setRoadmapItemStatus(cycleGoalId, idx, 'blocked')
                      .catch(() => null);
                  }
                  out.write(
                    dim(
                      `    ⚠ "${next.text}" still isn't verifying after my fix-it attempts — ${verdict.receipt}. I've hit my retry cap; this one needs your call before I push further.\n`,
                      out.color,
                    ),
                  );
                }
              }

              // Refresh the live roadmap from the store (picks up the verdict, the
              // done/blocked status, and any spawned fix-it) and reflect live
              // progress on the board after each item.
              const refreshed = await goalStore.get(cycleGoalId).catch(() => null);
              if (refreshed !== null && refreshed !== undefined) roadmap = refreshed.roadmap;
              await syncBoard();

              // A FAILURE is the strongest signal the plan needs maintenance — the
              // assumption a step encoded was wrong. Re-plan now (bounded + fail-
              // soft) so the next pick reflects the corrected path. On a pass the
              // plan is already proving out, so we don't spend a re-plan there.
              if (!itemDone) {
                await maybeReplan('after-failure');
                if (control.exit) { control.result = 'exit'; return true; }
                if (control.menu) { control.result = 'menu'; return true; }
              }
            }

            // Honest receipt + the goal-level gate. The goal can settle `done` ONLY
            // when EVERY to-do is verified-done AND the existing goal-level
            // verified-done gate (P4) passes against goalAcceptance. Otherwise the
            // goal stays open with an honest count — never fake green.
            const finalGoal = (await goalStore.get(cycleGoalId).catch(() => null)) ?? stored;
            const cycleDone = managerCycleComplete(finalGoal);
            const finalProg = roadmapProgress(finalGoal.roadmap);
            if (!cycleDone || stoppedEarly) {
              // Name the actual blocker when the cycle stalled on an unverifiable item,
              // so the stop reason is sharp ("blocked on <to-do>"), not a vague "needs
              // input". Falls back to a plain count when nothing is specifically blocked.
              const firstBlocked = finalGoal.roadmap.find((i) => i.status === 'blocked');
              const why = stoppedEarly
                ? 'stopped'
                : usedTurns >= DEFAULT_MAX_GOAL_ITERATIONS
                  ? 'reached the work budget'
                  : firstBlocked !== undefined
                    ? `blocked on "${firstBlocked.text}" — your call needed`
                    : 'a to-do needs your call';
              out.write(
                dim(
                  `\n  ${why} — ${String(finalProg.done)}/${String(finalProg.total)} to-dos verified. Keeping the goal open.\n`,
                  out.color,
                ),
              );
              lastGoalCompleted = false;
              return false;
            }
            // Every to-do verified-done → the goal-level gate decides `done`. Reuses
            // gateGoalCompletion (verifies cumulative changes + persists the goal
            // verdict + syncs the board) — the model's word never reaches it.
            out.write(
              dim(
                `\n  All ${String(finalProg.total)} to-dos verified — running the goal-level acceptance check…\n`,
                out.color,
              ),
            );
            lastGoalCompleted = await gateGoalCompletion(cycleGoalId, opts?.goalAcceptance);
            return false;
          }
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
                objective: goalLabel,
                contract: goalContract,
              })}\n`,
              out.color,
            ),
          );
          // Fail-soft history load: a corrupt store degrades to an empty thread +
          // a dim notice rather than crashing the goal loop / startMenu.
          let goalHistory: SessionEntry[] = [];
          try {
            goalHistory = await ctx.store.load(convId);
          } catch {
            goalHistory = [];
            out.write(dim("  Couldn't read prior history — continuing without it.\n", out.color));
          }
          const goalDeps = buildDeps(
            goalHistory,
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
          if (control.exit) { control.result = 'exit'; return true; }
          if (control.menu) { control.result = 'menu'; return true; }
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
            const fork = turn.final.questions.questions[0]?.prompt.trim();
            out.write(
              dim(
                `\n  I hit a fork I won't guess on${fork !== undefined && fork.length > 0 ? `: ${fork}` : ''} — which way?\n`,
                out.color,
              ),
            );
            await runStructuredQuestionFlow(turn.final);
            if (control.exit) { control.result = 'exit'; return true; }
            if (control.menu) { control.result = 'menu'; return true; }
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
            if (step.action === 'complete') {
              if (verifiedDoneOn) {
                // VERIFIED-DONE GATE (Elite-partner Part 3): the model's GOAL_COMPLETE
                // is a REQUEST to verify, NOT the completion. Run a REAL verification
                // and let its honest verdict — not the model's word — decide. Persists
                // the verdict against the stored goal (when one is tied to this run)
                // and only sets `lastGoalCompleted` when the verdict is passing/reviewed.
                out.write(dim(`\n  ${mark} ${step.reason} — verifying before marking done…\n`, out.color));
                lastGoalCompleted = await gateGoalCompletion(opts?.goalId, opts?.goalAcceptance);
                break;
              }
              // Flag OFF — today's behaviour exactly: the model's GOAL_COMPLETE settles
              // the goal `done` (byte-for-byte identical).
              lastGoalCompleted = true;
            }
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
      // Exact `/goal`/`/goal <text>` ONLY — so `/goals …` is NOT swallowed here
      // and falls through to its own dispatch below.
      if (line === '/goal' || line.startsWith('/goal ')) {
        const goalText = line.slice('/goal'.length).trim();
        if (goalText.length === 0) {
          out.write(dim('  Usage: /goal <what you want achieved> — I build the to-do list and work through it to verified-done (Ctrl+C to stop).\n', out.color));
          return 'continue';
        }
        // `/goal` is an entry into the ADAPTIVE JUDGMENT SYSTEM, not a rigid pipeline.
        // An elite pro DIGESTS the goal (grounded in the whole-picture system model),
        // JUDGES it like a senior, helps BUILD the to-dos, and then ACHIEVES them — the
        // manager cycle works each to-do to verified-done and asks a sharp question only
        // at a genuine fork (collaborative, "with the user", not a black-box grind).
        // When the manager cycle is opted OUT (MYSHELL_MANAGER=0), `/goal` stays
        // byte-for-byte the legacy free loop.
        if (managerCycleEnabled(process.env, mutableCtx.config)) {
          // The judgment pass is a manager-tier call (~several seconds). Show a dim
          // marker first so the explicit `/goal` invocation never looks like a silent
          // hang while it digests + plans (the owner asked for it — brief feedback is
          // welcome, unlike the post-turn auto-stage which stays silent + non-blocking).
          out.write(dim('  ◷ thinking it through — judging the goal and building the plan…\n', out.color));
          const plan = await judgeGoal(goalText);
          const projectKey = await resolveProjectKeyOnce();

          // CLARIFY: a genuine fork a senior would never guess on. Surface ONE sharp
          // question, PARK the goal with its provisional to-dos (nothing lost, it's on
          // the board), and WAIT — the user answers and we pick it up. No barreling.
          if (plan.judgment === 'clarify' && plan.clarifyingQuestion !== undefined) {
            try {
              await goalStore.create({
                title: plan.title,
                roadmap: plan.roadmap,
                scope: projectKey !== null ? 'project' : 'global',
                projectKey,
                conversationId: convId,
                source: 'user-explicit',
                ...(plan.approach !== undefined ? { approach: plan.approach } : {}),
              });
            } catch {
              /* fail-soft: even if the capture misses, still ask the question */
            }
            await syncBoard();
            out.write('\n' + dim('? ', out.color) + plan.clarifyingQuestion + '\n');
            out.write(dim(`  Parked "${plan.title}" on the board — answer that and I'll take it from there.\n`, out.color));
            return 'continue';
          }

          // PROPOSE-THEN-GO (Phase 2): the goal is clear, but an elite pro doesn't fire
          // a black box — it PRESENTS the plan it built (vision · goals · to-dos · the
          // dependency cause→effect · the chosen approach over the alternatives), flags
          // any adjacent risk it noticed, then offers a ONE-TAP go. Only on the owner's
          // word does the manager cycle launch. The proposal renders from the FULL judged
          // plan when the planner produced one; on the smart-label fallback (no model
          // plan) there is nothing rich to show, so we skip straight to the launch —
          // byte-for-byte the prior behaviour for that path.
          if (plan.plan !== undefined) {
            const proposal = formatGoalProposal(plan.plan);
            if (proposal.length > 0) {
              out.write('\n' + proposal + '\n');
              // PROACTIVE HEADS-UP: 1–2 findings the understanding pass already computed
              // (open questions / hard constraints) — "heads up, X looks fragile". Dim,
              // near-free, fail-soft (none → nothing). Never fabricated.
              for (const h of formatHeadsUp(plan.systemModel)) {
                out.write(dim(`  heads up: ${h}\n`, out.color));
              }
              // ONE-TAP confirm — the SAME frictionless selector the ask_user forks use.
              const confirm = await runQuestionSelector(
                {
                  questions: [
                    {
                      id: 'goal_start',
                      prompt: 'Shall I run this, or adjust first?',
                      options: [
                        { label: 'Start all', description: 'work the whole plan to verified-done' },
                        { label: 'Just the unblocked ones', description: 'start where nothing is waiting' },
                        { label: 'Edit / not yet', description: "park it — I'll wait for your word" },
                      ],
                      multiSelect: false,
                      allowFreeText: true,
                    },
                  ],
                },
                out,
                readLine,
              );
              // Cancelled (Enter/EOF) or chose "Edit / not yet" → PARK the goal so nothing
              // is lost (it's on the board, fully planned), and WAIT. Anything else is a
              // GO. A free-text reply is treated as an adjustment → park + carry it.
              const wantsLaunch =
                confirm !== null &&
                /Start all|unblocked/i.test(confirm) &&
                !/Edit|not yet/i.test(confirm);
              if (!wantsLaunch) {
                try {
                  await goalStore.create({
                    title: plan.title,
                    roadmap: plan.roadmap,
                    scope: projectKey !== null ? 'project' : 'global',
                    projectKey,
                    conversationId: convId,
                    source: 'user-explicit',
                    ...(plan.approach !== undefined ? { approach: plan.approach } : {}),
                  });
                } catch {
                  /* fail-soft: even if the capture misses, acknowledge honestly */
                }
                await syncBoard();
                out.write(
                  dim(
                    `  Parked "${plan.title}" on the board — say the word and I'll run it.\n`,
                    out.color,
                  ),
                );
                return 'continue';
              }
            }
          }

          // ACT: the owner gave the go. Put the goal on the board as active and drive the
          // manager cycle (work each to-do → verify with real evidence → mark done /
          // fix-it) to verified-done. The cycle itself refines the to-dos via replan as
          // it learns, and is dependency-aware (it never picks a to-do whose blockers
          // aren't done — so "just the unblocked ones" and "start all" launch the same
          // dependency-respecting cycle).
          let createdGoalId: string | undefined;
          try {
            const created = await goalStore.create({
              title: plan.title,
              roadmap: plan.roadmap,
              scope: projectKey !== null ? 'project' : 'global',
              projectKey,
              conversationId: convId,
              source: 'user-explicit',
              ...(plan.approach !== undefined ? { approach: plan.approach } : {}),
            });
            createdGoalId = created.id;
            await goalStore.setState(created.id, 'running'); // active now → board shows ◐
          } catch {
            createdGoalId = undefined; // store miss → fall back to the free loop
          }
          await syncBoard();
          const shouldBreak = await runGoalLoop(
            goalText,
            plan.title,
            createdGoalId !== undefined ? { goalId: createdGoalId } : undefined,
          );
          if (createdGoalId !== undefined) {
            // Settle honestly: `done` ONLY when the loop reached verified-done
            // (lastGoalCompleted); else leave it running for the user to revisit.
            if (lastGoalCompleted) await goalStore.setState(createdGoalId, 'done');
            await syncBoard();
          }
          if (shouldBreak) return control.result;
          return 'continue';
        }
        // Manager cycle off → the old free loop, byte-for-byte. Form a SMART manager-tier
        // objective for the LABEL while passing the FULL goalText to the work (fail-soft).
        if (await runGoalLoop(goalText, await formGoalLabel(goalText))) return control.result;
        return 'continue';
      }

      // ---- /todo — create a PARKED goal / check off a to-do -------------------
      // Manual, subscription-clean (no model call). `/todo <text>` parks a goal;
      // `/todo done|block <g> <n>` marks roadmap item #n of parked goal #g. The
      // numbers are 1-based and match the `/goals` listing order.
      if (line === '/todo' || line.startsWith('/todo ')) {
        const arg = line.slice('/todo'.length).trim();
        const cmd = parseTodoCommand(arg);
        if (cmd.kind === 'usage') {
          out.write(
            dim(
              '  Usage: /todo <what you want done>  ·  /todo add <g> <text>  ·  /todo done|block <g> <n>  (once promoted, the partner maintains the to-do list itself)\n',
              out.color,
            ),
          );
          return 'continue';
        }
        if (cmd.kind === 'create') {
          await runTodoCreate({
            store: goalStore,
            out,
            text: cmd.text,
            projectKey: await resolveProjectKeyOnce(),
            conversationId: convId,
          });
          await syncBoard(); // a new parked goal landed → refresh the board
          return 'continue';
        }
        if (cmd.kind === 'add') {
          await runTodoAdd({ store: goalStore, out, g: cmd.g, text: cmd.text });
          await syncBoard(); // a new to-do landed on a goal → refresh the board
          return 'continue';
        }
        // mark: done | blocked on parked goal #g, item #n. Honesty: a to-do is
        // marked done only on this EXPLICIT user check-off (real evidence) — the
        // store records, never infers from silence.
        const parkedForMark = await listParked(goalStore);
        const goalForMark = parkedAt(parkedForMark, cmd.g);
        if (goalForMark === null) {
          out.write(dim(`  No parked goal #${cmd.g}. Run /goals to see the list.\n`, out.color));
          return 'continue';
        }
        const updated = await goalStore.setRoadmapItemStatus(goalForMark.id, cmd.n - 1, cmd.status);
        if (updated === null) {
          out.write(dim(`  Goal "${goalForMark.title}" has no to-do #${cmd.n}.\n`, out.color));
        } else {
          const verb = cmd.status === 'done' ? 'Checked off' : 'Flagged blocked';
          out.write(`  ${verb} to-do #${cmd.n} of "${updated.title}".\n`);
        }
        await syncBoard(); // a to-do status changed → refresh the board's N/M counts
        return 'continue';
      }

      // ---- /goals — list by state, expand, promote, drop ----------------------
      if (line === '/goals' || line.startsWith('/goals ')) {
        const arg = line.slice('/goals'.length).trim();
        const cmd = parseGoalsCommand(arg);
        if (cmd.kind === 'usage') {
          out.write(
            dim('  Usage: /goals  ·  /goals show <n>  ·  /goals go <n>  ·  /goals drop <n>\n', out.color),
          );
          return 'continue';
        }
        if (cmd.kind === 'list') {
          await runGoalsList({ store: goalStore, out, nowIso: ctx.clock.isoNow(), projectKey: await resolveProjectKeyOnce() });
          return 'continue';
        }
        const parkedGoals = await listParked(goalStore);
        const target = parkedAt(parkedGoals, cmd.n);
        if (target === null) {
          out.write(dim(`  No parked goal #${cmd.n}. Run /goals to see the list.\n`, out.color));
          return 'continue';
        }
        if (cmd.kind === 'show') {
          renderGoalExpanded(target, out);
          return 'continue';
        }
        if (cmd.kind === 'drop') {
          // Never silent-delete: the user asked explicitly, so confirm + report.
          await goalStore.remove(target.id);
          out.write(`  Dropped goal "${target.title}".\n`);
          await syncBoard(); // a goal left the store → refresh the board
          return 'continue';
        }
        // cmd.kind === 'go' — PROMOTE. Hand the goal TITLE to runGoalLoop, which
        // runs the adaptive brain. The parked roadmap is PROVISIONAL: the brain
        // RE-VALIDATES it against current reality before acting (re-validation is
        // inherent to runGoalLoop) — we deliberately do NOT execute the stored
        // roadmap directly. Mark `running` for the duration; mark `done` ONLY if
        // the loop reached real GOAL_COMPLETE (never inferred), else leave it
        // running for the user to revisit.
        await goalStore.setState(target.id, 'running');
        await syncBoard(); // goal flipped to running → reflect on the board
        out.write(dim(`  Promoting "${target.title}" — re-validating its to-dos against the current state…\n`, out.color));
        // 4th-report fix: a parked title is RAW user text (runTodoCreate stores the
        // /todo text verbatim, truncated to 80 chars), so it can be a ramble. Form a
        // SMART manager-tier objective for the LABEL while still running the full
        // stored title as the work. fail-soft inside formGoalLabel.
        // Pass the stored goal's id + goal-level acceptance so the verified-done gate
        // (when the flag is ON) verifies the goal's cumulative changes against
        // goalAcceptance and persists the honest verdict against THIS goal before any
        // `done`. When the flag is OFF these are inert; the path is byte-identical.
        const shouldBreak = await runGoalLoop(target.title, await formGoalLabel(target.title), {
          goalId: target.id,
          ...(target.goalAcceptance !== undefined ? { goalAcceptance: target.goalAcceptance } : {}),
        });
        // `lastGoalCompleted` is now the VERIFIED computation when the gate is ON
        // (verdict ∈ {passing,reviewed}) — never the model's bare GOAL_COMPLETE word.
        // failing/unverified ⇒ false ⇒ the goal stays `running` for the user to revisit.
        if (lastGoalCompleted) {
          await goalStore.setState(target.id, 'done');
        }
        await syncBoard(); // goal settled (done / still running) → refresh the board
        if (shouldBreak) return control.result;
        return 'continue';
      }

      // OBSERVED immediate-rephrase (Phase-7 free layer): if a fork was just
      // surfaced and this turn re-states that decision differently, the partner
      // misread it — a strong miss signal (judgment §4.2). Conservative,
      // deterministic overlap test (core/taste.ts); flag-gated + fail-soft. We
      // consume the pending subject once, whatever the outcome, so it never leaks.
      if (lastDecisionSubject !== undefined) {
        const priorDecision = lastDecisionSubject;
        lastDecisionSubject = undefined;
        if (tasteOn && isImmediateRephrase(priorDecision, line)) {
          void recordTaste('immediate_rephrase', priorDecision, line);
        }
      }

      // ---- Bug 4 fix / FIX 3: no-provider gate (relocated) --------------------
      // Check whether any provider is actually authenticated before dispatching a
      // task that is doomed to fail. opencode now reports authenticated only when a
      // real provider/subscription is configured (no more installed-means-ready).
      // Relocated to HERE (just before the metered orchestrate path) so the local-
      // only slash commands above (/memory, /forget, /goals, /todo, /remember) run
      // without a provider; only the model-needing chat turn is gated.
      if (!hasAuthenticatedProvider(mutableCtx.env)) {
        out.write(
          '\n[info] No signed-in provider yet — type /back or press Ctrl+C twice to return, then [j] Claude / [k] Codex / [o] opencode to sign in.\n',
        );
        return 'continue';
      }

      const depsBase = buildDeps(
        priorHistory,
        await resolveTurnMemory(line),
        await resolveEnvironmentOnce(),
        await resolveTurnTaste(),
      );
      // Image attachments (audit #4, image scope): the IMPURE existence check lives
      // here in the interface layer (fs allowed). The pure extractor finds candidate
      // image paths in the user's message; we keep only those that exist on disk and
      // thread them onto deps so orchestrate sets needsVision + routes the turn to a
      // vision-capable provider (codex `-i` / opencode `-f`). No real image → empty
      // → field omitted → behaviour byte-for-byte unchanged.
      const turnAttachments = resolveImageAttachments(line, { cwd: ctx.cwd });
      const deps: OrchestrateDeps =
        turnAttachments.length > 0 ? { ...depsBase, attachments: turnAttachments } : depsBase;

      if (mutableCtx.config.autoGoal === true && effectiveMode === 'quality-first') {
        const autoClassification = classify(line);
        const autonomy = decideAutonomyOffer({
          mode: effectiveMode,
          classification: autoClassification,
          autoGoalEnabled: true,
        });
        if (autonomy.kind === 'auto_engage') {
          // Auto-engaging on RAW chat text: form a concise title/objective from it
          // (the full `line` stays the work input). Fail-soft → raw text.
          if (await runGoalLoop(line, await formGoalLabel(line))) return control.result;
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
      if (control.exit) {
        control.result = 'exit';
        return 'exit';
      }
      // Bug 3 fix: control.menu may have been set by a 2×Ctrl+C during the task.
      if (control.menu) {
        control.result = 'menu';
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
          // Fail-soft history load: a corrupt store degrades to an empty thread +
          // a dim notice rather than crashing the retry path / startMenu.
          let retryHistory: SessionEntry[] = [];
          try {
            retryHistory = await ctx.store.load(convId);
          } catch {
            retryHistory = [];
            out.write(dim("  Couldn't read prior history — continuing without it.\n", out.color));
          }
          const retryDepsBase = buildDeps(
            retryHistory,
            await resolveTurnMemory(line),
            await resolveEnvironmentOnce(),
          );
          // Re-thread image attachments onto the retry (same message → same images).
          const retryDeps: OrchestrateDeps =
            turnAttachments.length > 0
              ? { ...retryDepsBase, attachments: turnAttachments }
              : retryDepsBase;
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
          if (control.exit) {
            control.result = 'exit';
            return 'exit';
          }
          if (control.menu) {
            control.result = 'menu';
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
        out.write('\n  ' + dim('I can keep working on it autonomously, step by step.', out.color) + '\n');
        out.write(`  Keep working on it autonomously, step by step, until it's done? ${yesNoHint('yes', out.color)} `);
        if (await confirm(true)) {
          // Chunking a timed-out RAW chat ask: concise title, full `line` as work.
          if (await runGoalLoop(line, await formGoalLabel(line))) return control.result;
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
          // Accepting the model's keep-going offer on the ORIGINAL raw ask: concise
          // title, full `line` as work.
          if (await runGoalLoop(line, await formGoalLabel(line))) return control.result;
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
          while (queuedTurns.length > 0 && !control.exit && !control.menu) {
            const next = queuedTurns.shift();
            if (next === undefined) break;
            const drainSignal = await runOneChatInput(next);
            if (drainSignal === 'menu') { control.menu = true; control.result = 'menu'; break; }
            if (drainSignal === 'exit') { control.exit = true; control.result = 'exit'; break; }
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
      if (control.exit) {
        control.result = 'exit';
        return 'exit';
      }
      if (control.menu) {
        control.result = 'menu';
        return 'menu';
      }

      // ---- Planning brain / auto-stage (Phase 6) — AFTER the post-turn slot ----
      // Runs ONLY on a clean, settled SUCCESS turn that did not itself end in a
      // question (the model's own ask_user already owns the floor in that case).
      // Gated on WORK INTENT (hasWorkIntent — a manager/IC signal, real build/plan
      // work), so a trivial "sounds good?" AND a pure read-only LOOKUP ("how does X
      // work?", "explain Y") never pay for a background manager call (the planner
      // would just return judgment:none on a question — wasted quota). Flag-off ⇒
      // resolveAutoStage is a no-op ⇒ byte-identical. Fully fail-soft inside.
      //
      // FIRE-AND-FORGET (not awaited): the planner is a manager-tier call (~up to 8s),
      // and awaiting it here would FREEZE the screen between "✓ done" and the next
      // prompt — reading as a hang on every substantial turn. So we let it run in the
      // BACKGROUND: the prompt returns immediately, and the "※ Staged N goals" note +
      // board refresh land asynchronously when ready (the staging writes go to the
      // committed transcript region, exactly like streamed output). This mirrors the
      // non-blocking warmUnderstanding treatment and keeps the conversation frictionless.
      if (
        autoStageOn &&
        result.final?.success === true &&
        result.final.questions === undefined &&
        hasWorkIntent(line)
      ) {
        void resolveAutoStage(line);
      }
      return 'continue';
  }
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
  // EXPERIMENTAL Ink UI (Step 5, default OFF). When the flag is on AND we are not
  // under an injected test reader, mount the Ink rendering+input layer and drive
  // the REAL menu/chat loop through it: the SAME business logic below runs, but
  // `out`/`readLine`/`lineReader` are the Ink adapters and turns render via the
  // reducer-backed `renderStreamInk` (handle.renderTurn) instead of renderStream.
  // The Ink mount is behind a DYNAMIC import so the default (flag-off) path never
  // loads ink/react and pays zero startup cost. When the flag is off, `inkHandle`
  // stays null and EVERY Ink-gated branch below is a single false test — the
  // legacy path runs byte-identically.
  let inkHandle: import('./ui/mount.js').InkMountHandle | null = null;
  // The Ink turn renderer, adapted to the runTask TurnRenderer shape (the Ink
  // handle's renderTurn takes `(events, opts)`; runTask passes
  // `(events, out, verbosity, turnInput)`). Null off the Ink path → runChatLoop
  // takes the legacy renderStream turn path unchanged.
  let inkRenderTurn: import('./run.js').TurnRenderer | undefined;
  // TTY guard (critical for default-ON safety): Ink must mount ONLY when stdout is
  // a terminal AND legacy raw-key input can read from the same raw stream it would
  // use for single-key menus. In Replit shells process.stdin may not be a raw TTY,
  // but /dev/tty is; resolveRawKeyInput mirrors rawKeyInputs() exactly.
  // Tests inject ctx.readLine, so they bypass this whole branch regardless.
  const inkRawInput = ctx.readLine === undefined ? resolveRawKeyInput(out) : null;
  if (ctx.readLine === undefined && out.isTty === true && inkRawInput !== null && inkEnabled(process.env, ctx.config)) {
    const { mountInk } = await import('./ui/mount.js');
    inkHandle = mountInk({ color: out.color, isTty: out.isTty, stdin: inkRawInput });
    // Render the menu/chat OUTPUT and read INPUT through the Ink adapters by
    // reassigning the seam bindings the shared loop below already uses.
    out = inkHandle.out;
    const handle = inkHandle;
    inkRenderTurn = (events, _sink, verbosity) => {
      // Parity with legacy renderStream's spinner clock: stamp the turn start and
      // report wall-clock elapsed seconds so the Ink success line keeps its
      // `· Ns` suffix (`✓ done · N tokens · 12s`). Mirrors mount.tsx's
      // clock={() => Date.now()}; run-stream only reads this on a successful final.
      const startMs = ctx.clock.now();
      return handle.renderTurn(events, {
        verbosity,
        elapsedSecs: () => Math.max(0, Math.round((ctx.clock.now() - startMs) / 1000)),
      });
    };
  }

  // Resolve injected seams — use the real implementations when not provided.
  const installProviderFn = ctx.installProvider !== undefined ? ctx.installProvider : installProvider;
  const loginFn = ctx.login !== undefined ? ctx.login : runLogin;
  const detectEnvironmentFn = ctx.detectEnvironment !== undefined ? ctx.detectEnvironment : detectEnvironment;
  const checkForUpdateFn = ctx.checkForUpdate;
  const updateSelfFn = ctx.updateSelf;
  const activeVersionFn = ctx.activeVersion;
  const activeBinPathFn = ctx.activeBinPath;
  const relaunchFn = ctx.relaunch;
  // npx context: real detection from the running script path, or test override.
  const runningUnderNpx =
    ctx.runningUnderNpx !== undefined
      ? ctx.runningUnderNpx
      : isRunningUnderNpx(process.argv[1], process.env);

  // Build the readLine function — either injected (for tests), the Ink reader, or
  // backed by a real readline interface driven by the event-driven LineReader queue.
  let readLine: () => Promise<string | null>;
  let lineReader: LineReader | null = null;

  if (inkHandle !== null) {
    // Ink path: the Ink LineReader IS a full LineReader (nextLine/suspend/resume/
    // beginCapture/currentLine/close), so it drives both the menu reads and the
    // chat loop's typed-ahead capture — no second stdin owner, no readline.
    lineReader = inkHandle.reader;
    const reader = lineReader;
    // Commit any pending newline-LESS prompt (e.g. "Pick one, or Enter to skip: ")
    // BEFORE blocking on input, so the action cue is visible while we wait. flush()
    // is a no-op when nothing is pending, so newline-terminated flows are unaffected.
    readLine = () => {
      out.flush?.();
      return reader.nextLine();
    };
  } else if (ctx.readLine !== undefined) {
    // Injected reader — no real readline needed.
    readLine = ctx.readLine;
  } else {
    const readlineEcho: ReadlineEchoController = { muted: false };
    const readlineOutput = new ReadlineOutputProxy(process.stdout, readlineEcho);
    // Create ONE readline interface for the whole menu lifecycle and drive it
    // through the event-driven queue (NOT per-prompt rl.question). This buffers
    // lines that arrive before they're awaited (fixing pipe eager-drain loss)
    // and resolves to `null` on EOF instead of throwing ERR_USE_AFTER_CLOSE.
    const rl = readline.createInterface({
      input: process.stdin,
      output: readlineOutput,
      terminal: out.isTty,
      // Empty prompt: the chat caret (`❯ `) is written manually to `out` so it
      // can be coloured. readline's DEFAULT prompt is `'> '`, and a paste (or any
      // line refresh) makes readline repaint `'> ' + buffer` at column 0 —
      // competing with the manual caret and showing the input on a SECOND line
      // (the "doubled paste" bug). With prompt:'' a refresh repaints just the
      // buffer, so there is one input line. (Node measures prompt width with an
      // ANSI-aware helper, but we keep colour out of readline entirely here.)
      prompt: '',
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
    lineReader = createLineReader(rl, process.stdin as unknown as KeyInputStream, readlineEcho);
    const reader = lineReader;
    // All prompt text is already written to `out` before readLine() is called.
    // flush() is a no-op on the legacy sink (it writes straight to stdout, no
    // pending buffer); kept symmetric with the Ink path above.
    readLine = () => {
      out.flush?.();
      return reader.nextLine();
    };
  }

  // Single-key yes/no confirm (Enter = default, y/n decide instantly on a TTY)
  // with a line-mode fallback for piped input / tests. On the Ink path the confirm
  // reads a SINGLE key through Ink's own input pipeline (inkHandle.readKey) so y/n
  // decide instantly — matching the legacy feel — instead of grabbing the raw TTY
  // (which would fight Ink). forceLine stays false; inkReadKey owns the Ink path.
  const inkReadKey: (() => Promise<string>) | undefined =
    inkHandle !== null ? () => inkHandle.readKey() : undefined;
  // Ink turn-interrupt setter — installs/clears the per-turn ESC→abort handler on
  // the App bridge (the InputBox routes a bare ESC to it). Undefined off the Ink
  // path so runChatLoop's legacy ESC path is byte-identical.
  const inkSetInterrupt: ((handler: (() => void) | null) => void) | undefined =
    inkHandle !== null ? (handler) => inkHandle.setInterrupt(handler) : undefined;
  const inkSetInputInfo:
    | ((info: { readonly mode: string; readonly hints: readonly string[] } | null) => void)
    | undefined = inkHandle !== null ? (info) => inkHandle.setInputInfo(info) : undefined;
  // Ink chat-active setter — shows/hides the chat composer. runChatLoop sets it
  // true at entry and false on exit so the composer appears ONLY in a conversation,
  // never in the menu / auth-login / settings. Undefined off the Ink path.
  const inkSetChatActive: ((active: boolean) => void) | undefined =
    inkHandle !== null ? (active) => inkHandle.setChatActive(active) : undefined;
  const confirm = makeConfirm(out, readLine, ctx.confirm, false, inkReadKey);
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
                // Self-diagnose: when we can resolve WHERE the stale binary
                // lives, name it so the user can act without guessing. Fail-soft.
                let binLine = '';
                if (activeBinPathFn !== undefined) {
                  const binPath = await activeBinPathFn().catch(() => null);
                  if (binPath !== null) {
                    const ver = activeVersion !== null ? activeVersion : 'the old version';
                    binLine =
                      `     Active binary: ${binPath}  ← still ${ver}; ` +
                      `remove it or put your npm global bin first on PATH.\n`;
                  }
                }
                out.write(
                  `\n  ⚠️  Updated to ${toV}, but ${activeLine}\n` +
                    `     Fix your PATH or run: which myshell-tools\n` +
                    binLine +
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
      mutableCtx.config = await runWelcome(ctx, out, readLine, confirm, suspendStdin, mutableCtx.config, installProviderFn, loginFn, detectEnvironmentFn, inkReadKey);
      // Re-detect after onboarding so the first main screen shows the REAL post-login
      // status (e.g. codex now "ready" if the user signed in during setup).
      mutableCtx.env = await detectEnvironmentFn();
    }

    // ---- B. Main screen loop -------------------------------------------------
    // PAINT FIRST, FILL ASYNC. The first frame used to block behind three serial
    // disk reads — the Claude token capture date, the UNBOUNDED ledger.jsonl sum
    // (grows forever → felt slower over time), and the conversation/parked-goal
    // lists. None of those gate a useful first paint: the menu skeleton (header,
    // mode line, the scannable action menu) is identical regardless. So on the
    // Ink live-region path we paint the skeleton with transient placeholders, then
    // fill the cached fields asynchronously and repaint in place via the SAME
    // chrome/replace single-dispatch frame path. On legacy stdout / test sinks
    // (no beginFrame → no live region) we keep the original synchronous
    // await-before-paint flow so the byte stream and test behavior are unchanged.
    const liveRegion = out.beginFrame !== undefined;

    // Goal/to-do store for the menu's Parked-goals section + [g] manage flow.
    // Same persistent home + injected clock as the chat-loop store; fail-soft.
    const menuGoalStore = createFileGoalStore({ clock: ctx.clock });

    // Cached, dirty-tracked state — the menu hot path stays O(1) in ledger size:
    // recomputed only when a flag says the underlying data may have changed.
    const emptySpend = summarizeSpend([], ctx.clock.isoNow());
    let claudeTokenInfo: ClaudeTokenStatus | null | undefined;
    let spend = emptySpend;
    let metas: Awaited<ReturnType<typeof ctx.store.list>> = [];
    let parkedGoals: Awaited<ReturnType<typeof menuGoalStore.list>> = [];
    let spendDirty = false;
    let listDirty = false;
    // First-paint placeholders are active until the async fills resolve. On the
    // legacy/sync path they're satisfied immediately below (never seen).
    let spendLoading = true;
    let listsLoading = true;

    // Tests (and any caller) may inject the token status to skip the disk read.
    if (ctx.claudeTokenInfo !== undefined) {
      claudeTokenInfo = ctx.claudeTokenInfo;
    }

    // Resolve the three reads. On the sync path they all complete before the first
    // paint (placeholders never render). On the live-region path the loop kicks
    // these off AFTER the first paint and each repaints when it lands.
    const fillToken = async (): Promise<void> => {
      if (ctx.claudeTokenInfo !== undefined) return;
      const capturedAt = await loadClaudeTokenCapturedAt().catch(() => undefined);
      claudeTokenInfo = claudeTokenStatus(capturedAt, Date.now());
    };
    const fillSpend = async (): Promise<void> => {
      // summarizeSpend needs the FULL ledger for an accurate total — never tail-
      // truncate. Kept accurate but OFF the first-paint path (computed here, after).
      spend = summarizeSpend(await readLedger(ctx.cwd).catch(() => []), ctx.clock.isoNow());
      spendLoading = false;
    };
    const fillLists = async (): Promise<void> => {
      metas = await ctx.store.list().catch(() => []);
      parkedGoals = await menuGoalStore.list({ state: 'parked' }).catch(() => []);
      listsLoading = false;
    };

    if (!liveRegion) {
      // Legacy / test path — identical to the original: fully resolved before paint.
      await Promise.all([fillToken(), fillSpend(), fillLists()]);
    }

    // `inMainMenu` gates async-fill repaints: a fill that lands while we're inside a
    // sub-flow (chat, settings, …) must NOT paint the menu over it. Toggled around
    // every sub-flow below.
    let inMainMenu = true;
    let started = false; // first frame painted yet?

    const paintMenu = async (): Promise<void> => {
      // Render the menu chrome inside an EPHEMERAL FRAME. On the Ink path this paints
      // the whole menu into a bounded NON-<Static> live region that is REPLACED in
      // place every frame — instead of appending ~30 fresh permanent <Static> items
      // per keypress (the progressive-lag / duplicate-menu root cause). On legacy /
      // test sinks beginFrame/endFrame are no-ops, so the byte stream is unchanged.
      out.beginFrame?.();
      await renderMainScreen(
        ctx, mutableCtx, metas, spend, out, updateInfo, claudeTokenInfo,
        runningUnderNpx, ctx.healthIssues ?? [], parkedGoals,
        spendLoading, listsLoading,
      );
      out.write('> ');
      out.endFrame?.();
    };

    // Repaint triggered by an async fill resolving: only on the live-region path,
    // only once the first frame is up, and only while we're sitting on the menu.
    const repaintIfActive = (): void => {
      if (!liveRegion || !started || !inMainMenu) return;
      void paintMenu();
    };

    while (true) {
      // We're sitting on the menu again — late async fills may repaint here.
      inMainMenu = true;
      if (spendDirty) {
        spend = summarizeSpend(await readLedger(ctx.cwd).catch(() => []), ctx.clock.isoNow());
        spendLoading = false;
        spendDirty = false;
      }
      if (listDirty) {
        metas = await ctx.store.list().catch(() => []);
        parkedGoals = await menuGoalStore.list({ state: 'parked' }).catch(() => []);
        listsLoading = false;
        listDirty = false;
      }

      // Paint the frame (menu + prompt) as the live region before blocking on the
      // key. readMenuKey's internal out.flush?.() is then a no-op (nothing pending).
      await paintMenu();

      // FIRST PAINT IS UP — now kick off the slow disk reads (live-region path
      // only; the sync path already resolved them above). Each fill updates its
      // cached field, clears its placeholder, and repaints the live frame in place
      // via the same chrome/replace path. Fail-soft inside each fill (never throws).
      // Fired once, right after the very first frame.
      if (liveRegion && !started) {
        void fillToken().then(repaintIfActive);
        void fillSpend().then(repaintIfActive);
        void fillLists().then(repaintIfActive);
      }
      started = true;

      // Single keypress on a real TTY (press the letter, no Enter); line read in
      // pipes/tests. '' = Enter/no-op → re-render; null = Ctrl-C/EOF → exit. On
      // the Ink path read ONE key through Ink's own input pipeline (inkReadKey) so
      // menu nav is instant single-key — matching the legacy feel — without
      // grabbing the raw TTY (which would fight Ink).
      const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

      // ---- EOF / close — exit gracefully (FIX 1: no ERR_USE_AFTER_CLOSE) ----
      if (key === null) {
        break;
      }

      // ---- Enter / no-op key → just re-render the menu ------------------------
      // The live frame stays as-is; the next iteration's beginFrame/endFrame
      // REPLACES it in place — zero <Static> growth across no-op keypresses.
      if (key === '') {
        continue;
      }

      // A real action key was pressed: PROMOTE the just-shown menu frame into the
      // permanent transcript so it lingers in scrollback above the sub-flow / chat
      // output (legacy scrolling-TTY parity), then the sub-flow's own out.write
      // commits below it. No-op on legacy/test sinks.
      out.promoteFrame?.();
      // Leaving the menu for a sub-flow — suppress any late async-fill repaint so it
      // can't paint the menu over the sub-flow's output. Re-enabled at loop top.
      inMainMenu = false;

      // ---- [q] Quit -----------------------------------------------------------
      if (key === 'q') {
        break;
      }

      // ---- [n] New conversation -----------------------------------------------
      if (key === 'n') {
        if (!(await promptForAuthBeforeChat(out, readLine, mutableCtx, loginFn, detectEnvironmentFn, confirm, suspendStdin, inkReadKey))) {
          continue;
        }
        // No up-front "name your chat" prompt — a real chat shell just opens and
        // lets you type. The title is derived silently from the first user message
        // (conversations.ts append()), so create an untitled conversation and drop
        // straight into it.
        const meta = await ctx.store.create('');
        const chatResult = await runChatLoop(ctx, mutableCtx, meta.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt, inkSetInputInfo, inkSetChatActive);
        spendDirty = true; // a task may have run — refresh the spend summary
        listDirty = true; // a new conversation was created (and goals may be parked)
        if (chatResult === 'exit') break;
        continue;
      }

      // ---- [c] Continue most-recent conversation ------------------------------
      if (key === 'c') {
        const all = await ctx.store.list();
        const latest = all[0];
        if (latest !== undefined) {
          if (!(await promptForAuthBeforeChat(out, readLine, mutableCtx, loginFn, detectEnvironmentFn, confirm, suspendStdin, inkReadKey))) {
            continue;
          }
          const chatResult = await runChatLoop(ctx, mutableCtx, latest.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt, inkSetInputInfo, inkSetChatActive);
          spendDirty = true; // a task may have run — refresh the spend summary
          listDirty = true; // conversation order/goals may have changed
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
          if (!(await promptForAuthBeforeChat(out, readLine, mutableCtx, loginFn, detectEnvironmentFn, confirm, suspendStdin, inkReadKey))) {
            continue;
          }
          const chatResult = await runChatLoop(ctx, mutableCtx, target.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt, inkSetInputInfo, inkSetChatActive);
          spendDirty = true; // a task may have run — refresh the spend summary
          listDirty = true; // conversation order/goals may have changed
          if (chatResult === 'exit') break;
        } else {
          out.write(`No conversation at position ${digit}.\n`);
        }
        continue;
      }

      // ---- [e] Manage conversations -------------------------------------------
      if (key === 'e') {
        await runManage(ctx, out, readLine, confirm, inkReadKey);
        listDirty = true; // manage can rename/delete conversations
        continue;
      }

      // ---- [g] Manage goals (only meaningful when parked goals exist) ---------
      if (key === 'g') {
        await runManageGoals(ctx, menuGoalStore, out, readLine, confirm, inkReadKey);
        listDirty = true; // manage-goals can unpark/delete parked goals
        out.write(dim('\nPress any key to return to the menu.\n', out.color));
        await readMenuKey(out, readLine, undefined, false, inkReadKey);
        continue;
      }

      // ---- [i] Import a native conversation -----------------------------------
      if (key === 'i') {
        const importResult = await runImportNative(ctx, mutableCtx, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt, inkSetInputInfo, inkSetChatActive);
        spendDirty = true; // an imported session may run a task — refresh spend
        listDirty = true; // the import created a conversation
        if (importResult === 'exit') break;
        continue;
      }

      // ---- [r] Open a raw provider session ------------------------------------
      if (key === 'r') {
        await runRawProviderSession(out, readLine, mutableCtx.env, suspendStdin, inkReadKey);
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
        mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode, mutableCtx.env, inkReadKey);
        continue;
      }

      // ---- [s] Settings -------------------------------------------------------
      if (key === 's') {
        await runSettings(ctx, mutableCtx, out, readLine, inkReadKey);
        continue;
      }

      // ---- [d] Doctor ---------------------------------------------------------
      if (key === 'd') {
        await runDoctor(out);
        out.write(dim('\nPress any key to return to the menu.\n', out.color));
        await readMenuKey(out, readLine, undefined, false, inkReadKey);
        continue;
      }

      // ---- [$] Cost -----------------------------------------------------------
      if (key === '$') {
        await runCost(ctx.cwd, out);
        out.write(dim('\nPress any key to return to the menu.\n', out.color));
        await readMenuKey(out, readLine, undefined, false, inkReadKey);
        continue;
      }

      // ---- Unknown key --------------------------------------------------------
      if (key.length > 0) {
        out.write(`Unknown option: "${key}". Press q to quit.\n`);
      }
    }
  } finally {
    // On the Ink path the reader is `inkHandle.reader`; unmount() closes it AND
    // tears down the Ink render, so don't also call lineReader.close() (it would
    // be redundant). Off the Ink path, close the legacy reader as before.
    if (inkHandle !== null) {
      inkHandle.unmount();
    } else {
      lineReader?.close();
    }
  }
}
