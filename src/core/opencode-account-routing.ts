/**
 * src/core/opencode-account-routing.ts — subscription-account-aware routing.
 *
 * Pure pool detection + account selection helpers. No I/O, no env/process, no
 * random. The caller owns the mutable cooldown/session maps and the Clock;
 * these helpers are purely functional.
 *
 * Purity rules (enforced by the same arch guard as orchestrate.ts / work-call.ts):
 *  - No imports of fs / path / child_process
 *  - No console.* calls
 *  - No Date.now() / Math.random() / new Date() — receive epoch ms / iso strings
 *  - No process.exit()
 */

import type {
  OpencodePool,
  OpencodeSubscriptionAccount,
  SubscriptionAccount,
  SubscriptionProvider,
} from '../infra/subscriptions.js';

/**
 * Derive the OpenCode pool from a concrete model id prefix.
 * `opencode-go/...` → `'go'`, `opencode/...` → `'zen'`.
 * Returns `null` when the model id is not a routed OpenCode model
 * (e.g. the pricing placeholder `'opencode'` with no slash).
 */
export function opencodePoolForModel(model: string): OpencodePool | null {
  if (model.startsWith('opencode-go/')) return 'go';
  if (model.startsWith('opencode/')) return 'zen';
  return null;
}

/**
 * Select the best subscription account for the given provider for the current turn.
 *
 * Returns `null` when no eligible account exists — the caller MUST fall back to
 * the provider's global path with NO account env injection.
 *
 * Algorithm:
 *  1. Keep only accounts matching `provider`, enabled, not disabled-priority,
 *     not expired, priorityWeight > 0.
 *  2. For opencode, additionally filter by `pool`.
 *  3. Exclude cooling accounts (cooldownUntil > nowMs).
 *  4. If all eligible are cooling → never-strand: ignore cooldown for this
 *     selection.
 *
 * Strategy:
 *  - `spread` (default): pick the minimum normalizedLoad =
 *      (sessionTokensByAccount[id] ?? 0) / priorityWeight.
 *    Stable tiebreaker: createdAt, then id lexical.
 *  - `sticky`: pick the HIGHEST effective priorityWeight eligible account.
 *    Tie → min normalizedLoad; only fall to a lower-weight sibling when
 *    higher-weight ones are all excluded (disabled/expired) or cooling.
 */
export function selectSubscriptionAccount<T extends SubscriptionAccount>(input: {
  accounts: readonly T[];
  provider: SubscriptionProvider;
  pool?: OpencodePool;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
  strategy?: 'sticky' | 'spread';
}): T | null {
  const {
    accounts,
    provider,
    pool,
    nowMs,
    cooldownUntil,
    sessionTokensByAccount,
    strategy = 'spread',
  } = input;

  const eligible: Array<T & { load: number }> = [];
  for (const a of accounts) {
    if (
      a.provider === provider &&
      a.enabled === true &&
      a.priority !== 'disabled' &&
      a.priorityWeight > 0 &&
      (a.expiresAt === undefined || Date.parse(a.expiresAt) > nowMs)
    ) {
      if (provider === 'opencode') {
        const opencode = a as unknown as OpencodeSubscriptionAccount;
        if (pool !== undefined && opencode.pool !== pool) continue;
      }
      eligible.push({
        ...a,
        load:
          (sessionTokensByAccount[a.id] ?? 0) / a.priorityWeight,
      });
    }
  }

  if (eligible.length === 0) return null;

  const isCooling = (a: T & { load: number }): boolean => {
    const until = cooldownUntil.get(a.id);
    return until !== undefined && until > nowMs;
  };

  const notCooling = eligible.filter((a) => !isCooling(a));
  const candidates = notCooling.length > 0 ? notCooling : eligible;

  if (strategy === 'sticky') {
    // Group by priorityWeight (highest first), pick within the top group
    // that has at least one non-cooling candidate, ignoring cooling for
    // lower groups. Within a group, use min normalizedLoad + tiebreaker.
    const byWeight = new Map<number, Array<T & { load: number }>>();
    for (const c of candidates) {
      const list = byWeight.get(c.priorityWeight) ?? [];
      list.push(c);
      byWeight.set(c.priorityWeight, list);
    }
    const sortedWeights = [...byWeight.keys()].sort((a, b) => b - a);
    for (const w of sortedWeights) {
      const group = byWeight.get(w);
      if (group === undefined) continue;
      const groupNotCooling = group.filter((a) => !isCooling(a));
      const pickFrom = groupNotCooling.length > 0 ? groupNotCooling : group;
      pickFrom.sort((a, b) => {
        if (a.load !== b.load) return a.load - b.load;
        if (a.createdAt < b.createdAt) return -1;
        if (a.createdAt > b.createdAt) return 1;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });
      return pickFrom[0] ?? null;
    }
    return null;
  }

  candidates.sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  return candidates[0] ?? null;
}

/**
 * Select a DISTINCT sibling account for the SAME provider as the primary,
 * for use as a speculative hedge arm in account-aware parallelism (Slice 5).
 *
 * Eligibility: only accounts that are NOT the primary, NOT low/very-low-weight
 * (priorityWeight >= 100), enabled, not expired, not cooling, not overflow-only.
 *
 * Delegates to {@link selectSubscriptionAccount} with `strategy: 'spread'`
 * after filtering out the primary and low-weight/overflow accounts.
 */
export function selectSiblingSubscriptionAccount<T extends SubscriptionAccount>(input: {
  accounts: readonly T[];
  provider: SubscriptionProvider;
  pool?: OpencodePool;
  primaryAccountId: string;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): T | null {
  return selectSubscriptionAccount({
    ...input,
    accounts: input.accounts.filter((a) =>
      a.id !== input.primaryAccountId &&
      a.priority !== 'low' &&
      a.priorityWeight >= 100
    ),
    strategy: 'spread',
  });
}

/**
 * Compatibility wrapper: select the best OpenCode account from the matching pool.
 * Delegates to {@link selectSubscriptionAccount} with `provider: 'opencode'`.
 */
export function selectOpencodeAccount(input: {
  accounts: readonly OpencodeSubscriptionAccount[];
  pool: OpencodePool;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): OpencodeSubscriptionAccount | null {
  return selectSubscriptionAccount({
    accounts: input.accounts,
    provider: 'opencode',
    pool: input.pool,
    nowMs: input.nowMs,
    cooldownUntil: input.cooldownUntil,
    sessionTokensByAccount: input.sessionTokensByAccount,
  });
}
