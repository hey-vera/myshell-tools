/**
 * src/interface/ui/StatusBlock.tsx — the mission-control STATUS BLOCK (STEP 4 of
 * the Ink migration, behind the default-OFF MYSHELL_INK flag).
 *
 * A bounded, always-visible orchestration panel rendered ONLY while a turn is
 * active (it collapses to nothing when idle, matching today's calm idle prompt).
 * It sits between the <Static> transcript and the live <Stream>/<InputBox>, and
 * paints — from the reducer's existing UiState — the active GOALS, the AGENTS
 * running under each goal, a running TOKEN readout, and the spinner status line
 * ("Waiting on N models · claude ✓ · codex …"). NOT a full-screen takeover.
 *
 * PURE VIEW: every component reads state/props and paints. The ONE animation
 * owner is {@link StatusBlock}'s spinner-frame interval (Ink's render loop owns
 * it now that the legacy spinner is off on this surface); it is cheap and stops
 * when the turn ends. NO component calls Date.now / Math.random — elapsed seconds
 * for running agents are INJECTED via the `nowMs` prop (the consumer's tick).
 *
 * WHAT RENDERS IS DECIDED BY {@link layoutForHeight} (pure, unit-tested): the
 * StatusBlock paints STRICTLY the plan it returns, so the dynamic region is
 * provably <= the viewport and Ink can never duplicate the block into scrollback.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { formatTokens } from '../../infra/insights.js';
import { GLYPHS } from '../../ui/theme.js';
import { SPINNER_FRAMES, SPINNER_FRAME_INTERVAL_MS } from '../../ui/spinner.js';
import { panelLabel, type PanelistState } from '../../ui/theme.js';
import { pad, truncateToWidth } from '../../ui/tui.js';
import {
  layoutForHeight,
  summarizeTurn,
  totalAgentCount,
  coalescedQueuedLine,
  INPUT_ROWS,
  type GoalsMode,
} from './layout.js';
import type { AgentView, AgentRunState, GoalView, UiState } from './state.js';

// ---------------------------------------------------------------------------
// state glyphs
// ---------------------------------------------------------------------------

/** The single-cell glyph for a goal/agent run state, mirroring the design:
 *  queued ○ · running ◐ · done ✓ · failed ✗. Width-stable, no emoji. */
function stateGlyph(state: AgentRunState): string {
  switch (state) {
    case 'queued':
      return '○';
    case 'running':
      return '◐';
    case 'done':
      return GLYPHS.success; // ✓
    case 'failed':
      return GLYPHS.fail; // ✗
  }
}

/** The Ink colour for a run-state glyph (gated on `color`). running → cyan,
 *  done → green, failed → red, queued → dim. */
function stateColorProps(state: AgentRunState, color: boolean): { color?: string; dimColor?: boolean } {
  if (!color) return {};
  switch (state) {
    case 'running':
      return { color: 'cyan' };
    case 'done':
      return { color: 'green' };
    case 'failed':
      return { color: 'red' };
    case 'queued':
      return { dimColor: true };
  }
}

// ---------------------------------------------------------------------------
// TokenMeter
// ---------------------------------------------------------------------------

interface TokenMeterProps {
  /** The token count to render (a goal's tokens, or the turn total). */
  readonly tokens: number;
  readonly color?: boolean;
}

/**
 * The compact running token readout — `↓ ~Nk tokens` (reuses formatTokens for the
 * k/M compaction). Rendered dim so it reads as live telemetry, not chrome. A
 * progress bar is intentionally omitted: token totals are unbounded (no honest
 * denominator), so a `↓ ~Nk` text is the truthful readout — see the honesty
 * contract (no fabricated percentages).
 */
export function TokenMeter({ tokens, color = true }: TokenMeterProps): React.ReactElement {
  // Defence-in-depth alongside the reducer's clamp: a non-finite or negative
  // figure reaching here must never render `NaN`/`-Nk` — floor at 0.
  const safe = Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
  return (
    <Text dimColor={color}>{`↓ ~${formatTokens(safe)} tokens`}</Text>
  );
}

// ---------------------------------------------------------------------------
// AgentRow
// ---------------------------------------------------------------------------

export interface AgentRowProps {
  readonly agent: AgentView;
  /** True for the last agent under a goal → `└─`, else `├─`. */
  readonly last: boolean;
  /** Elapsed seconds for a running agent's `· Ns` suffix (injected, never
   *  Date.now). Omitted/0 → no suffix. */
  readonly elapsedSecs?: number;
  /** "What it's doing" for a RUNNING agent — the live stream.workLabel (e.g.
   *  "Thinking"), shown in place of the bare "running" word. Omitted/non-running →
   *  the run-state word. Never fabricated; it is the real current work label. */
  readonly workLabel?: string;
  readonly color?: boolean;
}

/** A short, human run-state word for the agent row ("done"/"running"/etc.). */
function agentStateWord(state: AgentRunState): string {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

/**
 * One agent under a goal, drawn as a tree row:
 *   `├─ claude/opus   ✓ done       1.8k tok`
 *   `└─ codex/gpt-5   ◐ running    1.3k tok · 6s`
 * provider/model + state glyph + state word + token count, plus an elapsed
 * `· Ns` only for a RUNNING agent (from the injected clock).
 */
export function AgentRow({ agent, last, elapsedSecs, workLabel, color = true }: AgentRowProps): React.ReactElement {
  const branch = last ? '└─' : '├─';
  const glyph = stateGlyph(agent.state);
  const glyphProps = stateColorProps(agent.state, color);
  // Fixed 16-col name column — glyph-width-aware truncate + pad (reuse tui.ts) so
  // a long provider/model never eats into the state glyph and the tree stays
  // aligned, exactly as box() keeps its border aligned.
  const name = pad(truncateToWidth(`${agent.provider}/${agent.model}`, 16), 16);
  // "what it's doing": for a RUNNING agent, prefer the live work label (real,
  // injected) over the bare "running" word; everyone else shows the run word.
  const word =
    agent.state === 'running' && workLabel !== undefined && workLabel.length > 0
      ? workLabel
      : agentStateWord(agent.state);
  const tok = agent.tokens > 0 ? `${formatTokens(agent.tokens)} tok` : '';
  const elapsed =
    agent.state === 'running' && elapsedSecs !== undefined && elapsedSecs > 0
      ? ` · ${elapsedSecs}s`
      : '';
  // queued agents read fully dim (nothing running yet); others keep the prose.
  const dimRow = color && agent.state === 'queued';
  return (
    <Box>
      <Text dimColor={color}>{`   ${branch} `}</Text>
      <Text dimColor={dimRow}>{`${name} `}</Text>
      <Text {...glyphProps}>{glyph}</Text>
      <Text dimColor={dimRow}>{` ${word.padEnd(8)}`}</Text>
      {tok !== '' ? <Text dimColor={color}>{`  ${tok}${elapsed}`}</Text> : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// GoalCard
// ---------------------------------------------------------------------------

export interface GoalCardProps {
  readonly goal: GoalView;
  /** Elapsed seconds for the goal's running agents (injected). */
  readonly elapsedSecs?: number;
  /** The running agent's "what it's doing" label (stream.workLabel / last tool),
   *  surfaced on the RUNNING agent row only. Omitted → the row shows its run word. */
  readonly workLabel?: string;
  readonly color?: boolean;
}

/**
 * The dim "tier · risk" secondary badge text for a goal card header, e.g.
 * `ic · medium`. The tier is always known; the risk is appended only when the
 * classifier supplied one (never fabricated). PURE.
 */
function goalBadge(goal: GoalView): string {
  const base = goal.risk !== undefined ? `${goal.tier} · ${goal.risk}` : goal.tier;
  // Per-goal PHASE badge (multi-goal seam): append "· phase X/Y" only when the
  // scheduler supplied a phase with a real denominator (total > 0). Never
  // fabricated — absent on today's single-goal path (no goal-phase event).
  if (goal.phase !== undefined && goal.phase.total > 0) {
    return `${base} · phase ${goal.phase.current}/${goal.phase.total}`;
  }
  return base;
}

/**
 * One goal: a header line (state glyph + bold human TITLE + dim "tier · risk"
 * badge + agent count + the goal's `↓ ~Nk tokens`) followed by one
 * {@link AgentRow} per agent. Mirrors the redesign:
 *   `▸ Refactor the auth middleware   ic · medium · 1 agent   ↓ ~3.1k tokens`
 *   `   └─ claude/opus   ◐ running    reading… 1.8k tok · 12s`
 */
export function GoalCard({ goal, elapsedSecs, workLabel, color = true }: GoalCardProps): React.ReactElement {
  const glyph = stateGlyph(goal.state);
  const glyphProps = stateColorProps(goal.state, color);
  const n = goal.agents.length;
  const badge = `${goalBadge(goal)} · ${n} agent${n === 1 ? '' : 's'}`;
  return (
    <Box flexDirection="column">
      <Box>
        <Text {...glyphProps}>{glyph}</Text>
        <Text bold={color}>{` ${goal.label}`}</Text>
        <Text dimColor={color}>{`   ${badge}`}</Text>
        <Text>{'  '}</Text>
        <TokenMeter tokens={goal.tokens} color={color} />
      </Box>
      {goal.agents.map((agent, i) => (
        <AgentRow
          key={`${agent.provider}/${agent.model}#${agent.attempt}`}
          agent={agent}
          last={i === goal.agents.length - 1}
          {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
          {...(workLabel !== undefined ? { workLabel } : {})}
          color={color}
        />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// GoalHeaderLine — a goal collapsed to a SINGLE header line (agent rows dropped
// under height pressure). Same header as GoalCard, no agent tree beneath it.
// ---------------------------------------------------------------------------

export interface GoalHeaderLineProps {
  readonly goal: GoalView;
  readonly color?: boolean;
}

/**
 * One collapsed goal: just the header line (state glyph + bold label + dim
 * "tier · risk · N agent" badge + token meter), used for running/done goals when
 * there isn't room to expand their agent rows. Exactly the GoalCard header,
 * minus the {@link AgentRow} children — so it always costs one terminal row.
 */
export function GoalHeaderLine({ goal, color = true }: GoalHeaderLineProps): React.ReactElement {
  const glyph = stateGlyph(goal.state);
  const glyphProps = stateColorProps(goal.state, color);
  const n = goal.agents.length;
  const badge = `${goalBadge(goal)} · ${n} agent${n === 1 ? '' : 's'}`;
  return (
    <Box>
      <Text {...glyphProps}>{glyph}</Text>
      <Text bold={color}>{` ${goal.label}`}</Text>
      <Text dimColor={color}>{`   ${badge}`}</Text>
      <Text>{'  '}</Text>
      <TokenMeter tokens={goal.tokens} color={color} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Panels — the GOALS panel body (full or compact), driven by the layout plan.
// ---------------------------------------------------------------------------

interface PanelsProps {
  readonly mode: GoalsMode;
  readonly elapsedSecs?: number;
  /** The live "what it's doing" label for running agents (stream.workLabel). */
  readonly workLabel?: string;
  readonly color?: boolean;
}

/**
 * The bordered GOALS panel. `mode` comes from {@link layoutForHeight}: `full`
 * paints a {@link GoalCard} per goal; `compact` paints the one-line summary;
 * `hidden` renders nothing (the caller drops the panel under height pressure).
 * The rounded border + cyan "GOALS" title mirror tui.panel()'s look.
 */
export function Panels({ mode, elapsedSecs, workLabel, color = true }: PanelsProps): React.ReactElement | null {
  if (mode.kind === 'hidden') return null;
  const borderProps = color ? { borderColor: 'gray' as const } : {};
  return (
    <Box flexDirection="column" borderStyle="round" {...borderProps} paddingX={1}>
      <Text {...(color ? { color: 'cyan' as const } : {})}>GOALS</Text>
      {mode.kind === 'full'
        ? mode.rows.map((row, i) => {
            // The ordered body plan: full cards, collapsed headers, and coalesced
            // queued/done lines — each painted as exactly the rows the layout
            // budgeted, so the panel can never overflow the viewport.
            if (row.kind === 'card') {
              return (
                <GoalCard
                  key={row.goal.id}
                  goal={row.goal}
                  {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
                  {...(workLabel !== undefined ? { workLabel } : {})}
                  color={color}
                />
              );
            }
            if (row.kind === 'header') {
              return <GoalHeaderLine key={row.goal.id} goal={row.goal} color={color} />;
            }
            if (row.kind === 'coalesced-queued') {
              return (
                <Text key={`queued#${i}`} dimColor={color}>
                  {coalescedQueuedLine(row.goals)}
                </Text>
              );
            }
            // coalesced-done: a one-line `✓ N done[ · ✗ M failed]` roll-up.
            const parts: string[] = [];
            if (row.done > 0) parts.push(`${GLYPHS.success} ${row.done} done`);
            if (row.failed > 0) parts.push(`${GLYPHS.fail} ${row.failed} failed`);
            return (
              <Text key={`done#${i}`} dimColor={color}>
                {parts.join(' · ')}
              </Text>
            );
          })
        : <Text dimColor={color}>{mode.summary}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// StatusLine — the spinner + phase verb + interrupt hint
// ---------------------------------------------------------------------------

export interface StatusLineProps {
  readonly state: UiState;
  /** The current braille frame glyph (from StatusBlock's single animation owner). */
  readonly frame: string;
  /** Elapsed seconds the turn has been visible (injected) → the `· Ns` suffix. */
  readonly elapsedSecs?: number;
  readonly color?: boolean;
}

/**
 * The live status line under the panels: `⠹ <verb> · Ns   esc to interrupt`. The
 * verb mirrors render.ts's spinnerLabel exactly:
 *   - panel mode → panelLabel() ("Waiting on N models · claude ✓ · codex …" /
 *     "Synthesizing N answers…");
 *   - otherwise → "<workLabel>… N steps[ · ↓ ~Nk tokens]".
 * The braille `frame` and the `· Ns` elapsed come from the injected tick/clock so
 * this component never reads the system clock.
 */
export function StatusLine({ state, frame, elapsedSecs, color = true }: StatusLineProps): React.ReactElement {
  const s = state.stream;
  const elapsed = elapsedSecs !== undefined && elapsedSecs > 0 ? ` · ${elapsedSecs}s` : '';
  if (s.phase === 'panel' || s.phase === 'synthesis') {
    // Panel mode keeps the already-agent-shaped panelLabel ("Waiting on N
    // models · claude ✓ · codex …" / "Synthesizing N answers…").
    const panelists = s.panelists.map((p) => ({
      provider: String(p.provider),
      state: (p.state === 'done' ? 'done' : 'running') as PanelistState,
    }));
    const verb = panelLabel(panelists, s.synthesizing, color);
    return (
      <Box>
        <Text {...(color ? { color: 'cyan' as const } : {})}>{frame}</Text>
        <Text>{` ${verb}${elapsed}`}</Text>
        <Text dimColor={color}>{'   esc to interrupt'}</Text>
      </Box>
    );
  }
  // Non-panel: LEAD with the real agent count; demote the per-tier tool-call count
  // (the old "N steps") to a DIM detail. The agent count is derived (1–4 today),
  // never fabricated. "29 steps" → "29 tool calls". Tokens stay a dim suffix.
  const nAgents = totalAgentCount(state);
  const agentStr = `${nAgents} agent${nAgents === 1 ? '' : 's'}`;
  const steps = `${s.stepCount} tool call${s.stepCount === 1 ? '' : 's'}`;
  const approxTok = s.streamedChars > 0 ? ` · ↓ ~${formatTokens(Math.ceil(s.streamedChars / 4))} tokens` : '';
  return (
    <Box>
      <Text {...(color ? { color: 'cyan' as const } : {})}>{frame}</Text>
      <Text>{` ${s.workLabel}…`}</Text>
      <Text dimColor={color}>{`  ${agentStr} · ${steps}${approxTok}${elapsed}   esc to interrupt`}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// StatusBlock — the container (the ONE spinner-animation owner)
// ---------------------------------------------------------------------------

export interface StatusBlockProps {
  readonly state: UiState;
  /**
   * An INJECTED wall-clock (ms), supplied by the impure mount boundary (never
   * `Date.now` inside this React tree). The block samples it on its own frame
   * tick to derive the turn's elapsed `· Ns`. When omitted, elapsed suffixes are
   * dropped — a hermetic test render shows no fabricated seconds. Tests pass a
   * deterministic `() => fixedMs` to assert exact elapsed values.
   */
  readonly clock?: () => number;
  /** Terminal height (rows) — the layout cap input. Defaults to a comfortable 24. */
  readonly rows?: number;
  /** Wrapped line count of the live stream buffer (for the cap). Default: 1 when
   *  the buffer is non-empty, else 0. */
  readonly streamLines?: number;
  /** Rows the pinned <InputBox> will occupy this frame (the composer's rendered
   *  height). MUST match what <App> passes to its own layoutForHeight so the panel
   *  plan and the stream cap agree. Defaults to the single-line {@link INPUT_ROWS}. */
  readonly inputRows?: number;
  readonly color?: boolean;
}

/**
 * The mission-control status block. Renders nothing when the turn is idle. While
 * a turn is active it paints (top→bottom): the GOALS panel (full cards or the
 * compact summary, per the height plan) then the live status line. The live
 * <Stream> and <InputBox> are rendered by <App> directly BELOW this block; this
 * block's height plus those is provably <= the viewport via {@link layoutForHeight}.
 *
 * This component owns the SINGLE spinner animation on the Ink surface: a cheap
 * interval that advances the braille frame while `turnActive`, and is torn down
 * the instant the turn ends (so an idle UI has zero timers).
 */
export function StatusBlock({
  state,
  clock,
  rows = 24,
  streamLines,
  inputRows,
  color = true,
}: StatusBlockProps): React.ReactElement | null {
  const [frameIndex, setFrameIndex] = useState(0);
  // The injected clock, sampled on each tick → elapsed `· Ns`. `turnStartMs` is
  // captured the first tick of a turn so elapsed counts from when the block
  // became visible (mirrors the legacy spinner's tick-derived elapsed). Both are
  // refs (not state) so sampling the clock never schedules an extra render beyond
  // the frame tick that already repaints.
  const turnStartRef = React.useRef<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState<number | undefined>(undefined);

  // The ONE animation owner: advance the braille frame on a cheap interval while
  // the turn is active, AND (when a clock is injected) recompute elapsed from it.
  // Stops + resets when the turn ends so an idle UI has zero timers.
  useEffect(() => {
    if (!state.turnActive) {
      setFrameIndex(0);
      turnStartRef.current = null;
      setElapsedSecs(undefined);
      return;
    }
    if (clock !== undefined && turnStartRef.current === null) {
      turnStartRef.current = clock();
      setElapsedSecs(0);
    }
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
      if (clock !== undefined && turnStartRef.current !== null) {
        const secs = Math.floor((clock() - turnStartRef.current) / 1000);
        setElapsedSecs(secs >= 0 ? secs : 0);
      }
    }, SPINNER_FRAME_INTERVAL_MS);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, [state.turnActive, clock]);

  const plan = layoutForHeight(
    state,
    rows,
    streamLines ?? (state.stream.buffer.length > 0 ? 1 : 0),
    inputRows ?? INPUT_ROWS,
  );
  if (!plan.visible) return null;

  const frame = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0] ?? '⠋';

  // The live "what it's doing" label rides onto the RUNNING agent row (real
  // stream.workLabel — "Thinking" in normal mode, the verbose tier label in
  // verbose). Only meaningful while the non-panel stream is active.
  const liveWorkLabel = state.stream.workLabel;

  return (
    <Box flexDirection="column">
      <Panels
        mode={plan.goals}
        {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
        {...(liveWorkLabel.length > 0 ? { workLabel: liveWorkLabel } : {})}
        color={color}
      />
      {plan.showSummary ? (
        <Text {...(color ? { color: 'cyan' as const } : {})}>
          {summarizeTurn(state, elapsedSecs)}
        </Text>
      ) : null}
      <StatusLine
        state={state}
        frame={frame}
        {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
        color={color}
      />
    </Box>
  );
}
