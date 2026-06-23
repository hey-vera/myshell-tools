import type { CommandTier } from './types.js';

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
