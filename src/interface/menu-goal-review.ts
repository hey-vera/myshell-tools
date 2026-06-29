/**
 * src/interface/menu-goal-review.ts — Presenter for the Goal Steward
 * conversation-open review prompt (Phase 6 first slice).
 *
 * Pure-ish: takes a GoalFinding + goal metadata and returns the prompt
 * text + valid action keys. No I/O, no model calls, no mutations.
 *
 * Mirrors the three prompt shapes from docs/menu-ia-and-goals-redesign.md
 * "Conversation-Open UX" + "Smallest First Slice".
 */

import type { GoalFinding } from '../core/goal-steward.js';

/** Result of {@link renderGoalReviewPrompt}. */
export interface GoalReviewPrompt {
  /** The prompt text to display before reading the user's choice. */
  readonly prompt: string;
  /** Valid single-key responses the caller should accept. '' = Enter/skip. */
  readonly validKeys: readonly string[];
  /** When true, the caller should use readLine for a free-text answer. */
  readonly isTextInput: boolean;
}

/**
 * Compute whole-number days since lastTouched. Pure — both times are injected.
 * Returns 0 on unparseable input.
 */
export function ageDays(lastTouchedIso: string, nowMs: number): number {
  const then = Date.parse(lastTouchedIso);
  if (Number.isNaN(then) || nowMs <= then) return 0;
  return Math.floor((nowMs - then) / 86_400_000);
}

/**
 * Render the conversation-open goal review prompt for one finding.
 *
 * Returns the prompt text + the valid single-key responses. The caller is
 * responsible for executing the action against the goal store — this
 * function is a pure formatter.
 */
export function renderGoalReviewPrompt(
  finding: GoalFinding,
  goalTitle: string,
  days: number,
): GoalReviewPrompt {
  switch (finding.classification) {
    // ---- inactive (running/queued past stale window) -------------------------
    case 'inactive': {
      const label = finding.state === 'running' ? 'running, inactive' : 'queued, inactive';
      const age = days > 0 ? ` since ${days}d ago` : '';
      return {
        prompt:
          `\nGoals for this conversation\n` +
          `  ${goalTitle}  ${label}${age}\n` +
          `  Suggested: review and resume\n\n` +
          `  [r] Resume  [a] Ask what changed  [d] Dismiss for now  [x] Cancel goal`,
        validKeys: ['r', 'a', 'd', 'x'],
        isTextInput: false,
      };
    }

    // ---- stale (parked past stale window) ------------------------------------
    case 'stale': {
      return {
        prompt:
          `\nGoal review\n` +
          `  "${goalTitle}" has been parked for ${days} days.\n\n` +
          `  [r] Resume it  [u] Update the goal first  [x] Cancel it`,
        validKeys: ['r', 'u', 'x', ''],
        isTextInput: false,
      };
    }

    // ---- blocked -------------------------------------------------------------
    case 'blocked': {
      return {
        prompt:
          `\nGoal needs input\n` +
          `  "${goalTitle}" is blocked.\n` +
          `  ${finding.reason}\n\n` +
          `  Answer now, or press Enter to skip.`,
        validKeys: [''],
        isTextInput: true,
      };
    }

    // ---- verified-complete ---------------------------------------------------
    case 'verified-complete': {
      if (finding.recommendedAction === 'resolve-done') {
        return {
          prompt: `\nGoal complete\n  "${goalTitle}" is verified complete. Mark it done? (y/n) `,
          validKeys: ['y', 'n'],
          isTextInput: false,
        };
      }
      return {
        prompt:
          `\nGoal done\n` +
          `  "${goalTitle}" is done but not verified.\n` +
          `  ${finding.reason}\n\n` +
          `  [r] Review  [d] Dismiss  [x] Cancel goal`,
        validKeys: ['r', 'd', 'x'],
        isTextInput: false,
      };
    }

    // ---- fresh (should never surface as a review prompt) ---------------------
    default: {
      return { prompt: '', validKeys: [], isTextInput: false };
    }
  }
}
