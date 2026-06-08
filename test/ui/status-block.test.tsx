/**
 * test/ui/status-block.test.tsx — Ink component tests for the STEP-4 mission-
 * control status block. Runs under `npm run test:ui` (tsx + ink-testing-library).
 *
 * Asserts the rendered frames (via lastFrame) for: a GoalCard's label/glyph/
 * tokens, an AgentRow's tree row, the StatusBlock being hidden when idle and
 * shown with goals when active, the "Waiting on N models" status-line wording,
 * and the height-cap COLLAPSE to the compact summary at a small `rows`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  StatusBlock,
  GoalCard,
  GoalHeaderLine,
  AgentRow,
  StatusLine,
  Panels,
  TokenMeter,
} from '../../src/interface/ui/StatusBlock.js';
import { planGoalsPanel } from '../../src/interface/ui/layout.js';
import { initialState } from '../../src/interface/ui/index.js';
import type { AgentView, GoalView, UiState } from '../../src/interface/ui/index.js';

function agent(over: Partial<AgentView> = {}): AgentView {
  return { provider: 'claude', model: 'opus', state: 'done', tokens: 1800, attempt: 0, ...over };
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
    ...(over.phase !== undefined ? { phase: over.phase } : {}),
  };
}
function active(goals: readonly GoalView[], over: Partial<UiState> = {}): UiState {
  return { ...initialState, turnActive: true, goals, ...over };
}

test('GoalCard renders the human TITLE, a dim "tier · risk · N agent" badge, glyph, and the token meter', () => {
  const { lastFrame } = render(
    <GoalCard
      goal={goal({ label: 'Refactor the auth middleware', tier: 'ic', risk: 'medium', state: 'running', tokens: 3100 })}
      color={false}
    />,
  );
  const frame = lastFrame() ?? '';
  // The bold human title leads (replaces the cryptic bare tier id "ic").
  assert.match(frame, /Refactor the auth middleware/);
  // The demoted tier + risk + agent-count badge.
  assert.match(frame, /ic · medium · 1 agent/);
  assert.match(frame, /◐/); // running glyph
  assert.match(frame, /↓ ~3\.1k tokens/);
});

test('GoalCard badge shows the tier only when no risk was classified (never fabricated)', () => {
  const { lastFrame } = render(
    <GoalCard goal={goal({ label: 'Fix the flaky test', tier: 'manager', state: 'running' })} color={false} />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /manager · 1 agent/);
  assert.doesNotMatch(frame, /medium|high|low|critical/);
});

test('AgentRow renders the tree row: provider/model, glyph, state, tokens', () => {
  const { lastFrame } = render(
    <AgentRow agent={agent({ provider: 'claude', model: 'opus', state: 'done', tokens: 1800 })} last={false} color={false} />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /├─/);
  assert.match(frame, /claude\/opus/);
  assert.match(frame, /✓/);
  assert.match(frame, /done/);
  assert.match(frame, /1\.8k tok/);
});

test('AgentRow shows an elapsed · Ns only for a RUNNING agent', () => {
  const { lastFrame: running } = render(
    <AgentRow agent={agent({ state: 'running', tokens: 1300 })} last elapsedSecs={6} color={false} />,
  );
  assert.match(running() ?? '', /◐/);
  assert.match(running() ?? '', /· 6s/);
  assert.match(running() ?? '', /└─/);

  // a done agent never shows the elapsed suffix even if one is passed
  const { lastFrame: done } = render(
    <AgentRow agent={agent({ state: 'done', tokens: 1800 })} last elapsedSecs={6} color={false} />,
  );
  assert.doesNotMatch(done() ?? '', /· 6s/);
});

test('TokenMeter renders the compact ↓ ~Nk tokens readout', () => {
  const { lastFrame } = render(<TokenMeter tokens={3100} color={false} />);
  assert.match(lastFrame() ?? '', /↓ ~3\.1k tokens/);
});

test('Panels renders the compact summary in compact mode and nothing when hidden', () => {
  const { lastFrame: compact } = render(
    <Panels mode={{ kind: 'compact', summary: '3 goals · 2 running · ↓ 4.2k tok' }} color={false} />,
  );
  assert.match(compact() ?? '', /3 goals/);
  assert.match(compact() ?? '', /╭/);

  const { lastFrame: hidden } = render(<Panels mode={{ kind: 'hidden' }} color={false} />);
  assert.equal((hidden() ?? '').trim(), '');
});

test('StatusBlock is hidden (empty frame) when the turn is idle', () => {
  const { lastFrame } = render(<StatusBlock state={initialState} color={false} rows={24} />);
  assert.equal((lastFrame() ?? '').trim(), '');
});

test('StatusBlock shows a "Thinking…" status line when active with no goals/stream yet', () => {
  // The exact post-turn/start state: turnActive true, no goals, fresh stream
  // (phase 'idle', workLabel 'Thinking', 0 steps). The block must render a
  // sensible "Thinking…" spinner line (NOT an empty box, NOT a crash, NO goals
  // panel) so the UI never looks frozen between submit and the first event.
  const state: UiState = { ...initialState, turnActive: true };
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={24} />);
  const frame = lastFrame() ?? '';
  assert.notEqual(frame.trim(), ''); // not an empty box
  assert.match(frame, /Thinking…/);
  assert.match(frame, /esc to interrupt/);
  assert.doesNotMatch(frame, /GOALS/); // no goals panel until goals arrive
});

test('StatusBlock shows the GOALS panel + goals when the turn is active', () => {
  const state = active([
    goal({ id: 'a', state: 'running', tokens: 3100, agents: [agent({ state: 'done' })] }),
    goal({ id: 'b', label: 'Add tests', state: 'queued', agents: [agent({ state: 'queued' })] }),
  ]);
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={40} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /GOALS/);
  assert.match(frame, /Refactor auth flow/);
  assert.match(frame, /Add tests/);
  assert.match(frame, /╭/); // rounded panel border (Ink borderStyle="round")
});

test('StatusLine renders the "Waiting on N models" wording in panel mode', () => {
  const state: UiState = {
    ...initialState,
    turnActive: true,
    stream: {
      ...initialState.stream,
      phase: 'panel',
      panelists: [
        { provider: 'claude', model: 'opus', state: 'done', tokens: 0, attempt: 0 },
        { provider: 'codex', model: 'gpt-5', state: 'running', tokens: 0, attempt: 0 },
      ],
      synthesizing: null,
    },
  };
  const { lastFrame } = render(<StatusLine state={state} frame="⠹" color={false} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Waiting on 1 model/);
  assert.match(frame, /claude/);
  assert.match(frame, /codex/);
  assert.match(frame, /esc to interrupt/);
});

test('StatusLine LEADS with the agent count, demoting steps to a dim "N tool calls" detail', () => {
  const state: UiState = {
    ...initialState,
    turnActive: true,
    goals: [goal({ state: 'running', agents: [agent({ state: 'running' })] })],
    stream: { ...initialState.stream, phase: 'streaming', workLabel: 'Thinking', stepCount: 3, streamedChars: 4000 },
  };
  const { lastFrame } = render(<StatusLine state={state} frame="⠙" elapsedSecs={6} color={false} />);
  const frame = lastFrame() ?? '';
  // Agent count headlines; tool calls are the demoted detail (no longer "N steps").
  assert.match(frame, /Thinking…/);
  assert.match(frame, /1 agent · 3 tool calls/);
  assert.doesNotMatch(frame, /3 steps/);
  assert.match(frame, /↓ ~1k tokens/);
  assert.match(frame, /· 6s/);
});

test('StatusLine pluralises agents + tool calls and counts panel candidates', () => {
  const state: UiState = {
    ...initialState,
    turnActive: true,
    goals: [goal({ state: 'running', agents: [agent({ state: 'running' }), agent({ state: 'done' })] })],
    stream: { ...initialState.stream, phase: 'streaming', workLabel: 'Thinking', stepCount: 1 },
  };
  const { lastFrame } = render(<StatusLine state={state} frame="⠙" color={false} />);
  assert.match(lastFrame() ?? '', /2 agents · 1 tool call/);
});

test('StatusBlock COLLAPSES to the compact summary at a small height', () => {
  const goals = [
    goal({ id: 'a', state: 'running', agents: [agent({ state: 'running' }), agent({ state: 'running' }), agent({ state: 'running' })] }),
    goal({ id: 'b', state: 'running', agents: [agent({ state: 'running' }), agent({ state: 'running' })] }),
    goal({ id: 'c', state: 'queued', agents: [agent({ state: 'queued' })] }),
  ];
  // distinct labels so the summary says "goals" (not phases).
  goals[0] = { ...goals[0]!, label: 'A' };
  goals[1] = { ...goals[1]!, label: 'B' };
  goals[2] = { ...goals[2]!, label: 'C' };
  const state = active(goals, { tokens: { turn: 4200, session: 4200 } });
  // A small height forces the compact one-line summary instead of full cards.
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={9} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /3 goals/);
  assert.match(frame, /6 agents/); // 3+2+1 real AgentViews, leading the summary
  assert.match(frame, /2 running/);
  assert.match(frame, /1 queued/);
  assert.match(frame, /↓ 4\.2k tok/);
  // the full per-agent tree must NOT be present in the collapsed form
  assert.doesNotMatch(frame, /├─/);
});

test('StatusBlock renders the agent-centric SUMMARY line under the GOALS panel', () => {
  const state = active([goal({ state: 'running', tokens: 1200, agents: [agent({ state: 'running' })] })], {
    tokens: { turn: 1200, session: 1200 },
  });
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={40} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /▸ 1 goal · 1 agent · 1\.2k tok/);
});

test('StatusBlock SUMMARY says "phases" when stacked cards share a title (honest count)', () => {
  const state = active(
    [
      goal({ id: 'p1', label: 'Fix the flaky test', state: 'done' }),
      goal({ id: 'p2', label: 'Fix the flaky test', tier: 'manager', state: 'running' }),
    ],
    { tokens: { turn: 3300, session: 3300 } },
  );
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={40} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /▸ 2 phases · 2 agents/);
});

test('StatusBlock with an injected clock shows a deterministic elapsed', async () => {
  const goals = [goal({ state: 'running', agents: [agent({ state: 'running', tokens: 1300 })] })];
  const state = active(goals);
  let now = 10_000;
  const clock = () => now;
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={40} clock={clock} />);
  // advance the injected clock past the first interval tick (80ms frame cadence)
  now = 16_000;
  await new Promise((r) => setTimeout(r, 120));
  assert.match(lastFrame() ?? '', /· 6s/);
});

// ---------------------------------------------------------------------------
// MULTI-GOAL render (design §3): concurrent cards, phase badge, collapse.
// ---------------------------------------------------------------------------

test('GoalCard renders a "phase X/Y" badge when phase is present', () => {
  const { lastFrame } = render(
    <GoalCard
      goal={goal({ label: 'Refactor auth', tier: 'ic', risk: 'medium', state: 'running', phase: { current: 7, total: 12 } })}
      color={false}
    />,
  );
  assert.match(lastFrame() ?? '', /phase 7\/12/);
});

test('GoalCard renders NO phase badge when phase is absent (never fabricated)', () => {
  const { lastFrame } = render(<GoalCard goal={goal({ label: 'Plain goal' })} color={false} />);
  assert.doesNotMatch(lastFrame() ?? '', /phase/);
});

test('GoalCard renders NO phase badge when total is 0 (no honest denominator)', () => {
  const { lastFrame } = render(
    <GoalCard goal={goal({ phase: { current: 0, total: 0 } })} color={false} />,
  );
  assert.doesNotMatch(lastFrame() ?? '', /phase/);
});

test('StatusBlock renders MULTIPLE concurrent running goals as distinct cards', () => {
  const state = active(
    [
      goal({ id: 'g1', label: 'Refactor the auth middleware', state: 'running', phase: { current: 7, total: 12 }, agents: [agent({ state: 'running' }), agent({ provider: 'codex', model: 'gpt-5', state: 'running' })] }),
      goal({ id: 'g2', label: 'Add integration tests', state: 'running', phase: { current: 1, total: 5 }, agents: [agent({ state: 'running' })] }),
      goal({ id: 'g3', label: 'Update the API docs', state: 'queued', agents: [] }),
    ],
    { tokens: { turn: 16_700, session: 16_700 } },
  );
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={40} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Refactor the auth middleware/);
  assert.match(frame, /Add integration tests/);
  assert.match(frame, /Update the API docs/);
  assert.match(frame, /phase 7\/12/);
  assert.match(frame, /phase 1\/5/);
  // the summary aggregates: 3 goals (distinct titles), and counts agents.
  assert.match(frame, /▸ 3 goals · 3 agents/);
});

test('GoalHeaderLine renders a one-line collapsed header (no agent tree)', () => {
  const { lastFrame } = render(
    <GoalHeaderLine goal={goal({ label: 'Collapsed goal', state: 'running', agents: [agent(), agent()] })} color={false} />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Collapsed goal/);
  assert.match(frame, /2 agents/);
  // exactly one rendered row — no └─/├─ agent tree branches
  assert.doesNotMatch(frame, /├─|└─/);
});

test('Panels renders a coalesced-queued line for many queued goals', () => {
  const goals: GoalView[] = [
    goal({ id: 'r1', label: 'Running', state: 'running', agents: [agent({ state: 'running' })] }),
    goal({ id: 'q1', label: 'Q one', state: 'queued', agents: [] }),
    goal({ id: 'q2', label: 'Q two', state: 'queued', agents: [] }),
    goal({ id: 'q3', label: 'Q three', state: 'queued', agents: [] }),
    goal({ id: 'q4', label: 'Q four', state: 'queued', agents: [] }),
  ];
  const plan = planGoalsPanel(goals, 3)!; // forces collapse: header + coalesced-queued
  const { lastFrame } = render(<Panels mode={{ kind: 'full', goals: [], rows: plan }} color={false} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /○ Q one/);
  assert.match(frame, /more queued/);
});
