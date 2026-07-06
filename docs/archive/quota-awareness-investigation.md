Read-only honored: I did not create or edit `docs/quota-awareness-investigation.md`. Markdown content:

```markdown
# Quota Awareness Investigation

## TL;DR

The highest-leverage buildable quota feature is **not a “% quota remaining” meter**. The real signals are: per-call tokens for Claude/Codex/OpenCode, provider rate-limit failures classified from stderr/error text, per-session token consumption, and Claude/Codex/OpenCode plan labels in limited cases. Build a **quota pressure surface + routing receipt**: show provider, tokens this turn/session, providers currently cooling down after 429/quota, and “headroom unknown” unless a provider actually exposes it. This ties directly into existing live machinery: token ledger writes in `src/core/work-call.ts:1400`, `src/core/work-call.ts:1407`; session token balancing in `src/interface/menu.ts:1346`, `src/interface/menu.ts:2313`; cooldown routing in `src/core/cooldown.ts:25`, `src/interface/menu.ts:1634`; and pressure shedding in `src/core/capability-budget.ts:192`. It helps “don’t run out” by avoiding recently throttled providers and exposing burn rate, preserves quality by not pretending false headroom, and improves speed by avoiding repeated 429 retries.

## Signal Inventory

| Provider | Quota / limit signal available? | Usable for headroom? |
|---|---|---|
| Claude | Token usage: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` in `src/providers/claude-parse.ts:35`; mapped at `src/providers/claude-parse.ts:61`; emitted on result at `src/providers/claude-parse.ts:214`. `rate_limit_event` exists but is ignored at `src/providers/claude-parse.ts:138`. 429/quota only via classified error text: `src/providers/errors.ts:100`. Claude plan/sub-tier may be detected from `subscriptionType`/`rateLimitTier`: `src/providers/detect.ts:100`, `src/providers/detect.ts:145`, `src/providers/detect.ts:422`. | **Partial only.** Tokens and Max 5x/20x tier are useful pressure context. No remaining quota, percent used, reset timestamp, Retry-After, 5-hour remaining, or weekly remaining is surfaced. |
| Codex | Token usage: `input_tokens`, `output_tokens`, `cached_input_tokens` in `src/providers/codex-parse.ts:55`; mapped at `src/providers/codex-parse.ts:80`; emitted on `turn.completed` at `src/providers/codex-parse.ts:191`. Rate-limit only via `turn.failed`/`error` text classification at `src/providers/codex-parse.ts:213`, `src/providers/errors.ts:100`. ChatGPT plan may be read from local auth token claim at `src/providers/detect.ts:250`, `src/providers/detect.ts:295`. | **No true headroom.** Tokens and plan label only. No remaining quota/reset/Retry-After fields in inspected parser/runner. |
| OpenCode | Token usage: `total`, `input`, `output`, `reasoning`, cache read/write in `src/providers/opencode-parse.ts:48`; mapped at `src/providers/opencode-parse.ts:104`; emitted on `step_finish` at `src/providers/opencode-parse.ts:230`; accumulated for final `done` at `src/providers/opencode-parse.ts:298`. Error text classified at `src/providers/opencode-parse.ts:261` and stderr at `src/providers/opencode.ts:243`. Plan is null for gateway/API creds; one exception for OAuth token claim at `src/providers/detect.ts:743`, `src/providers/detect.ts:765`. | **No true headroom.** Tokens only. No remaining quota/reset/Retry-After. |
| Grok | Parser explicitly says no usage/cost/tool events at `src/providers/grok-parse.ts:10`. `end` carries session id only at `src/providers/grok-parse.ts:73`. Error text classification exists at `src/providers/grok-parse.ts:89`. `grok models` exposes no plan label at `src/providers/detect.ts:922`. | **No.** No token totals, no quota fields, no plan, no reset. Only failures can be classified after the fact. |

## What The Product Already Does

Live:

- Rate-limit classification exists across providers through `classifyError`: quota/rate-limit patterns are `quota exceeded`, `rate limit`, `429`, `too many requests` at `src/providers/errors.ts:100`; category set at `src/providers/errors.ts:230`.
- Per-conversation cooldown is live: five-minute cooldown constant at `src/core/cooldown.ts:25`; never strands user if all providers cool down at `src/core/cooldown.ts:58`.
- UI captures providers that hit rate-limit events: `src/interface/ui/run-stream.ts:295`, legacy renderer equivalent `src/interface/render.ts:727`.
- Menu records cooldowns after a turn, including rescued failovers: `src/interface/menu.ts:1634`; writes cooldown expiry at `src/interface/menu.ts:1660`; tells user it will prefer other providers at `src/interface/menu.ts:1669`.
- Routing is cooled before orchestration: `availableAfterCooldown` is applied at `src/interface/menu.ts:2216`.
- Live quota pressure is derived from active cooldown count only: `src/interface/menu.ts:1126`; mapped by `pressureFromSignals` at `src/core/capability-budget.ts:214`.
- Shedding is live where wired: `decideShed` drops recap, narrows memory, skips intent pass as pressure rises at `src/core/capability-budget.ts:192`.
- Session token load balancing is live: ledger writes update `sessionConsumption` at `src/interface/menu.ts:1346`; existing session tokens seed from ledger at `src/interface/menu.ts:1370`; `deriveLiveProviderOrder` uses session tokens + cooldown at `src/core/capacity-allocator.ts:243`; menu computes live order at `src/interface/menu.ts:2313` and passes dynamic order into deps at `src/interface/menu.ts:2525`.
- Work-call has rate-limit failover and draft salvage: rate-limit draft guard at `src/core/work-call.ts:1715`; failover pool set at `src/core/work-call.ts:1754`.
- Scheduler path has separate pressure/backoff: cooldown map at `src/core/scheduler.ts:396`; active-limit recompute from live cooldowns at `src/core/scheduler.ts:444`; requeue/backoff on rate-limit at `src/core/scheduler.ts:540`.

Dark / partial:

- `capacity-allocator` is not true quota; it weights plan labels and session token load: `src/core/capacity-allocator.ts:42`, `src/core/capacity-allocator.ts:274`.
- `capability-budget` says it is advisory, not a hard runtime governor: `src/core/capability-budget.ts:5`.
- Governor pressure is gated: only threaded when governor enabled at `src/interface/menu.ts:2603`.
- Evidence receipt is default-on and still prints dollar cost: flag default-on at `src/interface/ui/evidence-receipt-flag.ts:20`; renderer prints `Cost:` at `src/interface/render.ts:938`.

## Honest Gaps

- No provider exposes “remaining quota”, “tokens remaining”, “percent used”, “reset at”, “5-hour window remaining”, weekly remaining, or Retry-After in the inspected parse/run modules.
- Claude `rate_limit_event` is currently discarded and no payload fields are parsed: `src/providers/claude-parse.ts:138`.
- Grok gives no token usage at all in streaming JSON: `src/providers/grok-parse.ts:10`.
- Token totals are real when the CLI reports them, but they are not equivalent to provider subscription headroom. For Claude resumed native sessions, token counts may be marginal scope: `docs/cost-attribution-diagnosis.md:61`.
- Ledger `usd` still exists in schema at `src/core/types.ts:192`; it must not be presented as a subscription bill.

## Ranked Opportunities

| Rank | Item | Grounded in real signal | Fix sketch | Risk | Impact |
|---|---|---|---|---|---|
| 1 | Quota pressure receipt: provider, model, tokens this turn, session tokens by provider, cooled providers, headroom unknown | Usage events: `src/providers/port.ts:28`; ledger writes: `src/core/work-call.ts:1400`; cooldown: `src/interface/menu.ts:1660`; session tokens: `src/interface/menu.ts:1346` | Add a compact receipt line after completion: `Claude Sonnet · 18.2k tokens this turn · 91k Claude session tokens · Codex cooling 3m · remaining quota unknown`. | Low. Must avoid fake percent remaining. | Highest: directly serves “don’t run out” without inventing unavailable data. |
| 2 | Make existing quota routing visible | Live order already computed at `src/interface/menu.ts:2313`; dynamic order passed at `src/interface/menu.ts:2525` | When order changes due to cooldown/session load, surface one concise notice. | Low/medium: avoid noisy notices. | High: user can trust why routing changed and see quota protection working. |
| 3 | Use token velocity as a proxy, not headroom | Tokens available for Claude/Codex/OpenCode parse modules; `summarizeSpend` has today/total tokens at `src/infra/insights.ts:65` | Show session token rate and per-provider totals. Label as consumption, not remaining. | Medium: users may infer false quota unless wording is strict. | Medium/high: useful for behavior change, not exact exhaustion prediction. |
| 4 | Receipt/ledger reframe: remove default dollar receipt | `cost` command already hides normal dollar figures at `src/commands/cost.ts:144`; evidence receipt still prints dollars at `src/interface/render.ts:938` | Replace receipt `Cost:` with tokens/cache/aux calls. Keep `usd` internal for legacy/routing ratio only. | Low. Schema can remain. | Medium: eliminates misleading subscription-dollar UX. |
| 5 | Parse Claude `rate_limit_event` only if payload has real fields | Event currently ignored at `src/providers/claude-parse.ts:138` | Add typed parsing for reset/retry fields only if fixtures/live output proves fields exist. Otherwise keep ignored. | Medium: needs fixtures; do not guess payload shape. | Potentially high, but currently unproven. |

## Recommendation

Quota-awareness is worth building now **only as a pressure/consumption/cooldown system**, not as a quota-remaining meter. The honest feature is: “what did this turn/session burn, what provider is cooling down, what routing changed because of it, and what headroom is unknown.” The code already has most of the hard systems behavior; the missing product lever is making it visible and removing the remaining dollar-shaped receipt surface.
```