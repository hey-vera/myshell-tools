/**
 * test/ui/goal-quick-strip.test.tsx — regression for the GoalQuickStrip pure
 * helpers (still used by Control Panel / layout) plus App-level single-board
 * + bottom-recap dock (P0.13–15). The strip is no longer mounted in chat.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { GoalQuickStrip } from '../../src/interface/ui/GoalQuickStrip.js';
import { RecapDock } from '../../src/interface/ui/RecapDock.js';
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
// Component-level tests (GoalQuickStrip still unit-testable; not mounted in App)
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

  assert.match(plain, /goals.*3 total.*1 active/);
  assert.match(plain, /\u25CF.*Build panel nav.*2\/5/);
  assert.match(plain, /running/);
  assert.match(plain, /\u25CB.*Clean docs.*4\/4/);
  assert.match(plain, /done/);
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
});

test('overflow caps visible goals', () => {
  const manyRows = Array.from({ length: GOAL_STRIP_MAX_GOALS + 3 }, (_, i) =>
    boardRow({ id: `g${i}`, title: `Goal ${i}`, state: 'parked', done: 0, total: 1, glyph: '\u25CC' }),
  );
  const rows = selectGoalQuickRows(stateWithBoard(manyRows));
  const { lastFrame } = render(<GoalQuickStrip rows={rows} color={false} columns={80} />);
  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /\+\d+ more/);
});

test('empty board -> GoalQuickStrip returns null', () => {
  const rows = selectGoalQuickRows(stateWithBoard([]));
  const { lastFrame } = render(<GoalQuickStrip rows={rows} color={false} columns={80} />);
  assert.equal((lastFrame() ?? '').trim(), '');
});

test('selectGoalQuickRows orders active goals first (running, queued), then parked, then terminal', () => {
  const board = [
    boardRow({ id: 'd', title: 'Done', state: 'done' }),
    boardRow({ id: 'p', title: 'Parked', state: 'parked' }),
    boardRow({ id: 'r', title: 'Running', state: 'running' }),
    boardRow({ id: 'q', title: 'Queued', state: 'queued' }),
  ];
  const rows = selectGoalQuickRows(stateWithBoard(board));
  assert.deepEqual(
    rows.map((r) => r.state),
    ['running', 'queued', 'parked', 'done'],
  );
});

test('goalStripPlannedRows returns 0 for empty board', () => {
  assert.equal(goalStripPlannedRows(0), 0);
});

test('goalStripPlannedRows caps at MAX_GOALS + overflow line', () => {
  assert.equal(goalStripPlannedRows(10), GOAL_STRIP_HEADER_ROWS + GOAL_STRIP_MAX_GOALS + 1);
});

test('goalStripPlannedRows at exact cap has no overflow line', () => {
  assert.equal(goalStripPlannedRows(GOAL_STRIP_MAX_GOALS), GOAL_STRIP_HEADER_ROWS + GOAL_STRIP_MAX_GOALS);
});

// ---------------------------------------------------------------------------
// RecapDock unit
// ---------------------------------------------------------------------------

test('RecapDock renders ※ recap line when text is present', () => {
  const { lastFrame } = render(
    <RecapDock text="we were refactoring the board" color={false} columns={80} />,
  );
  const plain = (lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /recap/);
  assert.match(plain, /we were refactoring the board/);
});

test('RecapDock collapses when text is empty/null', () => {
  const empty = render(<RecapDock text="" color={false} columns={80} />);
  assert.equal((empty.lastFrame() ?? '').trim(), '');
  const nil = render(<RecapDock text={null} color={false} columns={80} />);
  assert.equal((nil.lastFrame() ?? '').trim(), '');
});

// ---------------------------------------------------------------------------
// App-level: single BOARD surface + bottom recap dock (P0.13–15)
// ---------------------------------------------------------------------------

test('chat shows single BOARD goals surface (no GoalQuickStrip dual chrome)', async () => {
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

  // Single goals surface: the bordered BOARD
  assert.match(plain, /BOARD/);
  assert.match(plain, /Ship it/);
  assert.match(plain, /Fix tests/);
  assert.match(plain, /2\/5/);
  assert.match(plain, /0\/3/);
  // Dual chrome gone: no strip header "goals N total · M active"
  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
});

test('bottom recap dock renders above input when recap is set', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'Ship it', state: 'parked', done: 1, total: 4, glyph: '\u25CC' })],
    boardEnabled: true,
    recap: 'left off refactoring the auth middleware',
  };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  assert.match(plain, /BOARD/);
  assert.match(plain, /Ship it/);
  assert.match(plain, /recap/);
  assert.match(plain, /left off refactoring the auth middleware/);
  // Still no dual strip
  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
});

test('recap dock hidden when chatActive=false (menu)', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} />);
  const state: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'Ship it', state: 'running', done: 2, total: 5, glyph: '\u25CF' })],
    boardEnabled: true,
    recap: 'should not show on menu',
  };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  // BOARD may still paint idle board; strip header and dock recap must not appear at menu.
  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
  assert.doesNotMatch(plain, /should not show on menu/);
});

test('recap dock and GoalQuickStrip hidden when Control Panel is open', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state: UiState = {
    ...initialState,
    board: [boardRow({ id: 'a', title: 'Ship it', state: 'running', done: 2, total: 5, glyph: '\u25CF' })],
    boardEnabled: true,
    recap: 'dock should hide under panel',
    controlPanel: {
      open: true,
      activeSection: 'goals',
      statusScroll: 0,
      goalsListScroll: 0,
      goalsDetailScroll: 0,
      settingsScroll: 0,
      settingsSelectedIndex: -1,
    },
  };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
  assert.doesNotMatch(plain, /dock should hide under panel/);
  assert.match(plain, /CONTROL PANEL/);
});

test('BOARD updates live when board changes; no dual strip', async () => {
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
  assert.match(plain, /BOARD/);
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
  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
});

test('Empty board -> no strip header, no fabricated goals chrome', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} isTty={false} columns={80} rows={30} />);
  bridge.setChatActive(true);

  const state: UiState = { ...initialState, board: [], boardEnabled: true };
  bridge.pushState(state);
  await tick();

  const frame = lastFrame() ?? '';
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');

  assert.doesNotMatch(plain, /goals.*[0-9]+ total/);
  assert.doesNotMatch(plain, /\bBOARD\b/);
});
