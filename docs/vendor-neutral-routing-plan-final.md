# docs/vendor-neutral-routing-plan-final.md

## 1. Target Architecture

Current `main` is still vendor-biased: `DEFAULT_POLICY.providerOrderByTier` is Claude-first for all tiers at `src/core/policy.ts:47-50`, presets repeat it at `src/core/policy.ts:391-394` and `src/core/policy.ts:420-423`, and `route()` tries learned order then policy order at `src/core/route.ts:294-297`, `src/core/route.ts:463-491`.

Build a new deterministic router behind `MYSHELL_VENDOR_NEUTRAL_ROUTER=1` / `experimentalVendorNeutralRouter`, then graduate it to default-on with an explicit opt-out kill switch.

Control flow:

1. Build `ProviderInventory` from detected providers, auth, available models, OpenCode credential pools, capability registry, cooldowns, and session-token load.
2. Expand to `RoutingCandidate[]`: `{ provider, poolId, model, tier, capability, routingProfile }`.
3. Filter to authenticated and spawnable candidates only. No signed-out fallback.
4. Apply hard requirements from the curated registry: model availability, tier admission, context, vision, attachments/tool requirements. If no candidate remains, return typed `NoCapableProvider` instead of the current throw at `src/core/route.ts:166-170`.
5. Web search is soft: when current facts are needed, prefer search-capable candidates; if none exist, route normally and disclose.
6. Rank capable candidates by curated tier suitability from `src/core/model-capabilities.ts`, not provider name.
7. Among comparable candidates, apply `CostQuotaSignal`: cooldown, per-pool session-token load, current-session latency congestion, metered list price only for API-key metered rows.
8. Final tie-break: hidden config-file override, else alphabetical by stable candidate key `${provider}:${poolId}:${model}`.

Explicit non-goal: no outcome learning in routing. Remove `learnProviderOrder` and `learnModelOutcomeOrder` from the routing decision path (`src/core/routing-memory.ts:138`, `src/core/routing-memory.ts:333`; wired from `src/cli.ts:686-708`, `src/interface/menu.ts:1375-1385`). Also remove learned outcome input from `deriveLiveProviderOrder` (`src/core/capacity-allocator.ts:247`, `src/core/capacity-allocator.ts:265-272`) and stop passing it as `learnedProviderOrder` (`src/interface/menu.ts:2313-2320`, `src/interface/menu.ts:2527-2529`). Keep session-token load and 429 cooldowns because they are quota/load measurements, not quality learning.

## 2. Curated Capability And Quality Baseline

Current registry is too sparse for this job: schema lives at `src/core/model-capabilities.ts:81-96`; Claude/Codex/Grok have partial rows at `src/core/model-capabilities.ts:185-287`; OpenCode is empty at `src/core/model-capabilities.ts:287`.

Extend `ModelCapability` with a routable profile:

```ts
routingProfile: {
  tierSuitability: { worker: number; ic: number; manager: number }; // 0..100
  speedClass: 'fast' | 'balanced' | 'deep';
  quotaClass: 'subscription' | 'metered' | 'free' | 'unknown';
  searchMode?: 'native' | 'none' | 'unknown';
  poolHint?: 'claude' | 'codex' | 'grok' | 'opencode-go' | 'opencode-zen' | 'opencode-free';
  validation: { source: 'curated-self-test' | 'cli-metadata' | 'official-doc'; checkedAt: string };
}
```

Validation tests must fail the build when:

- Every `ProviderId` in `src/providers/port.ts:26` lacks at least one routable model per applicable tier.
- Every declared model lacks deterministic `tierSuitability` and `speedClass`.
- OpenCode GO, OpenCode Zen/free, Grok, Codex, and Claude are missing coverage.
- Search-capable rows are inconsistent with adapter support.
- A model selected by the router cannot be passed to its adapter.
- Unknown is represented honestly: absent capability never means false unless the row explicitly says false.

Dynamic refresh stays useful but is not the source of routing truth. `model-capability-refresh.ts` already merges detected models and Codex/OpenCode metadata (`src/core/model-capability-refresh.ts:155-216`, OpenCode verbose at `src/core/model-capability-refresh.ts:266-321`). Use it to validate/enrich context, efforts, vision, and tool flags. Do not let missing dynamic metadata erase the curated baseline.

## 3. OpenCode GO Vs Zen

Current code models only one provider ID: `opencode`, not `zen` (`src/providers/port.ts:26`). Detection reads OpenCode’s own auth file and counts any `type:"oauth"` or `type:"api"` credential (`src/providers/detect.ts:723-736`). It parses model IDs like `opencode-go/kimi-k2.6` and `opencode/...` from `opencode models` (`src/providers/detect.ts:809-823`, `src/providers/detect.ts:871-897`). Runner uses one binary and targets the pool by model ID: `opencode run --format json -m <provider/model>` (`src/providers/opencode.ts:90-98`, `src/providers/opencode.ts:166-172`).

Add `parseOpencodeCredentialPools(rawAuthJson)`:

- `opencode-go` credential key, usually OAuth/subscription -> pool `opencode-go`.
- `opencode` credential key with `type:"api"` -> pool `opencode-zen`.
- `opencode/*` models with no API credential -> pool `opencode-free`.
- `opencode-go/*` models always map to `opencode-go`.
- `opencode/*` models map to `opencode-zen` when the Zen API credential exists; otherwise `opencode-free`.
- If OpenCode cannot expose whether an `opencode/*` model is free vs Zen while both are present, be honest: treat it as one `opencode-zen-or-free` pool until `opencode models --verbose` exposes a reliable source. Do not fabricate separate headroom.

No new adapter is needed. Router returns `provider:'opencode'`, `model:'opencode-go/...'` or `model:'opencode/...'`, plus internal `poolId`. The runner remains `src/providers/opencode.ts`.

## 4. CostQuotaSignal

Cost means quota, not dollars.

Use real signals only:

- Per-pool session tokens. Today it is provider-keyed at `src/interface/menu.ts:1346-1354` and consumed at `src/core/capacity-allocator.ts:275-288`; change the key to `QuotaPoolId`, including `opencode-go` vs `opencode-zen`.
- 429 cooldowns. Existing cooldown is provider-keyed at `src/core/cooldown.ts:17-31` and updated at `src/interface/menu.ts:1634-1669`; add pool-aware cooldown where the failed run’s `model` can identify the pool.
- Observed current-session latency as congestion only, not quality learning. Reset each session; use only after curated suitability tie/comparable threshold.
- Metered API keys may use list price. Current `pricing.ts` `$0` rows for OpenCode/Grok are subscription sentinels, not router prices (`src/infra/pricing.ts:143-178`, `src/infra/pricing.ts:180-213`).

No provider exposes reliable remaining subscription headroom. The router must never display or rank by “remaining quota”. It can say “lower observed load” or “recently rate-limited”, not “more quota left”.

## 5. Cold Start Matrix

Turn 1 has zero learned history, zero session load, and no cooldown. Routing is therefore purely: auth -> hard capability -> curated suitability -> neutral tie.

Single-provider exact behavior:

| Auth subset | Worker | IC | Manager |
|---|---|---|---|
| `{opencode-go}` | best GO fast row, `opencode run -m opencode-go/...` | best GO balanced row | best GO strongest row |
| `{opencode-zen}` | best Zen/opencode fast row | best Zen balanced row | best Zen strongest row |
| `{opencode-go, opencode-zen}` | if suitability comparable, `opencode-go` on turn 1 by alphabetical pool key; next turn shifts toward Zen due pool-load | same | same |
| `{claude}` | Haiku row | Sonnet row | Opus row, if tier admitted |
| `{codex}` | best validated Codex worker row; do not pass stale hardcoded IDs | best validated Codex IC row | best validated Codex manager row |
| `{grok}` | `grok-composer-2.5-fast` | `grok-build` | `grok-build` |

Common mixes:

- Any single capable provider wins; no cross-provider assumption.
- If a hard requirement exists, incapable candidates are dropped first.
- If current facts are needed, search-capable candidates are preferred but never required.
- If multiple candidates have equal curated suitability, lower pool load wins; on turn 1 that is equal, so hidden override then alphabetical decides.
- All-provider cold start is not Claude-first. If the curated table gives equal manager suitability to top flagship models, alphabetical may choose Claude, but that is a documented neutral final tie, not a policy list.

## 6. Web Search

Current mismatch: `ProviderRequest.webSearch` documents Claude and Codex support plus OpenCode unknown at `src/providers/port.ts:67-78`, but `understanding-generator.ts` hardcodes Codex at `src/core/understanding-generator.ts:85-92`.

Required behavior:

- Add `supportsSearchTool` / `searchMode` rows for every model/provider where verified.
- Route soft-prefers native search for `needsWebSearch`.
- Request `webSearch:true` only when the selected model/provider capability says native search is supported.
- If no search-capable provider is authed, proceed without search and disclose “no authenticated provider with native web search”.
- Never hard-fail a user turn solely because search is unavailable.

## 7. PR Slices

Each slice ships green: `npm run typecheck`, targeted tests, and full-suite failure name-diff with zero new failing names versus the known pre-existing Windows/flaky baseline, not raw count.

1. Add router types and trace only: `ProviderInventory`, `RoutingCandidate`, `QuotaPoolId`, `RouteTrace`, `NoCapableProvider`. No call sites.
2. Add `experimentalVendorNeutralRouter` / `MYSHELL_VENDOR_NEUTRAL_ROUTER`, default off.
3. Add OpenCode pool parsing and tests for `opencode-go` OAuth plus `opencode` API/Zen. Do not change execution yet.
4. Extend `model-capabilities.ts` schema and add registry validation tests. Fill Claude, Codex, OpenCode GO, OpenCode Zen/free, Grok.
5. Replace `selectOpencodeModel` string heuristic (`src/core/opencode-model.ts:29-92`) with registry-backed selection, keeping fail-safe behavior.
6. Add pool-aware `CostQuotaSignal`; split subscription/free/unknown from list-price in `pricing.ts`.
7. Fix capacity allocator: add Grok to canonical coverage (`src/core/capacity-allocator.ts:21`) and remove learned outcome ordering from live order (`src/core/capacity-allocator.ts:247-272`).
8. Stop feeding routing-memory into routing from CLI/menu (`src/cli.ts:686-708`, `src/interface/menu.ts:1375-1385`, `src/interface/menu.ts:2313-2320`). Keep ledger stats only for diagnostics if desired.
9. Implement pure vendor-neutral route core and exhaustive provider-subset tests, including zero-history turn 1.
10. Wire sequential `runWorkCall` route calls (`src/core/work-call.ts:1146-1153`, `src/core/work-call.ts:1711-1718`, review routes at `src/core/work-call.ts:761-768`, `src/core/work-call.ts:1897-1904`) behind the flag.
11. Gate `goal-plan-generator.ts` effort: remove unconditional `reasoningEffort:'max'` at `src/core/goal-plan-generator.ts:133-140`; use registry-supported effort.
12. Validate/derive Codex model IDs: replace hardcoded `availableModels` at `src/providers/detect.ts:666-672`; adapter currently always passes `-m` at `src/providers/codex.ts:92-103`.
13. Make web search capability-driven everywhere, especially `understanding-generator.ts:85-92`.
14. Fix fabricated fallback provider labels in `orchestrate.ts:623-628` and `orchestrate.ts:749-754`; use real provider or `unknown`.
15. Wire panel/reviewer/hedge neutral selection: panel first-N/synthesizer at `src/core/ensemble.ts:108-157`, reviewer at `src/core/escalate.ts:52-57`, hedge route inputs at `src/core/hedge.ts:237-248`.
16. Graduate: flip router default on; retain explicit opt-out `MYSHELL_VENDOR_NEUTRAL_ROUTER=0`. Remove static provider-order policy as a routing input.

## 8. Risks / Unknowns

- Subscription headroom is unobservable. Cooldowns and per-pool token load are proxies, not quota remaining.
- OpenCode may not distinguish free `opencode/*` from Zen `opencode/*` in model IDs. If verbose metadata cannot prove it, treat them as one pool.
- Curated capability data will rot as CLIs and model IDs change. Registry validation and live optional smoke tests are mandatory.
- Codex IDs in current code are likely brittle (`src/providers/detect.ts:671`, `src/providers/codex.ts:92-103`).
- A bad curated score is worse than no score because the router will deterministically trust it. Require review discipline for registry edits.

## 9. Owner Questions

1. Is `opencode/*` with a Zen API key allowed to represent one combined Zen/free pool when the CLI cannot distinguish them?
2. Should hidden provider override be env/config only, with no UI forever?
3. Should `routing-memory.ts` be deleted after migration, or retained strictly for diagnostics/reporting?