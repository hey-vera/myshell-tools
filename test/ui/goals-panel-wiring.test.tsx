/**
 * test/ui/goals-panel-wiring.test.tsx — integration tests for the GoalsPanel
 * wiring in the real App + store + bridge route. Uses ink-testing-library and
 * the actual createInkAppBridge/createInkStore/configureGoalsPanelStore path
 * from Slice 3+4 to exercise the Slice 6 conditional render and input ownership.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { createInkAppBridge } from '../../src/interface/ui/App.js';
import {
  createInkStore,
  configureGoalsPanelStore,
} from '../../src/interface/ui/mount.js';
import { App } from '../../src/interface/ui/App.js';
import { initialState } from '../../src/interface/ui/index.js';
import type { GoalBoardRow, UiState } from '../../src/interface/ui/index.js';

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strip ANSI SGR codes so frame assertions match visible glyphs. */
const plain = (s: string | undefined): string => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

function boardRow(over: Partial<GoalBoardRow> = {}): GoalBoardRow {
  return {
    id: over.id ?? 'goal_a',
    title: over.title ?? 'Redesign feed',
    state: over.state ?? 'parked',
    done: over.done ?? 3,
    total: over.total ?? 8,
    glyph: over.glyph ?? '\u25F7',
    scope: over.scope ?? 'project',
    agents: over.agents ?? 0,
    ...(over.depth !== undefined ? { depth: over.depth } : {}),
    ...(over.todos !== undefined ? { todos: over.todos } : {}),
    ...(over.verdict !== undefined ? { verdict: over.verdict } : {}),
    ...(over.approach !== undefined ? { approach: over.approach } : {}),
  };
}

function setupBridgeAndStore() {
  const bridge = createInkAppBridge();
  const store = createInkStore(bridge);
  configureGoalsPanelStore(store, { MYSHELL_GOALS_PANEL: '1' }, undefined);
  bridge.onGoalsPanelAction((action) => store.dispatch(action));
  return { bridge, store };
}

test('enabled + closed → renders normal compact board, NOT Goals · To-dos', async () => {
  const { bridge, store } = setupBridgeAndStore();
  // Push board data so the compact board region is visible.
  store.dispatch({
    type: 'board/sync',
    rows: [
      boardRow({ id: 'g1', title: 'Ship it', state: 'running', done: 1, total: 5, agents: 1 }),
      boardRow({ id: 'g2', title: 'Fix tests', state: 'parked', done: 0, total: 3, agents: 0 }),
    ],
    enabled: true,
  });
  const { lastFrame } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} clock={() => 0} />,
  );
  // Post-mount: push the store snapshot so the structured branch activates.
  bridge.pushState(store.getState());
  await tick();
  const frame = plain(lastFrame());
  assert.match(frame, /BOARD/);
  assert.doesNotMatch(frame, /Goals · To-dos/);
});

test('empty-buffer Ctrl+G → opens panel, renders Goals · To-dos, removes board from frame', async () => {
  const { bridge, store } = setupBridgeAndStore();
  store.dispatch({
    type: 'board/sync',
    rows: [
      boardRow({ id: 'g1', title: 'Ship it', state: 'running', done: 1, total: 5, agents: 1 }),
    ],
    enabled: true,
  });
  const { lastFrame, stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  await tick();

  // Before: sees compact board, not Goals.
  {
    const frame = plain(lastFrame());
    assert.match(frame, /BOARD/);
    assert.doesNotMatch(frame, /Goals · To-dos/);
  }

  // Empty-buffer Ctrl+G → opens panel.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  {
    const frame = plain(lastFrame());
    assert.match(frame, /Goals · To-dos/);
    assert.doesNotMatch(frame, /BOARD/);
  }
});

test('Down/J updates store.getState().goalsPanel.highlightedGoalId exactly once', async () => {
  const { bridge, store } = setupBridgeAndStore();
  store.dispatch({
    type: 'board/sync',
    rows: [
      boardRow({ id: 'g1', title: 'First', state: 'running', done: 0, total: 3, agents: 1 }),
      boardRow({ id: 'g2', title: 'Second', state: 'parked', done: 0, total: 2, agents: 0 }),
      boardRow({ id: 'g3', title: 'Third', state: 'parked', done: 0, total: 1, agents: 0 }),
    ],
    enabled: true,
  });
  const { stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  await tick();

  // Open the panel.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, true);

  // Send Down arrow → one highlight change.
  await act(async () => {
    stdin.write('\x1b[B');
    await tick();
  });
  const afterDown = store.getState().goalsPanel.highlightedGoalId;
  assert.ok(typeof afterDown === 'string', 'highlightedGoalId should be set after Down');
  // One navigation event → one change (catches double active consumers).
  assert.ok(afterDown !== undefined);

  // Send J → another highlight change (different goal).
  await act(async () => {
    stdin.write('j');
    await tick();
  });
  const afterJ = store.getState().goalsPanel.highlightedGoalId;
  assert.ok(typeof afterJ === 'string');
  assert.notEqual(afterJ, afterDown, 'J should move to a different goal');
});

test('Escape closes panel; Ctrl+G toggles open/closed through bridge; after close normal board returns', async () => {
  const { bridge, store } = setupBridgeAndStore();
  store.dispatch({
    type: 'board/sync',
    rows: [
      boardRow({ id: 'g1', title: 'Ship it', state: 'running', done: 1, total: 5, agents: 1 }),
    ],
    enabled: true,
  });
  const { lastFrame, stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  await tick();

  // Open via Ctrl+G.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, true);

  // Escape closes.
  await act(async () => {
    stdin.write('\x1b');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, false);
  // Board returns.
  assert.match(plain(lastFrame()), /BOARD/);
  assert.doesNotMatch(plain(lastFrame()), /Goals · To-dos/);

  // Open again via Ctrl+G.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, true);

  // Ctrl+G while open closes.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, false);
  assert.match(plain(lastFrame()), /BOARD/);
});

test('non-empty Ctrl+G does NOT open; after clearing, open works; InputBox buffer does not mutate while panel owns input; close → editing resumes', async () => {
  const { bridge, store } = setupBridgeAndStore();
  store.dispatch({
    type: 'board/sync',
    rows: [
      boardRow({ id: 'g1', title: 'Ship it', state: 'running', done: 1, total: 5, agents: 1 }),
    ],
    enabled: true,
  });
  const { lastFrame, stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  // Show the composer so the buffer is visible.
  bridge.setChatActive(true);
  await tick();

  // Type a draft, one character at a time with flush between each.
  const typeChars = async (chars: string) => {
    for (const ch of chars) {
      await act(async () => {
        stdin.write(ch);
        await tick();
      });
    }
  };
  await typeChars('hello');
  assert.equal(bridge.input.currentLine(), 'hello');

  // Non-empty Ctrl+G → does NOT open.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, false);
  assert.doesNotMatch(plain(lastFrame()), /Goals · To-dos/);

  // Clear the buffer via submit (Enter).
  await act(async () => {
    stdin.write('\r');
    await tick();
  });
  assert.equal(bridge.input.currentLine(), '');

  // Now empty-buffer Ctrl+G → opens.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, true);
  assert.match(plain(lastFrame()), /Goals · To-dos/);

  // While panel owns input, send some editor keys. They must NOT mutate the
  // InputBox buffer (active=false on InputBox while panel is open).
  await typeChars('xyz');
  // Buffer must still be empty — the panel's useInput consumed these keys.
  assert.equal(bridge.input.currentLine(), '');

  // Close the panel.
  await act(async () => {
    stdin.write('\x1b');
    await tick();
  });
  assert.equal(store.getState().goalsPanel.open, false);
  assert.equal(bridge.input.currentLine(), '');

  // Normal editing resumes — type a key and verify buffer reflects it.
  await act(async () => {
    stdin.write('z');
    await tick();
  });
  assert.equal(bridge.input.currentLine(), 'z');
  assert.match(plain(lastFrame()), /z/);
});

test('board/todo rows exceeding rows → live frame stays within viewport cap', async () => {
  const { bridge, store } = setupBridgeAndStore();
  // Many board rows with todos, exceeding the 8-row viewport.
  const rows: GoalBoardRow[] = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push(boardRow({
      id: `g${i}`,
      title: `Goal ${i}`,
      state: i === 0 ? 'running' : 'parked',
      done: 0,
      total: 3,
      agents: i === 0 ? 1 : 0,
      todos: [{ id: `t${i}`, text: `Todo for goal ${i}`, status: 'queued' }],
    }));
  }
  store.dispatch({ type: 'board/sync', rows, enabled: true });
  const { lastFrame, stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={8} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  await tick();

  // Open the panel.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  {
    const frame = lastFrame() ?? '';
    // The panel is open: goal rows are rendered (not the normal compact board).
    assert.match(frame, /Goal 0/);
    assert.doesNotMatch(frame, /BOARD/);
    // Count the number of lines. The viewport is rows=8, and one row is the
    // hidden InputBox, so the live region is capped at rows - 1 = 7.
    // lastFrame() includes everything in the terminal; lines = newlineCount + 1.
    const newlineCount = (frame.match(/\n/g) ?? []).length;
    assert.ok(
      newlineCount + 1 <= 8,
      `frame should have at most 8 lines (viewport ${8}), got ${newlineCount + 1}:\n${frame}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Slice 7 — flag-off byte-for-byte frame regression tests
// ---------------------------------------------------------------------------

/**
 * Build a deterministic UiState for the structured compact-board control.
 * goalsPanel is explicitly off, board enabled, >=2 goals so the BOARD panel
 * paints, and all other fields are fixed so the frame is fully deterministic.
 */
function structuredControlState(): UiState {
  return {
    committed: [],
    chrome: [],
    goals: [],
    stream: initialState.stream,
    turnActive: false,
    tokens: { turn: 0, session: 0 },
    board: [
      boardRow({ id: 'g1', title: 'Redesign feed', state: 'parked', done: 3, total: 8 }),
      boardRow({ id: 'g2', title: 'Fix auth', state: 'parked', done: 0, total: 2 }),
    ],
    boardEnabled: true,
    pressure: 0,
    dynamicWorldItems: [],
    goalsPanel: { enabled: false, open: false },
    controlPanel: { enabled: false, open: false, activeSection: 'goals' },
  };
}

test('flag-off structured compact-board frame is byte-for-byte identical to baseline golden', async () => {
  const bridge = createInkAppBridge();
  const store = createInkStore(bridge);

  // Explicit dispatch so the reducer sees enabled:false.
  store.dispatch({ type: 'goals-panel/configure', enabled: false });

  // Push board data so the compact BOARD panel is visible.
  store.dispatch({
    type: 'board/sync',
    rows: structuredControlState().board,
    enabled: true,
  });

  const { lastFrame } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} columns={80} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  await tick();

  const frame = lastFrame() ?? '';

  // Semantic guards — an accidentally-empty golden must fail.
  assert.match(frame, /BOARD/, 'structured control must contain BOARD text');
  assert.doesNotMatch(frame, /Goals · To-dos/, 'flag-off frame must NOT contain Goals text');

  // Golden captured from the pre-wiring renderer with color=false, stdout.columns=100.
  // Stored as hex to avoid any source-file encoding ambiguity.
  const STRUCTURED_GOLDEN_HEX = 'e295ade29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e295ae0ae2948220424f4152442020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020e294820ae2948220676f616c20526564657369676e206665656420e2809420696e6163746976652020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020e294820ae2948220676f616c20466978206175746820e2809420696e61637469766520202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020e294820ae295b0e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e29480e295af0a';
  const golden = Buffer.from(STRUCTURED_GOLDEN_HEX, 'hex').toString('utf-8');
  assert.equal(frame, golden, 'structured flag-off frame must match baseline golden byte-for-byte');
});

test('legacy/pre-first-state frame matches its golden; Ctrl+G does not change it when route is unarmed', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame, stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} columns={80} clock={() => 0} />,
  );
  await tick();

  const frame = lastFrame() ?? '';
  // Golden: the legacy (pre-first-state) render produces an empty frame.
  const golden = '';
  assert.equal(frame, golden, 'legacy frame must match baseline golden byte-for-byte');

  // Send Ctrl+G with the route unarmed (flag off) — frame must NOT repaint.
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  const afterCtrlG = lastFrame() ?? '';
  assert.equal(afterCtrlG, golden, 'Ctrl+G with unarmed route must not change the legacy frame');
});

test('structured flag-off: Left Arrow then no-op key do not change the frame', async () => {
  const bridge = createInkAppBridge();
  const store = createInkStore(bridge);

  store.dispatch({ type: 'goals-panel/configure', enabled: false });
  store.dispatch({
    type: 'board/sync',
    rows: structuredControlState().board,
    enabled: true,
  });

  const { lastFrame, stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} columns={80} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  await tick();

  const original = lastFrame() ?? '';

  // Left Arrow on empty editor (cursor already at 0) is a pure no-op.
  await act(async () => {
    stdin.write('\x1b[D');
    await tick();
  });
  assert.equal(
    lastFrame() ?? '',
    original,
    'Left Arrow on empty buffer must not change the frame',
  );

  // A no-op key that does not match any panel/buffer branch.
  await act(async () => {
    stdin.write('x');
    await tick();
  });
  assert.equal(
    lastFrame() ?? '',
    original,
    'ordinary no-op key must not change the structured flag-off frame',
  );
});

// ---------------------------------------------------------------------------
// Phase 1 fallback: CP off → goals panel still works exactly as before
// ---------------------------------------------------------------------------

test('Phase 1 fallback: CP disabled + Goals enabled → goals panel opens and works', async () => {
  const bridge = createInkAppBridge();
  const store = createInkStore(bridge);
  // Explicitly disable CP, enable Goals.
  store.dispatch({ type: 'control-panel/configure', enabled: false });
  configureGoalsPanelStore(store, { MYSHELL_GOALS_PANEL: '1' }, undefined);
  bridge.onGoalsPanelAction((action) => store.dispatch(action));
  bridge.onControlPanelAction(null);

  store.dispatch({
    type: 'board/sync',
    rows: [
      boardRow({ id: 'g1', title: 'Ship it', state: 'running', done: 1, total: 5, agents: 1 }),
    ],
    enabled: true,
  });
  const { lastFrame, stdin } = render(
    <App bridge={bridge} color={false} isTty={false} rows={24} clock={() => 0} />,
  );
  bridge.pushState(store.getState());
  await tick();

  // Before: sees compact board, not Goals.
  {
    const frame = plain(lastFrame());
    assert.match(frame, /BOARD/);
    assert.doesNotMatch(frame, /CONTROL PANEL/);
  }

  // Empty-buffer Ctrl+G → opens standalone Goals Panel (not Control Panel).
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  {
    const frame = plain(lastFrame());
    assert.match(frame, /Goals · To-dos/);
    assert.doesNotMatch(frame, /CONTROL PANEL/);
    assert.doesNotMatch(frame, /BOARD/);
  }

  assert.equal(store.getState().goalsPanel.open, true);
  assert.equal(store.getState().controlPanel.open, false);
});
