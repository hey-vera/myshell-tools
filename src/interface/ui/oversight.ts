/**
 * src/interface/ui/oversight.ts — the OVERSIGHT SPECTRUM (Phase 2b): the single
 * source of truth for the per-user EXECUTION-AUTONOMY level and the reusable
 * launch-checkpoint seam that decides whether a goal/to-do pauses before it goes
 * from PROPOSED → RUNNING.
 *
 * The SAME partner serves three personas, learned + remembered per user:
 *   'review-all'  → cautious: confirm before launch AND pause after each to-do's
 *                   diff for a one-tap approve/stop.
 *   'checkpoint'  → the safe middle (DEFAULT): propose-then-one-tap-go before
 *                   launch, then run without per-diff pauses (Phase-2 behaviour).
 *   'autonomous'  → "just do it": skip the launch confirm, run, then surface a
 *                   confident done-summary. The safety floor stays (a genuine
 *                   mid-run fork still asks).
 *
 * This is DISTINCT from `partnerStyle` (a soft conversational bias) — it governs
 * real execution autonomy, modelled on Claude Code's permission modes
 * (review-each / acceptEdits / Auto).
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT 'checkpoint' — with `config.oversight` absent
 * the launch experience is BYTE-IDENTICAL to Phase 2 (propose-then-confirm, no
 * per-diff pauses). Never throws.
 *
 * THE EXTENSION POINT (Phase 4 plugs in HERE): {@link shouldPauseBeforeLaunch} is
 * the ONE reusable checkpoint hook the goal launch + the manager cycle consult
 * before a unit of work runs. Phase 4's standing-rules launch gate can add a new
 * `LaunchCheckpointReason` and an extra clause to this function WITHOUT re-plumbing
 * the call sites — they already pause on any non-`null` decision.
 */

import type { AppConfig } from '../../infra/config.js';

/** The three execution-autonomy levels. Re-exported from the config field type. */
export type Oversight = NonNullable<AppConfig['oversight']>;

/** Env values mapped to each explicit level (case-insensitive, trimmed). */
const ENV_LEVELS: Record<string, Oversight> = {
  'review-all': 'review-all',
  review: 'review-all',
  'review-each': 'review-all',
  checkpoint: 'checkpoint',
  propose: 'checkpoint',
  autonomous: 'autonomous',
  auto: 'autonomous',
};

/**
 * Resolve the effective oversight level for this user. An explicit
 * `MYSHELL_OVERSIGHT` env value wins (review-all | checkpoint | autonomous, plus a
 * couple of friendly aliases), then `config.oversight`, then the DEFAULT
 * 'checkpoint'. Pure; never throws (any surprise → the safe default).
 */
export function resolveOversight(
  config: Pick<AppConfig, 'oversight'> | undefined,
  env?: NodeJS.ProcessEnv,
): Oversight {
  try {
    const raw = env?.['MYSHELL_OVERSIGHT'];
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase();
      const mapped = ENV_LEVELS[v];
      if (mapped !== undefined) return mapped;
    }
    // VALIDATE the config value too — `loadConfig` JSON.parses without field checks, so a
    // hand-edited / corrupted `"oversight": "bogus"` must fall to the safe default, not pass
    // through verbatim (honouring this function's "any surprise → the safe default" contract).
    const fromConfig = config?.oversight;
    if (fromConfig === 'review-all' || fromConfig === 'checkpoint' || fromConfig === 'autonomous') {
      return fromConfig;
    }
    return 'checkpoint';
  } catch {
    return 'checkpoint';
  }
}

/**
 * WHY a launch checkpoint fires.
 *   - 'review-all-diff' → the cautious 'review-all' persona's per-diff review.
 *   - 'standing-rule'   → a user-authored STANDING RULE (Phase 4) matched the goal
 *                         about to launch: a 'pause' rule pauses for confirm, a
 *                         'block' rule refuses + explains, a 'prefer' rule surfaces
 *                         the preference. Carried on the {@link LaunchCheckpoint}.
 */
export type LaunchCheckpointReason = 'review-all-diff' | 'standing-rule';

/** The standing-rule decision flavour: refuse / confirm-first / inform. */
type StandingRuleAction = 'block' | 'pause' | 'prefer';

/** A decision to pause before a unit of work proceeds, with the reason it fired. */
export interface LaunchCheckpoint {
  readonly reason: LaunchCheckpointReason;
  /**
   * Present ONLY when reason === 'standing-rule': what the matched rule does
   * ('block' refuse / 'pause' confirm / 'prefer' inform) and the rule's own text,
   * so the caller can render the right prompt/explanation. Absent for the
   * 'review-all-diff' reason → byte-identical to the pre-Phase-4 checkpoint.
   */
  readonly rule?: {
    readonly action: StandingRuleAction;
    readonly text: string;
  };
}

/** A matched standing rule, reduced to what the gate needs (pure — no Rule import). */
export interface MatchedStandingRule {
  readonly kind: StandingRuleAction;
  readonly text: string;
}

/**
 * THE STANDING-RULES LAUNCH GATE (Phase 4) — the pure decision for whether a goal
 * about to go PROPOSED → RUNNING must pause/block/inform because a user rule
 * matched it. The interface layer runs the (impure) store read + `matchRules` and
 * passes the matched rules here in PRECEDENCE order (block → pause → prefer); this
 * returns the FIRST actionable checkpoint, or `null` when nothing matched (→ the
 * launch proceeds exactly as today). PURE — the caller owns the UI prompt.
 *
 * A 'block' rule and a 'pause' rule both pause the launch (the caller must stop and
 * either refuse or confirm); a lone 'prefer' rule ALSO surfaces as a checkpoint so
 * the caller can show the preference before proceeding — but the caller treats
 * 'prefer' as inform-and-continue, never a hard stop.
 */
export function standingRuleCheckpoint(
  matched: readonly MatchedStandingRule[],
): LaunchCheckpoint | null {
  if (!Array.isArray(matched) || matched.length === 0) return null;
  // matchRules already returns block → pause → prefer order; take the strongest.
  const first = matched[0];
  if (first === undefined) return null;
  return { reason: 'standing-rule', rule: { action: first.kind, text: first.text } };
}

/**
 * THE REUSABLE LAUNCH-CHECKPOINT SEAM (the Phase-4 extension point).
 *
 * Consulted before a goal/to-do goes from PROPOSED → RUNNING (and, for the manager
 * cycle, before each to-do's verified diff is committed to "done"). Returns a
 * {@link LaunchCheckpoint} when the run should PAUSE for the user, or `null` to
 * proceed without interruption. PURE — the caller owns the actual UI prompt; this
 * only decides whether to pause and why.
 *
 * Today it fires ONLY for the cautious 'review-all' persona, and only at the
 * `phase: 'per-todo-diff'` site (the per-diff review) when there is a real diff to
 * show (`hasDiff`). 'checkpoint' and 'autonomous' never pause here (their launch-time
 * behaviour — confirm vs. skip-confirm — is handled at the proposal site, not this
 * per-diff hook). When a future phase adds a standing-rules gate it adds a clause +
 * a reason here, and every existing call site honours it for free.
 */
export function shouldPauseBeforeLaunch(args: {
  readonly oversight: Oversight;
  /** Which checkpoint site is asking. */
  readonly phase: 'per-todo-diff';
  /** Whether the worker turn produced a real diff worth reviewing. */
  readonly hasDiff: boolean;
}): LaunchCheckpoint | null {
  // review-all: pause to review each to-do's diff before marking it done.
  if (args.oversight === 'review-all' && args.phase === 'per-todo-diff' && args.hasDiff) {
    return { reason: 'review-all-diff' };
  }
  return null;
}
