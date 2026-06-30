import type { UiState } from './state.ts';

// ---------------------------------------------------------------------------
// Row & model shapes
// ---------------------------------------------------------------------------

export interface GoalsPanelRow {
  readonly kind: 'goal' | 'todo';
  readonly id: string;
  readonly goalId: string;
  readonly depth: 0 | 1;
  readonly title: string;
  readonly statusLabel: string;
  readonly active?: boolean;
  readonly todoSummary?: string;
}

export interface GoalsPanelModel {
  readonly rows: readonly GoalsPanelRow[];
  readonly goalIds: readonly string[];
  readonly highlightedGoalId?: string;
}

// ---------------------------------------------------------------------------
// core builder
// ---------------------------------------------------------------------------

export function buildGoalsPanelModel(args: {
  board: UiState['board'];
  highlightedGoalId?: string;
}): GoalsPanelModel {
  const { board, highlightedGoalId } = args;
  const goalIds: readonly string[] = board.map((r) => r.id);

  let effectiveHighlight: string | undefined;
  if (highlightedGoalId !== undefined && goalIds.includes(highlightedGoalId)) {
    effectiveHighlight = highlightedGoalId;
  } else if (goalIds.length > 0) {
    effectiveHighlight = goalIds[0];
  }

  const rows: GoalsPanelRow[] = [];
  for (const row of board) {
    const goalRow: GoalsPanelRow = {
      kind: 'goal',
      id: row.id,
      goalId: row.id,
      depth: 0,
      title: row.title,
      statusLabel: row.state,
      active: row.state === 'running',
      todoSummary: row.done + '/' + row.total + ' to-dos',
    };
    rows.push(goalRow);

    if (row.id === effectiveHighlight && row.todos) {
      for (const todo of row.todos) {
        rows.push({
          kind: 'todo',
          id: todo.id,
          goalId: row.id,
          depth: 1,
          title: todo.text,
          statusLabel: todo.status,
        });
      }
    }
  }

  return {
    rows,
    goalIds,
    ...(effectiveHighlight !== undefined ? { highlightedGoalId: effectiveHighlight } : {}),
  };
}

// ---------------------------------------------------------------------------
// keyboard navigation helper
// ---------------------------------------------------------------------------

export function nextGoalId(args: {
  goalIds: readonly string[];
  currentGoalId: string | undefined;
  direction: 'up' | 'down';
}): string | undefined {
  const { goalIds, currentGoalId, direction } = args;
  const n = goalIds.length;
  if (n === 0) return undefined;

  if (currentGoalId === undefined) {
    return direction === 'down' ? goalIds[0] : goalIds[n - 1];
  }

  const idx = goalIds.indexOf(currentGoalId);
  if (idx === -1) {
    return direction === 'down' ? goalIds[0] : goalIds[n - 1];
  }

  const nextIdx = direction === 'down' ? (idx + 1) % n : (idx - 1 + n) % n;
  return goalIds[nextIdx];
}
