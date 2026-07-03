/**
 * test/ui/goal-quick-strip.test.tsx — Ink component tests for the GoalQuickStrip
 * inline goals strip (Phase 2). Runs under `npm run test:ui` (tsx +
 * ink-testing-library).
 *
 * Asserts: active+inactive goals rendered as compact rows, progress indicator
 * (done/total), overflow cap for many goals, strip hidden when fullscreen panel
 * is open / at menu, and the pure selector ordering + zero-board return.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { GoalQuickStrip } from '../../src/interface/ui/GoalQuickStrip.js';
import { selectGoalQuickRows, goalStripPlannedRows, GOAL_STRIP_MAX_GOALS, GOAL_STRIP_HEADER_ROWS } from '../../src/interface/ui/layout.js';
import { App, createInkAppBridge } from '../../src/interface/ui/App.js';
import { initialState, type GoalBoardRow, type UiState } from '../../src/interface/ui/index.js';

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    ...(over.depth !== undefined ? { depth: over.depth } : {}),
    ...(over.todos !== undefined ? { todos: over.todos } : {}),
    ...(over.verdict !== undefined ? { verdict: over.verdict } : {}),
    ...(over.approach !== undefined ? { approach: over.approach } : {}),
  };
}

function stateWithBoard(board: readonly GoalBoardRow[]): UiState {
  return { ...initialState, board, boardEnabled: true, turnActive: true };
}

// ---------------------------------------------------------------------------
// Component-level tests (GoalQuickStrip direct render)
// ---------------------------------------------------------------------------

test('renders header and both active and inactive goal rows', () => {
  const rows = selectGoalQuickRows(
    stateWithBoard([
      boardRow({ id: 'a', title: 'Build panel nav', state: 'running', done: 2, total: 5, glyph: '\u25CF', agents: 2 }),
      boardRow({ id: 'b', title: 'Clean docs', state: 'done', done: 4, total: 4, glyph: '\u25CB' }),
      boardRow({ id: 'c', title: 'Release polish', state: 'parked', done: 1, total: 6, glyph: '\u25CC' }),
    ]),
  );

  const { lastFrame } = render(<GoalQuickStrip rows={rows} color={false} columns={80} />);
  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  // Header: "goals  3 total · 1 active"
  assert.match(plain, /goals.*3 total.*1 active/);
  // Active goal (running)
  assert.match(plain, /\u25CF.*Build panel nav.*2\/5/);
  assert.match(plain, /running/);
  // Inactive goal (done)
  assert.match(plain, /\u25CB.*Clean docs.*4\/4/);
  assert.match(plain, /done/);
  // Inactive goal (parked)
  assert.match(plain, /\u25CC.*Release polish.*1\/6/);
  assert.match(plain, /parked/);
});

test('progress indicator shows done/total for each goal', () => {
  const rows = selectGoalQuickRows(
    stateWithBoard([
      boardRow({ id: 'a', title: 'Task A', state: 'running', done: 0, total: 3, glyph: '\u25CF' }),
      boardRow({ id: 'b', title: 'Task B', state: 'done', done: 7, total: 7, glyph: '\u25CB' }),
    ]),
  );

  const { lastFrame } = render(<GoalQuickStrip rows={rows} color={false} columns={80} />);
  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  assert.match(plain, /0\/3/);
  assert.match(plain, /7\/7/);
});

test('agent count shown for running goals', () => {
  const rows = selectGoalQuickRows(
    stateWithBoard([
      boardRow({ id: 'a', title: 'Active work', state: 'running', done: 1, total: 3, glyph: '\u25CF', agents: 3 }),
      boardRow({ id: 'b', title: 'Done work', state: 'done', done: 5, total: 5, glyph: '\u25CB', agents: 0 }),
    ]),
  );

  const { lastFrame } = render(<GoalQuickStrip rows={rows} color={false} columns={80} />);
  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  assert.match(plain, /3 workers/);
  assert.doesNotMatch(plain, /0 workers/);
});

test('overflow cap works with many goals (> GOAL_STRIP_MAX_GOALS)', () => {
  const manyRows: GoalBoardRow[] = [];
  for (let i = 0; i < 10; i += 1) {
    manyRows.push(boardRow({ id: `g${i}`, title: `Goal ${i}`, state: 'parked', glyph: '\u25CC' }));
  }

  const rows = selectGoalQuickRows(stateWithBoard(manyRows));
  const { lastFrame } = render(<GoalQuickStrip rows={rows} color={false} columns={80} />);
  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  // Only the first MAX goals should render, plus the overflow line.
  for (let i = 0; i < GOAL_STRIP_MAX_GOALS; i += 1) {
    assert.match(plain, new RegExp(`Goal ${i}`));
  }
  // The (MAX+1)th goal must NOT render.
  assert.doesNotMatch(plain, new RegExp(`Goal ${GOAL_STRIP_MAX_GOALS}`));
  // Overflow line "+N more" must appear.
  const overflow = manyRows.length - GOAL_STRIP_MAX_GOALS;
  assert.match(plain, new RegExp(`\\+${overflow} more`));
});

test('empty board renders nothing (null)', () => {
  const rows = selectGoalQuickRows(stateWithBoard([]));
  const { lastFrame } = render(<GoalQuickStrip rows={rows} color={false} columns={80} />);
  const frame = lastFrame() ?? '';
  assert.equal(frame, '');
});

test('selectGoalQuickRows orders active goals first (running, queued), then parked, then terminal', () => {
  const board: GoalBoardRow[] = [
    boardRow({ id: 'done', title: 'Done', state: 'done', glyph: '\u2713' }),
    boardRow({ id: 'running', title: 'Running', state: 'running', glyph: '\u25CF' }),
    boardRow({ id: 'parked', title: 'Parked', state: 'parked', glyph: '\u25CC' }),
    boardRow({ id: 'queued', title: 'Queued', state: 'queued', glyph: '\u25CB' }),
    boardRow({ id: 'failed', title: 'Failed', state: 'failed', glyph: '\u2717' }),
  ];

  const rows = selectGoalQuickRows(stateWithBoard(board));
  const order = rows.map((r) => r.state);
  assert.deepEqual(order, ['running', 'queued', 'parked', 'done', 'failed']);
});

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

test('goalStripPlannedRows returns 0 for empty board', () => {
  assert.equal(goalStripPlannedRows(0), 0);
});

test('goalStripPlannedRows returns header + N goal rows for small board', () => {
  // 3 goals → 1 header + 3 goal rows = 4, no overflow
  assert.equal(goalStripPlannedRows(3), GOAL_STRIP_HEADER_ROWS + 3);
});

test('goalStripPlannedRows caps at MAX_GOALS + overflow line', () => {
  // 10 goals → 1 header + MAX_GOALS(5) goal rows + 1 overflow line = 7
  assert.equal(goalStripPlannedRows(10), GOAL_STRIP_HEADER_ROWS + GOAL_STRIP_MAX_GOALS + 1);
});

test('goalStripPlannedRows at exact cap has no overflow line', () => {
  // Exactly MAX_GOALS → 1 header + MAX_GOALS rows = 6, no overflow
  assert.equal(goalStripPlannedRows(GOAL_STRIP_MAX_GOALS), GOAL_STRIP_HEADER_ROWS + GOAL_STRIP_MAX_GOALS);
});

// ---------------------------------------------------------------------------
// App-level integration tests (strip visibility)
// ---------------------------------------------------------------------------

test('GoalQuickStrip rendered in chat with populated board', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state: UiState = {
    ...initialState,
    board: [
      boardRow({ id: 'a', title: 'Ship it', state: 'running', done: 2, total: 5, glyph: '\u25CF', agents: 1 }),
      boardRow({ id: 'b', title: 'Fix tests', state: 'parked', done: 0, total: 3, glyph: '\u25CC' }),
    ],
    boardEnabled: true,
  };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  assert.match(plain, /Ship it/);
  assert.match(plain, /Fix tests/);
  assert.match(plain, /2\/5/);
  assert.match(plain, /0\/3/);
  assert.match(plain, /goals.*2 total/);
});

test('GoalQuickStrip hidden when chatActive=false (menu)', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} />);
  const state: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'Ship it', state: 'running', done: 2, total: 5, glyph: '\u25CF' })],
    boardEnabled: true,
  };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  // The GoalQuickStrip header is unique: "goals  N total · M active". The BOARD
  // panel may still render the goal title, but the strip header must NOT appear.
  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
});

test('GoalQuickStrip hidden when Control Panel is open', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'Ship it', state: 'running', done: 2, total: 5, glyph: '\u25CF' })],
    boardEnabled: true,
    controlPanel: { enabled: true, open: true, activeSection: 'goals' },
  };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  // The goal title appears in the Control Panel's Goals tab, but the
  // GoalQuickStrip header "goals N total" must NOT appear.
  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
  assert.match(plain, /CONTROL PANEL/);
});

test('GoalQuickStrip hidden when Goals Panel is open', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'Ship it', state: 'running', done: 2, total: 5, glyph: '\u25CF' })],
    boardEnabled: true,
    goalsPanel: { enabled: true, open: true },
  };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  // The goal title appears in the Goals Panel itself, but the
  // GoalQuickStrip header "goals N total" must NOT appear.
  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
  assert.match(plain, /Goals · To-dos/);
});

test('GoalQuickStrip updates live when board changes', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state1: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'First goal', state: 'running', done: 1, total: 3, glyph: '\u25CF' })],
    boardEnabled: true,
  };
  bridge.pushState(state1);
  await tick();

  let frame = lastFrame() ?? '';
  let plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /First goal/);
  assert.match(plain, /1\/3/);

  const state2: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'First goal', state: 'done', done: 3, total: 3, glyph: '\u2713' })],
    boardEnabled: true,
  };
  bridge.pushState(state2);
  await tick();

  frame = lastFrame() ?? '';
  plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /3\/3/);
  assert.match(plain, /done/);
});

test('Empty board -> no strip, no phantom rows', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state: UiState = { ...initialState, board: [], boardEnabled: true };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  assert.doesNotMatch(plain, /goals/);
  assert.doesNotMatch(plain, /total/);
});
