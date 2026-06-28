/**
 * src/core/opencode-account-routing.ts — OpenCode account-aware routing.
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
 * Select the best OpenCode account from the matching pool for the current turn.
 *
 * Returns `null` when no eligible account exists — the caller MUST fall back to
 * the current global OpenCode path with NO account env injection.
 *
 * Algorithm:
 *  1. Keep only accounts matching `pool`, enabled, not disabled-priority,
 *     not expired, priorityWeight > 0.
 *  2. Exclude cooling accounts (cooldownUntil > nowMs).
 *  3. If all eligible are cooling → never-strand: ignore cooldown for this
 *     selection (mirrors src/core/cooldown.ts:39-59).
 *  4. Pick the minimum normalizedLoad =
 *       (sessionTokensByAccount[id] ?? 0) / priorityWeight.
 *  5. Stable tiebreaker: createdAt, then id lexical.
 */
export function selectOpencodeAccount(input: {
  accounts: readonly OpencodeSubscriptionAccount[];
  pool: OpencodePool;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): OpencodeSubscriptionAccount | null {
  const { accounts, pool, nowMs, cooldownUntil, sessionTokensByAccount } =
    input;

  // Step 1 — filter to eligible candidates
  const eligible: Array<OpencodeSubscriptionAccount & { load: number }> = [];
  for (const a of accounts) {
    if (
      a.provider === 'opencode' &&
      a.pool === pool &&
      a.enabled === true &&
      a.priority !== 'disabled' &&
      a.priorityWeight > 0 &&
      (a.expiresAt === undefined || new Date(a.expiresAt).getTime() > nowMs)
    ) {
      eligible.push({
        ...a,
        load:
          (sessionTokensByAccount[a.id] ?? 0) / a.priorityWeight,
      });
    }
  }

  if (eligible.length === 0) return null;

  // Step 2 — split by cooldown
  const notCooling = eligible.filter((a) => {
    const until = cooldownUntil.get(a.id);
    return until === undefined || until <= nowMs;
  });

  // Step 3 — never-strand: if all are cooling, ignore cooldown
  const candidates = notCooling.length > 0 ? notCooling : eligible;

  // Step 4 + 5 — pick minimum load then stable tiebreaker
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
