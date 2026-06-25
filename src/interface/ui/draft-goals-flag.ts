/**
 * src/interface/ui/draft-goals-flag.ts — the single source of truth for whether
 * the DRAFT GOAL SKELETON feature (Phase 1 spine — "chat → draft goal") is
 * permitted to run.
 *
 * When ON, a BUILD-INTENT turn causes the byproduct IntentFrame to carry an
 * optional `draftGoalSkeleton` (title + high-level outline), which is
 * materialised as an INACTIVE (parked) goal in the GoalStore — source
 * `'byproduct-draft'`, state `'parked'`, never queued or executed without
 * explicit user confirmation. On non-build turns (questions / discussion) the
 * skeleton field is absent and NO goal is created — zero over-triggering.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR
 * `npm test` suite under strip-types. DEFAULT OFF — this is new behavior that
 * must be explicitly opted IN via `MYSHELL_DRAFT_GOALS` ∈
 * {'1','true','on','yes'} (case-insensitive, trimmed) or persisted
 * `config.experimentalDraftGoals === true`. Mirrors auto-brain-flag.ts /
 * byproduct-fallback-flag.ts. Rollback forces it OFF (kill-switch parity).
 *
 * THE OFF-GUARANTEE (load-bearing neutrality contract): when this returns
 * false, menu.ts injects NOTHING draft-goals-related onto OrchestrateDeps
 * (the `draftGoals` seam field is absent), so `orchestrate` never reads any
 * draft-goal output; no goal is created; byproduct schema is byte-for-byte
 * today's (the `draftGoalSkeleton` field is simply absent from every frame).
 * Every code path is BYTE-FOR-BYTE today's when this flag is off.
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_DRAFT_GOALS. */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the draft-goal-skeleton feature is enabled. DEFAULT FALSE.
 * Returns true ONLY on an explicit opt-IN: `MYSHELL_DRAFT_GOALS` ∈
 * {'1','true','on','yes'} (trimmed, case-insensitive) OR
 * `config.experimentalDraftGoals === true`. Rollback forces it off. Any
 * other value (including absent, '0', 'false', '') → false. Never throws.
 */
export function draftGoalsEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalDraftGoals?: boolean; rollback?: boolean } | undefined,
): boolean {
  try {
    if (rollbackEngaged(env, config)) return false;
    const raw = env?.['MYSHELL_DRAFT_GOALS'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    return config?.experimentalDraftGoals === true;
  } catch {
    return false;
  }
}
