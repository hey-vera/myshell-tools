/**
 * src/interface/menu-goal-review-wiring.ts — Wiring helper that connects the
 * Goal Steward deterministic audit engine to the conversation-open flow.
 *
 * Called once per conversation-open; checks the flag, audits linked goals,
 * selects the top finding, renders a single review prompt, reads one key,
 * and dispatches the action to the goal store.
 *
 * No model calls. No autonomous execution. No network.
 */

import { goalStewardEnabled } from './ui/goal-steward-flag.js';
import { auditGoals, selectTopFinding } from '../core/goal-steward.js';
import type { GoalFinding } from '../core/goal-steward.js';
import type { Goal } from '../core/goal-todo.js';
import type { GoalStore } from '../infra/goal-store.js';
import { renderGoalReviewPrompt, ageDays } from './menu-goal-review.js';
import type { OutputSink } from './render.js';
import type { Clock } from '../core/types.js';
import type { KeyInputStream } from './menu-readline.js';

/**
 * Dependencies injected by the menu loop so the wiring is testable without
 * touching the real TTY or filesystem.
 */
export interface GoalReviewWiringDeps {
  readonly goalStore: GoalStore;
  readonly clock: Clock;
  readonly out: OutputSink;
  readonly readLine: () => Promise<string | null>;
  /**
   * Single-key reader (imported readMenuKey). Called for most prompts;
   * the wiring will call it with forceLine=false and the same inkReadKey.
   */
  readonly readMenuKey: (
    out: OutputSink,
    readLine: () => Promise<string | null>,
    stdin?: KeyInputStream,
    forceLine?: boolean,
    inkReadKey?: () => Promise<string>,
  ) => Promise<string | null>;
  /** Optional Ink single-key reader, forwarded to readMenuKey. */
  readonly inkReadKey?: (() => Promise<string>) | undefined;
  /** Flag gate: env + config. Defaults to process.env if omitted. */
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: { experimentalGoalSteward?: boolean };
}

/**
 * Handle the action for a given finding + user-chosen key.
 * Mutations go through the goal store. Never calls a model.
 */
async function dispatchAction(
  deps: GoalReviewWiringDeps,
  finding: GoalFinding,
  goalTitle: string,
  key: string,
): Promise<void> {
  const { goalStore, out } = deps;
  const gid = finding.goalId;

  if (finding.classification === 'inactive') {
    switch (key) {
      case 'r': {
        out.write('\n');
        await goalStore.setState(gid, 'running');
        return;
      }
      case 'a': {
        out.write('\nWhat changed? You can describe it in the chat below.\n\n');
        return;
      }
      case 'd': {
        await goalStore.patchGoal(gid, {});
        return;
      }
      case 'x': {
        out.write('\n');
        await goalStore.setState(gid, 'failed');
        return;
      }
      default:
        return;
    }
  }

  if (finding.classification === 'stale') {
    switch (key) {
      case 'r': {
        out.write('\n');
        await goalStore.setState(gid, 'running');
        return;
      }
      case 'u': {
        out.write(`\n"${goalTitle}" — type your update in the chat below.\n\n`);
        return;
      }
      case 'x': {
        out.write('\n');
        await goalStore.setState(gid, 'failed');
        return;
      }
      case '': {
        // Enter = Skip — bump lastTouched
        await goalStore.patchGoal(gid, {});
        return;
      }
      default:
        return;
    }
  }

  if (finding.classification === 'blocked') {
    // key is the full line from readLine, or empty for skip
    const trimmed = key.trim();
    if (trimmed.length > 0) {
      out.write(`\nNoted. Your answer will be addressed in the chat.\n\n`);
    }
    // Either way, bump lastTouched so it is not re-flagged immediately.
    await goalStore.patchGoal(gid, {});
    return;
  }

  if (finding.classification === 'verified-complete') {
    if (finding.recommendedAction === 'resolve-done') {
      if (key === 'y') {
        out.write('\n');
        const result = await goalStore.markVerifiedComplete(gid);
        if (result !== null) {
          out.write(`"${goalTitle}" marked done.\n\n`);
        } else {
          out.write(`Could not mark "${goalTitle}" done — precondition failed.\n\n`);
        }
        return;
      }
      // 'n' or anything else → no-op
      return;
    }

    // done-but-unverified
    switch (key) {
      case 'd': {
        await goalStore.patchGoal(gid, {});
        return;
      }
      case 'x': {
        out.write('\n');
        await goalStore.setState(gid, 'failed');
        return;
      }
      case 'r':
      default: {
        return;
      }
    }
  }
}

/**
 * Run the goal review flow for one conversation, before the chat loop starts.
 *
 * When the flag is OFF, this is a no-op (returns immediately). When ON:
 * 1. Lists goals linked to the conversation.
 * 2. Runs the deterministic audit.
 * 3. Selects the single top review-worthy finding.
 * 4. If one exists, renders the prompt and reads ONE key.
 * 5. Dispatches the action to the goal store.
 *
 * Returns `true` when the caller should proceed to the chat loop,
 * `false` when the user Ctrl-C / EOF'd during the prompt (→ exit).
 */
export async function reviewConversationGoals(
  deps: GoalReviewWiringDeps,
  conversationId: string,
): Promise<boolean> {
  const stewardOn = goalStewardEnabled(deps.env, deps.config);
  if (!stewardOn) return true;

  const goals = await deps.goalStore.listByConversation(conversationId).catch(() => [] as Goal[]);
  if (goals.length === 0) return true;

  const findings = auditGoals({
    goals,
    nowMs: deps.clock.now(),
  });

  const top = selectTopFinding(findings, { conversationId });
  if (top === null || top.recommendedAction === 'none') return true;

  const goal = goals.find((g) => g.id === top.goalId);
  if (goal === undefined) return true;

  const days = ageDays(goal.lastTouched, deps.clock.now());
  const prompt = renderGoalReviewPrompt(top, goal.title, days);

  if (prompt.prompt.length === 0) return true;

  deps.out.write(prompt.prompt);

  if (prompt.isTextInput) {
    deps.out.write('> ');
    const answer = await deps.readLine();
    if (answer === null) return false; // Ctrl-C / EOF → exit
    await dispatchAction(deps, top, goal.title, answer);
    return true;
  }

  const key = await deps.readMenuKey(deps.out, deps.readLine, undefined, false, deps.inkReadKey);
  if (key === null) return false; // Ctrl-C / EOF → exit

  await dispatchAction(deps, top, goal.title, key);
  return true;
}
