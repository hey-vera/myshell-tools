/**
 * src/core/budget.ts — pure per-task cost budget helpers.
 *
 * Purity rules (enforced by test/arch/guards.test.ts):
 *  - No imports of fs / path / child_process
 *  - No console.* calls
 *  - No Date.now() / Math.random() / new Date()
 *  - No process.exit()
 */

/**
 * Returns `true` when `spentUsd` has reached or exceeded the budget cap, so
 * that orchestrate() must stop spending.
 *
 * Returns `false` (no cap) when:
 *  - `maxCostUsd` is `null` or `undefined`
 *  - `maxCostUsd` is ≤ 0 (non-positive cap is treated as "uncapped")
 */
export function budgetExceeded(
  spentUsd: number,
  maxCostUsd: number | null | undefined,
): boolean {
  if (maxCostUsd === null || maxCostUsd === undefined || maxCostUsd <= 0) {
    return false;
  }
  return spentUsd >= maxCostUsd;
}

/**
 * Returns how many USD remain in the budget, or `null` when uncapped.
 *
 * The returned value may be zero or negative if the cap has already been
 * reached; callers should use {@link budgetExceeded} to make gate decisions
 * rather than checking the sign here.
 */
export function remainingBudget(
  spentUsd: number,
  maxCostUsd: number | null | undefined,
): number | null {
  if (maxCostUsd === null || maxCostUsd === undefined || maxCostUsd <= 0) {
    return null;
  }
  return maxCostUsd - spentUsd;
}
