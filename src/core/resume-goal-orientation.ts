/**
 * src/core/resume-goal-orientation.ts — pure partner orientation for parked /
 * inactive goals on conversation resume (P0.16) + standing rewatch context
 * inject for the first model turn (PR-E goal rewatch+) + P2.6 stewardship act
 * proposals (concrete next step; never silent museum; never auto-mutates).
 *
 * On resume the chat already shows a ※ recap of *where the thread was*. This
 * helper adds a brief natural line about *open goals the partner should engage*
 * (status + next action or resume/drop/adjust), so the tool does not look stuck
 * next to parked work. PURE: no I/O, no wall clock, no randomness — the menu
 * loads real goals from the goal store and calls this once per resume session.
 *
 * Standing rewatch+: the same selection also shapes a short SYSTEM/context
 * block ({@link buildGoalRewatchContext}) so the *model* sees parked/blocked
 * goals on the first turn after open — not only a one-shot dim user line.
 *
 * Stewardship act (P2.6): {@link buildGoalStewardshipActLine} proposes a
 * concrete next step after turn-end or on multi-goal rewatch. Propose only —
 * do NOT auto-mutate goals without gates.
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

/**
 * Header for the standing-goals rewatch context block (first-turn partner
 * inject). Kept short so the model can act without a wall of ceremony.
 */
export const GOAL_REWATCH_CONTEXT_HEADER =
  'STANDING GOALS REWATCH (open work — engage; resume, drop, adjust, or act when relevant):';

/**
 * Build a short partner-context block for standing goals rewatch, or `null`
 * when there is nothing to address. Reuses {@link buildResumeGoalOrientation}
 * for the body so the user-facing dim line and model inject stay consistent.
 * PURE; never invents goals; never throws.
 *
 * Intended for **first model turn after conversation open** (session latch in
 * menu) — not every turn (board + CURRENT GOALS already carry ongoing plan).
 */
export function buildGoalRewatchContext(
  goals: readonly Goal[],
  scope: ResumeGoalOrientationScope,
): string | null {
  try {
    const line = buildResumeGoalOrientation(goals, scope);
    if (line === null) return null;
    const block = `${GOAL_REWATCH_CONTEXT_HEADER}\n${line}`;
    // P2.6: when multiple goals need attention, fold a concrete stewardship act
    // line so the model can pick one to act on (not a silent multi-goal museum).
    // Single-goal rewatch already carries next-step + resume/drop/adjust.
    const proposals = selectGoalStewardshipActProposals(goals, scope);
    if (proposals.length >= 2) {
      const act = buildGoalStewardshipActLine(goals, scope);
      const withAct = mergeStewardshipActIntoRewatch(block, act);
      if (withAct !== null && withAct.trim().length > 0) return withAct;
    }
    return block.trim().length > 0 ? block : null;
  } catch {
    return null;
  }
}

/**
 * Prepend a standing rewatch block onto the CURRENT GOALS plan string for a
 * one-shot first-turn inject. Empty/null rewatch leaves plan unchanged; empty
 * plan with rewatch yields rewatch alone. Pure; never throws.
 */
export function mergeGoalRewatchIntoContext(
  planContext: string,
  rewatchContext: string | null | undefined,
): string {
  try {
    const plan = typeof planContext === 'string' ? planContext.trim() : '';
    const rewatch =
      typeof rewatchContext === 'string' ? rewatchContext.trim() : '';
    if (rewatch.length === 0) return plan;
    if (plan.length === 0) return rewatch;
    return `${rewatch}\n\n${plan}`;
  } catch {
    return typeof planContext === 'string' ? planContext : '';
  }
}

// ---------------------------------------------------------------------------
// P2.6 — Parallel goal stewardship that acts (propose, never silent museum)
// ---------------------------------------------------------------------------

/** Hard cap so a post-turn stewardship line stays orientation-sized. */
export const GOAL_STEWARDSHIP_ACT_MAX_CHARS = 240;

/** How many goals to name in a multi-goal stewardship line. */
const STEWARD_NAME_CAP = 2;

/**
 * Risk band for a stewardship proposal. `low` = parked/queued with a clear
 * next step (partner may propose acting). `needs-user` = blocked or unclear
 * (partner proposes unblock/review only). Never auto-mutates goals.
 */
export type GoalStewardshipRisk = 'low' | 'needs-user';

/** One concrete next-step proposal for an open goal. PURE data only. */
export interface GoalStewardshipActProposal {
  readonly goalId: string;
  readonly title: string;
  readonly state: GoalState;
  readonly nextAction: string | undefined;
  readonly risk: GoalStewardshipRisk;
}

/**
 * Build act-proposals for in-scope partner goals that need attention.
 * PURE: never mutates goals; never invents next steps (only real roadmap text).
 *
 * - parked/queued with a clear next step → low risk (propose "say go" / act)
 * - blocked → needs-user (propose unblock)
 * - running without a next step still surfaces (keep going / adjust)
 * - terminal goals excluded via {@link selectResumePartnerGoals}
 */
export function selectGoalStewardshipActProposals(
  goals: readonly Goal[],
  scope: ResumeGoalOrientationScope,
): GoalStewardshipActProposal[] {
  try {
    const selected = selectResumePartnerGoals(goals, scope);
    const out: GoalStewardshipActProposal[] = [];
    for (const g of selected) {
      const next = nextStepText(g);
      const risk: GoalStewardshipRisk =
        g.state === 'blocked' || next === undefined ? 'needs-user' : 'low';
      // Running without a next still has a clear keep-going posture → low if
      // we have any next step; otherwise needs-user (ask what's next).
      const runningRisk: GoalStewardshipRisk =
        g.state === 'running' && next === undefined ? 'needs-user' : risk;
      out.push({
        goalId: g.id,
        title: g.title,
        state: g.state,
        nextAction: next,
        risk: g.state === 'running' ? runningRisk : risk,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One user-facing stewardship line that proposes a concrete next step (or
 * multi-goal attention), or `null` when nothing to steward. NEVER mutates
 * goals — only shapes caller-supplied store snapshots. Pure; never throws.
 *
 * Prefer emitting after a successful turn when ≥1 open goals need attention,
 * and folding into rewatch context so the partner is not a silent museum.
 */
export function buildGoalStewardshipActLine(
  goals: readonly Goal[],
  scope: ResumeGoalOrientationScope,
): string | null {
  try {
    const proposals = selectGoalStewardshipActProposals(goals, scope);
    const first = proposals[0];
    if (first === undefined) return null;
    const body =
      proposals.length === 1
        ? formatOneStewardshipAct(first)
        : formatManyStewardshipActs(proposals);
    const capped = capStewardship(body);
    return capped.length > 0 ? capped : null;
  } catch {
    return null;
  }
}

/**
 * Enrich a rewatch context block with a concrete stewardship act line when
 * present. Pure; never invents; leaves rewatch unchanged when act is null.
 */
export function mergeStewardshipActIntoRewatch(
  rewatchContext: string | null | undefined,
  actLine: string | null | undefined,
): string | null {
  try {
    const rewatch =
      typeof rewatchContext === 'string' ? rewatchContext.trim() : '';
    const act = typeof actLine === 'string' ? actLine.trim() : '';
    if (rewatch.length === 0 && act.length === 0) return null;
    if (act.length === 0) return rewatch.length > 0 ? rewatch : null;
    if (rewatch.length === 0) {
      return `${GOAL_REWATCH_CONTEXT_HEADER}\n${act}`;
    }
    // Avoid duplicating when rewatch body already carries the same next text.
    if (rewatch.includes(act)) return rewatch;
    return `${rewatch}\nSteward next: ${act}`;
  } catch {
    return typeof rewatchContext === 'string' ? rewatchContext : null;
  }
}

function formatOneStewardshipAct(p: GoalStewardshipActProposal): string {
  const title = quoteTitle(p.title);
  if (p.state === 'blocked') {
    const need =
      p.nextAction !== undefined
        ? ` — needs: ${shortNext(p.nextAction)}`
        : ' — needs input';
    return `Steward: blocked ${title}${need}. Unblock or adjust — not auto-acting.`;
  }
  if (p.nextAction !== undefined) {
    const verb =
      p.state === 'running'
        ? 'Keep going'
        : p.state === 'queued'
          ? 'Start'
          : 'Say go to resume';
    return `Steward: ${stateLabel(p.state)} ${title} — next: ${shortNext(p.nextAction)}. ${verb}, drop, or adjust.`;
  }
  return `Steward: ${stateLabel(p.state)} ${title}. Say what's next, drop, or adjust.`;
}

function formatManyStewardshipActs(
  proposals: readonly GoalStewardshipActProposal[],
): string {
  const named = proposals.slice(0, STEWARD_NAME_CAP);
  const rest = proposals.length - named.length;
  const bits = named.map((p) => {
    const head = `${stateLabel(p.state)} ${quoteTitle(p.title)}`;
    return p.nextAction !== undefined
      ? `${head} (next: ${shortNext(p.nextAction)})`
      : head;
  });
  let list = bits.join('; ');
  if (rest > 0) list += `; +${String(rest)} more`;
  const n = proposals.length;
  const lowCount = proposals.filter((p) => p.risk === 'low').length;
  const actHint =
    lowCount > 0
      ? 'Pick one to act on (say go / resume), drop, or adjust'
      : 'Unblock, drop, or adjust';
  return `Steward: ${String(n)} goals need attention — ${list}. ${actHint}.`;
}

function capStewardship(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= GOAL_STEWARDSHIP_ACT_MAX_CHARS) return s;
  return `${s.slice(0, GOAL_STEWARDSHIP_ACT_MAX_CHARS - 1).trimEnd()}…`;
}
