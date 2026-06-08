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
import { buildGoalTask, parseGoalSignal, parseGoalContinueText, decideGoalNext, formatGoalProgress, DEFAULT_MAX_GOAL_ITERATIONS, stripTrailingGoalConfidenceEnvelope } from '../core/goal.js';
import type { GoalCeilings } from '../core/goal.js';
import { appendCheckpointFromContinue, capContract } from '../core/work-contract.js';
import { deriveWorkStateFromHistory, renderWorkStateBlock } from '../core/work-state.js';
import { isKeepGoingOffer } from '../core/questions.js';
import { decideAutonomyOffer } from '../core/autonomy.js';
import { classify } from '../core/classify.js';
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
import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
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
import { deriveTitleFromRecap, isStubTitle } from '../infra/conversations.js';
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
import { isRecapStale, recapEligible, parseRecap } from '../core/recap.js';
import { makeRouteClassifier } from '../core/route-classifier.js';
import { makeIntentExtractor } from '../core/intent-extractor.js';
import { shouldShowFirstTouch, markSeen, FIRST_TOUCH_LINES } from '../core/first-touch.js';
import { teach } from '../core/teach.js';
import { decideShed, pressureFromSignals } from '../core/capability-budget.js';
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
} from './menu-readline.js';
import { inkEnabled } from './ui/flag.js';
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
import { runManage, runImportNative } from './menu-conversations.js';
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
      return await runTask(taskLine, taskDeps, out, signal, verbosity, turnInput, inkRenderTurn);
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
      out.write(renderInputPrompt({
        color: out.color,
        isTty: out.isTty,
        columns: promptColumns,
      }));

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
        control.result = 'menu';
        break;
      }
      if (line === 'exit') {
        control.result = 'exit';
        break;
      }

      // EOF → exit the chat loop gracefully
      if (line === null) break;
      if (promptIsBoxed) out.write('\n');

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

      // Resolve the capability summary once per session (await here so the
      // synchronous buildDeps below can read the memoized value). Fail-soft → undefined.
      await resolveCapabilitySummaryOnce();

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
          // WORK STATE block (AP2-B §2.3 B) — present only when an accepted prior
          // turn carried a trusted workTrace (resumed/continuing chat). Truthful or
          // absent; pure derivation from the loaded history, no model call.
          ...(workStateContext.length > 0 ? { workStateContext } : {}),
          // ENVIRONMENT / repo-map orientation block (E1) — gathered once per
          // session, present only when codebase awareness is on AND the scan
          // produced a non-empty block (fail-soft → '' otherwise).
          ...(environmentContext !== undefined && environmentContext.length > 0
            ? { environmentContext }
            : {}),
          // TOOL-STATE / ABOUT block (tool self-awareness) — present only when the
          // pure renderer produced a non-empty block (it always does given a version).
          ...(toolStateContext.length > 0 ? { toolStateContext } : {}),
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
                objective: goalText,
                contract: goalContract,
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
            out.write(dim('\n  The goal run needs your input before it can continue.\n', out.color));
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
        if (await runGoalLoop(goalText)) return control.result;
        return 'continue';
      }

      const depsBase = buildDeps(
        priorHistory,
        await resolveTurnMemory(line),
        await resolveEnvironmentOnce(),
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
          if (await runGoalLoop(line)) return control.result;
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
          const retryDepsBase = buildDeps(
            await ctx.store.load(convId),
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
          if (await runGoalLoop(line)) return control.result;
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
          if (await runGoalLoop(line)) return control.result;
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
  if (ctx.readLine === undefined && inkEnabled(process.env, ctx.config)) {
    const { mountInk } = await import('./ui/mount.js');
    inkHandle = mountInk({ color: out.color, isTty: out.isTty });
    // Render the menu/chat OUTPUT and read INPUT through the Ink adapters by
    // reassigning the seam bindings the shared loop below already uses.
    out = inkHandle.out;
    const handle = inkHandle;
    inkRenderTurn = (events, _sink, verbosity) =>
      handle.renderTurn(events, { verbosity });
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
    readLine = () => reader.nextLine();
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
    readLine = () => reader.nextLine();
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
      if (key === '') {
        continue;
      }

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
        const chatResult = await runChatLoop(ctx, mutableCtx, meta.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt);
        spendDirty = true; // a task may have run — refresh the spend summary
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
          const chatResult = await runChatLoop(ctx, mutableCtx, latest.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt);
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
          if (!(await promptForAuthBeforeChat(out, readLine, mutableCtx, loginFn, detectEnvironmentFn, confirm, suspendStdin, inkReadKey))) {
            continue;
          }
          const chatResult = await runChatLoop(ctx, mutableCtx, target.id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt);
          spendDirty = true; // a task may have run — refresh the spend summary
          if (chatResult === 'exit') break;
        } else {
          out.write(`No conversation at position ${digit}.\n`);
        }
        continue;
      }

      // ---- [e] Manage conversations -------------------------------------------
      if (key === 'e') {
        await runManage(ctx, out, readLine, confirm, inkReadKey);
        continue;
      }

      // ---- [i] Import a native conversation -----------------------------------
      if (key === 'i') {
        const importResult = await runImportNative(ctx, mutableCtx, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt);
        spendDirty = true; // an imported session may run a task — refresh spend
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
