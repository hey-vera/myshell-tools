import React from 'react';
import { Box, Text } from 'ink';
import { dim } from '../../ui/theme.js';
import { truncateToWidth } from '../../ui/tui.js';
import type { GoalQuickRow } from './layout.js';
import { GOAL_STRIP_MAX_GOALS } from './layout.js';

export interface GoalQuickStripProps {
  readonly rows: readonly GoalQuickRow[];
  readonly color: boolean;
  readonly columns?: number | undefined;
}

function formatProgress(row: GoalQuickRow): string {
  if (row.total === 0) return '';
  return `${row.done}/${row.total}`;
}

function formatStateLabel(state: GoalQuickRow['state']): string {
  return state;
}

function formatAgents(agents: number): string {
  if (agents <= 0) return '';
  return `${agents} worker${agents === 1 ? '' : 's'}`;
}

/**
 * Render ONE compact goal row for the inline strip:
 * `{glyph} {truncated title}  {done}/{total} · {state} · {N workers}`
 */
function GoalQuickStripRow({ row, color, maxTitle }: {
  readonly row: GoalQuickRow;
  readonly color: boolean;
  readonly maxTitle: number;
}): React.ReactElement {
  const progress = formatProgress(row);
  const agents = formatAgents(row.agents);
  const stateLabel = formatStateLabel(row.state);

  const title = truncateToWidth(row.title, maxTitle);

  const parts: string[] = [row.glyph, title, progress];

  if (agents) parts.push(agents);
  parts.push(stateLabel);

  const text = parts.filter(Boolean).join('  ');
  return (
    <Box>
      <Text>{dim(text, color)}</Text>
    </Box>
  );
}

/**
 * Inline goals strip rendered IMMEDIATELY ABOVE the chat composer. A compact
 * one-line-per-goal live glance (NOT the fullscreen GoalsPanel). Shows both
 * active and inactive goals with quick-view stats: status glyph, title (truncated
 * to width), progress indicator (done/total), agent count, and state label.
 *
 * Height is BOUNDED: at most {@link GOAL_STRIP_MAX_GOALS} goal rows + a header
 * line + an optional `+N more` overflow line, so a large board can never blow the
 * viewport.
 */
export function GoalQuickStrip({ rows, color, columns = 80 }: GoalQuickStripProps): React.ReactElement | null {
  if (rows.length === 0) return null;

  const active = rows.filter(
    (r) => r.state === 'running' || r.state === 'queued',
  ).length;
  const header = `goals  ${rows.length} total · ${active} active`;

  const shown = rows.slice(0, GOAL_STRIP_MAX_GOALS);
  const overflow = rows.length - shown.length;

  // Title width: fit within columns minus glyph(2) + progress(" N/M") (~6) + state(~10) + padding.
  // Rough: columns - glyph(2) - spacer(2) - progress(6) - spacer(2) - agents(10) - state(10) = columns - 32
  const maxTitle = Math.max(4, Math.floor(columns) - 32);

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{dim(header, color)}</Text>
      </Box>
      {shown.map((row) => (
        <GoalQuickStripRow key={row.id} row={row} color={color} maxTitle={maxTitle} />
      ))}
      {overflow > 0 && (
        <Box>
          <Text>{dim(`+${overflow} more`, color)}</Text>
        </Box>
      )}
    </Box>
  );
}
