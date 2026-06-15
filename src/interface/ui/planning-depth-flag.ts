/**
 * Internal rollout gate for effort-governed preflight planning depth.
 * Default off: only an explicit env or config opt-in enables B2.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function planningDepthEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalPlanningDepth?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_PLANNING_DEPTH'];
    if (typeof raw === 'string') {
      const value = raw.trim().toLowerCase();
      if (OFF.has(value)) return false;
      if (ON.has(value)) return true;
    }
    return config?.experimentalPlanningDepth === true;
  } catch {
    return false;
  }
}
