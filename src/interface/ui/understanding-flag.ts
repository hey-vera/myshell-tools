/**
 * src/interface/ui/understanding-flag.ts — the single source of truth for whether
 * the WHOLE-PICTURE UNDERSTANDING PASS (elite-partner architecture Part 2) is
 * permitted to run.
 *
 * When ON, the planning brain gains DEEP understanding of the REAL system FIRST: a
 * manager-tier, read-only investigation maps the relevant modules + how they
 * interconnect, the conventions + hard constraints, and the genuinely-open
 * questions — and (for high-stakes work) researches current best practice — so the
 * resulting {@link SystemModel} GROUNDS the planner (its goals reflect whole-
 * picture depth, not a naive parts-list). When OFF, the understanding pass NEVER
 * runs, so the planner is invoked exactly as today (its prompt byte-for-byte
 * identical) and the post-turn slot is unchanged.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — understanding ships dark unless the caller
 * explicitly opts IN: `MYSHELL_UNDERSTANDING` ∈ {'1','true','on','yes'} (case-
 * insensitive, trimmed) OR `config.experimentalUnderstanding === true`. This
 * mirrors the rollout shape of the board/auto-goal/judgment/verify flags (opt-in,
 * dark).
 *
 * THE OFF-GUARANTEE (the neutrality contract): when this returns false, menu.ts
 * never builds or invokes the understanding pass and never threads a SystemModel
 * into the planner — the planner prompt is byte-for-byte today's.
 */

/** Env values treated as an explicit opt-IN (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);
/** Env values treated as an explicit opt-OUT (case-insensitive) — restores legacy. */
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Decide whether the whole-picture understanding pass is enabled. DEFAULT TRUE — now
 * that the pass runs CACHE-AHEAD (a non-blocking background warm grounds the NEXT
 * planning moment, adding ZERO turn latency; menu.ts), default-on delivers
 * whole-picture grounding for free. Returns false ONLY on an explicit opt-OUT:
 * `MYSHELL_UNDERSTANDING` ∈ {'0','false','off','no'} (trimmed, case-insensitive) OR
 * `config.experimentalUnderstanding === false`, which leaves the planner ungrounded
 * exactly as the legacy path. Absent / any opt-in value → true. Never throws.
 */
export function understandingEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalUnderstanding?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_UNDERSTANDING'];
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase();
      if (OFF.has(v)) return false;
      if (ON.has(v)) return true;
    }
    if (config?.experimentalUnderstanding === false) return false;
    return true;
  } catch {
    return true;
  }
}
