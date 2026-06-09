/**
 * src/core/verify-policy.ts — the CONSERVATIVE built-in verify level policy used
 * when the Performance Governor flag is OFF (master-plan PHASE 3 / §2.3).
 *
 * When the Governor is ON, its `verify` lever selects the level (gated by budget,
 * shape, stakes, vendor count). When the Governor is OFF but the verify flag is ON,
 * THIS pure policy picks a conservative level so verification still works
 * standalone — single-vendor-valuable — without the Governor:
 *
 *   - tests-first is ALWAYS the floor (free local exec — the strongest, cheapest
 *     signal), so the default level is `'tests'`.
 *   - the diff-scoped critic (the one paid lever) is added ONLY on HIGH-STAKES or
 *     LARGE diffs — NEVER on a trivial change. And only when ≥2 vendors are
 *     connected (else the same-vendor critic would add a weak self-check the ICLR
 *     caveat warns against — we keep it tests-only when single-vendor + low-stakes).
 *
 * Pure, total, fail-soft. ZERO tokens.
 *
 * @see .tmp-master-golden.md §2.3 — the firing policy (gated, tests-first-free)
 */

import type { VerifyLevel } from './verify.js';

/** Inputs to the built-in conservative policy — all real, in-process signals. */
export interface VerifyPolicyInput {
  /** True when the brain assessed high stakes (risk high/critical OR irreversible). */
  readonly highStakes: boolean;
  /** The number of files the change touched (the diff's size proxy). */
  readonly changedFiles: number;
  /** How many vendors are authenticated (the cross-vendor unlock). */
  readonly authedProviderCount: number;
}

/** A diff touching at least this many files is "large" — earns a critic. */
const LARGE_DIFF_FILES = 5;

/**
 * Pick the conservative built-in verify level (Governor OFF). Tests-first is always
 * the floor; the critic is added only on high-stakes or large diffs AND ≥2 vendors.
 * NEVER returns a critic level for a trivial (≤1 file, low-stakes) change. Total.
 */
export function defaultVerifyLevel(input: VerifyPolicyInput): VerifyLevel {
  const files = Number.isFinite(input.changedFiles) ? Math.max(0, Math.floor(input.changedFiles)) : 0;
  // No change ⇒ no verification (the stage's diff-gate also enforces this).
  if (files === 0) return 'none';

  const twoVendors = Number.isFinite(input.authedProviderCount)
    && Math.floor(input.authedProviderCount) >= 2;

  const wantsCritic = (input.highStakes === true || files >= LARGE_DIFF_FILES) && twoVendors;

  // Tests-first is the floor; add the critic only when it is earned.
  return wantsCritic ? 'tests+critic' : 'tests';
}
