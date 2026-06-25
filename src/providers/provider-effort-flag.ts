/**
 * src/providers/provider-effort-flag.ts — the single source of truth for whether
 * the Claude and Grok provider adapters thread the normalized `reasoningEffort`
 * field from ProviderRequest onto their respective CLI flags (`--effort`).
 *
 * Pure (no I/O, no Date, no Math.random) so it is exercised by the REGULAR
 * `npm test` suite under strip-types.
 *
 * DEFAULT OFF — this is a live behavior change for any user who already relies on
 * Claude/Grok effort being *absent* from the CLI invocation. Default-off is
 * mandatory until the behavior is validated in production.
 *
 * Opt-IN truth table:
 *   `MYSHELL_PROVIDER_EFFORT` ∈ {'1','true','on','yes'} (trimmed, case-insensitive)
 *   OR `config.experimentalProviderEffort === true`
 * → both adapters thread `--effort <level>` when `req.reasoningEffort` is set and
 *   is not `'none'`.
 *
 * Opt-OUT (default): any other value, including absent → the adapters emit
 * ZERO `--effort` flag on their argv, byte-for-byte unchanged from before the
 * wiring was added.
 *
 * THE OFF-GUARANTEE: when this returns false, `buildClaudeArgs` and `buildGrokArgs`
 * skip the `--effort` block entirely — the argv they produce is byte-for-byte
 * identical to the pre-wiring baseline. The `claude-args` and `grok-args` test
 * suites include an off-by-default assertion that mechanically verifies this.
 *
 * Enable instructions:
 *   env:    MYSHELL_PROVIDER_EFFORT=1
 *   config: { "experimentalProviderEffort": true }  in ~/.myshell-tools/config.json
 */

/** Env values treated as an explicit opt-IN (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Returns true ONLY when the caller explicitly opts in via:
 *   - `MYSHELL_PROVIDER_EFFORT` ∈ {'1','true','on','yes'} (trimmed, case-insensitive), OR
 *   - `config.experimentalProviderEffort === true`.
 * Any other value (including absent, '0', 'false', '') → false. Never throws.
 */
export function providerEffortEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalProviderEffort?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_PROVIDER_EFFORT'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalProviderEffort === true) return true;
  return false;
}
