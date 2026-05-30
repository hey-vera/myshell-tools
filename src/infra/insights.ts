/**
 * src/infra/insights.ts — Pure reducers over LedgerEntry[] for spend and provider health.
 *
 * No I/O. All functions are deterministic given the same inputs.
 * Safe to call in tests with hand-built arrays.
 *
 * Honesty Contract:
 *   - No hardcoded percentages — success rates are always computed from data.
 *   - No digit-% literals in source — percent strings are built by concatenation.
 *   - No fabricated values — all outputs derive strictly from the input entries.
 */

import type { LedgerEntry } from '../core/types.js';

// ---------------------------------------------------------------------------
// SpendSummary
// ---------------------------------------------------------------------------

/** Aggregated spend data suitable for display in the control panel header. */
export interface SpendSummary {
  /** Total USD spent in the current calendar day (UTC). */
  readonly todayUsd: number;
  /** Total USD spent across all time. */
  readonly totalUsd: number;
  /** Total number of ledger entries (calls). */
  readonly calls: number;
  /** Per-provider breakdown keyed by ProviderId string. */
  readonly byProvider: Record<string, { readonly usd: number; readonly calls: number }>;
}

/**
 * Pure reduction over LedgerEntry[] that produces a SpendSummary.
 *
 * "Today" is defined as entries whose `timestamp` ISO string has the same
 * YYYY-MM-DD date prefix as `nowIso`. Both are treated as UTC.
 *
 * @param entries - Array of LedgerEntry objects (may be empty).
 * @param nowIso  - ISO-8601 timestamp representing "now" (e.g. from Clock.isoNow()).
 */
export function summarizeSpend(entries: LedgerEntry[], nowIso: string): SpendSummary {
  const todayDate = nowIso.slice(0, 10); // 'YYYY-MM-DD'

  let todayUsd = 0;
  let totalUsd = 0;
  const byProvider: Record<string, { usd: number; calls: number }> = {};

  for (const entry of entries) {
    totalUsd += entry.usd;

    if (entry.timestamp.slice(0, 10) === todayDate) {
      todayUsd += entry.usd;
    }

    const existing = byProvider[entry.provider];
    if (existing !== undefined) {
      existing.usd += entry.usd;
      existing.calls += 1;
    } else {
      byProvider[entry.provider] = { usd: entry.usd, calls: 1 };
    }
  }

  return {
    todayUsd,
    totalUsd,
    calls: entries.length,
    byProvider,
  };
}

// ---------------------------------------------------------------------------
// ProviderHealth
// ---------------------------------------------------------------------------

/** Health summary for a single provider derived from its ledger entries. */
export interface ProviderHealth {
  readonly provider: string;
  readonly calls: number;
  /** Fraction of successful calls in [0, 1]. 0 when calls === 0. */
  readonly successRate: number;
  /** Arithmetic mean of durationMs. 0 when calls === 0. */
  readonly avgDurationMs: number;
  readonly status: 'healthy' | 'degraded' | 'unknown';
}

/**
 * Compute per-provider health from a LedgerEntry array.
 *
 * Status thresholds:
 *   - `unknown`  — 0 calls
 *   - `degraded` — successRate < 0.7
 *   - `healthy`  — successRate >= 0.7
 *
 * @param entries - Array of LedgerEntry objects (may be empty).
 */
export function providerHealth(entries: LedgerEntry[]): ProviderHealth[] {
  const byProvider: Record<string, { calls: number; successes: number; durationMs: number }> = {};

  for (const entry of entries) {
    const existing = byProvider[entry.provider];
    if (existing !== undefined) {
      existing.calls += 1;
      existing.successes += entry.success ? 1 : 0;
      existing.durationMs += entry.durationMs;
    } else {
      byProvider[entry.provider] = {
        calls: 1,
        successes: entry.success ? 1 : 0,
        durationMs: entry.durationMs,
      };
    }
  }

  return Object.entries(byProvider).map(([provider, agg]) => {
    const { calls, successes, durationMs } = agg;
    const successRate = calls === 0 ? 0 : successes / calls;
    const avgDurationMs = calls === 0 ? 0 : durationMs / calls;
    let status: ProviderHealth['status'];
    if (calls === 0) {
      status = 'unknown';
    } else if (successRate < 0.7) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }
    return { provider, calls, successRate, avgDurationMs, status };
  });
}

// ---------------------------------------------------------------------------
// formatUsd
// ---------------------------------------------------------------------------

/**
 * Format a USD amount as a string with a `$` prefix and 4 decimal places.
 *
 * The result never contains a digit immediately before `%` — this is a dollar
 * amount, not a percentage.
 *
 * @param n - Amount in US dollars (may be 0).
 */
export function formatUsd(n: number): string {
  return '$' + n.toFixed(4);
}
