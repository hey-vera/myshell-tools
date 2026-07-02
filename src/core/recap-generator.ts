/**
 * src/core/recap-generator.ts — build a live RecapGenerator from providers.
 *
 * recap.ts decides + defines the recap (prompt builder, parse, staleness); this
 * module supplies the optional model pass that PRODUCES the text. Route to the
 * MANAGER tier (the strongest model), send the small `buildRecapPrompt` read-only
 * with a SHORT timeout, take the final text, and `parseRecapResult` it into a
 * structured {title, recap}. Every failure mode — no provider, route throws, the
 * run errors or times out, empty/unusable output — returns null, so the caller
 * falls straight back to the prior resume behaviour (the title). It never throws
 * and never writes.
 *
 * Cost discipline: this is the ONE pass a normal chat actually shows in the Recent
 * card (title + state line), so it is written by a capable model — but it is gated
 * by `isRecapStale` (a fresh cache costs ZERO model calls) and the quota-shed
 * `recapRefresh` gate so it stays INFREQUENT, never every turn. Subscription-auth
 * only: this reuses the existing provider machinery — no API key, no embeddings,
 * no metered service.
 *
 * Purity: no fs/path/child_process imports — the I/O lives in the injected
 * provider, exactly like intent-extractor.ts. A thin, testable composer.
 */

import type { Policy, SessionEntry, Tier } from './types.js';
import type { LedgerWriter, Clock } from './types.js';
import type { Provider, ProviderId, ProviderRequest, SandboxLevel, Usage } from '../providers/port.js';
import type { TurnCallBudget } from './turn-call-budget.js';
import { route } from './route.js';
import { buildRecapPrompt, parseRecapResult, type RecapResult } from './recap.js';
import { recordAuxLedger } from './aux-ledger.js';
import { runBudgetedProvider } from './budgeted-provider.js';

/** Everything the generator needs to pick and run the cheapest model. */
export interface RecapGeneratorDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly policy: Policy;
  readonly cwd: string;
  /** Hard wall-clock cap for the recap run. Keep short. */
  readonly timeoutMs: number;
  readonly sandbox?: SandboxLevel;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly accountAux?: boolean;
  readonly ledger?: LedgerWriter;
  readonly clock?: Clock;
  readonly sessionId?: string;
  readonly cacheAccountingV2?: boolean;
  readonly turnCallBudget?: TurnCallBudget;
}

/**
 * Recap generation runs at the MANAGER tier (the strongest model). This pass is
 * the one a normal chat actually shows in the Recent card — it produces both the
 * professional conversation TITLE and the honest STATE line — so it must be
 * written by a capable model reading the conversation against the product-vision /
 * quality bar, not the cheapest worker that parrots the last reply. Kept
 * INFREQUENT by the staleness + quota-shed gates (isRecapStale / recapRefresh),
 * so a fresh cache still costs ZERO model calls.
 */
const RECAP_TIER: Tier = 'manager';
/** It reads a transcript and emits a string — it never touches files. */
const RECAP_SANDBOX: SandboxLevel = 'read-only';

/**
 * Build a {@link RecapGenerator} backed by the manager-tier (strongest) provider.
 * Returns a function that takes the conversation history and resolves to a
 * {@link RecapResult} ({title, recap}), or `null` on ANY failure.
 *
 * The returned generator accepts the raw {@link SessionEntry} history and builds
 * the (truncated) recap prompt internally, so the menu only has to inject the
 * provider seam and pass `store.load(id)`.
 */
export function makeRecapGenerator(
  deps: RecapGeneratorDeps,
): (history: readonly SessionEntry[], signal: AbortSignal) => Promise<RecapResult | null> {
  return async (history: readonly SessionEntry[], signal: AbortSignal): Promise<RecapResult | null> => {
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
      sandbox: deps.sandbox ?? RECAP_SANDBOX,
      timeoutMs: deps.timeoutMs,
    };

    let finalText: string | undefined;
    let usage: Usage | undefined;
    let providerCostUsd: number | undefined;
    let startMs: number | undefined;
    try {
      startMs = deps.clock?.now();
      for await (const ev of runBudgetedProvider(provider, req, signal, {
        purpose: 'recap',
        bucket: 'discretionary',
        provider: provider.id,
        ...(deps.turnCallBudget ? { budget: deps.turnCallBudget } : {}),
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
    const result = parseRecapResult(finalText);
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
      stage: 'recap',
      provider: provider.id,
      model,
      tier: RECAP_TIER,
      usage,
      providerCostUsd,
      durationMs,
      success: result !== null,
    });
    return result;
  };
}
