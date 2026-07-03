import React from 'react';
import { Box, Text, useInput } from 'ink';
import {
  buildControlPanelModel,
  nextControlPanelSection,
} from './index.js';
import { nextGoalId } from './goals-panel-model.js';
import type { ControlPanelSection, UiState } from './state.js';
import type {
  ControlPanelGoalDetail,
  ControlPanelGoalRow,
  ControlPanelGoalsModel,
  ControlPanelModel,
} from './control-panel-model.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function providerSummary(model: ControlPanelModel): string {
  if (model.providers.length === 0) return 'none';
  return model.providers
    .map((p) => `${p.provider}:${p.state}`)
    .join(', ');
}

function sectionLabel(section: ControlPanelSection): string {
  switch (section) {
    case 'status':
      return 'Status';
    case 'goals':
      return 'Goals';
    case 'settings':
      return 'Settings';
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '\u2026';
}

// ---------------------------------------------------------------------------
// planner result
// ---------------------------------------------------------------------------

interface VisibleSlice {
  readonly rows: readonly (ControlPanelGoalRow | { kind: 'overflow'; count: number })[];
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

/**
 * Window `items` through a scroll offset and available rows, returning
 * the visible slice plus overflow-indicator counts.
 */
function windowItems(
  items: readonly ControlPanelGoalRow[],
  scroll: number,
  availableRows: number,
): VisibleSlice {
  const total = items.length;
  if (total === 0 || availableRows <= 0) {
    return { rows: [], hiddenBefore: 0, hiddenAfter: total };
  }
  let start = Math.min(scroll, Math.max(0, total - availableRows));
  start = Math.max(0, start);
  let end = Math.min(total, start + availableRows);
  // If we have room left at the end, pull the window down to fill it
  if (end === total && start > 0) {
    start = Math.max(0, total - availableRows);
    end = total;
  }
  const hiddenBefore = start;
  const hiddenAfter = total - end;

  const visible: (ControlPanelGoalRow | { kind: 'overflow'; count: number })[] = [];
  if (hiddenBefore > 0) {
    visible.push({ kind: 'overflow', count: hiddenBefore });
  }
  for (let i = start; i < end; i += 1) {
    const item = items[i];
    if (item !== undefined) visible.push(item);
  }

  return { rows: visible, hiddenBefore, hiddenAfter };
}

// ---------------------------------------------------------------------------
// detail planner
// ---------------------------------------------------------------------------

interface DetailSlice {
  readonly lines: readonly string[];
  readonly hiddenBefore: number;
  readonly hiddenAfter: number;
}

/**
 * Build the rendered detail lines for one highlighted goal, bounded by
 * the scroll offset and availableRows.
 */
function windowDetail(
  detail: ControlPanelGoalDetail | undefined,
  scroll: number,
  availableRows: number,
): DetailSlice {
  if (detail === undefined || availableRows <= 0) {
    return { lines: [], hiddenBefore: 0, hiddenAfter: 0 };
  }

  const raw: string[] = [];
  const stateStr = detail.state;
  const scopeStr = detail.scope;
  const doneStr = `${detail.done}/${detail.total} to-dos`;
  const agentStr = detail.agents > 0 ? `${detail.agents} agents` : '';
  const headerLine = [
    detail.title,
    stateStr,
    doneStr,
    scopeStr,
    agentStr,
  ]
    .filter(Boolean)
    .join('  ');
  raw.push(headerLine);

  if (detail.verdict !== undefined) {
    raw.push(`  verdict: ${detail.verdict}`);
  }
  if (detail.approach !== undefined && detail.approach.chosen) {
    const summary = detail.approach.rationale
      ? `${detail.approach.chosen} — ${detail.approach.rationale}`
      : detail.approach.chosen;
    raw.push(`  approach: ${truncate(summary, 60)}`);
  }

  if (detail.todos.length > 0) {
    raw.push('  To-dos:');
    for (const todo of detail.todos) {
      const glyph = todo.status === 'done' ? '\u2713' : '\u25CB';
      raw.push(`    ${glyph} ${truncate(todo.text, 50)}  ${todo.status}`);
    }
    if (detail.todoOverflow > 0) {
      raw.push(`    \u2026 ${detail.todoOverflow} more to-dos not synced`);
    }
  } else {
    raw.push('  (no to-dos)');
  }

  const total = raw.length;
  let start = Math.min(scroll, Math.max(0, total - availableRows));
  start = Math.max(0, start);
  let end = Math.min(total, start + availableRows);
  if (end === total && start > 0) {
    start = Math.max(0, total - availableRows);
    end = total;
  }
  const hiddenBefore = start;
  const hiddenAfter = total - end;
  return {
    lines: raw.slice(start, end),
    hiddenBefore,
    hiddenAfter,
  };
}

// ---------------------------------------------------------------------------
// props
// ---------------------------------------------------------------------------

export interface ControlPanelProps {
  readonly state: UiState;
  readonly rows?: number;
  readonly columns?: number;
  readonly onSetSection: (section: ControlPanelSection) => void;
  readonly onHighlightGoal: (goalId: string) => void;
  readonly onScroll: (section: ControlPanelSection, target: 'list' | 'detail' | undefined, delta: number) => void;
  readonly onClose: () => void;
  readonly active?: boolean;
}

// ---------------------------------------------------------------------------
// main component
// ---------------------------------------------------------------------------

export function ControlPanel(props: ControlPanelProps): React.ReactElement {
  const {
    state,
    rows: liveRows = 24,
    columns: liveColumns = 80,
    onSetSection,
    onHighlightGoal,
    onScroll,
    onClose,
    active,
  } = props;

  const model = buildControlPanelModel(state);

  // Fixed chrome rows needed outside the tab content:
  // title (1), summary (1), tabs (1), footer (1) = 4.
  // If height is very small, drop the summary row.
  const fixedRows = liveRows < 6 ? 3 : 4;
  const contentRows = Math.max(1, liveRows - fixedRows);
  const pageDelta = Math.max(1, contentRows - 1);
  const wideLayout = liveColumns >= 96;

  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'g')) {
        onClose();
        return;
      }
      if (key.tab) {
        onSetSection(
          nextControlPanelSection(
            model.activeSection,
            key.shift ? 'backward' : 'forward',
          ),
        );
        return;
      }
      if (model.activeSection === 'goals') {
        if (key.upArrow || input === 'k') {
          const id = nextGoalId({
            goalIds: model.controlGoals.goalIds,
            currentGoalId: model.controlGoals.highlightedGoalId,
            direction: 'up',
          });
          if (id !== undefined) onHighlightGoal(id);
          return;
        }
        if (key.downArrow || input === 'j') {
          const id = nextGoalId({
            goalIds: model.controlGoals.goalIds,
            currentGoalId: model.controlGoals.highlightedGoalId,
            direction: 'down',
          });
          if (id !== undefined) onHighlightGoal(id);
          return;
        }
        if (key.pageUp || input === 'u') {
          onScroll('goals', 'list', -pageDelta);
          return;
        }
        if (key.pageDown || input === 'd') {
          onScroll('goals', 'list', pageDelta);
          return;
        }
      }
      if (key.pageUp) {
        onScroll(model.activeSection, undefined, -pageDelta);
        return;
      }
      if (key.pageDown) {
        onScroll(model.activeSection, undefined, pageDelta);
        return;
      }
    },
    { isActive: active !== false },
  );

  const showSummary = liveRows >= 6;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>CONTROL PANEL</Text>
      </Box>
      {showSummary ? (
        <Box>
          <Text dimColor>
            {model.activeGoalCount} active goals · mode: execution/{model.executionPhase} · providers: {providerSummary(model)} · quota: {model.quotaLabel}
          </Text>
        </Box>
      ) : null}

      <Box>
        <Text>{'  '}</Text>
        {(['status', 'goals', 'settings'] as const).map((s) =>
          s === model.activeSection ? (
            <Text key={s} inverse>
              {' '}{sectionLabel(s)}{' '}
            </Text>
          ) : (
            <Text key={s}>{' '}{sectionLabel(s)}{' '}</Text>
          ),
        )}
      </Box>

      {model.activeSection === 'status' ? (
        <ControlPanelStatus
          model={model}
          scroll={state.controlPanel.statusScroll}
          availableRows={contentRows}
        />
      ) : model.activeSection === 'goals' ? (
        <GoalsTab
          model={model.controlGoals}
          scroll={state.controlPanel.goalsListScroll}
          detailScroll={state.controlPanel.goalsDetailScroll}
          availableRows={contentRows}
          columns={liveColumns}
          wide={wideLayout}
        />
      ) : (
        <ControlPanelSettings
          model={model}
          scroll={state.controlPanel.settingsScroll}
          availableRows={contentRows}
        />
      )}

      <Text dimColor>
        Tab/Shift+Tab navigate sections · ↑↓/jk select goal · PgUp/PgDn scroll · Esc close
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Goals tab
// ---------------------------------------------------------------------------

interface GoalsTabProps {
  readonly model: ControlPanelGoalsModel;
  readonly scroll: number;
  readonly detailScroll: number;
  readonly availableRows: number;
  readonly columns: number;
  readonly wide: boolean;
}

function GoalsTab(props: GoalsTabProps): React.ReactElement {
  const { model, scroll, detailScroll, availableRows, columns, wide } = props;

  if (model.rows.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No goals yet</Text>
      </Box>
    );
  }

  if (wide) {
    const listWidth = Math.min(42, Math.floor(columns * 0.42));
    const detailWidth = columns - listWidth - 1;
    const slice = windowItems(model.rows, scroll, availableRows);
    const detail = windowDetail(model.detail, detailScroll, availableRows);

    return (
      <Box flexDirection="row" height={Math.min(availableRows, Math.max(slice.rows.length + (slice.hiddenAfter > 0 ? 1 : 0) + (slice.hiddenBefore > 0 ? 1 : 0), 1))}>
        <Box width={listWidth} flexDirection="column">
          {slice.rows.map((row, i) =>
            'kind' in row ? (
              <Text key={`ovf-${i}`} dimColor>{'\u2026'} {row.count} above</Text>
            ) : (
              <Text
                key={row.id}
                bold={row.selected}
                inverse={row.selected}
              >
                {truncate(`${row.glyph} ${row.title}`, listWidth - 4)}  {row.state}
              </Text>
            ),
          )}
          {slice.hiddenAfter > 0 ? (
            <Text dimColor>{'\u2026'} {slice.hiddenAfter} more</Text>
          ) : null}
        </Box>
        <Box width={detailWidth} flexDirection="column" marginLeft={1}>
          {model.detail === undefined ? (
            <Text dimColor>Select a goal to see details</Text>
          ) : (
            <>
              {detail.hiddenBefore > 0 ? (
                <Text dimColor>{'\u2026'} {detail.hiddenBefore} lines above</Text>
              ) : null}
              {detail.lines.map((line, i) => (
                <Text key={i}>{truncate(line, detailWidth - 2)}</Text>
              ))}
              {detail.hiddenAfter > 0 ? (
                <Text dimColor>{'\u2026'} {detail.hiddenAfter} more</Text>
              ) : null}
            </>
          )}
        </Box>
      </Box>
    );
  }

  // Narrow layout: stacked — goal list on top, detail below
  const minListRows = Math.min(3, availableRows);
  const listAvailable = Math.max(
    minListRows,
    availableRows <= 5 ? 1 : Math.floor(availableRows * 0.4),
  );
  const detailAvailable = availableRows - listAvailable;

  const slice = windowItems(model.rows, scroll, listAvailable);
  const detail = windowDetail(model.detail, detailScroll, detailAvailable);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {slice.rows.map((row, i) =>
          'kind' in row ? (
            <Text key={`ovf-${i}`} dimColor>{'\u2026'} {row.count} above</Text>
          ) : (
            <Text
              key={row.id}
              bold={row.selected}
              inverse={row.selected}
            >
              {truncate(`${row.glyph} ${row.title}`, columns - 6)}  {row.state}
            </Text>
          ),
        )}
        {slice.hiddenAfter > 0 ? (
          <Text dimColor>{'\u2026'} {slice.hiddenAfter} more</Text>
        ) : null}
      </Box>
      {model.detail !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          {detail.hiddenBefore > 0 ? (
            <Text dimColor>{'\u2026'} {detail.hiddenBefore} lines above</Text>
          ) : null}
          {detail.lines.map((line, i) => (
            <Text key={i}>{truncate(line, columns - 4)}</Text>
          ))}
          {detail.hiddenAfter > 0 ? (
            <Text dimColor>{'\u2026'} {detail.hiddenAfter} more</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Status tab
// ---------------------------------------------------------------------------

function ControlPanelStatus(
  { model, scroll, availableRows }:
  { readonly model: ControlPanelModel; readonly scroll: number; readonly availableRows: number },
): React.ReactElement {
  const lines: string[] = [];
  lines.push('Active goals (running): ' + model.activeGoalCount);
  lines.push(
    'Mode: execution/' +
      model.executionPhase +
      (model.turnActive ? ' (turn active)' : ''),
  );
  lines.push('Provider health (observed)');
  if (model.providers.length === 0) {
    lines.push('  No provider observations');
  } else {
    for (const p of model.providers) {
      lines.push(`  ${p.provider}: ${p.state}`);
    }
  }
  lines.push('Quota: ' + model.quotaLabel);

  const total = lines.length;
  let start = Math.min(scroll, Math.max(0, total - availableRows));
  start = Math.max(0, start);
  let end = Math.min(total, start + availableRows);
  if (end === total && start > 0) {
    start = Math.max(0, total - availableRows);
    end = total;
  }
  const hiddenBefore = start;
  const hiddenAfter = total - end;

  return (
    <Box flexDirection="column">
      {hiddenBefore > 0 ? (
        <Text dimColor>{'\u2026'} {hiddenBefore} lines above</Text>
      ) : null}
      {lines.slice(start, end).map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {hiddenAfter > 0 ? (
        <Text dimColor>{'\u2026'} {hiddenAfter} more</Text>
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

function ControlPanelSettings(
  { model, scroll, availableRows }:
  { readonly model: ControlPanelModel; readonly scroll: number; readonly availableRows: number },
): React.ReactElement {
  const lines: string[] = [];
  for (const row of model.settings) {
    lines.push(
      `${row.label}: ${row.enabled ? 'enabled' : 'disabled'}` +
        (row.note !== undefined ? ` (${row.note})` : ''),
    );
  }
  lines.push('Settings are read-only in this release');

  const total = lines.length;
  let start = Math.min(scroll, Math.max(0, total - availableRows));
  start = Math.max(0, start);
  let end = Math.min(total, start + availableRows);
  if (end === total && start > 0) {
    start = Math.max(0, total - availableRows);
    end = total;
  }
  const hiddenBefore = start;
  const hiddenAfter = total - end;

  return (
    <Box flexDirection="column">
      {hiddenBefore > 0 ? (
        <Text dimColor>{'\u2026'} {hiddenBefore} lines above</Text>
      ) : null}
      {lines.slice(start, end).map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {hiddenAfter > 0 ? (
        <Text dimColor>{'\u2026'} {hiddenAfter} more</Text>
      ) : null}
    </Box>
  );
}
