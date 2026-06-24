/**
 * src/commands/goals.ts — the shared command logic for the unified goal /
 * to-do feature (vision doc .tmp-vision-todos.md §5, Phase 5a — MANUAL only).
 *
 * THE MODEL: a to-do is a step of a parked GOAL's roadmap. These handlers let a
 * user CREATE a parked goal (`/todo <text>`), LIST goals by state (`/goals`),
 * EXPAND a parked goal to see + check off its to-dos, PROMOTE a parked goal
 * (→ runGoalLoop, which runs the adaptive brain → RE-VALIDATES the provisional
 * roadmap against reality before acting), mark a to-do done/blocked, and remove
 * a goal. The chat-loop dispatch in menu.ts is a thin shim onto these.
 *
 * Design (mirrors src/commands/memory.ts):
 *   - Each handler takes an injected `OutputSink` + injected `readLine` (so the
 *     numbered pickers are testable WITHOUT a TTY — same pattern as
 *     runQuestionSelector / the memory selectors) + the `GoalStore`.
 *   - NO model call: creating/managing a manual to-do is subscription-clean —
 *     it never costs a turn. The ONLY brain involvement is on PROMOTE, which is
 *     the interface layer handing the goal title to runGoalLoop (NOT here).
 *
 * HARD RULE (owner): a parked goal's to-dos are PROVISIONAL. This module never
 * executes a roadmap. Promotion sets state then returns the goal to the caller,
 * which runs it through runGoalLoop (the adaptive brain) so the roadmap is
 * re-validated against current reality before any action — never run blindly.
 */

import type { OutputSink } from '../interface/render.js';
import { dim, green, bold } from '../ui/theme.js';
import type { AddRoadmapItemResult, GoalStore } from '../infra/goal-store.js';
import {
  formatGoalRow,
  formatTodoCount,
  formatRoadmapLines,
  formatGoalApproachLine,
  isStale,
  type Goal,
} from '../core/goal-todo.js';
import type { RoadmapItem } from '../core/work-contract.js';

// ---------------------------------------------------------------------------
// Pure arg parsing — `/goals <sub> [args]` and `/todo <text>`
// ---------------------------------------------------------------------------

export type GoalsCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'go'; readonly n: number }
  | { readonly kind: 'drop'; readonly n: number }
  | { readonly kind: 'cancel'; readonly n: number }
  | { readonly kind: 'park'; readonly n: number }
  | { readonly kind: 'show'; readonly n: number }
  | { readonly kind: 'usage' };

/**
 * Parse the argument string after `/goals`. Pure, never throws. Bare or `list`
 * → list; `go|drop|cancel|park|show <n>` → that op on parked goal #n (1-based); an
 * unrecognised form → usage.
 */
export function parseGoalsCommand(arg: string): GoalsCommand {
  const trimmed = (arg ?? '').trim();
  if (trimmed === '' || trimmed === 'list') return { kind: 'list' };
  const m = /^(go|drop|cancel|park|show|expand)\s+(\d+)$/.exec(trimmed);
  if (m !== null) {
    const n = Number.parseInt(m[2] ?? '', 10);
    const verb = m[1];
    if (Number.isFinite(n) && n >= 1) {
      if (verb === 'go') return { kind: 'go', n };
      if (verb === 'drop') return { kind: 'drop', n };
      if (verb === 'cancel') return { kind: 'cancel', n };
      if (verb === 'park') return { kind: 'park', n };
      return { kind: 'show', n }; // show | expand
    }
  }
  // `/goals <n>` on its own = expand parked goal #n.
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare !== null) {
    const n = Number.parseInt(bare[1] ?? '', 10);
    if (Number.isFinite(n) && n >= 1) return { kind: 'show', n };
  }
  return { kind: 'usage' };
}

/**
 * Parse the `/todo` subcommands. Pure, never throws. Numbers are 1-based and
 * match the `/goals` listing order (`g` = parked-goal index, `n` = to-do index):
 *   - `done|block <g> <n>`        → mark a to-do's status
 *   - `add <g> <new text>`        → add a new to-do to existing parked goal #g
 *   - anything else               → create a parked goal from the free text
 *
 * NOTE (owner's explicit clarification): the to-do list is the PARTNER's automatic
 * ability, not a manual chore. The `edit` / `move` / `rm` subcommands were RETIRED
 * — the manager cycle's automatic re-plan pass (goal-replan*.ts) now maintains the
 * to-do list itself (add/edit/reorder/prune) via the store CRUD. The remaining
 * subcommands are only the quick-capture conveniences (`/todo <text>` park, `add`,
 * `done`/`block`), never plan-restructuring ones.
 */
export type TodoCommand =
  | { readonly kind: 'create'; readonly text: string }
  | { readonly kind: 'mark'; readonly status: 'done' | 'blocked'; readonly g: number; readonly n: number }
  | { readonly kind: 'add'; readonly g: number; readonly text: string }
  | { readonly kind: 'usage' };

export function parseTodoCommand(arg: string): TodoCommand {
  const trimmed = (arg ?? '').trim();
  if (trimmed === '') return { kind: 'usage' };

  // add <g> <new text> — append a to-do to existing parked goal #g.
  const add = /^add\s+(\d+)\s+(.+)$/s.exec(trimmed);
  if (add !== null) {
    const g = Number.parseInt(add[1] ?? '', 10);
    const text = (add[2] ?? '').trim();
    if (Number.isFinite(g) && g >= 1 && text.length > 0) {
      return { kind: 'add', g, text };
    }
  }

  const mark = /^(done|block|blocked)\s+(\d+)\s+(\d+)$/.exec(trimmed);
  if (mark !== null) {
    const g = Number.parseInt(mark[2] ?? '', 10);
    const n = Number.parseInt(mark[3] ?? '', 10);
    if (Number.isFinite(g) && g >= 1 && Number.isFinite(n) && n >= 1) {
      return { kind: 'mark', status: mark[1] === 'done' ? 'done' : 'blocked', g, n };
    }
  }

  return { kind: 'create', text: trimmed };
}

// ---------------------------------------------------------------------------
// Render: the Goals-by-state section (used by the menu + `/goals`)
// ---------------------------------------------------------------------------

/**
 * The PARKED-goals section lines (vision doc §5). Returns [] when there are no
 * parked goals — the menu only renders the section when non-empty (no clutter).
 * Each row is themed (dim when stale). Pure-ish: I/O-free, takes the goal list +
 * nowIso + color flag. Stale goals are dimmed; nothing is ever hidden/deleted.
 */
export function renderParkedSection(
  parked: readonly Goal[],
  nowIso: string,
  color: boolean,
): string[] {
  if (parked.length === 0) return [];
  const lines: string[] = [];
  lines.push(dim(`  ── Goals · Parked (${parked.length})`, color));
  parked.forEach((g, i) => {
    const row = `  ${i + 1}. ${formatGoalRow(g, nowIso)}`;
    // Stale parked goals render dimmed (vision doc §4 — dim, never silent-delete).
    lines.push(isStale(g, nowIso) ? dim(row, color) : row);
  });
  lines.push(dim('     press g to manage goals', color));
  return lines;
}

// ---------------------------------------------------------------------------
// /goals — list by state
// ---------------------------------------------------------------------------

/**
 * The `/goals` view: goals grouped Active / Queued / Parked. Returns the printed
 * text (for testability). Never throws — a store error degrades to a calm note.
 */
export async function runGoalsList(opts: {
  readonly store: GoalStore;
  readonly out: OutputSink;
  readonly nowIso: string;
  readonly projectKey: string | null;
}): Promise<string> {
  let goals: Goal[] = [];
  try {
    goals = await opts.store.list();
  } catch {
    const msg = 'Could not read your goals right now.';
    opts.out.write(`  ${msg}\n`);
    return msg;
  }
  const running = goals.filter((g) => g.state === 'running');
  const queued = goals.filter((g) => g.state === 'queued');
  const parked = goals.filter((g) => g.state === 'parked');

  if (running.length === 0 && queued.length === 0 && parked.length === 0) {
    const msg = 'No goals yet. Park one with /todo <what you want done>.';
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }

  const lines: string[] = [];
  if (running.length > 0) {
    lines.push(bold('  Active', opts.out.color));
    for (const g of running) lines.push(`    ${formatGoalRow(g, opts.nowIso)}`);
  }
  if (queued.length > 0) {
    lines.push(bold('  Queued', opts.out.color));
    for (const g of queued) lines.push(`    ${formatGoalRow(g, opts.nowIso)}`);
  }
  if (parked.length > 0) {
    lines.push(bold(`  Parked (${parked.length})`, opts.out.color));
    parked.forEach((g, i) => {
      lines.push(`    ${i + 1}. ${formatGoalRow(g, opts.nowIso)}`);
    });
    lines.push(dim('  /goals show <n> to expand · /goals go <n> to promote · /goals drop <n>', opts.out.color));
  }
  const text = lines.join('\n');
  opts.out.write(`${text}\n`);
  return text;
}

// ---------------------------------------------------------------------------
// /todo <text> — create a PARKED goal
// ---------------------------------------------------------------------------

/**
 * Create a PARKED goal from `/todo <text>` (source: user-explicit). The text
 * becomes the goal title AND its single first to-do (a one-item roadmap), so the
 * goal is immediately a usable to-do list you can expand and grow. No model call.
 */
export async function runTodoCreate(opts: {
  readonly store: GoalStore;
  readonly out: OutputSink;
  readonly text: string;
  readonly projectKey: string | null;
  readonly conversationId: string | null;
}): Promise<string> {
  const text = (opts.text ?? '').trim();
  if (text.length === 0) {
    const msg = 'Usage: /todo <what you want done> — parks it as a goal you can pick up later.';
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  const title = text.length <= 80 ? text : `${text.slice(0, 79)}…`;
  const firstItem: RoadmapItem = { id: 'r1', text, status: 'pending' };
  try {
    const goal = await opts.store.create({
      title,
      roadmap: [firstItem],
      scope: opts.projectKey !== null ? 'project' : 'global',
      projectKey: opts.projectKey,
      conversationId: opts.conversationId,
      source: 'user-explicit',
    });
    const msg = `Parked goal: ${goal.title} (${formatTodoCount(goal.roadmap)}). /goals to see it.`;
    opts.out.write(`  ${green('◷', opts.out.color)} ${msg}\n`);
    return msg;
  } catch {
    const msg = 'Could not park that goal right now.';
    opts.out.write(`  ${msg}\n`);
    return msg;
  }
}

// ---------------------------------------------------------------------------
// Expand a parked goal — print its roadmap (the to-dos)
// ---------------------------------------------------------------------------

/** Print one parked goal's roadmap as a numbered checklist. Returns the text. */
export function renderGoalExpanded(goal: Goal, out: OutputSink): string {
  const lines: string[] = [];
  lines.push(bold(`  ${goal.title}`, out.color) + dim(`  ·  parked  ·  ${formatTodoCount(goal.roadmap)}`, out.color));
  // The best-approach one-liner (only when the planner recorded one) — the
  // smartest/most-efficient strategy chosen for this goal. Absent ⇒ no line.
  const approachLine = formatGoalApproachLine(goal);
  if (approachLine !== undefined) lines.push(dim(`   ${approachLine}`, out.color));
  if (goal.roadmap.length === 0) {
    lines.push(dim('   (no to-dos yet)', out.color));
  } else {
    lines.push(...formatRoadmapLines(goal.roadmap));
  }
  lines.push(
    dim(
      '   /goals go <n> promote · /todo add <g> <text> · /todo done <g> <n> — once promoted, the partner maintains the to-do list itself',
      out.color,
    ),
  );
  const text = lines.join('\n');
  out.write(`${text}\n`);
  return text;
}

// ---------------------------------------------------------------------------
// Resolve a 1-based parked-goal index → a Goal (the shared selector seam)
// ---------------------------------------------------------------------------

/** The parked goals, newest-touched first — the canonical 1-based index order. */
export async function listParked(store: GoalStore): Promise<Goal[]> {
  try {
    return await store.list({ state: 'parked' });
  } catch {
    return [];
  }
}

/** Resolve a 1-based index into the parked list, or null when out of range. */
export function parkedAt(parked: readonly Goal[], n: number): Goal | null {
  if (!Number.isFinite(n) || n < 1 || n > parked.length) return null;
  return parked[n - 1] ?? null;
}

/**
 * Cancel parked goal #n and every live descendant. Every terminated id/title is
 * reported; done/failed descendants are absent because the store preserves them.
 */
export async function runGoalCancel(opts: {
  readonly store: GoalStore;
  readonly out: OutputSink;
  readonly n: number;
}): Promise<string> {
  const parked = await listParked(opts.store);
  const target = parkedAt(parked, opts.n);
  if (target === null) {
    const msg = `No parked goal #${opts.n}. Run /goals to see the list.`;
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  const all = await opts.store.list().catch(() => []);
  const titleById = new Map(all.map((goal) => [goal.id, goal.title]));
  const { terminated } = await opts.store.cancelGoalTree(target.id);
  if (terminated.length === 0) {
    const msg = `Goal "${target.title}" has no live work to cancel.`;
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  const lines = ['Cancelled goals:'];
  for (const id of terminated) {
    lines.push(`  ${id} — ${titleById.get(id) ?? '(unknown title)'}`);
  }
  const text = lines.join('\n');
  opts.out.write(`${text}\n`);
  return text;
}

// ---------------------------------------------------------------------------
// Manual to-do QUICK-CAPTURE — add (the remaining manual /todo consumer).
// Subscription-clean (no model call): a pure local store op. The PLAN-RESTRUCTURING
// commands (edit / move / rm) were RETIRED — the to-do list is the partner's
// AUTOMATIC ability now (the manager cycle's re-plan pass maintains it via the
// store CRUD). `add` stays only as a quick way to capture an extra step on a
// parked goal. Returns the printed message string (for testability).
// ---------------------------------------------------------------------------

/** Mint a fresh, collision-free RoadmapItem id for a new to-do (e.g. `r3`). */
function nextRoadmapId(goal: Goal): string {
  const used = new Set(goal.roadmap.map((it) => it.id));
  for (let i = 1; ; i += 1) {
    const candidate = `r${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** `/todo add <g> <text>` — append a new to-do to existing parked goal #g. */
export async function runTodoAdd(opts: {
  readonly store: GoalStore;
  readonly out: OutputSink;
  readonly g: number;
  readonly text: string;
}): Promise<string> {
  const parked = await listParked(opts.store);
  const goal = parkedAt(parked, opts.g);
  if (goal === null) {
    const msg = `No parked goal #${opts.g}. Run /goals to see the list.`;
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  const item: RoadmapItem = { id: nextRoadmapId(goal), text: opts.text, status: 'pending' };
  const result: AddRoadmapItemResult = await opts.store.addRoadmapItem(goal.id, item);
  if (result.ok) {
    const msg = `Added a to-do to "${result.goal.title}" (${formatTodoCount(result.goal.roadmap)}).`;
    opts.out.write(`  ${green('◷', opts.out.color)} ${msg}\n`);
    return msg;
  }
  if (result.reason === 'full') {
    // Cap-8 reached — the honest "split into a child goal" nudge (Part 4).
    const msg = `"${result.goal.title}" already has 8 to-dos (the cap). Split the work into a new goal with /todo <text>.`;
    opts.out.write(dim(`  ${msg}\n`, opts.out.color));
    return msg;
  }
  const msg = `No parked goal #${opts.g}. Run /goals to see the list.`;
  opts.out.write(dim(`  ${msg}\n`, opts.out.color));
  return msg;
}
