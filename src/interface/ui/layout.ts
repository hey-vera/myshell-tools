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
import type { GoalView, UiState } from './state.js';

// ---------------------------------------------------------------------------
// Row constants
// ---------------------------------------------------------------------------

/** Rows the pinned <InputBox> occupies: top border + caret row + bottom border. */
export const INPUT_ROWS = 3;
/** Rows the spinner / "Waiting on N models" status line occupies. */
export const STATUS_LINE_ROWS = 1;
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
 * Build the one-line compact summary that replaces the full cards under height
 * pressure, e.g. `3 goals · 2 running · 1 queued · ↓ 4.2k tok`. Counts are real
 * (derived from goal state); the token figure is the running turn total.
 */
export function compactGoalsSummary(goals: readonly GoalView[], turnTokens: number): string {
  const n = goals.length;
  const running = goals.filter((g) => g.state === 'running').length;
  const queued = goals.filter((g) => g.state === 'queued').length;
  const done = goals.filter((g) => g.state === 'done').length;
  const failed = goals.filter((g) => g.state === 'failed').length;
  const parts: string[] = [`${n} goal${n === 1 ? '' : 's'}`];
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
 */
export function layoutForHeight(
  state: UiState,
  rows: number,
  streamLines = state.stream.buffer.length > 0 ? 1 : 0,
): StatusLayout {
  if (!state.turnActive) {
    return { visible: false, goals: { kind: 'hidden' }, streamCap: 0, plannedRows: 0 };
  }

  // The budget the dynamic region (panel + status line + stream) may occupy: the
  // viewport minus the always-present input box minus a safety margin. Floored at
  // 1 so the status line always survives.
  const budget = Math.max(1, rows - INPUT_ROWS - SAFETY_MARGIN_ROWS);

  const goals = state.goals;
  const hasGoals = goals.length > 0;
  const fullRows = hasGoals ? fullPanelRows(goals) : 0;

  // Step 1 + 2: try full cards. The status line is mandatory (1 row); whatever is
  // left after cards + status line is the stream's allowance.
  const fullPlusStatus = fullRows + STATUS_LINE_ROWS;
  if (hasGoals && fullPlusStatus <= budget) {
    const streamCap = Math.max(0, Math.min(streamLines, budget - fullPlusStatus));
    return {
      visible: true,
      goals: { kind: 'full', goals },
      streamCap,
      plannedRows: fullRows + STATUS_LINE_ROWS + streamCap,
    };
  }

  // Step 3: collapse cards to the one-line summary (PANEL_BORDER_ROWS + 1 summary
  // row). This frees every agent row at once.
  const compactRows = hasGoals ? PANEL_BORDER_ROWS + 1 : 0;
  const compactPlusStatus = compactRows + STATUS_LINE_ROWS;
  if (hasGoals && compactPlusStatus <= budget) {
    const streamCap = Math.max(0, Math.min(streamLines, budget - compactPlusStatus));
    return {
      visible: true,
      goals: { kind: 'compact', summary: compactGoalsSummary(goals, state.tokens.turn) },
      streamCap,
      plannedRows: compactRows + STATUS_LINE_ROWS + streamCap,
    };
  }

  // Step 4 + 5: no room for any panel — only the status line, plus whatever
  // stream tail the remaining budget allows (possibly 0).
  const streamCap = Math.max(0, Math.min(streamLines, budget - STATUS_LINE_ROWS));
  return {
    visible: true,
    goals: { kind: 'hidden' },
    streamCap,
    plannedRows: STATUS_LINE_ROWS + streamCap,
  };
}
