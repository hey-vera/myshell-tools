/**
 * src/interface/ui/experimental-default.ts — the composition-root resolver that makes
 * myshell-tools' full intelligence ON BY DEFAULT at the CLI entry point, so the tool is
 * automatic and frictionless with NO env-var flipping.
 *
 * This is the inverse of the pure per-feature flag helpers (governor-flag.ts,
 * verify-flag.ts, taste-flag.ts, judgment-flag.ts, trust-flag.ts, tribunal-flag.ts):
 * those return true ONLY on explicit opt-IN (default false) and are kept intact —
 * they remain the single source of truth exercised by the unit tests + the flag-off
 * neutrality suites (the off-path = today's behavior). This module flips the SOURCE of
 * the boolean used at the wiring sites in menu.ts so that the six intelligence
 * subsystems default ON, while the deps-spread shape (`...(resolved ? {...} : {})`) is
 * unchanged.
 *
 * DEFAULT ON. `experimentalEnabledByDefault` COMPOSES the subsystem's own pure opt-IN
 * helper (governorEnabled/verifyEnabled/…) with the global basic-mode switch, so the
 * helpers stay genuinely production-used (no src-graph orphan). An explicit per-feature
 * opt-IN (env value ∈ {'1','true','on','yes'} OR config value === true) wins outright —
 * even over basic mode. Otherwise it returns FALSE when EXPLICITLY disabled — its env
 * value ∈ {'0','false','off','no'} (trimmed, case-insensitive), OR its config value ===
 * false, OR the global basic-mode escape hatch is set (`MYSHELL_BASIC` ∈
 * {'1','true','on','yes'} OR `config.experimentalBasic === true`). Otherwise it returns
 * TRUE. Never throws (try/catch → true, since the default is on).
 *
 * THE NEUTRALITY CONTRACT IS PRESERVED: the pure helpers still return false by default,
 * so the characterization + oracle suites (which build deps with flags explicitly off)
 * are byte-for-byte unchanged. Their off-path is now the global escape hatch (basic
 * mode / explicit-off) rather than the silent default.
 */

/** Env values treated as an explicit opt-OUT for a per-feature key (case-insensitive). */
const OFF = new Set(['0', 'false', 'off', 'no']);

/** Env values treated as an explicit opt-IN for the global MYSHELL_BASIC switch. */
const BASIC_ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * The global "plain mode" escape hatch. When set, ALL six intelligence subsystems
 * resolve to false regardless of their per-feature env/config. Set by
 * `MYSHELL_BASIC` ∈ {'1','true','on','yes'} (trimmed, case-insensitive) OR
 * `config.experimentalBasic === true`. Never throws.
 */
export function basicModeEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalBasic?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_BASIC'];
    if (typeof raw === 'string' && BASIC_ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalBasic === true) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * The pure per-feature opt-IN predicate (governorEnabled/verifyEnabled/… shape):
 * returns true ONLY on an explicit opt-IN (env value ∈ {'1','true','on','yes'} OR
 * `config.experimentalX === true`), default FALSE. The resolver CONSUMES this so the
 * helpers stay genuinely production-used (no src-graph orphan) AND an explicit opt-IN
 * outranks the global basic-mode switch.
 */
type OptInHelper = (
  env: NodeJS.ProcessEnv | undefined,
  config: Record<string, boolean | undefined> | undefined,
) => boolean;

/**
 * Decide whether an intelligence subsystem is enabled, DEFAULT ON, by COMPOSING the
 * subsystem's own pure opt-IN helper with the global basic-mode switch. Truth table
 * (highest priority first):
 *
 *   1. explicit per-feature opt-IN  (optInHelper ⇒ true) → TRUE — even in basic mode
 *   2. global basic / plain mode set                     → FALSE
 *   3. explicit per-feature opt-OUT  (env ∈ '0'/'false'/'off'/'no' OR configValue===false)
 *                                                        → FALSE
 *   4. nothing set (absent)                              → TRUE (frictionless default)
 *
 * Pure + never throws (try/catch → true, since the default is on).
 *
 * @param env         the process environment (read-only)
 * @param config      the resolved config (basic-mode hatch + per-feature opt-IN)
 * @param envKey      the per-feature env var name, e.g. 'MYSHELL_GOVERNOR'
 * @param configValue the per-feature config value, e.g. `config.experimentalGovernor`
 * @param optInHelper the subsystem's pure opt-IN predicate, e.g. `governorEnabled`
 */
export function experimentalEnabledByDefault(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalBasic?: boolean } | undefined,
  envKey: string,
  configValue: boolean | undefined,
  optInHelper: OptInHelper,
): boolean {
  try {
    // 1. Explicit per-feature opt-IN wins outright — even over global basic mode.
    if (optInHelper(env, config as Record<string, boolean | undefined> | undefined)) {
      return true;
    }
    // 2. Global escape hatch: basic/plain mode disables everything not opted-in.
    if (basicModeEnabled(env, config)) return false;
    // 3. Explicit per-feature opt-OUT via env.
    const raw = env?.[envKey];
    if (typeof raw === 'string' && OFF.has(raw.trim().toLowerCase())) return false;
    // 3. Explicit per-feature opt-OUT via config.
    if (configValue === false) return false;
    // 4. Default: ON.
    return true;
  } catch {
    return true;
  }
}
