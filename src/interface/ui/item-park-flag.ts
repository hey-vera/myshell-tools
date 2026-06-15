/**
 * src/interface/ui/item-park-flag.ts — the single source of truth for whether
 * PER-ITEM BLOCK/CONTINUE PARKING (Phase D, the manager-cycle fork→park change)
 * is active.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types. DEFAULT OFF — the one Phase-D change that touches CURRENTLY
 * SHIPPED behavior (today a worker fork stops the whole goal cycle) ships dark, so
 * the manager cycle is byte-for-byte unchanged unless the caller explicitly opts
 * IN: `MYSHELL_ITEM_PARK` ∈ {'1','true','on','yes'} (case-insensitive, trimmed)
 * OR `config.experimentalItemParking === true`. This mirrors scheduler-flag.ts
 * verbatim (opt-in, dark by default) — its own dark switch for an adversarial
 * pass before becoming a default.
 *
 * NB: enabling this flag ALSO requires the next-phase wiring (the manager cycle's
 * fork branch parking the item instead of breaking) — this flag answers "did the
 * user opt in?", not "is the cycle wired?". The wiring seam is the fork branch in
 * menu.ts (the `// NEXT PHASE:` D5 slice).
 */

/** Env values treated as an explicit opt-IN for MYSHELL_ITEM_PARK (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether per-item parking is enabled. DEFAULT FALSE. Returns true ONLY
 * when explicitly opted in: `MYSHELL_ITEM_PARK` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalItemParking === true`. Any
 * other value (including absent, '0', 'false', 'off', '') → false. Never throws.
 */
export function itemParkingEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalItemParking?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_ITEM_PARK'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalItemParking === true) return true;
  return false;
}
