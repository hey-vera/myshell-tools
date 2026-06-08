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
 *                       + one row per agent ..... agents.length
 *   panel bottom border ........................ 1
 *   the status line (spinner verb) ............. 1
 *   the live <Stream> .......................... streamLines (capped to streamCap)
 *   the <InputBox> (border, caret row, border) . INPUT_ROWS
 * The collapsed form replaces the whole GoalCard block with a single summary row
 * inside the same 2 border rows.
 */

import { formatTokens } from '../../infra/insights.js';
import { visibleLength } from '../../ui/tui.js';
import type { GoalView, UiState } from './state.js';

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
 * WORST-CASE rows the pinned <InputBox> can occupy: its top + bottom border (2)
 * plus the editor's own MAX_VISIBLE_ROWS body cap (InputBox.tsx clamps a huge
 * paste to its last 10 visible rows). The layout budget reserves this so a tall
 * composer + panel + stream can never exceed the viewport and re-trigger the
 * Ink scrollback-duplication bug.
 *
 * Tradeoff (documented): we reserve the worst case rather than the composer's
 * LIVE height. The alternative — lifting the InputBox's private edit-buffer row
 * count up to App — would couple a per-keystroke child setState into the parent
 * render on every edit, which is materially more invasive than this constant and
 * buys only a few extra stream rows while the composer is short. Over-reserving
 * is the SAFE direction (it only shrinks the live <Stream> tail a little); under-
 * reserving is the bug we are fixing. Keep INPUT_ROWS_MAX = MAX_VISIBLE_ROWS + 2.
 */
export const INPUT_ROWS_MAX = 12;
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

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

/** How the GOALS panel is laid out for the available height. */
export type GoalsMode =
  /** Every goal as a full card with its agent rows. */
  | { readonly kind: 'full'; readonly goals: readonly GoalView[] }
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rows a single goal occupies as a full card: its line + one per agent. */
export function goalCardRows(goal: GoalView): number {
  return 1 + goal.agents.length;
}

/** Total rows the full-card GOALS panel would occupy (borders + every card). */
function fullPanelRows(goals: readonly GoalView[]): number {
  const body = goals.reduce((sum, g) => sum + goalCardRows(g), 0);
  return PANEL_BORDER_ROWS + body;
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
  const parts = [`▸ ${unitStr}`, agentStr, `${formatTokens(state.tokens.turn)} tok`];
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
 *   (the consumer passes the composer's rendered height, e.g. {@link INPUT_ROWS_MAX}
 *   for a multiline/pasted buffer). Defaults to {@link INPUT_ROWS} so existing
 *   callers/tests keep the single-line budget unchanged.
 */
export function layoutForHeight(
  state: UiState,
  rows: number,
  streamLines = state.stream.buffer.length > 0 ? 1 : 0,
  inputRows: number = INPUT_ROWS,
): StatusLayout {
  if (!state.turnActive) {
    return { visible: false, goals: { kind: 'hidden' }, showSummary: false, streamCap: 0, plannedRows: 0 };
  }

  // The budget the dynamic region (panel + status line + stream) may occupy: the
  // viewport minus the always-present input box minus a safety margin. Floored at
  // 1 so the status line always survives. `inputRows` is the composer's ACTUAL
  // rendered height (single-line default; worst-case for a tall/pasted buffer) so
  // a multiline composer cannot push the dynamic region past the viewport.
  const budget = Math.max(1, rows - Math.max(1, Math.floor(inputRows)) - SAFETY_MARGIN_ROWS);

  const goals = state.goals;
  const hasGoals = goals.length > 0;
  const fullRows = hasGoals ? fullPanelRows(goals) : 0;
  // The agent-centric summary line rides ABOVE the status line whenever the GOALS
  // panel is visible (full or compact); it is part of the budget so it can never
  // push the dynamic region past the viewport. It is dropped (0 rows) in the
  // hidden-panel degradation step, exactly like the panel itself.
  const summaryRows = hasGoals ? SUMMARY_LINE_ROWS : 0;
  const fixed = STATUS_LINE_ROWS + summaryRows;

  // Step 1 + 2: try full cards. The status line + summary line are mandatory when
  // the panel shows; whatever is left after cards + those is the stream's allowance.
  const fullPlusFixed = fullRows + fixed;
  if (hasGoals && fullPlusFixed <= budget) {
    const streamCap = Math.max(0, Math.min(streamLines, budget - fullPlusFixed));
    return {
      visible: true,
      goals: { kind: 'full', goals },
      showSummary: true,
      streamCap,
      plannedRows: fullRows + fixed + streamCap,
    };
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
      showSummary: true,
      streamCap,
      plannedRows: compactRows + fixed + streamCap,
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
    plannedRows: STATUS_LINE_ROWS + streamCap,
  };
}
