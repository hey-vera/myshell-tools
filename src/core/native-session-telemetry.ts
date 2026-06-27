/**
 * src/core/native-session-telemetry.ts — pure measurement for native session
 * promotion. Records structured telemetry when resumed same-provider runs skip
 * history replay, so the user can see the token savings.
 *
 * PURE: no I/O, no model calls, no side effects.
 */

import type { ProviderId, Usage } from '../providers/port.js';
import { estimateInputTokens } from './orchestrate-signals.js';
import type { NativeSessionPlan } from './native-session.js';

export interface NativeSessionTelemetry {
  readonly provider: ProviderId;
  readonly sessionId: string;
  readonly resume: boolean;
  readonly usedNative: boolean;
  readonly fallbackReason?: 'disabled' | 'no-plan' | 'provider-mismatch' | 'quarantined';
  readonly historyReplayEstimatedTokens: number;
  readonly actualInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens?: number;
  readonly inputTokenDropVsColdEstimate: number;
}

export interface BuildNativeSessionTelemetryInput {
  readonly provider: ProviderId;
  readonly nativePlan: NativeSessionPlan | undefined;
  readonly useNative: boolean;
  readonly historyContext: string | undefined;
  readonly usage: Usage | undefined;
  readonly fallbackReason?: NativeSessionTelemetry['fallbackReason'];
}

export function buildNativeSessionTelemetry(
  input: BuildNativeSessionTelemetryInput,
): NativeSessionTelemetry | undefined {
  if (input.nativePlan === undefined && input.fallbackReason === undefined) {
    return undefined;
  }

  const usedNative = input.useNative && input.nativePlan !== undefined;

  const historyReplayEstimatedTokens = estimateInputTokens(
    input.historyContext !== undefined ? [input.historyContext] : [],
  );

  const actualInputTokens = input.usage?.inputTokens ?? 0;
  const cachedInputTokens = input.usage?.cachedInputTokens ?? 0;

  const inputTokenDropVsColdEstimate = usedNative
    ? historyReplayEstimatedTokens
    : 0;

  const fallbackReason = input.fallbackReason;

  const hasCacheWrite = input.usage?.cacheWriteInputTokens !== undefined &&
    input.usage.cacheWriteInputTokens > 0;
  const cacheWriteInputTokens = hasCacheWrite
    ? input.usage!.cacheWriteInputTokens
    : undefined;

  return {
    provider: input.provider,
    sessionId: input.nativePlan?.sessionId ?? '',
    resume: input.nativePlan?.resume ?? false,
    usedNative,
    historyReplayEstimatedTokens,
    actualInputTokens,
    cachedInputTokens,
    inputTokenDropVsColdEstimate,
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };
}

export function renderNativeSessionTelemetry(
  sample: NativeSessionTelemetry,
): string {
  const parts: string[] = [];
  parts.push(`Native session: ${sample.provider}`);

  if (sample.usedNative && sample.resume) {
    parts.push('resumed');
    if (sample.inputTokenDropVsColdEstimate > 0) {
      parts.push(
        `saved ~${sample.inputTokenDropVsColdEstimate} tokens vs cold replay`,
      );
    }
    if (sample.cachedInputTokens > 0) {
      parts.push(`(${sample.cachedInputTokens} cache reads)`);
    }
  } else if (sample.fallbackReason !== undefined) {
    parts.push(`fallback: ${sample.fallbackReason}`);
  }

  return parts.join(' · ');
}
