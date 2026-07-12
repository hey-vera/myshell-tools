# Vendor-Neutral Routing Build Spec

## 0. Current Anchors

Current `main` is Claude-first everywhere: `src/core/policy.ts:47-50`, `src/core/policy.ts:391-394`, `src/core/policy.ts:420-423`. The older upstream audit’s “opencode-first worker” claim is stale; the bias to remove now is Claude-first across worker, IC, and manager.

Do not change flag-off behavior before graduation. Today `route()` still accepts learned provider order first (`src/core/route.ts:289-297`, `src/core/route.ts:458-483`), menu derives it (`src/interface/menu.ts:2313-2320`) and passes it into deps (`src/interface/menu.ts:2527-2531`), and CLI one-shot does the same (`src/cli.ts:686-708`, `src/cli.ts:760-766`). Those paths remain byte-identical until the new router is active or graduated.

## 1. Final Architecture

Add a deterministic router behind `MYSHELL_VENDOR_NEUTRAL_ROUTER=1` / `config.experimentalVendorNeutralRouter === true`. End state is default-on with explicit opt-out `MYSHELL_VENDOR_NEUTRAL_ROUTER=0` or `config.experimentalVendorNeutralRouter === false`. No UI provider menu.

Replace the current no-provider throw at `src/core/route.ts:166-170` with typed routing results:

```ts
type RouteResult = { ok: true; decision: RouteDecision; trace: RouteTrace }
  | { ok: false; error: NoCapableProvider; trace: RouteTrace };
```

Router flow:

1. Build `ProviderInventory` from detected provider status, auth, live available models, registry, OpenCode verbose facts, cooldowns, and session token load.
2. Expand to `RoutingCandidate[]`: `{ provider, poolId, model, tierAdmission, capability, routingProfile }`.
3. Filter to authenticated and spawnable candidates only. No signed-out fallback.
4. Apply hard requirements: tier admission, context, vision, attachment support, tool/search request compatibility, adapter passability.
5. For web-search turns, soft-prefer native search-capable candidates. If none exist, route normally and disclose.
6. Rank by provider-specific baseline:
   - Claude/Codex/Grok: curated, tested registry rows.
   - OpenCode: deterministic `opencodeTierRank()` from live facts, not static curation.
7. Unknown capability is not neutral for all tiers. Unknown candidate admission is worker floor only: it may satisfy worker routing, never IC or manager.
8. Among comparable candidates, apply `CostQuotaSignal`.
9. If still truly equal: lowest normalized pool load, then stable session-hash rotation across pools. No lexical/alphabetical provider tie-break.

A hidden override may exist only as env/config-file, never UI. It may pin or exclude pools after hard capability filtering, but must not resurrect signed-out or incapable candidates. Without explicit override, final equality is resolved only by load then session hash.

No runtime outcome-learning in routing. Cooldown, pool token load, and current-session congestion are allowed because they measure capacity/load, not quality. `routing-memory.ts` remains diagnostics/reporting-only after migration and can be deleted later if unused.

## 2. Capability Registry And Validation

Current schema is `src/core/model-capabilities.ts:74-114`; Claude rows lack search (`src/core/model-capabilities.ts:186-227`), Codex/Grok declare search (`src/core/model-capabilities.ts:229-284`), and OpenCode is empty (`src/core/model-capabilities.ts:287`).

Extend each routable row with:

```ts
routingProfile: {
  tierSuitability: { worker: number; ic: number; manager: number }; // 0..100
  tierAdmission: { worker: boolean; ic: boolean; manager: boolean };
  speedClass: 'fast' | 'balanced' | 'deep';
  quotaClass: 'subscription' | 'metered' | 'free' | 'unknown';
  searchMode: 'native' | 'none' | 'unknown';
  poolHint?: QuotaPoolId;
  validation: {
    source: 'curated-table' | 'opencode-live-rank' | 'official-doc' | 'cli-metadata';
    checkedAt: string;
    overrideReason?: string;
  };
}
```

Validation must fail the build, not warn, on these invariants:

- Every `ProviderId` from `src/providers/port.ts:26` has routable coverage when authenticated.
- Every curated Claude/Codex/Grok model has deterministic tier suitability, tier admission, speed class, quota class, and search mode.
- OpenCode is not required to have static rows; it must have tests proving `opencodeTierRank()` runs on live/detected facts.
- Search registry matches adapter support: Claude supports native search via `--allowedTools WebSearch WebFetch` (`src/providers/claude.ts:171-181`, documented at `src/providers/port.ts:74-78`), Codex supports it via `tools.web_search` (`src/providers/codex.ts:108-114`), Grok enables/disables native search (`src/providers/grok.ts:33-34`, `src/providers/grok.ts:138-140`), OpenCode stays unknown/none unless verified.
- A selected model must be passable to its adapter: Claude `--model` (`src/providers/claude.ts:143-144`), Codex `-m` (`src/providers/codex.ts:92-93`), Grok `-m` (`src/providers/grok.ts:110-114`), OpenCode concrete IDs only when they contain `/` (`src/providers/opencode.ts:87-93`).
- Unknown/absent facts never satisfy hard requirements.
- Unknown/uncurated models cannot have IC or manager admission unless objective facts prove it.
- Pricing/detect/registry candidate IDs must agree. Reconcile Codex extras in pricing (`src/infra/pricing.ts:121-140`) with detect (`src/providers/detect.ts:671`) and registry (`src/core/model-capabilities.ts:229-263`), or exclude them from candidates.

Fact-monotonicity self-test:

- A model cannot have `tierAdmission.manager === true` unless it has known manager-required facts: known context window at or above the manager threshold, adapter passability, and no explicit missing support for required attachments/tools.
- A model cannot have `tierAdmission.ic === true` unless context/tool facts meet IC thresholds or a curated override supplies `overrideReason`.
- Within the same provider, if model A dominates model B on known objective facts relevant to IC/manager, A’s IC/manager suitability must be `>=` B’s unless B has an explicit `overrideReason`.
- Worker suitability may favor faster/smaller models, but it must be justified by `speedClass`.
- `tierSuitability` values must be integers `0..100`.
- `searchMode:'native'` requires adapter support and a test proving `ProviderRequest.webSearch` reaches the CLI.
- Optional live smoke: for each authed model, run a trivial prompt and assert spawn success plus ordering sanity. This can be skipped offline, but the static monotonicity test cannot.

## 3. OpenCode Ranking And Pools

OpenCode has no stable static registry: `DECLARATIVE_MODEL_CAPABILITIES.opencode = []` at `src/core/model-capabilities.ts:287`; live models come from `opencode models` (`src/providers/detect.ts:809-823`, `src/providers/detect.ts:871-897`) and verbose facts from `opencode models --verbose` (`src/core/model-capability-refresh.ts:90-93`, `src/core/model-capability-refresh.ts:266-321`).

Define `opencodeTierRank(modelId, verboseFacts, credentialHints)` as pure and deterministic.

Inputs:

- `modelId`, e.g. `opencode-go/kimi-k2.7-code` or `opencode/deepseek-v4-flash-free`.
- Prefix-derived provider pool.
- `limit.context` and `limit.output` parsed into context/output (`src/core/model-capability-refresh.ts:375-402`).
- `capabilities.reasoning`.
- `variants[].level` parsed into supported reasoning efforts (`src/core/model-capability-refresh.ts:418-424`).
- Model-id morphology only for generic modifiers: `free`, `fast`, `flash`, `turbo`, `mini`, `nano`, `lite`, `pro`, `max`, `plus`, `large`, `xl`.
- Credential hints: presence of API or OAuth credential is a hint, never the source of pool identity.

Admission rule:

- Worker: any authenticated, spawnable OpenCode model is admitted.
- IC: admitted only if known context is `>= 128_000` or known context is `>= 64_000` plus reasoning support.
- Manager: admitted only if known context is `>= 128_000`, known output is present or unknown-not-needed for the adapter, and either reasoning support exists or deep morphology exists (`pro|max|large|xl`). If context is unknown, manager admission is false.
- If only `opencode models` exists with no verbose facts, the model is worker-only.

Scoring rule:

- `ctxBand`: unknown `0`, `<64k 0`, `64k 1`, `128k 2`, `256k 3`, `512k 4`, `1M+ 5`.
- `outBand`: unknown `0`, `<8k 0`, `8k 1`, `16k 2`, `32k 3`, `64k+ 4`.
- `reasonBand`: none/unknown `0`, reasoning true no variants `1`, max supported effort among `low=1`, `medium=2`, `high=3`, `xhigh=4`, `max=5`.
- `speedClass`: `fast` for `fast|flash|turbo|mini|nano|lite`, `deep` for `pro|max|large|xl` or `reasonBand >= 4 && ctxBand >= 3`, otherwise `balanced`.
- `freeFlag`: `true` if model id contains `free`.

Suitability:

```ts
worker = clamp(40 + fastBonus + freeBonus + ctxBand*3 + reasonBand*2 - deepPenalty, 0, 100)
ic      = admitted.ic
  ? clamp(35 + balancedBonus + ctxBand*5 + reasonBand*5 + outBand*2 - freePenalty, 0, 100)
  : 0
manager = admitted.manager
  ? clamp(20 + deepBonus + ctxBand*7 + reasonBand*8 + outBand*3 - freePenalty*10, 0, 100)
  : 0
```

Where:

- `fastBonus`: fast `20`, balanced `10`, deep `0`.
- `freeBonus`: `10` if free.
- `deepPenalty`: `10` if deep.
- `balancedBonus`: balanced `20`, deep `15`, fast `10`.
- `deepBonus`: deep `25`, balanced `10`, fast `0`.
- `freePenalty`: `1` if free else `0`.

Pool identity is prefix-derived:

- `opencode-go/*` -> `opencode-go`.
- `opencode/*` -> `opencode-zen-or-free` unless future CLI facts prove Zen vs free separately.
- If future facts prove it, split into `opencode-zen` and `opencode-free`.
- Bare placeholder `opencode` is `opencode-unknown-default`; because `src/providers/opencode.ts:90-93` omits `-m`, the actual pool is unknowable, so rate-limit cooldown applies broadly to all OpenCode pools. This must be rare and only when detection returns no models.

Do not derive GO/Zen from `auth.json` key names. Detection currently counts credential values by type, not key identity (`src/providers/detect.ts:713-736`). Auth parsing is only a soft hint.

## 4. CostQuotaSignal

Cost means quota/load, not dollars.

Signals:

- Per-pool session token load. Current menu accounting is provider-keyed (`src/interface/menu.ts:1346-1354`); change it to `QuotaPoolId`, deriving pool from `LedgerEntry.provider/model` (`src/core/types.ts:181-189`).
- Per-pool cooldown. Current cooldown is provider-keyed (`src/core/cooldown.ts:17-55`) and menu records provider cooldowns (`src/interface/menu.ts:1634-1669`). Re-key to pool where model identifies pool; placeholder OpenCode cools all OpenCode pools.
- Current-session latency congestion only, reset per session. It is not quality learning.
- Metered list price only for future API-key-metered rows. Subscription rows and `$0` sentinel rows in `src/infra/pricing.ts:143-213` are not dollar-ranking inputs.

No provider exposes reliable remaining subscription headroom. UI and traces may say “lower observed load” or “recent rate limit,” never “more quota remaining.”

Comparable threshold: if top tier suitability differs by more than 5 points, suitability wins. If within 5 points, use CostQuotaSignal: not cooled, lower normalized pool load, lower current-session latency congestion. If still equal, use session-hash rotation.

Session-hash rotation:

```ts
hash(`${sessionId}:${candidate.poolId}:${candidate.provider}:${candidate.model}`) ascending
```

This spreads cold-start ties across sessions and prevents systematic Claude-first or alphabetical bias.

## 5. Cold-Start Matrix

Turn 1 has no learning, zero load, and no cooldown. Selection must be auth -> hard capability -> baseline suitability -> load/hash, never provider enum order.

Singletons:

| Auth subset | Worker | IC | Manager |
|---|---|---|---|
| `{claude}` | curated Haiku worker row | curated Sonnet IC row | curated Opus manager row if admitted |
| `{codex}` | best validated Codex worker row | best validated Codex IC row | best validated Codex manager row |
| `{grok}` | `grok-composer-2.5-fast` | `grok-build` | `grok-build` |
| `{opencode-go}` | highest worker score from `opencode-go/*` | highest admitted IC score from `opencode-go/*`, else typed no-capable for IC | highest admitted manager score from `opencode-go/*`, else typed no-capable |
| `{opencode-zen-or-free}` | highest worker score from `opencode/*` | highest admitted IC score from `opencode/*` | highest admitted manager score from `opencode/*` |

Required provider-combination behavioral tests:

- All 10 pairs across `claude`, `codex`, `grok`, `opencode-go`, `opencode-zen-or-free`.
- Representative triples including `{claude,codex,grok}`, `{claude,opencode-go,opencode-zen-or-free}`, `{codex,grok,opencode-go}`.
- All-provider cold start.
- Every test asserts the selected model is selected by score/load/hash rules, not by array order.
- Unknown model in any mix is worker-only and cannot win IC/manager by absence.
- When hard requirements exist, incapable candidates are dropped before ranking.
- When web search is needed, native-search candidates are preferred if present; otherwise route normally and disclose.

## 6. Web Search

Make search capability-driven everywhere.

Registry must mark Claude native search because the port documents Claude+Codex support (`src/providers/port.ts:74-78`) and Claude appends `--allowedTools WebSearch WebFetch` (`src/providers/claude.ts:171-181`). Existing hardcoded Codex-only logic in `src/core/understanding-generator.ts:85-92` must be replaced.

Rules:

- `ProviderRequest.webSearch:true` is set only when selected candidate has `searchMode:'native'`.
- If no native-search authenticated provider exists, proceed without search and disclose: `no authenticated provider with native web search`.
- Web search is never a hard failure condition.
- Audit Grok/OpenCode honestly: Grok native unless disabled (`src/providers/grok.ts:33-34`, `src/providers/grok.ts:138-140`); OpenCode unknown/none unless verified.

## 7. Re-Sequenced PR Slices

Every slice ships green: `npm run typecheck`, targeted tests, and full-suite failure-name diff showing zero new failing names versus the known pre-existing Windows/flaky baseline, not raw count. Pre-graduation flag-off behavior must be byte-identical.

1. Add router result/types only: `ProviderInventory`, `RoutingCandidate`, `QuotaPoolId`, `RouteTrace`, `NoCapableProvider`, route union. No call sites.
2. Add flag resolver: default off, env/config on; no behavior changes.
3. Add registry schema fields and validation harness. Fill curated Claude/Codex/Grok routing profiles, including Claude search. Do not consume in old router.
4. Add `opencodeTierRank()` and tests from synthetic verbose facts plus detected-only worker-floor cases.
5. Add `poolForModelId()` prefix-derived pools and tests. Credential parsing only emits hints.
6. Add pool-aware ledger/session-load helpers without changing live routing.
7. Add pool-aware cooldown helpers without changing live routing.
8. Add pure vendor-neutral route core behind flag, including typed `NoCapableProvider`, unknown worker floor, load/hash tie-break, and exhaustive cold-start/provider-combo tests.
9. Wire new router behind flag into sequential `runWorkCall` route sites (`src/core/work-call.ts:1146-1152`, `src/core/work-call.ts:1711-1717`) only when flag on.
10. Wire review route sites behind flag (`src/core/work-call.ts:761-768`, `src/core/work-call.ts:1897-1906`).
11. Wire hedge route input behind flag (`src/core/hedge.ts:237-248`).
12. Wire panel seating behind flag: replace first-N/synthesizer-first behavior (`src/core/ensemble.ts:108-157`) with suitability-ranked candidates and highest manager-suitability synthesizer.
13. Wire reviewer choice behind flag: replace first-different reviewer (`src/core/escalate.ts:52-57`) with highest-suitability cross-vendor reviewer.
14. Make web search capability-driven behind flag in understanding/research/work/panel paths, including `src/core/understanding-generator.ts:85-145`.
15. Gate goal-planner effort by registry support; remove unconditional `reasoningEffort:'max'` at `src/core/goal-plan-generator.ts:119-139`.
16. Reconcile Codex candidate IDs across pricing/detect/registry; stop orphan pricing rows from becoming neutral candidates.
17. Fix fabricated fallback labels in `src/core/orchestrate.ts:623-628` and `src/core/orchestrate.ts:749-754`; use real provider or `unknown`.
18. Default-on graduation: router on by default with explicit opt-out. Static provider order remains only legacy/opt-out input.
19. After graduation only: remove learned ordering from routing paths. Stop feeding `routing-memory` into route decisions from CLI/menu and remove `learnedOutcomeOrderByTier` from `deriveLiveProviderOrder`. Keep routing-memory diagnostics/reporting only.
20. Cleanup legacy `selectOpencodeModel` heuristic (`src/core/opencode-model.ts:29-92`) only after new OpenCode ranking is proven in default-on routing.

## 8. Risks And Mitigations

Bad curated score: deterministic routers fail consistently. Mitigation: build-failing registry validation, fact-monotonicity, explicit override reasons, and provider-combination behavioral tests.

Registry rot: CLI model IDs change. Mitigation: curated table only for Claude/Codex/Grok tested IDs; OpenCode uses live deterministic ranking; Codex detect/pricing/registry must be reconciled.

Unknown model promotion: forbidden. Unknown capability is worker-floor only.

Quota headroom is unobservable. Mitigation: use real proxies only: session token load, cooldown, latency congestion. Never rank by claimed remaining quota.

Silent quality degradation will not be learned by routing by design. Mitigation is downstream verify, escalation, cross-vendor review, and panel synthesis, not outcome-learning in the router.
