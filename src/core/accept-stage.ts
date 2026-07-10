import { confidenceLine, type Confidence } from './brain.js';
import { ENGINE_BEHAVIOR_VERSION } from './engine-version.js';
import { memoryProposalFor } from './orchestrate-memory.js';
import type { CoreEvent, OrchestrateDeps, Tier } from './types.js';
import { buildVerifyReceipt, type VerifyLevel, type VerifyOutcome, type VerifyPort } from './verify.js';
import { buildSnapshotFromVerify, type EvidenceSnapshotV2 } from './evidence.js';
import type {
  CompletionResultV1,
  CompletionTerminal,
  DeliveryQualityResult,
  CompletionWorktreeState,
  CompletionVerification,
  CompletionTestEvidence,
  CompletionRepairEvidence,
  DeliveryQualityIssue,
  CompletionGoalSettlement,
  CompletionEvidenceStatus,
} from './types.js';
import type { RankedRepoFile } from './repo-map.js';
import type { SemanticDoneCondition } from './semantic-preflight.js';
import {
  composeTrustReceipt,
  trustReceiptLines,
  isEmptyReceipt,
  type TrustSignals,
} from './trust-receipt.js';
import type { WorkContract } from './work-contract.js';
import type { ProviderId } from '../providers/port.js';
import { buildBlockedRecord } from './blocked.js';
import { buildEvidenceReceipt } from './evidence-receipt.js';
import { routingReceiptFromRun } from './turn-routing-receipt.js';

export const MAX_REVISE_RETRIES = 1;

const MAX_REPAIR_EVIDENCE_OUTPUT_CHARS = 8_000;

export interface AcceptedRunSessionData {
  readonly content: string;
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string;
  readonly confidence: number | null;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly sessionId?: string;
  readonly workTrace?: WorkContract;
  readonly accountId?: string;
  /** Human account label for visible-dispatch receipts (never a secret). */
  readonly accountLabel?: string;
  /** Reasoning effort used on the actual work call, when selected. */
  readonly reasoningEffort?: string;
  /**
   * Short routing why from actual decision fields (capabilityReasons[0],
   * classification.rationale, auto-brain reason). Never fabricated.
   */
  readonly routeReason?: string;
}

export interface CandidateResult extends AcceptedRunSessionData {
  readonly totalCostUsd: number;
  readonly attempts: number;
  readonly disposition: 'clean' | 'bestEffort';
  readonly task: string;
  readonly cwd: string;
  readonly verifyPort?: VerifyPort;
  readonly verifyLevel: VerifyLevel;
  readonly verifyTestTimeoutMs?: number;
  readonly availableProviders: readonly ProviderId[];
  readonly trustEnabled?: boolean;
  readonly brainConfidence?: Confidence;
  readonly repair: (
    evidence: string,
  ) => AsyncGenerator<CoreEvent, CandidateResult | undefined>;
}

export type GateClassification = 'passing' | 'failing' | 'unverified';

export interface GateResult {
  readonly classification: GateClassification;
  readonly verifyOutcome?: VerifyOutcome;
  readonly repairRequired: boolean;
}

export interface CandidateQualityGateOptions {
  readonly deps: OrchestrateDeps;
  readonly candidate: CandidateResult;
  readonly goalTurn: boolean;
  readonly verify: (candidate: CandidateResult) => Promise<VerifyOutcome | undefined>;
  readonly receiptEvents: (
    outcome: VerifyOutcome | undefined,
    candidate: CandidateResult,
  ) => readonly CoreEvent[];
  /**
   * LAYER B: when true, a candidate that FAILS its objective check after the
   * bounded repair does NOT emit a failing `final` here — the failing
   * {@link GateResult} is returned instead, so the caller (the work loop) can
   * escalate to a higher tier and retry. DEFAULT false → byte-identical: the
   * failing final is emitted here exactly as before.
   */
  readonly deferFailingFinal?: boolean;
}

export function classifyGateOutcome(outcome: VerifyOutcome | undefined): GateClassification {
  if (outcome?.verified === 'passing') return 'passing';
  if (outcome?.verified === 'failing') return 'failing';
  return 'unverified';
}

function criticRequestsRevision(outcome: VerifyOutcome | undefined): boolean {
  return outcome?.critic?.parsed === true && outcome.critic.verdict === 'revise';
}

export function gateResult(outcome: VerifyOutcome | undefined): GateResult {
  const classification = classifyGateOutcome(outcome);
  return {
    classification,
    ...(outcome !== undefined ? { verifyOutcome: outcome } : {}),
    repairRequired: classification === 'failing' || criticRequestsRevision(outcome),
  };
}

function clipRepairOutput(output: string): string {
  if (output.length <= MAX_REPAIR_EVIDENCE_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_REPAIR_EVIDENCE_OUTPUT_CHARS)}\n... [truncated ${output.length - MAX_REPAIR_EVIDENCE_OUTPUT_CHARS} chars]`;
}

export function buildRepairEvidence(outcome: VerifyOutcome): string {
  const parts = ['Acceptance verification failed. Repair only the evidenced defects, then leave the repository ready for the same check.'];
  if (outcome.testCommand !== undefined) parts.push(`Test: ${outcome.testCommand}.`);
  if (outcome.changedPaths !== undefined && outcome.changedPaths.length > 0) {
    parts.push(`Changed paths: ${outcome.changedPaths.join(', ')}.`);
  }
  if (outcome.testRun?.outcome === 'red' && outcome.testRun.output.length > 0) {
    parts.push(`Failure output: ${clipRepairOutput(outcome.testRun.output)}.`);
  }
  if (outcome.critic?.notes !== undefined && outcome.critic.notes.length > 0) {
    parts.push(`Critic: ${outcome.critic.notes}.`);
  }
  return parts.join(' ');
}

/**
 * Build the verification/trust receipt CoreEvents for an accepted candidate — the
 * SAME logic the sequential work-call path uses inline (`receiptEvents`), extracted
 * here so the panel and hedge executors emit the identical receipt before `final`.
 * When the candidate opted into the trust surface, the consolidated trust receipt is
 * composed from the real signals; otherwise the bare verify-receipt notice is emitted
 * (or no event at all when verification was unarmed). PURE (reads only deps + outcome).
 */
export function buildVerifyReceiptEvents(
  deps: OrchestrateDeps,
  verifyOutcome: VerifyOutcome | undefined,
  candidate: CandidateResult,
): readonly CoreEvent[] {
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
}

export async function appendAcceptedAssistant(
  deps: OrchestrateDeps,
  run: AcceptedRunSessionData,
): Promise<void> {
  await deps.session.append({
    timestamp: deps.clock.isoNow(),
    role: 'assistant',
    content: run.content,
    tier: run.tier,
    provider: run.provider,
    model: run.model,
    confidence: run.confidence,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    ...(run.workTrace !== undefined ? { workTrace: run.workTrace } : {}),
    engineBehaviorVersion: ENGINE_BEHAVIOR_VERSION,
  });
}

function receiptForFinal(
  deps: OrchestrateDeps,
  final: Extract<CoreEvent, { type: 'final' }>,
  verifyOutcome: VerifyOutcome | undefined,
): { readonly receipt?: Extract<CoreEvent, { type: 'final' }>['receipt'] } {
  if (deps.evidenceReceiptV2 !== true) return {};
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
  const receipt = buildEvidenceReceipt({
    terminal: final.success ? 'done' : (final.blocked ? 'blocked' : 'failed'),
    success: final.success,
    ...(final.bestEffort === true ? { bestEffort: true as const } : {}),
    ...(final.blocked !== undefined ? { blocked: final.blocked } : {}),
    ...(verifyOutcome !== undefined ? { verifyOutcome } : {}),
    totalCostUsd: final.totalCostUsd,
    ...(deps.cacheAccountingV2 === true ? { cacheAccountingV2: true as const } : {}),
    ledgerEntries: entries,
    ...(deps.intentVersionId !== undefined ? { intentVersionId: deps.intentVersionId } : {}),
    ...(cooldownProviders !== undefined ? { cooldownProviders } : {}),
    ...(deps.sessionTokensForReceipt !== undefined ? { sessionTokens: deps.sessionTokensForReceipt } : {}),
  });
  return receipt !== undefined ? { receipt } : {};
}

/** Visible-dispatch line from actual candidate run fields (provider · model · …). */
function routingReceiptField(
  candidate: CandidateResult,
): { readonly routingReceipt?: string } {
  const line = routingReceiptFromRun(candidate);
  return line !== undefined ? { routingReceipt: line } : {};
}

async function finalizeAcceptedCandidate(
  deps: OrchestrateDeps,
  candidate: CandidateResult,
  verifyOutcome?: VerifyOutcome,
): Promise<Extract<CoreEvent, { readonly type: 'final' }>> {
  await appendAcceptedAssistant(deps, candidate);
  const memoryProposal = memoryProposalFor(candidate.content);
  const blockedStateV1 = deps.blockedStateV1 === true;
  const routing = routingReceiptField(candidate);

  if (candidate.disposition === 'bestEffort' && blockedStateV1) {
    const br = buildBlockedRecord({
      reason: 'Verification/repair budget exhausted without a clean accept.',
      nextAction: 'Review the output manually; it may be usable but is unverified.',
      preservedWork: candidate.content.slice(0, 500),
      code: 'verification_failed',
    });
    const f: Extract<CoreEvent, { readonly type: 'final' }> = {
      type: 'final',
      success: false,
      output: candidate.content,
      tier: candidate.tier,
      totalCostUsd: candidate.totalCostUsd,
      sessionId: deps.session.id,
      attempts: candidate.attempts,
      ...(br !== null ? { blocked: br } : {}),
      ...(memoryProposal !== undefined ? { memoryProposal } : {}),
      ...(candidate.accountId !== undefined ? { accountId: candidate.accountId } : {}),
      ...routing,
    };
    const withReceipt = { ...f, ...receiptForFinal(deps, f, verifyOutcome) } as Extract<CoreEvent, { readonly type: 'final' }>;
    return attachCompletionIfFlag(deps, withReceipt, candidate, verifyOutcome);
  }

  const f: Extract<CoreEvent, { readonly type: 'final' }> = {
    type: 'final',
    success: true,
    output: candidate.content,
    tier: candidate.tier,
    totalCostUsd: candidate.totalCostUsd,
    sessionId: deps.session.id,
    attempts: candidate.attempts,
    ...(candidate.disposition === 'bestEffort' ? { bestEffort: true } : {}),
    ...(memoryProposal !== undefined ? { memoryProposal } : {}),
    ...(candidate.accountId !== undefined ? { accountId: candidate.accountId } : {}),
    ...routing,
  };
  const withReceipt = { ...f, ...receiptForFinal(deps, f, verifyOutcome) } as Extract<CoreEvent, { readonly type: 'final' }>;
  return attachCompletionIfFlag(deps, withReceipt, candidate, verifyOutcome);
}

async function emitEvidenceSnapshot(
  deps: OrchestrateDeps,
  candidate: CandidateResult,
  verifyOutcome: VerifyOutcome | undefined,
): Promise<void> {
  if (verifyOutcome === undefined || deps.evidenceSink === undefined) return;
  const input = {
    taskId: deps.evidenceTaskId ?? deps.session.id,
    turnNumber: deps.evidenceTurnNumber ?? candidate.attempts,
    verifyOutcome,
    provider: candidate.provider,
    availableProviders: candidate.availableProviders,
    conclusionsReached: [
      verifyOutcome.note !== undefined && verifyOutcome.note.length > 0
        ? verifyOutcome.note
        : `verify:${verifyOutcome.verified}`,
    ],
  };
  try {
    const snapshot = deps.evidenceSnapshotBuilder !== undefined
      ? await deps.evidenceSnapshotBuilder(input)
      : buildFallbackEvidenceSnapshot(input);
    if (snapshot !== undefined) await deps.evidenceSink(snapshot);
  } catch {
    // FAIL-SOFT: evidence emission is observational. A hash/store/adapter failure
    // must never alter acceptance, repair, or final turn output.
  }
}

function buildFallbackEvidenceSnapshot(input: {
  readonly taskId: string;
  readonly turnNumber: number;
  readonly verifyOutcome: VerifyOutcome;
  readonly provider: ProviderId;
  readonly availableProviders: readonly ProviderId[];
  readonly conclusionsReached: readonly string[];
}): EvidenceSnapshotV2 {
  const commandsRun: EvidenceSnapshotV2['commandsRun'] =
    input.verifyOutcome.testCommand !== undefined && input.verifyOutcome.testRun !== undefined
      ? [{
          command: input.verifyOutcome.testCommand,
          tier: 'test-build',
          confirmed: true,
          outcome: input.verifyOutcome.testRun.outcome === 'green' ? 'success' : 'failed',
        }]
      : [];
  return buildSnapshotFromVerify({
    taskId: input.taskId,
    turnNumber: input.turnNumber,
    verifyOutcome: input.verifyOutcome,
    providersSucceeded: [
      input.provider,
      ...(input.verifyOutcome.critic?.vendor !== undefined
        ? [input.verifyOutcome.critic.vendor]
        : []),
    ],
    filesWritten: (input.verifyOutcome.changedPaths ?? []).map((path) => ({ path })),
    commandsRun,
    conclusionsReached: input.conclusionsReached,
  });
}

export async function* runCandidateQualityGate(
  options: CandidateQualityGateOptions,
): AsyncGenerator<CoreEvent, GateResult> {
  const { deps, goalTurn, verify, receiptEvents, deferFailingFinal = false } = options;
  let candidate = options.candidate;

  if (goalTurn) {
    yield await finalizeAcceptedCandidate(deps, candidate);
    return { classification: 'unverified', repairRequired: false };
  }

  let outcome = await verify(candidate);
  await emitEvidenceSnapshot(deps, candidate, outcome);
  for (const event of receiptEvents(outcome, candidate)) yield event;
  const first = gateResult(outcome);

  if (!first.repairRequired) {
    yield await finalizeAcceptedCandidate(deps, candidate, outcome);
    return first;
  }

  yield {
    type: 'notice',
    level: 'warn',
    message: 'Acceptance verification found negative evidence; attempting one bounded repair.',
  };

  if (outcome === undefined) {
    throw new Error('accept-stage invariant violated: repair required without verification evidence');
  }
  const repaired = yield* candidate.repair(buildRepairEvidence(outcome));
  if (repaired !== undefined) {
    candidate = repaired;
    outcome = await verify(candidate);
    await emitEvidenceSnapshot(deps, candidate, outcome);
    for (const event of receiptEvents(outcome, candidate)) yield event;
  }

  const finalGate = gateResult(outcome);
  if (repaired !== undefined && !finalGate.repairRequired) {
    yield await finalizeAcceptedCandidate(deps, candidate, outcome);
    return finalGate;
  }

  // The candidate FAILED its objective check after a bounded repair — demonstrable
  // repeated failure. DEFAULT: emit the failing final here (byte-identical). When
  // `deferFailingFinal` is set (Layer B), SUPPRESS the final and hand the failing
  // GateResult back so the caller can escalate-and-retry at a higher tier.
  if (!deferFailingFinal) {
    const blockedStateV1 = deps.blockedStateV1 === true;
    const blockedRecord = blockedStateV1
      ? buildBlockedRecord({
          reason: 'Verification failed after bounded repair.',
          nextAction: 'Review the negative evidence and fix the defects manually, then re-request.',
          preservedWork: candidate.content.slice(0, 500),
          code: 'verification_failed',
        })
      : null;
    const failureFinal: Extract<CoreEvent, { readonly type: 'final' }> = {
      type: 'final',
      success: false,
      output: candidate.content,
      tier: candidate.tier,
      totalCostUsd: candidate.totalCostUsd,
      sessionId: deps.session.id,
      attempts: candidate.attempts,
      provider: candidate.provider,
      ...(candidate.accountId !== undefined ? { accountId: candidate.accountId } : {}),
      ...(blockedRecord !== null ? { blocked: blockedRecord } : {}),
      ...routingReceiptField(candidate),
    };
    const withR = { ...failureFinal, ...receiptForFinal(deps, failureFinal, outcome) } as Extract<CoreEvent, { readonly type: 'final' }>;
    yield attachCompletionIfFlag(deps, withR, candidate, outcome);
  }
  return finalGate;
}

// ---------------------------------------------------------------------------
// CompletionResultV1 construction (P1-17a) + map binding skeleton
// Pure ctors after verify; delivery gate skeleton (full 17e later).
// Attaches under deps.completionResultV1. Hard rules skeleton for worktree.
// Uses Phase1 Ranked/symbols via orientationRef for durable substrate.
// ---------------------------------------------------------------------------

function evaluateDeliveryQualitySkeleton(
  output: string,
  verification: CompletionVerification,
): DeliveryQualityResult {
  const issues: DeliveryQualityIssue[] = [];
  if (!output || output.trim().length === 0) {
    issues.push({ code: 'missing-user-answer', message: 'Empty output' });
  }
  // Skeleton: no deep overclaim (17e later); pass unless empty.
  const status = issues.length === 0 ? 'passed' : 'failed';
  return {
    status,
    checked: true,
    issues,
    nextActionNamed: status !== 'passed' || verification.status !== 'verified',
    userVisibleSummary: status === 'passed' ? 'delivery ok' : 'delivery issues',
  };
}

function buildWorktreeFromVerify(
  verifyOutcome: VerifyOutcome | undefined,
  orientation?: { ranked?: readonly RankedRepoFile[]; symbolSummary?: readonly string[] },
): CompletionWorktreeState {
  const changed = verifyOutcome?.changedPaths ?? [];
  return {
    baseline: changed.length > 0 ? 'clean' : 'unknown',
    baselineEntries: [],
    changedByAssistant: [...changed],
    excludedPreExisting: [],
    concurrentUserEdits: [],
    conflictPaths: [],
    ...(orientation ? { orientationRef: orientation } : {}),
  };
}

function buildTestEvidence(verifyOutcome: VerifyOutcome | undefined): CompletionTestEvidence {
  if (!verifyOutcome) return { status: 'not-needed' } as CompletionTestEvidence;
  if (verifyOutcome.verified === 'passing') {
    return {
      status: 'green',
      command: verifyOutcome.testCommand ?? undefined,
      durationMs: verifyOutcome.testRun?.durationMs ?? undefined,
      outputExcerpt: verifyOutcome.testRun?.output?.slice(0, 200) ?? undefined,
    } as CompletionTestEvidence;
  }
  if (verifyOutcome.verified === 'failing') {
    return {
      status: 'red',
      command: verifyOutcome.testCommand ?? undefined,
      durationMs: verifyOutcome.testRun?.durationMs ?? undefined,
      outputExcerpt: verifyOutcome.testRun?.output?.slice(0, 200) ?? undefined,
    } as CompletionTestEvidence;
  }
  if (verifyOutcome.critic?.parsed) return { status: 'detected-not-run' } as CompletionTestEvidence;
  return { status: 'unverified' as const, command: verifyOutcome.testCommand ?? undefined } as unknown as CompletionTestEvidence;
}

function buildCompletionRepairEvidence(): CompletionRepairEvidence {
  return { attempted: false, attempts: 0, maxAttempts: 1, retestedAfterLastRepair: false, finalAttemptChangedPaths: [] };
}

// ---------------------------------------------------------------------------
// Done = check (PR-D): pure helpers
// Terminal/goal done cannot be promoted from model confidence or "looks good".
// Settlement requires verify/receipt truth; doneCondition is bound from preflight
// when present, never invented.
// ---------------------------------------------------------------------------

/** Contract cap for CompletionResultV1.doneCondition (r7-item17 §3). */
export const DONE_CONDITION_LIMIT = 200;

/**
 * Bind CompletionResultV1.doneCondition from semantic preflight (preferred) or a
 * plain doneWhen/doneCondition string. Only nonblank text binds; unknown/absent →
 * null. Pure; never invents a condition.
 */
export function resolveDoneConditionText(input: {
  readonly semanticDone?: SemanticDoneCondition | null;
  readonly text?: string | null;
  readonly doneWhen?: string | null;
}): string | null {
  // Prefer semantic specified text; unknown falls through to text/doneWhen.
  // Never invents a condition when nothing is specified.
  if (input.semanticDone !== undefined && input.semanticDone !== null) {
    if (input.semanticDone.status === 'specified') {
      const t = input.semanticDone.text.trim();
      if (t.length > 0) {
        return t.length > DONE_CONDITION_LIMIT ? t.slice(0, DONE_CONDITION_LIMIT) : t;
      }
    }
  }
  const raw = input.text ?? input.doneWhen;
  if (raw === undefined || raw === null) return null;
  const t = raw.trim();
  if (t.length === 0) return null;
  return t.length > DONE_CONDITION_LIMIT ? t.slice(0, DONE_CONDITION_LIMIT) : t;
}

/**
 * Map a real VerifyOutcome to CompletionEvidenceStatus. Critic-only approve is
 * `reviewed`, never `verified` (tests alone earn verified).
 */
export function verificationStatusFromOutcome(
  verifyOutcome: VerifyOutcome | undefined,
): CompletionEvidenceStatus {
  if (verifyOutcome?.verified === 'passing') return 'verified';
  if (verifyOutcome?.verified === 'failing') return 'failing';
  if (verifyOutcome?.critic?.parsed === true) return 'reviewed';
  if (verifyOutcome === undefined) return 'unverified';
  return 'unverified';
}

/**
 * Terminal earned from verification alone. Never promotes `done` without green tests.
 */
export function terminalEarnedFromVerify(
  verifyOutcome: VerifyOutcome | undefined,
): CompletionTerminal {
  if (verifyOutcome?.verified === 'passing') return 'done';
  if (verifyOutcome?.verified === 'failing') return 'failed';
  return 'answered';
}

/**
 * Resolve the completion terminal under the done=check law:
 * - delivery failure → blocked
 * - terminalOverride `'done'` is honored ONLY when verification earned `done`
 * - other overrides (needs-user, cancelled, …) pass through
 * Model confidence / "looks good" cannot force terminal done.
 */
export function resolveCompletionTerminal(params: {
  readonly verifyOutcome?: VerifyOutcome;
  readonly terminalOverride?: CompletionTerminal;
  readonly deliveryFailed?: boolean;
}): CompletionTerminal {
  if (params.deliveryFailed === true) return 'blocked';
  const earned = terminalEarnedFromVerify(params.verifyOutcome);
  if (params.terminalOverride === undefined) return earned;
  if (params.terminalOverride === 'done' && earned !== 'done') return earned;
  return params.terminalOverride;
}

/**
 * Goal settlement under done=check. `allowed` is true only when terminal is `done`
 * AND evidence is verified (tests green) or reviewed (real critic), with no
 * conflict paths. Model claim alone never settles.
 */
export function buildGoalSettlement(params: {
  readonly terminal: CompletionTerminal;
  readonly verificationStatus: CompletionEvidenceStatus;
  readonly conflictPaths?: readonly string[];
}): CompletionGoalSettlement {
  const conflicts = (params.conflictPaths?.length ?? 0) > 0;
  const evidenceOk =
    params.verificationStatus === 'verified' ||
    params.verificationStatus === 'reviewed';
  const allowed = params.terminal === 'done' && evidenceOk && !conflicts;

  let state: CompletionGoalSettlement['state'];
  if (allowed) state = 'done';
  else if (params.terminal === 'blocked') state = 'blocked';
  else if (params.terminal === 'needs-user') state = 'needs-user';
  else if (params.terminal === 'done' && !allowed) state = 'active';
  else if (
    params.terminal === 'answered' ||
    params.terminal === 'failed' ||
    params.terminal === 'cancelled'
  ) {
    state = 'none';
  } else state = 'active';

  let reason: string;
  if (allowed) {
    reason = params.verificationStatus === 'verified' ? 'verified' : 'reviewed';
  } else if (params.terminal === 'done' && conflicts) {
    reason = 'conflict-paths';
  } else if (params.terminal === 'done' && !evidenceOk) {
    reason = 'done-requires-check';
  } else {
    reason = params.terminal;
  }

  return { allowed, state, reason };
}

export function finalizeAcceptTurn(params: {
  deps: OrchestrateDeps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  final: any;
  candidate: CandidateResult;
  verifyOutcome?: VerifyOutcome;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): { final: any; patchWork?: any } {
  const { deps, final, candidate, verifyOutcome } = params;
  if (deps.completionResultV1 === true) {
    const cr = buildCompletionResultV1({ deps, candidate, ...(verifyOutcome !== undefined ? { verifyOutcome } : {}) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patchWork = { cwd: (deps as any).cwd || process.cwd() || '.', edited: (candidate as any).changedPaths || [] };
    return { final: { ...final, completionResult: cr }, patchWork };
  }
  return { final };
}

export function buildCompletionResultV1(params: {
  deps: OrchestrateDeps;
  candidate: CandidateResult;
  verifyOutcome?: VerifyOutcome;
  terminalOverride?: CompletionTerminal;
  /** Explicit doneCondition override (tests / rare callers). Prefer deps.completionDoneCondition. */
  doneCondition?: string | null;
  semanticDone?: SemanticDoneCondition | null;
}): CompletionResultV1 {
  const { deps, candidate, verifyOutcome, terminalOverride } = params;
  const createdAt = deps.clock.isoNow();
  const id = `cr-${deps.session.id.slice(0, 20)}-${candidate.attempts}`;
  const turnId = deps.session.id;
  const sessionId = deps.session.id;

  const testEvidence = buildTestEvidence(verifyOutcome);
  const repair = buildCompletionRepairEvidence();
  const verificationStatus = verificationStatusFromOutcome(verifyOutcome);
  const verification: CompletionVerification = {
    status: verificationStatus,
    ...(verifyOutcome ? { verifyOutcome } : {}),
    testEvidence,
    repair,
    factualClaims: [],
    obligationsSatisfied: [],
    obligationsUnmet: [],
    ruleCodes: verifyOutcome?.verified === 'passing' ? ['tests-passing'] : verifyOutcome?.verified === 'failing' ? ['tests-failing'] : ['not-applicable'],
  };

  const delivery = evaluateDeliveryQualitySkeleton(candidate.content, verification);

  // Done=check: terminal `done` only when verification earns it (or delivery fails → blocked).
  const terminal = resolveCompletionTerminal({
    ...(verifyOutcome !== undefined ? { verifyOutcome } : {}),
    ...(terminalOverride !== undefined ? { terminalOverride } : {}),
    deliveryFailed: delivery.status === 'failed',
  });

  const worktree = buildWorktreeFromVerify(verifyOutcome, { ranked: [], symbolSummary: [] });

  const goalSettlement = buildGoalSettlement({
    terminal,
    verificationStatus: verification.status,
    conflictPaths: worktree.conflictPaths,
  });

  // Replay forbids re-settlement only when settlement was actually allowed.
  const replayPolicy = {
    replay: goalSettlement.allowed ? 'forbidden-already-settled' as const : 'repair-only' as const,
    reason: goalSettlement.allowed ? 'settled after verify' : 'done-requires-check',
  };

  const receiptLines: string[] = [];
  if (verifyOutcome) receiptLines.push(`verify:${verifyOutcome.verified}`);
  if (!goalSettlement.allowed && terminal === 'done') {
    receiptLines.push('settle:denied-needs-check');
  }

  const doneCondition = resolveDoneConditionText({
    ...(params.semanticDone !== undefined ? { semanticDone: params.semanticDone } : {}),
    text:
      params.doneCondition !== undefined
        ? params.doneCondition
        : deps.completionDoneCondition !== undefined
          ? deps.completionDoneCondition
          : null,
  });

  return {
    version: 1,
    id: id.slice(0, 63),
    turnId,
    sessionId,
    createdAt,
    scope: 'code-change',
    terminal,
    objective: (candidate.task || 'turn').slice(0, 120),
    doneCondition,
    output: candidate.content,
    success: terminal === 'done' || terminal === 'answered',
    bestEffort: verification.status !== 'verified' || delivery.status !== 'passed',
    verification,
    deliveryQuality: delivery,
    worktree,
    goalSettlement,
    replayPolicy,
    receipt: { lines: receiptLines },
    upstream: {
      ...(deps.intentVersionId !== undefined ? { intentVersionId: deps.intentVersionId } : {}),
      ...(doneCondition !== null ? { semanticPreflightVersion: 1 as const } : {}),
    },
  };
}


export function buildTerminalCompletionResultV1(params: {
  deps: OrchestrateDeps;
  final: Extract<CoreEvent, { readonly type: 'final' }>;
  task: string;
  terminal: CompletionTerminal;
}): CompletionResultV1 {
  const { deps, final, task, terminal } = params;
  const createdAt = deps.clock.isoNow();
  const needsUser = terminal === 'cancelled' || terminal === 'needs-user';
  const verification: CompletionVerification = {
    status: terminal === 'failed' || terminal === 'blocked' ? 'failing' : 'not-applicable',
    testEvidence: { status: 'not-needed' },
    repair: buildCompletionRepairEvidence(),
    factualClaims: [],
    obligationsSatisfied: needsUser ? ['assistant paused before execution'] : [],
    obligationsUnmet: terminal === 'needs-user'
      ? ['waiting for user answer']
      : terminal === 'failed' || terminal === 'blocked'
        ? ['turn did not reach a provider']
        : [],
    ruleCodes: terminal === 'cancelled' ? ['cancelled'] : ['not-applicable'],
  };
  const delivery = evaluateDeliveryQualitySkeleton(final.output, verification);
  // Terminal path never reaches verify — done=check demotes unearned `done` to
  // `answered` and always forbids goal settlement.
  const honestTerminal: CompletionTerminal =
    terminal === 'done' ? 'answered' : terminal;
  const doneCondition = resolveDoneConditionText({
    text: deps.completionDoneCondition !== undefined ? deps.completionDoneCondition : null,
  });
  return {
    version: 1,
    id: `cr-${deps.session.id.slice(0, 20)}-terminal-${final.attempts}`.slice(0, 63),
    turnId: deps.session.id,
    sessionId: deps.session.id,
    createdAt,
    scope: 'conversation',
    terminal: honestTerminal,
    objective: task.slice(0, 120),
    doneCondition,
    output: final.output,
    // After demotion, `done` is never honest on this path — only `answered` may succeed.
    success: honestTerminal === 'answered' ? final.success : false,
    bestEffort: true,
    verification,
    deliveryQuality: delivery,
    worktree: {
      baseline: 'unknown',
      baselineEntries: [],
      changedByAssistant: [],
      excludedPreExisting: [],
      concurrentUserEdits: [],
      conflictPaths: [],
    },
    goalSettlement: {
      allowed: false,
      state: needsUser ? 'needs-user' : 'none',
      reason: terminal === 'done' ? 'done-requires-check' : terminal,
    },
    replayPolicy: {
      replay: needsUser ? 'needs-user' : 'unknown',
      reason: terminal === 'cancelled'
        ? 'user cancelled before settlement'
        : terminal === 'needs-user'
          ? 'waiting for user answer before execution'
          : terminal === 'done'
            ? 'done-requires-check: terminal path has no verify evidence'
            : 'terminal path did not reach provider execution',
    },
    receipt: { lines: [] },
    upstream: {
      ...(deps.intentVersionId !== undefined ? { intentVersionId: deps.intentVersionId } : {}),
      ...(doneCondition !== null ? { semanticPreflightVersion: 1 as const } : {}),
    },
  };
}

export function attachTerminalCompletionIfFlag(params: {
  deps: OrchestrateDeps;
  final: Extract<CoreEvent, { readonly type: 'final' }>;
  task: string;
  terminal: CompletionTerminal;
}): Extract<CoreEvent, { readonly type: 'final' }> {
  const { deps, final } = params;
  if (deps.completionResultV1 !== true) return final;
  return { ...final, completionResult: buildTerminalCompletionResultV1(params) };
}
export function attachCompletionIfFlag(
  deps: OrchestrateDeps,
  f: Extract<CoreEvent, { readonly type: 'final' }>,
  candidate: CandidateResult,
  verifyOutcome?: VerifyOutcome,
): Extract<CoreEvent, { readonly type: 'final' }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = finalizeAcceptTurn({ deps, final: f, candidate, verifyOutcome } as any);
  return res.final;
}
