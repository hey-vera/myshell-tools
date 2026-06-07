/**
 * src/core/recap-generator.ts — build a live RecapGenerator from providers.
 *
 * recap.ts decides + defines the recap (prompt builder, parse, staleness); this
 * module supplies the optional model pass that PRODUCES the text. A near-twin of
 * `intent-extractor.ts`: route to the CHEAPEST tier (worker), send the small
 * `buildRecapPrompt` read-only with a SHORT timeout, take the final text, and
 * `parseRecap` it. Every failure mode — no provider, route throws, the run errors
 * or times out, empty/unusable output — returns null, so the caller falls straight
 * back to the prior resume behaviour (the title). It never throws and never writes.
 *
 * Cost discipline: a recap is a single cheap worker-tier read-only pass, gated by
 * `isRecapStale` so a fresh cache costs ZERO model calls. Subscription-auth only:
 * this reuses the existing provider machinery — no API key, no embeddings, no
 * metered service.
 *
 * Purity: no fs/path/child_process imports — the I/O lives in the injected
 * provider, exactly like intent-extractor.ts. A thin, testable composer.
 */

import type { Policy, SessionEntry, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import { route } from './route.js';
import { buildRecapPrompt, parseRecap } from './recap.js';

/** Everything the generator needs to pick and run the cheapest model. */
export interface RecapGeneratorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the recap run. Keep short. */
  readonly timeoutMs: number;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
}

/** Recap generation always runs at the cheapest tier — it only orients. */
const RECAP_TIER: Tier = 'worker';
/** It reads a transcript and emits a string — it never touches files. */
const RECAP_SANDBOX: SandboxLevel = 'read-only';

/**
 * Build a {@link RecapGenerator} backed by the cheapest available provider.
 * Returns a function that takes the conversation history and resolves to a recap
 * string, or `null` on ANY failure. Mirrors `makeIntentExtractor` exactly.
 *
 * The returned generator accepts the raw {@link SessionEntry} history and builds
 * the (truncated) recap prompt internally, so the menu only has to inject the
 * provider seam and pass `store.load(id)`.
 */
export function makeRecapGenerator(
  deps: RecapGeneratorDeps,
): (history: readonly SessionEntry[], signal: AbortSignal) => Promise<string | null> {
  return async (history: readonly SessionEntry[], signal: AbortSignal): Promise<string | null> => {
    const prompt = buildRecapPrompt(history);
    if (prompt.trim().length === 0) return null;

    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
      // As in intent-extractor.ts: deliberately NOT threading the learned provider
      // order — this throwaway worker-tier pass is a cost decision about orienting
      // the user, not about doing their work.
      const decision = route(
        RECAP_TIER,
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
      prompt,
      cwd: deps.cwd,
      sandbox: RECAP_SANDBOX,
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
    return parseRecap(finalText);
  };
}
