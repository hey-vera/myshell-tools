# Provider Capability Utilization Audit 5.6

Audit date: 2026-06-06.

Scope: `myshell-tools` as a subscription-auth CLI orchestrator wrapping Claude Code, Codex, and OpenCode through their installed CLIs and OAuth/configured subscription state. This is a utilization audit, not a source-change proposal. No source files were changed.

Commands run:

- `claude --help`, `claude -h`, `claude agents --help`, `claude mcp --help`, `claude plugin --help`, `claude ultrareview --help`, `claude auto-mode --help`, `claude auth status`
- `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex mcp --help`, `codex features list`, `codex login status`
- `opencode --help`, `opencode run --help`, `opencode agent --help`, `opencode session --help`, `opencode providers --help`, `opencode providers list`, `opencode models`, `opencode models --verbose`
- Read `$CODEX_HOME/models_cache.json` at `.replit-tools/.codex-persistent/models_cache.json`

## Executive Summary

Utilization ratings:

| Area | Rating | Biggest lever |
| --- | ---: | --- |
| Claude | 45% | Wire the now-real `claude --effort <low|medium|high|xhigh|max>` flag through the existing `reasoningEffort` path. |
| Codex/GPT | 62% | Use the rest of `models_cache.json`: service/speed tiers, hidden/new listed models, search/image/tool metadata, and output schemas. |
| OpenCode | 28% | Parse `opencode models --verbose` and wire `opencode run --variant <low|medium|high|max>`, context, vision, toolcall, and session facts. |
| Combined | 52% | Make complementarity real by routing on provider-specific capabilities, not mostly static provider order plus opt-in panel/review. |

The system is strongest where it treats CLIs as subscription-auth execution engines: it shells out, preserves OAuth/config dirs, streams real events, tracks auth, uses per-provider sandbox permissions, uses native Claude/Codex session continuity, merges the Codex cache, and has opt-in panel/hedge/cross-vendor review.

The main gap is subtype utilization. The code has a good provider-agnostic `reasoningEffort` seam, but only Codex consumes it. Claude and OpenCode now expose effort/variant knobs in the installed CLIs, and myshell-tools does not use them. Codex is ahead, but even there the cache contains speed/service tiers, reasoning summaries, web search tool type, image detail support, truncation policy, and a visible `gpt-5.3-codex-spark` model that are not materially used by routing.

The combined "team" is real but shallow. `ensemble.ts` can run a cross-vendor panel, `hedge.ts` can race a flagship, and `orchestrate.ts` can run cross-vendor review. But default routing still prefers `claude, codex, opencode` for every tier in `policy.ts`, and capability-fit only re-ranks models within an already-chosen provider in `route.ts`. Providers are often interchangeable executors, with complementarity added by prompts and opt-in concurrency rather than by native capability-aware routing.

## Provider CLI Surface Observed

### Claude Code

Observed from `claude --help` / `claude -h`:

- Headless execution: `-p, --print`
- Model selection: `--model <model>`, aliases such as `sonnet` and `opus`
- Reasoning effort: `--effort <level>` with `low`, `medium`, `high`, `xhigh`, `max`
- Permission modes: `--permission-mode <mode>` with `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`
- Tool control: `--tools`, `--allowedTools` / `--allowed-tools`, `--disallowedTools` / `--disallowed-tools`
- MCP: `--mcp-config`, `--strict-mcp-config`, plus `claude mcp add/list/get/remove/serve`
- Sessions: `--session-id <uuid>`, `--resume`, `--continue`, `--fork-session`, `--no-session-persistence`
- Output: `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--json-schema`, `--include-partial-messages`, `--include-hook-events`
- Prompt/context controls: `--system-prompt`, `--append-system-prompt`, `--add-dir`, `--settings`, `--setting-sources`
- Native extensions: `--agent`, `--agents`, `claude agents`, `claude plugin`, skills via slash commands unless `--disable-slash-commands`
- Other native features: `--fallback-model`, `--prompt-suggestions`, `--chrome`, `--remote-control`, `--worktree`, `--tmux`, `claude ultrareview`
- Auth/plan: `claude auth status` returned OAuth `authMethod: "claude.ai"` and `subscriptionType: "max"` in this environment

Claude web-search availability was not directly enumerated by the help output. `--tools` can select built-in tools, but the help examples name `Bash`, `Edit`, and `Read`; a concrete `WebSearch` flag surface is unverified from CLI help alone.

### Codex

Observed from `codex --help` / `codex exec --help`:

- Headless execution: `codex exec`
- Model selection: `-m, --model <MODEL>`
- Images: `-i, --image <FILE>...`
- Sandbox: `--sandbox read-only|workspace-write|danger-full-access`
- Approval policy in interactive CLI: `--ask-for-approval untrusted|on-failure|on-request|never`
- Web search: top-level `--search` enables native Responses `web_search`
- Output: `codex exec --json`, `--output-schema <FILE>`, `--output-last-message <FILE>`, `--color`
- Resume: `codex exec resume [SESSION_ID] [PROMPT]`, `--last`, `--all`, plus image/schema/json flags on resume
- Config surface: repeated `-c, --config <key=value>`, `--enable`, `--disable`, profiles
- MCP/plugins: `codex mcp`, `codex plugin`, `codex mcp-server`
- Native features: `codex review`, `cloud`, `sandbox`, `features`, app/server commands

Observed from `$CODEX_HOME/models_cache.json`:

- Visible listed models: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`
- Hidden model: `codex-auto-review` with `visibility: "hide"`; current parser correctly skips hidden models
- Reasoning efforts: all visible models list `low`, `medium`, `high`, `xhigh`
- Defaults: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` default `medium`; `gpt-5.3-codex-spark` defaults `high`
- Context: `gpt-5.5` 272k max; `gpt-5.4` 272k context / 1M max; `gpt-5.4-mini` 272k; `gpt-5.3-codex-spark` 128k
- Modalities: the first three support `text,image`; Spark supports `text`
- Tool flags: `supports_search_tool: true`, `supports_parallel_tool_calls: true`
- Extra cache fields not consumed today: `service_tiers`, `additional_speed_tiers`, `supports_reasoning_summaries`, `apply_patch_tool_type`, `web_search_tool_type`, `truncation_policy`, `effective_context_window_percent`, `default_verbosity`, `support_verbosity`, `supports_image_detail_original`

### OpenCode

Observed from `opencode --help` / `opencode run --help`:

- Headless execution: `opencode run [message..]`
- Model selection: `-m, --model provider/model`
- Reasoning subtype: `--variant <variant>` described as provider-specific reasoning effort, examples `high`, `max`, `minimal`
- Reasoning visibility: `--thinking`
- Attachments: `-f, --file`
- Sessions: `--continue`, `--session`, `--fork`, `--share`; `opencode session list/delete`; `opencode export/import`
- Agents: `--agent`, `opencode agent create/list`
- Output: `--format default|json`
- Permissions: `--dangerously-skip-permissions`
- Server/remote: `serve`, `web`, `attach`, `--attach`, ACP server
- MCP/plugins/providers: `opencode mcp`, `opencode plugin`, `opencode providers login/list/logout`
- Model inventory: `opencode models [provider]`, `--verbose`, `--refresh`

Observed from `opencode models` in this environment:

- `opencode/big-pickle`
- `opencode/deepseek-v4-flash-free`
- `opencode/mimo-v2.5-free`
- `opencode/minimax-m3-free`
- `opencode/nemotron-3-ultra-free`

Observed from `opencode models --verbose`:

- Models expose `limit.context`, `limit.output`, `capabilities.reasoning`, `capabilities.attachment`, `capabilities.toolcall`, and input modality booleans.
- `big-pickle`: 200k context, 160k input, 32k output, reasoning true, toolcall true, no attachments, no image input, no variants.
- `deepseek-v4-flash-free`: 200k context, 128k output, reasoning true, toolcall true, variants `low|medium|high|max`.
- `mimo-v2.5-free`: 200k context, 32k output, attachment true, text/audio/image/video input true, variants `low|medium|high`.
- `minimax-m3-free`: 200k context, 32k output, image/video input true, no variants.
- `nemotron-3-ultra-free`: 1M context, 128k output, reasoning true, toolcall true, variants `low|medium|high`.

`opencode providers list` showed `0 credentials` in this environment, so myshell-tools correctly treats OpenCode as not authenticated for serious routed work despite the free model list.

## What myshell-tools Actually Uses

### Claude adapter

`src/providers/claude.ts` uses:

- `claude -p --output-format stream-json --verbose` (`buildClaudeArgs`, lines 126-139)
- `--model <alias>` after mapping full ids to `opus`, `sonnet`, `haiku` (`toClaudeModelArg`, lines 54-58)
- `--max-budget-usd 25` as a runaway cap (`CLAUDE_MAX_BUDGET_USD`, lines 65-84)
- Native session flags: `--resume <id>` or `--session-id <id>` when `ProviderRequest.sessionId` is set (`buildClaudeArgs`, lines 140-145)
- Permission mapping:
  - read-only: `--disallowedTools Write Edit NotebookEdit Bash`
  - workspace-write: `--permission-mode acceptEdits`
  - full-access: `--permission-mode bypassPermissions`
  (`claudeSandboxArgs`, lines 103-112)
- OAuth/config env injection via `loadClaudeToken`, `claudeEnv`, and `replitPersistentEnv` (`run`, lines 173-183)
- Streaming parser via `parseClaudeLine` (`run`, lines 204-214)

It does not use Claude `--effort`, `--json-schema`, `--tools` except read-only denylist, `--allowedTools`, `--mcp-config`, `--agent`, `--agents`, plugins/skills, `--fallback-model`, `--prompt-suggestions`, `--input-format stream-json`, `--file`, `--include-partial-messages`, or `ultrareview`.

### Codex adapter

`src/providers/codex.ts` uses:

- `codex exec --json -m <model> --sandbox <level> --skip-git-repo-check` (`buildCodexArgs`, lines 78-94)
- Sandbox mapping to `read-only`, `workspace-write`, `danger-full-access` (`toSandboxArg`, lines 50-58)
- Reasoning effort via `-c model_reasoning_effort=<effort>` when `ProviderRequest.reasoningEffort` is set and not `none` (`buildCodexArgs`, lines 87-89)
- Native resume via `codex exec resume <thread-id>` when `sessionId` and `resume` are set (`buildCodexArgs`, lines 90-92)
- Persistent `CODEX_HOME` injection (`run`, lines 118-123)
- JSONL parsing via `createCodexParser` (`run`, lines 136-155)

It does not use `--image`, `--search`, `--output-schema`, `--output-last-message`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--profile`, MCP/plugin features, feature flags, `codex review`, service/speed tiers from the cache, or reasoning summaries/verbosity/image-detail fields from the cache.

### OpenCode adapter

`src/providers/opencode.ts` uses:

- `opencode run --format json`
- `-m <provider/model>` only when `req.model` contains `/` (`run`, lines 71-74)
- Persistent XDG/env injection (`run`, lines 76-81)
- JSON event parser and real cost accumulation (`run`, lines 95-158)

It does not use `--variant`, `--thinking`, `--file`, `--agent`, `--continue`, `--session`, `--fork`, `--share`, `--attach`, `--dir`, MCP, plugin, provider metadata beyond model id, or verbose model capability facts.

### Detection and registry

`src/providers/detect.ts` uses:

- Claude: `claude --version`, `claude auth status`; returns `availableModels: ['opus','sonnet','haiku']` and observed `subscriptionType` as plan (`detectProvider`, lines 238-290)
- Codex: `codex --version`, `codex login status`; plan is always null; returns static `['gpt-5.5','gpt-5.4','gpt-5.4-mini']` (`detectProvider`, lines 304-347)
- OpenCode: `opencode --version`, `opencode auth list`, `opencode models`; parses `provider/model` ids (`detectOpencodeProvider`, lines 410-466)

`src/core/model-capabilities.ts` declares:

- Claude aliases and `supportsNativeSession`; provider-native skills/subagents as non-routable facts (`DECLARATIVE_MODEL_CAPABILITIES`, lines 171-211)
- Codex declarative `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`; supports native sessions; no hardcoded efforts (`lines 213-240`)
- OpenCode empty declarative registry because it is a meta-provider (`line 242`)

`src/core/model-capability-refresh.ts` merges:

- `ProviderStatus.availableModels` into the registry (`refreshCapabilities`, lines 145-166)
- Codex `models_cache.json` with `display_name`, `default_reasoning_level`, `supported_reasoning_levels`, context, modalities, `supports_search_tool`, and `supports_parallel_tool_calls` (`extractCodexFacts`, lines 291-341)
- It intentionally skips non-list Codex models (`mergeCodexCache`, lines 250-251)

It does not parse Claude CLI help, OpenCode verbose models, Codex service/speed tiers, Codex reasoning summaries, Codex image-detail flags, or OpenCode variants.

### Routing, effort, and combined orchestration

`src/core/route.ts`:

- Uses static provider order from `policy.providerOrderByTier`
- Prefers authenticated providers and learned provider order when supplied (`route`, lines 264-299)
- Applies capability-fit only within an already-chosen provider and tier (`decisionFor` / `applyCapabilityFit`, lines 171-261)
- Scores known vision, large context, native sessions, and weak model outcome order (`scoreModel`, lines 350-411)
- Selects effort using mode, tier, risk, and task kind (`selectReasoningEffort`, lines 516-564)

`src/core/orchestrate.ts`:

- Computes task signals once per turn: estimated input tokens, `needsVision: false`, and deterministic task kind (`lines 787-814`)
- Threads `capabilityContext` into normal work routes (`lines 828-838`, `1026-1034`)
- Sends `reasoningEffort` into `ProviderRequest` (`lines 1040-1047`, `1132-1142`)
- Uses native sessions when a provider has a plan, while avoiding poisoned native history (`lines 1074-1095`)
- Runs cross-vendor review with its own review capability context and effort (`lines 1516-1648`)

`src/core/ensemble.ts` and `src/core/hedge.ts`:

- Panel is opt-in and requires at least two authenticated providers (`planPanel`, lines 95-124)
- Panel candidates run concurrently and synthesizer adjudicates (`runPanel`, lines 515-928)
- Hedge is opt-in, high/critical only, and flagship-gated (`planHedge`, lines 105-155)
- Both panel and hedge select reasoning effort, but the adapters only honor that effort for Codex today

`src/core/policy.ts`:

- Default provider order is identical for worker/IC/manager: `['claude','codex','opencode']` (`DEFAULT_POLICY`, lines 43-47)
- Modes affect flagship admission and thresholds, not provider-specific capability strategy (`POLICY_PRESETS`, lines 256-301)

`src/core/native-session.ts`:

- Plans Claude native sessions using the conversation id and Codex resume only after a prior captured thread id (`planNativeSession`, lines 92-114)
- Does not plan OpenCode native sessions despite `opencode run --continue/--session` existing

## Utilization Matrix

### Claude

| Capability | Exposed by CLI? | Used by myshell-tools? | How / gap |
| --- | --- | --- | --- |
| Model variants | Yes: `--model`, aliases `opus`, `sonnet`, `haiku` | Yes | Pricing table maps tiers to Claude ids; adapter maps full ids to aliases in `toClaudeModelArg`. |
| Reasoning efforts | Yes: `--effort low|medium|high|xhigh|max` | No | `ProviderRequest.reasoningEffort` exists, but `claude.ts` ignores it. Registry also leaves Claude efforts empty. This is the largest Claude gap. |
| Extended/deep thinking | Partly exposed as `--effort`; other thinking controls unverified | No | No `--effort` or provider-mode mapping. |
| Vision/multimodal | Unclear from help; `--file` downloads file resources by file id | No | No `ProviderRequest` attachment/image channel. Do not claim local image support from help alone. |
| Tool/function calling | Yes: default tools plus `--tools`, `--allowedTools`, `--disallowedTools` | Partial | Read-only denies mutation/execution tools. No allowlist by task, no narrow tool sets, no explicit web/tool surface. |
| Web search | Unverified from help | No explicit wiring | Prompt asks providers to research when needed, but no verified Claude web-search flag is passed. |
| MCP | Yes: `--mcp-config`, `claude mcp` | No | No request or config path for per-run MCP. Good to keep explicit/user-controlled. |
| Native sessions/resume | Yes: `--session-id`, `--resume`, `--continue` | Yes | `native-session.ts` plans Claude; `claude.ts` passes `--session-id` / `--resume`. |
| Permission/sandbox modes | Yes: `--permission-mode`, `--allowedTools`, `--disallowedTools` | Yes | Good mapping: read-only denylist, workspace `acceptEdits`, full `bypassPermissions`; avoids `--dangerously-skip-permissions`. |
| Output formats | Yes: text/json/stream-json | Yes, partial | Uses `stream-json`; does not use `json` single-result or `--json-schema`. |
| Structured output | Yes: `--json-schema` | No | Could be used for review/assessment envelopes, not general prose. |
| Skills/plugins | Yes: skills, `claude plugin` | Inventory only | Registry declares Claude skills/subagents as non-routable facts. Deliberate and reasonable per `docs/model-capability-registry-5.6.md` section 6. |
| Subagents/agents | Yes: `--agent`, `--agents`, `claude agents` | Inventory only | Not invoked. Correct default: nested orchestration would hide routing/ledger/sandbox choices. |
| Parallel tool calls | Not verified from CLI help | No | No local fact. |
| Large context | Claude pricing table says 200k | Partial | Used only indirectly through static tier/pricing; registry does not currently seed Claude context. |
| Plan-tier awareness | Yes: `claude auth status` reports `subscriptionType` | Yes | `detect.ts` parses plan; `policy.ts` auto mode can become Max on `max`. |

Claude rating: 45%. Solid execution/sandbox/session use, but effort, structured output, provider tool controls, and native extension surfaces are mostly unused.

### Codex/GPT

| Capability | Exposed by CLI/cache? | Used by myshell-tools? | How / gap |
| --- | --- | --- | --- |
| Model variants | Yes: `-m`; cache lists `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` | Partial | Routes table models; cache can add Spark to registry, but route candidates are pricing-table bounded, so Spark lacks a tier path. |
| Reasoning efforts | Yes: cache `low|medium|high|xhigh`; CLI accepts `-c model_reasoning_effort=...` | Yes | Best-used subtype surface. `selectReasoningEffort` feeds `buildCodexArgs`. |
| Extended/deep thinking | Yes through effort levels and reasoning summaries cache fields | Partial | Effort used; `supports_reasoning_summaries` and summary config are not used. |
| Vision/multimodal | Yes: `-i --image`; cache `input_modalities: ['text','image']` | Registry only | Registry marks vision for Codex models, but `orchestrate.ts` hardcodes `needsVision: false` and no image request channel exists. |
| Tool/function calling | Yes: Codex agent tools; cache `apply_patch_tool_type`, `shell_type`; CLI sandbox | Partial | Tools are used by Codex internally, but myshell-tools does not use cache tool metadata in routing or disclosure beyond parallel/search. |
| Web search | Yes: `codex --search`; cache `supports_search_tool`, `web_search_tool_type` | No | Registry records search support, but adapter never passes `--search` for external/current tasks. |
| MCP | Yes: `codex mcp`, `codex mcp-server` | No | No per-run MCP config. Reasonable to keep explicit. |
| Native sessions/resume | Yes: `codex exec resume` | Yes, partial | Parser captures thread ids; `native-session.ts` resumes after prior captured id. No establish-by-id because Codex generates ids. |
| Permission/sandbox modes | Yes: `--sandbox`, approval policies | Yes | `codex.ts` maps all three sandbox levels. It does not set approval policy, appropriate for `exec` JSON runs. |
| Output formats | Yes: `--json`, `--output-last-message` | Yes, partial | Uses `--json`; does not use `--output-last-message`. |
| Structured output | Yes: `--output-schema <FILE>` | No | Could harden internal classifiers/review envelopes. |
| Skills/plugins | Yes: `codex plugin`, features show plugins stable | No | Not used. Good not to auto-enable arbitrary plugins. |
| Subagents/multi-agent | Features show `multi_agent` stable, `multi_agent_v2` under development | No | No route surface. Avoid until CLI invocation is documented and auditable. |
| Parallel tool calls | Cache says true | Registry only | Parsed into capability facts but not used to route or explain much beyond summary. |
| Large context | Cache gives 272k/1M facts | Partial | Registry merges context and route can score large-context within provider. Provider choice is still fixed before fit. |
| Plan-tier awareness | `codex login status` reports logged in, no plan | Partial | Auth yes; plan unknown. Correct not to fabricate. |
| Speed/service tiers | Cache has `service_tiers: priority/Fast`, `additional_speed_tiers: ['fast']` for top models | No | Parser ignores these. CLI config key to activate them is unverified; inventory first. |

Codex rating: 62%. It is the only provider with end-to-end effort wiring and good cache merge, but native search, image inputs, output schemas, speed/service tiers, and new cache models are underused.

### OpenCode

| Capability | Exposed by CLI/model metadata? | Used by myshell-tools? | How / gap |
| --- | --- | --- | --- |
| Model variants | Yes: `-m provider/model`; `opencode models` | Yes | Detection parses model ids; `selectOpencodeModel` chooses a real id per tier. |
| Reasoning variants | Yes: `opencode run --variant`; verbose metadata has variants like `low|medium|high|max` | No | Adapter never passes `--variant`; registry does not parse verbose model metadata. Largest OpenCode gap. |
| Extended/deep thinking | Yes: `--thinking`, reasoning capabilities and variants | No | No `--thinking`, no variant selection, no reasoning metadata. |
| Vision/multimodal | Yes: `-f --file`; verbose model input flags include image/audio/video for some models | No | No attachment channel; no verbose parser; `needsVision` is always false. |
| Tool/function calling | Verbose metadata has `capabilities.toolcall: true` | No explicit use | OpenCode agent may use tools internally, but myshell-tools does not route on toolcall support. |
| Web search | Not clear from top-level help | Unverified/no explicit use | Do not assume. |
| MCP | Yes: `opencode mcp` | No | No per-run MCP config. |
| Native sessions/resume | Yes: `--continue`, `--session`, `--fork`, `opencode session` | No | `native-session.ts` only plans Claude/Codex. |
| Permission/sandbox modes | No direct sandbox; has `--dangerously-skip-permissions` | Conservative default | Adapter deliberately passes no bypass. This is appropriate. |
| Output formats | Yes: `--format default|json` | Yes | Adapter uses JSON events. |
| Structured output | No schema flag observed | No | `--format json` is event format, not output schema. |
| Skills/plugins/agents | Yes: `opencode agent`, `opencode plugin` | No | Not used. Could be explicit opt-in only. |
| Subagents | Agents exposed | No | No nested orchestration. Reasonable default. |
| Parallel tool calls | Verbose metadata gives toolcall but not parallel flag | No | Unverified. |
| Large context | Verbose metadata gives 200k and 1M model limits | No | `selectOpencodeModel` is keyword heuristic, not context-aware. |
| Plan-tier awareness | Providers list exposes credential count, no plan tier | Partial | Detects 0 credentials and treats as not ready; no paid/free tier classification. |

OpenCode rating: 28%. The integration uses OpenCode as a model-id runner and cost/event stream, but ignores its own model metadata, variants, attachments, sessions, and agent surfaces.

## Combined / Cross-Provider Utilization

What is real:

- Cross-vendor review exists. `orchestrate.ts` only reviews with a different provider (`pickReviewer`, review block lines 1516-1602).
- Parallel panel exists. `ensemble.ts` runs authenticated providers concurrently and synthesizes, gated by `panelPolicy`.
- Hedge exists. `hedge.ts` can start a speculative flagship on high/critical slow turns.
- Learned routing exists. `routing-memory.ts` ranks providers by observed success and latency, and model outcomes by task kind after minimum evidence.
- Native session continuity exists for Claude and Codex, with fallback to prompt replay when switching providers.
- Capability-fit exists, with vision/large-context/native-session scoring.

Where complementarity is shallow:

- Static provider order is identical for every tier: Claude first, then Codex, then OpenCode (`policy.ts`, lines 43-47 and 271-298). That means Claude tends to win unless auth/cooldown/learned order/failover changes it.
- Capability-fit cannot choose a different provider for a hard requirement. `route.ts` picks the provider first, then re-ranks models inside that provider (`decisionFor`, lines 171-200). If Codex is the only provider with known image/search/cache facts, capability-fit does not promote Codex over Claude by itself.
- Panel and hedge are opt-in (`config.panel`, `config.hedge`) and default off. Good for quota safety, but it means the default user experience is still mostly single-provider.
- The panel chooses candidates from `authenticatedProviders.slice(0, cap)` (`ensemble.ts`, line 116). Diversity is provider-level, not capability-selected. It does not pick "best reviewer for image/search/large context".
- Cross-vendor review uses another provider, but reviewer routing still starts from the same policy/routing machinery, with no provider-specialized reviewer role beyond prompt text.
- Learned outcomes are conservative and useful, but opt-in and cold-start absent. They are not yet enough to make the providers "know each other's strengths" on day one.

Combined rating: 52%. The architecture supports a subscription-first team, but default routing still treats providers as mostly fungible executors. Complementarity becomes meaningful only after opt-in panel/hedge/review, learned ledger evidence, or failure/cooldown.

## Findings

### 1. Claude effort is exposed but completely unused

Evidence:

- CLI exposes `--effort <level>` with `low`, `medium`, `high`, `xhigh`, `max`.
- `ProviderRequest.reasoningEffort` exists (`src/providers/port.ts`, lines 55-63).
- `selectReasoningEffort` already chooses bounded efforts (`src/core/route.ts`, lines 516-564).
- `claude.ts` never reads `req.reasoningEffort`; `buildClaudeArgs` emits no `--effort` (`src/providers/claude.ts`, lines 126-148).
- The registry says Claude supported efforts are empty (`src/core/model-capabilities.ts`, lines 178, 193, 205), because the prior design assumed no verified flag.

Gap: Claude Max/Opus can be selected by tier, but not by thinking depth. Hard architecture/review tasks routed to Claude do not use the full installed Claude Code subtype surface.

Where it would wire: add Claude effort facts to the registry from verified local CLI help or a conservative declarative source, then append `--effort <mapped>` in `buildClaudeArgs` when `req.reasoningEffort` is set. Map `xhigh` to `xhigh`; decide whether `max` requires extending `ReasoningEffort` or only a Claude-specific cap.

Guardrail: safe. This reuses the OAuth CLI, no API key or metered path.

### 2. OpenCode variants and verbose capabilities are unused

Evidence:

- `opencode run --help` exposes `--variant` and `--thinking`.
- `opencode models --verbose` exposes reasoning variants, context/output limits, attachment support, input modalities, and toolcall support.
- `opencode.ts` only emits `opencode run --format json [-m model]` (`src/providers/opencode.ts`, lines 71-74).
- `detect.ts` runs `opencode models`, not `opencode models --verbose`, and parses only `provider/model` ids (`src/providers/detect.ts`, lines 439-453).
- `selectOpencodeModel` is keyword scoring, not metadata-driven (`src/core/opencode-model.ts`, lines 29-93).

Gap: OpenCode has enough local metadata to make it the best current target for richer dynamic capability parsing, but myshell-tools treats it mostly as a list of names.

Where it would wire: add an OpenCode verbose parser, merge `limit.context`, `limit.output`, `capabilities.input`, `capabilities.attachment`, `capabilities.toolcall`, and `variants` into the registry, then map `reasoningEffort` to `opencode run --variant <effort>` when the selected model declares that variant.

Guardrail: safe if it uses `opencode models --verbose` and `opencode run`; no API key or external service added.

### 3. Codex search and image support are known but not activated

Evidence:

- `codex --help` exposes `--search`.
- `codex exec --help` exposes `-i, --image <FILE>...`.
- Cache says listed models support `supports_search_tool: true`, `supports_parallel_tool_calls: true`, and most support `input_modalities: ['text','image']`.
- `model-capability-refresh.ts` merges `supportsSearchTool`, `supportsParallelToolCalls`, and `supportsVision` (`lines 325-338`).
- `orchestrate.ts` sets `needsVision: false` because there is no image channel (`lines 799-807`).
- `codex.ts` never passes `--search` or `--image`.

Gap: The system knows Codex can do search and vision, but cannot choose or invoke those capabilities.

Where it would wire: add explicit task signals for external-current facts and attachments. For Codex, pass `--search` on web-research turns and `-i` for image files. Keep it opt-in by task signal, not always on.

Guardrail: safe. `--search` and `--image` are native CLI features under the logged-in Codex account. No external API key path.

### 4. Structured output is available in Claude and Codex but unused

Evidence:

- Claude exposes `--json-schema <schema>`.
- Codex exposes `--output-schema <FILE>`.
- myshell-tools currently asks models to emit text envelopes and parses final text (`assess`, review prompts, panel JSON self-report).
- No adapter emits schema flags.

Gap: The highest-value schema use is not general user answers; it is internal control surfaces: classifier outputs, review verdicts, panel self-reports, and assessment envelopes. Today those remain prompt-contract parsing.

Where it would wire: extend `ProviderRequest` with optional output schema for internal-only calls. `claude.ts` can pass `--json-schema`; `codex.ts` can write/use a temporary schema file for `--output-schema`. OpenCode has no observed schema flag.

Guardrail: safe if implemented through CLI flags and local temp files. No API key.

### 5. Codex cache service/speed/tool details are ignored

Evidence:

- Cache has `service_tiers` with `priority/Fast` for `gpt-5.5` and `gpt-5.4`, `additional_speed_tiers: ['fast']`, `supports_reasoning_summaries`, `web_search_tool_type`, `apply_patch_tool_type`, `truncation_policy`, and verbosity fields.
- `model-capability-refresh.ts` schema only reads display name, reasoning levels/default, context, input modalities, search, and parallel calls (`CodexCacheModel`, lines 101-113).

Gap: The registry misses potentially useful speed/quota and tool-behavior signals. Some may be inventory-only until a verified Codex config key exists.

Where it would wire: first add these as non-routable or weak-routable facts in `ModelCapability`. Only pass a runtime `-c` knob after verifying the correct Codex config key from official CLI docs or local config schema.

Guardrail: inventory is safe. Runtime speed/service-tier activation is guardrail-safe only if done through the logged-in CLI and not an API service tier billed separately.

### 6. New/dynamic Codex models are not tier-routable

Evidence:

- Cache lists `gpt-5.3-codex-spark` as visible.
- Refresh adds dynamic ids with no invented tier (`model-capability-refresh.ts`, lines 255-265).
- `route.ts` candidates are bounded to `PRICING_TABLE.models` for a provider and tier (`route.ts`, lines 226-236).
- `PRICING_TABLE` lacks `gpt-5.3-codex-spark` (`src/infra/pricing.ts`, lines 74-119).

Gap: The registry can know the model exists, but route cannot select it unless pricing/tier metadata is added or a dynamic tiering rule is defined.

Where it would wire: derive a conservative tier from cache metadata only when local fields justify it, or keep dynamic models as explicit-choice only. Do not guess from brand alone.

Guardrail: safe if using local cache only.

### 7. Native OpenCode sessions are left unused

Evidence:

- `opencode run --help` exposes `--continue`, `--session`, `--fork`.
- `opencode session` lists and deletes sessions.
- `native-session.ts` only plans Claude and Codex (`planNativeSession`, lines 104-112).

Gap: OpenCode loses provider-native context continuity and must rely on prompt replay.

Where it would wire: parse OpenCode session ids from JSON events if present, or use `--continue` only for same-provider consecutive turns. Must avoid stale-history issues the same way Claude/Codex do.

Guardrail: safe through CLI session flags.

### 8. Provider-native skills/subagents/plugins are deliberately not used

Evidence:

- Claude exposes `--agent`, `--agents`, `claude agents`, and plugins/skills.
- Codex exposes plugin features and `multi_agent` as a stable feature flag.
- OpenCode exposes `opencode agent` and plugins.
- `docs/model-capability-registry-5.6.md` section 6 says provider-native skills/subagents should be inventory-only and not invoked automatically.
- `model-capabilities.ts` comments mark Claude skills/subagents as "NON-ROUTABLE" facts (`lines 95-108`, `180-185`).

Verdict: this is already optimal for now. Auto-invoking provider-native agents would create nested orchestration that bypasses myshell-tools routing, sandbox, cooldown, and ledger attribution.

Guardrail: any future use must be explicit opt-in and still use the provider CLI. No hidden API, no metered agent service.

## Prioritized Opportunities

1. Wire Claude `--effort` into the existing effort selector.
   - Unlocks: real Claude subtype control for hard reasoning, review, architecture, and Max mode.
   - Effort: Small to medium. Registry update plus `buildClaudeArgs` mapping/tests.
   - Guardrail: safe. OAuth CLI only.

2. Parse OpenCode verbose model metadata and wire `--variant`.
   - Unlocks: OpenCode reasoning variants, context-aware selection, vision/attachment awareness, and better tier selection than keyword scoring.
   - Effort: Medium. Parser, registry merge, route scoring, adapter flag.
   - Guardrail: safe. Local `opencode models --verbose` plus `opencode run`.

3. Activate Codex native search for external/current tasks.
   - Unlocks: actual web-search tool for "latest/current/look up" tasks instead of relying on prompt text.
   - Effort: Small to medium. Add search task signal and adapter flag.
   - Guardrail: safe if using `codex --search` under the logged-in CLI.

4. Add a provider-agnostic attachment/image request channel.
   - Unlocks: Codex `--image`, OpenCode `--file`, and capability-fit `needsVision`; Claude local image support remains unverified from help and should not be assumed.
   - Effort: Medium to large depending on UI/CLI input surface.
   - Guardrail: safe if files are passed to provider CLIs only.

5. Use structured output for internal control calls.
   - Unlocks: more reliable classifier/review/panel envelopes via Claude `--json-schema` and Codex `--output-schema`.
   - Effort: Medium. Requires schema temp-file handling for Codex and fallback to prompt parsing when unsupported.
   - Guardrail: safe. Local CLI flags only.

6. Extend Codex cache parsing to service/speed/tool metadata.
   - Unlocks: self-awareness and future routing on speed tiers, reasoning summaries, image detail, search tool type, and truncation policy.
   - Effort: Small for inventory; medium for runtime config.
   - Guardrail: inventory safe. Runtime service-tier activation needs verification that it does not imply a metered/API service path.

7. Make provider selection capability-aware across providers for hard requirements.
   - Unlocks: Codex for search/image when those are required, OpenCode for 1M-context Nemotron when available, Claude for provider-native strengths when explicitly known.
   - Effort: Large. Requires changing `route()` from provider-first then model-fit to bounded provider+model candidate scoring without bypassing auth, cooldown, and flagship admission.
   - Guardrail: safe if it only reorders authenticated CLI providers.

8. Add OpenCode native session planning.
   - Unlocks: better continuity for OpenCode users and less prompt replay.
   - Effort: Medium. Need reliable session id capture or safe `--continue` semantics.
   - Guardrail: safe through CLI flags.

9. Make dynamic Codex models routeable when local facts are sufficient.
   - Unlocks: visible cache models such as `gpt-5.3-codex-spark`.
   - Effort: Medium. Needs conservative tiering or explicit model preference config.
   - Guardrail: safe using local cache. Do not guess subjective tiers.

10. Keep MCP/plugins/agents explicit, not automatic.
    - Unlocks: power-user integration without nested hidden orchestration.
    - Effort: Medium to large for a safe UI/config model.
    - Guardrail: safe only when user-configured and CLI-based. Do not install or invoke arbitrary remote plugins by default.

## Already Optimal / Not Worth It Now

- Do not use API keys, embeddings, vector DBs, Vertex, or metered APIs. The current architecture correctly shells out to subscription-auth CLIs.
- Do not use `claude --bare` for normal runs. Its help says OAuth/keychain are never read; that conflicts with the subscription-auth guardrail.
- Do not pass Claude `--dangerously-skip-permissions` or OpenCode `--dangerously-skip-permissions` automatically. Current conservative permission mapping is correct.
- Do not auto-enable provider-native subagents/agents/plugins. Inventory is fine; execution should be explicit opt-in because nested agents hide decisions from myshell-tools.
- Do not infer Codex or OpenCode plan tiers when CLIs do not expose them. `detect.ts` is correct to keep plan null/unknown rather than fabricate.
- Do not route on unverified Claude web-search or vision claims. The help output did not give a concrete web-search or local-image invocation flag.
- Do not make panel/hedge default-on without a quota/latency UX. They are valuable subscription-first features, but they spend rate-limit headroom.

## 12-Line Executive Summary

1. Claude utilization: 45%; it uses model/session/sandbox/streaming well but misses `--effort`.
2. Codex utilization: 62%; it uses effort and cache basics, but misses search, images, schemas, speed/service tiers, and some cache models.
3. OpenCode utilization: 28%; it uses model ids and JSON events, but misses variants, verbose capabilities, attachments, and sessions.
4. Combined utilization: 52%; cross-vendor review/panel/hedge exist, but default routing is still mostly provider-order driven.
5. Top safe opportunity 1: wire Claude `--effort` through `ProviderRequest.reasoningEffort`.
6. Top safe opportunity 2: parse `opencode models --verbose` and pass `opencode run --variant`.
7. Top safe opportunity 3: enable Codex `--search` for explicit/current external-research turns.
8. Use Codex/OpenCode image/file paths only after adding a first-class attachment request field.
9. Use Claude/Codex structured schemas for internal envelopes, not arbitrary user prose.
10. Keep provider-native agents/plugins inventory-only until explicit opt-in and ledger attribution exist.
11. Do not add API keys, embeddings, vector DBs, Vertex, or metered service paths.
12. Biggest architecture lever: make capability-fit able to choose among provider+model candidates while still respecting auth, cooldown, policy, and flagship admission.
