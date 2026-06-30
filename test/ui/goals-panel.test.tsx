/**
 * test/ui/goals-panel.test.tsx — Ink component tests for the GoalsPanel
 * fullscreen view (Slice 6). Runs under `npm run test:ui` (tsx +
 * ink-testing-library).
 *
 * Asserts the rendered frames for: goal titles + header, highlighted-goal todo
 * expansion vs non-highlighted suppression, down-arrow navigation calls
 * onHighlightGoal, escape calls onClose, and the empty-board placeholder.
 */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { GoalsPanel } from '../../src/interface/ui/GoalsPanel.js';
import type { GoalBoardRow } from '../../src/interface/ui/index.js';

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

test('renders goal titles from board and the header', () => {
  const { lastFrame } = render(
    <GoalsPanel
      board={[boardRow({ id: 'a', title: 'Ship it' }), boardRow({ id: 'b', title: 'Fix tests' })]}
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Goals · To-dos/);
  assert.match(frame, /↑↓ navigate · esc close/);
  assert.match(frame, /Ship it/);
  assert.match(frame, /Fix tests/);
});

test("highlighted goal's todos render, non-highlighted goal's todos do not render", () => {
  const { lastFrame } = render(
    <GoalsPanel
      board={[
        boardRow({
          id: 'a',
          title: 'Ship it',
          state: 'running',
          todos: [{ id: 't1', text: 'do x', status: 'queued' }],
        }),
        boardRow({
          id: 'b',
          title: 'Fix tests',
          state: 'parked',
          todos: [{ id: 't2', text: 'do y', status: 'queued' }],
        }),
      ]}
      highlightedGoalId="a"
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /• do x/);
  assert.match(frame, /Ship it/);
  assert.match(frame, /Fix tests/);
  assert.doesNotMatch(frame, /• do y/);
});

test('down-arrow calls onHighlightGoal with the next goal id', async () => {
  const onHighlightGoal = vi.fn();
  const { stdin } = render(
    <GoalsPanel
      board={[boardRow({ id: 'a', title: 'A' }), boardRow({ id: 'b', title: 'B' })]}
      onHighlightGoal={onHighlightGoal}
      onClose={() => {}}
    />,
  );
  await act(async () => {
    stdin.write('\x1b[B');
    await tick();
  });
  assert.ok(onHighlightGoal.mock.calls.length > 0, 'onHighlightGoal should have been called');
  assert.equal(onHighlightGoal.mock.calls[0]?.[0], 'b');
});

test('escape calls onClose', async () => {
  const onClose = vi.fn();
  const { stdin } = render(
    <GoalsPanel
      board={[boardRow({ id: 'a', title: 'A' })]}
      onHighlightGoal={() => {}}
      onClose={onClose}
    />,
  );
  await act(async () => {
    stdin.write('\x1b');
    await tick();
  });
  assert.ok(onClose.mock.calls.length > 0, 'onClose should have been called');
});

test('empty board renders "No goals yet"', () => {
  const { lastFrame } = render(
    <GoalsPanel
      board={[]}
      onHighlightGoal={() => {}}
      onClose={() => {}}
    />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /No goals yet/);
});

test('active={false} disables arrow/j/k/Escape/Ctrl+G — neither callback fires', async () => {
  const onHighlightGoal = vi.fn();
  const onClose = vi.fn();
  const { stdin } = render(
    <GoalsPanel
      board={[boardRow({ id: 'a', title: 'A' }), boardRow({ id: 'b', title: 'B' })]}
      onHighlightGoal={onHighlightGoal}
      onClose={onClose}
      active={false}
    />,
  );
  await act(async () => {
    stdin.write('\x1b[B');
    stdin.write('\x1b[A');
    stdin.write('j');
    stdin.write('k');
    stdin.write('\x1b');
    stdin.write('\x07');
    await tick();
  });
  assert.equal(onHighlightGoal.mock.calls.length, 0, 'onHighlightGoal should NOT be called when active=false');
  assert.equal(onClose.mock.calls.length, 0, 'onClose should NOT be called when active=false');
});
