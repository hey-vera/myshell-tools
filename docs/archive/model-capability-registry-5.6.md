# Model / Provider Capability Registry 5.6

Design doc only. No source changes.

This design keeps the maintainer's key constraint: do not hardcode subjective prose like "model X is weak at Y". The registry is not a vibes table. It is a conservative, provider-agnostic fact layer, refreshed from machine-readable local sources when available, and tempered by observed outcomes from the user's own ledger.

## 1. Gap Analysis

### How model choice works today

`src/core/policy.ts` is the current routing policy owner. `DEFAULT_POLICY` sets `maxAttempts`, `flagshipAdmission`, `maxFlagshipAttemptsPerTurn`, confidence thresholds, static `providerOrderByTier`, and review policy (`src/core/policy.ts:11`). Modes are `cost-saver`, `balanced`, and `quality-first`, surfaced as Efficient / Balanced / Max (`src/core/policy.ts:71`). Plan classification is intentionally conservative: a missing plan is `unknown` with confidence `none`, not inferred (`src/core/policy.ts:121`).

`src/core/flagship.ts` gates manager-tier access. `authorizeTier` only governs `manager`; worker and IC pass through (`src/core/flagship.ts:98`). Balanced earns one manager attempt when high-risk, low-confidence, review, or failure signals justify it, and can be vetoed by observed free plans (`src/core/flagship.ts:120`). This is the correct subscription-auth framing: scarce resource is quota / rate-limit headroom, not API dollars.

`src/core/router.ts` decides the initial tier and risk. It uses deterministic `classify` first; only ambiguous no-evidence turns call the injected cheap `ModelClassifier` (`src/core/router.ts:201`). `src/core/route-classifier.ts` builds that classifier by routing to worker tier, read-only, short timeout, and failing soft to `null` (`src/core/route-classifier.ts:45`). It deliberately does not use learned provider order because this call is a cheap classifier, not work execution (`src/core/route-classifier.ts:55`).

`src/core/route.ts` chooses the concrete provider and model. It clamps the requested tier through `clampTier` (`src/core/route.ts:35`), then walks learned order if present, then `policy.providerOrderByTier`, while preferring authenticated providers and filtering by `availableModels` (`src/core/route.ts:92`). `decisionFor` picks OpenCode models through `selectOpencodeModel` when a real `opencode models` list exists, otherwise falls back to `getCheapestForTier` (`src/core/route.ts:121`).

`src/core/orchestrate.ts` wires these pieces. It decides route classification (`src/core/orchestrate.ts:331`), gates initial manager admission (`src/core/orchestrate.ts:705`), calls `route()` for the work run (`src/core/orchestrate.ts:736`), emits `tier-start` with provider/model (`src/core/orchestrate.ts:800`), builds a `ProviderRequest` with only model/prompt/cwd/sandbox/timeout/native-session fields (`src/core/orchestrate.ts:810`), reuses `route()` for failover preview (`src/core/orchestrate.ts:1078`), and routes cross-vendor review through the same manager admission path (`src/core/orchestrate.ts:1163`).

`src/providers/detect.ts` already exposes `ProviderStatus.availableModels` (`src/providers/detect.ts:31`). Today Claude detection returns aliases `opus`, `sonnet`, `haiku`; Codex detection returns a small static list `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` (`src/providers/detect.ts:340`); OpenCode runs `opencode models` and parses real `provider/model` ids (`src/providers/detect.ts:439`).

`src/core/routing-memory.ts` is the existing learned seed. It computes provider stats per tier from ledger `success` and `durationMs`, requires minimum runs per provider, needs at least two qualified providers, then ranks success rate before latency (`src/core/routing-memory.ts:69`, `src/core/routing-memory.ts:136`). `learnedProviderOrder` is threaded into `route()` by both one-shot and interactive wiring.

`src/core/tool-state.ts` is the self-awareness owner. `buildToolStateContext` renders live provider auth, plans, effective mode, and tool capabilities into an "ABOUT THIS TOOL" block (`src/core/tool-state.ts:97`). `src/core/prompt-context.ts` assembles `ENVIRONMENT -> TOOL-STATE -> MEMORY -> INTENT -> ENGAGEMENT -> partner posture`, capped globally, so model self-awareness already has the right prompt plumbing.

### What's missing

There is no provider-agnostic model capability shape. Current routing knows tier, provider order, auth, cooldown-filtered availability, advertised model ids, and learned provider order. It does not know objective model facts such as supported reasoning efforts, context window, max output, vision, tool/function support, native session support, or provider-specific mode knobs.

There is no merge layer between declarative defaults and dynamic model sources. `availableModels` is already detected, and `$CODEX_HOME/models_cache.json` contains richer local Codex metadata, but route selection consumes only string ids. In this workspace the Codex cache shape is:

```json
{
  "fetched_at": "2026-06-06T14:36:31.014120252Z",
  "client_version": "0.137.0",
  "models": [
    {
      "slug": "gpt-5.5",
      "display_name": "GPT-5.5",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        { "effort": "low" },
        { "effort": "medium" },
        { "effort": "high" },
        { "effort": "xhigh" }
      ],
      "context_window": 272000,
      "max_context_window": 1000000,
      "input_modalities": ["text", "image"],
      "supports_search_tool": true,
      "supports_parallel_tool_calls": true
    }
  ]
}
```

There is no routed effort or mode decision. Codex can be invoked externally with `-c model_reasoning_effort=high`, and the cache declares `supported_reasoning_levels`, but `ProviderRequest` has no `reasoningEffort` / `mode` field and `buildCodexArgs` does not thread one.

There is no model-level learned outcome layer. `routing-memory.ts` ranks providers per tier, not provider/model/effort by task type. That is the right seed, but it cannot yet learn that one model/effort is consistently faster or more successful for large-repo edits, review, or architecture turns.

## 2. Three-Layer Registry Architecture

The registry has one invariant: unknown is absent. No capability is guessed from brand, marketing name, or subjective reputation. A missing field means "we do not know", not "false unless convenient". Routing can prefer known fit, but must not punish unknown so heavily that new models are self-limited before evidence arrives.

### Layer 1: Objective declarative capabilities

New pure data owner:

`src/core/model-capabilities.ts`

This file is provider-agnostic reference data and types. It imports no fs, child_process, Date, or provider adapters. It can import `ProviderId` as a type.

Core shape:

```ts
export type CapabilitySource = 'declarative' | 'detect' | 'codex-cache' | 'ledger';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type CostSpeedTier = 'fast' | 'standard' | 'premium' | 'unknown';

export interface ModelCapability {
  readonly provider: ProviderId;
  readonly id: string;
  readonly aliases: readonly string[];
  readonly displayName?: string;
  readonly tierHint?: Tier;
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly defaultReasoningEffort?: ReasoningEffort;
  readonly supportsExtendedThinking?: boolean;
  readonly supportsVision?: boolean;
  readonly inputModalities?: readonly ('text' | 'image' | 'audio' | 'video')[];
  readonly supportsToolCalling?: boolean;
  readonly supportsSearchTool?: boolean;
  readonly supportsParallelToolCalls?: boolean;
  readonly supportsNativeSession?: boolean;
  readonly costSpeedTier?: CostSpeedTier;
  readonly source: readonly CapabilitySource[];
  readonly lastRefreshedAt?: string;
}

export type CapabilityRegistry = Readonly<Record<ProviderId, readonly ModelCapability[]>>;
```

Declarative defaults are deliberately sparse:

```ts
export const DECLARATIVE_MODEL_CAPABILITIES: CapabilityRegistry = {
  claude: [
    {
      provider: 'claude',
      id: 'opus',
      aliases: ['claude-opus-4-7', 'opus-4.7'],
      tierHint: 'manager',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      source: ['declarative'],
    },
    {
      provider: 'claude',
      id: 'sonnet',
      aliases: ['claude-sonnet-4-6', 'sonnet-4.6'],
      tierHint: 'ic',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      source: ['declarative'],
    },
    {
      provider: 'claude',
      id: 'haiku',
      aliases: ['claude-haiku-4-5', 'haiku-4.5'],
      tierHint: 'worker',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      source: ['declarative'],
    },
  ],
  codex: [
    {
      provider: 'codex',
      id: 'gpt-5.5',
      aliases: [],
      tierHint: 'manager',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      source: ['declarative'],
    },
    {
      provider: 'codex',
      id: 'gpt-5.4',
      aliases: [],
      tierHint: 'ic',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      source: ['declarative'],
    },
    {
      provider: 'codex',
      id: 'gpt-5.4-mini',
      aliases: [],
      tierHint: 'worker',
      supportedReasoningEfforts: [],
      supportsNativeSession: true,
      source: ['declarative'],
    },
  ],
  opencode: [],
};
```

Notes:

- Context windows from `infra/pricing.ts` can seed `contextWindow` when present, but should be treated as declarative and date-stamped because pricing tables rot.
- `supportsExtendedThinking` is only true when a local dynamic source or an explicit provider doc-backed declarative entry says so. Do not set it from "Claude" as a brand.
- OpenCode declarative defaults remain empty because it is a meta-provider. Its real capabilities come from `opencode models` plus optional later adapters for model manifests.
- Gemini later is a clean drop-in: add `ProviderId`, detection, adapter, and a `gemini` key. No model-specific routing code should assume the provider set is only three entries.

Real-run verification:

- Unit: construct the declarative registry and assert all providers exist, ids are unique per provider, aliases do not collide within a provider, and every enum value is known.
- Real: run `myshell-tools doctor` or the existing detection path and confirm the app still starts with the registry file imported but unused. No provider spawn behavior changes in stage 1.

### Layer 2: Dynamic refresh / merge

New infra owner:

`src/infra/model-capability-refresh.ts`

This is the only layer that reads local files or provider detection results. It returns a pure registry value and never blocks orchestration if refresh fails.

Inputs:

```ts
export interface RefreshCapabilityInput {
  readonly env: EnvironmentStatus;
  readonly cwd: string;
  readonly codexHome?: string;
  readonly nowIso: string;
}
```

Outputs:

```ts
export interface CapabilitySnapshot {
  readonly registry: CapabilityRegistry;
  readonly diagnostics: readonly CapabilityRefreshDiagnostic[];
}

export interface CapabilityRefreshDiagnostic {
  readonly provider: ProviderId;
  readonly source: CapabilitySource;
  readonly level: 'info' | 'warn';
  readonly message: string;
}
```

Merge rules:

1. Start with `DECLARATIVE_MODEL_CAPABILITIES`.
2. Merge `ProviderStatus.availableModels` from `detect.ts`.
3. Merge Codex `$CODEX_HOME/models_cache.json` when readable and valid.
4. Never delete declarative entries when dynamic sources are unavailable.
5. Never fabricate a field from another field. Example: a Codex cache model with `input_modalities: ['text', 'image']` sets `supportsVision: true`; a model with missing `input_modalities` leaves `supportsVision` undefined.
6. Dynamic ids add new models but do not invent tier. Unknown dynamic models get no `tierHint`; routing can still consider them only when a tier selector has a safe fallback.
7. `source` accumulates all contributors and `lastRefreshedAt` is set only for dynamic data.

Codex cache parser:

```ts
interface CodexModelsCache {
  readonly fetched_at?: string;
  readonly client_version?: string;
  readonly models?: readonly unknown[];
}

interface CodexCacheModel {
  readonly slug?: string;
  readonly display_name?: string;
  readonly default_reasoning_level?: string;
  readonly supported_reasoning_levels?: readonly { readonly effort?: string }[];
  readonly context_window?: number;
  readonly max_context_window?: number;
  readonly input_modalities?: readonly string[];
  readonly supports_search_tool?: boolean;
  readonly supports_parallel_tool_calls?: boolean;
}
```

Failure modes:

- Offline/headless/cron: cache read may fail; use declarative plus detection.
- Corrupt JSON: emit a diagnostic and keep defaults.
- Stale cache: still usable as local fact if schema-valid, but mark `lastRefreshedAt` from `fetched_at`. A future stale threshold can lower confidence for display without removing facts.
- Unknown reasoning effort string: ignore that effort and keep the rest.

Why this does not self-limit:

- Dynamic source adds models; it does not remove unknown models just because the declarative list is stale.
- Capability-fit is an additive rank signal. It can prefer a model that declares `xhigh` for hard reasoning, but it should not permanently blacklist a model with missing effort metadata.
- The registry records what is known, not what the maintainer believes.

Real-run verification:

- With the current workspace cache, a one-shot diagnostic command or test harness should show `codex/gpt-5.5` with `supportedReasoningEfforts: ['low','medium','high','xhigh']`, `defaultReasoningEffort: 'medium'`, and `contextWindow: 272000`.
- Move `models_cache.json` aside in a temp `CODEX_HOME`; rerun refresh; verify no throw and Codex declarative models remain.
- Corrupt a temp cache file; rerun refresh; verify diagnostic only.
- Run detection with OpenCode installed and models present; verify every parsed `opencode provider/model` id appears in the registry with `source: ['detect']` and no invented context/reasoning fields.

### Layer 3: Learned outcomes

Extend, do not replace, `src/core/routing-memory.ts`.

Current `learnProviderOrder` is provider-by-tier. Keep it. Add a second optional aggregate that is model-aware and task-aware:

```ts
export type TaskKind =
  | 'trivial'
  | 'implementation'
  | 'debug'
  | 'review'
  | 'architecture'
  | 'large-context'
  | 'unknown';

export interface ModelOutcomeStats {
  readonly provider: ProviderId;
  readonly model: string;
  readonly tier: Tier;
  readonly taskKind: TaskKind;
  readonly runs: number;
  readonly successes: number;
  readonly successRate: number;
  readonly avgDurationMs: number;
  readonly avgInputTokens: number;
  readonly avgOutputTokens: number;
  readonly confidenceWeight: number;
}
```

Minimal new ledger signal:

- No embeddings, no vector DB, no API calls.
- Add optional fields to future `LedgerEntry`: `taskKind?: TaskKind`, `reasoningEffort?: ReasoningEffort`, `capabilityFit?: readonly string[]`.
- For backward compatibility, old ledger entries aggregate as `taskKind: 'unknown'`.
- `taskKind` comes from existing deterministic classification plus route/intent signals. Example: `manager` + architecture keywords -> `architecture`; repo-map token estimate above threshold -> `large-context`; review path -> `review`. If uncertain, `unknown`.

Conservative aggregation:

- Minimum 5 runs per provider/model/taskKind before using model-level outcome order.
- Minimum 2 candidates before returning an order.
- Smooth success rate with a neutral prior, for example `(successes + 1) / (runs + 2)`, so 1/1 does not dominate 20/25.
- Prefer success first, then lower duration, then lower token use only as a tie-breaker. Token use is a quota signal, not quality.
- Recency filtering stays in the caller, same as `routing-memory.ts`; pure aggregators do not parse timestamps.
- Cold start is declarative capability-fit plus existing policy order.

Real-run verification:

- Unit: old ledger entries without `taskKind` still produce the same `learnProviderOrder` output.
- Unit: model outcome order returns `null` until the minimum run threshold is met.
- Real: run a sequence of small deterministic tasks against two providers with learning enabled; verify `learnedProviderOrder` remains provider-level until enough model-level evidence exists.

## 3. Routing Integration

### What stays

Keep all existing routing machinery:

- `Mode` / `MODE_LABELS` / policy presets stay owned by `src/core/policy.ts`.
- `authorizeTier` remains the only manager admission gate.
- `availableAfterCooldown` remains the session-local rate-limit bias.
- `learnedProviderOrder` remains provider-level and is still tried before static `providerOrderByTier`.
- `makeRouteClassifier` remains worker-tier, read-only, short timeout, and does not use learned order.
- `route()` remains pure and fail-soft in spirit: no I/O, no time, no provider spawning.
- `assembleContextBlocks` remains the only prompt context seam.

### What changes

Extend `RouteDecision` in `src/core/types.ts`:

```ts
export interface RouteDecision {
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly capabilityReasons?: readonly string[];
}
```

Extend `route()` with an optional `capabilityContext` parameter after existing optional args to preserve default behavior:

```ts
export interface CapabilityRouteContext {
  readonly registry?: CapabilityRegistry;
  readonly taskSignals?: CapabilityTaskSignals;
  readonly modelOutcomeOrder?: readonly ModelPreference[];
  readonly mode: Mode;
}

export interface CapabilityTaskSignals {
  readonly risk: Risk;
  readonly routePlan: boolean;
  readonly estimatedInputTokens?: number;
  readonly needsVision?: boolean;
  readonly taskKind: TaskKind;
}
```

Ranking order inside `route()` should become:

1. Candidate provider pool from existing `available`, auth filtering, cooldown-filtered caller list, failover pool, and static/learned provider order.
2. Candidate model set from existing tier and `availableModels`.
3. Capability-fit score within that bounded candidate set.
4. Existing pricing fallback when no registry model matches.

Capability-fit is bounded:

- It cannot select a provider outside `available`.
- It cannot select a signed-out provider ahead of a signed-in provider when `authenticatedProviders` is known.
- It cannot bypass `authorizeTier`.
- It cannot ignore `policy.maxTier` or `effPolicy` manager lift.
- It cannot choose OpenCode ids not returned by `opencode models`.
- It cannot force a reasoning effort unsupported by the selected model.

Example fit signals:

- Large context: prefer known `contextWindow` above estimated input size with margin. Unknown context is neutral, not disqualifying.
- Vision: require `supportsVision === true` only when the task includes image inputs. Unknown/false models are not selected for image tasks unless no known vision-capable candidate exists, in which case the route should proceed with an honest warning or ask for a supported provider.
- Hard reasoning: prefer models with `xhigh` or `high`; select effort based on mode and risk.
- Review: prefer cross-vendor as today; within reviewer provider, prefer model with high reasoning effort support and known tool support.
- Native session: when `deps.nativeSession` has a plan for the selected provider, prefer models with `supportsNativeSession === true`, but never switch providers solely for native continuity if learned/cooldown/policy says otherwise.

Effort selector:

```ts
export function selectReasoningEffort(input: {
  readonly model: ModelCapability;
  readonly mode: Mode;
  readonly tier: Tier;
  readonly risk: Risk;
  readonly taskKind: TaskKind;
  readonly routePlan: boolean;
}): ReasoningEffort | undefined
```

Rules:

- If `supportedReasoningEfforts` is empty, return `undefined`.
- Efficient: `low` for worker/IC when available; `medium` for admitted manager when available; never `xhigh`.
- Balanced: `medium` default; `high` for high/critical, architecture, review, or large-context; `xhigh` only for admitted manager plus critical/architecture/large-context and only once per turn.
- Max: `high` default for IC/manager hard turns; `xhigh` for admitted manager high/critical architecture/review/large-context when supported.
- If selected effort is unavailable, step down to the nearest lower known effort.

Real-run verification:

- Unit: with no `capabilityContext`, `route()` returns byte-for-byte equivalent decisions to current tests.
- Unit: with a Codex registry declaring `gpt-5.5` supports `xhigh`, a manager/high/architecture route in Max selects `gpt-5.5` and `xhigh` only after `authorizeTier` permits manager.
- Unit: Balanced low-risk manager-classified prompt still drops to IC before route, so capability-fit cannot open manager.
- Real: run `myshell-tools run "design a migration plan..."` in Max with Codex authenticated and verify `tier-start` still names the provider/model and the adapter receives `model_reasoning_effort` only if supported.

## 4. Self-Awareness Integration

Self-awareness should extend `buildToolStateContext`, not add another prompt block.

Extend `ToolStateInput`:

```ts
export interface ToolStateInput {
  readonly version: string;
  readonly providers: readonly ToolStateProvider[];
  readonly mode: Mode;
  readonly modeIsAuto: boolean;
  readonly smartRoute: boolean;
  readonly capabilitySummary?: CapabilitySelfAwarenessSummary;
}
```

Summary shape:

```ts
export interface CapabilitySelfAwarenessSummary {
  readonly providers: readonly {
    readonly provider: ProviderId;
    readonly authed: boolean;
    readonly models: readonly {
      readonly id: string;
      readonly tierHint?: Tier;
      readonly contextWindow?: number;
      readonly reasoningEfforts?: readonly ReasoningEffort[];
      readonly supportsVision?: boolean;
      readonly supportsNativeSession?: boolean;
    }[];
  }[];
  readonly learned?: readonly {
    readonly tier: Tier;
    readonly order: readonly ProviderId[];
    readonly reason: string;
  }[];
}
```

Rendered text must stay capped. It should not list every field for every model on every turn. It should render:

- Authenticated providers and plan status, as today.
- Known available model names per authenticated provider, capped to top 3 per provider by tier/capability.
- Known objective facts only: `reasoning: low/medium/high/xhigh`, `context: 272k`, `vision: yes`, `native sessions: yes`.
- Learned order only if it exists and has enough signal, for example: "Observed outcomes currently prefer Claude then Codex for IC tasks (success, then latency; minimum-run gated)."
- A routing explanation template the model can reuse: "Routing is bounded by mode, plan, cooldown, flagship admission, and observed outcomes; unknown capabilities are not guessed."

Example block addition:

```text
- Known model capabilities (objective, local): Codex gpt-5.5 supports reasoning low/medium/high/xhigh, text+image input, 272k context; gpt-5.4-mini supports low/medium/high/xhigh when present in Codex cache. Claude reports model aliases opus/sonnet/haiku; no local machine-readable reasoning-effort metadata is available, so do not claim a specific effort knob for Claude.
- Routing explanations: explain choices using tier, mode, plan/cooldown, known capability fit, and learned outcomes. Do not claim a model is "better" without ledger evidence.
```

This gives the partner enough to answer:

"For this I'd use Codex gpt-5.5 at xhigh because the task is architecture-heavy, Max mode admits the flagship, the local Codex cache says this model supports xhigh, and the registry knows its large context window. If Max is not active or the flagship is not admitted, I would step down to the best IC model and high/medium effort."

No extra model calls. The data is assembled where `buildToolStateContext` is already called in `src/cli.ts` and `src/interface/menu.ts`, then rides `assembleContextBlocks`.

Real-run verification:

- Ask: "What subscriptions am I signed into and what models can you use?" The response should cite the ABOUT block facts, not read files.
- Ask: "Why did you route this to Codex?" after a run. The response should mention actual `tier-start`/decision facts when available and avoid unsupported claims.
- Disable/corrupt Codex cache and ask again. The response should say Codex models are known from detection only and reasoning levels are unknown.

## 5. Effort / Mode Knobs

Add provider-agnostic request fields:

```ts
export interface ProviderRequest {
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly sandbox: SandboxLevel;
  readonly timeoutMs: number;
  readonly sessionId?: string;
  readonly resume?: boolean;
  readonly reasoningEffort?: ReasoningEffort;
  readonly providerMode?: string;
}
```

Provider behavior:

- Codex: if `reasoningEffort` is set and the selected model capability includes it, append `-c model_reasoning_effort=<effort>` to `buildCodexArgs`. This matches the existing CLI invocation style observed in the live process. If unsupported or undefined, omit it.
- Claude: do not invent a CLI flag. If a future local machine-readable source or verified CLI flag exposes extended thinking / ultrathink as an invocation knob, map it through `providerMode` or a typed Claude-specific adapter field. Until then, the registry can state "extended thinking support unknown locally" or "known from docs/source" only if backed by a maintained declarative entry.
- OpenCode: omit unless OpenCode exposes a stable per-model effort flag. For now its models are selected by real `opencode models` and `selectOpencodeModel`.

Cost/latency discipline:

- Effort is selected only for the work run, review run, hedge branch, or panel member, never for the cheap route classifier unless a future test proves value.
- High/xhigh must respect `Mode`, `authorizeTier`, `maxFlagshipAttemptsPerTurn`, cooldown, and timeout caps.
- xhigh should be reserved for admitted manager-tier or explicitly hard IC turns in Max, not casual worker tasks.
- If quota pressure or cooldown exists, effort can step down before switching providers.
- Effort choices are recorded in ledger for later outcome learning.

Real-run verification:

- Unit: `buildCodexArgs` omits `model_reasoning_effort` when undefined.
- Unit: `buildCodexArgs` includes `-c model_reasoning_effort=xhigh` only when `ProviderRequest.reasoningEffort === 'xhigh'`.
- Real: run a short Codex task in Efficient and verify no xhigh flag. Run an architecture task in Max and verify the spawned argv includes the selected effort.
- Ledger: verify the recorded entry includes model and effort when the request used one.

## 6. Provider-Native Skills & Agents Verdict

Verdict: defer using provider-native skills and subagents inside myshell-tools orchestration. Reflect their existence in the capability registry as objective provider features only after verified locally, but do not let them execute under the v1 registry.

Reasoning:

- Claude Code skills and subagents are real provider-native mechanisms. Official Claude Code docs describe Skills as filesystem artifacts and subagents as independently delegated agents with their own configuration; subagents can replace the default system prompt and can consume extra context/tools. See Claude Skills docs and Claude sub-agent docs: https://docs.claude.com/en/docs/claude-code/skills and https://code.claude.com/docs/en/sub-agents.
- myshell-tools already has its own orchestration plane: tier routing, panel, cross-vendor review, native sessions, memory, repo-map, intent, engagement, work contracts, cooldown, and ledger. Letting Claude internally spawn subagents creates a nested orchestrator whose decisions are not visible to `route()`, `authorizeTier`, cooldown, or learned outcomes.
- Skills can be useful as provider-local instruction packs, but invoking them from inside myshell-tools makes capability and outcome attribution ambiguous. Was success due to Claude Opus, the skill, a subagent model, or a hidden permission mode? The registry's core value is auditable routing.
- Security and permissions become harder. Claude subagents can have their own tools, model, permission mode, hooks, and skills. That conflicts with myshell-tools' provider-agnostic sandbox and panel discipline.
- Reliability verification is weaker. A nested agent may burn context/quota or fail internally while myshell-tools sees only a single provider run.

Recommended path:

1. v1 registry records provider-native features as non-routable facts: `supportsProviderSkills?: boolean`, `supportsProviderSubagents?: boolean`, `providerFeatureSource?: string`.
2. Do not auto-enable them.
3. Later, consider explicit user opt-in per provider, with visible audit metadata in `RouteDecision` and ledger: `providerNativeFeaturesUsed: ['claude-skill:<name>']`.
4. Never let provider-native agents replace myshell-tools' cross-provider panel/review. If used later, they should be leaf execution aids inside a single provider route.

## 7. Gemini Verdict

Verdict: skip Gemini now, but design every registry shape so Gemini is a clean later provider.

Reasoning:

- Subscription-auth fit exists in principle. Official Gemini CLI docs describe "Sign in with Google (OAuth login using your Google Account)" as an auth option and position it for individual developers and Gemini Code Assist licenses. The same docs also include API key and Vertex AI paths, which myshell-tools must not use under the subscription-auth-only constraint. Source: https://github.com/google-gemini/gemini-cli and https://google-gemini.github.io/gemini-cli/docs/cli/authentication.html.
- The adapter/parsing cost is non-trivial. Adding Gemini means new detection, auth-state parsing, model list parsing, streaming event parser, sandbox/permission mapping, native session assessment, error classification, and ledger correctness.
- Guardrail risk is high mid-architecture. The registry is already touching route decisions, self-awareness, and provider request knobs. Adding a fourth provider at the same time expands the test matrix and makes it harder to prove the registry did not regress Claude/Codex/OpenCode.
- OAuth/headless behavior needs real-run validation. The Gemini CLI OAuth flow has had headless/container friction reported in the project issue tracker, so subscription-auth support cannot be assumed robust in the environments myshell-tools cares about.
- Terms and integration boundaries must be respected. The design should shell out to the official CLI as a user-invoked subscription tool if added later; it must not scrape or reuse OAuth tokens directly.

Design-for-later requirements:

- `ProviderId` extension should be the only type-level provider addition.
- `CapabilityRegistry` already supports `gemini: ModelCapability[]`.
- Detection should produce `ProviderStatus.availableModels` and plan/auth facts exactly like other providers.
- Gemini-specific dynamic metadata belongs in a Gemini refresh parser, not in `route()`.
- Until then, no Gemini code, no Gemini policy entry, and no Gemini route candidate.

## 8. Staged Build Plan

### Stage 1: Highest leverage - Codex cache to capability registry and self-awareness

Build:

- Add `model-capabilities.ts` types and declarative defaults.
- Add `model-capability-refresh.ts` that merges `detect.ts` `availableModels` plus `$CODEX_HOME/models_cache.json`.
- Extend `buildToolStateContext` input/rendering with a capped capability summary.
- Do not change route decisions yet.

Why first:

- It is objective.
- It uses a real local source already present.
- It improves self-awareness immediately.
- It has zero provider execution risk.
- It gives the later router tests a factual fixture.

Exact real-run test:

1. Use Node 22.
2. Run an interactive or one-shot prompt: "What Codex models and reasoning efforts can you see for my setup?"
3. Expected: the answer says Codex `gpt-5.5` is known from local cache and supports low/medium/high/xhigh; it mentions context only when present; it does not claim Claude reasoning efforts unless declared.
4. Rename `$CODEX_HOME/models_cache.json` temporarily and repeat.
5. Expected: the answer degrades to detection/declarative facts and says reasoning levels are unknown.

### Stage 2: Capability-fit ranking in `route()`, no effort flag yet

Build:

- Extend `RouteDecision` with `capabilityReasons`.
- Add optional `CapabilityRouteContext` to `route()`.
- Use context window, vision, native session, and known tier hints as within-provider model selection signals.
- Preserve current output when context is absent.

Real-run test:

- With capability context absent, existing route tests pass unchanged.
- With a fake registry, large-context task chooses a model with sufficient known context over a smaller same-provider model.
- With real env, normal tasks still route according to policy/learned/cooldown.

### Stage 3: Reasoning effort selector and Codex adapter wiring

Build:

- Add `ReasoningEffort` to `ProviderRequest`.
- Add `selectReasoningEffort`.
- Thread effort from `route()` to work, review, hedge, and panel request creation.
- Add Codex `-c model_reasoning_effort=<effort>` only when selected and supported.
- Record effort in ledger.

Real-run test:

- Efficient simple prompt on Codex: no xhigh.
- Max architecture prompt on Codex `gpt-5.5`: xhigh when manager admitted.
- Balanced low-risk manager-classified prompt: no manager, no xhigh.

### Stage 4: Learned model outcomes

Build:

- Add optional `taskKind` and `reasoningEffort` to ledger entries.
- Add model-level aggregation with neutral priors and minimum runs.
- Feed model outcome order as a weak rank term after hard capability requirements.

Real-run test:

- Seed ledger fixtures: below threshold returns no model preference.
- Above threshold returns deterministic model order.
- Real repeated tasks eventually produce an explanation that says "observed outcomes prefer..." only after the threshold is met.

### Stage 5: Provider-native feature inventory, still not execution

Build:

- Add non-routable provider feature facts for skills/subagents when locally verifiable.
- Render them in self-awareness as "available in provider, not used by myshell-tools routing".

Real-run test:

- Ask "Can you use Claude skills/subagents?" Expected answer: "Claude Code supports them, but myshell-tools does not invoke them automatically; routing uses myshell-tools' orchestrator."

### Stage 6: Gemini spike only after registry stabilizes

Build:

- Detection-only Gemini spike behind a feature flag.
- No routing until auth, model list, parser, sandbox, errors, and real-run tests pass.

Real-run test:

- `gemini` installed and OAuth-authenticated: detection reports installed/authenticated and available models.
- Headless/offline: detection fails soft and does not affect existing providers.

## 9. Risks

Capability staleness: declarative facts rot. Mitigation: keep them sparse, dynamic merge where possible, and expose `source`/`lastRefreshedAt`.

False precision: context windows and max output can vary by plan, CLI, or model alias. Mitigation: unknown absent; stale facts marked; routing treats unknown as neutral except when a hard requirement exists.

Overfitting ledger outcomes: a few lucky successes could dominate. Mitigation: minimum runs, neutral priors, recency filtering in caller, and provider-level fallback.

Quota pressure from xhigh: higher effort may consume more quota and latency. Mitigation: mode-bounded selector, manager admission, one manager attempt in Balanced, cooldown, and timeout caps.

Nested orchestration opacity: provider-native subagents can hide model/tool choices. Mitigation: defer execution and keep myshell-tools as the orchestrator of record.

Provider surface expansion: adding Gemini during the registry change could make failures hard to attribute. Mitigation: skip now, design generic shapes, add later behind a flag.

## 10. Deliberately Not Built

No subjective strengths/weakness prose.

No API keys.

No embeddings.

No vector DB.

No metered services.

No remote model catalog fetch beyond provider CLIs' own local caches/detection.

No hard dependency on Codex cache availability.

No Gemini provider in the initial registry implementation.

No automatic Claude skills/subagents.

No router replacement.

No learned routing before sufficient evidence.

No hidden provider-specific capability guesses.

## Executive Summary

1. Build a provider-agnostic capability registry with objective fields only.
2. Start from sparse declarative defaults and merge dynamic local facts fail-soft.
3. Use `ProviderStatus.availableModels` and Codex `models_cache.json` first.
4. Keep tier routing, modes, flagship admission, cooldown, and learned provider order.
5. Add capability-fit as a bounded rank signal, not a router replacement.
6. Add reasoning effort as a typed request knob, initially safest for Codex.
7. Feed the same facts into `buildToolStateContext` through `assembleContextBlocks`.
8. Let ledger outcomes shape preferences after minimum evidence, not opinions.
9. Defer Claude native skills/subagents as execution mechanisms; inventory only.
10. Skip Gemini now, but keep the registry generic so it drops in later.
