/**
 * src/core/resume-goal-orientation.ts — pure partner orientation for parked /
 * inactive goals on conversation resume (P0.16).
 *
 * On resume the chat already shows a ※ recap of *where the thread was*. This
 * helper adds a brief natural line about *open goals the partner should engage*
 * (status + next action or resume/drop/adjust), so the tool does not look stuck
 * next to parked work. PURE: no I/O, no wall clock, no randomness — the menu
 * loads real goals from the goal store and calls this once per resume session.
 *
 * Distinct from Goal Steward (flag-gated interactive audit with a 30-day stale
 * window): this is always-available orientation for any live parked/inactive
 * goal linked to the conversation or workspace. Never invents goals.
 */

import type { Goal, GoalState } from './goal-todo.js';
import { formatTodoCount, roadmapProgress } from './goal-todo.js';

/** Hard cap so orientation stays a line, not a second board. */
export const RESUME_GOAL_ORIENTATION_MAX_CHARS = 240;

/** How many goals to name in the orientation line. */
const NAME_CAP = 2;

/** States the partner should address on resume (non-terminal live work). */
const PARTNER_STATES: ReadonlySet<GoalState> = new Set([
  'parked',
  'blocked',
  'running',
  'queued',
]);

/** Attention rank: blocked first, then active work, then parked plans. */
const STATE_RANK: Record<GoalState, number> = {
  blocked: 0,
  running: 1,
  queued: 2,
  parked: 3,
  done: 9,
  failed: 9,
  superseded: 9,
};

export interface ResumeGoalOrientationScope {
  readonly conversationId: string;
  /**
   * Privacy-preserving project key for the conversation workspace, or null when
   * unknown / global-only. Used to include unattached workspace goals.
   */
  readonly projectKey?: string | null;
}

/**
 * Whether a goal is in scope for resume partnering: live (non-terminal) and either
 * linked to this conversation or to the current workspace project. Pure.
 */
export function isResumePartnerGoal(
  goal: Goal,
  scope: ResumeGoalOrientationScope,
): boolean {
  if (!PARTNER_STATES.has(goal.state)) return false;
  if (goal.conversationId === scope.conversationId) return true;
  const pk = scope.projectKey;
  if (pk !== undefined && pk !== null && goal.projectKey === pk) return true;
  return false;
}

/**
 * Select + order goals the partner should address on resume. Attention rank
 * (blocked → running → queued → parked), stable within rank. Pure; never mutates.
 */
export function selectResumePartnerGoals(
  goals: readonly Goal[],
  scope: ResumeGoalOrientationScope,
): Goal[] {
  if (goals.length === 0) return [];
  const ranked: Array<{ readonly g: Goal; readonly i: number }> = [];
  for (let i = 0; i < goals.length; i += 1) {
    const g = goals[i];
    if (g === undefined || !isResumePartnerGoal(g, scope)) continue;
    ranked.push({ g, i });
  }
  ranked.sort((a, b) => STATE_RANK[a.g.state] - STATE_RANK[b.g.state] || a.i - b.i);
  return ranked.map((x) => x.g);
}

/**
 * First open roadmap step text for orientation, or undefined when none.
 * Uses status (pending/active, then blocked) — not the manager-cycle
 * verified-done bar — so the resume line matches what the user sees as unfinished.
 * Pure.
 */
function nextStepText(goal: Goal): string | undefined {
  const open = goal.roadmap.find(
    (it) => it.status === 'pending' || it.status === 'active',
  );
  if (open !== undefined && open.text.trim().length > 0) return open.text.trim();
  const blocked = goal.roadmap.find((it) => it.status === 'blocked');
  if (blocked !== undefined && blocked.text.trim().length > 0) return blocked.text.trim();
  return undefined;
}

function stateLabel(state: GoalState): string {
  switch (state) {
    case 'parked':
      return 'parked';
    case 'blocked':
      return 'blocked';
    case 'running':
      return 'in progress';
    case 'queued':
      return 'queued';
    default:
      return state;
  }
}

function quoteTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  // Bound a runaway title so the whole line stays orientation-sized.
  const capped = t.length > 64 ? `${t.slice(0, 63).trimEnd()}…` : t;
  return `“${capped}”`;
}

function shortNext(step: string): string {
  const s = step.replace(/\s+/g, ' ').trim();
  return s.length > 72 ? `${s.slice(0, 71).trimEnd()}…` : s;
}

/**
 * One-goal orientation body: status + optional next step + resume/drop/adjust
 * (or clear next action). Pure.
 */
function formatOneGoal(goal: Goal): string {
  const title = quoteTitle(goal.title);
  const prog = roadmapProgress(goal.roadmap);
  const count =
    prog.total > 0 ? ` (${formatTodoCount(goal.roadmap)})` : '';
  const next = nextStepText(goal);

  if (goal.state === 'blocked') {
    const need = next !== undefined ? ` — needs: ${shortNext(next)}` : ' — needs input';
    return `Blocked: ${title}${count}${need}. Unblock, drop, or adjust?`;
  }
  if (goal.state === 'running') {
    if (next !== undefined) {
      return `In progress: ${title}${count} — next: ${shortNext(next)}. Keep going, pause, or adjust?`;
    }
    return `In progress: ${title}${count}. Keep going, pause, or adjust?`;
  }
  if (goal.state === 'queued') {
    if (next !== undefined) {
      return `Queued: ${title}${count} — next: ${shortNext(next)}. Start it, drop, or adjust?`;
    }
    return `Queued: ${title}${count}. Start it, drop, or adjust?`;
  }
  // parked (default inactive)
  if (next !== undefined) {
    return `Parked: ${title}${count} — next: ${shortNext(next)}. Resume, drop, or adjust?`;
  }
  return `Parked: ${title}${count}. Resume, drop, or adjust — or say what's next.`;
}

/**
 * Multi-goal orientation: brief status list + a single call-to-action. Pure.
 */
function formatManyGoals(goals: readonly Goal[]): string {
  const named = goals.slice(0, NAME_CAP);
  const rest = goals.length - named.length;
  const bits = named.map((g) => {
    const next = nextStepText(g);
    const head = `${stateLabel(g.state)} ${quoteTitle(g.title)}`;
    return next !== undefined ? `${head} (next: ${shortNext(next)})` : head;
  });
  let list = bits.join('; ');
  if (rest > 0) list += `; +${String(rest)} more`;
  const n = goals.length;
  return `${String(n)} open goals: ${list}. Resume one, drop, or adjust?`;
}

/**
 * Cap a finished orientation string to {@link RESUME_GOAL_ORIENTATION_MAX_CHARS}.
 * Pure.
 */
function capOrientation(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= RESUME_GOAL_ORIENTATION_MAX_CHARS) return s;
  return `${s.slice(0, RESUME_GOAL_ORIENTATION_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Build a brief natural partner orientation line for parked/inactive goals on
 * resume, or `null` when there is nothing to address. NEVER invents goals —
 * only shapes the caller-supplied store snapshot. Pure; never throws.
 *
 * @param goals Full or filtered goal list (caller loads from goal store).
 * @param scope Conversation (+ optional project) scope for selection.
 */
export function buildResumeGoalOrientation(
  goals: readonly Goal[],
  scope: ResumeGoalOrientationScope,
): string | null {
  try {
    const selected = selectResumePartnerGoals(goals, scope);
    const first = selected[0];
    if (first === undefined) return null;
    const body =
      selected.length === 1 ? formatOneGoal(first) : formatManyGoals(selected);
    const capped = capOrientation(body);
    return capped.length > 0 ? capped : null;
  } catch {
    return null;
  }
}
