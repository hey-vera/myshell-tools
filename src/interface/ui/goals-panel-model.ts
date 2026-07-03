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
