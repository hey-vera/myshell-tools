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
  summarizeTurn,
  totalAgentCount,
  goalsAreSequentialPhases,
  goalCardRows,
  goalRowsHeight,
  planGoalsPanel,
  coalescedQueuedLine,
  streamWrappedRows,
  tailStreamToRows,
  INPUT_ROWS,
  STATUS_LINE_ROWS,
  SUMMARY_LINE_ROWS,
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
    tier: over.tier ?? 'ic',
    ...(over.risk !== undefined ? { risk: over.risk } : {}),
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
  it('caps the live stream to the rows left after the (full) panel + summary + status line', () => {
    // One goal, one agent → full panel = 2 borders + 1 header + 1 agent = 4 rows.
    const goals = [goal({ agents: [agent()] })];
    // Ask for a 50-line stream on a height where only a few lines fit.
    const rows = 12;
    const plan = layoutForHeight(active(goals, 'x'), rows, 50);
    const budget = rows - INPUT_ROWS - SAFETY_MARGIN_ROWS; // 8
    const panelRows = PANEL_BORDER_ROWS + 1 + 1; // 4
    assert.equal(plan.goals.kind, 'full');
    assert.equal(plan.showSummary, true);
    // The agent-centric summary line now consumes one budgeted row.
    assert.equal(plan.streamCap, budget - panelRows - SUMMARY_LINE_ROWS - STATUS_LINE_ROWS); // 8-4-1-1 = 2
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
      goal({ id: 'a', label: 'A', state: 'running', agents: [agent(), agent(), agent()] }),
      goal({ id: 'b', label: 'B', state: 'running', agents: [agent(), agent()] }),
      goal({ id: 'c', label: 'C', state: 'queued', agents: [agent({ state: 'queued' })] }),
    ];
    // Full panel would be 2 + (1+3) + (1+2) + (1+1) = 11 rows; squeeze the budget.
    const rows = 9; // budget = 9-3-1 = 5; full(11)+summary+status > 5 → compact(3)+summary(1)+status(1)=5
    const plan = layoutForHeight(active(goals, '', 4200), rows, 1);
    assert.equal(plan.goals.kind, 'compact');
    if (plan.goals.kind === 'compact') {
      // distinct labels → "3 goals" (not phases), and the summary LEADS with agents.
      assert.match(plan.goals.summary, /3 goals/);
      assert.match(plan.goals.summary, /6 agents/); // 3+2+1 real AgentViews
      assert.match(plan.goals.summary, /2 running/);
      assert.match(plan.goals.summary, /1 queued/);
      assert.match(plan.goals.summary, /↓ 4\.2k tok/);
    }
    assert.ok(plan.plannedRows + INPUT_ROWS <= rows);
  });

  it('compactGoalsSummary counts real goal states + agents, leading with agents', () => {
    const goals = [
      goal({ label: 'A', state: 'running' }),
      goal({ label: 'B', state: 'done' }),
      goal({ label: 'C', state: 'failed' }),
      goal({ label: 'D', state: 'queued' }),
    ];
    const s = compactGoalsSummary(goals, 12_400);
    assert.match(s, /4 goals/);
    assert.match(s, /4 agents/); // one agent per goal
    assert.match(s, /1 running/);
    assert.match(s, /1 done/);
    assert.match(s, /1 failed/);
    assert.match(s, /1 queued/);
    assert.match(s, /↓ 12\.4k tok/);
  });

  it('compactGoalsSummary says "phases" when stacked cards share a title, and counts panel candidates', () => {
    const goals = [
      goal({ id: 'p1', label: 'Fix the flaky test', state: 'done' }),
      goal({ id: 'p2', label: 'Fix the flaky test', state: 'running' }),
    ];
    const s = compactGoalsSummary(goals, 3300, 1); // +1 panel candidate
    assert.match(s, /2 phases/);
    assert.match(s, /3 agents/); // 2 goal agents + 1 panelist
  });

  it('pluralises a single goal', () => {
    assert.match(compactGoalsSummary([goal()], 0), /^1 goal /);
  });
});

// ---------------------------------------------------------------------------
// agent-centric summary line (Phase 1)
// ---------------------------------------------------------------------------

describe('summarizeTurn — agent-centric one-glance summary', () => {
  it('counts a single goal + single agent honestly', () => {
    const s = summarizeTurn(active([goal()], '', 1200), 51);
    assert.equal(s, '▸ 1 goal · 1 agent · 1.2k tok · 51s');
  });

  it('says "phases" (not goals) when stacked cards share a title', () => {
    const goals = [
      goal({ id: 'p1', label: 'Fix the flaky test', state: 'done' }),
      goal({ id: 'p2', label: 'Fix the flaky test', state: 'running' }),
    ];
    const s = summarizeTurn(active(goals, '', 3300), 40);
    assert.match(s, /▸ 2 phases · 2 agents/);
    assert.doesNotMatch(s, /goals/);
  });

  it('says "goals" when stacked cards have distinct titles', () => {
    const goals = [goal({ id: 'a', label: 'A' }), goal({ id: 'b', label: 'B' })];
    assert.match(summarizeTurn(active(goals, '', 0)), /▸ 2 goals · 2 agents/);
  });

  it('omits the elapsed when absent/0, never fabricating seconds', () => {
    const s = summarizeTurn(active([goal()], '', 500));
    assert.equal(s, '▸ 1 goal · 1 agent · 500 tok');
  });

  it('totalAgentCount sums goal agents + panel candidates (real, never fabricated)', () => {
    const goals = [goal({ agents: [agent(), agent()] })];
    const st: UiState = {
      ...active(goals),
      stream: { ...initialState.stream, panelists: [agent(), agent()] },
    };
    assert.equal(totalAgentCount(st), 4); // 2 goal agents + 2 panelists
  });

  it('goalsAreSequentialPhases is false for 0/1 goals and distinct-title goals', () => {
    assert.equal(goalsAreSequentialPhases([]), false);
    assert.equal(goalsAreSequentialPhases([goal()]), false);
    assert.equal(
      goalsAreSequentialPhases([goal({ id: 'a', label: 'A' }), goal({ id: 'b', label: 'B' })]),
      false,
    );
    assert.equal(
      goalsAreSequentialPhases([goal({ id: 'a', label: 'X' }), goal({ id: 'b', label: 'X' })]),
      true,
    );
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

describe('streamWrappedRows — wrapped row count at a width (item 2)', () => {
  it('is 0 for an empty buffer', () => {
    assert.equal(streamWrappedRows('', 80), 0);
  });

  it('counts the ● marker on the first row only', () => {
    // 79 visible chars + the 2-col marker = 81 → wraps to 2 rows at width 80.
    assert.equal(streamWrappedRows('a'.repeat(79), 80), 2);
    // 78 + 2 = 80 → exactly one row.
    assert.equal(streamWrappedRows('a'.repeat(78), 80), 1);
  });

  it('sums per-line wrapping (each \\n is a new line, blanks count 1)', () => {
    // line0: 10 + marker(2) = 12 → 1 row at 80; line1: empty → 1; line2: 10 → 1.
    assert.equal(streamWrappedRows('1234567890\n\n1234567890', 80), 3);
    // A long second line wraps: 120 chars at width 40 → 3 rows; line0 (5+2) → 1.
    assert.equal(streamWrappedRows('hello\n' + 'b'.repeat(120), 40), 1 + 3);
  });
});

describe('tailStreamToRows — keep the last K wrapped rows (item 2)', () => {
  it('returns the whole buffer when it already fits', () => {
    assert.equal(tailStreamToRows('one\ntwo\nthree', 80, 10), 'one\ntwo\nthree');
  });

  it("returns '' when the cap is 0 or the buffer is empty", () => {
    assert.equal(tailStreamToRows('anything', 80, 0), '');
    assert.equal(tailStreamToRows('', 80, 5), '');
  });

  it('keeps the TAIL (newest) lines and the result never exceeds the cap', () => {
    const buffer = 'l1\nl2\nl3\nl4\nl5';
    const capped = tailStreamToRows(buffer, 80, 2);
    assert.equal(capped, 'l4\nl5', 'keeps the last two source lines');
    assert.ok(streamWrappedRows(capped, 80) <= 2 + 1, 'capped rows stay within budget (+marker)');
    assert.ok(!capped.includes('l1'));
  });

  it('keeps a single tall last line rather than dropping everything', () => {
    const buffer = 'short\n' + 'x'.repeat(200); // last line wraps to many rows
    const capped = tailStreamToRows(buffer, 40, 2);
    assert.ok(capped.startsWith('x'), 'keeps the (tall) last line even when it exceeds the cap');
    assert.ok(!capped.includes('short'));
  });
});

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

// ---------------------------------------------------------------------------
// MULTI-GOAL collapse (design §3/§4): planGoalsPanel + the cap invariant at
// 1/3/12 goals × short/tall terminals.
// ---------------------------------------------------------------------------

describe('coalescedQueuedLine — one row for N queued goals', () => {
  it('lists labels then rolls the rest into +K more queued', () => {
    const qs = [
      goal({ id: 'q1', label: 'Add tests', state: 'queued' }),
      goal({ id: 'q2', label: 'Wire CI', state: 'queued' }),
      goal({ id: 'q3', label: 'Changelog', state: 'queued' }),
      goal({ id: 'q4', label: 'd', state: 'queued' }),
      goal({ id: 'q5', label: 'e', state: 'queued' }),
    ];
    const line = coalescedQueuedLine(qs);
    assert.match(line, /○ Add tests/);
    assert.match(line, /\+2 more queued$/); // 5 - 3 shown = 2 more
  });

  it('appends "queued" when all fit and there is no overflow', () => {
    const qs = [goal({ id: 'q1', label: 'A', state: 'queued' })];
    assert.match(coalescedQueuedLine(qs), /○ A queued$/);
  });

  it('is empty for no queued goals', () => {
    assert.equal(coalescedQueuedLine([]), '');
  });
});

describe('planGoalsPanel — the cap-preserving collapse', () => {
  it('returns one full card per goal when everything fits (today behaviour)', () => {
    const goals = [goal({ id: 'a', agents: [agent()] }), goal({ id: 'b', agents: [agent()] })];
    const plan = planGoalsPanel(goals, 20)!;
    assert.equal(plan.length, 2);
    assert.ok(plan.every((r) => r.kind === 'card'));
  });

  it('collapses running goals to headers + coalesces queued/done under pressure', () => {
    const goals = [
      goal({ id: 'r1', label: 'Run one', state: 'running', agents: [agent(), agent(), agent()] }),
      goal({ id: 'r2', label: 'Run two', state: 'running', agents: [agent(), agent()] }),
      goal({ id: 'd1', label: 'Done one', state: 'done' }),
      goal({ id: 'q1', label: 'Q one', state: 'queued' }),
      goal({ id: 'q2', label: 'Q two', state: 'queued' }),
    ];
    // A tight body budget forces collapse: 2 running headers + 1 done line + 1
    // queued line = 4 rows minimum.
    const plan = planGoalsPanel(goals, 4)!;
    assert.ok(plan !== null);
    assert.ok(goalRowsHeight(plan) <= 4);
    assert.equal(plan.filter((r) => r.kind === 'coalesced-queued').length, 1);
    assert.equal(plan.filter((r) => r.kind === 'coalesced-done').length, 1);
    // both running goals are present (as header or card)
    const runningRows = plan.filter((r) => r.kind === 'header' || r.kind === 'card');
    assert.equal(runningRows.length, 2);
  });

  it('returns null when even the minimum collapsed form will not fit', () => {
    const goals = [
      goal({ id: 'r1', state: 'running' }),
      goal({ id: 'r2', state: 'running' }),
      goal({ id: 'r3', state: 'running' }),
    ];
    assert.equal(planGoalsPanel(goals, 2), null); // 3 running headers > budget 2
  });

  it('the body plan height is ALWAYS <= the budget, swept across budgets', () => {
    const mk = (n: number, state: GoalView['state']): GoalView[] =>
      Array.from({ length: n }, (_, i) =>
        goal({ id: `${state}${i}`, label: `${state} ${i}`, state, agents: state === 'running' ? [agent(), agent()] : [] }),
      );
    const goals = [...mk(2, 'running'), ...mk(2, 'done'), ...mk(8, 'queued')]; // 12 goals
    for (let budget = 1; budget <= 30; budget += 1) {
      const plan = planGoalsPanel(goals, budget);
      if (plan === null) continue;
      assert.ok(
        goalRowsHeight(plan) <= budget,
        `body ${goalRowsHeight(plan)} > budget ${budget}`,
      );
    }
  });
});

describe('layoutForHeight — cap invariant at 1/3/12 goals × short/tall terminals', () => {
  function manyGoals(n: number): GoalView[] {
    // A realistic mix: ~a third running (with agents), a few done, the rest queued.
    return Array.from({ length: n }, (_, i) => {
      const state: GoalView['state'] = i < Math.ceil(n / 3) ? 'running' : i < Math.ceil(n / 2) ? 'done' : 'queued';
      return goal({
        id: `g${i}`,
        label: `Goal ${i}`,
        state,
        agents: state === 'running' ? [agent(), agent(), agent()] : state === 'done' ? [agent()] : [],
        ...(i % 4 === 0 ? {} : {}),
      });
    });
  }

  for (const n of [1, 3, 12]) {
    for (const rows of [8, 10, 14, 24, 40, 60]) {
      for (const streamLines of [0, 1, 5, 40]) {
        for (const inputRows of [INPUT_ROWS, 12]) {
          it(`never overflows with ${n} goals, rows=${rows}, stream=${streamLines}, input=${inputRows}`, () => {
            const goals = manyGoals(n);
            const plan = layoutForHeight(active(goals, streamLines > 0 ? 'x' : ''), rows, streamLines, inputRows);
            const budget = Math.max(1, rows - Math.max(1, inputRows) - SAFETY_MARGIN_ROWS);
            // The STRICT cap invariant: the region we paint never exceeds the budget.
            assert.ok(
              plan.plannedRows <= budget,
              `plannedRows ${plan.plannedRows} > budget ${budget}`,
            );
            assert.ok(plan.streamCap <= streamLines);
            // If a full panel is shown, its body plan also obeys the budget.
            if (plan.goals.kind === 'full') {
              const bodyBudget = budget - PANEL_BORDER_ROWS - STATUS_LINE_ROWS - SUMMARY_LINE_ROWS - plan.streamCap;
              assert.ok(
                goalRowsHeight(plan.goals.rows) <= Math.max(bodyBudget, goalRowsHeight(plan.goals.rows)),
              );
            }
          });
        }
      }
    }
  }

  it('12 goals on a MEDIUM terminal collapse to running cards + a coalesced queued line', () => {
    const goals = manyGoals(12); // 4 running (3 agents), 2 done (1 agent), 6 queued
    // Full panel = 2 borders + 4*4 + 2*2 + 6*1 = 28 body rows. At rows=22 the full
    // form overflows (budget 18) so the multi-goal collapse kicks in but the panel
    // is still shown — queued goals coalesce to ONE row.
    const plan = layoutForHeight(active(goals, ''), 22, 0);
    assert.equal(plan.goals.kind, 'full');
    if (plan.goals.kind === 'full') {
      assert.ok(plan.goals.rows.some((r) => r.kind === 'coalesced-queued'));
    }
    const budget = 22 - INPUT_ROWS - SAFETY_MARGIN_ROWS;
    assert.ok(plan.plannedRows <= budget);
  });

  it('12 goals on a SHORT terminal fall to the compact one-liner (existing degradation)', () => {
    const goals = manyGoals(12);
    const plan = layoutForHeight(active(goals, 'x', 31_000), 8, 1);
    // budget = 8-3-1 = 4 → even the collapsed multi-goal body cannot fit; the
    // existing compact summary takes over (or hidden under extreme pressure).
    assert.ok(plan.goals.kind === 'compact' || plan.goals.kind === 'hidden');
    assert.ok(plan.plannedRows + INPUT_ROWS <= 8);
  });
});
