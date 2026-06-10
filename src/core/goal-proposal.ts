/**
 * src/core/goal-proposal.ts — the PURE proposal renderer for the GOAL EXPERIENCE
 * (elite-partner Phase 2, "confident elite pro, not a passive black box").
 *
 * THE PROBLEM this fixes: the planning brain (goal-plan.ts) COMPUTES a rich plan —
 * a {@link GoalPlan} with a `vision`, per-goal `title`, ordered `todos`, intra-goal
 * dependency edges (`dependsOn`), and a best-`approach` (chosen + why, over
 * alternatives) — and then the menu DISCARDED it at the last inch (a dim 6-word
 * "※ Staged N goals" whisper, or a silent black-box `/goal` execution). The user
 * never saw the plan they were about to run.
 *
 * THE FIX: this module renders that plan the way a confident senior pro would
 * present it — "Here's how I'd tackle {vision}: {N} goals, {M} to-dos. Approach:
 * {chosen} over {alternatives} because {rationale}. Steps 3-4 build on 1-2." — so
 * the explicit `/goal` path can PROPOSE (then offer a one-tap go) and the auto-stage
 * note can say something REAL. Personality matches src/core/prompt.ts (the elite
 * voice + brutal honesty): confident, concrete, never a content-free whisper.
 *
 * PURE: no fs/path/child_process/Date/Math.random, never throws. It only SHAPES
 * text; the caller themes the dimming/colour. Fail-soft contract: an empty / `none`
 * / `clarify` plan with no goals renders `''` (the caller shows nothing), so this is
 * always additive — a plan with nothing to propose proposes nothing.
 */

import type { GoalPlan } from './goal-plan.js';
import type { SystemModel } from './understanding.js';

/**
 * Phrase a goal's intra-goal dependency edges as a plain cause→effect sentence —
 * e.g. "Steps 3-4 build on 1-2." — from the `dependsOn` INDEX markers a planned
 * goal carries. Returns `''` when the goal is flat (no real edges), so a dependency-
 * free plan adds NO noise. PURE, total.
 *
 * The phrasing is deliberately coarse (the SET of dependent step numbers → the SET
 * of step numbers they collectively build on, each as a compact range): an elite
 * pro says "the back half builds on the front half", not a graph dump. Indices are
 * the 1-based positions WITHIN this goal's todo list (they line up with the printed
 * checklist numbers).
 */
export function formatDependencyPhrase(todos: GoalPlan['goals'][number]['todos']): string {
  const dependents: number[] = []; // 1-based positions that have ≥1 real blocker
  const blockers = new Set<number>(); // 1-based positions named as a blocker
  todos.forEach((todo, i) => {
    const deps = (todo.dependsOn ?? []).filter((n) => n >= 1 && n < i + 1);
    if (deps.length === 0) return;
    dependents.push(i + 1);
    for (const n of deps) blockers.add(n);
  });
  if (dependents.length === 0 || blockers.size === 0) return '';
  const depPart = compactRanges(dependents);
  const blockPart = compactRanges([...blockers].sort((a, b) => a - b));
  const stepWord = dependents.length === 1 ? 'Step' : 'Steps';
  return `${stepWord} ${depPart} build on ${blockPart}.`;
}

/** Collapse a list of positive integers into compact ranges:
 *  [1,2,3,5] → "1-3, 5". PURE, total (empty → ''). Sorts + dedupes internally. */
function compactRanges(nums: readonly number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i] as number;
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? String(start) : `${String(start)}-${String(prev)}`);
    start = n;
    prev = n;
  }
  parts.push(start === prev ? String(start) : `${String(start)}-${String(prev)}`);
  return parts.join(', ');
}

/** Total to-do count across a plan's goals. PURE. */
function totalTodos(plan: GoalPlan): number {
  let n = 0;
  for (const g of plan.goals) n += g.todos.length;
  return n;
}

/**
 * Per-goal dropped-todo counts for the proposal renderer. An entry at index `i`
 * means `plan.goals[i]` had that many todos cut by the parser's cap. Omitted or
 * zero entries are silent — the output stays byte-identical to today's.
 *
 * ADDITIVE: callers that do not pass this stay byte-identical.
 */
export interface ProposalDroppedCounts {
  /** Dropped todos per goal, keyed by 0-based goal index. */
  readonly perGoalTodos?: ReadonlyMap<number, number>;
  /** How many goals were dropped by the goal cap (≥1 → "N goals not shown"). */
  readonly goals?: number;
}

/**
 * Render the CONFIDENT, full proposal for a staged plan — the headline of Phase 2.
 * Lines (themed by the caller; this is plain text):
 *  - a vision header ("Here's how I'd tackle {vision}: {N} goal(s), {M} to-do(s).")
 *    — or a generic "Here's the plan:" when the planner stated no vision;
 *  - per goal: a numbered title line, its best-APPROACH (chosen + over-alternatives
 *    + because-rationale) when present, the dependency cause→effect phrase when the
 *    goal has real edges, then its to-dos as a numbered `[ ]` checklist;
 *  - when `dropped` carries a non-zero dropped-todo count for a goal, appends a brief
 *    honest line "(kept the N highest-leverage steps; M more not shown)" — only when
 *    M>0 (strictly additive; no dropped items ⇒ byte-identical to today's output);
 *  - when `dropped.goals` > 0, appends a note at the end naming the dropped-goal count;
 *  - a blank line between goals.
 *
 * Returns `''` when there is nothing to propose (no `stage` verdict, or zero goals)
 * — the fail-soft contract, so the caller shows nothing rather than an empty box.
 * PURE, never throws.
 *
 * @param dropped  optional dropped-count hints (additive — absent ⇒ byte-identical).
 */
export function formatGoalProposal(plan: GoalPlan, dropped?: ProposalDroppedCounts): string {
  if (plan.judgment !== 'stage' || plan.goals.length === 0) return '';
  const goalCount = plan.goals.length;
  const todoCount = totalTodos(plan);
  const goalNoun = goalCount === 1 ? 'goal' : 'goals';
  const todoNoun = todoCount === 1 ? 'to-do' : 'to-dos';

  const lines: string[] = [];
  const vision = plan.vision?.trim();
  if (vision !== undefined && vision.length > 0) {
    lines.push(
      `Here's how I'd tackle ${vision}: ${String(goalCount)} ${goalNoun}, ${String(todoCount)} ${todoNoun}.`,
    );
  } else {
    lines.push(`Here's the plan: ${String(goalCount)} ${goalNoun}, ${String(todoCount)} ${todoNoun}.`);
  }

  plan.goals.forEach((goal, gi) => {
    lines.push('');
    lines.push(`${String(gi + 1)}. ${goal.title}`);

    const approach = goal.approach;
    if (approach !== undefined) {
      const chosen = approach.chosen.trim();
      if (chosen.length > 0) {
        const alts = (approach.alternatives ?? [])
          .map((a) => a.trim())
          .filter((a) => a.length > 0);
        const over = alts.length > 0 ? ` over ${alts.join(', ')}` : '';
        const rationale = approach.rationale.trim();
        const because = rationale.length > 0 ? ` — because ${rationale}` : '';
        lines.push(`   Approach: ${chosen}${over}${because}`);
      }
    }

    const dep = formatDependencyPhrase(goal.todos);
    if (dep.length > 0) lines.push(`   ${dep}`);

    goal.todos.forEach((todo, ti) => {
      lines.push(`   ${String(ti + 1)}. [ ] ${todo.text}`);
    });

    // Honest cap disclosure: only when something was dropped (additive — silent when 0).
    const droppedTodos = dropped?.perGoalTodos?.get(gi) ?? 0;
    if (droppedTodos > 0) {
      const kept = goal.todos.length;
      lines.push(
        `   (kept the ${String(kept)} highest-leverage step${kept === 1 ? '' : 's'}; ${String(droppedTodos)} more not shown)`,
      );
    }
  });

  // Honest goal-cap disclosure (additive — silent when 0).
  const droppedGoals = dropped?.goals ?? 0;
  if (droppedGoals > 0) {
    const goalWord = droppedGoals === 1 ? 'goal' : 'goals';
    lines.push(`\n(${String(droppedGoals)} additional ${goalWord} not shown — plan exceeded the ${String(goalCount + droppedGoals)}-goal cap)`);
  }

  return lines.join('\n');
}

/** Max heads-up findings to surface alongside a proposal — one or two, never a
 *  brain dump (mirrors prompt.ts's "one or two genuinely valuable anticipations"). */
const HEADS_UP_MAX = 2;

/**
 * PROACTIVE HEADS-UP — surface 1–2 adjacent findings the understanding pass already
 * computed (its genuinely-open questions + hard constraints) alongside the proposal,
 * so the partner says "heads up, X looks fragile" the way an elite pro would, instead
 * of throwing that raw material away. Open questions come first (the sharper "I'm not
 * sure about X" signal), then constraints (the "must respect Y" guardrail) to fill
 * the budget. Each line is a bare finding the caller prefixes with "heads up:" and
 * dims. NEVER fabricates — returns `[]` when there is no warm model or no findings,
 * so the fail-soft contract holds (none → nothing). PURE, total.
 */
export function formatHeadsUp(systemModel: SystemModel | undefined): string[] {
  if (systemModel === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (raw: string): void => {
    if (out.length >= HEADS_UP_MAX) return;
    const v = raw.trim();
    if (v.length === 0) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  for (const q of systemModel.openQuestions) take(q);
  for (const c of systemModel.constraints) take(c);
  return out;
}

/**
 * Render the BRIEF auto-stage note — the confident one-liner that REPLACES the dim
 * "※ Staged N goals on the board." whisper. It names the goal title(s) (capped) and
 * the to-do count, then asks the frictionless go-ahead — still a single non-blocking
 * line (the caller keeps the fire-and-forget + conversationLive guard; this only
 * shapes the text). Returns `''` when nothing was staged (the caller shows nothing).
 *
 * When `droppedGoals` > 0, appends a brief honest tail noting how many additional
 * goals the plan contained but were not staged (the cap was hit). Only when >0 —
 * zero ⇒ byte-identical to today's output (strictly additive). PURE, total.
 *
 * @param titles       the staged goal titles, in order (already deduped by the caller).
 * @param todoCount    total to-dos across the staged goals (for the "N to-dos" count).
 * @param droppedGoals how many goals were dropped by the goal cap (omit or 0 ⇒ silent).
 * PURE, total — never throws.
 */
export function formatAutoStageNote(
  titles: readonly string[],
  todoCount: number,
  droppedGoals = 0,
): string {
  const clean = titles.map((t) => t.trim()).filter((t) => t.length > 0);
  if (clean.length === 0) return '';
  const NAME_CAP = 2; // name the first couple; "+N more" beyond
  const named = clean.slice(0, NAME_CAP);
  const extra = clean.length - named.length;
  let titlePart = named.join('; ');
  if (extra > 0) titlePart += ` (+${String(extra)} more)`;
  const goalNoun = clean.length === 1 ? 'goal' : 'goals';
  const todoNoun = todoCount === 1 ? 'to-do' : 'to-dos';
  const countPart = todoCount > 0 ? ` · ${String(todoCount)} ${todoNoun}` : '';
  const dropped = Math.max(0, Math.floor(droppedGoals));
  const droppedPart =
    dropped > 0
      ? ` · ${String(dropped)} more goal${dropped === 1 ? '' : 's'} not staged (plan exceeded cap)`
      : '';
  return `Staged ${String(clean.length)} ${goalNoun} on the board: ${titlePart}${countPart}${droppedPart} · shall I start?`;
}
