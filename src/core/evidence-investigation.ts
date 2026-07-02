import {
  isInvestigable,
  needsContext,
  needsExternal,
  type EngagementSignals,
} from './engagement.js';
import {
  semanticToIntentFrame,
  type EvidenceKind,
  type EvidenceNeed,
  type SemanticPreflightV1,
} from './semantic-preflight.js';

export interface EvidenceCapabilities {
  readonly repoPresent: boolean;
  readonly localReadAvailable: boolean;
  readonly webSearchAvailable: boolean;
}

export interface EvidenceObservation {
  readonly needId: string;
  readonly kind: EvidenceKind;
  readonly status: 'obtained' | 'missing' | 'failed' | 'cancelled';
}

export interface EvidenceDecision {
  readonly beforeWork: 'none' | 'local' | 'web' | 'user-input' | 'cannot-ground';
  readonly beforeCompletion: readonly EvidenceNeed[];
  readonly mayStartWork: boolean;
  readonly reasons: readonly string[];
}

const DET_LOCAL: EvidenceNeed = {
  id: 'DET_LOCAL',
  kind: 'local-code',
  phase: 'before-execution',
  query: 'Read the relevant local code before making or claiming existing-code facts.',
  required: true,
};

const DET_WEB: EvidenceNeed = {
  id: 'DET_WEB',
  kind: 'external-source',
  phase: 'before-answer',
  query: 'Look up the requested current external facts before answering.',
  required: true,
};

const CHEAP_COMPLETION_KINDS: ReadonlySet<EvidenceKind> = new Set([
  'command-output',
  'test-result',
  'local-code',
]);

function isPreWorkNeed(need: EvidenceNeed): boolean {
  return need.required && (need.phase === 'before-answer' || need.phase === 'before-execution');
}

function isSatisfied(
  need: EvidenceNeed,
  observations: readonly EvidenceObservation[],
): boolean {
  for (const observation of observations) {
    if (
      observation.status === 'obtained' &&
      observation.needId === need.id &&
      observation.kind === need.kind
    ) {
      return true;
    }
  }
  return false;
}

function decision(
  beforeWork: EvidenceDecision['beforeWork'],
  mayStartWork: boolean,
  beforeCompletion: readonly EvidenceNeed[],
  reasons: readonly string[],
): EvidenceDecision {
  return { beforeWork, beforeCompletion, mayStartWork, reasons };
}

function signalsFor(task: string, semantic: SemanticPreflightV1): EngagementSignals {
  return {
    frame: semanticToIntentFrame(semantic),
    classification: {
      tier: semantic.route.tier,
      risk: semantic.risk.level,
      rationale: semantic.route.rationale,
    },
    routePlan: semantic.route.plan,
    engagementBias: 0,
    task,
  };
}

function hasCodebaseFloor(
  task: string,
  semantic: SemanticPreflightV1,
  capabilities: EvidenceCapabilities,
): boolean {
  if (!capabilities.repoPresent) return false;
  const codeClaimOrChange =
    semantic.taskShape.mutatesWorkspace ||
    semantic.taskShape.kind === 'change' ||
    semantic.taskShape.kind === 'analysis';
  if (!codeClaimOrChange) return false;
  const signals = signalsFor(task, semantic);
  return needsContext(signals) > 0 || isInvestigable(signals);
}

function hasExternalFloor(task: string, semantic: SemanticPreflightV1): boolean {
  return needsExternal(signalsFor(task, semantic)) > 0;
}

function addNeedOnce(needs: EvidenceNeed[], need: EvidenceNeed): void {
  if (!needs.some((n) => n.id === need.id)) needs.push(need);
}

function allRequiredPreWorkNeeds(
  task: string,
  semantic: SemanticPreflightV1,
  capabilities: EvidenceCapabilities,
): readonly EvidenceNeed[] {
  const needs = semantic.evidenceNeeded.filter(isPreWorkNeed);
  const out = [...needs];
  if (hasCodebaseFloor(task, semantic, capabilities)) addNeedOnce(out, DET_LOCAL);
  if (hasExternalFloor(task, semantic)) addNeedOnce(out, DET_WEB);
  return out;
}

function explicitRequiredPreWorkNeeds(semantic: SemanticPreflightV1): readonly EvidenceNeed[] {
  return semantic.evidenceNeeded.filter(isPreWorkNeed);
}

function beforeCompletionNeeds(semantic: SemanticPreflightV1): readonly EvidenceNeed[] {
  return semantic.evidenceNeeded.filter((need) => need.phase === 'before-completion');
}

function hasRequiredCheapCompletionNeed(needs: readonly EvidenceNeed[]): boolean {
  return needs.some((need) => need.required && CHEAP_COMPLETION_KINDS.has(need.kind));
}

function hasObtainedPreWorkEvidence(
  needs: readonly EvidenceNeed[],
  observations: readonly EvidenceObservation[],
): boolean {
  return needs.some(
    (need) =>
      (need.kind === 'local-code' || need.kind === 'external-source' || need.kind === 'user-input') &&
      isSatisfied(need, observations),
  );
}

function firstUnsatisfied(
  needs: readonly EvidenceNeed[],
  kind: EvidenceKind,
  observations: readonly EvidenceObservation[],
): EvidenceNeed | undefined {
  return needs.find((need) => need.kind === kind && !isSatisfied(need, observations));
}

function missingPreWorkDecision(
  need: EvidenceNeed,
  capabilities: EvidenceCapabilities,
  beforeCompletion: readonly EvidenceNeed[],
): EvidenceDecision {
  if (need.kind === 'user-input') {
    return decision('user-input', false, beforeCompletion, [
      `Required user input ${need.id} must be observed before work starts.`,
    ]);
  }
  if (need.kind === 'external-source') {
    if (capabilities.webSearchAvailable) {
      return decision('web', false, beforeCompletion, [
        `Required external evidence ${need.id} must be obtained before work starts.`,
      ]);
    }
    return decision('cannot-ground', false, beforeCompletion, [
      `Required external evidence ${need.id} cannot be obtained without web search.`,
    ]);
  }
  if (need.kind === 'local-code') {
    if (capabilities.repoPresent && capabilities.localReadAvailable) {
      return decision('local', false, beforeCompletion, [
        `Required local evidence ${need.id} must be obtained before work starts.`,
      ]);
    }
    return decision('cannot-ground', false, beforeCompletion, [
      `Required local evidence ${need.id} cannot be obtained without repo/read capability.`,
    ]);
  }
  return decision('cannot-ground', false, beforeCompletion, [
    `Required pre-work evidence ${need.id} has no collector in this policy.`,
  ]);
}

export function decideEvidenceInvestigation(
  task: string,
  semantic: SemanticPreflightV1,
  capabilities: EvidenceCapabilities,
  observations: readonly EvidenceObservation[] = [],
): EvidenceDecision {
  const completion = beforeCompletionNeeds(semantic);

  const explicitPreWork = explicitRequiredPreWorkNeeds(semantic);
  for (const kind of ['user-input', 'external-source', 'local-code'] as const) {
    const missing = firstUnsatisfied(explicitPreWork, kind, observations);
    if (missing !== undefined) return missingPreWorkDecision(missing, capabilities, completion);
  }

  const allPreWork = allRequiredPreWorkNeeds(task, semantic, capabilities);
  for (const kind of ['user-input', 'external-source', 'local-code'] as const) {
    const missing = firstUnsatisfied(allPreWork, kind, observations);
    if (missing !== undefined) return missingPreWorkDecision(missing, capabilities, completion);
  }

  const obtainedPreWork = hasObtainedPreWorkEvidence(allPreWork, observations);
  if (semantic.uncertainty.level === 'high') {
    if (obtainedPreWork) {
      return decision('none', true, completion, [
        'High uncertainty is allowed only because required pre-work evidence was obtained.',
      ]);
    }
    return decision('cannot-ground', false, completion, [
      'High uncertainty cannot start without an obtained required pre-work observation.',
    ]);
  }

  if (semantic.uncertainty.level === 'medium') {
    if (obtainedPreWork || hasRequiredCheapCompletionNeed(completion)) {
      return decision('none', true, completion, [
        obtainedPreWork
          ? 'Medium uncertainty is grounded by obtained pre-work evidence.'
          : 'Medium uncertainty is allowed with a required cheap before-completion obligation.',
      ]);
    }
    return decision('cannot-ground', false, completion, [
      'Medium uncertainty cannot start without obtained pre-work evidence or a required cheap completion obligation.',
    ]);
  }

  return decision('none', true, completion, [
    allPreWork.length > 0
      ? 'Required pre-work evidence has been satisfied.'
      : 'Low uncertainty has no required pre-work evidence.',
  ]);
}
