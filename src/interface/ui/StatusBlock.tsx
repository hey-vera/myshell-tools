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
  summarizeWork,
  summarizeTurn,
  coalescedQueuedLine,
  INPUT_ROWS,
  type BoardPlan,
  type GoalsMode,
  type StatusLayout,
} from './layout.js';
import type {
  AgentView,
  AgentRunState,
  GoalBoardRow,
  GoalBoardTodoRow,
  GoalView,
  UiState,
} from './state.js';

// ---------------------------------------------------------------------------
// currentTool → a scannable live-action label
// ---------------------------------------------------------------------------

/**
 * Render the live action (`stream.currentTool`) as a scannable `verb target`
 * string, e.g. `editing src/auth/mw.ts` or just `running` when no real target was
 * supplied. The target is shown ONLY when genuinely present (never fabricated) and
 * is width-bounded so a long path/command never blows the status line. Returns ''
 * for an absent/empty action so callers fall back to the real workLabel. PURE.
 */
function liveActionLabel(
  currentTool: { readonly verb: string; readonly target?: string } | undefined,
): string {
  if (currentTool === undefined || currentTool.verb.length === 0) return '';
  if (currentTool.target !== undefined && currentTool.target.length > 0) {
    return `${currentTool.verb} ${truncateToWidth(currentTool.target, 40)}`;
  }
  return currentTool.verb;
}

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

/**
 * Semantic Ink colour for a persistent BOARD row state (gated on `color`).
 * Mirrors {@link stateColorProps} so the board and live GOALS panel share one
 * success/error/running vocabulary (S.1 visual polish).
 */
function boardStateColorProps(
  state: GoalBoardRow['state'],
  color: boolean,
): { color?: string; dimColor?: boolean } {
  if (!color) return {};
  switch (state) {
    case 'running':
      return { color: 'cyan' };
    case 'done':
      return { color: 'green' };
    case 'failed':
    case 'blocked':
      return { color: 'red' };
    case 'queued':
      return { color: 'yellow' };
    case 'parked':
    case 'superseded':
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
   *  "Preparing" / "Thinking" / "Responding"), shown in place of the bare
   *  "running" word. Omitted/non-running → the run-state word. Never fabricated;
   *  it is the real current work label. */
  readonly workLabel?: string;
  /** The LIVE action label ("editing src/auth/mw.ts" / "running") from the real
   *  most-recent tool event, preferred over {@link workLabel} for a RUNNING agent.
   *  Omitted/empty → falls back to workLabel then the run-state word. Real, never
   *  fabricated (target shown only when the tool event supplied one). */
  readonly liveAction?: string;
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
export function AgentRow({ agent, last, elapsedSecs, workLabel, liveAction, color = true }: AgentRowProps): React.ReactElement {
  const branch = last ? '└─' : '├─';
  const glyph = stateGlyph(agent.state);
  const glyphProps = stateColorProps(agent.state, color);
  // Fixed 16-col name column — glyph-width-aware truncate + pad (reuse tui.ts) so
  // a long provider/model never eats into the state glyph and the tree stays
  // aligned, exactly as box() keeps its border aligned.
  const name = pad(truncateToWidth(`${agent.provider}/${agent.model}`, 16), 16);
  // "what it's doing": for a RUNNING agent, LEAD with the live action (the real
  // tool verb + target, e.g. "editing src/auth/mw.ts"), then the live work label
  // ("Thinking"), then the bare "running" word; everyone else shows the run word.
  // All three are real — the live action comes straight from the tool event.
  const liveWord =
    liveAction !== undefined && liveAction.length > 0
      ? liveAction
      : workLabel !== undefined && workLabel.length > 0
        ? workLabel
        : '';
  const word =
    agent.state === 'running' && liveWord.length > 0 ? liveWord : agentStateWord(agent.state);
  // Tokens are shown ONLY when genuinely > 0 (real, post-tier-done); never a
  // fabricated/zero figure. The elapsed `· Ns` is a real injected clock value and
  // shows for ANY running agent — independent of whether tokens are known yet
  // (so a live-action row mid-run still shows how long it has been going).
  const tok = agent.tokens > 0 ? `${formatTokens(agent.tokens)} tok` : '';
  const showElapsed =
    agent.state === 'running' && elapsedSecs !== undefined && elapsedSecs > 0;
  // Build the dim trailing detail from whichever real signals exist. The elapsed
  // always reads as `· Ns` (a leading `· ` even when it stands alone, so a live-
  // action row mid-run shows `editing … · 12s`); tokens lead when present.
  const trailing = tok !== '' ? (showElapsed ? `${tok} · ${elapsedSecs}s` : tok) : showElapsed ? `· ${elapsedSecs}s` : '';
  // queued agents read fully dim (nothing running yet); others keep the prose.
  const dimRow = color && agent.state === 'queued';
  return (
    <Box>
      <Text dimColor={color}>{`   ${branch} `}</Text>
      <Text dimColor={dimRow}>{`${name} `}</Text>
      <Text {...glyphProps}>{glyph}</Text>
      <Text dimColor={dimRow}>{` ${word.padEnd(8)}`}</Text>
      {trailing !== '' ? <Text dimColor={color}>{`  ${trailing}`}</Text> : null}
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
  /** The live action label (real tool verb + target) for the RUNNING agent row,
   *  preferred over {@link workLabel}. Omitted → falls back to workLabel. */
  readonly liveAction?: string;
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
export function GoalCard({ goal, elapsedSecs, workLabel, liveAction, color = true }: GoalCardProps): React.ReactElement {
  const glyph = stateGlyph(goal.state);
  const glyphProps = stateColorProps(goal.state, color);
  const n = goal.agents.length;
  const badge = `${goalBadge(goal)} · ${n} agent${n === 1 ? '' : 's'}`;
  const depNote = goal.dependsOn && goal.dependsOn.length > 0 ? ` (deps: ${goal.dependsOn.join(',')})` : '';
  // Fuller DAG/tree viz (A++++): tree prefix and deps
  const treePrefix = goal.dependsOn && goal.dependsOn.length > 0 ? '├─ ' : '▸ ';
  return (
    <Box flexDirection="column">
      <Box>
        <Text {...glyphProps}>{glyph}</Text>
        <Text bold={color}>{` ${treePrefix}${goal.label}`}</Text>
        <Text dimColor={color}>{`   ${badge}${depNote}`}</Text>
        {goal.tokens > 0 ? (
          <>
            <Text>{'  '}</Text>
            <TokenMeter tokens={goal.tokens} color={color} />
          </>
        ) : null}
      </Box>
      {goal.dependsOn && goal.dependsOn.length > 0 && (
        <Text dimColor={color}>   └ depends on: {goal.dependsOn.join(', ')}</Text>
      )}
      {goal.agents.map((agent, i) => (
        <AgentRow
          key={`${agent.provider}/${agent.model}#${agent.attempt}`}
          agent={agent}
          last={i === goal.agents.length - 1}
          {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
          {...(workLabel !== undefined ? { workLabel } : {})}
          {...(liveAction !== undefined ? { liveAction } : {})}
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
      {goal.tokens > 0 ? (
        <>
          <Text>{'  '}</Text>
          <TokenMeter tokens={goal.tokens} color={color} />
        </>
      ) : null}
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
  /** The live action label (real tool verb + target) for running agents. */
  readonly liveAction?: string;
  /**
   * The panel title. DEFAULT "GOALS" → byte-for-byte today. When the persistent
   * board is ON the caller passes "WORKING" so the live per-turn region reads as
   * honest current-turn status (the real goals live on the BOARD, not here).
   */
  readonly header?: string;
  readonly color?: boolean;
}

/**
 * The bordered GOALS panel. `mode` comes from {@link layoutForHeight}: `full`
 * paints a {@link GoalCard} per goal; `compact` paints the one-line summary;
 * `hidden` renders nothing (the caller drops the panel under height pressure).
 * The rounded border + cyan "GOALS" title mirror tui.panel()'s look.
 */
function PanelsImpl({ mode, elapsedSecs, workLabel, liveAction, header = 'GOALS', color = true }: PanelsProps): React.ReactElement | null {
  if (mode.kind === 'hidden') return null;
  const borderProps = color ? { borderColor: 'gray' as const } : {};
  return (
    <Box flexDirection="column" borderStyle="round" {...borderProps} paddingX={1}>
      <Text {...(color ? { color: 'cyan' as const } : {})}>{header}</Text>
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
                  {...(liveAction !== undefined ? { liveAction } : {})}
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
            // S.1: success/error glyphs carry semantic color; counts stay dim.
            return (
              <Box key={`done#${i}`}>
                {row.done > 0 ? (
                  <>
                    <Text {...(color ? { color: 'green' as const } : {})}>{GLYPHS.success}</Text>
                    <Text dimColor={color}>{` ${row.done} done`}</Text>
                  </>
                ) : null}
                {row.done > 0 && row.failed > 0 ? (
                  <Text dimColor={color}>{' · '}</Text>
                ) : null}
                {row.failed > 0 ? (
                  <>
                    <Text {...(color ? { color: 'red' as const } : {})}>{GLYPHS.fail}</Text>
                    <Text dimColor={color}>{` ${row.failed} failed`}</Text>
                  </>
                ) : null}
              </Box>
            );
          })
        : <Text dimColor={color}>{mode.summary}</Text>}
    </Box>
  );
}

/**
 * The bordered GOALS panel, memoized so a parent re-render with UNCHANGED props
 * (e.g. the 1Hz elapsed bump when nothing in the panel changed, or any state push
 * that doesn't touch the goals/mode) skips re-rendering the whole goal tree. The
 * props are shallow-comparable: `mode` is `plan.goals` (referentially stable while
 * the memoized layout plan is stable), and the rest are primitives. Pure view —
 * memoizing never changes its output.
 */
export const Panels = React.memo(PanelsImpl);

// ---------------------------------------------------------------------------
// BoardPanel — the REAL PERSISTENT GOAL BOARD (Elite-partner Phase 1)
// ---------------------------------------------------------------------------

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function boardTodoGlyph(status: GoalBoardTodoRow['status']): string {
  switch (status) {
    case 'done':
      return GLYPHS.success;
    case 'blocked':
      return '\u26A0';
    case 'superseded':
      return '\u2717';
    case 'active':
      return '\u25D0';
    case 'pending':
      return ' ';
  }
}

export interface BoardRowProps {
  readonly row: GoalBoardRow;
  readonly state: UiState;
  readonly color?: boolean;
}

/**
 * First real next step on a board row (active todo preferred, else first pending).
 * Returns undefined when no honest next item exists — never fabricated.
 */
export function boardNextAction(row: GoalBoardRow): string | undefined {
  if (row.todos === undefined || row.todos.length === 0) return undefined;
  const active = row.todos.find((t) => t.status === 'active');
  if (active !== undefined) return active.text;
  const pending = row.todos.find((t) => t.status === 'pending');
  if (pending !== undefined) return pending.text;
  return undefined;
}

/**
 * One persistent board row, rendered goal-first from the persisted row plus the
 * reducer's live goal snapshot keyed by row.id. In board mode this is the primary
 * per-goal line for both idle and active turns.
 *
 * Header shape (scannable, no dual chrome):
 *   `{glyph} {title}  {done}/{total} · {state}[ · N workers][ · N tools]`
 * Optional real secondary lines: Approach, next-action (when the todo checklist
 * is not expanded), running checklist.
 */
export function BoardRow({ row, state, color = true }: BoardRowProps): React.ReactElement {
  const liveGoal = state.goals.find((goal) => goal.id === row.id);
  const liveAgents = liveGoal?.agents.length ?? 0;
  const liveTools = liveGoal?.toolCount ?? 0;
  // Prefer the live agent count when present; fall back to the synced row count.
  const agents = liveAgents > 0 ? liveAgents : row.agents;
  const progress = row.total > 0 ? `${row.done}/${row.total}` : '';
  // Meta after the title stays dim secondary text; glyph carries semantic color.
  const metaParts: string[] = [];
  if (progress.length > 0) metaParts.push(progress);
  metaParts.push('·', row.state);
  if (agents > 0) metaParts.push('·', pluralize(agents, 'worker'));
  if (liveTools > 0) metaParts.push('·', pluralize(liveTools, 'tool'));
  if (row.verdict !== undefined && row.verdict.length > 0) metaParts.push('·', row.verdict);
  const indent = '  '.repeat(row.depth ?? 0);
  const glyphProps = boardStateColorProps(row.state, color);
  // Running goals expand the checklist, so a separate "next:" line would duplicate
  // the active todo. For parked/queued/etc., surface the next real step when known.
  const nextHint = row.state === 'running' ? undefined : boardNextAction(row);
  return (
    <Box flexDirection="column">
      <Box>
        {indent.length > 0 ? <Text>{indent}</Text> : null}
        <Text {...glyphProps}>{row.glyph}</Text>
        <Text>{` ${row.title}`}</Text>
        {metaParts.length > 0 ? (
          <Text dimColor={color}>{` ${metaParts.join(' ')}`}</Text>
        ) : null}
      </Box>
      {row.approach ? (
        <Text dimColor={color}>
          {`${indent}   Approach: ${truncateToWidth(row.approach.chosen, 48)}${row.approach.rationale ? ' - ' + truncateToWidth(row.approach.rationale, 40) : ''}`}
        </Text>
      ) : null}
      {nextHint !== undefined ? (
        <Text dimColor={color}>{`${indent}   next: ${truncateToWidth(nextHint, 56)}`}</Text>
      ) : null}
      {row.state === 'running'
        ? row.todos?.map((todo) => (
            <Text key={todo.id} dimColor={color}>{`${indent}   [${boardTodoGlyph(todo.status)}] ${todo.text}`}</Text>
          ))
        : null}
    </Box>
  );
}

interface BoardPanelProps {
  readonly plan: BoardPlan;
  readonly state: UiState;
  readonly color?: boolean;
}

/**
 * The bordered BOARD panel: a cyan "BOARD" title over one {@link BoardRow} per
 * shown goal, plus a dim `+K more` overflow line when the height budget collapsed
 * the tail. Painted STRICTLY to the layout's {@link BoardPlan} (so it can never
 * overflow the viewport) and ACROSS turns (it does not depend on turnActive). The
 * rounded border mirrors the GOALS/WORKING panel look.
 */
function BoardPanelImpl({ plan, state, color = true }: BoardPanelProps): React.ReactElement {
  const borderProps = color ? { borderColor: 'gray' as const } : {};
  return (
    <Box flexDirection="column" borderStyle="round" {...borderProps} paddingX={1}>
      <Text {...(color ? { color: 'cyan' as const } : {})}>BOARD</Text>
      {plan.shown.map((row) => (
        <BoardRow key={row.id} row={row} state={state} color={color} />
      ))}
      {plan.overflow > 0 ? (
        <Text dimColor={color}>{`+${plan.overflow} more`}</Text>
      ) : null}
    </Box>
  );
}

/** Memoized BOARD panel — a 1Hz elapsed bump or a spinner tick with an UNCHANGED
 *  plan skips re-rendering the whole board tree (the plan reference is stable while
 *  the memoized layout plan is). Pure view — memoizing never changes its output. */
export const BoardPanel = React.memo(BoardPanelImpl);

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

interface SpinnerStatusLineProps {
  readonly state: UiState;
  /** Elapsed seconds the turn has been visible (injected) → the `· Ns` suffix. */
  readonly elapsedSecs?: number;
  readonly color?: boolean;
}

/**
 * The self-animating live status line — the SOLE owner of the fast (80ms) braille
 * spinner frame on the Ink surface. It keeps the frame index in its OWN
 * `useState`/interval so a frame tick repaints ONLY this one line, NOT the parent
 * StatusBlock / GOALS panel (the perf fix: an 80ms tick no longer re-walks the
 * stream buffer or re-runs the layout planner). The elapsed `· Ns` is still driven
 * by the slower (1Hz) parent tick via the `elapsedSecs` prop. Renders byte-identical
 * output to the prior {@link StatusLine} (same braille cycle, same verb, same
 * elapsed) — the smokes that scrape the braille frame + `· Ns` see no change.
 */
function SpinnerStatusLine({ state, elapsedSecs, color = true }: SpinnerStatusLineProps): React.ReactElement {
  const [frameIndex, setFrameIndex] = useState(0);
  useEffect(() => {
    if (!state.turnActive) {
      setFrameIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % SPINNER_FRAMES.length);
    }, SPINNER_FRAME_INTERVAL_MS);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, [state.turnActive]);
  const frame = SPINNER_FRAMES[frameIndex] ?? SPINNER_FRAMES[0] ?? '⠋';
  return (
    <StatusLine
      state={state}
      frame={frame}
      {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
      color={color}
    />
  );
}

/**
 * The live status line under the panels: `⠹ <verb> · Ns   esc to interrupt`. The
 * verb mirrors render.ts's spinnerLabel exactly:
 *   - panel mode → panelLabel() ("Waiting on N models · claude ✓ · codex …" /
 *     "Synthesizing N answers…");
 *   - otherwise → "<workLabel>… · honest work summary".
 * The braille `frame` and the `· Ns` elapsed come from the injected tick/clock so
 * this component never reads the system clock.
 */
export function StatusLine({ state, frame, elapsedSecs, color = true }: StatusLineProps): React.ReactElement {
  const s = state.stream;
  const elapsed = elapsedSecs !== undefined ? `${elapsedSecs}s` : '';
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
  // Non-panel: LEAD with the live ACTION — the single most informative real-time
  // signal — i.e. the real tool verb + target ("editing src/auth/mw.ts") from the
  // most recent tool event; fall back to the real workLabel ("Preparing" /
  // "Thinking" / "Responding") when no tool is active. Then the demoted, DIM
  // detail: a strictly derived work summary
  // (running agents, completed agents, visible multi-goal count, elapsed). NO
  // token figure is shown here: mid-run there is no honest token count for the
  // Claude subscription provider, so we never render the old fabricated
  // `streamedChars/4` proxy.
  const liveAction = liveActionLabel(s.currentTool);
  const headline = liveAction.length > 0 ? liveAction : s.workLabel;
  const summary = summarizeWork(state);
  const detailParts: string[] = [];
  if (summary.active > 0) detailParts.push(`◐ ${summary.active} active`);
  if (summary.complete > 0) detailParts.push(`✓ ${summary.complete} complete`);
  if (summary.goals !== undefined) detailParts.push(`${summary.goals} goals`);
  if (elapsed.length > 0) detailParts.push(elapsed);
  const detail = detailParts.join(' · ');
  return (
    <Box>
      <Text {...(color ? { color: 'cyan' as const } : {})}>{frame}</Text>
      <Text>{` ${headline}…`}</Text>
      {detail.length > 0 ? (
        <Text dimColor={color}>{` · ${detail}${summary.active > 0 || summary.complete > 0 || summary.goals !== undefined ? '   esc to interrupt' : ''}`}</Text>
      ) : null}
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
  /**
   * The PRE-COMPUTED layout plan. <App> computes the plan ONCE (memoized on the
   * real content inputs) and threads it down so this block does NOT run a second
   * full `layoutForHeight` pass per render (the perf fix). When omitted (tests that
   * render <StatusBlock> directly), the block falls back to computing the plan
   * itself from `rows`/`streamLines`/`inputRows` — byte-identical to before.
   */
  readonly plan?: StatusLayout;
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
  plan: planProp,
  color = true,
}: StatusBlockProps): React.ReactElement | null {
  // The injected clock, sampled once per SECOND → elapsed `· Ns`. `turnStartRef`
  // is captured the first tick of a turn so elapsed counts from when the block
  // became visible. The fast (80ms) braille frame is NO LONGER owned here — it
  // lives in the {@link SpinnerStatusLine} leaf so an animation tick repaints one
  // line, not this whole block (and never re-runs the layout planner). This block
  // now only re-renders on a real state push or the 1Hz elapsed bump.
  const turnStartRef = React.useRef<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState<number | undefined>(undefined);

  // The 1Hz elapsed-seconds tick (when a clock is injected). Stops + resets when
  // the turn ends so an idle UI has zero timers. The cadence is now 1s, not 80ms:
  // elapsed only changes whole seconds, so a slower interval renders identically
  // while cutting this block's tick-driven re-renders by ~12x.
  useEffect(() => {
    if (!state.turnActive) {
      turnStartRef.current = null;
      setElapsedSecs(undefined);
      return;
    }
    if (clock === undefined) {
      return;
    }
    if (turnStartRef.current === null) {
      turnStartRef.current = clock();
      setElapsedSecs(0);
    }
    const timer = setInterval(() => {
      if (turnStartRef.current !== null) {
        const secs = Math.floor((clock() - turnStartRef.current) / 1000);
        setElapsedSecs(secs >= 0 ? secs : 0);
      }
    }, 1000);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, [state.turnActive, clock]);

  // Use the plan threaded down from <App> (computed ONCE, memoized) when present;
  // otherwise (a direct <StatusBlock> render in tests) compute it here so the
  // standalone behaviour is byte-identical to before.
  const plan =
    planProp ??
    layoutForHeight(
      state,
      rows,
      streamLines ?? (state.stream.buffer.length > 0 ? 1 : 0),
      inputRows ?? INPUT_ROWS,
    );
  if (!plan.visible) return null;

  // The persistent BOARD (Elite-partner Phase 1) renders ACROSS turns, ABOVE the
  // live region, painted strictly to the layout's bounded plan. Null on the flag-
  // off path → nothing extra rendered (byte-for-byte today). When the turn is idle
  // the live region (Panels / summary / spinner) collapses and ONLY the board shows.
  const boardEl =
    plan.board !== null ? <BoardPanel plan={plan.board} state={state} color={color} /> : null;

  if (!state.turnActive) {
    // Idle: the only reason the block is visible is the persistent board.
    return <Box flexDirection="column">{boardEl}</Box>;
  }

  // The live "what it's doing" label rides onto the RUNNING agent row (real
  // stream.workLabel — phase verb (Preparing/Thinking/Responding) in normal mode,
  // the verbose tier label in
  // verbose). Only meaningful while the non-panel stream is active.
  const liveWorkLabel = state.stream.workLabel;
  // The live ACTION (real tool verb + optional target) leads the RUNNING agent row
  // when a tool is active — the "see what's happening" signal. Real, never
  // fabricated; empty when no tool has fired this tier (then the row falls back to
  // the work label).
  const liveAction = liveActionLabel(state.stream.currentTool);
  return (
    <Box flexDirection="column">
      {boardEl}
      {plan.goals.kind !== 'hidden' ? (
        <Panels
          mode={plan.goals}
          header="GOALS"
          {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
          {...(liveWorkLabel.length > 0 ? { workLabel: liveWorkLabel } : {})}
          {...(liveAction.length > 0 ? { liveAction } : {})}
          color={color}
        />
      ) : null}
      {plan.showSummary ? (
        <Text {...(color ? { color: 'cyan' as const } : {})}>
          {summarizeTurn(state, elapsedSecs)}
        </Text>
      ) : null}
      <SpinnerStatusLine
        state={state}
        {...(elapsedSecs !== undefined ? { elapsedSecs } : {})}
        color={color}
      />
    </Box>
  );
}
