/**
 * src/interface/ui/board-flag.ts — the single source of truth for whether the
 * REAL PERSISTENT GOAL BOARD (the cross-turn projection of the persisted GoalStore
 * onto the live status region) is permitted to render, and — symmetrically —
 * whether the fake per-turn "GOALS ▸ <raw message>" card is suppressed.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — the board ships dark and the UI is
 * byte-for-byte identical to today (the fake per-turn card and all) unless the
 * caller explicitly opts IN: `MYSHELL_BOARD` ∈ {'1','true','on','yes'}
 * (case-insensitive, trimmed) OR `config.experimentalBoard === true`. This mirrors
 * the rollout shape of the tribunal/judgment/verify/scheduler flags (opt-in, dark).
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

/** Env values treated as an explicit opt-IN for MYSHELL_BOARD (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the persistent Goal Board is enabled. DEFAULT FALSE. Returns true
 * ONLY when explicitly opted in: `MYSHELL_BOARD` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalBoard === true`. Any other
 * value (including absent, '0', 'false', '') → false. Never throws.
 */
export function boardEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalBoard?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_BOARD'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalBoard === true) return true;
    return false;
  } catch {
    return false;
  }
}
