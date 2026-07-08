/**
 * Pure subscription pressure model.
 *
 * This intentionally models pressure/consumption provenance, not exact remaining
 * subscription quota. Unless a future provider exposes an official exact field,
 * receipts must say headroom is unknown.
 */

export type PressureSignalKind =
  | 'tokens-used'
  | 'cache-usage'
  | 'rate-limit-hit'
  | 'cooldown-active'
  | 'external-monitor-estimate'
  | 'headroom-unknown';

export type PressureSignalSource =
  | 'myshell-ledger'
  | 'provider-usage'
  | 'transcript'
  | 'otel'
  | 'third-party-monitor'
  | 'custom-hook'
  | 'provider-error'
  | 'myshell-runtime';

export type PressureTrust =
  | 'official-runtime-field'
  | 'official-telemetry-consumption'
  | 'local-transcript-consumption'
  | 'third-party-estimate'
  | 'user-configured-threshold'
  | 'runtime-observed-failure'
  | 'unknown';

export type SubscriptionPressureLevel = 'low' | 'medium' | 'high' | 'cooling' | 'unknown';

export interface PressureSignal {
  readonly kind: PressureSignalKind;
  readonly source: PressureSignalSource;
  readonly trust: PressureTrust;
  readonly provider?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly estimateLevel?: Exclude<SubscriptionPressureLevel, 'cooling' | 'unknown'>;
  readonly cooldownMs?: number;
  readonly note?: string;
}

export interface SubscriptionPressureSummary {
  readonly level: SubscriptionPressureLevel;
  readonly remainingQuotaKnown: false;
  readonly totalTokens: number;
  readonly coolingProviders: readonly string[];
  readonly signals: readonly PressureSignal[];
  readonly receiptLines: readonly string[];
}

function n(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : 0;
}

function signalTokens(signal: PressureSignal): number {
  return n(signal.inputTokens) + n(signal.outputTokens) + n(signal.cacheReadTokens) + n(signal.cacheWriteTokens);
}

function stronger(a: SubscriptionPressureLevel, b: SubscriptionPressureLevel): SubscriptionPressureLevel {
  const rank: Record<SubscriptionPressureLevel, number> = { unknown: 0, low: 1, medium: 2, high: 3, cooling: 4 };
  return rank[b] > rank[a] ? b : a;
}

function tokenLevel(total: number): SubscriptionPressureLevel {
  if (total <= 0) return 'unknown';
  if (total >= 150_000) return 'high';
  if (total >= 50_000) return 'medium';
  return 'low';
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function summarizeSubscriptionPressure(signals: readonly PressureSignal[]): SubscriptionPressureSummary {
  const totalTokens = signals.reduce((sum, signal) => sum + signalTokens(signal), 0);
  const coolingProviders = [...new Set(signals
    .filter((signal) => signal.kind === 'cooldown-active' || signal.kind === 'rate-limit-hit')
    .map((signal) => signal.provider ?? 'unknown'))];

  let level = tokenLevel(totalTokens);
  for (const signal of signals) {
    if (signal.kind === 'cooldown-active' || signal.kind === 'rate-limit-hit') {
      level = stronger(level, 'cooling');
    } else if (signal.kind === 'external-monitor-estimate' && signal.estimateLevel !== undefined) {
      level = stronger(level, signal.estimateLevel);
    }
  }

  const receiptLines: string[] = [];
  if (totalTokens > 0) {
    receiptLines.push(`Observed consumption: ${formatTokens(totalTokens)} tokens from available telemetry/ledgers.`);
  }
  if (coolingProviders.length > 0) {
    receiptLines.push(`Cooling after observed pressure: ${coolingProviders.join(', ')}.`);
  }
  const thirdParty = signals.some((signal) => signal.trust === 'third-party-estimate');
  if (thirdParty) {
    receiptLines.push('Third-party monitor data is treated as an estimate, not exact quota.');
  }
  receiptLines.push('Remaining subscription headroom: unknown.');

  return {
    level,
    remainingQuotaKnown: false,
    totalTokens,
    coolingProviders,
    signals,
    receiptLines,
  };
}
