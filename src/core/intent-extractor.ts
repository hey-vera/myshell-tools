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
import type { LedgerStage, LedgerWriter, Clock } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel, Usage } from '../providers/port.js';
import { route } from './route.js';
import { buildIntentPrompt, parseIntentFrame } from './intent.js';
import type { IntentExtractor, IntentExtraction } from './intent.js';
import { parseFallbackIntentFrame } from './byproduct-parse.js';
import { recordAuxLedger } from './aux-ledger.js';
import { runBudgetedProvider } from './budgeted-provider.js';
import type { TurnCallBudget, TurnCallPurpose } from './turn-call-budget.js';

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
  /**
   * EXPERIMENTAL (default absent/false). When true, if the primary
   * `parseIntentFrame` returns null the extractor tries the richer
   * `parseFallbackIntentFrame` chain (fenced JSON → partial JSON → prose
   * markers) before returning null. PURELY ADDITIVE: on a clean primary parse
   * this has zero effect. Sourced from `OrchestrateDeps.byproductFallback`
   * (set by the interface layer when `byproductFallbackEnabled` is true).
   * Absent/false → byte-for-byte today's behavior.
   */
  readonly byproductFallback?: boolean;
  readonly accountAux?: boolean;
  readonly ledger?: LedgerWriter;
  readonly clock?: Clock;
  readonly sessionId?: string;
  readonly cacheAccountingV2?: boolean;
  readonly turnCallBudget?: TurnCallBudget;
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
  return async (
    task: string,
    signal: AbortSignal,
    opts?: { readonly stage?: LedgerStage; readonly intentVersionId?: string },
  ): Promise<IntentExtraction> => {
    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    try {
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
    let usage: Usage | undefined;
    let providerCostUsd: number | undefined;
    let startMs: number | undefined;
    const purpose: TurnCallPurpose = (() => {
      const stage = opts?.stage;
      if (stage === 'reextract-local') return 'reextract-local';
      if (stage === 'reextract-web') return 'reextract-web';
      return 'intent';
    })();
    try {
      startMs = deps.clock?.now();
      for await (const ev of runBudgetedProvider(provider, req, signal, {
        ...(deps.turnCallBudget !== undefined ? { budget: deps.turnCallBudget } : {}),
        purpose,
        bucket: 'discretionary',
        provider: provider.id,
      })) {
        if (ev.type === 'done') {
          finalText = ev.text;
          usage = ev.usage;
          providerCostUsd = ev.costUsd;
        } else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    // PRIMARY parse: the standard `parseIntentFrame` (always attempted first).
    let frame = parseIntentFrame(finalText);

    // FALLBACK parse (ADDITIVE — only when primary returned null AND the flag
    // is on).  Never alters a successful primary parse.  The fallback handles
    // fenced JSON blocks, partial JSON missing `confidence`, and prose markers.
    if (frame === null && deps.byproductFallback === true) {
      frame = parseFallbackIntentFrame(finalText);
    }

    const durationMs =
      startMs !== undefined && deps.clock !== undefined
        ? deps.clock.now() - startMs
        : 0;
    await recordAuxLedger({
      enabled: deps.accountAux === true,
      ledger: deps.ledger,
      clock: deps.clock,
      sessionId: deps.sessionId,
      cacheAccountingV2: deps.cacheAccountingV2,
      intentVersionId: opts?.intentVersionId,
      stage: opts?.stage ?? 'intent',
      provider: provider.id,
      model,
      tier: INTENT_TIER,
      usage,
      providerCostUsd,
      durationMs,
      success: frame !== null,
    });

    // Carry usage alongside the frame (backward-compatible IntentExtraction union).
    // When usage is unavailable, return the bare frame (consumers see usage:
    // undefined and omit the token figure rather than print a false 0).
    if (usage !== undefined) {
      const intentUsage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        ...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}),
      };
      const withUsage: IntentExtraction = { frame, usage: intentUsage };
      return withUsage;
    }
    return frame;
  };
}
