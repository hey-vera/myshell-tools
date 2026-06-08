/**
 * test/unit/ui-layout.test.ts — the PURE height-cap planner (STEP 4).
 *
 * Exercises `layoutForHeight` and its helpers with NO Ink: it is a pure function
 * of (UiState, rows) → a render plan, so it runs in the strip-types `npm test`
 * suite. The load-bearing guarantee proved here is that the planned dynamic
 * region (panel + status line + stream) plus the input box NEVER exceeds the
 * viewport — the mitigation for Ink's scrollback-duplication bug — and that the
 * degradation order (full cards → truncate stream → compact summary → hide panel
 * → drop stream) kicks in as height shrinks.
 *
 * Run: node --experimental-strip-types --test test/unit/ui-layout.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutForHeight,
  compactGoalsSummary,
  goalCardRows,
  INPUT_ROWS,
  STATUS_LINE_ROWS,
  PANEL_BORDER_ROWS,
  SAFETY_MARGIN_ROWS,
} from '../../src/interface/ui/index.ts';
import { initialState } from '../../src/interface/ui/index.ts';
import type { AgentView, GoalView, UiState } from '../../src/interface/ui/index.ts';

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function agent(over: Partial<AgentView> = {}): AgentView {
  return { provider: 'claude', model: 'opus', state: 'running', tokens: 1800, attempt: 0, ...over };
}

function goal(over: Partial<GoalView> = {}): GoalView {
  return {
    id: over.id ?? 'mid#0',
    label: over.label ?? 'Refactor auth flow',
    state: over.state ?? 'running',
    tokens: over.tokens ?? 3100,
    agents: over.agents ?? [agent()],
  };
}

function active(goals: readonly GoalView[], buffer = '', turn = 0): UiState {
  return {
    ...initialState,
    turnActive: true,
    goals,
    tokens: { turn, session: turn },
    stream: { ...initialState.stream, buffer },
  };
}

// ---------------------------------------------------------------------------
// idle
// ---------------------------------------------------------------------------

describe('layoutForHeight — idle', () => {
  it('hides the whole block when the turn is idle', () => {
    const plan = layoutForHeight(initialState, 24);
    assert.equal(plan.visible, false);
    assert.equal(plan.plannedRows, 0);
    assert.equal(plan.goals.kind, 'hidden');
  });
});

// ---------------------------------------------------------------------------
// full cards
// ---------------------------------------------------------------------------

describe('layoutForHeight — full cards when they fit', () => {
  it('shows every goal as a full card on a roomy terminal', () => {
    const goals = [
      goal({ id: 'a', agents: [agent(), agent({ provider: 'codex', model: 'gpt-5' })] }),
      goal({ id: 'b', label: 'Add tests', state: 'queued', agents: [agent({ state: 'queued' })] }),
    ];
    const plan = layoutForHeight(active(goals, 'streaming…'), 40, 1);
    assert.equal(plan.visible, true);
    assert.equal(plan.goals.kind, 'full');
    if (plan.goals.kind === 'full') assert.equal(plan.goals.goals.length, 2);
    // the stream gets its 1 line
    assert.equal(plan.streamCap, 1);
  });

  it('goalCardRows = 1 header + one row per agent', () => {
    assert.equal(goalCardRows(goal({ agents: [agent()] })), 2);
    assert.equal(goalCardRows(goal({ agents: [agent(), agent(), agent()] })), 4);
    assert.equal(goalCardRows(goal({ agents: [] })), 1);
  });
});

// ---------------------------------------------------------------------------
// stream truncation
// ---------------------------------------------------------------------------

describe('layoutForHeight — stream truncation to last K', () => {
  it('caps the live stream to the rows left after the (full) panel + status line', () => {
    // One goal, one agent → full panel = 2 borders + 1 header + 1 agent = 4 rows.
    const goals = [goal({ agents: [agent()] })];
    // Ask for a 50-line stream on a height where only a few lines fit.
    const rows = 12;
    const plan = layoutForHeight(active(goals, 'x'), rows, 50);
    const budget = rows - INPUT_ROWS - SAFETY_MARGIN_ROWS; // 8
    const panelRows = PANEL_BORDER_ROWS + 1 + 1; // 4
    assert.equal(plan.goals.kind, 'full');
    assert.equal(plan.streamCap, budget - panelRows - STATUS_LINE_ROWS); // 8-4-1 = 3
    // never exceeds the budget
    assert.ok(plan.plannedRows + INPUT_ROWS <= rows, `plannedRows=${plan.plannedRows}`);
  });
});

// ---------------------------------------------------------------------------
// collapse to compact summary
// ---------------------------------------------------------------------------

describe('layoutForHeight — COLLAPSE to compact summary under pressure', () => {
  it('collapses many full cards to a one-line summary when they would overflow', () => {
    const goals = [
      goal({ id: 'a', state: 'running', agents: [agent(), agent(), agent()] }),
      goal({ id: 'b', state: 'running', agents: [agent(), agent()] }),
      goal({ id: 'c', state: 'queued', agents: [agent({ state: 'queued' })] }),
    ];
    // Full panel would be 2 + (1+3) + (1+2) + (1+1) = 11 rows; squeeze the budget.
    const rows = 9; // budget = 9-3-1 = 5; full(11)+status > 5 → compact
    const plan = layoutForHeight(active(goals, '', 4200), rows, 1);
    assert.equal(plan.goals.kind, 'compact');
    if (plan.goals.kind === 'compact') {
      assert.match(plan.goals.summary, /3 goals/);
      assert.match(plan.goals.summary, /2 running/);
      assert.match(plan.goals.summary, /1 queued/);
      assert.match(plan.goals.summary, /↓ 4\.2k tok/);
    }
    assert.ok(plan.plannedRows + INPUT_ROWS <= rows);
  });

  it('compactGoalsSummary counts real goal states', () => {
    const goals = [
      goal({ state: 'running' }),
      goal({ state: 'done' }),
      goal({ state: 'failed' }),
      goal({ state: 'queued' }),
    ];
    const s = compactGoalsSummary(goals, 12_400);
    assert.match(s, /4 goals/);
    assert.match(s, /1 running/);
    assert.match(s, /1 done/);
    assert.match(s, /1 failed/);
    assert.match(s, /1 queued/);
    assert.match(s, /↓ 12\.4k tok/);
  });

  it('pluralises a single goal', () => {
    assert.match(compactGoalsSummary([goal()], 0), /^1 goal /);
  });
});

// ---------------------------------------------------------------------------
// hide panel / drop stream under extreme pressure
// ---------------------------------------------------------------------------

describe('layoutForHeight — extreme pressure', () => {
  it('hides the panel entirely when even the compact summary will not fit', () => {
    const goals = [goal(), goal({ id: 'b' })];
    // budget must be < compact(3)+status(1)=4 but >= 1: rows-4 < 4 → rows < 8.
    const rows = 6; // budget = 2 → compact(3)+status(1)=4 > 2 → hidden
    const plan = layoutForHeight(active(goals, 'x'), rows, 3);
    assert.equal(plan.goals.kind, 'hidden');
    assert.ok(plan.visible);
    assert.ok(plan.plannedRows + INPUT_ROWS <= rows);
  });

  it('drops the stream to 0 in the tiniest viewport but never exceeds the budget', () => {
    const goals = [goal()];
    const rows = 4; // budget = max(1, 4-3-1)=1; only the status line fits
    const plan = layoutForHeight(active(goals, 'lots of text'), rows, 99);
    assert.equal(plan.goals.kind, 'hidden');
    assert.equal(plan.streamCap, 0);
    assert.equal(plan.plannedRows, STATUS_LINE_ROWS);
    // input may not even fit a 4-row terminal, but the DYNAMIC region we control
    // (plannedRows) is floored at the status line and never grows unbounded.
    assert.ok(plan.plannedRows <= 1);
  });
});

// ---------------------------------------------------------------------------
// the load-bearing invariant — exhaustive sweep
// ---------------------------------------------------------------------------

describe('layoutForHeight — invariant: dynamic region <= viewport across all heights', () => {
  it('never plans more rows than the viewport allows, for many goal shapes × heights', () => {
    const shapes: GoalView[][] = [
      [goal({ agents: [agent()] })],
      [goal({ agents: [agent(), agent()] }), goal({ id: 'b' })],
      [
        goal({ id: 'a', agents: [agent(), agent(), agent(), agent()] }),
        goal({ id: 'b', agents: [agent(), agent()] }),
        goal({ id: 'c', agents: [agent()] }),
      ],
    ];
    for (const goals of shapes) {
      for (let rows = 1; rows <= 60; rows += 1) {
        for (const streamLines of [0, 1, 5, 40]) {
          const plan = layoutForHeight(active(goals, streamLines > 0 ? 'x' : ''), rows, streamLines);
          // The region we OWN above the input never exceeds the budget; and when
          // the terminal is large enough to hold the input, the whole stack fits.
          const budget = Math.max(1, rows - INPUT_ROWS - SAFETY_MARGIN_ROWS);
          assert.ok(
            plan.plannedRows <= budget,
            `plannedRows ${plan.plannedRows} > budget ${budget} at rows=${rows} streamLines=${streamLines}`,
          );
          // streamCap never exceeds the requested line count
          assert.ok(plan.streamCap <= streamLines);
        }
      }
    }
  });
});
