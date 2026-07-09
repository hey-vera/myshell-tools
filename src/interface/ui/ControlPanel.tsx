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
  ControlPanelSettingRow,
} from './control-panel-model.js';

// ---------------------------------------------------------------------------
// Focus model (PANEL-NAV-SPEC / P0.10)
// ---------------------------------------------------------------------------
//
// Single active `useInput` owner per route — terminals have no rich focus:
//
// - **Chat route:** InputBox owns keys. Empty-buffer bare Right / Ctrl+G open
//   this panel; empty-buffer bare Left returns to the main menu. Non-empty
//   buffer keeps Left/Right as cursor movement.
// - **Control Panel route (this component):** App sets InputBox `active=false`
//   and `visible=false` so the composer is not a competing listener and cannot
//   trap keys. This panel's `useInput` is the sole owner while `active`.
// - **Always escapable:** Esc, Left, and Ctrl+G call `onClose` → chat. The
//   chrome footer always shows Esc (and Left) so the panel is never a black hole.
// - **Suspended TTY handoff:** when App passes `active={false}` (inherited child
//   owns the TTY), all keys are inert here — same contract as InputBox.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Clustered panel key legend — must stay ≤1 terminal row (footer is reserved chrome). */
const FULL_PANEL_FOOTER =
  '\u2190 chat  \u00b7  Tab sections  \u00b7  \u2191\u2193 select  \u00b7  Enter goal  \u00b7  Esc close';
/** Narrow terminals keep close + section-switch only (never bury Esc). */
const NARROW_PANEL_FOOTER = '\u2190 chat  \u00b7  Tab  \u00b7  Esc close';
/** Columns below this threshold drop select/goal hints. */
const NARROW_PANEL_COLUMNS = 60;

/**
 * Pure footer text for the Control Panel chrome.
 * Always includes Esc close so discoverability does not depend on reading source.
 */
export function buildControlPanelFooterText(columns: number): string {
  return columns < NARROW_PANEL_COLUMNS ? NARROW_PANEL_FOOTER : FULL_PANEL_FOOTER;
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

function getSelectedSettingRow(
  rows: readonly ControlPanelSettingRow[],
  index: number,
): ControlPanelSettingRow | undefined {
  const interactive = rows.filter((r) => r.kind !== 'readonly');
  if (index < 0 || index >= interactive.length) return undefined;
  return interactive[index];
}

function nextSegmentedValue(
  row: { readonly kind: 'segmented'; readonly options: readonly { readonly value: string; readonly active: boolean }[] },
): string | undefined {
  const idx = row.options.findIndex((o) => o.active);
  if (idx < 0) return row.options[0]?.value;
  const next = (idx + 1) % row.options.length;
  return row.options[next]?.value;
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

export interface ControlPanelSettingIntent {
  readonly key: string;
  readonly value?: string | boolean;
}

export interface ControlPanelProps {
  readonly state: UiState;
  readonly rows?: number;
  readonly columns?: number;
  readonly onSetSection: (section: ControlPanelSection) => void;
  readonly onHighlightGoal: (goalId: string) => void;
  readonly onScroll: (section: ControlPanelSection, target: 'list' | 'detail' | undefined, delta: number) => void;
  readonly onClose: () => void;
  readonly onSettingAction?: (intent: ControlPanelSettingIntent) => void;
  readonly onSettingsSelect?: (index: number) => void;
  /** Close the panel and insert \@goal:&lt;id&gt; into the chat composer. */
  readonly onComposeGoal?: (goalId: string) => void;
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
    onSettingAction,
    onSettingsSelect,
    onComposeGoal,
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
      // Always-escapable: Esc, Left (back to chat), Ctrl+G alias.
      // Order before Tab/section keys so close never competes with navigation.
      if (key.escape || key.leftArrow || (key.ctrl && input === 'g')) {
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
        if ((key.return || input === 'c') && onComposeGoal !== undefined) {
          const id = model.controlGoals.highlightedGoalId;
          if (id !== undefined) onComposeGoal(id);
          return;
        }
      }
      if (model.activeSection === 'settings' && onSettingAction !== undefined) {
        const interactiveCount = model.settings.filter((r) => r.kind !== 'readonly').length;
        if (key.upArrow || input === 'k') {
          if (interactiveCount > 0) {
            const cur = state.controlPanel.settingsSelectedIndex;
            const next = cur <= 0 ? interactiveCount - 1 : cur - 1;
            onSettingsSelect?.(next);
          }
          return;
        }
        if (key.downArrow || input === 'j') {
          if (interactiveCount > 0) {
            const cur = state.controlPanel.settingsSelectedIndex;
            const next = cur >= interactiveCount - 1 ? 0 : cur + 1;
            onSettingsSelect?.(next);
          }
          return;
        }
        if (key.return) {
          const row = getSelectedSettingRow(model.settings, state.controlPanel.settingsSelectedIndex);
          if (row !== undefined) {
            if (row.kind === 'segmented') {
              const nextOpt = nextSegmentedValue(row);
              if (nextOpt !== undefined) {
                onSettingAction({ key: row.id, value: nextOpt });
              }
            } else if (row.kind === 'toggle') {
              onSettingAction({ key: row.id, value: !row.value });
            } else if (row.kind === 'action') {
              onSettingAction({ key: row.id, value: !row.value });
            }
          }
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
            {model.summaryLine}
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
          selectedIndex={state.controlPanel.settingsSelectedIndex}
        />
      )}

      {/* Always-visible chrome footer (reserved in fixedRows) — never buried in content. */}
      <Text dimColor>{buildControlPanelFooterText(liveColumns)}</Text>
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
  // Phase 4C: build display lines from structured status rows
  const lines: string[] = [];
  let lastHeading = '';
  for (const row of model.statusRows) {
    if (row.kind === 'heading') {
      if (row.text !== lastHeading) {
        lines.push(row.text);
        lastHeading = row.text;
      }
    } else {
      lines.push(row.text);
    }
  }

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
  { readonly model: ControlPanelModel; readonly scroll: number; readonly availableRows: number; readonly selectedIndex: number },
): React.ReactElement {
  const lines: string[] = [];

  for (const row of model.settings) {
    if (row.kind === 'segmented') {
      const options = row.options.map((o) => o.active ? `[${o.label}]` : ` ${o.label} `).join('');
      const marker = row.selected ? '\u25B8 ' : '  ';
      lines.push(`${marker}${row.label}: ${options}`);
      if (row.note !== undefined) {
        lines.push(`  (${row.note})`);
      }
    } else if (row.kind === 'toggle' || row.kind === 'action') {
      const marker = row.selected ? '\u25B8 ' : '  ';
      const note = row.note !== undefined ? ` (${row.note})` : '';
      lines.push(`${marker}${row.label}: ${row.value ? 'on' : 'off'}${note}`);
    } else {
      // readonly
      lines.push(`  ${row.label}: ${row.value}`);
    }
  }

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
