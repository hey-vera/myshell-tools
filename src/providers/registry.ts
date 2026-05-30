/**
 * src/providers/registry.ts — provider registry for the CLI.
 *
 * Builds the Partial<Record<ProviderId, Provider>> map consumed by
 * OrchestrateDeps. Each provider registers when `installed` is true — we gate
 * on `installed`, NOT `authenticated`, because auth is only truly known at
 * call time and errors render honestly via classifyError().
 *
 * With both Claude and Codex installed, `deps.providers` will have entries for
 * both — which automatically activates cross-vendor review in the orchestrator.
 */

import type { Provider, ProviderId } from './port.js';
import { detectEnvironment } from './detect.js';
import { createClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';

/**
 * Discover which providers are available in the current environment and build
 * the provider map for OrchestrateDeps.
 *
 * @param _cwd - Working directory (used by real adapters to locate project-
 *               level config; may be forwarded to adapters in a future phase).
 * @returns     A (possibly empty) map of available providers.
 */
export async function buildProviders(
  _cwd: string,
): Promise<Partial<Record<ProviderId, Provider>>> {
  const env = await detectEnvironment();
  const providers: Partial<Record<ProviderId, Provider>> = {};

  if (env.claude.installed) {
    providers.claude = createClaudeProvider();
  }

  if (env.codex.installed) {
    providers.codex = createCodexProvider();
  }

  return providers;
}
