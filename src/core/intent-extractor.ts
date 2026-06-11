/**
 * src/core/intent-extractor.ts — build a live IntentExtractor from providers.
 *
 * intent.ts decides + defines the frame; this module supplies the optional model
 * pass that *populates* it on substantial turns. A near-twin of
 * `route-classifier.ts`: route to the CHEAPEST tier (worker), send the small
 * `buildIntentPrompt` read-only with a SHORT timeout, take the final text, and
 * `parseIntentFrame` it. Every failure mode — no provider, route throws, the run
 * errors or times out, unparseable output — returns null, so orchestrate falls
 * straight back to `rulesIntentFrame`. It never throws and never writes.
 *
 * Cost discipline: the extractor always runs at the worker tier with a read-only
 * sandbox and a caller-capped timeout — understanding a turn is far cheaper than
 * running it. It is the ONLY model touch the intent engine + APE add, and it is
 * gated (most turns make ZERO call — see `shouldExtractIntent`).
 *
 * Purity: no fs/path/child_process imports — the actual I/O lives in the injected
 * provider, exactly like route-classifier.ts. A thin, testable composer.
 */

import type { Policy, Tier } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel } from '../providers/port.js';
import { route } from './route.js';
import { buildIntentPrompt, parseIntentFrame } from './intent.js';
import type { IntentExtractor, IntentExtraction } from './intent.js';

/** Everything the extractor needs to pick and run the cheapest model. */
export interface IntentExtractorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the extraction run. Keep short. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
}

/** Extraction always runs at the cheapest tier — it only buckets understanding. */
const INTENT_TIER: Tier = 'worker';
/** Extraction reads a string and emits a string — it never touches files. */
const INTENT_SANDBOX: SandboxLevel = 'read-only';

/**
 * Build an {@link IntentExtractor} backed by the cheapest available provider.
 * Returns a function suitable for `OrchestrateDeps.intentExtractor`. Mirrors
 * `makeRouteClassifier` exactly.
 */
export function makeIntentExtractor(deps: IntentExtractorDeps): IntentExtractor {
  return async (task: string, signal: AbortSignal): Promise<IntentExtraction> => {
    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
      // As in route-classifier.ts: deliberately NOT threading the learned
      // provider order — this throwaway worker-tier extraction is a cost decision
      // about understanding a turn, not about doing the user's work.
      const decision = route(
        INTENT_TIER,
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
      prompt: buildIntentPrompt(task),
      cwd: deps.cwd,
      sandbox: deps.sandbox ?? INTENT_SANDBOX,
      timeoutMs: deps.timeoutMs,
    };

    let finalText: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      for await (const ev of provider.run(req, signal)) {
        if (ev.type === 'done') {
          finalText = ev.text;
          // Surface the REAL measured token usage (tokens-not-dollars) so the
          // brain's codebase-scrape round can show real numbers on its tier-done
          // rather than a hardcoded 0 (vision-brain §5).
          if (ev.usage !== undefined) {
            usage = { inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens };
          }
        } else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    const frame = parseIntentFrame(finalText);
    // Carry usage alongside the frame (backward-compatible IntentExtraction union).
    // When usage is unavailable, return the bare frame (consumers see usage:
    // undefined and omit the token figure rather than print a false 0).
    if (usage !== undefined) {
      const withUsage: IntentExtraction = { frame, usage };
      return withUsage;
    }
    return frame;
  };
}
