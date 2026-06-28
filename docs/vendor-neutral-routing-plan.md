I could not write `docs/vendor-neutral-routing-plan.md` because this session is read-only and approval is disabled. Below is the plan document content.

# Vendor-Neutral Routing Plan

## Current Verified State

The audit is directionally right, but current `main` differs in one important detail: `src/core/policy.ts:47-50` is now `claude, codex, opencode, grok` for every tier, not worker `opencode`-first. The presets repeat that order at `src/core/policy.ts:391-394` and `src/core/policy.ts:420-423`. This is still vendor bias.

Other confirmed coupling:

- `route()` tries learned order first, then static policy order: `src/core/route.ts:294-297`, auth-aware selection at `src/core/route.ts:463-470`.
- Capability prepasses exist but sit on top of static provider order: hard vision/context at `src/core/route.ts:300-404`, soft web search at `src/core/route.ts:406-455`.
- Learned routing is vendor-neutral and observed-only: success/latency only at `src/core/routing-memory.ts:14-20`, min runs at `src/core/routing-memory.ts:118-129`, alphabetical final tie at `src/core/routing-memory.ts:154-160`.
- Capacity allocator omits Grok: `src/core/capacity-allocator.ts:21`; unknown providers sort badly through `indexOf` at `src/core/capacity-allocator.ts:328-329`.
- OpenCode declarative capability rows are empty: `src/core/model-capabilities.ts:287`, though dynamic `opencode models --verbose` parsing already exists at `src/core/model-capability-refresh.ts:227-241`.
- Goal planner forces `reasoningEffort: 'max'`: `src/core/goal-plan-generator.ts:133-140`.
- Codex model IDs are hardcoded in detection: `src/providers/detect.ts:666-672`; adapter always emits `-m <model>` at `src/providers/codex.ts:92-103`.
- Understanding web search is Codex-only: `src/core/understanding-generator.ts:85-92`, despite `ProviderRequest.webSearch` documenting Claude and Codex support at `src/providers/port.ts:67-76`.
- Pricing uses subscription `$0` sentinels for OpenCode/Grok: `src/infra/pricing.ts:143-151`, `src/infra/pricing.ts:180-183`.
- Zen is not a provider ID: `src/providers/port.ts:26`; it is an OpenCode API/gateway credential per `src/providers/detect.ts:826-831`.
- Fallback event labels fabricate Claude at `src/core/orchestrate.ts:623-628` and `src/core/orchestrate.ts:749-754`.
- Panel and reviewer selection consume caller order directly: panel first N at `src/core/ensemble.ts:108-157`, reviewer `available.find(id !== primary)` at `src/core/escalate.ts:52-57`.

## Target Architecture

Add a new pure router, default-off behind `MYSHELL_VENDOR_NEUTRAL_ROUTER` / `config.experimentalVendorNeutralRouter`.

Pipeline:

1. Build `ProviderInventory` from `deps.providers`, `authenticatedProviders`, `availableModels`, `planInfos`, capability registry, capacity weights, cooldowns, and optional user `providerOrder`.
2. Filter to authenticated and spawnable providers only. No signed-out fallback in the new path.
3. Expand provider/model candidates per tier using `availableModels`, pricing aliases, OpenCode selected models, and capability registry.
4. Apply hard requirements: vision, large context, native web search when the turn requires current facts, tool/file attachment support, and concrete model availability. Known-incapable candidates are dropped. If no candidate can satisfy a hard requirement, return a typed “no capable provider” result with an honest user-facing limitation rather than silently running a wrong provider.
5. Apply learned outcome ranking when `learnProviderOrder` / model outcome data has enough observations. Reuse `routing-memory.ts`; it is already vendor-neutral.
6. Rank cold-start remainder by `CostQuotaSignal`, not raw `pricing.ts` dollars:
   - `metered`: real list price from pricing table.
   - `subscription-included`: no marginal dollar price; rank by quota pressure, latency, reliability.
   - `credit/gateway`: e.g. Zen/OpenCode API credit where balance is unknown; rank as `unknown` unless a reliable local signal exists.
   - `unknown`: no fabricated price.
7. Apply tier bias:
   - `worker`: prefer low quota pressure, low latency, low metered cost after capability.
   - `ic`: balance success/reliability, latency, quota pressure.
   - `manager`: capability and learned success first; cost/quota only breaks real ties.
8. Final tie-break: explicit user provider order, else alphabetical provider id. No built-in vendor list.

Claude-first for IC/manager should be removed. If the owner wants a cold-start prior, it must be capability-backed, explicit, documented, and lower priority than auth, hard capabilities, learned outcomes, and quota pressure.

## Provider Matrix

| Authenticated setup | Worker | IC | Manager | Why |
|---|---|---|---|---|
| `{opencode}` | OpenCode model from `opencode models` | same | same | Single provider wins if it has a tier-capable model; otherwise honest limitation. |
| `{claude}` | Claude | Claude | Claude if admitted | Single provider; no cross-vendor assumptions. |
| `{codex}` | Codex detected/cached model | same | same | Must validate model IDs or omit stale `-m` safely. |
| `{grok}` | Grok | Grok | Grok | Add Grok to neutral capacity logic; large-context can prefer `grok-build`. |
| `{zen}` | OpenCode/Zen credential | same | same | Today this is `opencode`; UX must say “OpenCode-backed Zen” unless `zen` becomes a provider ID. |
| `{claude,codex}` | Learned/cost/quota winner | capability/learned winner | capability/learned winner | Web/vision/current-fact turns route to a capable provider; otherwise no vendor prior. |
| `{claude,opencode}` | Often OpenCode if capable and lower pressure | learned/capability winner | capable manager model | OpenCode is not preferred by name, only by real model/cost/quota facts. |
| `{codex,grok}` | learned/pressure winner | large context may prefer Grok | large context may prefer Grok | Search-capable tie resolves by learned/cost/user order/alphabetical. |
| all providers | requirement-specific | requirement-specific | requirement-specific | Auth + capability first, learned next, cost/quota next, neutral tie last. |

## Must Add

- `ProviderInventory`, `TurnRequirements`, `CandidateModel`, `RouteRankTrace`, and typed “no capable route” result.
- `CostQuotaSignal` abstraction separate from `pricing.ts`:
  `billingKind`, real list price when metered, quota pressure, capacity weight, cooldown, learned latency, source/confidence.
- User-configurable provider order for final tie-break only.
- Capability coverage for all providers:
  OpenCode dynamic verbose rows, Grok complete rows, Claude/Codex search/vision/tool facts, and explicit unknown handling.
- Codex model validation/derivation from local cache or detected models, with stale hardcoded IDs treated as fallback only.
- Capability-driven web search in every path, especially `understanding-generator.ts`.
- Neutral selection helpers for panel candidates, reviewers, hedge, failover, goal planners, recap, and aux passes.
- Zen UX/type decision: either keep as `opencode` credential with clear labels, or introduce a separate `zen` provider ID and migrate every union/table.

## PR Slices

1. Add pure router data types and rank trace behind flag. No live call sites. Gate: `tsc`, unit tests, name-diff unchanged.
2. Add `CostQuotaSignal`; split pricing list-price from subscription/unknown sentinels. Existing cost accounting unchanged when flag off.
3. Add neutral capacity helpers including Grok; leave old allocator output byte-identical off-flag.
4. Fill capability coverage: OpenCode verbose merge hardening, Grok rows, Claude/Codex search/tool facts, tests for unknown vs incapable.
5. Gate `goal-plan-generator.ts` reasoning effort through capability lookup; off path keeps current `max`.
6. Validate Codex model IDs from local cache/detection; stale IDs must not brick Codex-only users.
7. Replace Codex-only understanding web-search check with capability-driven check.
8. Implement vendor-neutral route core and snapshot tests for provider combinations.
9. Wire sequential work/failover/review under flag.
10. Wire panel, hedge, goal planner, recap, and preflight aux passes under flag.
11. Fix fallback event provider labels; use real provider or `unknown`, never fabricated Claude.
12. Resolve Zen model/UX and update login/doctor/tool-state copy.
13. Promote: remove static provider-order policy only after characterization confirms default behavior or migration decision.

## Risks / Unknowns

- Capability metadata is incomplete and partly CLI-version-dependent.
- Subscription quota pressure is not directly observable for most providers; cooldown/session load is only a proxy.
- `$0` subscription rows are unusable for “cheapest” routing.
- Learned order is cold-start weak; neutral tie-breaks must be acceptable.
- Zen may be credits, gateway, or subscription depending setup; current type model cannot express that.
- “No capable provider” must be designed as a graceful product state, not a crash.

## Owner Questions

1. Should Zen remain an OpenCode credential, or become first-class `zen`?
2. Should IC/manager have any explicit cold-start capability prior, or pure neutral ranking only?
3. What should “cost” mean for your subscriptions: quota preservation, latency, reliability, or dollars only for metered API keys?
4. Should web search be a hard requirement when requested, or soft best-effort with disclosure?
5. Do you want user provider order exposed in config/UI, or config-file-only initially?