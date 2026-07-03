/**
 * src/core/aux-ledger.ts — record auxiliary model calls in the ledger.
 *
 * One pure helper shared by route-classifier, intent-extractor, recap-generator,
 * understanding-generator, and goal-plan-generator. Account aux is always on;
 * it stamps a ledger entry with the auxiliary `stage` and optional
 * `intentVersionId`.
 *
 * Cost discipline: uses `calculateEffectiveCost` with cacheAccountingV2
 * always active; otherwise `calculateCost`. Falls back to a local price-lookup
 * estimate when `providerCostUsd` is absent.
 */

import type { LedgerStage, LedgerWriter, Tier } from './types.js';
import type { Clock } from './types.js';
import type { ProviderId, Usage } from '../providers/port.js';
import { getModelPricing, calculateCost, calculateEffectiveCost } from '../infra/pricing.js';

export interface RecordAuxLedgerInput {
  readonly enabled: boolean;
  readonly ledger: LedgerWriter | undefined;
  readonly clock: Clock | undefined;
  readonly sessionId: string | undefined;
  readonly cacheAccountingV2: boolean | undefined;
  readonly intentVersionId?: string | undefined;
  readonly stage: LedgerStage;
  readonly provider: ProviderId;
  readonly model: string;
  readonly tier: Tier;
  readonly usage: Usage | undefined;
  readonly providerCostUsd: number | undefined;
  readonly durationMs: number;
  readonly success: boolean;
}

export async function recordAuxLedger(input: RecordAuxLedgerInput): Promise<void> {
  const { enabled } = input;
  if (enabled !== true) return;
  const { ledger, clock, sessionId } = input;
  if (ledger === undefined || clock === undefined || sessionId === undefined) return;

  let usd = input.providerCostUsd;
  if (usd === undefined) {
    const pricing = getModelPricing(input.provider, input.model);
    if (pricing !== undefined && input.usage !== undefined) {
      usd =
        input.cacheAccountingV2 === true
          ? calculateEffectiveCost(
              input.usage.inputTokens,
              input.usage.outputTokens,
              pricing,
              {
                cachedInputTokens: input.usage.cachedInputTokens,
                cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
              },
            )
          : calculateCost(
              input.usage.inputTokens,
              input.usage.outputTokens,
              pricing,
            );
    } else {
      usd = 0;
    }
  }

  await ledger.record({
    timestamp: clock.isoNow(),
    sessionId,
    taskId: clock.uuid(),
    provider: input.provider,
    model: input.model,
    tier: input.tier,
    inputTokens: input.usage?.inputTokens ?? 0,
    outputTokens: input.usage?.outputTokens ?? 0,
    cachedInputTokens: input.usage?.cachedInputTokens ?? 0,
    ...(input.cacheAccountingV2 === true && input.usage?.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: input.usage.cacheWriteInputTokens }
      : {}),
    usd,
    durationMs: input.durationMs,
    success: input.success,
    stage: input.stage,
    ...(input.intentVersionId !== undefined
      ? { intentVersionId: input.intentVersionId }
      : {}),
  });
}
