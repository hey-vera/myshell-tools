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
  return (
    <Text dimColor={color}>{`↓ ~${formatTokens(tokens)} tokens`}</Text>
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
export function AgentRow({ agent, last, elapsedSecs, color = true }: AgentRowProps): React.ReactElement {
  const branch = last ? '└─' : '├─';
  const glyph = stateGlyph(agent.state);
  const glyphProps = stateColorProps(agent.state, color);
  // Fixed 16-col name column — glyph-width-aware truncate + pad (reuse tui.ts) so
  // a long provider/model never eats into the state glyph and the tree stays
  // aligned, exactly as box() keeps its border aligned.
  const name = pad(truncateToWidth(`${agent.provider}/${agent.model}`, 16), 16);
  const word = agentStateWord(agent.state);
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
  readonly color?: boolean;
}

/**
 * One goal: a header line (state glyph + label + the goal's `↓ ~Nk tokens`)
 * followed by one {@link AgentRow} per agent. Mirrors the design:
 *   `◐ Refactor auth flow                       ↓ ~3.1k tokens`
 *   `   ├─ claude/opus   ✓ done       1.8k tok`
 */
export function GoalCard({ goal, elapsedSecs, color = true }: GoalCardProps): React.ReactElement {
  const glyph = stateGlyph(goal.state);
  const glyphProps = stateColorProps(goal.state, color);
  return (
    <Box flexDirection="column">
      <Box>
        <Text {...glyphProps}>{glyph}</Text>
        <Text bold={color}>{` ${goal.label}`}</Text>
        <Text>{'  '}</Text>
        <TokenMeter tokens={goal.tokens} color={color} />
      </Box>
      {goal.agents.map((agent, i) => (
        <AgentRow
          key={`${agent.provider}/${agent.model}#${agent.attempt}`}
          agent={agent}
          last={i === goal.agents.length - 1}
          {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
          color={color}
        />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Panels — the GOALS panel body (full or compact), driven by the layout plan.
// ---------------------------------------------------------------------------

interface PanelsProps {
  readonly mode: GoalsMode;
  readonly elapsedSecs?: number;
  readonly color?: boolean;
}

/**
 * The bordered GOALS panel. `mode` comes from {@link layoutForHeight}: `full`
 * paints a {@link GoalCard} per goal; `compact` paints the one-line summary;
 * `hidden` renders nothing (the caller drops the panel under height pressure).
 * The rounded border + cyan "GOALS" title mirror tui.panel()'s look.
 */
export function Panels({ mode, elapsedSecs, color = true }: PanelsProps): React.ReactElement | null {
  if (mode.kind === 'hidden') return null;
  const borderProps = color ? { borderColor: 'gray' as const } : {};
  return (
    <Box flexDirection="column" borderStyle="round" {...borderProps} paddingX={1}>
      <Text {...(color ? { color: 'cyan' as const } : {})}>GOALS</Text>
      {mode.kind === 'full'
        ? mode.goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
              color={color}
            />
          ))
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
  let verb: string;
  if (s.phase === 'panel' || s.phase === 'synthesis') {
    const panelists = s.panelists.map((p) => ({
      provider: String(p.provider),
      state: (p.state === 'done' ? 'done' : 'running') as PanelistState,
    }));
    verb = panelLabel(panelists, s.synthesizing, color);
  } else {
    const steps = `${s.stepCount} step${s.stepCount === 1 ? '' : 's'}`;
    if (s.streamedChars > 0) {
      const approxTok = formatTokens(Math.ceil(s.streamedChars / 4));
      verb = `${s.workLabel}… ${steps} · ↓ ~${approxTok} tokens`;
    } else {
      verb = `${s.workLabel}… ${steps}`;
    }
  }
  const elapsed = elapsedSecs !== undefined && elapsedSecs > 0 ? ` · ${elapsedSecs}s` : '';
  return (
    <Box>
      <Text {...(color ? { color: 'cyan' as const } : {})}>{frame}</Text>
      <Text>{` ${verb}${elapsed}`}</Text>
      <Text dimColor={color}>{'   esc to interrupt'}</Text>
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
  );
  if (!plan.visible) return null;

  const frame = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0] ?? '⠋';

  return (
    <Box flexDirection="column">
      <Panels
        mode={plan.goals}
        {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
        color={color}
      />
      <StatusLine
        state={state}
        frame={frame}
        {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
        color={color}
      />
    </Box>
  );
}
