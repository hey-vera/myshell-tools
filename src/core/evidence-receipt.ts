/**
 * src/core/evidence-receipt.ts — pure proof-of-done receipt assembled from
 * EXISTING data, never fabricating a claim. The receipt reports what changed,
 * what verification ran, and whether the result is truly verified or merely
 * answered, plus cost/cache/aux ledger facts from PR1/PR2.
 *
 * PURE: no I/O, no model calls, no side effects. Never throws.
 */

import type { VerifiedState, VerifyOutcome } from './verify.js';
import type { LedgerEntry } from './types.js';
import type { ProviderId } from '../providers/port.js';

export type ReceiptTerminal = 'done' | 'blocked' | 'failed' | 'answered';
export type ReceiptVerdict =
  | 'verified'
  | 'reviewed'
  | 'unverified'
  | 'failing'
  | 'answered';

export interface EvidenceReceiptV2 {
  readonly version: 2;
  readonly terminal: ReceiptTerminal;
  readonly verdict: ReceiptVerdict;
  readonly changedFiles?: readonly string[];
  readonly commandsRun?: readonly {
    readonly command: string;
    readonly outcome: 'success' | 'failed' | 'skipped';
    readonly durationMs?: number;
  }[];
  readonly testsResult?: {
    readonly command: string;
    readonly outcome: 'green' | 'red' | 'timeout' | 'errored';
    readonly durationMs: number;
  };
  readonly verifyVerdict: VerifiedState | 'not-run';
  readonly costUsd: number;
  readonly cacheAdjustedUsd?: number;
  readonly auxCalls?: {
    readonly count: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteInputTokens?: number;
    readonly usd: number;
  };
  readonly intentVersionId?: string;
  readonly turnTokens?: readonly {
    readonly provider: ProviderId;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
  }[];
  readonly cooldownProviders?: readonly {
    readonly provider: ProviderId;
    readonly remainingMs: number;
  }[];
  readonly sessionTokens?: Readonly<Partial<Record<ProviderId, number>>>;
  readonly headroom: 'unknown';
}

export interface BuildEvidenceReceiptInput {
  readonly terminal: ReceiptTerminal;
  readonly success: boolean;
  readonly bestEffort?: true;
  readonly blocked?: import('./blocked.js').BlockedRecord;
  readonly verifyOutcome?: VerifyOutcome;
  readonly totalCostUsd: number;
  readonly cacheAccountingV2?: boolean;
  readonly ledgerEntries: readonly LedgerEntry[];
  readonly intentVersionId?: string;
  readonly cooldownProviders?: readonly {
    readonly provider: ProviderId;
    readonly remainingMs: number;
  }[];
  readonly sessionTokens?: Readonly<Partial<Record<ProviderId, number>>>;
}

function mapVerdict(input: BuildEvidenceReceiptInput): ReceiptVerdict {
  const vo = input.verifyOutcome;
  if (vo === undefined) return 'unverified';
  switch (vo.verified) {
    case 'passing':
      return 'verified';
    case 'reviewed':
      return 'reviewed';
    case 'failing':
      return 'failing';
    case 'unverified':
      return 'unverified';
    default:
      return 'unverified';
  }
}

function mapTerminal(input: BuildEvidenceReceiptInput): ReceiptTerminal {
  if (input.blocked !== undefined) return 'blocked';
  if (!input.success) return 'failed';
  return 'done';
}

export function summarizeReceiptLedger(
  entries: readonly LedgerEntry[],
): EvidenceReceiptV2['cacheAdjustedUsd'] {
  if (entries.length === 0) return undefined;
  let sum = 0;
  for (const e of entries) sum += e.usd;
  return sum;
}

function summarizeAuxCalls(
  entries: readonly LedgerEntry[],
): EvidenceReceiptV2['auxCalls'] {
  const aux = entries.filter(
    (e) => e.stage !== undefined && e.stage !== 'work',
  );
  if (aux.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let usd = 0;
  for (const e of aux) {
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cachedInputTokens += e.cachedInputTokens;
    if (typeof e.cacheWriteInputTokens === 'number') {
      cacheWriteInputTokens += e.cacheWriteInputTokens;
    }
    usd += e.usd;
  }
  const result: EvidenceReceiptV2['auxCalls'] = {
    count: aux.length,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    usd,
    ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}),
  };
  return result;
}

function summarizeTurnTokens(
  entries: readonly LedgerEntry[],
): EvidenceReceiptV2['turnTokens'] {
  if (entries.length === 0) return undefined;
  const groups = new Map<string, {
    provider: ProviderId;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  }>();
  for (const e of entries) {
    const key = `${e.provider}\x00${e.model}`;
    let g = groups.get(key);
    if (!g) {
      g = { provider: e.provider, model: e.model, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      groups.set(key, g);
    }
    g.inputTokens += e.inputTokens;
    g.outputTokens += e.outputTokens;
    g.cachedInputTokens += e.cachedInputTokens;
  }
  return [...groups.values()];
}

export function buildEvidenceReceipt(
  input: BuildEvidenceReceiptInput,
): EvidenceReceiptV2 | undefined {
  const version = 2 as const;
  const terminal = mapTerminal(input);
  const verdict = mapVerdict(input);
  const verifyVerdict = input.verifyOutcome?.verified ?? ('not-run' as const);
  const costUsd = input.totalCostUsd;
  const headroom = 'unknown' as const;

  const vo = input.verifyOutcome;

  let changedFiles: readonly string[] | undefined;
  if (vo !== undefined && vo.changedPaths !== undefined && vo.changedPaths.length > 0) {
    changedFiles = [...vo.changedPaths];
  }

  let commandsRun: EvidenceReceiptV2['commandsRun'] | undefined;
  let testsResult: EvidenceReceiptV2['testsResult'] | undefined;
  if (vo !== undefined && vo.testCommand !== undefined) {
    if (vo.testRun !== undefined) {
      commandsRun = [{
        command: vo.testCommand,
        outcome: vo.testRun.outcome === 'green'
          ? ('success' as const)
          : vo.testRun.outcome === 'red'
            ? ('failed' as const)
            : ('skipped' as const),
        durationMs: vo.testRun.durationMs,
      }];
      testsResult = {
        command: vo.testCommand,
        outcome: vo.testRun.outcome,
        durationMs: vo.testRun.durationMs,
      };
    } else {
      commandsRun = [{ command: vo.testCommand, outcome: 'skipped' as const }];
    }
  }

  let cacheAdjustedUsd: number | undefined;
  if (input.cacheAccountingV2 === true) {
    const adjusted = summarizeReceiptLedger(input.ledgerEntries);
    if (adjusted !== undefined) {
      cacheAdjustedUsd = adjusted;
    }
  }

  const auxCalls = summarizeAuxCalls(input.ledgerEntries);

  const intentVersionId = input.intentVersionId;

  const turnTokens = summarizeTurnTokens(input.ledgerEntries);

  return {
    version,
    terminal,
    verdict,
    ...(changedFiles !== undefined ? { changedFiles } : {}),
    ...(commandsRun !== undefined ? { commandsRun } : {}),
    ...(testsResult !== undefined ? { testsResult } : {}),
    verifyVerdict,
    costUsd,
    ...(cacheAdjustedUsd !== undefined ? { cacheAdjustedUsd } : {}),
    ...(auxCalls !== undefined ? { auxCalls } : {}),
    ...(intentVersionId !== undefined ? { intentVersionId } : {}),
    ...(turnTokens !== undefined ? { turnTokens } : {}),
    ...(input.cooldownProviders !== undefined ? { cooldownProviders: input.cooldownProviders } : {}),
    ...(input.sessionTokens !== undefined ? { sessionTokens: input.sessionTokens } : {}),
    headroom,
  };
}
