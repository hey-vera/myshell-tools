import type { CommandTier } from './types.js';
import type { VerifyOutcome } from './verify.js';

export type ProviderMode = 'zero' | 'solo' | 'multi';

export type ConfidenceLabel =
  | 'not-verified'
  | 'plausible'
  | 'reviewed'
  | 'verified-by-tests'
  | 'verified-by-tests-and-independent-review';

export interface EvidenceSnapshotV1 {
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

export type EvidenceSnapshot = EvidenceSnapshotV1;

export interface EvidenceFileWriteV2 {
  readonly path: string;
  readonly hashBefore?: string;
  readonly hashAfter?: string;
}

export interface EvidenceSnapshotV2 {
  readonly version: 2;
  readonly taskId: string;
  readonly turnNumber: number;
  readonly filesReadPre?: readonly { readonly path: string; readonly hash: string }[];
  readonly filesWritten: readonly EvidenceFileWriteV2[];
  readonly commandsRun: EvidenceSnapshotV1['commandsRun'];
  readonly conclusionsReached: readonly string[];
  readonly confidenceLabel: ConfidenceLabel;
  readonly providerMode: ProviderMode;
  readonly providersAttempted?: readonly string[];
  readonly providersSucceeded: readonly string[];
  readonly providersFailed?: EvidenceSnapshotV1['providersFailed'];
  readonly timestamp: number;
}

export type EvidenceRecord = EvidenceSnapshotV1 | EvidenceSnapshotV2;

export interface BuildSnapshotFromVerifyInput {
  readonly taskId: string;
  readonly turnNumber: number;
  readonly verifyOutcome: VerifyOutcome;
  readonly providerMode?: EvidenceSnapshotV1['providerMode'];
  readonly providersAttempted?: readonly string[];
  readonly providersSucceeded: readonly string[];
  readonly providersFailed?: EvidenceSnapshotV1['providersFailed'];
  readonly filesWritten: readonly EvidenceFileWriteV2[];
  readonly commandsRun: EvidenceSnapshotV1['commandsRun'];
  readonly conclusionsReached: readonly string[];
  readonly filesReadPre?: EvidenceSnapshotV1['filesReadPre'];
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
  for (const provider of input.providersAttempted ?? []) providers.add(provider);
  for (const provider of input.providersSucceeded) providers.add(provider);
  for (const failure of input.providersFailed ?? []) providers.add(failure.provider);
  if (input.verifyOutcome.critic?.vendor !== undefined) {
    providers.add(input.verifyOutcome.critic.vendor);
  }
  return providers;
}

function deriveProviderMode(input: BuildSnapshotFromVerifyInput): EvidenceSnapshotV1['providerMode'] {
  const providers = providerSet(input);
  if (providers.size === 0) return 'zero';
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

/**
 * Map a verify outcome to the canonical 5-label {@link ConfidenceLabel} vocabulary.
 * Mirrors the solo/multi cap discipline used for {@link EvidenceSnapshot} so the
 * trust receipt and the evidence store speak the same tier language.
 */
export function deriveConfidenceLabel(
  outcome: VerifyOutcome,
  providerMode: EvidenceSnapshotV1['providerMode'],
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

export function buildSnapshotFromVerify(input: BuildSnapshotFromVerifyInput): EvidenceSnapshotV2 {
  const providerMode = deriveProviderMode(input);
  const providers = providerSet(input);
  const snapshot: EvidenceSnapshotV2 = {
    version: 2 as const,
    taskId: input.taskId,
    turnNumber: input.turnNumber,
    filesWritten: freezeArray(input.filesWritten) as readonly EvidenceFileWriteV2[],
    commandsRun: freezeArray(input.commandsRun),
    conclusionsReached: freezeArray(input.conclusionsReached),
    confidenceLabel: deriveConfidenceLabel(input.verifyOutcome, providerMode, providers.size),
    providerMode,
    providersSucceeded: freezeArray(input.providersSucceeded),
    timestamp: input.timestamp ?? 0,
    ...(input.filesReadPre !== undefined && input.filesReadPre.length > 0 ? { filesReadPre: freezeArray(input.filesReadPre) } : {}),
    ...(input.providersAttempted !== undefined && input.providersAttempted.length > 0 ? { providersAttempted: freezeArray(input.providersAttempted) } : {}),
    ...(input.providersFailed !== undefined && input.providersFailed.length > 0 ? { providersFailed: freezeArray(input.providersFailed) } : {}),
  };
  return Object.freeze(snapshot) as EvidenceSnapshotV2;
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

function commandsRun(value: unknown): EvidenceSnapshotV1['commandsRun'] | null {
  if (!Array.isArray(value)) return null;
  const out: EvidenceSnapshotV1['commandsRun'][number][] = [];
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

function providerFailures(value: unknown): EvidenceSnapshotV1['providersFailed'] | null {
  if (!Array.isArray(value)) return null;
  const out: EvidenceSnapshotV1['providersFailed'][number][] = [];
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

export function normalizeEvidenceSnapshotV1(raw: unknown): EvidenceSnapshotV1 | null {
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

function readFilesV2(
  value: unknown,
): readonly { readonly path: string; readonly hash: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { readonly path: string; readonly hash: string }[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['path'] !== 'string' ||
      typeof item['hash'] !== 'string' ||
      item['hash'] === ''
    ) {
      return null;
    }
    out.push({ path: item['path'], hash: item['hash'] });
  }
  return out;
}

function writtenFilesV2(value: unknown): readonly EvidenceFileWriteV2[] | null {
  if (!Array.isArray(value)) return null;
  const out: EvidenceFileWriteV2[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['path'] !== 'string') return null;
    const hasBefore = 'hashBefore' in item;
    const hashBefore = item['hashBefore'];
    if (hasBefore && (typeof hashBefore !== 'string' || hashBefore === '')) return null;
    const hasAfter = 'hashAfter' in item;
    const hashAfter = item['hashAfter'];
    if (hasAfter && (typeof hashAfter !== 'string' || hashAfter === '')) return null;
    if (hasBefore && hasAfter) {
      out.push({ path: item['path'], hashBefore: hashBefore as string, hashAfter: hashAfter as string });
    } else if (hasBefore) {
      out.push({ path: item['path'], hashBefore: hashBefore as string });
    } else if (hasAfter) {
      out.push({ path: item['path'], hashAfter: hashAfter as string });
    } else {
      out.push({ path: item['path'] });
    }
  }
  return out;
}

function optionalReadFilesV2(
  raw: Record<string, unknown>,
): readonly { readonly path: string; readonly hash: string }[] | null | undefined {
  if (!('filesReadPre' in raw)) return undefined;
  return readFilesV2(raw['filesReadPre']);
}

function optionalStringArray(raw: Record<string, unknown>, key: string): readonly string[] | null | undefined {
  if (!(key in raw)) return undefined;
  return stringArray(raw[key]);
}

function optionalProviderFailures(raw: Record<string, unknown>): EvidenceSnapshotV1['providersFailed'] | null | undefined {
  if (!('providersFailed' in raw)) return undefined;
  return providerFailures(raw['providersFailed']);
}

export function normalizeEvidenceSnapshotV2(raw: unknown): EvidenceSnapshotV2 | null {
  if (!isRecord(raw)) return null;
  if (raw['version'] !== 2) return null;

  const filesReadPre = optionalReadFilesV2(raw);
  const filesWritten = writtenFilesV2(raw['filesWritten']);
  const parsedCommandsRun = commandsRun(raw['commandsRun']);
  const conclusionsReached = stringArray(raw['conclusionsReached']);
  const providersAttempted = optionalStringArray(raw, 'providersAttempted');
  const providersSucceeded = stringArray(raw['providersSucceeded']);
  const providersFailed = optionalProviderFailures(raw);

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

  const snapshot: EvidenceSnapshotV2 = {
    version: 2,
    taskId: raw['taskId'],
    turnNumber: raw['turnNumber'],
    ...(filesReadPre !== undefined ? { filesReadPre } : {}),
    filesWritten,
    commandsRun: parsedCommandsRun,
    conclusionsReached,
    confidenceLabel: raw['confidenceLabel'],
    providerMode: raw['providerMode'],
    ...(providersAttempted !== undefined ? { providersAttempted } : {}),
    providersSucceeded,
    ...(providersFailed !== undefined ? { providersFailed } : {}),
    timestamp: raw['timestamp'],
  };
  return snapshot;
}

export function normalizeEvidenceSnapshot(raw: unknown): EvidenceRecord | null {
  if (!isRecord(raw)) return null;
  if (raw['version'] === 2) {
    return normalizeEvidenceSnapshotV2(raw);
  }
  return normalizeEvidenceSnapshotV1(raw);
}
