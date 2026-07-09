/**
 * src/interface/ui/completion-result-flag.ts - the entrypoint source of truth for whether CompletionResultV1 is enabled.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the regular unit suite.
 * DEFAULT ON: this is part of the actualized Kern-like runtime surface. Users can
 * explicitly opt out with MYSHELL_COMPLETION_RESULT_V1 in {'0','false','off','no'}
 * (case-insensitive, trimmed) OR config.experimentalCompletionResultV1 === false.
 *
 * Explicit opt-in values remain accepted for compatibility with older configs and
 * scripts that used the former dark flag.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Decide whether CompletionResultV1 is enabled. DEFAULT TRUE. Env overrides config:
 * explicit env on -> true, explicit env off -> false; then config true/false;
 * absent/garbage -> true. Never throws.
 */
export function completionResultV1Enabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalCompletionResultV1?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_COMPLETION_RESULT_V1'];
    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (ON.has(normalized)) return true;
      if (OFF.has(normalized)) return false;
    }
    if (config?.experimentalCompletionResultV1 === true) return true;
    if (config?.experimentalCompletionResultV1 === false) return false;
    return true;
  } catch {
    return true;
  }
}
