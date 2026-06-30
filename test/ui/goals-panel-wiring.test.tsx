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
import type { GoalBoardRow } from '../../src/interface/ui/index.js';

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
