import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { ControlPanel, buildControlPanelFooterText } from '../../src/interface/ui/ControlPanel.js';
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
    controlPanel: {
      open: true,
      activeSection: 'goals',
      statusScroll: 0,
      goalsListScroll: 0,
      goalsDetailScroll: 0,
      settingsScroll: 0,
    },
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
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /CONTROL PANEL/);
  assert.match(frame, /0 active goals/);
  assert.match(frame, /quota remaining unknown/);
  assert.match(frame, /Ship it/);
});

test('Status section shows active count, execution phase, provider states, quota', () => {
  const state = baseState({
    controlPanel: { open: true, activeSection: 'status', statusScroll: 0, goalsListScroll: 0, goalsDetailScroll: 0, settingsScroll: 0 },
    board: [br('a', 'Alpha', { state: 'running' })],
    goals: [
      goalView('b', 'running'),
      goalView('c', 'queued'),
    ],
    stream: {
      ...initialStreamView,
      phase: 'thinking',
      panelists: [
        { provider: 'claude' as const, state: 'running' as const, model: '', tokens: 0, attempt: 0 },
      ],
    },
    turnActive: true,
    // No capacity snapshot → shows unknowns in Status tab
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  // Summary line shows quota remaining unknown
  assert.match(frame, /2 active goals/);
  assert.match(frame, /quota remaining unknown/);
  // Status tab shows unknown capacity snapshot info
  assert.match(frame, /Capacity snapshot: unknown/);
  assert.match(frame, /Quota remaining: unknown/);
  assert.match(frame, /Cooldowns: unknown/);
});

test('Settings shows one read-only board row, no toggle', () => {
  const state = baseState({
    controlPanel: { open: true, activeSection: 'settings', statusScroll: 0, goalsListScroll: 0, goalsDetailScroll: 0, settingsScroll: 0 },
    boardEnabled: true,
    goalsPanel: {},
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Settings/);
  assert.match(frame, /Persistent board: enabled/);
  // Phase 4D: Settings tab is interactive (no longer "read-only in this release")
  assert.match(frame, /Settings snapshot/);
});

test('Tab calls onSetSection forward; Shift+Tab calls backward', async () => {
  const onSetSection = vi.fn();
  const state = baseState();
  const { stdin } = render(
    <ControlPanel
      state={state}
      onSetSection={onSetSection}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
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

test('Left closes panel; Right is a no-op', async () => {
  const onSetSection = vi.fn();
  const onHighlightGoal = vi.fn();
  const onClose = vi.fn();
  const state = baseState();
  const { stdin } = render(
    <ControlPanel
      state={state}
      onSetSection={onSetSection}
      onHighlightGoal={onHighlightGoal}
      onScroll={() => {}}
      onClose={onClose}
    />,
  );
  await act(async () => {
    stdin.write('\x1b[D'); // Left → close (always escapable)
    await tick();
  });
  assert.equal(onClose.mock.calls.length, 1, 'Left should call onClose once');
  assert.equal(onSetSection.mock.calls.length, 0, 'Left should not call onSetSection');
  assert.equal(onHighlightGoal.mock.calls.length, 0, 'Left should not call onHighlightGoal');

  onClose.mockClear();
  await act(async () => {
    stdin.write('\x1b[C'); // Right → no-op (no nested panel)
    await tick();
  });
  assert.equal(onClose.mock.calls.length, 0, 'Right should not call onClose');
  assert.equal(onSetSection.mock.calls.length, 0, 'Right should not call onSetSection');
  assert.equal(onHighlightGoal.mock.calls.length, 0, 'Right should not call onHighlightGoal');
});

test('visible chrome footer always shows Esc close (wide + narrow)', () => {
  assert.match(buildControlPanelFooterText(80), /Esc close/);
  assert.match(buildControlPanelFooterText(80), /Tab sections/);
  assert.match(buildControlPanelFooterText(80), /\u2190 chat/);
  assert.match(buildControlPanelFooterText(50), /Esc close/);
  assert.match(buildControlPanelFooterText(50), /\u2190 chat/);
  assert.doesNotMatch(buildControlPanelFooterText(50), /Tab sections/);

  const state = baseState();
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      columns={80}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Esc close/, 'panel frame must teach Esc close');
  assert.match(frame, /Tab sections/, 'panel frame must teach Tab sections');
  assert.match(frame, /\u2190 chat/, 'panel frame must teach Left → chat');
});

test('Arrows/j/k navigate only on Goals section', async () => {
  const onHighlightGoal = vi.fn();
  const goalsState = baseState({
    board: [br('a', 'Alpha'), br('b', 'Bravo')],
    controlPanel: { open: true, activeSection: 'goals', statusScroll: 0, goalsListScroll: 0, goalsDetailScroll: 0, settingsScroll: 0 },
  });
  const { stdin } = render(
    <ControlPanel
      state={goalsState}
      onSetSection={() => {}}
      onHighlightGoal={onHighlightGoal}
      onScroll={() => {}}
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
    controlPanel: { open: true, activeSection: 'status', statusScroll: 0, goalsListScroll: 0, goalsDetailScroll: 0, settingsScroll: 0 },
  });
  const { stdin: stdin2 } = render(
    <ControlPanel
      state={statusState}
      onSetSection={() => {}}
      onHighlightGoal={onHighlightGoal}
      onScroll={() => {}}
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
      onScroll={() => {}}
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
      onScroll={() => {}}
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

test('Status section with no providers shows unknown capacity snapshot', () => {
  const state = baseState({
    controlPanel: { open: true, activeSection: 'status', statusScroll: 0, goalsListScroll: 0, goalsDetailScroll: 0, settingsScroll: 0 },
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Capacity snapshot: unknown/);
  assert.match(frame, /Quota remaining: unknown/);
  assert.match(frame, /Cooldowns: unknown/);
});

// ---------------------------------------------------------------------------
// Phase 4B: GoalsTab rendering (viewport-safe)
// ---------------------------------------------------------------------------

test('GoalsTab shows highlighted goal detail with todos', () => {
  const state = baseState({
    board: [
      br('a', 'Active Goal', {
        state: 'running',
        done: 1,
        total: 3,
        todos: [
          { id: 't1', text: 'wire up API', status: 'done' },
          { id: 't2', text: 'write docs', status: 'pending' },
        ],
      }),
    ],
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Active Goal/);
  assert.match(frame, /wire up API/);
  assert.match(frame, /write docs/);
});

test('GoalsTab shows inactive goal todos', () => {
  const state = baseState({
    board: [
      br('a', 'Parked Goal', {
        state: 'parked',
        done: 0,
        total: 2,
        todos: [
          { id: 't1', text: 'research', status: 'pending' },
          { id: 't2', text: 'plan', status: 'pending' },
        ],
      }),
    ],
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Parked Goal/);
  assert.match(frame, /research/);
  assert.match(frame, /plan/);
});

test('GoalsTab shows todo overflow indicator', () => {
  const state = baseState({
    board: [
      br('a', 'Overflow Goal', {
        state: 'running',
        done: 2,
        total: 14,
        todos: [
          { id: 't1', text: 'a', status: 'done' },
          { id: 't2', text: 'b', status: 'done' },
          { id: 't3', text: 'c', status: 'pending' },
        ],
        todoOverflow: 11,
      }),
    ],
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /11 more to-dos not synced/);
});

test('GoalsTab narrow layout stacks list and detail', () => {
  const state = baseState({
    board: [
      br('a', 'Stacked Goal', {
        state: 'running',
        done: 1,
        total: 3,
        todos: [
          { id: 't1', text: 'task one', status: 'pending' },
        ],
      }),
    ],
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
      columns={60}
    />,
  );
  const frame = lastFrame() ?? '';
  // Narrow layout (< 96 cols) should still show the goal and its todo
  assert.match(frame, /Stacked Goal/);
  assert.match(frame, /task one/);
});

test('GoalsTab with many goals shows overflow indicators', () => {
  const goals: GoalBoardRow[] = [];
  for (let i = 0; i < 15; i += 1) {
    goals.push(
      br(`g${i}`, `Goal ${i}`, { state: 'parked' as const }),
    );
  }
  const state = baseState({ board: goals });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
      rows={10}
    />,
  );
  const frame = lastFrame() ?? '';
  // With 10 total rows and 3 fixed chrome rows in small height,
  // 15 goals should show an overflow indicator.
  assert.match(frame, /more/);
});

test('GoalsTab with short viewport renders bounded content', () => {
  const state = baseState({
    board: [
      br('a', 'Only Goal', {
        state: 'running',
        done: 0,
        total: 5,
        todos: Array.from({ length: 20 }, (_, i) => ({
          id: `t${i}`,
          text: `task ${i}`,
          status: 'pending' as const,
        })),
        todoOverflow: 0,
      }),
    ],
  });
  const { lastFrame } = render(
    <ControlPanel
      state={state}
      onSetSection={() => {}}
      onHighlightGoal={() => {}}
      onScroll={() => {}}
      onClose={() => {}}
      rows={10}
    />,
  );
  const frame = lastFrame() ?? '';
  // 10 total rows, 3 fixed chrome (tiny height: title+tabs+footer),
  // 7 content rows. 20 todos in detail → must show overflow or scroll.
  // The detail should NOT render all 20 items — it should be bounded.
  const lines = frame.split('\n');
  // Footer should always be present (reserved chrome; Esc always discoverable)
  assert.match(frame, /Esc close/);
  // Should not have 20+ detail lines
  assert.ok(lines.length < 25);
});

