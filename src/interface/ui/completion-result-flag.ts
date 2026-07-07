/**
 * src/interface/ui/completion-result-flag.ts - the single source of truth for
 * whether DARK CompletionResultV1 is attached to terminal foreground turns.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the regular unit suite.
 * DEFAULT OFF: the completion-result path is unreachable unless the caller
 * explicitly opts in with MYSHELL_COMPLETION_RESULT_V1 in {'1','true','on','yes'}
 * (case-insensitive, trimmed) OR config.experimentalCompletionResultV1 === true.
 *
 * THE OFF-GUARANTEE: when this returns false, entry points do not set
 * OrchestrateDeps.completionResultV1, so accept-stage returns the legacy final
 * shape with no completionResult key.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_COMPLETION_RESULT_V1. */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether CompletionResultV1 is enabled. DEFAULT FALSE. Returns true
 * ONLY for explicit opt-in env/config true. Any other value, including absent,
 * '0', 'false', '', and garbage, returns false. Never throws.
 */
export function completionResultV1Enabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalCompletionResultV1?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_COMPLETION_RESULT_V1'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalCompletionResultV1 === true) return true;
  return false;
}