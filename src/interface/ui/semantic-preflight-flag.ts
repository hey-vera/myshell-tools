/**
 * src/interface/ui/semantic-preflight-flag.ts - the single source of truth for
 * whether DARK SEMANTIC PREFLIGHT V1 owns the preflight/evidence path.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the regular unit suite.
 * DEFAULT OFF: the semantic path is unreachable unless the caller explicitly
 * opts in with MYSHELL_SEMANTIC_PREFLIGHT_V1 in {'1','true','on','yes'}
 * (case-insensitive, trimmed) OR config.experimentalSemanticPreflightV1 === true.
 *
 * THE OFF-GUARANTEE: when this returns false, entry points keep the legacy
 * route/intent closures and do not set OrchestrateDeps.semanticPreflightV1.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_SEMANTIC_PREFLIGHT_V1. */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether Semantic Preflight V1 is enabled. DEFAULT FALSE. Returns true
 * ONLY for explicit opt-in env/config true. Any other value, including absent,
 * '0', 'false', '', and garbage, returns false. Never throws.
 */
export function semanticPreflightV1Enabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalSemanticPreflightV1?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_SEMANTIC_PREFLIGHT_V1'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalSemanticPreflightV1 === true) return true;
  return false;
}
