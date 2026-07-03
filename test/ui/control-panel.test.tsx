import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { ControlPanel } from '../../src/interface/ui/ControlPanel.js';
import { GoalsPanelBody } from '../../src/interface/ui/GoalsPanel.js';
import { buildGoalsPanelModel } from '../../src/interface/ui/goals-panel-model.js';
import type {
  GoalBoardRow,
  GoalView,
  UiState,
} from '../../src/interface/ui/state.js';
import { initialStreamView } from '../../src/interface/ui/state.js';

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

function br(
  id: string,
  title: string,
  over: Partial<GoalBoardRow> = {},
): GoalBoardRow {
  return {
    id,
    title,
    state: 'running',
    done: 0,
    total: 3,
    glyph: '\u25B6',
    scope: 'global' as const,
    agents: 0,
    ...over,
  };
}

function goalView(id: string, state: GoalView['state']): GoalView {
  return {
    id,
    label: `Goal ${id}`,
    state,
    tokens: 0,
    toolCount: 0,
    agents: [],
    tier: 'worker' as const,
    dependsOn: [],
  };
}

function baseState(over: Partial<UiState> = {}): UiState {
  return {
    committed: [],
    chrome: [],
    goals: [],
    stream: { ...initialStreamView },
    turnActive: false,
    tokens: { turn: 0, session: 0 },
    board: [],
    boardEnabled: false,
    goalsPanel: {},
    controlPanel: { open: true, activeSection: 'goals' },
    ...over,
  };
}

test('renders status band, ordered tabs, and Goals body by default', () => {
  const state = baseState({
    board: [br('a', 'Ship it', { state: 'parked' })],
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /CONTROL PANEL/);
  assert.match(frame, /0 active goals/);
  assert.match(frame, /mode: execution\/idle/);
  assert.match(frame, /quota: unavailable/);
  assert.match(frame, /Goals · To-dos/);
  assert.match(frame, /Ship it/);
});

test('Status section shows active count, execution phase, provider states, quota', () => {
  const state = baseState({
    controlPanel: { open: true, activeSection: 'status' },
    board: [br('a', 'Alpha', { state: 'running' })],
    goals: [
      goalView('b', 'running'),
      goalView('c', 'queued'),
    ],
    stream: {
      ...initialStreamView,
      phase: 'thinking',
      panelists: [
        { provider: 'claude' as const, state: 'running' as const },
      ],
    },
    turnActive: true,
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Active goals \(running\): 2/);
  assert.match(frame, /Mode: execution\/thinking/);
  assert.match(frame, /turn active/);
  assert.match(frame, /Provider health \(observed\)/);
  assert.match(frame, /claude: running/);
  assert.match(frame, /Quota: unavailable in UI state/);
});

test('Settings shows one read-only board row, no toggle', () => {
  const state = baseState({
    controlPanel: { open: true, activeSection: 'settings' },
    boardEnabled: true,
    goalsPanel: {},
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Settings/);
  assert.match(frame, /Persistent board: enabled/);
  assert.match(frame, /read-only in this release/);
});

test('Tab calls onSetSection forward; Shift+Tab calls backward', async () => {
  const onSetSection = vi.fn();
  const state = baseState();
  const { stdin } = render(
    <ControlPanel
      state={state}
      onSetSection={onSetSection}
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  await act(async () => {
    stdin.write('\t');
    await tick();
  });
  assert.ok(onSetSection.mock.calls.length > 0, 'Tab should call onSetSection');
  assert.equal(onSetSection.mock.calls[0]?.[0], 'settings');

  onSetSection.mockClear();
  await act(async () => {
    stdin.write('\x1b[Z');
    await tick();
  });
  assert.ok(onSetSection.mock.calls.length > 0, 'Shift+Tab should call onSetSection');
  assert.equal(onSetSection.mock.calls[0]?.[0], 'status');
});

test('Left/Right arrows do nothing', async () => {
  const onSetSection = vi.fn();
  const onHighlightGoal = vi.fn();
  const onClose = vi.fn();
  const state = baseState();
  const { stdin } = render(
    <ControlPanel
      state={state}
      onSetSection={onSetSection}
      onHighlightGoal={onHighlightGoal}
      onClose={onClose}
    />,
  );
  await act(async () => {
    stdin.write('\x1b[D');
    stdin.write('\x1b[C');
    await tick();
  });
  assert.equal(onSetSection.mock.calls.length, 0, 'Left/Right should not call onSetSection');
  assert.equal(onHighlightGoal.mock.calls.length, 0, 'Left/Right should not call onHighlightGoal');
  assert.equal(onClose.mock.calls.length, 0, 'Left/Right should not call onClose');
});

test('Arrows/j/k navigate only on Goals section', async () => {
  const onHighlightGoal = vi.fn();
  const goalsState = baseState({
    board: [br('a', 'Alpha'), br('b', 'Bravo')],
    controlPanel: { open: true, activeSection: 'goals' },
  });
  const { stdin } = render(
    <ControlPanel
      state={goalsState}
      onSetSection={() => {}}
      onHighlightGoal={onHighlightGoal}
      onClose={() => {}}
    />,
  );
  await act(async () => {
    stdin.write('\x1b[B');
    await tick();
  });
  assert.ok(onHighlightGoal.mock.calls.length > 0, 'Down arrow on Goals should call onHighlightGoal');
  assert.equal(onHighlightGoal.mock.calls[0]?.[0], 'b');

  onHighlightGoal.mockClear();

  const statusState = baseState({
    board: [br('a', 'Alpha'), br('b', 'Bravo')],
    controlPanel: { open: true, activeSection: 'status' },
  });
  const { stdin: stdin2 } = render(
    <ControlPanel
      state={statusState}
      onSetSection={() => {}}
      onHighlightGoal={onHighlightGoal}
      onClose={() => {}}
    />,
  );
  await act(async () => {
    stdin2.write('\x1b[B');
    stdin2.write('\x1b[A');
    stdin2.write('j');
    stdin2.write('k');
    await tick();
  });
  assert.equal(onHighlightGoal.mock.calls.length, 0, 'Arrows/j/k on Status should NOT call onHighlightGoal');
});

test('Escape and Ctrl+G call onClose once each', async () => {
  const onClose = vi.fn();
  const state = baseState();
  const { stdin } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onClose={onClose}
    />,
  );
  await act(async () => {
    stdin.write('\x1b');
    await tick();
  });
  assert.equal(onClose.mock.calls.length, 1, 'Escape should call onClose once');

  onClose.mockClear();
  await act(async () => {
    stdin.write('\x07');
    await tick();
  });
  assert.equal(onClose.mock.calls.length, 1, 'Ctrl+G should call onClose once');
});

test('active={false} makes all keys inert', async () => {
  const onSetSection = vi.fn();
  const onHighlightGoal = vi.fn();
  const onClose = vi.fn();
  const state = baseState({
    board: [br('a', 'Alpha'), br('b', 'Bravo')],
  });
  const { stdin } = render(
    <ControlPanel
      state={state}
      onSetSection={onSetSection}
      onHighlightGoal={onHighlightGoal}
      onClose={onClose}
      active={false}
    />,
  );
  await act(async () => {
    stdin.write('\t');
    stdin.write('\x1b[Z');
    stdin.write('\x1b[B');
    stdin.write('\x1b[A');
    stdin.write('j');
    stdin.write('k');
    stdin.write('\x1b');
    stdin.write('\x07');
    await tick();
  });
  assert.equal(onSetSection.mock.calls.length, 0, 'active=false: Tab should not call onSetSection');
  assert.equal(onHighlightGoal.mock.calls.length, 0, 'active=false: arrows should not call onHighlightGoal');
  assert.equal(onClose.mock.calls.length, 0, 'active=false: Escape should not call onClose');
});

test('Status section with no providers shows empty provider line', () => {
  const state = baseState({
    controlPanel: { open: true, activeSection: 'status' },
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /No provider observations/);
});

test('GoalsPanelBody renders from a prebuilt model', () => {
  const model = buildGoalsPanelModel({
    board: [br('a', 'Ship it')],
  });
  const { lastFrame } = render(<GoalsPanelBody model={model} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Goals · To-dos/);
  assert.match(frame, /Ship it/);
});
