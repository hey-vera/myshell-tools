/**
 * src/core/route.ts — pure cost-aware routing decision.
 *
 * Given a tier, the set of currently available provider IDs, and the active
 * Policy, selects the concrete provider+model that should handle the work.
 *
 * No I/O, no time, no randomness. Pricing data is pure reference data imported
 * from infra/pricing (permitted by the purity guard because pricing.ts itself
 * imports no fs/path/child_process).
 */

import type { Tier, Risk, RouteDecision, Policy } from './types.js';
import type { Mode } from './policy.js';
import type { ProviderId } from '../providers/port.js';
import { getCheapestForTier, PRICING_TABLE } from '../infra/pricing.js';
import { selectOpencodeModel } from './opencode-model.js';
import {
  findCapability,
  type CapabilityRegistry,
  type ModelPreference,
  type TaskKind,
} from './model-capabilities.js';

/**
 * Task-level signals describing WHAT this turn needs, used by capability-fit to
 * re-rank models WITHIN the already-bounded candidate set. Purely informational:
 * none of these can expand the candidate set, switch providers, or bypass a gate.
 * See docs/model-capability-registry-5.6.md §3.
 */
export interface CapabilityTaskSignals {
  readonly risk: Risk;
  readonly routePlan: boolean;
  /** Best-effort estimate of input size; drives the large-context preference. */
  readonly estimatedInputTokens?: number;
  /** True only when the turn actually has image input (drives the vision gate). */
  readonly needsVision?: boolean;
  readonly taskKind: TaskKind;
}

/**
 * Optional, opt-in capability-fit context for route(). When ABSENT (the default),
 * route() behaves byte-for-byte as before. When present, capability-fit re-ranks
 * models within the bounded candidate set the existing machinery already produced
 * (provider chosen by available/auth/cooldown/learned/policy; model set bounded by
 * tier + availableModels). It can NEVER select a provider outside `available`, put
 * a signed-out provider ahead of a signed-in one, bypass authorizeTier/maxTier, or
 * choose a model not in availableModels. See §3 "Capability-fit is bounded".
 */
export interface CapabilityRouteContext {
  /** The merged capability registry (Layer 2 snapshot). Absent → no fit signal. */
  readonly registry?: CapabilityRegistry;
  readonly taskSignals?: CapabilityTaskSignals;
  /**
   * Learned (provider, model) outcome order (Stage 4). Accepted in the shape now,
   * consumed only minimally in Stage 2 as a tie-breaker WITHIN the chosen
   * provider's candidate models; it never expands the candidate set or switches
   * provider. Absent → no effect.
   */
  readonly modelOutcomeOrder?: readonly ModelPreference[];
  readonly mode: Mode;
}

/**
 * Ordinal rank of each tier, cheapest → most expensive. Used to clamp a
 * requested tier DOWN to a policy ceiling (`policy.maxTier`).
 */
const TIER_RANK: Record<Tier, number> = {
  worker: 0,
  ic: 1,
  manager: 2,
};

/**
 * Clamp `requested` down to `ceiling` when a ceiling is set. This ONLY lowers
 * the tier (never raises it): if the requested tier already sits at or below the
 * ceiling it is returned unchanged. `undefined` ceiling → no clamp (classifier
 * / caller wins). This is the single chokepoint that caps both initial routing
 * AND escalation/review calls — e.g. under `balanced` (maxTier 'ic') a
 * `route('manager', ...)` request resolves an IC model (sonnet), never opus.
 */
export function clampTier(requested: Tier, ceiling: Tier | undefined): Tier {
  if (ceiling === undefined) return requested;
  return TIER_RANK[requested] > TIER_RANK[ceiling] ? ceiling : requested;
}

/**
 * Resolve a {@link RouteDecision} for the given tier.
 *
 * Algorithm:
 *  0. Clamp the requested `tier` DOWN to `policy.maxTier` when set (only lowers,
 *     never raises; undefined = no cap). This is the single chokepoint that caps
 *     initial routing AND escalation/review calls, so e.g. under `balanced`
 *     (maxTier 'ic') a manager request resolves an IC model, not opus.
 *  1. Walk `policy.providerOrderByTier[tier]` in preference order.
 *  2. When `authenticatedProviders` is supplied and non-empty, prefer the FIRST
 *     provider that is both in `available` AND in `authenticatedProviders`.
 *     This ensures signed-in providers are chosen before signed-out ones,
 *     avoiding wasted attempts against providers that are installed but not
 *     logged in.
 *  3. If no authenticated+available match is found (or `authenticatedProviders`
 *     is absent/empty), fall back to the FIRST provider in preference order that
 *     is present in `available` (current behaviour — a signed-out provider may
 *     still be tried; auth can change at call time and failover handles the rest).
 *  4. If none of the policy-preferred providers are available but `available`
 *     is non-empty, fall back to the globally cheapest model for that tier.
 *  5. If `available` is empty, throw — there is nothing to route to.
 *
 * The `availableModels` parameter is additive/opt-in:
 *   - When absent or undefined → behaviour is IDENTICAL to today (no change).
 *   - When a provider's entry is present and non-empty → prefer a model in that
 *     list; if none match the pricing table, fall back to cheapest-for-tier
 *     (graceful degradation, never throws, never returns nothing).
 *
 * The `authenticatedProviders` parameter is additive/opt-in:
 *   - When absent or empty → behaviour is IDENTICAL to today (no change).
 *   - When supplied and non-empty → authenticated+available providers are
 *     preferred over signed-out+available ones within the policy order.
 *
 * The `preferredOrder` parameter is additive/opt-in (the Local Outcome Learner):
 *   - When absent or empty → behaviour is IDENTICAL to today (no change).
 *   - When supplied and non-empty → this LEARNED order is tried FIRST, using the
 *     SAME auth-aware logic (prefer the first provider that is in `available`
 *     AND, when auth info is present, in `authenticatedProviders`). Only when the
 *     learned order yields no eligible provider does route() fall back to
 *     `policy.providerOrderByTier`. The learned order never expands the candidate
 *     set (a provider must still be in `available`), so it can only REORDER which
 *     reachable provider wins — never route to an unreachable one.
 *
 * @param tier                   - The orchestration tier to route.
 * @param available              - Provider IDs that are currently reachable.
 * @param policy                 - Active routing policy (from `DEFAULT_POLICY` or overrides).
 * @param availableModels        - Optional per-provider advertised model sets from detection.
 * @param authenticatedProviders - Optional set of provider IDs known to be signed in.
 * @param preferredOrder         - Optional learned, observed-only provider order
 *                                 (for the clamped tier) to try before the static
 *                                 policy order. Absent/empty → no effect.
 */
export function route(
  tier: Tier,
  available: ProviderId[],
  policy: Policy,
  availableModels?: Partial<Record<ProviderId, readonly string[]>>,
  authenticatedProviders?: readonly ProviderId[],
  preferredOrder?: readonly ProviderId[],
  capabilityContext?: CapabilityRouteContext,
): RouteDecision {
  if (available.length === 0) {
    throw new Error(
      `route: no providers available for tier "${tier}" — start at least one provider`,
    );
  }

  // Clamp the requested tier down to the policy ceiling BEFORE model resolution.
  // From here on, `tier` is the *effective* tier: provider preference order,
  // model selection, and the returned RouteDecision.tier all use the clamped
  // value, so the decision stays internally consistent (an IC model is reported
  // as tier 'ic', never as a 'manager' decision running a sonnet model).
  tier = clampTier(tier, policy.maxTier);

  const preferredOrder_policy = policy.providerOrderByTier[tier];
  const hasAuthInfo =
    authenticatedProviders !== undefined && authenticatedProviders.length > 0;

  /**
   * Build a RouteDecision for the given provider id, applying the
   * availableModels filter when present.
   */
  function decisionFor(id: ProviderId): RouteDecision {
    const providerAllowed = availableModels?.[id];
    const allowedSet =
      providerAllowed !== undefined && providerAllowed.length > 0
        ? providerAllowed
        : undefined;
    // opencode: which models are usable is entirely the user's connected set
    // (free models, OpenCode Go subscription, or Zen credits). Pick the best of
    // their REAL available models for this tier instead of a pricing placeholder,
    // so `opencode run -m` uses a model they actually have. Fail-safe: when no
    // usable model is found, fall through to pricing (the adapter then omits -m
    // and lets opencode use its own configured default).
    let baseline: RouteDecision;
    if (id === 'opencode') {
      const picked = selectOpencodeModel(tier, allowedSet);
      if (picked !== undefined) baseline = { tier, provider: id, model: picked };
      else baseline = { tier, provider: id, model: getCheapestForTier(tier, [id], allowedSet).model };
    } else {
      const pricing = getCheapestForTier(tier, [id], allowedSet);
      baseline = { tier, provider: id, model: pricing.model };
    }
    // Capability-fit re-rank — BOUNDED and OPT-IN. When no capabilityContext is
    // supplied, return the baseline UNCHANGED (byte-for-byte equal to the prior
    // behaviour, including the absence of any capabilityReasons field). When a
    // registry IS supplied, re-rank ONLY among the candidate models for this
    // already-chosen provider+tier — the provider choice (and therefore every
    // auth/cooldown/policy/maxTier guard) is untouched.
    if (capabilityContext === undefined) return baseline;
    return applyCapabilityFit(baseline, id, allowedSet, capabilityContext);
  }

  /**
   * Re-rank candidate models for an ALREADY-CHOSEN provider using objective
   * registry facts. Pure, bounded, fail-soft: it can only swap WHICH model of
   * `id` runs (always within the candidate set), never the provider; it never
   * adds a model outside `allowedSet`/the pricing table for the tier; and it
   * returns the baseline unchanged whenever there is no clear, known fit win.
   */
  function applyCapabilityFit(
    baseline: RouteDecision,
    id: ProviderId,
    allowedSet: readonly string[] | undefined,
    ctx: CapabilityRouteContext,
  ): RouteDecision {
    const registry = ctx.registry;
    const signals = ctx.taskSignals;
    // Candidate model ids — bounded EXACTLY as the existing machinery: models for
    // THIS provider at THIS (already-clamped) tier. When the provider advertises a
    // set we keep only its members that are valid for the tier (mirrors
    // getCheapestForTier's tier+allowed filter, so capability-fit can never select
    // a model the tier machinery would have excluded — e.g. a manager-tier id on an
    // IC route). If that intersection is empty we degrade to the pricing-tier set,
    // exactly like getCheapestForTier's graceful fallback. opencode real ids are
    // not in the pricing table, so this yields the placeholder set and the baseline
    // (selectOpencodeModel's pick) stands — we never re-rank arbitrary opencode ids.
    const tierModels = PRICING_TABLE.models.filter((m) => m.provider === id && m.tier === tier);
    let candidates: readonly string[];
    if (allowedSet !== undefined) {
      const allowed = new Set(allowedSet.map((a) => a.toLowerCase()));
      const filtered = tierModels.filter(
        (m) => allowed.has(m.model.toLowerCase()) || m.aliases.some((a) => allowed.has(a.toLowerCase())),
      );
      candidates = (filtered.length > 0 ? filtered : tierModels).map((m) => m.model);
    } else {
      candidates = tierModels.map((m) => m.model);
    }
    if (registry === undefined || candidates.length === 0) {
      // Nothing to rank against → baseline, but still record the (empty/neutral)
      // reasoning so callers can tell capability-fit RAN with no actionable fact.
      return { ...baseline, capabilityReasons: [] };
    }

    const baseScored = scoreModel(tier, baseline.model, id, registry, signals, ctx);
    let best = baseline.model;
    let bestScore = baseScored.score;
    let bestReasons = baseScored.reasons;

    for (const cand of candidates) {
      if (cand === baseline.model) continue;
      const { score, reasons } = scoreModel(tier, cand, id, registry, signals, ctx);
      // Strictly-better only: ties keep the baseline (the existing cheapest /
      // opencode-selected pick), so capability-fit only ever moves when a known
      // fact justifies it. This preserves current output on neutral turns.
      if (score > bestScore) {
        best = cand;
        bestScore = score;
        bestReasons = reasons;
      }
    }

    return { tier, provider: id, model: best, capabilityReasons: bestReasons };
  }

  // Order in which we consult provider-preference lists: the LEARNED order first
  // (when supplied and non-empty — the Local Outcome Learner), then the static
  // policy order. Each list is walked auth-aware then first-available, so the
  // learned order can only REORDER among reachable providers; it never strands
  // routing (an empty/non-eligible learned list simply falls through to policy).
  const learnedOrder =
    preferredOrder !== undefined && preferredOrder.length > 0 ? preferredOrder : undefined;
  const candidateOrders: ReadonlyArray<readonly ProviderId[]> =
    learnedOrder !== undefined ? [learnedOrder, preferredOrder_policy] : [preferredOrder_policy];

  // Auth-aware pass: when authenticatedProviders is supplied and non-empty, prefer
  // the first provider that is both available AND authenticated. We try the
  // learned order's authenticated match BEFORE the policy order's, so a learned
  // preference wins when it is eligible. This prevents wasting an attempt on a
  // signed-out provider when a ready one exists later in a preference order.
  if (hasAuthInfo) {
    for (const order of candidateOrders) {
      for (const preferred of order) {
        if (
          available.includes(preferred) &&
          (authenticatedProviders as readonly ProviderId[]).includes(preferred)
        ) {
          return decisionFor(preferred);
        }
      }
    }
    // No authenticated+available match found in any order — fall through to the
    // standard first-available pass below (signed-out provider as last resort).
  }

  // Standard pass: walk each preference order (learned first) and pick the first
  // available provider.
  for (const order of candidateOrders) {
    for (const preferred of order) {
      if (available.includes(preferred)) {
        return decisionFor(preferred);
      }
    }
  }

  // None of the policy-preferred providers are available; fall back to the
  // globally cheapest provider, then apply the normal provider-specific model
  // selection so advertised-model filters and opencode handling are preserved.
  const fallback = getCheapestForTier(tier, available);
  return decisionFor(fallback.provider as ProviderId);
}

/** Headroom (tokens) a model's context window must clear the estimate by before
 *  large-context fit prefers it — guards against a borderline window that would
 *  overflow once prompt scaffolding/output are added. PURE constant. */
const LARGE_CONTEXT_MARGIN_TOKENS = 8_000;

/** The estimated-input size at/above which window size becomes a real routing
 *  constraint. Below it every reasonable window fits, so the large-context
 *  preference stays NEUTRAL and the cheapest baseline pick is kept (a small task
 *  must not be nudged onto a bigger-window model for no reason). PURE constant. */
const LARGE_CONTEXT_ENGAGE_TOKENS = 100_000;

/**
 * Score one candidate model of an ALREADY-CHOSEN provider against the task using
 * ONLY objective registry facts. Higher score = better known fit; ties leave the
 * baseline in place (caller keeps the cheapest/opencode pick). Pure, fail-soft:
 * unknown facts are NEUTRAL (never disqualifying — §2 "unknown is absent"), so a
 * model with missing metadata simply scores 0 and never wins over the baseline.
 *
 * Bounded by construction: this function never sees `available`, auth, cooldown,
 * or the provider list — it can only rank models the caller already bounded to the
 * chosen provider+tier candidate set, so it cannot bypass any routing gate.
 */
function scoreModel(
  tier: Tier,
  modelId: string,
  provider: ProviderId,
  registry: CapabilityRegistry,
  signals: CapabilityTaskSignals | undefined,
  ctx: CapabilityRouteContext,
): { score: number; reasons: string[] } {
  const cap = findCapability(registry, provider, modelId);
  let score = 0;
  const reasons: string[] = [];
  if (cap === undefined) {
    // Unknown model = neutral. We do NOT punish absence (a new model must not be
    // self-limited before evidence arrives — §2).
    return { score, reasons };
  }

  // --- Vision: a HARD requirement only when the task truly has image input. ----
  if (signals?.needsVision === true) {
    if (cap.supportsVision === true) {
      score += 100;
      reasons.push(`vision supported for image input (${cap.id})`);
    } else {
      // Known-false or unknown vision for an image task: strong negative so a
      // vision-capable sibling wins when one exists in the candidate set. If none
      // does, the baseline still wins (all candidates equally penalized) and the
      // caller proceeds honestly with the existing pick — never strands routing.
      score -= 100;
    }
  }

  // --- Large context: prefer a known window that clears the estimate + margin. -
  // Engaged ONLY for genuinely large inputs (≥ threshold); below it window size
  // is not a real constraint, so the preference stays neutral and the baseline
  // (cheapest) model is kept. A model with `taskKind === 'large-context'` also
  // engages it even if the token estimate is absent but high signals say so.
  const est = signals?.estimatedInputTokens;
  const largeContextTask =
    (est !== undefined && est >= LARGE_CONTEXT_ENGAGE_TOKENS) ||
    (signals?.taskKind === 'large-context' && est !== undefined && est > 0);
  if (est !== undefined && est > 0 && largeContextTask) {
    const window = cap.maxContextWindow ?? cap.contextWindow;
    if (window !== undefined) {
      if (window >= est + LARGE_CONTEXT_MARGIN_TOKENS) {
        // Larger known windows score higher so the biggest sufficient window wins
        // among candidates that all clear the bar. Bucketed (per 100k) so the
        // score stays small/auditable and never dwarfs the vision requirement.
        score += 10 + Math.floor(window / 100_000);
        reasons.push(
          `context window ${formatTokens(window)} ≥ estimated ${formatTokens(est)} (+margin)`,
        );
      }
      // Known window that is too small: neutral, not negative — the caller may
      // have nothing larger and the provider/tier were already chosen.
    }
    // Unknown window: NEUTRAL (no score change, no reason) per §3.
  }

  // --- Native-session continuity: a SOFT within-provider preference only. ------
  // Never switches providers (the provider is already fixed); just nudges toward
  // a model that supports native sessions when the task is non-trivial.
  if (cap.supportsNativeSession === true && tier !== 'worker') {
    score += 1;
    reasons.push(`native session supported (${cap.id})`);
  }

  // --- Learned outcome order (Stage 4 input): minimal tie-breaker only. --------
  // Consumed conservatively in Stage 2 — a small bump for an earlier-ranked
  // (provider, model) pair, never enough to override a known capability fit.
  const order = ctx.modelOutcomeOrder;
  if (order !== undefined && order.length > 0) {
    const idx = order.findIndex(
      (p) => p.provider === provider && matchesModel(registry, provider, p.model, modelId),
    );
    if (idx >= 0) {
      score += Math.max(0, 5 - idx) * 0.1;
      reasons.push(`learned outcome preference rank ${idx + 1}`);
    }
  }

  return { score, reasons };
}

/** True when `learnedId` refers to the same model as `candidateId` (id/alias). PURE. */
function matchesModel(
  registry: CapabilityRegistry,
  provider: ProviderId,
  learnedId: string,
  candidateId: string,
): boolean {
  if (learnedId.toLowerCase() === candidateId.toLowerCase()) return true;
  const a = findCapability(registry, provider, learnedId);
  const b = findCapability(registry, provider, candidateId);
  return a !== undefined && b !== undefined && a.id === b.id;
}

/** Compact token count for audit reasons (e.g. 272000 -> "272k"). PURE. */
function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
