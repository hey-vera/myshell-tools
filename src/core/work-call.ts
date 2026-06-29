/**
 * src/core/work-call.ts — the `runWorkCall` stage (Phase 1 seam).
 *
 * This is the WORK-CALL EXECUTION REGION carved out of orchestrate() as a single,
 * cohesive, named stage. It owns the bounded escalation + review loop:
 *
 *   route → streamProvider → collectProviderRun → append accepted assistant →
 *   retry/failover by tier → usage/cost accounting → emit CoreEvents
 *
 * It is a behaviour-PRESERVING extraction: it yields the SAME CoreEvents in the
 * SAME order as the inlined loop did, and mutates only its own internal loop state.
 * The seam exists so the later master-plan subsystems (the Governor, the
 * verification centerpiece, the judgment poll) plug in at one named boundary
 * instead of inside a 2200-line generator. Phase 1 builds ONLY the seam + the
 * empty `verifyStage` slot — NO new behaviour.
 *
 * WHAT FLOWS IN (`WorkCallInput`): the live, already-computed turn context —
 *   - the immutable signals: task, deps, signal, classification, routePlan,
 *     directive, intentFrame, engagementPlan, goalTitle, workTrace,
 *     incomingWorkContract, available providers, mode, taskSignals,
 *     capabilityContext, historyContext, wantsWebSearch, hasImageAttachment;
 *   - the RESOLVED starting tier (`startTier`) — the admission gates in
 *     orchestrate() (admitManager / authorizeTier / the Oracle escalation) keep
 *     their authority and run BEFORE this stage; this stage receives the tier they
 *     chose. It re-derives its own `admitManager` over its loop-local mutable tier
 *     for the IN-LOOP escalation/failover/review admission decisions (identical
 *     body to the preamble's, closing over the live loop tier — exactly as the
 *     inlined closure did).
 *
 * WHAT FLOWS OUT: the yielded CoreEvent stream (classified is emitted by
 * orchestrate before this stage; this stage emits tier-start/provider-event/
 * tier-done/escalate/failover/notice/final). The terminal `final` event is the
 * stage's only "return value"; the accepted-assistant append + ledger records are
 * side-effects on the injected ports. The stage returns (the generator completes)
 * after emitting exactly one terminal `final`.
 *
 * Purity rules (enforced by test/arch/guards.test.ts), identical to orchestrate.ts:
 *  - No imports of fs / path / child_process
 *  - No console.* calls
 *  - No Date.now() / Math.random() / new Date() — use deps.clock
 *  - No process.exit()
 */

import type { CoreEvent, OrchestrateDeps, Tier, Classification, Assessment, Policy } from './types.js';
import type { CliError, Usage, ProviderRequest, Provider, ProviderId } from '../providers/port.js';
import { route, clampTier, type CapabilityRouteContext, type CapabilityTaskSignals } from './route.js';
import type { Mode } from './policy.js';
import { shouldReview, effortForDecision } from './orchestrate-signals.js';
import { authorizeTier } from './flagship.js';
import type { FlagshipTrigger, FlagshipDecision } from './flagship.js';
import { buildPrompt } from './prompt.js';
import { assess } from './assess.js';
import { parseQuestions } from './questions.js';
import { getModelPricing, calculateCost, calculateEffectiveCost } from '../infra/pricing.js';
import { nextTierUp, pickReviewer } from './escalate.js';
import { buildReviewPrompt, parseReviewVerdict } from './review.js';
import {
  unverified,
  stateFromTestRun,
  composeVerifiedState,
  buildDiffReviewPrompt,
  buildVerifyReceipt,
  levelWantsCritic,
  type VerifyOutcome,
  type VerifiedState,
  type TestRunResult,
} from './verify.js';
import { defaultVerifyLevel } from './verify-policy.js';
import { confidenceLine } from './brain.js';
import { buildInitialExecutorContextBlockOptions } from './context-block-options.js';
import {
  composeTrustReceipt,
  trustReceiptLines,
  isEmptyReceipt,
  type TrustSignals,
} from './trust-receipt.js';
import type { WorkContract } from './work-contract.js';
import { capContract, shouldMaterializeContract, isCleanObjectiveTask, stampContractIntentVersion } from './work-contract.js';
import type { IntentFrame } from './intent.js';
import type { EngagementPlan } from './engagement.js';
import { deriveAskFromForks } from './engagement.js';
import type { TurnDirective } from './turn-directive.js';
import {
  validateTurnOutput,
  shouldAppendGroundedFallback,
  GENERIC_MENU_REPAIR_NOTE,
  GROUNDED_RECOMMENDATION_REPAIR_NOTE,
  GROUNDED_RECOMMENDATION_FALLBACK,
} from './turn-directive.js';
import {
  extractDiscoverySignals,
  discoveryWarrantsManager,
  discoveryWarrantsReview,
  discoveryEscalationReason,
  type DiscoverySignal,
} from './discovery.js';
import { lastJsonObjectBoundsWithKey } from './json-envelope.js';
import {
  MAX_REVISE_RETRIES,
  appendAcceptedAssistant,
  runCandidateQualityGate,
  type AcceptedRunSessionData,
  type CandidateResult,
  type GateResult,
} from './accept-stage.js';
import { decideLayerBEscalation } from './auto-brain.js';
import { buildBlockedRecord, type BlockedReasonCode } from './blocked.js';
import { buildEvidenceReceipt } from './evidence-receipt.js';
import {
  buildNativeSessionTelemetry,
  renderNativeSessionTelemetry,
} from './native-session-telemetry.js';
import { vendorNeutralRoute } from './vendor-neutral-route.js';
import { opencodePoolForModel, selectOpencodeAccount, selectSubscriptionAccount } from './opencode-account-routing.js';
import { accountEnvFor } from '../infra/subscriptions.js';
import type { SubscriptionAccount } from '../infra/subscriptions.js';

function blockedCodeForError(
  category: import('../providers/port.js').CliError['category'],
): BlockedReasonCode | undefined {
  switch (category) {
    case 'auth': return 'missing_authority';
    case 'rate-limit': return 'quota_exhausted';
    case 'timeout':
    case 'network':
    case 'sandbox-environment': return 'environment_unavailable';
    case 'permission': return 'risk_requires_approval';
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Partial-output salvage constants (draft-handoff on rate-limit failover)
// ---------------------------------------------------------------------------

/**
 * Minimum stripped-draft length (chars) required to salvage across a failover.
 * Below this, the partial is too short to be useful context and is skipped.
 */
const SALVAGE_MIN_CHARS = 200;

/**
 * Maximum stripped-draft length (chars) to inject as a salvaged-draft block.
 * When the partial exceeds this, keep the HEAD (so the continuation reads
 * naturally from the beginning of the answer) and cap with a tail marker.
 * HEAD-preference: a continuation that reads from "…" at the tail is harder
 * for the model to bridge; starting from the head + indicating truncation is
 * more natural and lets the model re-close the answer coherently.
 */
const SALVAGE_MAX_CHARS = 4000;

/**
 * Strip the trailing confidence envelope (and/or ask_user block) from a
 * provider's partial draft before injecting it as a salvaged-draft context
 * block. The same approach as history.ts stripEnvelope — but inlined here to
 * avoid a cross-module dependency on a private helper.
 *
 * Handles both 'confidence' and 'ask_user' keys (whichever appears last and is
 * truly trailing). Never throws — returns the original text on any failure.
 */
function stripSalvageEnvelope(text: string): string {
  try {
    let match: { readonly start: number; readonly end: number } | null = null;
    for (const key of ['confidence', 'ask_user']) {
      const m = lastJsonObjectBoundsWithKey(text, key);
      if (m !== null && text.slice(m.end).trim().length === 0) {
        if (match === null || m.start < match.start) match = { start: m.start, end: m.end };
      }
    }
    if (match === null) return text;
    return text.slice(0, match.start).replace(/\s+$/, '');
  } catch {
    return text;
  }
}

/**
 * Conservative check: does the text appear to contain an unterminated tool-call
 * or code fence? If yes, skip salvage — injecting mid-tool-call JSON as a
 * continuation context block would confuse provider B.
 *
 * Checks for:
 *   - An odd number of ``` fences (open fence with no matching close)
 *   - A dangling `<tool_use>` or `<function_call>` open tag with no close
 *
 * Pure; never throws.
 */
function hasUnterminatedToolCall(text: string): boolean {
  try {
    // Odd number of triple-backtick fences → a code fence is open
    const fenceCount = (text.match(/```/g) ?? []).length;
    if (fenceCount % 2 !== 0) return true;
    // An open <tool_use> or <function_call> tag without a matching close
    if (/<tool_use>/i.test(text) && !/<\/tool_use>/i.test(text)) return true;
    if (/<function_call>/i.test(text) && !/<\/function_call>/i.test(text)) return true;
    return false;
  } catch {
    return false; // fail-safe: don't skip salvage on a check error
  }
}

// ---------------------------------------------------------------------------
// Private streaming helpers (moved verbatim from orchestrate.ts — they are used
// ONLY by the work-call loop). ensemble.ts keeps its own independent copies.
// ---------------------------------------------------------------------------

interface StreamOutcome {
  finalText: string | undefined;
  errored: CliError | undefined;
  usage: Usage | undefined;
  providerCostUsd: number | undefined;
  /** Provider-assigned session/thread id captured from the `done` event, if any. */
  sessionId: string | undefined;
  canceled: boolean;
  /** True only when the signal was already aborted before streaming started. */
  canceledBeforeStream: boolean;
}

/**
 * Stream a single provider run, yielding `{type:'provider-event', tier, event}`
 * for every event, while accumulating `finalText`, `usage`, `providerCostUsd`,
 * and `errored`.  Cancellation via `signal` is detected both before and after
 * each event; on cancellation the generator returns immediately with
 * `canceled: true` (no notice/final events — the caller emits those).
 */
async function* streamProvider(
  provider: Provider,
  req: ProviderRequest,
  tier: Tier,
  signal: AbortSignal,
): AsyncGenerator<CoreEvent, StreamOutcome> {
  let finalText: string | undefined;
  let errored: CliError | undefined;
  let usage: Usage | undefined;
  let providerCostUsd: number | undefined;
  let sessionId: string | undefined;
  let hadDoneWithText = false;

  // Pre-stream abort check
  if (signal.aborted) {
    return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: true };
  }

  for await (const ev of provider.run(req, signal)) {
    yield { type: 'provider-event', tier, event: ev };

    if (ev.type === 'done') {
      finalText = ev.text;
      if (finalText !== undefined && finalText.trim().length > 0) {
        hadDoneWithText = true;
        // A substantive done supersedes a soft (unknown-category) error that
        // arrived earlier in the same attempt (e.g. an opencode inline error
        // line emitted before the adapter recovered via finalize()). Timeout/
        // cancel/auth/rate-limit keep their specific categories and still fail.
        if (errored !== undefined && errored.category === 'unknown') {
          errored = undefined;
        }
      }
      // done.usage is the authoritative accumulated total.
      if (ev.usage !== undefined) {
        usage = ev.usage;
      }
      if (ev.costUsd !== undefined) {
        providerCostUsd = ev.costUsd;
      }
      if (ev.sessionId !== undefined && ev.sessionId.length > 0) {
        sessionId = ev.sessionId;
      }
    } else if (ev.type === 'error') {
      if (!(hadDoneWithText && ev.error.category === 'unknown')) {
        errored = ev.error;
      }
    } else if (ev.type === 'usage' && usage === undefined) {
      usage = ev.usage;
    }

    if (signal.aborted) {
      return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: false };
    }
  }

  return { finalText, errored, usage, providerCostUsd, sessionId, canceled: false, canceledBeforeStream: false };
}

/**
 * Consume a provider run for terminal data only. Internal control-plane runs
 * such as cross-vendor review must not stream their prose to the renderer.
 */
async function collectProviderRun(
  provider: Provider,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<StreamOutcome> {
  let finalText: string | undefined;
  let errored: CliError | undefined;
  let usage: Usage | undefined;
  let providerCostUsd: number | undefined;
  let sessionId: string | undefined;

  if (signal.aborted) {
    return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: true };
  }

  for await (const ev of provider.run(req, signal)) {
    if (ev.type === 'done') {
      finalText = ev.text;
      // done.usage is the authoritative accumulated total.
      if (ev.usage !== undefined) {
        usage = ev.usage;
      }
      if (ev.costUsd !== undefined) {
        providerCostUsd = ev.costUsd;
      }
      if (ev.sessionId !== undefined && ev.sessionId.length > 0) {
        sessionId = ev.sessionId;
      }
    } else if (ev.type === 'error') {
      errored = ev.error;
    } else if (ev.type === 'usage' && usage === undefined) {
      usage = ev.usage;
    }

    if (signal.aborted) {
      return { finalText, errored, usage, providerCostUsd, sessionId, canceled: true, canceledBeforeStream: false };
    }
  }

  return { finalText, errored, usage, providerCostUsd, sessionId, canceled: false, canceledBeforeStream: false };
}

// ---------------------------------------------------------------------------
// The verifyStage SLOT (Phase 1 — empty placeholder)
// ---------------------------------------------------------------------------

/**
 * Inputs the verification stage reads at the turn's accept point (master-plan
 * PHASE 3). The first three fields are the original Phase-1 reserved shape; the
 * rest are OPTIONAL — the verify stage runs ONLY when they are supplied (i.e. the
 * verify flag is ON and the impure {@link VerifyPort} was injected onto deps).
 * Absent → verifyStage returns `undefined` and is the byte-for-byte no-op it was
 * (the characterization + oracle suites prove this neutrality).
 */
export interface VerifyStageContext {
  /** The accepted answer text for this turn (the candidate "done"). */
  readonly output: string;
  /** The provider that produced it (for cross-vendor reviewer selection). */
  readonly provider: ProviderId;
  /** The tier it ran at. */
  readonly tier: Tier;
  /**
   * The injected verification port (impure git-diff + test exec). PRESENT ONLY when
   * the verify flag is ON. Absent ⇒ verification does not run (the no-op default).
   */
  readonly port?: import('./verify.js').VerifyPort;
  /** The verification level (the Governor's `verify` lever, or the built-in default). */
  readonly level?: import('./verify.js').VerifyLevel;
  /** The original user task (for the diff-scoped critic prompt orientation). */
  readonly task?: string;
  /** The project cwd to capture the diff / run tests in. */
  readonly cwd?: string;
  /** The bounded test-run timeout (ms). */
  readonly testTimeoutMs?: number;
  /** The authenticated providers available for the cross-vendor critic. */
  readonly available?: readonly ProviderId[];
  /**
   * A "run a one-shot provider" port the critic uses — supplied by the work-call
   * loop (it owns `collectProviderRun` + routing). When absent, the critic cannot
   * run and the stage degrades to tests-only (still honest). PURE injection: the
   * stage never imports a provider directly.
   */
  readonly runCritic?: (input: CriticRunInput) => Promise<CriticRunOutput | undefined>;
}

/** What the work-call loop needs to run a diff-scoped critic on the stage's behalf. */
export interface CriticRunInput {
  /** The reviewer provider chosen by pickReviewer (a different vendor when possible). */
  readonly reviewer: ProviderId;
  /** The fully-built diff-scoped review prompt. */
  readonly prompt: string;
}

/** The critic's outcome the stage maps into the receipt. */
export interface CriticRunOutput {
  /** Whether a real, parseable verdict was produced (never fabricated). */
  readonly ran: boolean;
  readonly parsed?: boolean;
  readonly verdict?: 'approve' | 'revise' | 'escalate';
  readonly notes?: string;
}

const VERIFY_DEFAULT_TEST_TIMEOUT_MS = 120_000;

/**
 * verifyStage — THE VERIFICATION CENTERPIECE (master-plan PHASE 3).
 *
 * Runs at the turn's accept point, AFTER the answer is accepted as the candidate
 * "done" and BEFORE the receipt is surfaced. It runs a GRADUATED, HONEST check and
 * returns the honest four-state {@link VerifyOutcome} ({unverified|reviewed|passing
 * |failing}), which the loop turns into a receipt notice. It NEVER mutates the
 * accepted answer and NEVER breaks the turn (every step is fail-soft; a crash
 * degrades to `unverified` + an honest note).
 *
 * THE GRADUATED LADDER (strict cost order):
 *   1. CHANGE-CAPTURE — capture the diff THIS turn produced (the turn's real
 *      edited-files signal when known, else `git diff` of the working tree). An
 *      EMPTY diff ⇒ NO verification (`unverified`, satisfying the no-diff⇒no-verify
 *      invariant). FREE.
 *   2. TESTS-FIRST — detect the project's test command CONSERVATIVELY and run it
 *      bounded/non-destructive. Green⇒`passing`, red⇒`failing`, no-command/timeout
 *      ⇒ honest `unverified (...)` — NEVER a fabricated pass. FREE local exec, always
 *      tried before any model call.
 *   3. DIFF-SCOPED CRITIC — only when the level selects a critic (`tests+critic`/
 *      `reviewed`): ONE cross-vendor critic reviews the DIFF + the TEST OUTPUT (not
 *      prose), routed to a different vendor when possible (labelled same-vendor
 *      fallback when only one vendor is connected). With tests, the critic
 *      ANNOTATES (tests own pass/fail); with no tests, the critic ⇒ `reviewed`.
 *
 * RETURNS `undefined` (the no-op) when verification is not armed — no port, no
 * level, or `level === 'none'` — so the flag-off path is byte-for-byte unchanged.
 *
 * @see master-plan PHASE 3 — THE CENTERPIECE · change-capture + verify
 */
export async function verifyStage(
  ctx: VerifyStageContext,
): Promise<VerifyOutcome | undefined> {
  // NO-OP GUARD (the flag-off / unarmed neutrality): without a port, a level, or a
  // cwd, verification does not run — return undefined exactly as Phase 1 did.
  const { port, level, cwd } = ctx;
  if (port === undefined || level === undefined || level === 'none' || cwd === undefined) {
    return undefined;
  }

  try {
    // -- 1. CHANGE-CAPTURE (free) --------------------------------------------
    const diff = await port.captureDiff(cwd).catch(() => ({ files: [], patch: '' }));
    if (diff.files.length === 0) {
      // Empty diff ⇒ no verification ran (the honest default, no-diff⇒no-verify).
      return unverified('no code change to verify', 0);
    }
    const changedFiles = diff.files.length;

    // BUILT-IN DEFAULT UPGRADE (Governor OFF): when the level is the bare `'tests'`
    // floor, the conservative built-in policy MAY add a critic — but ONLY on a large
    // diff with ≥2 vendors, NEVER on a trivial change. When the Governor is ON it has
    // already chosen `tests+critic`/`reviewed` deliberately (by stakes), so we never
    // downgrade its decision; we only upgrade the bare floor.
    const effectiveLevel =
      level === 'tests'
        ? defaultVerifyLevel({
            highStakes: false, // stakes are the Governor's job; the floor uses size only
            changedFiles,
            authedProviderCount: (ctx.available ?? []).length,
          })
        : level;

    // -- 2. TESTS-FIRST (free local exec — always tried before any model call) --
    const detected = await port.detectTestCommand(cwd).catch(() => null);
    let testState: VerifiedState | undefined;
    let testRun: TestRunResult | undefined;
    let testCommandLabel: string | undefined;
    let testReason: string | undefined;
    if (detected === null) {
      testReason = 'no test command detected';
    } else {
      testCommandLabel = detected.label;
      const timeout = ctx.testTimeoutMs ?? VERIFY_DEFAULT_TEST_TIMEOUT_MS;
      testRun = await port
        .runTests(cwd, detected, timeout)
        .catch(() => ({ outcome: 'errored' as const, output: '', durationMs: 0 }));
      if (testRun.outcome === 'green' || testRun.outcome === 'red') {
        testState = stateFromTestRun(testRun);
      } else if (testRun.outcome === 'timeout') {
        testReason = `tests timed out (${testCommandLabel})`;
      } else {
        testReason = `tests could not run (${testCommandLabel})`;
      }
    }

    // -- 3. DIFF-SCOPED CROSS-VENDOR CRITIC (the ONE paid lever, gated) -------
    let critic: VerifyOutcome['critic'] | undefined;
    if (levelWantsCritic(effectiveLevel) && ctx.runCritic !== undefined) {
      const available = ctx.available ?? [];
      const reviewer = pickReviewer([...available], ctx.provider);
      if (reviewer !== null) {
        const prompt = buildDiffReviewPrompt({
          task: ctx.task ?? '',
          diff: diff.patch,
          ...(testRun !== undefined ? { testOutput: testRun.output, testOutcome: testRun.outcome } : {}),
        });
        const out = await ctx.runCritic({ reviewer, prompt }).catch(() => undefined);
        if (out !== undefined && out.ran) {
          critic = {
            vendor: reviewer,
            sameVendor: reviewer === ctx.provider,
            parsed: out.parsed ?? true,
            verdict: out.verdict ?? 'approve',
            notes: out.notes ?? '',
          };
        }
      }
    }

    // -- 4. COMPOSE THE HONEST FOUR-STATE + the outcome ----------------------
    const verified = composeVerifiedState(testState, critic !== undefined);
    return {
      verified,
      changedFiles,
      ...(diff.files.length > 0 ? { changedPaths: diff.files } : {}),
      ...(testCommandLabel !== undefined ? { testCommand: testCommandLabel } : {}),
      ...(testRun !== undefined ? { testRun } : {}),
      ...(critic !== undefined ? { critic } : {}),
      ...(verified === 'unverified' && testReason !== undefined ? { note: testReason } : {}),
    };
  } catch {
    // FAIL-SOFT: any unexpected crash in verification degrades to unverified +
    // an honest note — NEVER breaks the turn.
    return unverified('verification could not complete', 0);
  }
}

// ---------------------------------------------------------------------------
// runWorkCall — the extracted work-call stage
// ---------------------------------------------------------------------------

/**
 * The live, already-computed turn context handed to {@link runWorkCall}. Every
 * field is read (never recomputed) by the stage; this is exactly the set of
 * closure variables the inlined loop referenced.
 */
export interface WorkCallInput {
  readonly task: string;
  readonly deps: OrchestrateDeps;
  readonly signal: AbortSignal;
  readonly classification: Classification;
  readonly routePlan: boolean;
  readonly directive: TurnDirective;
  readonly intentFrame: IntentFrame | undefined;
  readonly engagementPlan: EngagementPlan;
  readonly goalTitle: string;
  readonly workTrace: WorkContract | undefined;
  readonly incomingWorkContract: WorkContract | undefined;
  readonly available: ProviderId[];
  readonly mode: Mode;
  readonly taskSignals: CapabilityTaskSignals;
  readonly capabilityContext: CapabilityRouteContext | undefined;
  readonly historyContext: string | undefined;
  readonly wantsWebSearch: boolean;
  readonly hasImageAttachment: boolean;
  /**
   * The RESOLVED starting tier from orchestrate()'s admission gates (admitManager
   * / authorizeTier / the Oracle escalation). Those gates keep their authority and
   * run BEFORE this stage; the stage starts the loop at the tier they chose.
   */
  readonly startTier: Tier;
  /**
   * LAYER B (auto-brain escalation): when true, a candidate that FAILS its
   * objective check after the bounded repair escalates the tier and RETRIES
   * instead of finalizing — the live within-turn self-correction loop. Set by
   * orchestrate when the auto-brain flag is on. DEFAULT (absent/false) → the loop
   * finalizes on objective failure exactly as before (byte-for-byte neutrality).
   */
  readonly autoBrainEscalation?: boolean;
  /** Hard provider-invocation cap for this turn. Absent means unbounded by Governor. */
  readonly turnCallBudget?: number;
  /** Governor investigation-round allowance, threaded for executor authority. */
  readonly roundBudget?: number;
  /**
   * The RESOLVED verification level for this turn (master-plan PHASE 3). orchestrate
   * sets this from the Governor's `verify` lever when the Governor is ON, else from
   * the conservative built-in default policy (or `deps.verifyLevel`). Read by the
   * verify stage ONLY when `deps.verifyPort` is present. Absent → the stage defaults
   * to `'tests'` (tests-first, the free signal — never a fabricated pass).
   */
  readonly verifyLevel?: import('./verify.js').VerifyLevel;
  /**
   * THE TRUST SURFACE (master-plan PHASE 8). When true, the accept-point receipt is
   * UPGRADED from the bare verify line into the consolidated, auditable trust receipt
   * (auditable confidence + verify + self-audit), composed PURELY from the real
   * signals already on the turn. DEFAULT (absent/false) → the accept path emits
   * EXACTLY today's single verify-receipt notice (byte-for-byte neutrality).
   */
  readonly trustEnabled?: boolean;
  /**
   * The brain's FINAL confidence tuple for THIS turn (understanding / groundedness /
   * stakes / optional cross-vendor agreement). Threaded so the trust receipt can
   * point the confidence statement at its real grounds. Read ONLY when
   * {@link trustEnabled} is true; absent → no confidence line (never fabricated).
   */
  readonly brainConfidence?: import('./brain.js').Confidence;
  /**
   * Prior metered spend already incurred THIS turn BEFORE the work-call loop runs —
   * e.g. a judgment poll or rival tribunal that made real provider calls and returned
   * a measured `totalCostUsd`. The loop SEEDS its own `totalCostUsd` from this so the
   * terminal `final.totalCostUsd` is the HONEST sum across every metered run this turn
   * (the honesty contract: "real sum across all runs"). OPTIONAL — when absent it
   * defaults to 0, so the loop behaves byte-for-byte identically to before (no
   * double-counting: the poll/tribunal cost is added here exactly once, and the
   * poll/tribunal generators never re-enter this loop). Read ONLY here, in (e).
   */
  readonly priorCostUsd?: number;
  /** When true, use vendor-neutral routing behind the flag (slices 9-10). */
  readonly vendorNeutralEnabled?: boolean;
}

/**
 * runWorkCall — the bounded escalation + review work loop, extracted verbatim from
 * orchestrate(). Yields the SAME CoreEvent stream in the SAME order as the inlined
 * loop. Owns ONLY its internal loop state (the tier, attempt/cost/notes counters,
 * the per-tier tried sets, the failover pool, the review/revise budgets). The
 * admission GATES are NOT relocated — `admitManager` here is the in-loop admission
 * wrapper over the loop-local tier, identical to the inlined closure.
 */

/**
 * Build {@link VendorNeutralRouteParams} from live context and call
 * vendor-neutral-route. Returns the decision on ok, or null on NoCapableProvider.
 * For web-search turns the router already soft-prefers native search internally;
 * this helper surfaces the disclosure when needed.
 */
function vendorNeutralDecision(
  tier: Tier,
  pool: readonly ProviderId[],
  deps: OrchestrateDeps,
  sessionId: string,
  wantsWebSearch: boolean,
  hasImageAttachment: boolean,
): ReturnType<typeof route> | null {
  const registry = deps.capabilityRegistry;
  if (!registry) return null;
  const availableModelsMap = new Map<ProviderId, readonly string[]>();
  if (deps.availableModels) {
    for (const [p, models] of Object.entries(deps.availableModels)) {
      if (models !== undefined) availableModelsMap.set(p as ProviderId, models);
    }
  }
  const result = vendorNeutralRoute({
    tier,
    authedProviders: deps.authenticatedProviders ?? pool,
    availableModels: availableModelsMap,
    registry,
    sessionId,
    ...(wantsWebSearch ? { needsWebSearch: true as const } : {}),
    ...(hasImageAttachment ? { needsVision: true as const } : {}),
    ...(deps.attachments !== undefined && deps.attachments.length > 0 ? { hasAttachments: true as const } : {}),
  });
  if (result.ok) return result.decision;
  return null;
}

export async function* runWorkCall(input: WorkCallInput): AsyncGenerator<CoreEvent> {
  const {
    task,
    deps,
    signal,
    classification,
    routePlan,
    directive,
    intentFrame,
    engagementPlan,
    goalTitle,
    workTrace,
    incomingWorkContract,
    available,
    mode,
    taskSignals,
    capabilityContext,
    historyContext,
    wantsWebSearch,
    hasImageAttachment,
    startTier,
    autoBrainEscalation,
    turnCallBudget,
    verifyLevel,
    trustEnabled,
    brainConfidence,
    priorCostUsd,
    vendorNeutralEnabled,
  } = input;

  // -------------------------------------------------------------------------
  // (e) Loop state — owned by this stage.
  // -------------------------------------------------------------------------
  let currentTier: Tier = startTier;
  let managerNotes: string | undefined;
  let attempts = 0;
  let providerCalls = 0;
  // Core-answer reservation: the first work provider call is un-sheddable (the
  // product invariant — see menu.ts shed-ladder + capability-budget SheddingPlan).
  // turnCallBudget caps optional work AFTER that first call, and may arrive 0 or
  // "remaining-after-preflight" from upstream; the core slot survives regardless.
  const callBudgetAvailable = (): boolean =>
    turnCallBudget === undefined ||
    providerCalls === 0 ||
    providerCalls < turnCallBudget;
  // Seed from any prior metered spend this turn (poll/tribunal). Defaults to 0 when
  // absent → byte-for-byte the prior path; the prior cost is folded in exactly once.
  let totalCostUsd = priorCostUsd ?? 0;
  let lastOutput = '';
  let acceptedRun: AcceptedRunSessionData | undefined;
  /** Track the last error category across all attempts (for the failing final). */
  let lastErroredCategory: import('../providers/port.js').CliError['category'] | undefined;
  /** Track the last attempted provider (for the failing final). */
  let lastAttemptedProvider: ProviderId | undefined;
  /** Track the last selected account id (for the failing final after the loop). */
  let lastSubscriptionAccountId: string | undefined;
  /**
   * Manager-tier attempts used this turn — the quota guard for adaptive flagship
   * admission (Balanced earns a bounded number of flagship passes per turn). The
   * orchestrate() admission gates ran with this at 0 (they never increment it); the
   * loop starts it at 0 here, identical to the inlined path.
   */
  let flagshipAttemptsThisTurn = 0;

  /**
   * Generic-open-menu repair budget (adaptive-partner-v2-5.6.md §2.2 A2). The
   * `reject_generic_open_menu` validator may fire ONCE per turn: when a successful
   * answer is the order-taker menu, we re-run the SAME tier once with a manager-
   * style repair note. Bounded at 1 (distinct from MAX_REVISE_RETRIES, which is
   * the reviewer-revise budget) so it never adds a second metered call on a turn
   * that already passed. A repaired answer that still fails is KEPT (never
   * discarded) — the best-effort accept paths below preserve a usable answer.
   */
  let genericMenuRepairs = 0;
  const MAX_VALIDATOR_REPAIRS = 1;

  /**
   * Per-tier set of providers that have already been tried, used by the
   * cross-vendor failover logic so we never retry the same provider twice
   * within a tier on consecutive execution failures.
   */
  const triedByTier = new Map<Tier, Set<ProviderId>>();

  /**
   * When non-null, the next iteration must route among only these providers
   * (the remaining untried vendors at the current tier).  Cleared after use.
   */
  let failoverPool: ProviderId[] | null = null;

  /**
   * Partial draft salvaged from a rate-limited interrupted attempt, to be
   * injected into the NEXT provider's prompt (draft-handoff semantics).
   * Set in the failover branch (rate-limit only, guards met), cleared
   * immediately after buildPrompt so it never leaks into a later iteration.
   * undefined on the common path → byte-identical output.
   */
  let salvagedDraft: string | undefined;

  /**
   * Track which attempt indices have already been reviewed so that re-runs
   * (e.g. after a revise verdict) are not reviewed a second time and we
   * cannot enter an infinite review loop.
   */
  const reviewedAttempts = new Set<number>();

  /**
   * How many times a reviewer's `revise` verdict has triggered a same-tier
   * re-run this turn. A `revise` re-executes the ENTIRE (often expensive)
   * investigation against the same model with feedback notes; left unbounded it
   * can drive the loop to exhaust `maxAttempts` re-doing the same heavy work and
   * then discard the result. We allow ONE revise re-run (apply the notes once);
   * beyond that, blind re-execution is wasteful — escalate to a stronger tier if
   * admission allows, otherwise accept the best answer we already have.
   */
  let reviseRetries = 0;

  /**
   * Adaptive flagship admission for a manager request at the current decision
   * point. Closes over the live `currentTier` and `flagshipAttemptsThisTurn`.
   * Returns the full decision (tier + allowed + reason) so callers can surface an
   * honest notice on denial. Scopes the free-plan veto to the eligible
   * (authenticated, cooldown-filtered) candidate providers. This is the IN-LOOP
   * admission wrapper — identical body to orchestrate()'s preamble closure; the
   * gates' authority is unchanged, it just reads the loop-local live tier.
   */
  const admitManager = (trigger: FlagshipTrigger, assessmentArg?: Assessment): FlagshipDecision =>
    authorizeTier({
      requestedTier: 'manager',
      currentTier,
      classification,
      ...(assessmentArg !== undefined ? { assessment: assessmentArg } : {}),
      policy: deps.policy,
      ...(deps.planInfos !== undefined ? { planInfos: deps.planInfos } : {}),
      ...(deps.authenticatedProviders !== undefined
        ? { candidateProviders: deps.authenticatedProviders }
        : {}),
      flagshipAttemptsThisTurn,
      trigger,
    });

  // -------------------------------------------------------------------------
  // (e2) THE VERIFY STAGE runner (master-plan PHASE 3) — armed ONLY when the
  // verify flag injected `deps.verifyPort`. When absent, verifyStage returns
  // undefined and this is a behaviour-neutral no-op (the flag-off neutrality the
  // characterization + oracle suites prove). FAIL-SOFT throughout — a crash in
  // verification degrades to an honest `unverified` note and NEVER breaks the turn.
  //
  // The critic (the ONE paid lever) runs ONLY when the resolved verify level
  // selects it (the Governor's `verify` lever, or the conservative built-in
  // default). It reuses the SAME cross-vendor reviewer routing the review block
  // uses (route → collectProviderRun → ledger → parseReviewVerdict) so the diff
  // critic is a real, parseable verdict — never fabricated — and its cost is
  // accounted into `totalCostUsd` + the ledger exactly like the inline reviewer.
  const runVerifyAtAccept = async (candidate: CandidateResult): Promise<VerifyOutcome | undefined> => {
    if (candidate.verifyPort === undefined) return undefined;
    // The critic-runner the verify stage calls. Returns { ran:true } only on a
    // genuinely parseable verdict; a broken/absent reviewer → { ran:false } so the
    // four-state never claims `reviewed` off a non-verdict.
    const runCritic = async (
      input: CriticRunInput,
    ): Promise<CriticRunOutput | undefined> => {
      const reviewerProvider = deps.providers[input.reviewer];
      if (reviewerProvider === undefined) return { ran: false };
      try {
        const reviewModelOutcomeOrder = deps.modelOutcomeOrderByTaskKind?.['review'];
        const reviewCapabilityContext: CapabilityRouteContext | undefined =
          deps.capabilityRegistry !== undefined
            ? {
                registry: deps.capabilityRegistry,
                taskSignals: { ...taskSignals, taskKind: 'review' },
                mode,
                ...(reviewModelOutcomeOrder !== undefined
                  ? { modelOutcomeOrder: reviewModelOutcomeOrder }
                  : {}),
              }
            : undefined;
        let reviewDecision: ReturnType<typeof route>;
        if (vendorNeutralEnabled && deps.capabilityRegistry) {
          const vnDecision = vendorNeutralDecision(
            'manager', [input.reviewer], deps, deps.session.id, false, false,
          );
          if (vnDecision) {
            reviewDecision = vnDecision;
          } else {
            return { ran: false };
          }
        } else {
          reviewDecision = route(
            'manager',
            [input.reviewer],
            deps.policy,
            deps.availableModels,
            deps.authenticatedProviders,
            deps.learnedProviderOrder?.['manager'],
            reviewCapabilityContext,
          );
        }
        const reviewEffort = effortForDecision(
          deps.capabilityRegistry,
          input.reviewer,
          reviewDecision.model,
          reviewDecision.tier,
          mode,
          { ...taskSignals, taskKind: 'review' },
        );
        const reviewReq: ProviderRequest = {
          model: reviewDecision.model,
          prompt: input.prompt,
          cwd: deps.cwd,
          sandbox: deps.sandbox,
          timeoutMs: deps.timeoutMs,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
        };
        const reviewStart = deps.clock.now();
        if (!callBudgetAvailable()) return { ran: false };
        providerCalls++;
        const reviewOutcome = await collectProviderRun(reviewerProvider, reviewReq, signal);
        const reviewDurationMs = deps.clock.now() - reviewStart;
        if (reviewOutcome.canceled || reviewOutcome.errored != null) {
          return { ran: false };
        }
        const reviewPricing = getModelPricing(input.reviewer, reviewDecision.model);
        const reviewUsd =
          reviewOutcome.providerCostUsd ??
          (reviewOutcome.usage !== undefined && reviewPricing !== undefined
            ? (deps.cacheAccountingV2 === true
              ? calculateEffectiveCost(
                  reviewOutcome.usage.inputTokens,
                  reviewOutcome.usage.outputTokens,
                  reviewPricing,
                  { cachedInputTokens: reviewOutcome.usage.cachedInputTokens, cacheWriteInputTokens: reviewOutcome.usage.cacheWriteInputTokens },
                )
              : calculateCost(
                  reviewOutcome.usage.inputTokens,
                  reviewOutcome.usage.outputTokens,
                  reviewPricing,
                ))
            : 0);
        totalCostUsd += reviewUsd;
        await deps.ledger.record({
          timestamp: deps.clock.isoNow(),
          sessionId: deps.session.id,
          taskId: deps.clock.uuid(),
          provider: input.reviewer,
          model: reviewDecision.model,
          tier: reviewDecision.tier,
          inputTokens: reviewOutcome.usage?.inputTokens ?? 0,
          outputTokens: reviewOutcome.usage?.outputTokens ?? 0,
          cachedInputTokens: reviewOutcome.usage?.cachedInputTokens ?? 0,
          ...(deps.cacheAccountingV2 === true && reviewOutcome.usage?.cacheWriteInputTokens !== undefined
            ? { cacheWriteInputTokens: reviewOutcome.usage.cacheWriteInputTokens }
            : {}),
          usd: reviewUsd,
          durationMs: reviewDurationMs,
          success: true,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
          taskKind: 'review',
          ...(deps.accountAux === true ? { stage: 'review' as const } : {}),
          ...(deps.accountAux === true && deps.intentVersionId !== undefined
            ? { intentVersionId: deps.intentVersionId }
            : {}),
        });
        const verdict = parseReviewVerdict(reviewOutcome.finalText ?? '');
        // A real, parseable verdict ⇒ the critic genuinely ran.
        return {
          ran: verdict.parsed === true,
          parsed: verdict.parsed,
          verdict: verdict.verdict,
          notes: verdict.notes,
        };
      } catch {
        return { ran: false };
      }
    };

    return verifyStage({
      output: candidate.content,
      provider: candidate.provider,
      tier: candidate.tier,
      port: candidate.verifyPort,
      level: candidate.verifyLevel,
      task: candidate.task,
      cwd: candidate.cwd,
      ...(candidate.verifyTestTimeoutMs !== undefined
        ? { testTimeoutMs: candidate.verifyTestTimeoutMs }
        : {}),
      available: candidate.availableProviders,
      runCritic,
    });
  };

  const receiptEvents = (
    verifyOutcome: VerifyOutcome | undefined,
    candidate: CandidateResult,
  ): readonly CoreEvent[] => {
    if (candidate.trustEnabled === true) {
      const trustSignals: TrustSignals = {
        ...(candidate.brainConfidence !== undefined
          ? { confidence: candidate.brainConfidence }
          : {}),
        ...(verifyOutcome !== undefined ? { verify: verifyOutcome } : {}),
        ...(verifyOutcome?.changedPaths !== undefined && verifyOutcome.changedPaths.length > 0
          ? { groundedFiles: verifyOutcome.changedPaths }
          : {}),
        ...(deps.authenticatedProviders !== undefined
          ? { authedProviderCount: deps.authenticatedProviders.length }
          : {}),
      };
      const receipt = composeTrustReceipt(
        trustSignals,
        confidenceLine(candidate.brainConfidence),
      );
      if (!isEmptyReceipt(receipt)) {
        const level = verifyOutcome?.verified === 'failing' ? 'warn' : 'info';
        return trustReceiptLines(receipt).map((message) => ({ type: 'notice', level, message }));
      }
      return [];
    }
    if (verifyOutcome === undefined) return [];
    return [{
      type: 'notice',
      level: verifyOutcome.verified === 'failing' ? 'warn' : 'info',
      message: buildVerifyReceipt(verifyOutcome),
    }];
  };

  const runAcceptanceRepair = async function* (
    candidate: CandidateResult,
    evidence: string,
  ): AsyncGenerator<CoreEvent, CandidateResult | undefined> {
    const provider = deps.providers[candidate.provider];
    if (provider === undefined || signal.aborted || !callBudgetAvailable()) return undefined;

    providerCalls++;
    attempts++;
    const reasoningEffort = effortForDecision(
      deps.capabilityRegistry,
      candidate.provider,
      candidate.model,
      candidate.tier,
      mode,
      taskSignals,
    );
    const useNative = candidate.sessionId !== undefined;
    const prompt = buildPrompt(
      candidate.tier,
      task,
      evidence,
      useNative ? undefined : historyContext,
      {
        ...(deps.goalTurn === true ? { goalTurn: true } : {}),
        ...(directive.substantial === true ? { explanatory: true } : {}),
        ...(buildInitialExecutorContextBlockOptions(deps) ?? {}),
      },
    );

    yield {
      type: 'tier-start',
      tier: candidate.tier,
      provider: candidate.provider,
      model: candidate.model,
      attempt: attempts,
      ...(goalTitle.length > 0 ? { title: goalTitle } : {}),
      risk: classification.risk,
    };

    const req: ProviderRequest = {
      model: candidate.model,
      prompt,
      cwd: deps.cwd,
      sandbox: deps.sandbox,
      timeoutMs: deps.timeoutMs,
      ...(candidate.sessionId !== undefined
        ? { sessionId: candidate.sessionId, resume: true }
        : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(wantsWebSearch ? { webSearch: true } : {}),
      ...(hasImageAttachment && deps.attachments !== undefined
        ? { attachments: deps.attachments }
        : {}),
    };
    const start = deps.clock.now();
    const outcome = yield* streamProvider(provider, req, candidate.tier, signal);
    const durationMs = deps.clock.now() - start;
    const finalText = outcome.finalText ?? '';
    const success =
      !outcome.canceled && outcome.errored === undefined && finalText.trim().length > 0;
    const pricing = getModelPricing(candidate.provider, candidate.model);
    const usd =
      outcome.providerCostUsd ??
      (outcome.usage !== undefined && pricing !== undefined
        ? (deps.cacheAccountingV2 === true
          ? calculateEffectiveCost(
              outcome.usage.inputTokens,
              outcome.usage.outputTokens,
              pricing,
              { cachedInputTokens: outcome.usage.cachedInputTokens, cacheWriteInputTokens: outcome.usage.cacheWriteInputTokens },
            )
          : calculateCost(
              outcome.usage.inputTokens,
              outcome.usage.outputTokens,
              pricing,
            ))
        : 0);
    totalCostUsd += usd;
    const assessment = assess(finalText);

    await deps.ledger.record({
      timestamp: deps.clock.isoNow(),
      sessionId: deps.session.id,
      taskId: deps.clock.uuid(),
      provider: candidate.provider,
      model: candidate.model,
      tier: candidate.tier,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      cachedInputTokens: outcome.usage?.cachedInputTokens ?? 0,
      ...(deps.cacheAccountingV2 === true && outcome.usage?.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: outcome.usage.cacheWriteInputTokens }
        : {}),
      usd,
      durationMs,
      success,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      taskKind: taskSignals.taskKind,
      ...(deps.accountAux === true ? { stage: 'work' as const } : {}),
      ...(deps.accountAux === true && deps.intentVersionId !== undefined
        ? { intentVersionId: deps.intentVersionId }
        : {}),
    });
    yield {
      type: 'tier-done',
      tier: candidate.tier,
      success,
      confidence: assessment.confidence,
      costUsd: usd,
      inputTokens: outcome.usage?.inputTokens ?? 0,
      outputTokens: outcome.usage?.outputTokens ?? 0,
      durationMs,
    };

    if (!success) return undefined;

    lastOutput = finalText;
    const repairedRun: AcceptedRunSessionData = {
      content: finalText,
      tier: candidate.tier,
      provider: candidate.provider,
      model: candidate.model,
      confidence: assessment.confidence,
      costUsd: usd,
      durationMs,
      ...(outcome.sessionId !== undefined
        ? { sessionId: outcome.sessionId }
        : candidate.sessionId !== undefined
          ? { sessionId: candidate.sessionId }
          : {}),
      ...(candidate.workTrace !== undefined ? { workTrace: candidate.workTrace } : {}),
    };
    acceptedRun = repairedRun;
    return makeCandidate(repairedRun, candidate.disposition);
  };

  function makeCandidate(
    run: AcceptedRunSessionData,
    disposition: CandidateResult['disposition'],
  ): CandidateResult {
    const candidate: CandidateResult = {
      ...run,
      get totalCostUsd() { return totalCostUsd; },
      get attempts() { return attempts; },
      disposition,
      task,
      cwd: deps.cwd,
      ...(deps.verifyPort !== undefined ? { verifyPort: deps.verifyPort } : {}),
      verifyLevel: verifyLevel ?? deps.verifyLevel ?? 'tests',
      ...(deps.verifyTestTimeoutMs !== undefined
        ? { verifyTestTimeoutMs: deps.verifyTestTimeoutMs }
        : {}),
      availableProviders: deps.authenticatedProviders ?? available,
      ...(trustEnabled === true ? { trustEnabled: true } : {}),
      ...(brainConfidence !== undefined ? { brainConfidence } : {}),
      repair: (evidence) => runAcceptanceRepair(candidate, evidence),
    };
    return candidate;
  }

  // LAYER B (auto-brain escalation) — live only when the auto-brain flag is on.
  const layerBOn = autoBrainEscalation === true;

  const gateAcceptedRun = async function* (
    run: AcceptedRunSessionData,
    disposition: CandidateResult['disposition'],
    deferFailingFinal = false,
  ): AsyncGenerator<CoreEvent, GateResult> {
    return yield* runCandidateQualityGate({
      deps,
      candidate: makeCandidate(run, disposition),
      goalTurn: deps.goalTurn === true,
      verify: runVerifyAtAccept,
      receiptEvents,
      deferFailingFinal,
    });
  };

  // Accept the candidate; on demonstrable repeated objective failure (a 'failing'
  // gate AFTER the bounded repair) escalate the tier and tell the loop to RETRY
  // (Layer B). When Layer B is off, or escalation is impossible (top tier / attempt
  // ceiling / manager admission denied), this is byte-identical to gateAcceptedRun
  // + finalize. Returns 'escalated' (caller: `continue mainLoop`) or 'final'
  // (caller: `return`). The failing final is DEFERRED only when escalation is
  // actually possible, so a deferred-but-not-escalated final never goes unemitted.
  const acceptWithLayerB = async function* (
    run: AcceptedRunSessionData,
    disposition: CandidateResult['disposition'],
    assessmentArg: Assessment,
  ): AsyncGenerator<CoreEvent, 'escalated' | 'final'> {
    const escalateTo = layerBOn ? nextTierUp(currentTier) : null;
    const admissionOk =
      escalateTo === 'manager' ? admitManager('failure', assessmentArg).allowed : escalateTo !== null;
    const canEscalate = layerBOn && escalateTo !== null && admissionOk;
    const gateRes = yield* gateAcceptedRun(run, disposition, canEscalate);
    if (
      canEscalate &&
      escalateTo !== null &&
      decideLayerBEscalation({
        classification: gateRes.classification,
        currentTier,
        attempts,
        maxAttempts: deps.policy.maxAttempts,
      })
    ) {
      yield {
        type: 'escalate',
        from: currentTier,
        to: escalateTo,
        reason: 'objective failure after bounded repair (Layer B)',
      };
      currentTier = escalateTo;
      return 'escalated';
    }
    return 'final';
  };

  // -------------------------------------------------------------------------
  // (f) Main orchestration loop
  // -------------------------------------------------------------------------
  // maxAttempts bounds ordinary escalation / review / repair iterations. A
  // queued failover is a separate budget: once an execution failure identifies
  // an authenticated, untried provider at this tier, that provider gets its one
  // execution even when the ordinary attempt ceiling has been reached.
  mainLoop: while (
    failoverPool !== null ||
    (attempts < deps.policy.maxAttempts && callBudgetAvailable())
  ) {
    attempts++;

    // --- Route for current tier ---
    // When a failoverPool is set (previous failure, untried vendors remain),
    // route among only those vendors for this one iteration, then clear the pool.
    const routePool = failoverPool ?? available;
    failoverPool = null;
    // When currentTier is 'manager' we have ALREADY passed adaptive admission
    // (initial gate or an earned escalation gate), so route() must not re-clamp it
    // back down via the static maxTier safety net — lift the ceiling to 'manager'
    // for this resolve. For worker/ic, the static policy (and its maxTier) applies.
    const effPolicy: Policy =
      currentTier === 'manager' ? { ...deps.policy, maxTier: 'manager' } : deps.policy;
    // Learned, observed-only provider order for the tier we're routing (the
    // Local Outcome Learner). Absent → routing is unchanged. We key on
    // currentTier (the requested tier); route() applies it after its own clamp,
    // and an entry for a tier the run clamps away simply finds no eligible match
    // and falls through to the static order.
    let decision: ReturnType<typeof route>;
    const staticRoute = (): ReturnType<typeof route> =>
      route(
        currentTier,
        routePool,
        effPolicy,
        deps.availableModels,
        deps.authenticatedProviders,
        deps.learnedProviderOrder?.[currentTier],
        capabilityContext,
      );
    if (vendorNeutralEnabled && deps.capabilityRegistry) {
      const vnDecision = vendorNeutralDecision(
        currentTier, routePool, deps, deps.session.id, wantsWebSearch, hasImageAttachment,
      );
      if (vnDecision) {
        decision = vnDecision;
      } else {
        // Un-sheddable core answer: VN routing could not resolve a capable model
        // (e.g. an authenticated provider whose model is not in the capability
        // catalog). Rather than abort the turn with no answer, fall back to the
        // static policy router so the core answer still runs.
        decision = staticRoute();
      }
    } else {
      decision = staticRoute();
    }

    // Reasoning effort for THIS run, selected against the resolved model's
    // capability facts (capability registry §3/§5). decision.tier is the tier the
    // policy ALREADY granted (after route()'s clamp), so this can never open
    // manager or exceed policy. undefined when no registry / no efforts → no flag.
    const reasoningEffort = effortForDecision(
      deps.capabilityRegistry,
      decision.provider,
      decision.model,
      decision.tier,
      mode,
      taskSignals,
    );

    // Count a flagship attempt the moment the run resolves to the manager tier
    // (the quota guard read by subsequent admission decisions this turn).
    if (decision.tier === 'manager') {
      flagshipAttemptsThisTurn++;
    }

    // Record this provider as tried at this tier.
    let tierTried = triedByTier.get(currentTier);
    if (tierTried === undefined) {
      tierTried = new Set();
      triedByTier.set(currentTier, tierTried);
    }
    tierTried.add(decision.provider);
    lastAttemptedProvider = decision.provider;

    const provider = deps.providers[decision.provider];
    if (provider === undefined) {
      yield {
        type: 'notice',
        level: 'error',
        message: `Provider "${decision.provider}" was selected by route() but is not present in deps.providers.`,
      };
      break mainLoop;
    }

    // --- Native session decision (EXPERIMENTAL, opt-in) ---
    // Use native continuity only when this tier's provider has a plan. Otherwise
    // (no plan for this provider) fall back to replaying the compacted history —
    // so switching providers never loses context.
    //
    // STALE-HISTORY HARDENING (AP2-F / Stage 6, §3 "Native session caveat"): when
    // this turn's directive quarantines the history (a prior assistant turn was a
    // generic menu OR predates the enforced-ask engine version), do NOT resume the
    // provider's NATIVE session — it holds the SERVER-SIDE memory of that poisoned/
    // legacy prose, which would few-shot the old order-taker behavior straight past
    // the cleaned replay. Forcing the replay path means the model sees the
    // QUARANTINED/cleaned history, not the provider's stale memory. This is a NARROW
    // per-turn policy: clean turns keep native sessions exactly as before. menu.ts
    // already withholds the plan entirely on a quarantined turn (planNativeSession
    // gets the policy); this is the in-orchestrate backstop so the directive remains
    // authoritative even if a plan slipped through. Fail-soft: no plan → no-op.
    const quarantined =
      directive.historyPolicy.replayMode === 'quarantine_assistant_prose';
    const nativePlan = quarantined
      ? undefined
      : deps.nativeSession?.find((p) => p.provider === decision.provider);
    const useNative = nativePlan !== undefined;

    // Compute fallback reason for telemetry (observed only, never alters behaviour).
    let nativeFallbackReason: import('./native-session-telemetry.js').NativeSessionTelemetry['fallbackReason'] | undefined;
    if (quarantined) {
      nativeFallbackReason = 'quarantined';
    } else if (!useNative && deps.nativeSession !== undefined && deps.nativeSession.length > 0) {
      nativeFallbackReason = 'provider-mismatch';
    } else if (!useNative) {
      nativeFallbackReason = 'no-plan';
    }

    // --- Build prompt (with optional reviewer feedback on retry + history context) ---
    // Bug 4 fix: inject managerNotes whenever defined, not just when currentTier === 'ic'.
    // When using a native session, skip the replayed history — the provider holds it.
    // Use decision.tier (the tier route() actually resolved, AFTER any maxTier
    // clamp) — not the requested currentTier — so the persona prompt always
    // matches the model that runs (e.g. balanced clamps manager→ic: we must use
    // the IC persona on the sonnet model, never the manager persona).
    const prompt = buildPrompt(
      decision.tier,
      task,
      managerNotes,
      useNative ? undefined : historyContext,
      {
        ...(deps.goalTurn === true ? { goalTurn: true } : {}),
        // EXPLANATORY DEPTH (review §2d/§7): the expanded "make it land" directive
        // fires ONLY on a substantial/explanatory turn, reusing the SAME
        // `directive.substantial` predicate the grounded-recommendation validator
        // uses (turn-directive.ts decideSubstantial → isTrivial-exempt). A trivial
        // / quick-factual turn has substantial=false → the block is omitted and the
        // fast path stays crisp.
        ...(directive.substantial === true ? { explanatory: true } : {}),
        ...(deps.partnerStyle !== undefined ? { partnerStyle: deps.partnerStyle } : {}),
        ...(deps.environmentContext !== undefined ? { environmentContext: deps.environmentContext } : {}),
        ...(deps.toolStateContext !== undefined ? { toolStateContext: deps.toolStateContext } : {}),
        ...(deps.memoryContext !== undefined ? { memoryContext: deps.memoryContext } : {}),
        ...(deps.tasteContext !== undefined ? { tasteContext: deps.tasteContext } : {}),
        ...(deps.workStateContext !== undefined ? { workStateContext: deps.workStateContext } : {}),
        // PARTIAL-OUTPUT SALVAGE: inject the prior provider's stripped partial
        // draft (rate-limit failover only). Absent → omitted → byte-identical.
        // Cleared immediately after buildPrompt (one-shot, never leaks).
        ...(salvagedDraft !== undefined ? { salvagedDraft } : {}),
        ...(deps.goalContext !== undefined ? { goalContext: deps.goalContext } : {}),
        ...(deps.rulesContext !== undefined ? { rulesContext: deps.rulesContext } : {}),
        ...(deps.visionTriageContext !== undefined ? { visionTriageContext: deps.visionTriageContext } : {}),
        // SYSTEM UNDERSTANDING (Phase 3a): inject the deep whole-picture model into
        // the WORK prompt (it previously grounded only the goal planner). Absent →
        // omitted → byte-for-byte unchanged.
        ...(deps.understandingContext !== undefined ? { understandingContext: deps.understandingContext } : {}),
        // LOCAL INVESTIGATION (rank 9): the bounded read-only retrieval findings from
        // the enforced preflight, carried into the work prompt as a grounding block.
        // Absent → omitted → byte-for-byte unchanged.
        ...(deps.investigationContext !== undefined ? { investigationContext: deps.investigationContext } : {}),
        ...(deps.intentFrame !== undefined ? { intentFrame: deps.intentFrame } : {}),
        ...(deps.engagementPlan !== undefined ? { engagementPlan: deps.engagementPlan } : {}),
      },
    );
    // IMPORTANT: clear the salvaged draft immediately after consuming it so it
    // only ever affects this single attempt and never leaks into a later retry.
    salvagedDraft = undefined;

    // --- Yield tier-start ---
    // Account-aware routing: select a subscription account when applicable.
    // Prefers the generic deps (subscriptionAccounts + accountCooldownUntil)
    // for both opencode and claude; falls back to the legacy opencode-only deps
    // for backward compatibility. When no deps or no eligible account, every
    // subsequent path is byte-for-byte unchanged.
    //
    // MODE-AWARE STRATEGY (Slice 4):
    //   cost-saver / balanced → 'sticky' (primary-first, fallback on cap)
    //   quality-first          → 'spread'  (load-balance across accounts)
    const accountStrategy: 'sticky' | 'spread' =
      mode === 'quality-first' ? 'spread' : 'sticky';
    const subscriptionAccount: SubscriptionAccount | null = (() => {
      // Generic path: when menu.ts passes provider-generic deps
      if (
        deps.subscriptionAccounts !== undefined &&
        deps.subscriptionAccounts.length > 0 &&
        (decision.provider === 'opencode' || decision.provider === 'claude' || decision.provider === 'codex' || decision.provider === 'grok')
      ) {
        return selectSubscriptionAccount({
          accounts: deps.subscriptionAccounts,
          provider: decision.provider,
          ...(decision.provider === 'opencode'
            ? { pool: opencodePoolForModel(decision.model) ?? 'zen' }
            : {}),
          nowMs: deps.clock.now(),
          cooldownUntil: deps.accountCooldownUntil ?? new Map(),
          sessionTokensByAccount: deps.sessionTokensByAccount ?? {},
          strategy: accountStrategy,
        });
      }
      // Backward compat: legacy opencode-only deps (tests, pre-migration callers)
      if (
        decision.provider === 'opencode' &&
        deps.opencodeAccounts !== undefined &&
        deps.opencodeAccounts.length > 0
      ) {
        return selectOpencodeAccount({
          accounts: deps.opencodeAccounts,
          pool: opencodePoolForModel(decision.model) ?? 'zen',
          nowMs: deps.clock.now(),
          cooldownUntil: deps.opencodeAccountCooldownUntil ?? new Map(),
          sessionTokensByAccount: deps.sessionTokensByAccount ?? {},
        });
      }
      return null;
    })();
    const accountEnv =
      subscriptionAccount !== null
        ? accountEnvFor(subscriptionAccount)
        : undefined;

    if (subscriptionAccount !== null) {
      lastSubscriptionAccountId = subscriptionAccount.id;
    }

    yield {
      type: 'tier-start',
      tier: decision.tier,
      provider: decision.provider,
      model: decision.model,
      attempt: attempts,
      ...(goalTitle.length > 0 ? { title: goalTitle } : {}),
      risk: classification.risk,
      ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
    };

    // --- Build request and record start time ---
    const req: ProviderRequest = {
      model: decision.model,
      prompt,
      cwd: deps.cwd,
      sandbox: deps.sandbox,
      timeoutMs: deps.timeoutMs,
      ...(nativePlan !== undefined
        ? { sessionId: nativePlan.sessionId, resume: nativePlan.resume }
        : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(wantsWebSearch ? { webSearch: true } : {}),
      // Image attachments (audit #4): threaded onto the request ONLY when the turn
      // genuinely carries image input (the interface layer extracted + confirmed
      // existence). Adapters that support images attach one CLI flag per path
      // (codex `-i`, opencode `-f`); claude ignores them (fail-soft). Absent → the
      // field is omitted entirely (byte-for-byte unchanged).
      ...(hasImageAttachment && deps.attachments !== undefined
        ? { attachments: deps.attachments }
        : {}),
      ...(subscriptionAccount !== null
        ? {
            accountId: subscriptionAccount.id,
            accountEnv: accountEnv as Readonly<Partial<NodeJS.ProcessEnv>>,
          }
        : {} as Record<string, never>),
    };
    const start = deps.clock.now();

    // --- Stream provider events ---
    providerCalls++;
    if (subscriptionAccount !== null && deps.onAccountUsed !== undefined) {
      const cb = deps.onAccountUsed;
      void (async () => {
        try { await cb(subscriptionAccount.id, deps.clock.isoNow()); } catch { /* best-effort */ }
      })();
    }
    const outcome = yield* streamProvider(provider, req, decision.tier, signal);

    if (outcome.canceled) {
      yield { type: 'notice', level: 'warn', message: 'cancelled' };
      yield {
        type: 'final',
        success: false,
        output: outcome.canceledBeforeStream
          ? 'Task was cancelled before it started.'
          : 'Task was cancelled.',
        tier: decision.tier,
        totalCostUsd,
        sessionId: deps.session.id,
        attempts,
        ...(outcome.canceled ? { canceled: true } : {}),
        ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
        ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
      };
      return;
    }

    const { finalText, usage, providerCostUsd } = outcome;

    // Empty-output guard (Goal 4 — fail safe on malformed/empty model output):
    // a provider can exit cleanly (no error event) yet stream NOTHING usable —
    // an empty or whitespace-only `done.text`. Accepting that as a clean success
    // renders a blank "✓ done · 0 tokens" turn with no answer, which reads as if
    // the work were finished when in fact the model produced nothing. Treat it as
    // a synthetic `model`-category error so the SAME decision tree below (cross-
    // vendor failover → escalate → honest fail) handles it exactly like any other
    // provider failure. A run that produced real text is byte-for-byte unaffected.
    const emptyOutput =
      outcome.errored === undefined &&
      !outcome.canceled &&
      (finalText ?? '').trim().length === 0;
    const errored: CliError | undefined = emptyOutput
      ? {
          category: 'model',
          recoverable: true,
          message: 'The model returned an empty response.',
          suggestion: 'Retry, or rephrase the request — the provider produced no output.',
        }
      : outcome.errored;

    // Track last error for failing final event.
    if (errored !== undefined) {
      lastErroredCategory = errored.category;
    }

    // --- Compute duration + cost ---
    const durationMs = deps.clock.now() - start;
    const success = errored == null;

    const pricing = getModelPricing(decision.provider, decision.model);
    const usd =
      providerCostUsd ??
      (usage !== undefined && pricing !== undefined
        ? (deps.cacheAccountingV2 === true
          ? calculateEffectiveCost(
              usage.inputTokens,
              usage.outputTokens,
              pricing,
              { cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens },
            )
          : calculateCost(usage.inputTokens, usage.outputTokens, pricing))
        : 0);
    totalCostUsd += usd;

    // --- Assess output ---
    const assessment = assess(finalText ?? '');

    // --- DISCOVERY-DRIVEN ESCALATION SIGNALS (adaptive-partner-v2-5.6.md §2.5 D,
    //     Stage 4). PURE extraction from the provider OUTPUT TEXT + the parsed
    //     confidence envelope — NO extra model pass, NO new agent stack. The
    //     signals feed the EXISTING review / escalation gates below, bounded by
    //     `authorizeTier` (manager) and `panelPolicy` (panel) — discovery can never
    //     bypass those. The low-confidence threshold is the SAME risk-indexed
    //     escalate bar the confidence gate uses, so the two agree on "low". On a
    //     clean, confident, local answer this is [] and nothing below changes. */
    const discoverySignals: readonly DiscoverySignal[] = success
      ? extractDiscoverySignals(
          finalText ?? '',
          assessment,
          deps.policy.escalateBelowConfidence[classification.risk],
        )
      : [];

    // --- Record in ledger ---
    await deps.ledger.record({
      timestamp: deps.clock.isoNow(),
      sessionId: deps.session.id,
      taskId: deps.clock.uuid(),
      provider: decision.provider,
      model: decision.model,
      tier: decision.tier,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      ...(deps.cacheAccountingV2 === true && usage?.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
        : {}),
      usd,
      durationMs,
      success,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      // Record the SAME taskKind orchestrate derived for routing (Stage 4, §2
      // Layer 3) so the model-level outcome learner weighs this run by task type.
      taskKind: taskSignals.taskKind,
      ...(deps.accountAux === true ? { stage: 'work' as const } : {}),
      ...(deps.accountAux === true && deps.intentVersionId !== undefined
        ? { intentVersionId: deps.intentVersionId }
        : {}),
      ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
    });

    // --- Yield tier-done ---
    // Native session telemetry: emitted only when MYSHELL_NATIVE_SESSIONS_PROMOTE
    // is on. Records the estimated token savings from skipping history replay.
    let nativeTelemetry: import('./native-session-telemetry.js').NativeSessionTelemetry | undefined;
    if (deps.nativeSessionsPromote === true) {
      nativeTelemetry = buildNativeSessionTelemetry({
        provider: decision.provider,
        nativePlan,
        useNative,
        historyContext,
        usage: usage ?? undefined,
        fallbackReason: nativeFallbackReason,
      });
      if (nativeTelemetry !== undefined && nativeTelemetry.usedNative && nativeTelemetry.resume) {
        yield {
          type: 'notice',
          level: 'info',
          message: renderNativeSessionTelemetry(nativeTelemetry),
        };
      }
    }

    yield {
      type: 'tier-done',
      tier: decision.tier,
      success,
      confidence: assessment.confidence,
      costUsd: usd,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      durationMs,
      ...(nativeTelemetry !== undefined ? { nativeSessionTelemetry: nativeTelemetry } : {}),
    };

    lastOutput = finalText ?? (errored?.message ?? '');
    if (success) {
      acceptedRun = {
        content: lastOutput,
        tier: decision.tier,
        provider: decision.provider,
        model: decision.model,
        confidence: assessment.confidence,
        costUsd: usd,
        durationMs,
        ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        ...(workTrace !== undefined ? { workTrace } : {}),
        ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
      };
    }

    // -----------------------------------------------------------------------
    // 0a) GENERIC-OPEN-MENU REPAIR (adaptive-partner-v2-5.6.md §2.2 A2).
    // -----------------------------------------------------------------------
    // A successful answer that is the order-taker "are you fixing / adding /
    // polishing / integrating?" menu is the exact live failure mode. When the
    // directive's validator fires (and the model did NOT emit a legitimate
    // structured ask_user block, which the short-circuit below owns), re-run the
    // SAME tier ONCE with a manager-style repair note appended. This costs one
    // retry ONLY on the live failure — never on a passing turn — and is bounded
    // (MAX_VALIDATOR_REPAIRS = 1). The current `acceptedRun`/`lastOutput` are left
    // in place: if the repaired answer is no better, the best-effort accept paths
    // below KEEP a usable answer rather than discarding it as Failed.
    // The generic-menu (§2.2 A2) and grounded-recommendation (§2.6 E) validators
    // SHARE this single repair budget — together they retry at most once, so we
    // never multiply provider calls. validateTurnOutput returns the FIRST failure;
    // we pick the matching repair note so the retry gets targeted feedback.
    const rawValidatorFailure =
      success &&
      callBudgetAvailable() &&
      genericMenuRepairs < MAX_VALIDATOR_REPAIRS &&
      parseQuestions(finalText ?? '') === null
        ? validateTurnOutput(finalText ?? '', directive)
        : null;
    // The grounded-recommendation repair DEFERS to the review pipeline: when this
    // turn will be cross-vendor reviewed (high/critical risk, or the model asked for
    // review), the reviewer's revise verdict is the STRONGER, already-budgeted
    // correction — preempting it with a local repair would waste the shared budget
    // and double-correct. The generic-menu failure is a hard order-taker failure
    // mode and is repaired regardless. (When review will NOT run, the grounded
    // repair fires here as the only correction.)
    const validatorFailure =
      rawValidatorFailure !== null &&
      rawValidatorFailure.kind === 'ungrounded_recommendation' &&
      shouldReview(classification, assessment, deps.policy.reviewPolicy)
        ? null
        : rawValidatorFailure;
    if (validatorFailure !== null) {
      genericMenuRepairs++;
      const repairNote =
        validatorFailure.kind === 'ungrounded_recommendation'
          ? GROUNDED_RECOMMENDATION_REPAIR_NOTE
          : GENERIC_MENU_REPAIR_NOTE;
      managerNotes =
        managerNotes !== undefined && managerNotes.length > 0
          ? `${managerNotes}\n\n${repairNote}`
          : repairNote;
      yield {
        type: 'notice',
        level: 'info',
        message:
          validatorFailure.kind === 'ungrounded_recommendation'
            ? 'Reworking an ungrounded answer into a grounded recommendation.'
            : 'Reworking a generic task-category menu into a grounded recommendation.',
      };
      continue mainLoop;
    }

    // -----------------------------------------------------------------------
    // 0b) GROUNDED-RECOMMENDATION TRUTHFUL FALLBACK (§2.6 E, AP2-E).
    // -----------------------------------------------------------------------
    // If we reach here on a successful turn, the validator either passed OR the
    // shared one-retry budget is exhausted. When the grounded-recommendation
    // validator STILL fails (a substantial turn left ungrounded after the retry),
    // append the DETERMINISTIC truthful wrapper — but ONLY when it is literally
    // true (no recommendation could be grounded, and it is not already an honest
    // "can't see the repo"). We NEVER fabricate grounding; this only states the
    // honest next step. The fallback is appended to the kept answer (lastOutput +
    // acceptedRun.content) so every downstream final carries it. We DEFER it when a
    // review will run (the reviewer may replace this output — appending now would
    // wrap a soon-discarded answer); on a reviewed turn the grounded repair is also
    // deferred, so review owns the correction end-to-end.
    if (
      success &&
      parseQuestions(finalText ?? '') === null &&
      !shouldReview(classification, assessment, deps.policy.reviewPolicy) &&
      shouldAppendGroundedFallback(lastOutput, directive)
    ) {
      lastOutput =
        lastOutput.length > 0
          ? `${lastOutput}\n\n${GROUNDED_RECOMMENDATION_FALLBACK}`
          : GROUNDED_RECOMMENDATION_FALLBACK;
      if (acceptedRun !== undefined) {
        acceptedRun = { ...acceptedRun, content: lastOutput };
      }
    }

    // -----------------------------------------------------------------------
    // 0) Structured question short-circuit (ask_user)
    // -----------------------------------------------------------------------
    // If the model ended its turn by asking the user a structured question
    // instead of completing work, that is a COMPLETE turn that needs a reply —
    // not low-confidence work. Yield a successful final carrying the questions
    // and return WITHOUT escalating or reviewing. The confidence envelope is
    // ignored for this turn (the two are mutually exclusive per prompt.ts).
    if (success) {
      // Prefer the model's own ask_user block. When APE planned an ASK_CLARIFYING
      // at a genuine fork but the model did NOT ask, derive the structured
      // question from the frame's fork so the planned fork is never silently
      // dropped (intent §5.4 / APE §6.2). The derivation is bounded by ASK_CAP and
      // only fires on the FIRST attempt (a derived ask is terminal — it short-
      // circuits the turn exactly like a model ask, no escalate/review).
      const modelQuestions = parseQuestions(finalText ?? '');
      const derivedQuestions =
        modelQuestions === null &&
        attempts === 1 &&
        engagementPlan.actions.includes('ASK_CLARIFYING')
          ? deriveAskFromForks(intentFrame, engagementPlan)
          : null;
      const questions = modelQuestions ?? derivedQuestions;
      if (questions !== null) {
        if (acceptedRun === undefined) {
          throw new Error('orchestrate invariant violated: question final without accepted run');
        }
        await appendAcceptedAssistant(deps, acceptedRun);
        yield {
          type: 'final',
          success: true,
          output: lastOutput,
          tier: currentTier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          questions,
          ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
        };
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Decision tree
    // -----------------------------------------------------------------------

    // 1) Provider failure → try cross-vendor failover first; escalate only when
    //    all vendors at this tier have been exhausted.
    if (!success) {
      // Timeouts are terminal for THIS task: do NOT cross-vendor fail over and do
      // NOT escalate the tier. Re-running the same (too-broad) task on another
      // vendor at the same tier just doubles the wall-clock and the spend for the
      // same likely-to-time-out work — exactly the runaway we are fixing. Stop
      // here with an actionable notice. (Fast crashes and other recoverable
      // errors keep the existing failover/escalation behaviour below.)
      if (errored !== undefined && errored.category === 'timeout') {
        // Honest-spend judgment call (Goal 3): a timeout SIGKILLs the child before
        // the CLI emits its terminal usage/result, so claude-parse produces no
        // usage. The LedgerEntry schema (types.ts) holds only numeric token/usd
        // fields — it cannot represent "unknown". We do NOT fabricate a number:
        // the ledger entry was recorded above with success:false and the real
        // parsed usage (0 when none arrived before the kill). When nothing was
        // parsed, the recorded $0 is NOT a real cost — the run very likely burned
        // the user's subscription — so we surface that explicitly here rather than
        // letting the UI render "0 tokens / $0 / free". When partial usage DID
        // arrive before the kill, we trust it and make no unknown-spend claim.
        const parsedNoUsage =
          usage === undefined && providerCostUsd === undefined;
        if (parsedNoUsage) {
          yield {
            type: 'notice',
            level: 'warn',
            message:
              'Spend unknown — the process was killed before reporting usage; the recorded $0 is not a real cost (the run may still have consumed your subscription).',
          };
        }
        yield {
          type: 'notice',
          level: 'warn',
          message:
            'Timed out before the model finished. Not retrying on another vendor (the same work would likely time out again and double the cost). The task may be too broad — narrow it, or raise the timeout in Settings.',
        };
        yield {
          type: 'final',
          success: false,
          output: lastOutput,
          tier: currentTier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          errorCategory: 'timeout',
          provider: decision.provider,
          ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
          ...(deps.evidenceReceiptV2 === true
            ? (() => {
                const entries = deps.receiptLedgerSnapshot?.() ?? [];
                const cooldownProviders = (() => {
                  const cd = deps.cooldownUntil;
                  if (!cd || cd.size === 0) return undefined;
                  const now = deps.clock.now();
                  const result: { provider: ProviderId; remainingMs: number }[] = [];
                  for (const [provider, until] of cd) {
                    if (until > now) {
                      result.push({ provider, remainingMs: until - now });
                    }
                  }
                  return result.length > 0 ? result : undefined;
                })();
                const r = buildEvidenceReceipt({
                  terminal: 'failed' as const,
                  success: false,
                  totalCostUsd,
                  ...(deps.cacheAccountingV2 === true ? { cacheAccountingV2: true as const } : {}),
                  ledgerEntries: entries,
                  ...(deps.intentVersionId !== undefined ? { intentVersionId: deps.intentVersionId } : {}),
                  ...(cooldownProviders !== undefined ? { cooldownProviders } : {}),
                  ...(deps.sessionTokensForReceipt !== undefined ? { sessionTokens: deps.sessionTokensForReceipt } : {}),
                });
                return r !== undefined ? { receipt: r } : {};
              })()
            : {}),
        };
        return;
      }

      // Compute which providers haven't been tried at this tier yet.
      const triedAtTier = triedByTier.get(currentTier) ?? new Set<ProviderId>();
      let remaining = available.filter((id) => !triedAtTier.has(id));
      // Don't fail over to a provider that isn't signed in — it would just fail
      // again with "not signed in" and burn an attempt. When we have real auth
      // info, restrict the failover pool to authenticated providers; if that
      // leaves nothing, we escalate/stop instead of attempting a doomed vendor.
      // (When auth info is absent/empty we keep the prior behaviour and try an
      // untried vendor anyway — auth may have changed since detection.)
      const authedProviders = deps.authenticatedProviders;
      if (authedProviders !== undefined && authedProviders.length > 0) {
        remaining = remaining.filter((id) => authedProviders.includes(id));
      }

      if (remaining.length > 0) {
        // Peek at what route() will pick from the remaining pool so the event
        // names the execution that is now guaranteed to run. Provider failover
        // has its own dynamic budget (one run per authenticated provider at this
        // tier), independent of the escalation / repair maxAttempts ceiling.
        // This also makes sandbox-environment failures switch CLIs immediately
        // instead of spending another ordinary retry on the broken sandbox.
        let nextDecision: ReturnType<typeof route>;
        const staticFailoverRoute = (): ReturnType<typeof route> =>
          route(
            currentTier,
            remaining,
            effPolicy,
            deps.availableModels,
            deps.authenticatedProviders,
            deps.learnedProviderOrder?.[currentTier],
            capabilityContext,
          );
        if (vendorNeutralEnabled && deps.capabilityRegistry) {
          const vnDecision = vendorNeutralDecision(
            currentTier, remaining, deps, deps.session.id, wantsWebSearch, hasImageAttachment,
          );
          // VN routing could not resolve a capable failover model: fall back to the
          // static router over the remaining untried pool rather than aborting with
          // no answer (mirrors the initial-route fallback above).
          nextDecision = vnDecision ?? staticFailoverRoute();
        } else {
          nextDecision = staticFailoverRoute();
        }
        yield {
          type: 'failover',
          from: decision.provider,
          to: nextDecision.provider,
          tier: currentTier,
          reason: errored?.message ?? 'execution failure',
        };

        // PARTIAL-OUTPUT SALVAGE (draft-handoff): when the just-failed attempt
        // was rate-limited AND produced a meaningful partial, inject it as
        // context for the next provider so no work is wasted.
        // Guards (ALL must hold or salvage is skipped → undefined clears any stale):
        //   G1. Error category is specifically 'rate-limit' (not auth, model, etc.)
        //   G2. finalText is defined and stripped length >= SALVAGE_MIN_CHARS
        //   G3. The stripped draft does not contain an unterminated tool-call/fence
        // Multi-failover A→B→C: each failover replaces from the just-failed attempt
        // (latest-wins); a failed guard clears any stale draft (never carry forward).
        if (
          errored?.category === 'rate-limit' &&
          finalText !== undefined
        ) {
          const stripped = stripSalvageEnvelope(finalText).trimEnd();
          if (
            stripped.length >= SALVAGE_MIN_CHARS &&
            !hasUnterminatedToolCall(stripped)
          ) {
            // Cap to SALVAGE_MAX_CHARS keeping the HEAD (natural continuation).
            const capped =
              stripped.length > SALVAGE_MAX_CHARS
                ? `${stripped.slice(0, SALVAGE_MAX_CHARS)}\n[draft truncated — continue from here]`
                : stripped;
            salvagedDraft = capped;
            yield {
              type: 'notice',
              level: 'info',
              message: `Resuming on ${nextDecision.provider} from ${decision.provider}'s partial draft (~${capped.length} chars) — no work wasted.`,
            };
          } else {
            // Guard failed — clear any stale draft from a prior failover.
            salvagedDraft = undefined;
          }
        } else {
          // Not a rate-limit failover — clear any stale draft.
          salvagedDraft = undefined;
        }

        // Signal the next iteration to route among only the remaining vendors.
        // The loop condition treats this as failover budget, not ordinary budget.
        failoverPool = remaining;
        continue mainLoop;
      }

      if (!callBudgetAvailable()) break mainLoop;

      // An auth failure can be provider-local, so authenticated alternatives
      // above must get their failover execution. Once none remain, however,
      // escalating tiers would only retry a CLI whose authentication is broken.
      if (errored !== undefined && errored.category === 'auth') {
        yield {
          type: 'final',
          success: false,
          output: lastOutput,
          tier: currentTier,
          totalCostUsd,
          sessionId: deps.session.id,
          attempts,
          errorCategory: 'auth',
          provider: decision.provider,
          ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
        };
        return;
      }

      // All authenticated, available vendors at this tier have now been tried —
      // only at this point may the tier escalate or hard-fail.
      // Adaptive admission: a failure escalation to the flagship is an EARNED
      // trigger, but Efficient (never-auto) and a free-plan veto deny it; in that
      // case fall back to the static ceiling (clampTier) — preserving the prior
      // effective behaviour (e.g. Efficient worker→ic).
      // QUALITY SAFEGUARD: on the *first* execution failure of a turn, force an
      // escalate to manager (if the tier allows) even if the current policy would
      // deny it. This guarantees that a transient/recoverable error never produces
      // a hard "Failed — attempts: 1" when the user has access to stronger models
      // via any of their subscriptions. Subsequent fails respect the normal gates.
      if (currentTier !== 'manager') {
        let target: Tier = admitManager('failure').allowed
          ? 'manager'
          : clampTier('manager', deps.policy.maxTier);
        if (target === currentTier && attempts <= 1) {
          target = 'manager';
        }
        if (target === currentTier) {
          break mainLoop; // ceiling reached — cannot escalate further
        }
        yield { type: 'escalate', from: currentTier, to: target, reason: 'execution failure' };
        currentTier = target;
        continue mainLoop;
      } else {
        break mainLoop; // already at manager; emit failing final below
      }
    }

    if (!callBudgetAvailable()) break mainLoop;

    // 2) Cross-vendor review for high/critical risk or needsReview — any tier
    //    Guard: each attempt is reviewed at most once (prevents infinite loops).
    //    Guard: skip review if the only available reviewer is the same vendor
    //           (cross-vendor review is required; same-vendor-only → skip).
    //
    //    DISCOVERY (§2.5 D): a discovery worth a second vendor's eyes (a
    //    high-stakes surface, a cross-cutting change, or a verified wider root
    //    cause) ADDS a review trigger — but only as far as the user's reviewPolicy
    //    already permits. We AND-gate the discovery path on reviewPolicy !== 'off'
    //    so discovery can never review a turn the user turned review OFF for; and
    //    the same `!reviewedAttempts.has` + cross-vendor guards below still bound
    //    it to at most one review per attempt. A passing turn with no discovery
    //    signal sees the original `shouldReview` decision unchanged.
    const discoveryWantsReview =
      deps.policy.reviewPolicy !== 'off' && discoveryWarrantsReview(discoverySignals);
    if (
      (shouldReview(classification, assessment, deps.policy.reviewPolicy) ||
        discoveryWantsReview) &&
      !reviewedAttempts.has(attempts)
    ) {
      // Pick the reviewer from AUTHENTICATED (and, since the conversation layer
      // already cooldown-filters that list, un-throttled) providers when we know
      // them — never route a review to a signed-out or cooled-down vendor. Falls
      // back to all available providers only when auth state is unknown.
      const reviewerPool =
        deps.authenticatedProviders !== undefined && deps.authenticatedProviders.length > 0
          ? available.filter((id) => (deps.authenticatedProviders as readonly ProviderId[]).includes(id))
          : available;
      const reviewerId = pickReviewer(reviewerPool, decision.provider);
      // Only proceed with a DIFFERENT-vendor reviewer (cross-vendor requirement).
      const reviewerProvider =
        reviewerId !== null && reviewerId !== decision.provider
          ? deps.providers[reviewerId]
          : undefined;

      if (reviewerId !== null && reviewerProvider !== undefined) {
        reviewedAttempts.add(attempts);
        yield {
          type: 'notice',
          level: 'info',
          message: `Review by ${reviewerId} (cross-vendor)`,
        };

        // Route the reviewer at the flagship tier — through the SAME adaptive
        // admission gate as every other manager step, so it isn't a back door.
        // When admitted (e.g. high/critical risk, which is exactly when review
        // fires), lift the ceiling so the reviewer runs the strong model; when
        // denied, route() clamps it to the policy ceiling. Either way we use the
        // RESOLVED reviewDecision.tier everywhere below — never a hard-coded
        // 'manager' — so events/ledger never claim a tier the model didn't run.
        // Note: the review is gated through admission for honest labelling and the
        // never-auto / free-plan cases, but it does NOT consume the per-turn
        // flagship ESCALATION budget — review is a distinct, separately-bounded
        // mechanism (once per attempt, cross-vendor required). Counting it here
        // would let a high-risk review starve the task's own escalation pass.
        const reviewAdmission = admitManager('review', assessment);
        const reviewPolicy: Policy = reviewAdmission.allowed
          ? { ...deps.policy, maxTier: 'manager' }
          : deps.policy;
        // The reviewer pool is a single provider, so the learned order can only
        // confirm it (never reorder a one-element pool) — passed for consistency
        // so every route() call site threads the same learned snapshot.
        // Review is a 'review' taskKind regardless of the work turn's kind — the
        // reviewer's job is critique. Build a review-flavoured capability context
        // so capability-fit + effort selection treat it as such. Absent registry →
        // undefined → route() unchanged (byte-for-byte).
        const reviewModelOutcomeOrder = deps.modelOutcomeOrderByTaskKind?.['review'];
        const reviewCapabilityContext: CapabilityRouteContext | undefined =
          deps.capabilityRegistry !== undefined
            ? {
                registry: deps.capabilityRegistry,
                taskSignals: { ...taskSignals, taskKind: 'review' },
                mode,
                ...(reviewModelOutcomeOrder !== undefined
                  ? { modelOutcomeOrder: reviewModelOutcomeOrder }
                  : {}),
              }
            : undefined;
        let reviewDecision: ReturnType<typeof route>;
        if (vendorNeutralEnabled && deps.capabilityRegistry) {
          const vnDecision = vendorNeutralDecision(
            'manager', [reviewerId], deps, deps.session.id, wantsWebSearch, hasImageAttachment,
          );
          if (vnDecision) {
            reviewDecision = vnDecision;
          } else {
            yield {
              type: 'notice',
              level: 'error',
              message: `Vendor-neutral routing could not find a review provider. Skipping review.`,
            };
            // skip review — fall through to accept path
            reviewDecision = route(
              'manager',
              [reviewerId],
              reviewPolicy,
              deps.availableModels,
              deps.authenticatedProviders,
              deps.learnedProviderOrder?.['manager'],
              reviewCapabilityContext,
            );
          }
        } else {
          reviewDecision = route(
            'manager',
            [reviewerId],
            reviewPolicy,
            deps.availableModels,
            deps.authenticatedProviders,
            deps.learnedProviderOrder?.['manager'],
            reviewCapabilityContext,
          );
        }
        const reviewTier = reviewDecision.tier;
        // Reasoning effort for the reviewer run, against the resolved reviewer
        // model. reviewTier is the tier admission already granted to the reviewer,
        // so this never opens manager or exceeds policy. undefined → no flag.
        const reviewEffort = effortForDecision(
          deps.capabilityRegistry,
          reviewerId,
          reviewDecision.model,
          reviewTier,
          mode,
          { ...taskSignals, taskKind: 'review' },
        );
        const reviewContractDecision = shouldMaterializeContract({
          classification,
          routePlan,
          context: 'normal',
          reviewWillRun: true,
        });
        const reviewContract =
          incomingWorkContract !== undefined
            ? stampContractIntentVersion(incomingWorkContract, deps.intentStore !== undefined ? deps.intentVersionId : undefined)
            : isCleanObjectiveTask(task)
              ? capContract({
                  version: 1,
                  objective: task,
                  ...(deps.intentStore !== undefined && deps.intentVersionId !== undefined
                    ? { intentVersionId: deps.intentVersionId }
                    : {}),
                })
              : undefined;
        const reviewPrompt =
          reviewContractDecision.criteria && reviewContract !== undefined
            ? buildReviewPrompt(task, lastOutput, reviewContract)
            : buildReviewPrompt(task, lastOutput);

        // Yield tier-start for review run
        yield {
          type: 'tier-start',
          tier: reviewTier,
          provider: reviewerId,
          model: reviewDecision.model,
          attempt: attempts,
          ...(goalTitle.length > 0 ? { title: goalTitle } : {}),
          risk: classification.risk,
        };

        const reviewReq: ProviderRequest = {
          model: reviewDecision.model,
          prompt: reviewPrompt,
          cwd: deps.cwd,
          sandbox: deps.sandbox,
          timeoutMs: deps.timeoutMs,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
          // Provider-capability parity (audit): the reviewer judges THIS turn's
          // output, so it must see the SAME capability inputs the sequential work
          // request carried — otherwise a reviewer of a vision turn can't see the
          // attached image, and a reviewer of a current-facts turn can't verify the
          // claim against live info. Mirror both signals from the work request:
          //   • webSearch — when the turn genuinely needed external/current facts
          //     (`wantsWebSearch`, driven by the engagement WEB_RESEARCH flag), the
          //     reviewer needs the same live-info access to validate, not rubber-stamp
          //     or falsely reject, current-fact answers. Codex honours it; others
          //     fail-soft ignore it.
          //   • attachments — when the turn genuinely carries image input, the
          //     reviewer must SEE the image to judge a vision answer. Omitted entirely
          //     on text-only turns → byte-for-byte unchanged.
          ...(wantsWebSearch ? { webSearch: true } : {}),
          ...(hasImageAttachment && deps.attachments !== undefined
            ? { attachments: deps.attachments }
            : {}),
        };
        const reviewStart = deps.clock.now();

        // --- Consume reviewer events without surfacing internal prose ---
        providerCalls++;
        const reviewOutcome = await collectProviderRun(reviewerProvider, reviewReq, signal);

        if (reviewOutcome.canceled) {
          yield { type: 'notice', level: 'warn', message: 'cancelled' };
          yield {
            type: 'final',
            success: false,
            output: 'Task was cancelled.',
            tier: currentTier,
            totalCostUsd,
            sessionId: deps.session.id,
            attempts,
            ...(reviewOutcome.canceled ? { canceled: true } : {}),
            ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
            ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
          };
          return;
        }

        const reviewDurationMs = deps.clock.now() - reviewStart;
        const reviewSuccess = reviewOutcome.errored == null;

        const reviewPricing = getModelPricing(reviewerId, reviewDecision.model);
        const reviewUsd =
          reviewOutcome.providerCostUsd ??
          (reviewOutcome.usage !== undefined && reviewPricing !== undefined
            ? (deps.cacheAccountingV2 === true
              ? calculateEffectiveCost(
                  reviewOutcome.usage.inputTokens,
                  reviewOutcome.usage.outputTokens,
                  reviewPricing,
                  { cachedInputTokens: reviewOutcome.usage.cachedInputTokens, cacheWriteInputTokens: reviewOutcome.usage.cacheWriteInputTokens },
                )
              : calculateCost(reviewOutcome.usage.inputTokens, reviewOutcome.usage.outputTokens, reviewPricing))
            : 0);
        totalCostUsd += reviewUsd;

        // Record reviewer run in ledger
        await deps.ledger.record({
          timestamp: deps.clock.isoNow(),
          sessionId: deps.session.id,
          taskId: deps.clock.uuid(),
          provider: reviewerId,
          model: reviewDecision.model,
          tier: reviewTier,
          inputTokens: reviewOutcome.usage?.inputTokens ?? 0,
          outputTokens: reviewOutcome.usage?.outputTokens ?? 0,
          cachedInputTokens: reviewOutcome.usage?.cachedInputTokens ?? 0,
          ...(deps.cacheAccountingV2 === true && reviewOutcome.usage?.cacheWriteInputTokens !== undefined
            ? { cacheWriteInputTokens: reviewOutcome.usage.cacheWriteInputTokens }
            : {}),
          usd: reviewUsd,
          durationMs: reviewDurationMs,
          success: reviewSuccess,
          ...(reviewEffort !== undefined ? { reasoningEffort: reviewEffort } : {}),
          // The reviewer run is always a 'review' taskKind (Stage 4).
          taskKind: 'review',
          ...(deps.accountAux === true ? { stage: 'review' as const } : {}),
          ...(deps.accountAux === true && deps.intentVersionId !== undefined
            ? { intentVersionId: deps.intentVersionId }
            : {}),
        });

        // Yield tier-done for reviewer
        yield {
          type: 'tier-done',
          tier: reviewTier,
          success: reviewSuccess,
          confidence: null,
          costUsd: reviewUsd,
          inputTokens: reviewOutcome.usage?.inputTokens ?? 0,
          outputTokens: reviewOutcome.usage?.outputTokens ?? 0,
          durationMs: reviewDurationMs,
        };

        // Parse verdict and act on it
        const verdict = parseReviewVerdict(reviewOutcome.finalText ?? '');

        // Risk-indexed fail-open: when parsing failed (verdict.parsed === false)
        // AND the task is high/critical risk, do NOT silently auto-approve —
        // escalate (or warn if already at manager) rather than letting
        // unparseable output pass as approved.
        if (!verdict.parsed && (classification.risk === 'high' || classification.risk === 'critical')) {
          // Escalate to the flagship to adjudicate — but only if admission allows it
          // (high/critical risk justifies it under adaptive; a free-plan veto or spent
          // attempt budget can still deny). When denied, fall through to the honest
          // "inconclusive — not auto-approving" failing final rather than escalating.
          if (currentTier !== 'manager' && admitManager('review', assessment).allowed) {
            yield {
              type: 'notice',
              level: 'warn',
              message: 'review inconclusive — not auto-approving',
            };
            yield { type: 'escalate', from: currentTier, to: 'manager', reason: 'review inconclusive' };
            currentTier = 'manager';
            continue mainLoop;
          } else {
            // Already at manager (top tier): a high/critical-risk review came back
            // inconclusive and there is no higher tier to escalate to. Do NOT ship
            // it as a clean success — surface the inconclusive result honestly.
            yield {
              type: 'notice',
              level: 'warn',
              message: 'review inconclusive — not auto-approving',
            };
            yield {
              type: 'final',
              success: false,
              output: lastOutput,
              tier: currentTier,
              totalCostUsd,
              sessionId: deps.session.id,
              attempts,
              ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
              ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
            };
            return;
          }
        } else {
          yield {
            type: 'notice',
            level: 'info',
            message: `Review verdict: ${verdict.verdict}`,
          };

          if (verdict.verdict === 'approve') {
            if (acceptedRun === undefined) {
              throw new Error('orchestrate invariant violated: approved final without accepted run');
            }
            if ((yield* acceptWithLayerB(acceptedRun, 'clean', assessment)) === 'escalated') {
              continue mainLoop;
            }
            return;
          }

          if (verdict.verdict === 'revise') {
            // Bound blind re-execution. The first revise applies the reviewer's
            // notes and re-runs the same tier once. A SECOND revise would re-run
            // the same expensive investigation against the same model again — the
            // 160k-token runaway. Instead, treat a persistent revise like an
            // escalate: hand it to a stronger tier when admission allows; if we
            // can't escalate, accept the best answer we already have (the accept
            // path below), never blind-loop to exhaustion.
            if (reviseRetries < MAX_REVISE_RETRIES) {
              reviseRetries++;
              managerNotes = verdict.notes;
              continue mainLoop;
            }
            const escalateTo = nextTierUp(currentTier);
            const escalateBlocked =
              escalateTo === 'manager' ? !admitManager('review', assessment).allowed : false;
            if (escalateTo !== null && !escalateBlocked) {
              managerNotes = verdict.notes;
              yield {
                type: 'escalate',
                from: currentTier,
                to: escalateTo,
                reason: 'review revise (bounded re-execution)',
              };
              currentTier = escalateTo;
              continue mainLoop;
            }
            // Can't escalate (top tier, or admission denied) — accept the best
            // result rather than re-running the same model again.
            yield {
              type: 'notice',
              level: 'warn',
              message:
                'reviewer asked for further revision but the cheaper re-run budget is spent — accepting best result',
            };
            if (acceptedRun === undefined) {
              throw new Error('orchestrate invariant violated: revise-accept final without accepted run');
            }
            if ((yield* acceptWithLayerB(acceptedRun, 'bestEffort', assessment)) === 'escalated') {
              continue mainLoop;
            }
            return;
          }

          // verdict === 'escalate'
          const escalateTo = nextTierUp(currentTier);
          // Adaptive admission negates a flagship escalation the reviewer asked for
          // when this mode/turn doesn't admit manager (Efficient, free-plan veto, or
          // attempt budget spent). Accept the current result rather than re-running
          // the same model. (Escalation to 'ic' is always allowed.)
          const reviewEscalateBlocked =
            escalateTo === 'manager' ? !admitManager('review', assessment).allowed : false;
          if (escalateTo !== null && reviewEscalateBlocked) {
            yield {
              type: 'notice',
              level: 'warn',
              message: 'reviewer requested escalation but the policy tier ceiling is reached — accepting best result',
            };
            if (acceptedRun === undefined) {
              throw new Error('orchestrate invariant violated: ceiling-accepted final without accepted run');
            }
            if ((yield* acceptWithLayerB(acceptedRun, 'bestEffort', assessment)) === 'escalated') {
              continue mainLoop;
            }
            return;
          }
          if (escalateTo === null) {
            // Bug 2 fix: already at the top tier — reviewer requested escalation
            // but there is nowhere higher to go.  Yield an honest warn + failing
            // final instead of silently looping until maxAttempts.
            yield {
              type: 'notice',
              level: 'warn',
              message: 'reviewer requested escalation but already at the top tier — accepting best result',
            };
            yield {
              type: 'final',
              success: false,
              output: lastOutput,
              tier: currentTier,
              totalCostUsd,
              sessionId: deps.session.id,
              attempts,
              ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
              ...(subscriptionAccount !== null ? { accountId: subscriptionAccount.id } : {}),
            };
            return;
          }
          yield { type: 'escalate', from: currentTier, to: escalateTo, reason: 'reviewer escalation' };
          currentTier = escalateTo;
          continue mainLoop;
        }
      }
    }

    // 3) Confidence-based escalation (+ DISCOVERY-DRIVEN escalation, §2.5 D)
    const threshold = deps.policy.escalateBelowConfidence[classification.risk];
    // A discovery indicating high-risk or cross-cutting blast radius (a
    // high-confidence wider root cause, a cross-cutting change, or a high-stakes
    // surface) is a §2.5 D reason to REQUEST a manager escalation — the engine
    // deliberately changes scope when investigation finds the real work is bigger.
    // It only sets `needEsc`; whether manager actually opens is STILL decided by
    // `admitManager`/`authorizeTier` below (free-plan veto, Efficient never-auto,
    // and the per-turn flagship budget remain the sole authority). A merely-larger
    // BUT-LOCAL fix (a medium-confidence larger_bug with no cross-cutting/high-
    // stakes signal) does NOT trip this — it stays at the current tier and is just
    // done, per §2.5 D ("just do the larger fix when it is local/reversible").
    const discoveryWantsEscalation = discoveryWarrantsManager(discoverySignals);
    const needEsc =
      assessment.escalate ||
      discoveryWantsEscalation ||
      (assessment.confidence !== null && assessment.confidence < threshold);

    const nextTier = nextTierUp(currentTier);
    // The tier we'd actually escalate to, or null if escalation wouldn't change the
    // running model. For a flagship (manager) step, adaptive admission decides:
    // under Balanced this confidence trigger is justified, but a free-plan veto or a
    // spent attempt budget can still deny it. Escalation to 'ic' (from worker) is
    // always allowed; the static clamp guards that legacy case.
    const confAdmission: FlagshipDecision | null =
      nextTier === 'manager' ? admitManager('confidence', assessment) : null;
    const escalateTo: Tier | null =
      nextTier === 'manager'
        ? confAdmission?.allowed
          ? 'manager'
          : null
        : nextTier !== null && clampTier(nextTier, deps.policy.maxTier) !== currentTier
          ? nextTier
          : null;
    if (needEsc && escalateTo !== null) {
      // Prefer a discovery-driven reason when a discovery (not low confidence)
      // drove this escalation — the `escalate` event IS the notice of the real
      // additional run that the next loop iteration starts at the higher tier, so
      // it is the honest place to name WHY scope widened (no fake "escalating…"
      // without a run). Falls back to the model's own reason / low confidence.
      const discoveryReason = discoveryWantsEscalation
        ? discoveryEscalationReason(discoverySignals)
        : undefined;
      const escalateReason =
        discoveryReason ??
        (assessment.reason !== 'model provided no reason' &&
        assessment.reason !== 'no confidence envelope'
          ? assessment.reason
          : 'low confidence');
      yield {
        type: 'escalate',
        from: currentTier,
        to: escalateTo,
        reason: escalateReason,
      };
      currentTier = escalateTo;
      continue mainLoop;
    }

    // Honest notice: the turn WANTED to escalate to the flagship (low confidence /
    // escalate signal) but adaptive admission denied it (Efficient, free-plan veto,
    // or the per-turn flagship budget is spent). Surface why, so a low-confidence
    // result isn't silently accepted as if it were fully trusted.
    if (needEsc && confAdmission !== null && !confAdmission.allowed) {
      yield {
        type: 'notice',
        level: 'warn',
        message: `accepting best available result — ${confAdmission.reason}`,
      };
    }

    // 4) Accept — everything checks out (or the flagship was warranted but denied)
    //
    // verifyStage SLOT (Phase 3, NOW FILLED): this accept point is exactly where the
    // verification centerpiece runs — the turn is about to be accepted as "done", so
    // change-capture → tests-first → an optional diff-scoped critic runs HERE and the
    // honest four-state `verified` receipt is surfaced. The stage is FLAG-GATED: when
    // `deps.verifyPort` is absent (the default), verifyStage returns undefined and
    // this is byte-for-byte the pre-Phase-3 accept path (the characterization + oracle
    // suites prove that neutrality).
    if (acceptedRun === undefined) {
      throw new Error('orchestrate invariant violated: successful final without accepted run');
    }
    yield* gateAcceptedRun(acceptedRun, 'clean');
    return;
  }

  // -------------------------------------------------------------------------
  // Loop exhausted or broke out on failure.
  //
  // CARDINAL RULE — never discard a usable answer as "Failed". The bounded
  // escalation/review loop can run out of attempts (e.g. a reviewer kept asking
  // to `revise`, or low confidence kept retrying the same tier) WITHOUT ever
  // reaching a clean accept. If a provider run nonetheless produced a substantive
  // answer (`acceptedRun` is set only on an errorless run, and its content is
  // non-empty), that answer is the user's best result — returning success:false
  // here throws away good work AND hides it behind a "Failed" banner.
  //
  // So: when a substantive accepted answer exists, return it as a BEST-EFFORT
  // success — persist it to the session like any accepted turn, attach any
  // model-proposed memory, and flag `bestEffort` so the renderer notes honestly
  // that it exhausted the loop / stayed under the confidence bar (not a clean
  // success, but real work the user can use). success:false is reserved for
  // GENUINE failure: no usable output (provider/auth/timeout errors, empty text).
  // Those terminal paths already returned above with their own honest finals; the
  // only way to reach here with no acceptedRun is the `break mainLoop` on an
  // error with no untried vendor — that correctly still fails below.
  // -------------------------------------------------------------------------
  if (acceptedRun !== undefined && acceptedRun.content.trim().length > 0) {
    yield* gateAcceptedRun(acceptedRun, 'bestEffort');
    return;
  }

  yield {
    type: 'final',
    success: false,
    output: lastOutput,
    tier: currentTier,
    totalCostUsd,
    sessionId: deps.session.id,
    attempts,
    ...(lastErroredCategory !== undefined ? { errorCategory: lastErroredCategory } : {}),
    ...(lastAttemptedProvider !== undefined ? { provider: lastAttemptedProvider } : {}),
    ...(lastSubscriptionAccountId !== undefined ? { accountId: lastSubscriptionAccountId } : {}),
    ...(deps.blockedStateV1 === true && lastErroredCategory !== undefined
      ? (() => {
          const code = blockedCodeForError(lastErroredCategory);
          if (code === undefined) return {};
          const br = buildBlockedRecord({
            reason: `Work halted: ${lastErroredCategory}`,
            nextAction: code === 'missing_authority'
              ? 'Authenticate and retry the request.'
              : code === 'quota_exhausted'
                ? 'Wait for quota refresh or reduce usage, then retry.'
                : code === 'environment_unavailable'
                  ? 'Check environment availability and retry.'
                  : 'Resolve the approval constraint before retrying.',
            preservedWork: lastOutput.slice(0, 500),
            code,
          });
          if (br === null) return {};
          return { blocked: br } as const;
        })()
      : {}),
    ...(deps.evidenceReceiptV2 === true
      ? (() => {
          const entries = deps.receiptLedgerSnapshot?.() ?? [];
          let blockedRecordForReceipt: import('./blocked.js').BlockedRecord | undefined;
          if (deps.blockedStateV1 === true && lastErroredCategory !== undefined) {
            const code = blockedCodeForError(lastErroredCategory);
            if (code !== undefined) {
              const br = buildBlockedRecord({
                reason: `Work halted: ${lastErroredCategory}`,
                nextAction: 'Review the output and retry.',
                preservedWork: lastOutput.slice(0, 500),
                code,
              });
              if (br !== null) blockedRecordForReceipt = br;
            }
          }
          const cooldownProviders = (() => {
            const cd = deps.cooldownUntil;
            if (!cd || cd.size === 0) return undefined;
            const now = deps.clock.now();
            const result: { provider: ProviderId; remainingMs: number }[] = [];
            for (const [provider, until] of cd) {
              if (until > now) {
                result.push({ provider, remainingMs: until - now });
              }
            }
            return result.length > 0 ? result : undefined;
          })();
          const r = buildEvidenceReceipt({
            terminal: blockedRecordForReceipt ? 'blocked' as const : 'failed' as const,
            success: false,
            ...(blockedRecordForReceipt !== undefined ? { blocked: blockedRecordForReceipt } : {}),
            totalCostUsd,
            ...(deps.cacheAccountingV2 === true ? { cacheAccountingV2: true as const } : {}),
            ledgerEntries: entries,
            ...(deps.intentVersionId !== undefined ? { intentVersionId: deps.intentVersionId } : {}),
            ...(cooldownProviders !== undefined ? { cooldownProviders } : {}),
            ...(deps.sessionTokensForReceipt !== undefined ? { sessionTokens: deps.sessionTokensForReceipt } : {}),
          });
          return r !== undefined ? { receipt: r } : {};
        })()
      : {}),
  };
}
