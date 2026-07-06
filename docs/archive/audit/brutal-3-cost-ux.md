# Brutal Audit 3: Cost, Guardrails, UX Reality

## Guardrail verdict

**FAIL.** `myshell-tools` is not subscription-OAuth-only as implemented. Claude and Codex paths mostly respect subscription/OAuth boundaries, but OpenCode explicitly instructs users to create and paste an API key, and provider detection treats OpenCode API-key credentials as authenticated. That violates the stated guardrail: no API keys, no metered services, no ambiguity.

No embeddings or vector DB usage surfaced in the audited paths. Codex `web_search` is invoked through the Codex CLI/subscription path, not a direct external API key path. The hard guardrail failure is OpenCode API-key acceptance and messaging.

## Ranked findings

### CRITICAL: OpenCode breaks the subscription-OAuth-only guardrail

`src/commands/login.ts:27-30` tells the user to run `opencode auth login -p opencode`, create an API key at `https://opencode.ai/auth`, and paste it into OpenCode. `src/commands/login.ts:98-102` repeats that OpenCode setup uses provider account tiers while emphasizing `myshell` does not receive the key.

That distinction is not enough. The product-level rule is subscription-OAuth only: no API keys. Whether `myshell` stores the key is secondary if the official setup path tells the user to create one.

The detector also accepts API-key auth as valid auth. `src/providers/detect.ts:153-158` says the OpenCode fallback credential file may contain an OAuth token or API key, and `src/providers/detect.ts:165-168` returns true when `primaryApiKey` exists. `src/providers/detect.ts:373-383` then treats any `opencode auth list` credential as authenticated without distinguishing subscription OAuth from API-key auth.

This is a direct guardrail violation, not a wording issue.

### HIGH: First-turn and startup latency can silently absorb up to 10 seconds for OpenCode capability refresh

The new capability refresh path can spawn `opencode models --verbose` once per chat session. `src/infra/model-capability-port.ts:29-35` sets a 10,000 ms timeout, and `src/infra/model-capability-port.ts:69-87` actually runs `opencode models --verbose`.

The chat session awaits this refresh before capability summary setup. `src/interface/menu.ts:3533-3550` creates a once-per-session refresh, `src/interface/menu.ts:3553-3567` awaits `refreshCapabilities(...)`, and `src/interface/menu.ts:4308-4310` blocks the first normal turn on `resolveCapabilitySummaryOnce()`.

This is fail-soft, but not latency-soft. If OpenCode is installed and slow, the user can pay cold-start lag before the assistant answers. Provider detection has similar OpenCode CLI timeout exposure around `opencode auth list` and `opencode models` in `src/providers/detect.ts:426-453`.

### HIGH: The "one extra blocking call" budget is not true in real chat paths

`src/core/capability-budget.ts:31-47`, `src/core/capability-budget.ts:57-82`, and `src/core/capability-budget.ts:89` frame the system as having a bounded extra-call budget, with one blocking added call before the answer. The live chat loop can exceed that.

Smart routing is enabled by default and can spawn a worker classifier for ambiguous turns. `src/infra/config.ts:90-98` documents the default and the expected 5-10 second cost. `src/core/router.ts:204-219` runs the model classifier when deterministic routing does not decide. `src/interface/menu.ts:4406-4419` wires that classifier with a 20 second timeout.

Intent extraction is also enabled by default. `src/infra/config.ts:129-139` documents it, `src/interface/menu.ts:4422-4440` wires it with an 8 second timeout, and `src/core/orchestrate.ts:482-507` awaits it before the main provider call when the intent gate says yes. `src/core/intent.ts:417-437` makes that likely on substantial, manager, long, multi-clause, or collaborative turns.

Resume recap is another blocking path. `src/interface/menu.ts:3488-3523` builds an 8 second worker-tier recap generator, `src/interface/menu.ts:3627-3639` awaits generation, and `src/interface/menu.ts:3714-3726` can run it during resume before the prompt is ready. That contradicts the "background-only" flavor of the budget notes.

Net: a hard turn can incur smart-route classification, intent extraction, recap on resume, capability refresh, then the actual answer. The code has pieces of budget awareness, but the user-facing latency story is still over-optimistic.

### HIGH: Effort knobs, web search, panel, hedge, and reviews can burn quota/rate limits fast

Defaults are not maximal, but the feature set makes it easy to stack expensive behavior.

Reasoning effort can escalate aggressively. `src/core/route.ts:621-631` defines the effort policy, and `src/core/route.ts:660-684` maps Balanced manager hard turns to `xhigh` and quality-first hard manager turns to `max`. Those flags are passed through to providers at `src/providers/claude.ts:147-157`, `src/providers/codex.ts:101-103`, and `src/providers/opencode.ts:95-98`.

Codex web search is enabled when the engagement plan asks for it. `src/core/orchestrate.ts:518-526` sets the search request, and `src/providers/codex.ts:104-115` passes `-c tools.web_search=true`. That is not an API-key violation by itself, but it is more latency and subscription quota pressure.

Panel mode multiplies calls. `src/core/ensemble.ts:588-593` runs candidates concurrently, `src/core/ensemble.ts:684-693` counts the synthesis phase, and `src/core/ensemble.ts:796-812` runs the synthesizer. With the default cap of two candidates, one hard turn can become three model runs. The help text says panel has "no extra cost on your plan" at `src/interface/menu.ts:4092-4096`; that is misleading because quota, rate limits, and latency are still real user costs.

Hedge mode can also double-run a turn. `src/core/hedge.ts:557-560` starts a speculative branch after the delay, and `src/core/hedge.ts:672-674` records both executed runs. `src/core/hedge.ts:691-699` says the slower branch was cancelled, but cancellation after start does not guarantee quota was saved.

Reviews add more calls on high/critical turns. `src/core/orchestrate.ts:1539-1557` decides to review, `src/core/orchestrate.ts:1563-1574` selects a reviewer, and `src/core/orchestrate.ts:1704-1721` records the review run.

Future parallel-goals concurrency would make this materially worse. The existing system already supports concurrent panel/hedge patterns; adding parallel agents without a hard quota governor would be a rate-limit footgun.

### HIGH: Spend/quota uncertainty is hidden from normal users on timeout

When a provider times out without usage data, the orchestrator emits a warning that spend is unknown. `src/core/orchestrate.ts:1430-1448` explicitly says output may have been partially generated and spend is unknown if usage was not reported.

But normal rendering hides warning notices unless verbose mode is on. `src/interface/render.ts:1139-1149` only displays `warn` notices in verbose mode, except for some panel/hedge categories. The timeout final line at `src/interface/render.ts:1172-1178` can therefore show a clean failure with `0 tokens` while suppressing the only useful warning about unknown spend/quota.

That is not honest enough for a tool trying to manage subscription/rate-limit anxiety.

### MEDIUM: Review escalation can be flattened into "success"

The review path is stricter than a raw prompt, but it still leaks honesty.

If the reviewer requests escalation and policy blocks manager escalation, the orchestrator can return `success: true` without marking the result as best-effort. `src/core/orchestrate.ts:1861-1892` accepts the best result when escalation is blocked by policy. That is a bad final state: the system knows the reviewer wanted more, policy denied it, and the user can still get a normal-looking success.

There is also a contradictory top-tier path. `src/core/orchestrate.ts:1894-1913` says it is accepting the best result because it is already at the top tier, but returns `success: false`.

Review parsing has a lower-severity fail-open issue. `src/core/review.ts:110-151` returns `approve` on malformed review output. High and critical tasks get a no-auto-approve guard at `src/core/orchestrate.ts:1738-1742`, but lower tiers can still turn malformed review output into approval.

### MEDIUM: "Verified done" can be polluted by weak verification defaults

The work-state contract says done needs evidence, but the implementation can treat a weak verification object as approval. `src/core/work-contract.ts:135-148` defaults the verification verdict to `approve` whenever a `verification` object exists and the verdict is not explicitly `revise` or `escalate`.

`src/core/work-state.ts:155-176` then uses review approval and goal completion signals to determine verified-done state, including `review:approved` at `src/core/work-state.ts:166-171`.

This is better than blindly trusting prose, but not strong enough to support hard "honest/never fabricate" claims. A malformed or under-specified verification payload can become approval.

### MEDIUM: Goal completion and "done" are still model-reported, not independently proven

The goal prompt asks the model to emit `GOAL_COMPLETE` only when the objective is fully achieved and verified. `src/core/goal.ts:60-75` defines that instruction, `src/core/goal.ts:170-210` parses the final marker, and `src/core/goal.ts:287-321` accepts the marker as the decision.

The UI is careful in one place: `src/interface/menu.ts:4791-4801` says "the model reported the goal is complete." But ordinary turn completion is looser. `src/interface/render.ts:1237-1245` prints `done` for a successful turn with token usage. That reads like task completion even when it only means the command finished successfully.

For a demanding user, that word choice matters. "Done" should be reserved for verified task completion, not successful response rendering.

### LOW: Confidence handling avoids fake numbers, but missing confidence can still pass critical paths

The confidence parser does not fabricate a number when the envelope is missing or malformed. `src/core/assess.ts:64-105` returns `confidence: null`, and `src/interface/render.ts:372-384` renders that as unrated.

But hedge scoring treats missing confidence as acceptable. `src/core/hedge.ts:384-396` sets `confidenceOk` true when confidence is null. That means an answer that skipped the required confidence envelope can still qualify as a hedge winner.

This is not fake precision, but it is weak enforcement of the "be honest" contract.

### LOW: Rate-limit protection is reactive and can still route into cooldown pressure

Rate-limit cooldowns are tracked after provider events. `src/interface/render.ts:1036-1040` collects rate-limited providers, and `src/interface/menu.ts:3957-3996` updates cooldown state after a run.

Filtering is reactive, not a quota governor. `src/interface/menu.ts:4359-4366` filters authenticated providers by cooldown but intentionally avoids stranding the user when all providers are cooling down. `src/core/capability-budget.ts:95-187` sheds features based on detected pressure, but it does not enforce a hard per-turn or per-session quota budget.

That is acceptable for convenience, but not for strong cost/rate-limit guarantees. Once panel, hedge, reviews, web search, and future parallel agents are in the mix, reactive cooldowns are not enough.

### LOW: Partner UX is useful but visibly over-engineered

The personas are trying to make the assistant a good partner, but they are heavy and repetitive. Worker, IC, and manager prompts each include long sections about honesty, partnership, asking user questions, confidence envelopes, memory, and collaboration: `src/core/prompt.ts:58-138`, `src/core/prompt.ts:140-234`, and `src/core/prompt.ts:236-327`.

The prompt says warmth is not length and asks the model to avoid unnecessary questions, but it also authorizes structured asks with one to four questions and multiple choices at `src/core/prompt.ts:115-128`, `src/core/prompt.ts:210-223`, and `src/core/prompt.ts:304-317`. The chat loop then supports follow-up question rounds at `src/interface/menu.ts:4627-4674`.

The shell UI exposes a lot of machinery. Help lists many modes and switches at `src/interface/menu.ts:4074-4097`, settings expose many experimental toggles at `src/interface/menu.ts:2631-2655`, and autonomous goal continuation has its own loop and progress accounting at `src/interface/menu.ts:4677-4805`.

For a power user, this can be valuable. For a demanding normal user, the seams are obvious: first-turn waiting, hidden prepasses, recap pauses, review/hedge/panel notices, token accounting caveats, and "done" language that does not always mean done. It feels like an agent cockpit, not a calm partner.

## Cost and latency risk summary

- OpenCode capability refresh can add up to 10 seconds of blocking first-turn latency.
- Smart routing can add a classifier call with a 20 second timeout.
- Intent extraction can add an 8 second blocking pre-call.
- Resume recap can block before chat is usable.
- Balanced/quality-first effort policies can push hard manager turns to `xhigh` or `max`.
- Codex web search adds latency and quota pressure when current/latest/research signals are detected.
- Panel mode can turn one hard answer into two candidate calls plus one synthesis call.
- Hedge mode can start a second provider branch after delay and still consume quota even if later cancelled.
- Reviews add another provider call on high/critical turns.
- Cooldowns react after rate-limit events; they are not a proactive quota budget.

## UX reality

This is not a clean "subscription-only partner" yet. It is a capable orchestration shell with several honest mechanisms, but the experience is too full of invisible model calls, soft budget claims, feature switches, and status words that overstate certainty.

The best parts are the attempts to parse confidence, record ledgers, review risky work, and avoid direct API-key handling for Claude/Codex. The worst parts are OpenCode API-key setup, latency hidden behind "smart" features, and wording that treats quota as not-cost.

A real demanding user would notice the seams. They would notice slow first turns. They would notice that panel/hedge/review can multiply calls. They would notice "done" appearing where the system only has a successful response, not verified completion. They would notice that "no extra cost" ignores the thing subscription users actually care about: rate limits and quota exhaustion.

The product can be a strong power-user tool if it becomes explicit about budgets and removes API-key-based auth paths. Right now it is feature-laden machinery with some good honesty scaffolding, not a reliably calm partner.

bottom line: would a demanding user love this or bounce off it.
