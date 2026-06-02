/**
 * src/core/route-classifier.ts — build a live ModelClassifier from providers.
 *
 * router.ts decides; this module supplies the optional model it asks. It wraps a
 * real provider run in the ModelClassifier shape: route to the CHEAPEST tier
 * (worker), send the tiny routing prompt read-only with a SHORT timeout, take the
 * final text, and parse it. Every failure mode — no provider, route throws, the
 * run errors or times out, unparseable output — returns null, so router.ts falls
 * straight back to the deterministic rules. It never throws and never writes.
 *
 * Cost discipline: the classifier always runs at the worker tier with a read-only
 * sandbox and a caller-capped timeout, so deciding how to route a turn is far
 * cheaper than running the turn itself.
 *
 * Purity: no fs/path/child_process imports — the actual I/O lives in the injected
 * provider, exactly like orchestrate(). This stays a thin, testable composer.
 */

import type { Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import { route } from './route.js';
import { buildRouterPrompt, parseModelRoute } from './router.js';
import type { ModelClassifier, ModelRouteSuggestion } from './router.js';

/** Everything the classifier needs to pick and run the cheapest model. */
export interface RouteClassifierDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the classification run. Keep short. */
  readonly timeoutMs: number;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
}

/** Classification always runs at the cheapest tier — it only buckets a turn. */
const ROUTER_TIER: Tier = 'worker';
/** Classification reads a string and emits a string — it never touches files. */
const ROUTER_SANDBOX: SandboxLevel = 'read-only';

/**
 * Build a {@link ModelClassifier} backed by the cheapest available provider.
 * Returns a function suitable for `OrchestrateDeps.routeClassifier`.
 */
export function makeRouteClassifier(deps: RouteClassifierDeps): ModelClassifier {
  return async (task: string, signal: AbortSignal): Promise<ModelRouteSuggestion | null> => {
    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
      const decision = route(
        ROUTER_TIER,
        pool,
        deps.policy,
        deps.availableModels,
        deps.authenticatedProviders,
      );
      provider = deps.providers[decision.provider];
      model = decision.model;
    } catch {
      return null;
    }
    if (provider === undefined) return null;

    const req: ProviderRequest = {
      model,
      prompt: buildRouterPrompt(task),
      cwd: deps.cwd,
      sandbox: ROUTER_SANDBOX,
      timeoutMs: deps.timeoutMs,
    };

    let finalText: string | undefined;
    try {
      for await (const ev of provider.run(req, signal)) {
        if (ev.type === 'done') finalText = ev.text;
        else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    return parseModelRoute(finalText);
  };
}
