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
import type { ModelPreference, TaskKind } from './model-capabilities.js';

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
    if (entry.stage !== undefined && entry.stage !== 'work') continue;
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

// ---------------------------------------------------------------------------
// Stage 4 — Model-level learned outcomes (§2 Layer 3). EXTENDS the provider-by-
// tier learner above; does NOT replace it. The LOWEST-priority, MOST conservative
// routing signal: it only ever NUDGES route()'s tie-break AFTER hard capability
// fit, within the already-bounded candidate set. Cold-start / below-threshold →
// null → routing unchanged.
//
// PURITY (same contract as above, enforced by test/arch/guards.test.ts): no
// fs/path/child_process/os/crypto, no Date/Math.random/new Date. In particular we
// do NOT parse `entry.timestamp` — recency filtering stays the CALLER's job.
// ---------------------------------------------------------------------------

/**
 * Aggregated, observed-only outcome stats for one (provider, model, tier,
 * taskKind) cell. `successRate` is the RAW observed rate in [0,1];
 * `confidenceWeight` is the neutral-prior-SMOOTHED success used for ranking
 * (`(successes + 1) / (runs + 2)`), so a lucky 1/1 cannot dominate a solid 20/25.
 * Token averages are recorded as a final, lowest-priority tie-break only — a
 * quota signal, never a quality one.
 */
export interface ModelOutcomeStats {
  readonly provider: ProviderId;
  readonly model: string;
  readonly tier: Tier;
  readonly taskKind: TaskKind;
  readonly runs: number;
  readonly successes: number;
  readonly successRate: number;
  readonly avgDurationMs: number;
  readonly avgInputTokens: number;
  readonly avgOutputTokens: number;
  readonly confidenceWeight: number;
}

/** Internal mutable accumulator for one (provider, model) cell at a taskKind. */
interface ModelAccumulator {
  provider: ProviderId;
  model: string;
  tier: Tier;
  runs: number;
  successes: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

/** A missing/absent ledger taskKind aggregates as 'unknown' (§2 Layer 3 back-compat). */
function taskKindOf(entry: LedgerEntry): TaskKind {
  return entry.taskKind ?? 'unknown';
}

/** A non-negative finite number, else 0 (defensive: the JSONL file is user-editable). */
function nonNegFinite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compute per-(provider, model) observed outcome stats for ONE taskKind. PURE.
 *
 * Filters `entries` to `taskKind` (absent ledger taskKind → 'unknown'), groups by
 * provider+model, and reduces each group to runs / successes / rates / averages.
 * The cell's `tier` is the tier of the FIRST entry seen for that cell (a model's
 * tier is stable); it is informational only and never gates ranking. Tolerates
 * empty/garbage input (→ empty array) and never throws. Only success / durationMs
 * / token counts are read — never usd. Negative/NaN numerics coerce to 0.
 *
 * @param entries  - Ledger entries (any mix; caller pre-filters recency).
 * @param taskKind - The task kind to aggregate.
 */
export function computeModelOutcomeStats(
  entries: readonly LedgerEntry[],
  taskKind: TaskKind,
): readonly ModelOutcomeStats[] {
  if (!Array.isArray(entries)) return [];
  const byKey = new Map<string, ModelAccumulator>();

  for (const entry of entries) {
    if (entry === null || entry === undefined) continue;
    if (entry.stage !== undefined && entry.stage !== 'work') continue;
    if (taskKindOf(entry) !== taskKind) continue;
    const provider: ProviderId = entry.provider;
    const model = entry.model;
    // Defensive: the JSONL file is user-editable upstream — ignore entries with no
    // usable provider/model id (mirrors computeTierStats' provider guard).
    if (typeof provider !== 'string' || (provider as string).length === 0) continue;
    if (typeof model !== 'string' || model.length === 0) continue;
    if (entry.tier !== 'worker' && entry.tier !== 'ic' && entry.tier !== 'manager') continue;
    const tier: Tier = entry.tier;

    const key = `${provider} ${model}`;
    const existing = byKey.get(key);
    const acc: ModelAccumulator = existing ?? {
      provider,
      model,
      tier,
      runs: 0,
      successes: 0,
      totalDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    if (existing === undefined) byKey.set(key, acc);
    acc.runs += 1;
    if (entry.success === true) acc.successes += 1;
    acc.totalDurationMs += nonNegFinite(entry.durationMs);
    acc.totalInputTokens += nonNegFinite(entry.inputTokens);
    acc.totalOutputTokens += nonNegFinite(entry.outputTokens);
  }

  const stats: ModelOutcomeStats[] = [];
  for (const acc of byKey.values()) {
    stats.push({
      provider: acc.provider,
      model: acc.model,
      tier: acc.tier,
      taskKind,
      runs: acc.runs,
      successes: acc.successes,
      successRate: acc.runs > 0 ? acc.successes / acc.runs : 0,
      avgDurationMs: acc.runs > 0 ? acc.totalDurationMs / acc.runs : 0,
      avgInputTokens: acc.runs > 0 ? acc.totalInputTokens / acc.runs : 0,
      avgOutputTokens: acc.runs > 0 ? acc.totalOutputTokens / acc.runs : 0,
      // Neutral prior: (s+1)/(r+2). A 1/1 cell → 0.667; a 20/25 cell → 0.778, so
      // the well-evidenced cell ranks ahead despite a lower raw "lucky" rate.
      confidenceWeight: (acc.successes + 1) / (acc.runs + 2),
    });
  }
  return stats;
}

/** Minimum runs a (provider, model) cell needs at a taskKind before it is usable. */
const DEFAULT_MIN_RUNS_PER_MODEL = 5;
/** Minimum qualifying candidate models before an order is returned at all. */
const DEFAULT_MIN_CANDIDATES = 2;

/**
 * Learn a MODEL-level outcome order for one `taskKind` from the user's recorded
 * outcomes. PURE. Returns the ranked `(provider, model)` pairs, or `null` when
 * there is insufficient signal — in which case routing falls back to declarative
 * capability-fit + policy order (the weak learned term is simply absent).
 *
 * This is the §2 Layer 3 aggregator and it is deliberately the most conservative
 * signal in the system:
 *  1. Aggregate per-(provider, model) stats for the taskKind (absent ledger
 *     taskKind aggregates as 'unknown').
 *  2. Keep only cells with `runs >= minRunsPerModel` (default 5) — a tiny per-user
 *     ledger is weak signal; we do not nudge routing on noise.
 *  3. If fewer than `minCandidates` (default 2) cells qualify, return `null`: there
 *     is nothing to tie-break between.
 *  4. Rank, deterministically and stably:
 *       a. higher SMOOTHED success (`confidenceWeight`, neutral prior) first — the
 *          outcome that matters most, with 1/1 unable to dominate 20/25;
 *       b. tie-break by LOWER `avgDurationMs` (latency is a real cost);
 *       c. tie-break by LOWER total avg token use (`avgInputTokens +
 *          avgOutputTokens`) — a QUOTA signal only, never quality, so it is the
 *          last numeric tie-break;
 *       d. final tie-break by provider then model id ascending, so the output is
 *          fully deterministic regardless of input order / sort stability.
 *
 * The returned order is consumed by route() ONLY as a weak tie-break applied after
 * hard capability fit and within the bounded candidate set; it can never change
 * the provider, expand the candidate set, or bypass a gate.
 *
 * Never throws: empty / garbage input → null.
 *
 * @param entries  - Ledger entries for this user (caller pre-filters recency).
 * @param taskKind - The task kind to learn an order for.
 * @param opts.minRunsPerModel - Minimum runs a cell needs to be ranked (default 5).
 * @param opts.minCandidates   - Minimum qualifying cells to return an order (default 2).
 */
export function learnModelOutcomeOrder(
  entries: readonly LedgerEntry[],
  taskKind: TaskKind,
  opts?: { readonly minRunsPerModel?: number; readonly minCandidates?: number },
): readonly ModelPreference[] | null {
  if (!Array.isArray(entries)) return null;

  const minRuns = opts?.minRunsPerModel ?? DEFAULT_MIN_RUNS_PER_MODEL;
  const minCandidates = opts?.minCandidates ?? DEFAULT_MIN_CANDIDATES;

  const qualifying = computeModelOutcomeStats(entries, taskKind).filter(
    (s) => s.runs >= minRuns,
  );

  // Need ≥minCandidates qualifying cells to have something to tie-break between.
  if (qualifying.length < minCandidates) return null;

  const ranked = [...qualifying].sort((a, b) => {
    if (b.confidenceWeight !== a.confidenceWeight) {
      return b.confidenceWeight - a.confidenceWeight; // higher smoothed success first
    }
    if (a.avgDurationMs !== b.avgDurationMs) {
      return a.avgDurationMs - b.avgDurationMs; // lower latency first
    }
    const aTok = a.avgInputTokens + a.avgOutputTokens;
    const bTok = b.avgInputTokens + b.avgOutputTokens;
    if (aTok !== bTok) return aTok - bTok; // lower token use first (quota tie-break only)
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1; // provider asc
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0; // model id asc
  });

  return ranked.map((s) => ({ provider: s.provider, model: s.model }));
}
