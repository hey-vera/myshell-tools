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
  AgentRow,
  StatusLine,
  Panels,
  TokenMeter,
} from '../../src/interface/ui/StatusBlock.js';
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
  };
}
function active(goals: readonly GoalView[], over: Partial<UiState> = {}): UiState {
  return { ...initialState, turnActive: true, goals, ...over };
}

test('GoalCard renders the label, a state glyph, and the token meter', () => {
  const { lastFrame } = render(
    <GoalCard goal={goal({ state: 'running', tokens: 3100 })} color={false} />,
  );
  const frame = lastFrame() ?? '';
  assert.match(frame, /Refactor auth flow/);
  assert.match(frame, /◐/); // running glyph
  assert.match(frame, /↓ ~3\.1k tokens/);
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

test('StatusLine renders the non-panel "Thinking…" verb with step + token estimate', () => {
  const state: UiState = {
    ...initialState,
    turnActive: true,
    stream: { ...initialState.stream, phase: 'streaming', workLabel: 'Thinking', stepCount: 3, streamedChars: 4000 },
  };
  const { lastFrame } = render(<StatusLine state={state} frame="⠙" elapsedSecs={6} color={false} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /Thinking… 3 steps/);
  assert.match(frame, /↓ ~1k tokens/);
  assert.match(frame, /· 6s/);
});

test('StatusBlock COLLAPSES to the compact summary at a small height', () => {
  const goals = [
    goal({ id: 'a', state: 'running', agents: [agent({ state: 'running' }), agent({ state: 'running' }), agent({ state: 'running' })] }),
    goal({ id: 'b', state: 'running', agents: [agent({ state: 'running' }), agent({ state: 'running' })] }),
    goal({ id: 'c', state: 'queued', agents: [agent({ state: 'queued' })] }),
  ];
  const state = active(goals, { tokens: { turn: 4200, session: 4200 } });
  // A small height forces the compact one-line summary instead of full cards.
  const { lastFrame } = render(<StatusBlock state={state} color={false} rows={9} />);
  const frame = lastFrame() ?? '';
  assert.match(frame, /3 goals/);
  assert.match(frame, /2 running/);
  assert.match(frame, /1 queued/);
  assert.match(frame, /↓ 4\.2k tok/);
  // the full per-agent tree must NOT be present in the collapsed form
  assert.doesNotMatch(frame, /├─/);
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
