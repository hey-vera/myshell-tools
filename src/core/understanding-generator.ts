/**
 * src/core/understanding-generator.ts — build a live WHOLE-PICTURE UNDERSTANDING
 * pass (elite-partner architecture Part 2).
 *
 * understanding.ts decides + defines the understanding (prompt builder, parse);
 * this module supplies the model pass that PRODUCES the {@link SystemModel}. Route
 * to the MANAGER tier (the strongest model — gaining DEEP, EXPERT understanding of
 * the real system is the headline of this phase, so it is read by a capable model
 * against the product-vision / quality bar), run the `buildUnderstandingPrompt` in
 * a READ-ONLY sandbox (it MAY read files to understand the system, but must not
 * modify anything) with a SHORT timeout, take the final text, and
 * `parseSystemModel` it. Every failure mode — no provider, route throws, the run
 * errors or times out, empty/unusable output — returns null, so the caller runs the
 * planner UNGROUNDED (today's behaviour). It never throws and never writes.
 *
 * WEB SEARCH (high-stakes only): when the engagement is high-stakes AND the routed
 * provider/model can honour the native web-search tool (Claude/Codex/Grok per
 * registry `searchMode:'native'`; OpenCode unknown/none), the request sets
 * `ProviderRequest.webSearch: true` (port.ts:74). Flag-gated: flag-OFF = Codex only
 * (byte-identical); flag-ON = capability-driven via the registry. Otherwise
 * fail-soft to a non-web read-only investigation.
 *
 * Cost discipline: this is ONE manager pass per auto-stage attempt (the menu gates
 * it on the flag + the non-trivial signal + quota pressure, run POST-turn, non-
 * blocking and fail-soft) — exactly the throwaway-pass shape of
 * goal-objective-generator.ts / goal-plan-generator.ts. Subscription-auth only: it
 * reuses the existing provider machinery — no API key, no embeddings, no metered
 * service (webSearch rides the provider's own native tool via port.ts, never a
 * metered API).
 *
 * Purity: no fs/path/child_process imports — the I/O lives in the injected
 * provider, exactly like goal-objective-generator.ts. A thin, testable composer.
 */

import type { Policy, Tier } from './types.js';
import type { LedgerWriter, Clock } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel, Usage } from '../providers/port.js';
import { route } from './route.js';
import { buildUnderstandingPrompt, parseSystemModel, type SystemModel } from './understanding.js';
import { recordAuxLedger } from './aux-ledger.js';
import { findCapability, DECLARATIVE_MODEL_CAPABILITIES } from './model-capabilities.js';
import { vendorNeutralRouterEnabled } from './route-types.js';

/** Everything the understanding pass needs to pick and run the manager-tier model. */
export interface UnderstandingGeneratorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the investigation run. Keep TIGHT — it runs post-turn. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  /** Optional deterministic repo-map / environment block to orient the model. */
  readonly repoContext?: string;
  /**
   * Whether the work about to be planned is HIGH-STAKES / novel-domain (security,
   * auth, money, data-loss, fast-moving methods). When true AND the routed provider
   * can honour native web search, the request opts into web search so the model can
   * ground its best-practice notes in CURRENT sources. Derived from the EXISTING
   * classify() risk signal upstream — never fabricated. Default false.
   */
  readonly highStakes?: boolean;
  readonly accountAux?: boolean;
  readonly ledger?: LedgerWriter;
  readonly clock?: Clock;
  readonly sessionId?: string;
  readonly cacheAccountingV2?: boolean;
}

/**
 * The understanding pass runs at the MANAGER tier (the strongest model). Mapping
 * the real motherboard — modules + how they interconnect, conventions, hard
 * constraints, the genuinely-open questions — is the headline behaviour of this
 * phase, so it must be read by a capable model, not the cheapest worker. ONE pass
 * per auto-stage attempt, fail-soft + tight timeout so it can never block.
 */
const UNDERSTANDING_TIER: Tier = 'manager';
/**
 * READ-ONLY: the pass MAY read files to understand the real system, but must NEVER
 * modify anything. This is an investigation, not a build.
 */
const UNDERSTANDING_SANDBOX: SandboxLevel = 'read-only';

/**
 * Whether the routed provider/model can honour native web search.
 *
 * Flag-OFF (byte-identical): Codex only.
 * Flag-ON (capability-driven): checks the selected model's routing profile
 * `searchMode:'native'` in the registry (Claude/Codex/Grok per curated rows).
 * OpenCode stays unknown/none until verified.
 *
 * Fail-soft: a non-search provider simply runs the investigation without the flag.
 * Never hard-fails a turn for lack of search.
 */
function providerHonoursWebSearch(
  id: ProviderId,
  model: string,
  flagOn: boolean,
): boolean {
  // Flag-off: byte-identical (Codex only)
  if (!flagOn) return id === 'codex';

  // Flag-on: lookup the selected model's routing profile in the declarative registry
  const cap = findCapability(DECLARATIVE_MODEL_CAPABILITIES, id, model);
  if (cap?.routingProfile?.searchMode === 'native') return true;

  // Fallback: check any model from this provider (model not found by name)
  const providerCaps = DECLARATIVE_MODEL_CAPABILITIES[id];
  if (providerCaps) {
    for (const c of providerCaps) {
      if (c.routingProfile?.searchMode === 'native') return true;
    }
  }
  return false;
}

/**
 * Build a manager-tier whole-picture-understanding pass. Returns a function that
 * takes the work-to-understand text and resolves to a grounded {@link SystemModel},
 * or `null` on ANY failure (so the caller runs the planner ungrounded). Mirrors
 * `makeGoalObjectiveGenerator` / `makeGoalPlanner` exactly.
 */
export function makeUnderstandingPass(
  deps: UnderstandingGeneratorDeps,
): (task: string, signal: AbortSignal) => Promise<SystemModel | null> {
  return async (task: string, signal: AbortSignal): Promise<SystemModel | null> => {
    const prompt = buildUnderstandingPrompt(task, deps.repoContext);
    if (prompt.trim().length === 0) return null;

    const pool = (Object.keys(deps.providers) as ProviderId[]).filter(
      (id) => deps.providers[id] !== undefined,
    );
    if (pool.length === 0) return null;

    let provider: Provider | undefined;
    let model: string;
    let providerId: ProviderId;
    try {
      // As in goal-objective-generator.ts: deliberately NOT threading the learned
      // provider order — this throwaway pass is a cost decision about understanding
      // the system, not about doing the owner's work.
      const decision = route(
        UNDERSTANDING_TIER,
        pool,
        deps.policy,
        deps.availableModels,
        deps.authenticatedProviders,
      );
      provider = deps.providers[decision.provider];
      model = decision.model;
      providerId = decision.provider;
    } catch {
      return null;
    }
    if (provider === undefined) return null;

    // webSearch ONLY when the work is high-stakes AND the routed provider can
    // honour the native web-search tool. Flag-gated: when the vendor-neutral
    // router is ON, this is capability-driven via the registry's searchMode;
    // when OFF it is byte-identical (Codex only).
    const flagOn = vendorNeutralRouterEnabled(process.env, undefined);
    const wantsWebSearch = deps.highStakes === true && providerHonoursWebSearch(providerId, model, flagOn);

    const req: ProviderRequest = {
      model,
      prompt,
      cwd: deps.cwd,
      sandbox: deps.sandbox ?? UNDERSTANDING_SANDBOX,
      timeoutMs: deps.timeoutMs,
      ...(wantsWebSearch ? { webSearch: true } : {}),
    };

    let finalText: string | undefined;
    let usage: Usage | undefined;
    let providerCostUsd: number | undefined;
    let startMs: number | undefined;
    try {
      startMs = deps.clock?.now();
      for await (const ev of provider.run(req, signal)) {
        if (ev.type === 'done') {
          finalText = ev.text;
          usage = ev.usage;
          providerCostUsd = ev.costUsd;
        } else if (ev.type === 'error') return null;
      }
    } catch {
      return null;
    }
    const result = parseSystemModel(finalText);
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
      stage: 'understanding',
      provider: providerId,
      model,
      tier: UNDERSTANDING_TIER,
      usage,
      providerCostUsd,
      durationMs,
      success: result !== null,
    });
    return result;
  };
}
