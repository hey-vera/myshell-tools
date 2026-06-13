/**
 * src/interface/ui/board-flag.ts — the single source of truth for whether the
 * REAL PERSISTENT GOAL BOARD (the cross-turn projection of the persisted GoalStore
 * onto the live status region) is permitted to render, and — symmetrically —
 * whether the fake per-turn "GOALS ▸ <raw message>" card is suppressed.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT ON — the persistent board is the shipped
 * experience, and the caller opts OUT with `MYSHELL_BOARD` ∈ {'0','false','off','no'}
 * (case-insensitive, trimmed) or `config.experimentalBoard === false`.
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns
 * false, menu.ts never dispatches `board/sync`, so `UiState.boardEnabled` stays
 * false. With it false the reducer's `tier-start` keeps the existing
 * `title ?? tier` label (the fake card) and the layout/StatusBlock never plan or
 * paint the persistent board — the live status region is byte-for-byte today's.
 * When ON, menu.ts syncs the GoalStore snapshot in (flipping `boardEnabled` true),
 * which (a) suppresses the raw-message title on the per-turn card and reheads the
 * live region "WORKING", and (b) paints the real board across turns.
 */

/** Env values treated as an explicit opt-IN (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);
/** Env values treated as an explicit opt-OUT (case-insensitive) — restores legacy. */
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Decide whether the persistent Goal Board is enabled. DEFAULT TRUE (the real board
 * is the shipped experience). Returns false ONLY on an explicit opt-OUT:
 * `MYSHELL_BOARD` ∈ {'0','false','off','no'} (trimmed, case-insensitive) OR
 * `config.experimentalBoard === false` — which restores the byte-identical legacy
 * fake-card UI. Absent / any opt-in value → true. Never throws.
 */
export function boardEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalBoard?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_BOARD'];
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase();
      if (OFF.has(v)) return false;
      if (ON.has(v)) return true;
    }
    if (config?.experimentalBoard === false) return false;
    return true;
  } catch {
    return true;
  }
}
