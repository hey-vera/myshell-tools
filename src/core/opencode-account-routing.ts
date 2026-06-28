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
 *  5. Pick the minimum normalizedLoad =
 *       (sessionTokensByAccount[id] ?? 0) / priorityWeight.
 *  6. Stable tiebreaker: createdAt, then id lexical.
 */
export function selectSubscriptionAccount<T extends SubscriptionAccount>(input: {
  accounts: readonly T[];
  provider: SubscriptionProvider;
  pool?: OpencodePool;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): T | null {
  const {
    accounts,
    provider,
    pool,
    nowMs,
    cooldownUntil,
    sessionTokensByAccount,
  } = input;

  const eligible: Array<T & { load: number }> = [];
  for (const a of accounts) {
    if (
      a.provider === provider &&
      a.enabled === true &&
      a.priority !== 'disabled' &&
      a.priorityWeight > 0 &&
      (a.expiresAt === undefined || new Date(a.expiresAt).getTime() > nowMs)
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

  const notCooling = eligible.filter((a) => {
    const until = cooldownUntil.get(a.id);
    return until === undefined || until <= nowMs;
  });

  const candidates = notCooling.length > 0 ? notCooling : eligible;

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
