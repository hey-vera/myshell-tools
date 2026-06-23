import type { CommandTier } from './types.js';
import type { VerifyOutcome } from './verify.js';

export type ConfidenceLabel =
  | 'not-verified'
  | 'plausible'
  | 'reviewed'
  | 'verified-by-tests'
  | 'verified-by-tests-and-independent-review';

export interface EvidenceSnapshot {
  readonly taskId: string;
  readonly turnNumber: number;
  readonly filesReadPre: readonly { readonly path: string; readonly hash: string }[];
  readonly filesWritten: readonly {
    readonly path: string;
    readonly hashBefore: string;
    readonly hashAfter: string;
  }[];
  readonly commandsRun: readonly {
    readonly command: string;
    readonly tier: CommandTier;
    readonly confirmed: boolean;
    readonly outcome: 'success' | 'skipped' | 'failed';
  }[];
  readonly conclusionsReached: readonly string[];
  readonly confidenceLabel: ConfidenceLabel;
  readonly providerMode: 'zero' | 'solo' | 'multi';
  readonly providersAttempted: readonly string[];
  readonly providersSucceeded: readonly string[];
  readonly providersFailed: readonly { readonly provider: string; readonly reason: string }[];
  readonly timestamp: number;
}

export interface BuildSnapshotFromVerifyInput {
  readonly taskId: string;
  readonly turnNumber: number;
  readonly verifyOutcome: VerifyOutcome;
  readonly providerMode?: EvidenceSnapshot['providerMode'];
  readonly providersAttempted: readonly string[];
  readonly providersSucceeded: readonly string[];
  readonly providersFailed: EvidenceSnapshot['providersFailed'];
  readonly filesWritten: EvidenceSnapshot['filesWritten'];
  readonly commandsRun: EvidenceSnapshot['commandsRun'];
  readonly conclusionsReached: readonly string[];
  readonly filesReadPre?: EvidenceSnapshot['filesReadPre'];
  readonly timestamp?: number;
}

const COMMAND_TIERS = [
  'read-only',
  'test-build',
  'local-write',
  'dependency-install',
  'destructive-filesystem',
  'credential-sensitive',
] as const satisfies readonly CommandTier[];

const COMMAND_OUTCOMES = ['success', 'skipped', 'failed'] as const;
const CONFIDENCE_LABELS = [
  'not-verified',
  'plausible',
  'reviewed',
  'verified-by-tests',
  'verified-by-tests-and-independent-review',
] as const satisfies readonly ConfidenceLabel[];
const PROVIDER_MODES = ['zero', 'solo', 'multi'] as const;

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function providerSet(input: BuildSnapshotFromVerifyInput): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const provider of input.providersAttempted) providers.add(provider);
  for (const provider of input.providersSucceeded) providers.add(provider);
  for (const failure of input.providersFailed) providers.add(failure.provider);
  if (input.verifyOutcome.critic?.vendor !== undefined) {
    providers.add(input.verifyOutcome.critic.vendor);
  }
  return providers;
}

function deriveProviderMode(input: BuildSnapshotFromVerifyInput): EvidenceSnapshot['providerMode'] {
  const providers = providerSet(input);
  if (input.providerMode === 'zero' || providers.size === 0) return 'zero';
  if (
    input.providerMode === 'solo' ||
    providers.size <= 1 ||
    input.verifyOutcome.critic?.sameVendor === true
  ) {
    return 'solo';
  }
  if (input.verifyOutcome.critic?.sameVendor === false) return 'multi';
  return input.providerMode ?? 'multi';
}

function deriveConfidenceLabel(
  outcome: VerifyOutcome,
  providerMode: EvidenceSnapshot['providerMode'],
  providerCount: number,
): ConfidenceLabel {
  const critic = outcome.critic;
  const independentApprove =
    critic?.parsed === true && critic.verdict === 'approve' && critic.sameVendor === false;
  const base: ConfidenceLabel =
    outcome.verified === 'passing' && independentApprove
      ? 'verified-by-tests-and-independent-review'
      : outcome.verified === 'passing'
        ? 'verified-by-tests'
        : outcome.verified === 'reviewed'
          ? 'reviewed'
          : 'not-verified';

  // SOLO CAP: with a solo provider set (or same-vendor critic), the snapshot must
  // never claim an independent review. Cap any stronger confidence at "reviewed";
  // tests may still be visible in commandsRun, but the headline confidence stays
  // honest about the review topology.
  const soloCapped =
    providerMode === 'solo' || providerCount <= 1 || critic?.sameVendor === true;
  if (
    soloCapped &&
    (base === 'verified-by-tests' || base === 'verified-by-tests-and-independent-review')
  ) {
    return 'reviewed';
  }
  return base;
}

export function buildSnapshotFromVerify(input: BuildSnapshotFromVerifyInput): EvidenceSnapshot {
  const providerMode = deriveProviderMode(input);
  const providers = providerSet(input);
  const snapshot: EvidenceSnapshot = {
    taskId: input.taskId,
    turnNumber: input.turnNumber,
    filesReadPre: freezeArray(input.filesReadPre ?? []),
    filesWritten: freezeArray(input.filesWritten),
    commandsRun: freezeArray(input.commandsRun),
    conclusionsReached: freezeArray(input.conclusionsReached),
    confidenceLabel: deriveConfidenceLabel(input.verifyOutcome, providerMode, providers.size),
    providerMode,
    providersAttempted: freezeArray(input.providersAttempted),
    providersSucceeded: freezeArray(input.providersSucceeded),
    providersFailed: freezeArray(input.providersFailed),
    timestamp: input.timestamp ?? 0,
  };
  return Object.freeze(snapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function readFiles(
  value: unknown,
): readonly { readonly path: string; readonly hash: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { readonly path: string; readonly hash: string }[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['path'] !== 'string' || typeof item['hash'] !== 'string') {
      return null;
    }
    out.push({ path: item['path'], hash: item['hash'] });
  }
  return out;
}

function writtenFiles(
  value: unknown,
): readonly {
  readonly path: string;
  readonly hashBefore: string;
  readonly hashAfter: string;
}[] | null {
  if (!Array.isArray(value)) return null;
  const out: { readonly path: string; readonly hashBefore: string; readonly hashAfter: string }[] =
    [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['path'] !== 'string' ||
      typeof item['hashBefore'] !== 'string' ||
      typeof item['hashAfter'] !== 'string'
    ) {
      return null;
    }
    out.push({
      path: item['path'],
      hashBefore: item['hashBefore'],
      hashAfter: item['hashAfter'],
    });
  }
  return out;
}

function commandsRun(value: unknown): EvidenceSnapshot['commandsRun'] | null {
  if (!Array.isArray(value)) return null;
  const out: EvidenceSnapshot['commandsRun'][number][] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['command'] !== 'string' ||
      !oneOf(item['tier'], COMMAND_TIERS) ||
      typeof item['confirmed'] !== 'boolean' ||
      !oneOf(item['outcome'], COMMAND_OUTCOMES)
    ) {
      return null;
    }
    out.push({
      command: item['command'],
      tier: item['tier'],
      confirmed: item['confirmed'],
      outcome: item['outcome'],
    });
  }
  return out;
}

function providerFailures(value: unknown): EvidenceSnapshot['providersFailed'] | null {
  if (!Array.isArray(value)) return null;
  const out: EvidenceSnapshot['providersFailed'][number][] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['provider'] !== 'string' ||
      typeof item['reason'] !== 'string'
    ) {
      return null;
    }
    out.push({ provider: item['provider'], reason: item['reason'] });
  }
  return out;
}

export function normalizeEvidenceSnapshot(raw: unknown): EvidenceSnapshot | null {
  if (!isRecord(raw)) return null;

  const filesReadPre = readFiles(raw['filesReadPre']);
  const filesWritten = writtenFiles(raw['filesWritten']);
  const parsedCommandsRun = commandsRun(raw['commandsRun']);
  const conclusionsReached = stringArray(raw['conclusionsReached']);
  const providersAttempted = stringArray(raw['providersAttempted']);
  const providersSucceeded = stringArray(raw['providersSucceeded']);
  const providersFailed = providerFailures(raw['providersFailed']);

  if (
    typeof raw['taskId'] !== 'string' ||
    !isFiniteNumber(raw['turnNumber']) ||
    filesReadPre === null ||
    filesWritten === null ||
    parsedCommandsRun === null ||
    conclusionsReached === null ||
    !oneOf(raw['confidenceLabel'], CONFIDENCE_LABELS) ||
    !oneOf(raw['providerMode'], PROVIDER_MODES) ||
    providersAttempted === null ||
    providersSucceeded === null ||
    providersFailed === null ||
    !isFiniteNumber(raw['timestamp'])
  ) {
    return null;
  }

  return {
    taskId: raw['taskId'],
    turnNumber: raw['turnNumber'],
    filesReadPre,
    filesWritten,
    commandsRun: parsedCommandsRun,
    conclusionsReached,
    confidenceLabel: raw['confidenceLabel'],
    providerMode: raw['providerMode'],
    providersAttempted,
    providersSucceeded,
    providersFailed,
    timestamp: raw['timestamp'],
  };
}
