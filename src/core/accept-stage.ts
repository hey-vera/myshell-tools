import { confidenceLine, type Confidence } from './brain.js';
import { ENGINE_BEHAVIOR_VERSION } from './engine-version.js';
import { memoryProposalFor } from './orchestrate-memory.js';
import type { CoreEvent, OrchestrateDeps, Tier } from './types.js';
import { buildVerifyReceipt, type VerifyLevel, type VerifyOutcome, type VerifyPort } from './verify.js';
import { buildSnapshotFromVerify, type EvidenceSnapshot } from './evidence.js';
import {
  composeTrustReceipt,
  trustReceiptLines,
  isEmptyReceipt,
  type TrustSignals,
} from './trust-receipt.js';
import type { WorkContract } from './work-contract.js';
import type { ProviderId } from '../providers/port.js';

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

async function finalizeAcceptedCandidate(
  deps: OrchestrateDeps,
  candidate: CandidateResult,
): Promise<Extract<CoreEvent, { readonly type: 'final' }>> {
  await appendAcceptedAssistant(deps, candidate);
  const memoryProposal = memoryProposalFor(candidate.content);
  return {
    type: 'final',
    success: true,
    output: candidate.content,
    tier: candidate.tier,
    totalCostUsd: candidate.totalCostUsd,
    sessionId: deps.session.id,
    attempts: candidate.attempts,
    ...(candidate.disposition === 'bestEffort' ? { bestEffort: true } : {}),
    ...(memoryProposal !== undefined ? { memoryProposal } : {}),
  };
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
}): EvidenceSnapshot {
  const providers = new Set<string>(input.availableProviders);
  providers.add(input.provider);
  if (input.verifyOutcome.critic?.vendor !== undefined) {
    providers.add(input.verifyOutcome.critic.vendor);
  }
  const commandsRun: EvidenceSnapshot['commandsRun'] =
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
    providerMode:
      input.availableProviders.length === 0
        ? 'zero'
        : input.availableProviders.length === 1
          ? 'solo'
          : 'multi',
    providersAttempted: [...providers],
    providersSucceeded: [
      input.provider,
      ...(input.verifyOutcome.critic?.vendor !== undefined
        ? [input.verifyOutcome.critic.vendor]
        : []),
    ],
    providersFailed: [],
    filesReadPre: [],
    filesWritten: (input.verifyOutcome.changedPaths ?? []).map((path) => ({
      path,
      hashBefore: '',
      hashAfter: '',
    })),
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
    yield await finalizeAcceptedCandidate(deps, candidate);
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
    yield await finalizeAcceptedCandidate(deps, candidate);
    return finalGate;
  }

  // The candidate FAILED its objective check after a bounded repair — demonstrable
  // repeated failure. DEFAULT: emit the failing final here (byte-identical). When
  // `deferFailingFinal` is set (Layer B), SUPPRESS the final and hand the failing
  // GateResult back so the caller can escalate-and-retry at a higher tier.
  if (!deferFailingFinal) {
    yield {
      type: 'final',
      success: false,
      output: candidate.content,
      tier: candidate.tier,
      totalCostUsd: candidate.totalCostUsd,
      sessionId: deps.session.id,
      attempts: candidate.attempts,
      provider: candidate.provider,
    };
  }
  return finalGate;
}
