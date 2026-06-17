/**
 * src/providers/registry.ts — provider registry for the CLI.
 *
 * Builds the Partial<Record<ProviderId, Provider>> map consumed by
 * OrchestrateDeps. Each provider registers when `installed` is true — we gate
 * on `installed`, NOT `authenticated`, because auth is only truly known at
 * call time and errors render honestly via classifyError().
 *
 * With multiple providers installed, `deps.providers` will have entries for
 * each — which automatically activates cross-vendor review in the orchestrator.
 */

import type { Provider, ProviderId } from './port.js';
import type { EnvironmentStatus } from './detect.js';
import { createClaudeProvider } from './claude.js';
import { createCodexProvider } from './codex.js';
import { createOpencodeProvider } from './opencode.js';
import { createGrokProvider } from './grok.js';

/**
 * Build the provider map for OrchestrateDeps from an already-detected
 * EnvironmentStatus.  The caller is responsible for running detectEnvironment()
 * once and passing the result here — this avoids a second round of
 * `--version` spawns when the caller already holds the detection result.
 *
 * @param _cwd - Working directory (used by real adapters to locate project-
 *               level config; may be forwarded to adapters in a future phase).
 * @param env  - The environment status produced by detectEnvironment().
 * @returns      A (possibly empty) map of available providers.
 */
export function buildProviders(
  _cwd: string,
  env: EnvironmentStatus,
): Partial<Record<ProviderId, Provider>> {
  const providers: Partial<Record<ProviderId, Provider>> = {};

  if (env.claude.installed) {
    providers.claude = createClaudeProvider();
  }

  if (env.codex.installed) {
    providers.codex = createCodexProvider();
  }

  if (env.opencode.installed) {
    providers.opencode = createOpencodeProvider();
  }

  if (env.grok.installed) {
    providers.grok = createGrokProvider();
  }

  return providers;
}

/**
 * The ORCHESTRATION provider set: {@link buildProviders} filtered to providers
 * that are actually SIGNED IN. An installed-but-signed-out provider must never be
 * a routing / preflight / work-call target — spawning its CLI unauthenticated can
 * hang or error opaquely (e.g. a user who installed several provider CLIs but only
 * signed into one). Detection still lists every INSTALLED provider for
 * `doctor`/login; this is only the set `orchestrate` is allowed to spawn. When
 * nothing is signed in this returns an empty map, so orchestrate's no-providers
 * guard fires cleanly instead of stalling on a signed-out CLI.
 */
export function buildAuthenticatedProviders(
  cwd: string,
  env: EnvironmentStatus,
): Partial<Record<ProviderId, Provider>> {
  const installed = buildProviders(cwd, env);
  const authed: Partial<Record<ProviderId, Provider>> = {};
  for (const id of Object.keys(installed) as ProviderId[]) {
    const provider = installed[id];
    if (provider !== undefined && env[id].authenticated) authed[id] = provider;
  }
  return authed;
}
