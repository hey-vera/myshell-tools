/**
 * src/core/routing-memory.ts — Local Outcome Learner (EXPERIMENTAL, opt-in).
 *
 * Learns, from THIS user's own append-only ledger, which provider tends to
 * perform best per tier, and produces a learned provider-preference order that
 * the conversation layer can hand to route() to reorder which signed-in provider
 * a turn tries first. This is a subscription-first lever: when several providers
 * are signed in, the honest question is not "which is cheapest per token" (a
 * flat-rate plan has no per-token bill) but "which one actually finishes my work,
 * fastest" — and the only ground truth for that is the user's own recorded
 * outcomes. So we learn from them rather than guessing.
 *
 * HONESTY CONTRACT (load-bearing — do not weaken):
 *  - We rank ONLY on observed outcomes: the `success` flag and `durationMs`. We
 *    never touch `usd`/tokens for ranking (dollars are not the scarce resource
 *    here, and a token count says nothing about whether the answer was good), and
 *    we never infer or fabricate plan/quota state.
 *  - We require real signal before reordering: a provider must have at least
 *    `minRunsPerProvider` runs to be ranked at all (we do not reorder on noise),
 *    and we need ≥2 ranked providers to return an order at all (otherwise there is
 *    nothing to reorder — return null and leave routing unchanged).
 *  - We never throw: garbage / empty input degrades to null (no override).
 *
 * PURITY (enforced by test/arch/guards.test.ts): no fs/path/child_process/os/
 * crypto, no Date.now()/Math.random()/new Date(), no provider imports beyond the
 * type-only ProviderId. In particular we do NOT parse `entry.timestamp` (that
 * needs Date) — recency filtering is the CALLER's job; this module ranks only the
 * entries it is handed.
 */

import type { LedgerEntry, Tier } from './types.js';
import type { ProviderId } from '../providers/port.js';

/**
 * Aggregated, observed-only outcome stats for one provider at one tier.
 * `successRate` is in [0,1]; `avgDurationMs` is the mean wall-clock across the
 * provider's runs at this tier (a real latency cost, our tie-breaker).
 */
export interface ProviderTierStats {
  readonly provider: ProviderId;
  readonly runs: number;
  readonly successes: number;
  readonly successRate: number;
  readonly avgDurationMs: number;
}

/** Internal mutable accumulator (collapsed into the readonly stats below). */
interface Accumulator {
  runs: number;
  successes: number;
  totalDurationMs: number;
}

/**
 * Compute per-provider observed outcome stats for a single tier. PURE.
 *
 * Filters `entries` to `tier`, groups by provider, and reduces each group to
 * runs / successes / successRate / avgDurationMs. Providers with no entries at
 * this tier do not appear. Tolerates empty input (→ empty array) and never
 * throws. Only `success` and `durationMs` are read — never usd/tokens.
 *
 * Negative/NaN `durationMs` is coerced to 0 so a malformed entry can't poison the
 * average into a negative or NaN value (defensive; the schema is numeric but the
 * file is user-editable JSONL).
 *
 * @param entries - Ledger entries (any tier mix; caller pre-filters recency).
 * @param tier    - The tier to aggregate.
 */
export function computeTierStats(
  entries: readonly LedgerEntry[],
  tier: Tier,
): readonly ProviderTierStats[] {
  const byProvider = new Map<ProviderId, Accumulator>();

  for (const entry of entries) {
    if (entry === null || entry === undefined) continue;
    if (entry.tier !== tier) continue;
    const provider = entry.provider;
    // Defensive: ignore entries with no usable provider id.
    if (typeof provider !== 'string' || provider.length === 0) continue;

    let acc = byProvider.get(provider);
    if (acc === undefined) {
      acc = { runs: 0, successes: 0, totalDurationMs: 0 };
      byProvider.set(provider, acc);
    }
    acc.runs += 1;
    if (entry.success === true) acc.successes += 1;
    const duration =
      typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) && entry.durationMs > 0
        ? entry.durationMs
        : 0;
    acc.totalDurationMs += duration;
  }

  const stats: ProviderTierStats[] = [];
  for (const [provider, acc] of byProvider) {
    stats.push({
      provider,
      runs: acc.runs,
      successes: acc.successes,
      successRate: acc.runs > 0 ? acc.successes / acc.runs : 0,
      avgDurationMs: acc.runs > 0 ? acc.totalDurationMs / acc.runs : 0,
    });
  }
  return stats;
}

/**
 * Learn a provider-preference order for `tier` from the user's recorded
 * outcomes. PURE. Returns the ranked provider ids, or `null` when there is
 * insufficient signal to justify an override (so routing stays unchanged).
 *
 * Algorithm:
 *  1. Aggregate per-provider stats for the tier (computeTierStats).
 *  2. Keep only providers with `runs >= minRunsPerProvider` (default 3) — we do
 *     not reorder routing on noise.
 *  3. If fewer than 2 providers qualify, return `null`: there is nothing to
 *     reorder (one provider's order is whatever it is), and a single data point
 *     is not enough to assert a preference.
 *  4. Otherwise rank, deterministically and stably:
 *       a. higher `successRate` first (the outcome that matters most),
 *       b. tie-break by LOWER `avgDurationMs` (latency is a real cost on a
 *          flat-rate plan — the budget is wall-clock + quota, not dollars),
 *       c. final tie-break by provider id alphabetically, so the output is fully
 *          deterministic regardless of input order or sort stability.
 *  5. Return the ranked provider ids (only the qualifying providers).
 *
 * Never throws: empty / garbage input → null.
 *
 * @param entries - Ledger entries for this user (caller pre-filters recency).
 * @param tier    - The tier to learn an order for.
 * @param opts.minRunsPerProvider - Minimum runs a provider needs to be ranked
 *                                  (default 3).
 */
export function learnProviderOrder(
  entries: readonly LedgerEntry[],
  tier: Tier,
  opts?: { readonly minRunsPerProvider?: number },
): readonly ProviderId[] | null {
  // Defensive: a non-array (shouldn't happen via the typed API, but the data is
  // user-editable upstream) yields no signal rather than throwing.
  if (!Array.isArray(entries)) return null;

  const minRuns = opts?.minRunsPerProvider ?? 3;

  const qualifying = computeTierStats(entries, tier).filter((s) => s.runs >= minRuns);

  // Need ≥2 ranked providers to have something to reorder.
  if (qualifying.length < 2) return null;

  const ranked = [...qualifying].sort((a, b) => {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate; // higher first
    if (a.avgDurationMs !== b.avgDurationMs) return a.avgDurationMs - b.avgDurationMs; // lower first
    return a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0; // id asc
  });

  return ranked.map((s) => s.provider);
}
