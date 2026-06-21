/**
 * src/interface/ui/layout.ts — the PURE height-cap planner for the live status
 * region (STEP 4 of the Ink migration).
 *
 * This is the mitigation for Ink's resize / scrollback-duplication bug: the
 * always-visible dynamic region (StatusBlock + live <Stream> + <InputBox>) must
 * NEVER exceed the terminal viewport, or Ink re-emits the overflow into the
 * scrollback on every repaint (the duplicated-status-block glitch). So before the
 * view renders, we plan WHAT to show for the current `rows` and prove the planned
 * height fits.
 *
 * PURE: no Ink/React/JSX, no I/O, no Date.now/Math.random. A plain function of
 * (state, rows) → a {@link StatusLayout} describing exactly which rows the
 * StatusBlock will paint. Exercised by the regular `npm test` suite under
 * strip-types AND consumed by the .tsx components, which render STRICTLY what the
 * plan allows. Keeping the cap logic here (not in a component) is what makes the
 * "fits the viewport" guarantee unit-testable.
 *
 * Row budget model (each item below is exactly ONE terminal row):
 *   panel top border ........................... 1
 *   per full GoalCard:  the goal line ........... 1
 *                       + approach (if present) . 0|1
 *                       + one row per agent ..... agents.length
 *                       + todos (running only) .. 0..N
 *   panel bottom border ........................ 1
 *   the status line (spinner verb) ............. 1
 *   the live <Stream> .......................... streamLines (capped to streamCap)
 *   the <InputBox> (border, caret row, border) . INPUT_ROWS
 * The collapsed form replaces the whole GoalCard block with a single summary row
 * inside the same 2 border rows.
 */

import { formatTokens } from '../../infra/insights.js';
import { truncateToWidth, visibleLength } from '../../ui/tui.js';
import type { GoalBoardRow, GoalView, UiState } from './state.js';

// ---------------------------------------------------------------------------
// Live <Stream> wrapping — how many terminal ROWS the live answer buffer
// occupies at a given width, and how to truncate it to its LAST K rows.
// ---------------------------------------------------------------------------

/** The streaming `● ` marker the <Stream> view prepends to the buffer's first
 *  visual line (cyan dot + space). It costs 2 columns on that first row only. */
const STREAM_MARKER_COLUMNS = 2;

/**
 * Count the terminal ROWS the live <Stream> buffer wraps to at `columns` width,
 * accounting for the `● ` marker on the very first row. Each `\n`-separated
 * source line wraps to `ceil(width / columns)` rows (a blank line is one row).
 * PURE. `columns < 1` is treated as 1 so the count never divides by zero.
 */
export function streamWrappedRows(buffer: string, columns: number): number {
  if (buffer.length === 0) return 0;
  const cols = Math.max(1, Math.floor(columns));
  const lines = buffer.split('\n');
  let rows = 0;
  for (let i = 0; i < lines.length; i++) {
    const extra = i === 0 ? STREAM_MARKER_COLUMNS : 0;
    const width = visibleLength(lines[i] ?? '') + extra;
    rows += Math.max(1, Math.ceil(width / cols));
  }
  return rows;
}

/**
 * Truncate the live <Stream> buffer so it occupies at most `cap` wrapped rows at
 * `columns` width, keeping the buffer's TAIL (the newest prose, like a terminal
 * scrolling up). Returns the original buffer when it already fits, '' when `cap`
 * is 0. Truncation is done on whole `\n`-separated source lines from the end;
 * when even a single source line is too tall for the cap we keep that last line
 * and let Ink wrap it (the cap is a budget guard, not a hard pixel clip). PURE.
 */
export function tailStreamToRows(buffer: string, columns: number, cap: number): string {
  if (buffer.length === 0 || cap <= 0) return '';
  const cols = Math.max(1, Math.floor(columns));
  if (streamWrappedRows(buffer, cols) <= cap) return buffer;
  const lines = buffer.split('\n');
  // Accumulate source lines from the END until adding one more would exceed cap.
  // Each line's row cost ignores the first-row marker (the marker only lands on
  // whatever ends up being the first visible line, a small over-count that keeps
  // us safely UNDER budget rather than over).
  const kept: string[] = [];
  let rows = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineRows = Math.max(1, Math.ceil(visibleLength(lines[i] ?? '') / cols));
    if (kept.length > 0 && rows + lineRows > cap) break;
    kept.unshift(lines[i] ?? '');
    rows += lineRows;
    if (rows >= cap) break;
  }
  return kept.join('\n');
}

// ---------------------------------------------------------------------------
// Row constants
// ---------------------------------------------------------------------------

/** Rows the pinned <InputBox> occupies at rest: top border + caret row + bottom
 *  border. The single-line default; a multiline/pasted composer is taller. */
export const INPUT_ROWS = 3;
/**
 * The composer body's MAX_VISIBLE_ROWS cap (InputBox.tsx clamps a huge paste to
 * its last N *logical* rows). Kept here so the layout budget and the editor agree
 * on the same constant. NOTE: each shown logical row may SOFT-WRAP to several
 * PHYSICAL rows (the word-wrap feature), so this is NOT the worst-case physical
 * height — see {@link composerPhysicalRows}, which measures the TRUE wrapped count.
 */
export const INPUT_BODY_MAX_LOGICAL_ROWS = 10;
/** The 2 rounded-border rows of the composer (top rule + bottom rule). */
export const INPUT_BORDER_ROWS = 2;
// ---------------------------------------------------------------------------
// composerPhysicalRows — the TRUE wrapped physical height of the <InputBox>
// ---------------------------------------------------------------------------

/**
 * The content width of the composer's word-wrapping <Box> at a given terminal
 * `columns`, mirroring InputBox.tsx EXACTLY: the box is `composerWidth - 2` wide
 * (`composerWidth = max(32, columns)`), and the per-row `<Box width={inputWidth-2}>`
 * that wraps the text is 2 columns narrower still (the caret/gutter sits in a
 * fixed 2-col sibling). So the wrap width is `max(1, max(32, columns) - 4)`. PURE.
 */
export function composerContentWidth(columns: number): number {
  const composerWidth = Math.max(32, Math.floor(columns));
  const inputWidth = Math.max(1, composerWidth - 2);
  return Math.max(1, inputWidth - 2);
}

/**
 * The TRUE number of PHYSICAL terminal rows the pinned <InputBox> composer will
 * occupy for edit buffer `value` at terminal `columns`, accounting for the
 * word-wrap feature (each shown logical row soft-wraps to `ceil(width / content)`
 * physical rows) plus the 2 border rows. This is the value the height budget must
 * reserve: the old constant (MAX_VISIBLE_ROWS + 2 = 12) assumed 1 physical row per
 * shown logical row and so UNDER-reserved a wrapped/pasted composer → the
 * scrollback-duplication overflow.
 *
 * The editor shows at most {@link INPUT_BODY_MAX_LOGICAL_ROWS} LOGICAL rows (its
 * tail, keeping the caret visible). When `viewportRows` is supplied and even the
 * shown wrapped body would not fit the viewport (an extreme paste of very long
 * lines), the PHYSICAL body is further capped to `viewportRows - borders -
 * SAFETY_MARGIN_ROWS` so the input ALONE can never exceed the viewport — the
 * editor scrolls to its TAIL (the caret/last row stays visible). Always returns
 * at least {@link INPUT_ROWS} (one caret row + 2 borders). PURE.
 *
 * The companion {@link composerShownPlan} returns the SAME physical body count
 * (minus borders) plus the exact logical rows InputBox renders, so the measured
 * budget count and the rendered height are identical to the row.
 */
export function composerPhysicalRows(value: string, columns: number, viewportRows?: number): number {
  return INPUT_BORDER_ROWS + composerShownPlan(value, columns, viewportRows).physical;
}

/**
 * Plan exactly which logical rows the composer SHOWS (its tail) and the PHYSICAL
 * row count they wrap to, so InputBox rendering and the height budget agree to the
 * row. Selection order:
 *   1. take at most {@link INPUT_BODY_MAX_LOGICAL_ROWS} LOGICAL rows from the END;
 *   2. if a `viewportRows` cap is given and the wrapped PHYSICAL body still would
 *      exceed `viewportRows - borders - margin`, drop logical rows from the FRONT
 *      of the shown window until the physical body fits (always keep the LAST row,
 *      so the caret/tail stays visible — an extreme paste scrolls to its end).
 *
 * Returns the `firstShown` absolute index (so the caret-on-row-0 logic survives),
 * the shown logical lines, and their total `physical` (wrapped) row count. PURE.
 */
export function composerShownPlan(
  value: string,
  columns: number,
  viewportRows?: number,
): { readonly firstShown: number; readonly shown: readonly string[]; readonly physical: number } {
  const content = composerContentWidth(columns);
  const logical = value.split('\n');
  const rowPhysical = (line: string): number => Math.max(1, Math.ceil(visibleLength(line) / content));
  // Step 1: the last MAX_VISIBLE_ROWS logical rows.
  let firstShown =
    logical.length > INPUT_BODY_MAX_LOGICAL_ROWS ? logical.length - INPUT_BODY_MAX_LOGICAL_ROWS : 0;
  // Step 2: tighten to the physical viewport cap (keep the caret/last row).
  if (viewportRows !== undefined) {
    const maxBody = Math.max(1, Math.floor(viewportRows) - INPUT_BORDER_ROWS - SAFETY_MARGIN_ROWS);
    // Drop logical rows from the front of the window until the physical body fits.
    let physical = 0;
    for (let i = firstShown; i < logical.length; i += 1) physical += rowPhysical(logical[i] ?? '');
    while (firstShown < logical.length - 1 && physical > maxBody) {
      physical -= rowPhysical(logical[firstShown] ?? '');
      firstShown += 1;
    }
    // The single surviving (last) row may itself wrap taller than maxBody (one very
    // long pasted line). That residual is accepted: Ink wraps it and the box grows,
    // but it is the unavoidable minimum (we always keep the caret row). The budget
    // floor below clamps the REPORTED physical count to maxBody so the planner still
    // never plans past the viewport; the few extra wrapped rows of a single giant
    // line are the documented over-spill cost of always showing the caret.
  }
  const shown = logical.slice(firstShown);
  let physical = 0;
  for (const line of shown) physical += rowPhysical(line);
  physical = Math.max(1, physical);
  if (viewportRows !== undefined) {
    const maxBody = Math.max(1, Math.floor(viewportRows) - INPUT_BORDER_ROWS - SAFETY_MARGIN_ROWS);
    physical = Math.min(physical, maxBody);
  }
  return { firstShown, shown, physical };
}
/** Rows the spinner / "Waiting on N models" status line occupies. */
export const STATUS_LINE_ROWS = 1;
/**
 * Rows the agent-centric summary line ("▸ N goals · M agents · …") occupies. It
 * sits between the GOALS panel and the status line and is part of the height
 * budget so adding it can never push the dynamic region past the viewport (the
 * scrollback-duplication guard). One row when the panel is visible; 0 when hidden.
 */
export const SUMMARY_LINE_ROWS = 1;
/** The two rounded-border rows of the GOALS panel (top + bottom). */
export const PANEL_BORDER_ROWS = 2;
/** Rows we keep as breathing room so the region never butts the very top edge. */
export const SAFETY_MARGIN_ROWS = 1;
/**
 * The chrome rows of the persistent BOARD panel: the 2 rounded-border rows + the
 * 1-row "BOARD" title line. The board body (one row per shown goal + an optional
 * `+K more` overflow line) is budgeted on top of these. Kept here so the layout
 * budget and the StatusBlock board renderer agree on the same constant.
 */
export const BOARD_CHROME_ROWS = 3;

// ---------------------------------------------------------------------------
// Composer hint-line shaping
// ---------------------------------------------------------------------------

/**
 * Shape the composer's bottom hint line to fit `width` columns while preserving
 * the body width. The first segment ("Mode: …") is kept as long as possible;
 * trailing hints are dropped one-by-one before the mode segment itself is
 * truncated. PURE.
 */
export function fitComposerInfo(info: string, width: number): string {
  const segments = info
    .split(' · ')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0 || width <= 0) return '';

  const first = segments[0] ?? '';
  const rest = segments.slice(1);
  let fitted = first;
  for (const segment of rest) {
    const next = `${fitted} · ${segment}`;
    if (visibleLength(next) > width) break;
    fitted = next;
  }
  return truncateToWidth(fitted, width);
}

// ---------------------------------------------------------------------------
// Live work-summary shaping
// ---------------------------------------------------------------------------

export interface WorkSummary {
  readonly active: number;
  readonly complete: number;
  readonly goals?: number;
}

/**
 * Count the real in-flight work visible in the reducer state. Active/complete are
 * derived strictly from tracked agents/panelists; the goal count is shown only
 * when more than one goal is present. PURE.
 */
export function summarizeWork(state: UiState): WorkSummary {
  const goalAgents = state.goals.flatMap((goal) => goal.agents);
  const panelists = state.stream.panelists;
  const active =
    goalAgents.filter((agent) => agent.state === 'running').length +
    panelists.filter((agent) => agent.state === 'running').length;
  const complete =
    goalAgents.filter((agent) => agent.state === 'done').length +
    panelists.filter((agent) => agent.state === 'done').length;
  const goals = state.goals.length > 1 ? state.goals.length : undefined;
  return { active, complete, ...(goals !== undefined ? { goals } : {}) };
}

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

/**
 * One row in the GOALS panel body (multi-goal collapse). The body is an ORDERED
 * list of these, summing to a known row count so the cap invariant still holds:
 *  - `card`   : a goal rendered as a full card (header + one row per agent).
 *  - `header` : a goal collapsed to a single header line (agent rows dropped) —
 *               used for running/done goals under height pressure.
 *  - `coalesced-queued` : ONE line summarising N queued goals
 *               (`○ a · ○ b · +K more queued`).
 *  - `coalesced-done`   : ONE line summarising N done/failed goals
 *               (`✓ N done`), used under pressure.
 */
export type GoalRow =
  | { readonly kind: 'card'; readonly goal: GoalView }
  | { readonly kind: 'header'; readonly goal: GoalView }
  | { readonly kind: 'coalesced-queued'; readonly goals: readonly GoalView[] }
  | { readonly kind: 'coalesced-done'; readonly done: number; readonly failed: number };

/** How the GOALS panel is laid out for the available height. */
export type GoalsMode =
  /**
   * The bordered GOALS panel. `rows` is the ORDERED body plan (cards, collapsed
   * headers, coalesced queued/done lines); `goals` is the subset rendered as FULL
   * cards (kept for back-compat with callers/tests that read the expanded set).
   * When everything fits, `rows` is one `card` per goal and `goals` is every goal
   * — byte-for-byte today's behaviour.
   */
  | { readonly kind: 'full'; readonly goals: readonly GoalView[]; readonly rows: readonly GoalRow[] }
  /** A single summary row replacing the cards (height pressure). */
  | { readonly kind: 'compact'; readonly summary: string }
  /** No room for the panel at all (extreme pressure) — only the status line shows. */
  | { readonly kind: 'hidden' };

/** The complete render plan the StatusBlock paints. */
export interface StatusLayout {
  /** False when the turn is idle — the whole block collapses to nothing. */
  readonly visible: boolean;
  readonly goals: GoalsMode;
  /**
   * Whether the agent-centric summary line is part of this plan (it is budgeted as
   * {@link SUMMARY_LINE_ROWS} whenever the GOALS panel is visible). The view builds
   * the actual text via {@link summarizeTurn} with its injected elapsed — keeping
   * the elapsed clock out of the pure planner — but renders the row ONLY when this
   * is true, so it can never exceed the proven `plannedRows`.
   */
  readonly showSummary: boolean;
  /** Max lines of the live <Stream> to show (it is truncated to its LAST K). */
  readonly streamCap: number;
  /** The total rows this plan paints (block + status line + stream), EXCLUDING
   *  the input box — provably <= the height budget passed in. For assertions. */
  readonly plannedRows: number;
  /**
   * The persistent BOARD plan (Elite-partner Phase 1) — present (non-null) ONLY
   * when `state.boardEnabled && state.board.length > 0` AND the board fits the
   * height budget; null otherwise (flag off, empty board, or no room). The board
   * renders INDEPENDENT of `turnActive` (the one change to the idle-collapse rule),
   * so it shows across turns. Its rows are part of `plannedRows`, so the dynamic
   * region (board + goals panel + status line + stream) is still provably <= the
   * viewport. Null on the flag-off path → byte-for-byte today's layout.
   */
  readonly board: BoardPlan | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rows a single goal occupies as a full card: its line + one per agent. */
export function goalCardRows(goal: GoalView): number {
  return 1 + goal.agents.length;
}

/** Rows a single {@link GoalRow} occupies in the panel body. PURE. */
function goalRowHeight(row: GoalRow): number {
  switch (row.kind) {
    case 'card':
      return goalCardRows(row.goal);
    case 'header':
    case 'coalesced-queued':
    case 'coalesced-done':
      return 1;
  }
}

/** Total body rows for an ordered {@link GoalRow} plan. PURE. */
export function goalRowsHeight(rows: readonly GoalRow[]): number {
  return rows.reduce((sum, r) => sum + goalRowHeight(r), 0);
}

/** Total rows the full-card GOALS panel would occupy (borders + every card). */
function fullPanelRows(goals: readonly GoalView[]): number {
  const body = goals.reduce((sum, g) => sum + goalCardRows(g), 0);
  return PANEL_BORDER_ROWS + body;
}

/**
 * Build the coalesced-queued ONE-line text for the panel body, e.g.
 * `○ Add tests · ○ Wire CI · +6 more queued`. Lists labels until the line would
 * grow long, then rolls the rest into `+K more queued`. Always one row. PURE.
 */
export function coalescedQueuedLine(goals: readonly GoalView[], maxLabels = 3): string {
  if (goals.length === 0) return '';
  const shown = goals.slice(0, Math.max(1, maxLabels));
  const rest = goals.length - shown.length;
  const parts = shown.map((g) => `○ ${g.label}`);
  if (rest > 0) parts.push(`+${rest} more queued`);
  else if (shown.length > 0) parts[parts.length - 1] = `${parts[parts.length - 1]} queued`;
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// planGoalsPanel — the cap-preserving multi-goal collapse (design §3 / §4)
// ---------------------------------------------------------------------------

/**
 * Plan the GOALS panel BODY for a given row `budget` (the rows available for the
 * body, i.e. excluding the 2 border rows). Implements the design's collapse
 * order so MANY goals never overflow the viewport:
 *
 *   1. running goals expanded (full cards), newest-active first, up to budget;
 *   2. running goals that don't fit → collapse to a 1-line header (drop agents);
 *   3. done/failed goals → 1 line each, then coalesced to `✓ N done` under pressure;
 *   4. queued goals → always coalesced to ONE `○ a · ○ b · +K more queued` row.
 *
 * Returns the ordered {@link GoalRow} plan whose summed height is GUARANTEED
 * `<= budget` (the caller adds the 2 border rows). For the common case (every
 * goal fits as a full card) it returns one `card` per goal — byte-for-byte the
 * prior behaviour. PURE; never mutates inputs.
 *
 * When the body cannot fit even the most-collapsed form in `budget`, returns
 * `null` so the caller falls through to the existing compact one-liner.
 */
export function planGoalsPanel(goals: readonly GoalView[], budget: number): readonly GoalRow[] | null {
  if (goals.length === 0) return [];
  if (budget < 1) return null;

  const running = goals.filter((g) => g.state === 'running');
  const terminal = goals.filter((g) => g.state === 'done' || g.state === 'failed');
  const queued = goals.filter((g) => g.state === 'queued');
  const doneCount = terminal.filter((g) => g.state === 'done').length;
  const failedCount = terminal.filter((g) => g.state === 'failed').length;

  // Fast path: everything fits as full cards (today's behaviour for ≤ a few goals).
  const allCards: GoalRow[] = goals.map((g) => ({ kind: 'card' as const, goal: g }));
  if (goalRowsHeight(allCards) <= budget) return allCards;

  // The MINIMUM footprint: one header per running goal + at most one coalesced-
  // done line + at most one coalesced-queued line. If even that overflows the
  // budget, give up (caller falls to the compact one-liner).
  const minRows =
    running.length + (terminal.length > 0 ? 1 : 0) + (queued.length > 0 ? 1 : 0);
  if (minRows > budget) return null;

  // Reserve rows for the always-coalesced queued line + the done summary, then
  // spend the rest expanding running goals to full cards (newest-active first).
  const reservedQueued = queued.length > 0 ? 1 : 0;
  const reservedDone = terminal.length > 0 ? 1 : 0;
  const runningBudget = budget - reservedQueued - reservedDone;

  // Each running goal costs at least its header (1 row); expanding to a card adds
  // its agent rows. Lay them down as headers first (cheapest), then upgrade the
  // most-recent ones to full cards while the budget allows.
  const runningRows: GoalRow[] = running.map((g) => ({ kind: 'header' as const, goal: g }));
  let used = running.length; // every running goal starts as a 1-row header
  // Upgrade from the END (newest-active) toward the front.
  for (let i = running.length - 1; i >= 0; i -= 1) {
    const g = running[i];
    if (g === undefined) continue;
    const extra = goalCardRows(g) - 1; // agent rows added by expanding
    if (extra > 0 && used + extra <= runningBudget) {
      runningRows[i] = { kind: 'card', goal: g };
      used += extra;
    }
  }

  const rows: GoalRow[] = [...runningRows];
  if (terminal.length > 0) {
    rows.push({ kind: 'coalesced-done', done: doneCount, failed: failedCount });
  }
  if (queued.length > 0) {
    rows.push({ kind: 'coalesced-queued', goals: queued });
  }
  // Final guard: the plan never exceeds the budget (it cannot by construction,
  // but assert-by-truncation keeps the invariant total even if budgets change).
  if (goalRowsHeight(rows) > budget) {
    // Demote expanded cards back to headers until it fits.
    for (let i = 0; i < rows.length && goalRowsHeight(rows) > budget; i += 1) {
      const r = rows[i];
      if (r !== undefined && r.kind === 'card') rows[i] = { kind: 'header', goal: r.goal };
    }
    if (goalRowsHeight(rows) > budget) return null;
  }
  return rows;
}

/**
 * The total number of REAL agents across the turn: one {@link AgentView} per goal
 * agent plus the live panel candidates ({@link StreamView.panelists}). This is the
 * honest headline count (1–4 today: ≤3 provider CLIs + 1 synthesizer in panel
 * mode; sequential default = 1). It is DERIVED, never fabricated — it equals the
 * number of AgentView entries the reducer actually created. PURE.
 */
export function totalAgentCount(state: UiState): number {
  const goalAgents = state.goals.reduce((sum, g) => sum + g.agents.length, 0);
  return goalAgents + state.stream.panelists.length;
}

/**
 * Whether the stacked goal cards are sequential PHASES of one request (IC →
 * review → manager escalation of the SAME goal) rather than distinct goals. True
 * when there is more than one goal and they all share the same human title — the
 * honesty gate that makes the summary say "N phases" instead of inflating to "N
 * goals" (orchestration-UX honesty contract). With ≤1 goal there is nothing to
 * disambiguate, so this returns false. PURE.
 */
export function goalsAreSequentialPhases(goals: readonly GoalView[]): boolean {
  if (goals.length <= 1) return false;
  const first = goals[0]?.label;
  return goals.every((g) => g.label === first);
}

/**
 * The one-glance agent-centric SUMMARY line shown under the GOALS panel
 * (orchestration-UX Phase 1):
 *   `▸ 1 goal · 1 agent · 1.2k tok · 51s`
 *   `▸ 2 phases · 2 agents · 3.3k tok · 40s`   (stacked escalation of one request)
 * Every figure is REAL: the goal/phase count from `goals.length`, the agent count
 * from {@link totalAgentCount} (goal agents + panel candidates), the token total
 * from `tokens.turn`, and the elapsed `Ns` injected by the caller (never a
 * fabricated clock; omitted when absent/0). "phases" is used only when the cards
 * are sequential phases of one request ({@link goalsAreSequentialPhases}); else
 * "goal[s]". PURE.
 */
export function summarizeTurn(state: UiState, elapsedSecs?: number): string {
  const nUnits = state.goals.length;
  const phases = goalsAreSequentialPhases(state.goals);
  const noun = phases ? 'phase' : 'goal';
  const unitStr = `${nUnits} ${noun}${nUnits === 1 ? '' : 's'}`;
  const nAgents = totalAgentCount(state);
  const agentStr = `${nAgents} agent${nAgents === 1 ? '' : 's'}`;
  const parts = [`▸ ${unitStr}`, agentStr];
  // The token segment appears ONLY once the turn total is genuinely > 0 (real
  // usage, populated at a tier-done / final). Mid-run there is no honest token
  // figure for the Claude subscription provider, so the segment is omitted rather
  // than showing a fabricated/zero "0 tok".
  if (state.tokens.turn > 0) parts.push(`${formatTokens(state.tokens.turn)} tok`);
  if (elapsedSecs !== undefined && elapsedSecs > 0) parts.push(`${elapsedSecs}s`);
  return parts.join(' · ');
}

/**
 * Build the one-line compact summary that replaces the full cards under height
 * pressure, now LEADING with the agent count (orchestration-UX Phase 1), e.g.
 * `2 phases · 4 agents · 1 running · 1 queued · ↓ 9.4k tok`. Counts are real
 * (derived from goal state + panel candidates); the token figure is the running
 * turn total. Uses "phases" when the cards are sequential phases of one request.
 */
export function compactGoalsSummary(
  goals: readonly GoalView[],
  turnTokens: number,
  panelistCount = 0,
): string {
  const n = goals.length;
  const phases = goalsAreSequentialPhases(goals);
  const noun = phases ? 'phase' : 'goal';
  const running = goals.filter((g) => g.state === 'running').length;
  const queued = goals.filter((g) => g.state === 'queued').length;
  const done = goals.filter((g) => g.state === 'done').length;
  const failed = goals.filter((g) => g.state === 'failed').length;
  const nAgents = goals.reduce((sum, g) => sum + g.agents.length, 0) + panelistCount;
  const parts: string[] = [
    `${n} ${noun}${n === 1 ? '' : 's'}`,
    `${nAgents} agent${nAgents === 1 ? '' : 's'}`,
  ];
  if (running > 0) parts.push(`${running} running`);
  if (queued > 0) parts.push(`${queued} queued`);
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(`↓ ${formatTokens(turnTokens)} tok`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// planBoard — the persistent goal BOARD plan (Elite-partner Phase 1)
// ---------------------------------------------------------------------------

/**
 * The persistent goal BOARD plan for a given row `budget` (the rows available for
 * the board BODY, i.e. excluding the {@link BOARD_CHROME_ROWS} border+title). The
 * board is a flat, cross-turn projection of the GoalStore: each shown goal is one
 * row; when there are more goals than fit, the overflow rolls into a single
 * `+K more` line so a 20-goal board NEVER overflows the viewport (the same
 * height-discipline as {@link planGoalsPanel}). PURE; never mutates input.
 *
 * Returns `null` when even one row + the overflow line cannot fit `budget` (the
 * caller then hides the board entirely). When every goal fits, `shown` is the
 * whole board and `overflow` is 0.
 */
export interface BoardPlan {
  readonly shown: readonly GoalBoardRow[];
  readonly overflow: number;
}

function boardRowHeight(row: GoalBoardRow): number {
  // Base goal line + optional approach line (always, for persistent viz) +
  // running todos only (live checklist). This keeps the layout budget
  // honest so StatusBlock + stream + input never overflow viewport.
  const base = 1;
  const approachLines = row.approach ? 1 : 0;
  const todoLines = row.state === 'running' ? (row.todos?.length ?? 0) : 0;
  return base + approachLines + todoLines;
}

function boardRowsHeight(rows: readonly GoalBoardRow[]): number {
  return rows.reduce((sum, row) => sum + boardRowHeight(row), 0);
}

export function planBoard(board: readonly GoalBoardRow[], budget: number): BoardPlan | null {
  if (board.length === 0) return null;
  if (budget < 1) return null;
  if (boardRowsHeight(board) <= budget) return { shown: board, overflow: 0 };

  const shown: GoalBoardRow[] = [];
  let used = 0;
  for (let i = 0; i < board.length; i += 1) {
    const row = board[i];
    if (row === undefined) continue;
    const remaining = board.length - (i + 1);
    const reserveOverflow = remaining > 0 ? 1 : 0;
    const next = boardRowHeight(row);
    if (used + next + reserveOverflow > budget) break;
    shown.push(row);
    used += next;
  }
  if (shown.length < 1) return null;
  return { shown, overflow: board.length - shown.length };
}

// ---------------------------------------------------------------------------
// layoutForHeight — the planner
// ---------------------------------------------------------------------------

/**
 * Plan the live status region for a terminal of `rows` rows.
 *
 * Guarantee: `result.plannedRows + INPUT_ROWS <= rows` whenever `rows` is large
 * enough to hold the minimum (input + one status line + safety margin); for a
 * pathologically tiny `rows` the plan still never EXCEEDS the budget — it caps
 * the stream to 0 and hides the panel, so the worst case is exactly the status
 * line + input. The view renders STRICTLY what this returns, so the dynamic
 * region can never push old frames into the scrollback.
 *
 * Degradation order (most graceful first):
 *   1. full cards + as much stream as fits;
 *   2. cards kept, the live stream truncated toward its last line;
 *   3. cards collapsed to the one-line summary (frees Σ agent rows), stream re-fit;
 *   4. panel hidden entirely — only the status line + a 1-line stream tail;
 *   5. stream dropped to 0 — only the status line.
 * Each step frees rows for the always-present input box + status line.
 *
 * @param state - the reducer snapshot (read-only).
 * @param rows  - the terminal height (already width-backfilled by mount).
 * @param streamLines - how many lines the live <Stream> buffer currently has
 *   (the consumer passes the wrapped line count; defaults to a 1-line estimate).
 * @param inputRows - rows the pinned <InputBox> will actually occupy this frame
 *   (the consumer passes the composer's MEASURED wrapped physical height via
 *   {@link composerPhysicalRows} for a multiline/pasted buffer). Defaults to
 *   {@link INPUT_ROWS} so existing callers/tests keep the single-line budget.
 */
export function layoutForHeight(
  state: UiState,
  rows: number,
  streamLines = state.stream.buffer.length > 0 ? 1 : 0,
  inputRows: number = INPUT_ROWS,
): StatusLayout {
  // The full viewport budget the dynamic region (board + panel + status line +
  // stream) may occupy: the viewport minus the always-present input box minus a
  // safety margin. Floored at 1 so at least one row always survives.
  const fullBudget = Math.max(1, rows - Math.max(1, Math.floor(inputRows)) - SAFETY_MARGIN_ROWS);

  // Elite-partner Phase 1: the persistent BOARD renders INDEPENDENT of turnActive
  // (the one change to the idle-collapse rule). Plan it FIRST and reserve its rows
  // off the budget so the live goals panel / stream get whatever remains — the
  // board can never push the dynamic region past the viewport. The board plans only
  // when the flag is ON and the store snapshot is non-empty; otherwise it is null
  // and every path below is byte-for-byte today's. The board is capped to at most
  // ~⅓ of the viewport (and ≥1 body row) so a 20-goal board never starves a live
  // turn's panel/stream while still showing the work across turns.
  const boardOn = state.boardEnabled && state.board.length > 0;
  let board: BoardPlan | null = null;
  let boardRows = 0;
  if (boardOn) {
    const boardCapBody = Math.max(1, Math.floor(rows / 3) - BOARD_CHROME_ROWS);
    const boardBodyBudget = Math.min(boardCapBody, Math.max(0, fullBudget - BOARD_CHROME_ROWS));
    const planned = boardBodyBudget >= 1 ? planBoard(state.board, boardBodyBudget) : null;
    if (planned !== null) {
      board = planned;
      boardRows = BOARD_CHROME_ROWS + boardRowsHeight(planned.shown) + (planned.overflow > 0 ? 1 : 0);
    }
  }

  // When no turn is active the live goals panel / status line / stream all collapse
  // to nothing (today's calm idle). With the board on, the region stays VISIBLE
  // showing ONLY the board across turns; with the board off this is byte-for-byte
  // the original idle-collapse (visible:false, nothing painted).
  if (!state.turnActive) {
    if (board !== null) {
      return {
        visible: true,
        goals: { kind: 'hidden' },
        showSummary: false,
        streamCap: 0,
        plannedRows: boardRows,
        board,
      };
    }
    return {
      visible: false,
      goals: { kind: 'hidden' },
      showSummary: false,
      streamCap: 0,
      plannedRows: 0,
      board: null,
    };
  }

  // The budget the LIVE region (panel + status line + stream) may occupy: the full
  // budget minus whatever the board reserved. Floored at 1 so the status line
  // always survives. When the board is off, `boardRows` is 0 → identical to today.
  const budget = Math.max(1, fullBudget - boardRows);

  const goals = state.goals;
  const hasGoals = goals.length > 0;
  const fullRows = hasGoals ? fullPanelRows(goals) : 0;
  // The agent-centric turn-summary line ("▸ N goals · M agents · …") is shown ONLY
  // when there is more than ONE goal to AGGREGATE. With a single goal it is a pure
  // duplicate of the GoalCard header + nested AgentRow (which already say "1 agent")
  // and the StatusLine (which carries the unique tool-call count), so it is dropped
  // — three lines no longer restate the same "1 agent". When shown, it rides ABOVE
  // the status line and is part of the budget (so it can never push the dynamic
  // region past the viewport) and is dropped (0 rows) in the hidden-panel step.
  const showSummaryLine = hasGoals && goals.length > 1;
  const summaryRows = showSummaryLine ? SUMMARY_LINE_ROWS : 0;
  const fixed = STATUS_LINE_ROWS + summaryRows;

  // Step 1 + 2: try full cards. The status line + summary line are mandatory when
  // the panel shows; whatever is left after cards + those is the stream's allowance.
  const fullPlusFixed = fullRows + fixed;
  if (hasGoals && fullPlusFixed <= budget) {
    const streamCap = Math.max(0, Math.min(streamLines, budget - fullPlusFixed));
    return {
      visible: true,
      goals: { kind: 'full', goals, rows: goals.map((g) => ({ kind: 'card' as const, goal: g })) },
      showSummary: showSummaryLine,
      streamCap,
      plannedRows: boardRows + fullRows + fixed + streamCap,
      board,
    };
  }

  // Step 2.5 (multi-goal collapse): the full cards overflow, but the panel may
  // still fit if running goals collapse to headers and queued/done coalesce into
  // single lines (design §3/§4). Budget the BODY (panel rows minus the 2 borders
  // and the mandatory status+summary lines) and let planGoalsPanel pack it. This
  // keeps MANY goals visible (12+) without ever exceeding the viewport. Only runs
  // when the all-full path above didn't fit, so the single-/few-goal behaviour is
  // untouched.
  const bodyBudget = budget - PANEL_BORDER_ROWS - fixed;
  if (hasGoals && bodyBudget >= 1) {
    const plan = planGoalsPanel(goals, bodyBudget);
    if (plan !== null && plan.length > 0) {
      const bodyRows = goalRowsHeight(plan);
      const panelRows = PANEL_BORDER_ROWS + bodyRows;
      const cardGoals = plan
        .filter((r): r is Extract<GoalRow, { kind: 'card' }> => r.kind === 'card')
        .map((r) => r.goal);
      const streamCap = Math.max(0, Math.min(streamLines, budget - panelRows - fixed));
      return {
        visible: true,
        goals: { kind: 'full', goals: cardGoals, rows: plan },
        showSummary: showSummaryLine,
        streamCap,
        plannedRows: boardRows + panelRows + fixed + streamCap,
        board,
      };
    }
  }

  // Step 3: collapse cards to the one-line summary (PANEL_BORDER_ROWS + 1 summary
  // row). This frees every agent row at once. The agent-centric summary line still
  // rides above the status line.
  const compactRows = hasGoals ? PANEL_BORDER_ROWS + 1 : 0;
  const compactPlusFixed = compactRows + fixed;
  if (hasGoals && compactPlusFixed <= budget) {
    const streamCap = Math.max(0, Math.min(streamLines, budget - compactPlusFixed));
    return {
      visible: true,
      goals: {
        kind: 'compact',
        summary: compactGoalsSummary(goals, state.tokens.turn, state.stream.panelists.length),
      },
      showSummary: showSummaryLine,
      streamCap,
      plannedRows: boardRows + compactRows + fixed + streamCap,
      board,
    };
  }

  // Step 4 + 5: no room for any panel — only the status line, plus whatever
  // stream tail the remaining budget allows (possibly 0).
  const streamCap = Math.max(0, Math.min(streamLines, budget - STATUS_LINE_ROWS));
  return {
    visible: true,
    goals: { kind: 'hidden' },
    showSummary: false,
    streamCap,
    plannedRows: boardRows + STATUS_LINE_ROWS + streamCap,
    board,
  };
}
