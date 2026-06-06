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
  KNOWN_REASONING_EFFORTS,
  type CapabilityRegistry,
  type ModelCapability,
  type ModelPreference,
  type ReasoningEffort,
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
   * Candidate model ids for `id` at THIS (already-clamped) tier — bounded EXACTLY
   * as the existing machinery: pricing-table models for the provider+tier, then
   * (when the provider advertises a set) kept to only its members valid for the
   * tier (mirrors getCheapestForTier's tier+allowed filter, so neither the
   * pre-pass nor capability-fit can ever consider a model the tier machinery would
   * have excluded — e.g. a manager-tier id on an IC route). If that intersection is
   * empty we degrade to the pricing-tier set, exactly like getCheapestForTier's
   * graceful fallback. opencode real ids are not in the pricing table, so this
   * yields the placeholder set and the baseline (selectOpencodeModel's pick)
   * stands — we never re-rank arbitrary opencode ids. PURE, shared by the
   * hard-requirement pre-pass and applyCapabilityFit so their bounds are identical.
   */
  function candidateModelsFor(
    id: ProviderId,
    allowedSet: readonly string[] | undefined,
  ): readonly string[] {
    const tierModels = PRICING_TABLE.models.filter((m) => m.provider === id && m.tier === tier);
    if (allowedSet !== undefined) {
      const allowed = new Set(allowedSet.map((a) => a.toLowerCase()));
      const filtered = tierModels.filter(
        (m) => allowed.has(m.model.toLowerCase()) || m.aliases.some((a) => allowed.has(a.toLowerCase())),
      );
      return (filtered.length > 0 ? filtered : tierModels).map((m) => m.model);
    }
    return tierModels.map((m) => m.model);
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
    const candidates = candidateModelsFor(id, allowedSet);
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

  // -------------------------------------------------------------------------
  // Capability-aware provider PRE-PASS (cross-provider hard-requirement fit).
  //
  // CONSERVATIVE + ACTIVATES ONLY ON A GENUINE HARD REQUIREMENT. When this pass
  // does not fire — capabilityContext absent, registry absent, no hard requirement
  // detected, or no available+authenticated provider KNOWN-satisfies it — we DO
  // NOTHING and fall through to the existing auth-aware/standard passes below, so
  // route() is byte-for-byte identical to today on every non-hard turn.
  //
  // A HARD requirement is one only some providers can hold (not a soft preference):
  //   - needsVision === true (the turn truly has image input), OR
  //   - estimatedInputTokens exceeds the known context window of some candidate
  //     providers' in-tier models (a large-context need only big-window providers
  //     can satisfy).
  // (Web search is intentionally NOT detected here: CapabilityTaskSignals carries
  //  no search signal, and the brief forbids inventing one.)
  //
  // When a hard requirement exists AND a registry is present, we compute which
  // providers KNOWN-satisfy it (have an in-tier model — bounded EXACTLY like
  // decisionFor via candidateModelsFor — whose registry capability satisfies the
  // requirement). We then route to the best satisfying provider using the SAME
  // preference logic as below (auth-aware over learned→policy order, then
  // first-available over learned→policy order), restricted to the satisfying set.
  // Bounds preserved: we only ever pick a provider that the unrestricted passes
  // below could also have picked at this tier (available, and — under auth info —
  // never a signed-out provider ahead of a signed-in one); we never change tier,
  // bypass authorizeTier/maxTier (the pre-pass runs at the already-clamped `tier`),
  // override cooldown (we operate only on the passed `available`), or reorder on
  // unknown-capability guesses (only KNOWN-satisfying providers qualify). If the
  // satisfying set is empty we fall through unchanged — never strand, never pick a
  // signed-out/unavailable provider ahead of an eligible one.
  if (capabilityContext?.registry !== undefined) {
    const reg = capabilityContext.registry;
    const signals = capabilityContext.taskSignals;
    const needsVision = signals?.needsVision === true;
    const est = signals?.estimatedInputTokens;
    const needsLargeContext =
      est !== undefined && est > 0 && est >= LARGE_CONTEXT_ENGAGE_TOKENS;

    if (needsVision || needsLargeContext) {
      // A provider KNOWN-satisfies the requirement when at least one of its in-tier
      // candidate models has a registry capability that is KNOWN to satisfy it.
      // Unknown capability is NEITHER a satisfier nor a disqualifier (it simply
      // does not count toward the satisfying set), so we never reorder on a guess.
      const knownSatisfies = (id: ProviderId): boolean => {
        const candidates = candidateModelsFor(id, availableModels?.[id]);
        for (const modelId of candidates) {
          const cap = findCapability(reg, id, modelId);
          if (cap === undefined) continue;
          if (needsVision && cap.supportsVision !== true) continue;
          if (needsLargeContext) {
            const window = cap.maxContextWindow ?? cap.contextWindow;
            if (
              window === undefined ||
              !(est !== undefined && window >= est + LARGE_CONTEXT_MARGIN_TOKENS)
            ) {
              continue;
            }
          }
          return true;
        }
        return false;
      };

      // Pick within the SATISFYING set using the existing preference logic: prefer
      // an authenticated+available satisfying provider (when auth info is present),
      // walking learned→policy order; then a first-available satisfying provider,
      // walking learned→policy order. This is the same two-phase walk as below,
      // just gated by `knownSatisfies` — so a satisfying provider is never picked
      // ahead of an equally-eligible one in a way the standard passes wouldn't.
      if (hasAuthInfo) {
        for (const order of candidateOrders) {
          for (const preferred of order) {
            if (
              available.includes(preferred) &&
              (authenticatedProviders as readonly ProviderId[]).includes(preferred) &&
              knownSatisfies(preferred)
            ) {
              return decisionFor(preferred);
            }
          }
        }
      }
      for (const order of candidateOrders) {
        for (const preferred of order) {
          if (available.includes(preferred) && knownSatisfies(preferred)) {
            // When auth info IS present, do NOT let this first-available phase pick
            // a signed-out satisfying provider ahead of a signed-in (but
            // non-satisfying) one — that would strand the user on an unauthenticated
            // provider. The auth-aware phase above already handled authed
            // satisfiers; if none existed, fall through to today's selection rather
            // than promote a signed-out provider on capability grounds.
            if (
              hasAuthInfo &&
              !(authenticatedProviders as readonly ProviderId[]).includes(preferred)
            ) {
              continue;
            }
            return decisionFor(preferred);
          }
        }
      }
      // No KNOWN-satisfying eligible provider → fall through unchanged.
    }
  }

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

// ---------------------------------------------------------------------------
// Reasoning-effort selector (capability registry §3 "Effort selector", §5).
// ---------------------------------------------------------------------------

/** Ordinal rank along KNOWN_REASONING_EFFORTS (none=0 … xhigh=4 … max=5). PURE. */
function effortRank(e: ReasoningEffort): number {
  return KNOWN_REASONING_EFFORTS.indexOf(e);
}

/**
 * Given a DESIRED effort and the model's supported set, return the desired effort
 * if supported; otherwise STEP DOWN to the nearest LOWER supported effort (§3
 * "If selected effort is unavailable, step down to the nearest lower known
 * effort"). Returns `undefined` only when nothing at/below the desired effort is
 * supported (e.g. the model declares only a higher effort). PURE.
 */
function resolveSupported(
  desired: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
  const supportedSet = new Set(supported);
  if (supportedSet.has(desired)) return desired;
  const desiredRank = effortRank(desired);
  // Walk DOWN from the desired effort to the cheapest, taking the first supported.
  let best: ReasoningEffort | undefined;
  let bestRank = -1;
  for (const e of supported) {
    const r = effortRank(e);
    if (r <= desiredRank && r > bestRank) {
      best = e;
      bestRank = r;
    }
  }
  return best;
}

/**
 * Is this turn a "hard reasoning" turn — the kind that earns a deeper effort?
 * High/critical risk, architecture, review, or a large-context turn. PURE.
 */
function isHardReasoningTurn(input: {
  readonly risk: Risk;
  readonly taskKind: TaskKind;
}): boolean {
  return (
    input.risk === 'high' ||
    input.risk === 'critical' ||
    input.taskKind === 'architecture' ||
    input.taskKind === 'review' ||
    input.taskKind === 'large-context'
  );
}

/**
 * Select the reasoning-effort knob for a run, per docs/model-capability-
 * registry-5.6.md §3 ("Effort selector") and §5. PURE — no I/O, no time, no
 * randomness; reference data only.
 *
 * The selector is BOUNDED BY POLICY, never a back door:
 *  - It is called only AFTER tier/manager admission is resolved, against the
 *    ALREADY-CHOSEN model's capability. `tier === 'manager'` here means the
 *    flagship was already admitted by authorizeTier — the selector never opens
 *    manager and never lifts a ceiling; it only chooses how deep to think within
 *    the tier the policy already granted. `xhigh` is therefore reachable ONLY when
 *    the caller passes `tier: 'manager'` (i.e. manager was admitted).
 *  - When the model declares NO efforts (`supportedReasoningEfforts` empty) it
 *    returns `undefined` → no effort flag → byte-for-byte unchanged behaviour.
 *  - The desired effort is always reconciled against the model's supported set
 *    (step-down to the nearest lower supported effort), so it can never force an
 *    effort the model doesn't support (§3 "cannot force a reasoning effort
 *    unsupported by the selected model").
 *
 * Rules (mode × tier × risk/taskKind):
 *  - Efficient (cost-saver): worker/IC → `low`; admitted manager → `medium`;
 *    NEVER `xhigh`.
 *  - Balanced: `medium` default; `high` for a hard turn (high/critical risk,
 *    architecture, review, or large-context); `xhigh` ONLY for an admitted
 *    manager on critical/architecture/large-context.
 *  - Max (quality-first): `high` floor for IC/manager (and worker hard turns);
 *    the DEEPEST supported level (`max` for a model that offers it, e.g. Claude;
 *    `xhigh` after step-down for Codex) for an admitted manager on a hard turn
 *    (high/critical risk, architecture, review, or large-context). Worker non-hard
 *    stays `medium`.
 */
export function selectReasoningEffort(input: {
  readonly model: ModelCapability;
  readonly mode: Mode;
  readonly tier: Tier;
  readonly risk: Risk;
  readonly taskKind: TaskKind;
  readonly routePlan: boolean;
}): ReasoningEffort | undefined {
  const { model, mode, tier, risk, taskKind } = input;
  const supported = model.supportedReasoningEfforts;
  // No machine-readable effort metadata → never thread an effort (unchanged).
  if (supported.length === 0) return undefined;

  const isManager = tier === 'manager'; // manager here ⇒ already admitted by policy
  const hardTurn = isHardReasoningTurn({ risk, taskKind });
  // xhigh-class turns: critical/architecture/large-context (review/high are NOT
  // sufficient for xhigh in Balanced, but ARE sufficient in Max).
  const xhighClassStrict =
    risk === 'critical' || taskKind === 'architecture' || taskKind === 'large-context';

  let desired: ReasoningEffort;
  switch (mode) {
    case 'cost-saver': {
      // Efficient: worker/IC → low; admitted manager → medium; NEVER xhigh.
      desired = isManager ? 'medium' : 'low';
      break;
    }
    case 'balanced': {
      if (isManager && xhighClassStrict) desired = 'xhigh';
      else if (hardTurn) desired = 'high';
      else desired = 'medium';
      break;
    }
    case 'quality-first': {
      // Max (quality-first, the deepest knob): `high` is the FLOOR for IC/manager
      // (Max spends quality on substantial work by default); for an admitted manager
      // on a hard turn (high/critical risk, architecture, review, or large-context)
      // we desire the DEEPEST level the chosen model offers — `max` (Claude's
      // `--effort max`). resolveSupported steps this down to the nearest lower
      // supported effort for a model without `max` (e.g. Codex → `xhigh`), so this
      // is byte-for-byte unchanged for Codex while unlocking `max` for Claude.
      // Worker rises to `high` on a hard turn but otherwise stays `medium` (a trivial
      // worker chore is never worth deep reasoning, even in Max).
      if (isManager && hardTurn) desired = 'max';
      else if (tier !== 'worker' || hardTurn) desired = 'high';
      else desired = 'medium';
      break;
    }
  }

  // Reconcile against the model's supported set (step down to nearest lower).
  return resolveSupported(desired, supported);
}
