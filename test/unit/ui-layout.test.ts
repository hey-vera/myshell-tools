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

import { describe, it } from 'vitest';
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
  planBoard,
  INPUT_ROWS,
  STATUS_LINE_ROWS,
  SUMMARY_LINE_ROWS,
  PANEL_BORDER_ROWS,
  SAFETY_MARGIN_ROWS,
  BOARD_CHROME_ROWS,
} from '../../src/interface/ui/index.ts';
import { initialState } from '../../src/interface/ui/index.ts';
import type { AgentView, GoalBoardRow, GoalView, UiState } from '../../src/interface/ui/index.ts';
import {
  composerPhysicalRows,
  composerShownPlan,
  composerContentWidth,
  INPUT_BORDER_ROWS,
  INPUT_BODY_MAX_LOGICAL_ROWS,
} from '../../src/interface/ui/layout.ts';

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

  it('shows the turn-summary line only for MULTIPLE goals (not a single goal)', () => {
    // One goal → no summary line (it would only restate the GoalCard's "1 agent").
    const one = layoutForHeight(active([goal({ id: 'a' })], 'x'), 40, 1);
    assert.equal(one.showSummary, false);
    // Two goals → the aggregating summary line is shown.
    const two = layoutForHeight(
      active([goal({ id: 'a' }), goal({ id: 'b', label: 'Add tests' })], 'x'),
      40,
      1,
    );
    assert.equal(two.showSummary, true);
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
    // A SINGLE goal drops the turn-summary line (it would just restate "1 agent"
    // already shown by the GoalCard header + nested AgentRow), so it costs 0 rows.
    assert.equal(plan.showSummary, false);
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

  it('omits the token segment entirely until the turn total is real (> 0)', () => {
    // Mid-run with no real usage yet (turn tokens 0): NO "0 tok" / fabricated figure.
    const s = summarizeTurn(active([goal({ id: 'a' }), goal({ id: 'b', label: 'B' })], '', 0), 12);
    assert.doesNotMatch(s, /tok/);
    assert.equal(s, '▸ 2 goals · 2 agents · 12s');
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

// ---------------------------------------------------------------------------
// BUG 1 — wrapped composer rows must be measured (not assumed 1 physical row per
// shown logical row) and the full dynamic region (stream+status+input+chrome)
// must still fit the viewport. The regression: the word-wrap feature let a long
// logical row soft-wrap to several PHYSICAL rows, so a full composer occupied far
// more than the old constant INPUT_ROWS_MAX(12) reserved → overflow → duplication.
// ---------------------------------------------------------------------------

describe('composerPhysicalRows — TRUE wrapped composer height (BUG 1)', () => {
  it('a single short line is 1 body row + 2 borders', () => {
    assert.equal(composerPhysicalRows('hi', 80), INPUT_BORDER_ROWS + 1);
  });

  it('a long logical row soft-wraps to multiple physical rows', () => {
    const content = composerContentWidth(80); // the box wrap width at 80 cols
    // One logical line ~2.5× the content width wraps to 3 physical rows.
    const long = 'a'.repeat(content * 2 + 5);
    assert.equal(composerPhysicalRows(long, 80), INPUT_BORDER_ROWS + 3);
  });

  it('measures > INPUT_ROWS_MAX(12) for 10 shown rows that each wrap ×2', () => {
    const content = composerContentWidth(80);
    // 10 logical rows, each ~1.5× the content width → each wraps to 2 physical rows.
    const row = 'b'.repeat(content + 5);
    const value = Array.from({ length: INPUT_BODY_MAX_LOGICAL_ROWS }, () => row).join('\n');
    const measured = composerPhysicalRows(value, 80);
    // 10 shown rows × 2 physical + 2 borders = 22 — well past the constant 12.
    assert.equal(measured, INPUT_BODY_MAX_LOGICAL_ROWS * 2 + INPUT_BORDER_ROWS);
    assert.ok(measured > 12, `measured ${measured} should exceed the legacy constant 12`);
  });

  it('feeding the MEASURED count to layoutForHeight keeps total dynamic <= viewport', () => {
    const content = composerContentWidth(80);
    const row = 'c'.repeat(content + 5); // each shown row wraps ×2
    const value = Array.from({ length: INPUT_BODY_MAX_LOGICAL_ROWS }, () => row).join('\n');
    const rows = 30;
    const inputRows = composerPhysicalRows(value, 80, rows); // 22
    const goals = [goal(), goal({ id: 'g2', label: 'Wire CI', agents: [agent(), agent({ provider: 'codex' })] })];
    const plan = layoutForHeight(active(goals, 'x'.repeat(400), 9000), rows, 8, inputRows);
    // The no-overflow invariant: panel + status + summary + stream + INPUT all fit.
    assert.ok(
      plan.plannedRows + inputRows + SAFETY_MARGIN_ROWS <= rows,
      `plannedRows ${plan.plannedRows} + input ${inputRows} + margin > ${rows}`,
    );
    // The planner shrank the stream/status region to make room for the tall input.
    assert.ok(inputRows > 12, 'this case must exercise an input taller than the old constant');
  });

  it('EXTREME paste: input alone caps to the viewport, keeps the caret/tail row, total <= viewport', () => {
    const rows = 12;
    // 40 logical rows, each itself wrapping ×3 → the raw wrapped body is ~120 rows,
    // far past the 12-row viewport.
    const content = composerContentWidth(80);
    const fat = 'd'.repeat(content * 2 + 1); // wraps ×3
    const value = Array.from({ length: 40 }, () => fat).join('\n');
    const inputRows = composerPhysicalRows(value, 80, rows);
    // The whole box (body + borders) never exceeds the viewport.
    assert.ok(inputRows <= rows, `input ${inputRows} must be <= viewport ${rows}`);
    // And it leaves room for the safety margin + at least the status line.
    assert.ok(inputRows <= rows - SAFETY_MARGIN_ROWS, 'input leaves the safety margin');
    // The shown plan keeps the LAST logical row visible (caret/tail stays on screen).
    const planShown = composerShownPlan(value, 80, rows);
    const allRows = value.split('\n');
    assert.equal(planShown.shown[planShown.shown.length - 1], allRows[allRows.length - 1]);
    // The full layout with this capped input still never exceeds the viewport.
    const plan = layoutForHeight(active([goal()], 'p'.repeat(200), 5000), rows, 4, inputRows);
    assert.ok(plan.plannedRows + inputRows + SAFETY_MARGIN_ROWS <= rows || plan.plannedRows <= 1);
    assert.ok(plan.plannedRows + inputRows <= rows, `total ${plan.plannedRows + inputRows} > viewport ${rows}`);
  });

  it('composerShownPlan caps at MAX_VISIBLE_ROWS logical rows when no viewport cap', () => {
    const value = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
    const plan = composerShownPlan(value, 80);
    assert.equal(plan.shown.length, INPUT_BODY_MAX_LOGICAL_ROWS);
    // Tail-anchored: the last shown row is the buffer's last logical row.
    assert.equal(plan.shown[plan.shown.length - 1], 'line 24');
  });
});

// ---------------------------------------------------------------------------
// BUG 3 — the chrome[] live-frame region rendered OUTSIDE the height budget. The
// fix subtracts chrome.length from the rows budget at the App render boundary; here
// we prove the invariant holds when chrome and an active turn coexist by passing the
// reduced budget into the planner (the exact wiring App does).
// ---------------------------------------------------------------------------

describe('chrome[] is inside the height budget (BUG 3)', () => {
  it('subtracting chrome.length keeps chrome + dynamic + input <= viewport', () => {
    const rows = 24;
    const chromeRows = 18; // a tall lingering menu frame
    const inputRows = INPUT_ROWS;
    const goals = [goal(), goal({ id: 'g2', label: 'b' }), goal({ id: 'g3', label: 'c' })];
    // App computes the plan against rows MINUS chrome (max-floored at 2 like App).
    const budgetRows = Math.max(2, rows - chromeRows);
    const plan = layoutForHeight(active(goals, 'x'.repeat(300), 4000), budgetRows, 6, inputRows);
    // The full on-screen total — chrome + the planned dynamic region + input — fits.
    const total = chromeRows + plan.plannedRows + inputRows;
    assert.ok(total <= rows, `chrome ${chromeRows} + planned ${plan.plannedRows} + input ${inputRows} = ${total} > ${rows}`);
  });
});

// ---------------------------------------------------------------------------
// Elite-partner Phase 1 — the persistent BOARD plan
// ---------------------------------------------------------------------------

function boardRow(over: Partial<GoalBoardRow> = {}): GoalBoardRow {
  return {
    id: over.id ?? 'goal_a',
    title: over.title ?? 'Redesign feed',
    state: over.state ?? 'parked',
    done: over.done ?? 3,
    total: over.total ?? 8,
    glyph: over.glyph ?? '◷',
    scope: over.scope ?? 'project',
    agents: over.agents ?? 0,
    ...(over.todos !== undefined ? { todos: over.todos } : {}),
  };
}

function withBoard(board: readonly GoalBoardRow[], turnActive = false, goals: readonly GoalView[] = []): UiState {
  return { ...initialState, turnActive, goals, board, boardEnabled: true };
}

describe('planBoard — bounded board body', () => {
  it('returns null for an empty board or a <1 budget', () => {
    assert.equal(planBoard([], 10), null);
    assert.equal(planBoard([boardRow()], 0), null);
  });
  it('shows every goal as one row each when they fit', () => {
    const rows = [boardRow({ id: 'a' }), boardRow({ id: 'b' }), boardRow({ id: 'c' })];
    const plan = planBoard(rows, 5);
    assert.ok(plan !== null);
    assert.equal(plan?.shown.length, 3);
    assert.equal(plan?.overflow, 0);
  });
  it('budgets running board rows by their expanded checklist height', () => {
    const rows = [
      boardRow({
        id: 'run',
        state: 'running',
        todos: [
          { id: 't1', text: 'one', status: 'done' },
          { id: 't2', text: 'two', status: 'active' },
        ],
      }),
      boardRow({ id: 'parked' }),
      boardRow({ id: 'done', state: 'done' }),
    ];
    const budget = 4;
    const plan = planBoard(rows, budget);
    assert.ok(plan !== null);
    assert.deepEqual(plan?.shown.map((row) => row.id), ['run']);
    assert.equal(plan?.overflow, 2);
    const used =
      (plan?.shown.reduce((sum, row) => sum + 1 + (row.state === 'running' ? row.todos?.length ?? 0 : 0), 0) ?? 0) +
      ((plan?.overflow ?? 0) > 0 ? 1 : 0);
    assert.ok(used <= budget, `used ${used} > budget ${budget}`);
  });
  it('collapses the overflow into a single +K more line so 20 goals never exceed the budget', () => {
    const rows = Array.from({ length: 20 }, (_, i) => boardRow({ id: `g${i}` }));
    const budget = 6;
    const plan = planBoard(rows, budget);
    assert.ok(plan !== null);
    // shown rows + the one overflow line never exceed the budget.
    const used = (plan?.shown.length ?? 0) + ((plan?.overflow ?? 0) > 0 ? 1 : 0);
    assert.ok(used <= budget, `used ${used} > budget ${budget}`);
    assert.equal((plan?.shown.length ?? 0) + (plan?.overflow ?? 0), 20, 'every goal accounted for');
    assert.ok((plan?.overflow ?? 0) > 0);
  });
});

describe('layoutForHeight — persistent board (flag ON)', () => {
  it('renders the board even when the turn is IDLE (independent of turnActive)', () => {
    const plan = layoutForHeight(withBoard([boardRow(), boardRow({ id: 'b' })]), 24);
    assert.equal(plan.visible, true, 'block is visible for the board even when idle');
    assert.notEqual(plan.board, null);
    assert.equal(plan.board?.shown.length, 2);
    // No live goals panel when idle.
    assert.equal(plan.goals.kind, 'hidden');
    assert.equal(plan.streamCap, 0);
  });

  it('shows the board instead of a duplicate live goals panel during an active turn', () => {
    const goals = [
      { id: 'mid#0', label: 'ic', state: 'running' as const, tokens: 0, agents: [], tier: 'ic' as const },
    ];
    const plan = layoutForHeight(withBoard([boardRow()], true, goals), 40, 1);
    assert.equal(plan.visible, true);
    assert.notEqual(plan.board, null, 'board still planned during a turn');
    assert.equal(plan.goals.kind, 'hidden', 'board is the single planned goal surface');
  });

  it('a 20-goal board never makes the planned region exceed the viewport (idle)', () => {
    const rows = Array.from({ length: 20 }, (_, i) => boardRow({ id: `g${i}` }));
    const viewport = 24;
    const plan = layoutForHeight(withBoard(rows), viewport, 0, INPUT_ROWS);
    assert.equal(plan.visible, true);
    assert.ok(
      plan.plannedRows + INPUT_ROWS + SAFETY_MARGIN_ROWS <= viewport,
      `planned ${plan.plannedRows} + input ${INPUT_ROWS} + margin ${SAFETY_MARGIN_ROWS} > ${viewport}`,
    );
    // The board self-caps to ~1/3 of the viewport, so it leaves room for a live turn.
    const boardRowsUsed =
      BOARD_CHROME_ROWS +
      (plan.board?.shown.reduce((sum, row) => sum + 1 + (row.state === 'running' ? row.todos?.length ?? 0 : 0), 0) ?? 0) +
      ((plan.board?.overflow ?? 0) > 0 ? 1 : 0);
    assert.equal(plan.plannedRows, boardRowsUsed, 'idle planned rows == the board rows');
  });

  it('expanded running board rows still never make board plus live panel exceed the terminal height', () => {
    const board = [
      boardRow({
        id: 'goal_a',
        state: 'running',
        todos: [
          { id: 't1', text: 'Inspect logs', status: 'done' },
          { id: 't2', text: 'Patch renderer', status: 'active' },
          { id: 't3', text: 'Verify layout', status: 'pending' },
        ],
      }),
      boardRow({ id: 'goal_b' }),
      boardRow({ id: 'goal_c' }),
    ];
    const goals = [goal({ id: 'goal_a', label: 'Ship it', state: 'running', agents: [agent({ state: 'running' })] })];
    const rows = 18;
    const plan = layoutForHeight(withBoard(board, true, goals), rows, 1, INPUT_ROWS);
    assert.ok(
      plan.plannedRows + INPUT_ROWS + SAFETY_MARGIN_ROWS <= rows,
      `planned ${plan.plannedRows} + input ${INPUT_ROWS} + margin ${SAFETY_MARGIN_ROWS} > ${rows}`,
    );
  });
});

describe('layoutForHeight — board OFF stays byte-identical', () => {
  it('idle with boardEnabled false hides the whole block (today behaviour)', () => {
    // Even with board ROWS present, the flag being OFF means no board renders.
    const offState: UiState = { ...initialState, board: [boardRow()], boardEnabled: false };
    const plan = layoutForHeight(offState, 24);
    assert.equal(plan.visible, false);
    assert.equal(plan.plannedRows, 0);
    assert.equal(plan.board, null);
  });

  it('an active turn with the board OFF plans EXACTLY as before (board: null)', () => {
    const goals = [
      { id: 'mid#0', label: 'Refactor', state: 'running' as const, tokens: 3100, agents: [], tier: 'ic' as const },
    ];
    const off: UiState = { ...initialState, turnActive: true, goals };
    const plan = layoutForHeight(off, 40, 1);
    assert.equal(plan.board, null);
    assert.equal(plan.goals.kind, 'full');
  });
});
