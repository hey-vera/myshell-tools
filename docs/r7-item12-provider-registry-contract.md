# Item 12 contract - async startup, provider registry, and latency feel budget

Status: delegation-ready implementation contract, grounded at repository head `3a93e2f` on 2026-07-02.

This document is controlling for Round-7 Item 12. It also absorbs the folded Candidate Item 21 latency and feel budget. Item 10 owns exactly-once execution and safe retry. Item 13 owns goal scheduling. Item 17 owns `CompletionResultV1`; this contract reuses that vocabulary by reference and must not redefine it. Item 11 owns the canonical event log; this contract emits/references provider-generation observations but does not redefine the log.

Required-reading drift at authoring time: `docs/r7-item17-completion-contract.md` is not present in this checkout. The contract therefore names `CompletionResultV1` only as an external Item-17 type. `docs/r7-item11-durable-context-contract.md` is present but untracked in the local worktree and is treated as pre-existing user work. This file is the only intended edit.

## 1. Outcome and deliberately smaller boundary

When `MYSHELL_PROVIDER_REGISTRY_V1` is explicitly enabled, myshell has one immutable provider/capability generation at any instant. Every route, preflight, work call, retry decision, native-session decision, web-search helper, goal scheduler, and UI self-awareness block consumes that same generation id and the same capability facts. Provider detection and capability refresh are progressive and nonblocking: the prompt is available first, partial facts land as generation updates, slow probes time out into honest `pending/timed-out` facts, and late probes publish a newer generation rather than mutating an older one.

The required outcome is narrow:

- prompt and menu input are available before provider/capability probes finish;
- installed/authenticated/provider-model/capability/cooldown facts are one versioned snapshot, not scattered closure state;
- login, logout, account changes, Retry-After, cooldown expiry, slow-probe timeout, and manual refresh invalidate by publishing a new generation;
- routing reacts to generation changes before opening a provider stream and records the generation used;
- provider probes and capability refreshes are cancel-aware, fail-soft, and never block direct user input;
- latency and feel budgets are first-class acceptance targets with receipts.

This item does **not**:

- implement Item 10's exactly-once state machine;
- implement Item 13's multi-goal scheduler;
- redefine Item 17 `CompletionResultV1`, replay policy, or goal settlement;
- redefine Item 11 canonical events, snapshots, or storage;
- change provider adapters' call protocols except to consume a generation reference;
- make semantic preflight, durable context, provider registry, or goal scheduling default-on;
- promise live cloud quota truth that subscription CLIs do not expose.

## 2. Current-state evidence and invariants

All citations below are current at `3a93e2f`; workers must re-run line numbering before editing and record drift rather than silently relying on stale ranges.

- `ProviderStatus` already has installed, version, authenticated, plan, binary path, and available models at `src/providers/detect.ts:45-53`; `EnvironmentStatus` is the four-provider aggregate at `src/providers/detect.ts:55-60`.
- Provider detection uses real local probes and 10,000 ms subprocess timeouts: Claude version/auth at `src/providers/detect.ts:511-555`, Codex version/auth at `src/providers/detect.ts:630-655`, OpenCode version/auth/models at `src/providers/detect.ts:864-906`, and Grok version/models at `src/providers/detect.ts:1009-1050`.
- `detectEnvironment()` already probes all four providers in parallel at `src/providers/detect.ts:1065-1071`.
- `buildProviders(...)` registers installed providers at `src/providers/registry.ts:37-62`; `buildAuthenticatedProviders(...)` filters to signed-in providers at `src/providers/registry.ts:75-87`.
- The capability registry's fact model is sparse and explicit: `CapabilitySource` and `ReasoningEffort` are at `src/core/model-capabilities.ts:34-38`, `ModelCapability` is at `src/core/model-capabilities.ts:75-118`, and `CapabilityRegistry` is at `src/core/model-capabilities.ts:120-121`.
- Capability refresh consumes already-detected provider facts at `src/core/model-capability-refresh.ts:43-60`, returns a `CapabilitySnapshot` at `src/core/model-capability-refresh.ts:71-75`, and reads dynamic sources through an injected port at `src/core/model-capability-refresh.ts:82-97`.
- Surface divergence is already named as data: `SurfaceCapability` is at `src/core/surface-capabilities.ts:21-30`, the matrix is at `src/core/surface-capabilities.ts:49-104`, and the REPL subset guard is at `src/core/surface-capabilities.ts:110-126`.
- Menu keeps rate-limit cooldowns in process memory at `src/interface/menu.ts:1051-1057` and records rate-limit observations at `src/interface/menu.ts:1640-1678`.
- Menu currently memoizes objective capability summary and registry once per chat session at `src/interface/menu.ts:1072-1091`; it awaits the first resolution before building turn deps at `src/interface/menu.ts:2113-2115`.
- `buildDeps(...)` is intentionally rebuilt after re-login and each goal turn from live mutable env at `src/interface/menu.ts:2168-2171`; it derives available models at `src/interface/menu.ts:2219-2243`, authenticated providers after cooldown at `src/interface/menu.ts:2245-2261`, and passes the memoized capability registry to orchestrate at `src/interface/menu.ts:2443-2447`.
- Inline re-login re-detects after auth success at `src/interface/menu.ts:6194-6218`.
- Chat prompt availability already has the right direction: the conversation composer is shown before recap, and recap resolves concurrently, at `src/interface/menu.ts:1300-1327`.
- Main-menu first paint is already stale-while-revalidate on live-region output: first frame avoids slow reads at `src/interface/menu.ts:6971-6980`, async fills begin after first paint at `src/interface/menu.ts:7130-7138`, and stale environment refresh runs in the background on the live path at `src/interface/menu.ts:7118-7124`.
- Environment refresh has a TTL and in-flight dedupe at `src/interface/menu.ts:6800-6823`, but it mutates `mutableCtx.env` in place and does not publish a generation id.

Baseline gap:

| surface | current source | Item-12 requirement |
|---|---|---|
| provider auth | `mutableCtx.env` plus ad hoc refresh | immutable generation with invalidation reason |
| capability registry | per-chat `caps` closure | capability snapshot inside the same generation |
| cooldown | per-chat maps | generation facts plus route reaction |
| login/logout | force re-detect and mutate env | publish generation and notify subscribers |
| startup feel | partial first-paint async work | prompt live before every provider/capability probe |
| routing | recomputed from live env/caps closures | route consumes one generation id and records it |

## 3. Shared typed contract

Slice 12a must export these names from `src/core/provider-generation.ts`. Equivalent aliases or renamed fields are not allowed because later slices and fixtures bind to them.

```ts
import type { CapabilityRegistry } from './model-capabilities.js';
import type { CapabilitySnapshot } from './model-capability-refresh.js';
import type { ProviderId } from '../providers/port.js';
import type { EnvironmentStatus, ProviderStatus } from '../providers/detect.js';

export type ProviderGenerationVersion = 1;

export type ProviderGenerationReason =
  | 'startup-initial'
  | 'probe-progress'
  | 'probe-complete'
  | 'slow-probe-timeout'
  | 'login'
  | 'logout'
  | 'account-change'
  | 'manual-refresh'
  | 'rate-limit'
  | 'retry-after'
  | 'cooldown-expired'
  | 'probe-failed';

export type ProviderProbeState =
  | 'unknown'
  | 'pending'
  | 'ready'
  | 'uninstalled'
  | 'unauthenticated'
  | 'failed'
  | 'timed-out';

export interface ProviderProbeReceiptV1 {
  readonly provider: ProviderId;
  readonly state: ProviderProbeState;
  readonly startedAtMs: number;
  readonly completedAtMs?: number;
  readonly durationMs?: number;
  readonly timeoutMs?: number;
  readonly source: 'detect' | 'capability-refresh' | 'cooldown' | 'login' | 'logout';
  readonly errorCategory?: 'timeout' | 'spawn' | 'parse' | 'auth' | 'unknown';
}

export interface ProviderFactV1 {
  readonly provider: ProviderId;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly version: string | null;
  readonly plan: string | null;
  readonly binaryPath: string | null;
  readonly availableModels: readonly string[];
  readonly probeState: ProviderProbeState;
}

export interface ProviderCooldownFactV1 {
  readonly provider: ProviderId;
  readonly accountId?: string;
  readonly reason: 'rate-limit' | 'retry-after' | 'correlated-429';
  readonly observedAtMs: number;
  readonly untilMs: number;
  readonly retryAfterMs?: number;
  readonly sourceEventId?: string;
}

export interface ProviderLatencyReceiptV1 {
  readonly version: 1;
  readonly generationId: string;
  readonly promptReadyMs?: number;
  readonly menuFirstPaintMs?: number;
  readonly chatPromptReadyMs?: number;
  readonly firstProviderFactMs?: number;
  readonly fullProbeCompleteMs?: number;
  readonly blockingPreAnswerCalls: number;
  readonly cancelled: boolean;
}

export interface ProviderGenerationV1 {
  readonly version: 1;
  readonly generationId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly reason: ProviderGenerationReason;
  readonly priorGenerationId: string | null;
  readonly environment: EnvironmentStatus;
  readonly providerFacts: Readonly<Record<ProviderId, ProviderFactV1>>;
  readonly authenticatedProviders: readonly ProviderId[];
  readonly capabilityRegistry: CapabilityRegistry;
  readonly capabilityDiagnostics: CapabilitySnapshot['diagnostics'];
  readonly cooldowns: readonly ProviderCooldownFactV1[];
  readonly receipts: readonly ProviderProbeReceiptV1[];
  readonly latency?: ProviderLatencyReceiptV1;
}

export interface ProviderGenerationUpdateV1 {
  readonly previous: ProviderGenerationV1;
  readonly current: ProviderGenerationV1;
  readonly reason: ProviderGenerationReason;
}

export type ProviderGenerationSubscriber = (update: ProviderGenerationUpdateV1) => void;
```

Caps and parsing are part of the contract:

- `generationId` matches `/^pg_[a-z0-9_-]{8,64}$/`; `sequence` is strictly increasing per process.
- `priorGenerationId` is the previous committed generation or `null` for genesis.
- `providerFacts` always has exactly `claude`, `codex`, `opencode`, and `grok`.
- `authenticatedProviders` is derived from `providerFacts[*].authenticated` after active cooldown filtering only when a route asks for routable providers; the raw generation keeps the real auth truth.
- Capability registry is the output of the existing sparse merge rules. Unknown remains absent or empty, never fabricated.
- Cooldown expiry facts are retained in the generation until `untilMs <= now`; publishing `cooldown-expired` removes them through a new generation.
- Every array is frozen or treated as readonly by construction. No consumer may mutate `environment`, `providerFacts`, `capabilityRegistry`, `cooldowns`, or receipts in place.

The impure runtime layer may carry provider adapter instances beside the pure generation:

```ts
export interface ProviderRuntimeGenerationV1 {
  readonly generation: ProviderGenerationV1;
  readonly providers: Partial<Record<ProviderId, import('../providers/port.js').Provider>>;
}
```

The adapter map is process memory only. It is derived from the same generation and is never persisted in Item 11 events.

## 4. Generation store, subscription, and invalidation rules

Slice 12b must implement one generation store. The store is the only in-process authority for provider/capability facts when the flag is enabled.

Required API shape:

```ts
export interface ProviderGenerationStoreV1 {
  current(): ProviderRuntimeGenerationV1;
  subscribe(subscriber: ProviderGenerationSubscriber): () => void;
  refresh(reason: ProviderGenerationReason, signal: AbortSignal): Promise<ProviderRuntimeGenerationV1>;
  publish(update: ProviderRuntimeGenerationV1, reason: ProviderGenerationReason): ProviderRuntimeGenerationV1;
  invalidate(reason: ProviderGenerationReason, detail?: unknown): ProviderRuntimeGenerationV1;
}
```

Rules:

1. `current()` is synchronous and always returns a generation, even during startup. The genesis generation may contain `unknown/pending` facts but must be complete in shape.
2. `refresh(...)` may run probes in the background. It must publish at least one progress generation before any slow probe can block the prompt.
3. Subscribers are called after commit, never before. Subscriber exceptions are swallowed and recorded as diagnostics; they cannot roll back a generation.
4. Late probe results compare against their launch generation. If stale, they publish a new generation by merging facts into the latest generation, not by mutating the old one.
5. Login/logout/account-change invalidates auth and model facts for the affected provider immediately, then launches a refresh. A logout generation must make the provider unroutable before the slow refresh completes.
6. Slow-probe timeout is an invalidation reason. The timed-out provider becomes `timed-out` or remains `pending`; known prior facts may be retained only with an explicit stale marker in the receipt. Routing must prefer non-stale providers.
7. Retry-After/rate-limit publishes cooldown facts before any retry or fallback route is planned.
8. Cancellation aborts the refresh promise and publishes no partial success after the cancellation point. Already committed generations remain valid.

## 5. Route reaction semantics

Every executor consumes the same capability facts. "Executor" means semantic preflight, route classifier, intent extractor, work provider calls, web-search helper, goal decomposition, goal execution, native-session planner, raw provider session launch when routed by myshell, and any future Item 10/13 worker.

Rules:

1. A turn captures `turnStartGenerationId` when the user input is accepted.
2. A route plan captures `plannedGenerationId` and selected provider/model/effort from that generation.
3. Immediately before opening a provider stream, the executor compares `plannedGenerationId` to `store.current().generation.generationId`.
4. If unchanged, it opens the stream.
5. If changed and the selected provider is still authenticated, not cooling, and still supports the selected model/effort, it may proceed but records both ids.
6. If changed and any selected fact is invalid, it reroutes once from the current generation before opening the stream.
7. If the stream is already open, generation changes do not interrupt it except for user cancellation or a provider-specific logout/auth invalidation that occurs before the first provider event.
8. Every final event, call receipt, and future `CompletionResultV1` reference records the generation id used for the first opened stream.
9. Route code must not call `detectEnvironment()`, `refreshCapabilities()`, or read provider caches directly when the flag is on.

This is the named `12->10` precondition: Item 10 may not claim safe retry until provider generation, Retry-After, and cooldown facts are stable and durable enough for its replay decision. A retry made from a stale generation is not safe retry.

This is the named `12->13` precondition: Item 13 goal scheduling may enqueue, park, or ask from stale context, but it may not launch goal work without a current provider generation snapshot and a generation-change policy.

## 6. Async startup and blocking policy

The product rule is simple: user input first, probes second.

Allowed to block before first menu/chat prompt:

- synchronous config parse needed to know whether the feature flag is on;
- synchronous construction of the genesis generation from already-provided `ctx.env`;
- terminal setup/readline/Ink initialization needed to accept input;
- explicit user-facing update/onboarding/login flows already chosen by the user;
- local store create/load only when the user explicitly enters a specific conversation and the chat prompt cannot exist without a conversation id.

Must be deferred or bounded behind stale-while-revalidate:

- provider `--version`, auth status, model list, and account probes;
- Codex cache read and OpenCode verbose capability read;
- spend ledger summaries, token capture metadata, conversation list, parked-goal list, and account summaries;
- recap, system understanding warmup, and any nonessential pre-answer model call;
- capability summary rendering when a prior generation can render "unknown/pending" honestly.

Concrete startup behavior:

- main menu paints from cached/genesis data and starts provider refresh in the background;
- entering chat shows the composer before capability refresh, recap, or system understanding;
- a no-provider gate may block a model-requiring turn from opening a provider call, but it must not block local slash commands or typing;
- first turn may use a partial generation only if it honestly marks pending/timed-out facts and routes only to known authenticated providers;
- if no authenticated provider is known yet but probes are pending, the UI may show a progressive receipt and ask the user whether to wait or sign in; it must not spawn a signed-out provider.

## 7. Folded Item 21 latency and feel budget

Latency is not polish; it is contract surface.

Targets, measured on the same host with warm Node process where possible:

| budget | target | hard gate for promotion |
|---|---:|---:|
| menu first prompt, live-region path, excluding explicit update/onboarding | p95 <= 150 ms | p95 <= 250 ms |
| chat composer visible after conversation selected, excluding store corruption recovery | p95 <= 120 ms | p95 <= 250 ms |
| genesis generation construction | p95 <= 5 ms | p95 <= 10 ms |
| first provider fact receipt after refresh starts | p95 <= 300 ms | p95 <= 750 ms |
| startup slow-probe foreground timeout per provider | target 750 ms | max 1,000 ms |
| background full probe completion | target 10,000 ms | no prompt blocking |
| route reaction after generation change | p95 <= 10 ms | p95 <= 25 ms |
| cancellation to no further provider opens | p95 <= 50 ms | p95 <= 100 ms |
| progressive receipt paint after generation commit | p95 <= 50 ms | p95 <= 100 ms |

Pre-answer model-call budget:

- Provider/capability probes are not model calls and never count against semantic/work budgets.
- A normal nontrivial foreground turn may have at most one blocking pre-answer model call before the answer/work stream opens, unless the user explicitly requested a goal/retry/eval mode with its own receipt.
- Recap, system-understanding warmup, provider refresh, and capability refresh must be concurrent or deferred when they would become a second blocking pre-answer call.
- If the budget is exhausted, the core answer/work path survives and optional intelligence is skipped with a receipt.

Measurement:

- Add monotonic marks for process/menu start, first frame begin/end, chat composer visible, generation genesis, refresh start, first fact commit, full probe settle, route planned, stream open, cancellation requested, and cancellation honored.
- A `ProviderLatencyReceiptV1` is emitted per session and a smaller per-turn receipt is attached to the existing turn receipt path.
- p95/p99 are computed from at least 50 fake-probe runs in unit tests and at least 20 local smoke runs for promotion artifacts. Do not use Vitest total runtime as latency evidence.
- Targets are acceptance targets, not claims about every host. Promotion requires artifact hashes, host info, fake-probe fixture stats, and a same-host before/after startup comparison.

Cancellation semantics:

- ESC/Ctrl-C aborts pre-answer model calls and pending route work before opening any new provider stream.
- Background probes may continue only if they cannot write into a dead conversation/menu frame; otherwise they must be aborted.
- A cancelled refresh cannot publish a success generation after the abort boundary.
- Late generation receipts are allowed only while the target surface is still live.

Progressive receipts:

- If provider refresh is still pending 250 ms after prompt, render a quiet "checking providers" state or equivalent structured receipt.
- When a provider becomes ready, unauthenticated, timed-out, or cooling, publish a generation update and repaint the relevant live region without stealing input.
- Receipts name facts, not guesses: "Codex pending", "OpenCode timed out", "Claude cooling until <time>", never "best provider ready" unless the generation proves it.

## 8. Shared rollout, fixture, and worktree rules

The single runtime flag is `MYSHELL_PROVIDER_REGISTRY_V1`; the config mirror is `experimentalProviderRegistryV1?: boolean`. Both are default false. Prior pure slices are unreachable except through explicit test injection.

When the flag is off:

- `detectEnvironment()`, `buildProviders(...)`, `buildAuthenticatedProviders(...)`, the current `caps` closure, menu refresh TTL, cooldown maps, and existing route deps remain event-for-event current.
- No latency receipt, provider generation field, or provider-generation event is emitted.

When the flag is on:

- every provider/capability consumer receives a generation or a derived view from the generation store;
- legacy direct detection/capability reads inside route/executor paths are forbidden;
- route, provider call, completion, and goal receipts include generation ids.

Rollback:

1. Unset `MYSHELL_PROVIDER_REGISTRY_V1` or set it to `0|false|off|no`.
2. Set `experimentalProviderRegistryV1:false` if config was used.
3. Restart the process.
4. Confirm startup/menu/provider receipts match the legacy snapshots and no generation field appears.

No migration deletes provider/capability data. Additive Item-11 events, when implemented, are ignored by flag-off readers.

Every worker slice must begin with:

```bash
git status --short
git diff --name-only
npm run typecheck
```

Record pre-existing paths and do not edit them. At document creation the worktree contained pre-existing `?? docs/r7-item11-durable-context-contract.md`. A slice is rejected if `git diff --name-only` contains a path outside its exhaustive maximum set.

## 9. Ordered slices

### P1-12a - `PROVIDER-GENERATION-DOMAIN`

**One invariant:** a provider generation is complete, immutable, versioned, and cannot fabricate unknown capability facts.

**Preconditions/dependencies:** existing `ProviderStatus`, `EnvironmentStatus`, `CapabilityRegistry`, `CapabilitySnapshot`, `ProviderId`, and sparse capability rules.

**Maximum file set:**

- `src/core/provider-generation.ts` (new)
- `test/unit/provider-generation.test.ts` (new)

**Behavioral diff:** add the shared types, id validation, genesis generation constructor, immutable freeze helper, provider-fact conversion from `EnvironmentStatus`, cooldown merge/remove helpers, and capability attachment. No runtime wiring.

**Named tests:** `genesis has four provider facts`, `generation ids and sequence are strict`, `unknown capability fields stay absent`, `cooldown fact cannot outlive expiry merge`, `deep freeze rejects consumer mutation`, `invalid ids and duplicate receipts fail closed`.

**Fixtures:** success = full env plus capability snapshot; failure = malformed ids/missing provider; cancellation = N/A pure; injected crash = proxies/throwing getters do not create valid generations.

**Verification receipt:**

```bash
npm run typecheck && npm run lint -- src/core/provider-generation.ts test/unit/provider-generation.test.ts && npx vitest run test/unit/provider-generation.test.ts
```

Expected before: no provider generation type. Expected after: pure domain exists and runtime behavior is unchanged.

### P1-12b - `GENERATION-STORE-SUBSCRIPTION`

**One invariant:** subscribers observe committed generations in order and cannot mutate or roll back the store.

**Preconditions/dependencies:** 12a.

**Maximum file set:**

- `src/core/provider-generation.ts`
- `test/unit/provider-generation-store.test.ts` (new)

**Behavioral diff:** add pure/injected `createProviderGenerationStoreV1(...)`, `current`, `publish`, `invalidate`, `subscribe`, unsubscribe, subscriber error isolation, stale publish rejection, and deterministic sequence.

**Named tests:** `current is synchronous during startup`, `subscriber sees previous and current ids`, `unsubscribe stops events`, `throwing subscriber is diagnostic only`, `stale publish cannot replace newer generation`, `invalidate publishes new generation`.

**Fixtures:** success = three ordered publishes; failure = stale sequence; cancellation = N/A pure; injected crash = subscriber throws.

**Verification receipt:** commands above with `test/unit/provider-generation-store.test.ts`; include before/after generation sequence table.

### P1-12c - `ASYNC-PROBE-SCHEDULER`

**One invariant:** provider probes are progressive, timeout-bounded for foreground feel, and never block prompt availability.

**Preconditions/dependencies:** 12b and current `detectProvider`/`detectEnvironment` behavior.

**Maximum file set:**

- `src/core/provider-generation.ts`
- `src/core/provider-probe-scheduler.ts` (new)
- `test/unit/provider-probe-scheduler.test.ts` (new)

**Behavioral diff:** add injected probe scheduler that starts per-provider probes concurrently, publishes progress generations, marks slow probes at `startupSlowProbeTimeoutMs`, allows background completion up to existing provider timeout, and respects `AbortSignal`.

**Named tests:** `first prompt does not await probes`, `slow probe publishes timed-out generation`, `late probe publishes newer generation`, `abort prevents later success publish`, `four providers probe concurrently`, `probe failure keeps prior known facts with receipt`.

**Fixtures:** success = staged provider completions; failure = rejected probe; cancellation = abort before second provider; injected crash = probe throws after timeout.

**Verification receipt:** include fake timer table: prompt-ready mark before any probe settles; p95 fake scheduler operation under 5 ms excluding injected latency.

### P1-12d - `CAPABILITY-GENERATION-MERGE`

**One invariant:** capability registry and self-awareness summary are derived from the same provider generation.

**Preconditions/dependencies:** 12c and existing `refreshCapabilities(...)`.

**Maximum file set:**

- `src/core/provider-generation.ts`
- `src/core/provider-capability-generation.ts` (new)
- `test/unit/provider-capability-generation.test.ts` (new)
- `test/unit/model-capability-refresh.test.ts`

**Behavioral diff:** add helper that calls `refreshCapabilities` from generation provider facts, merges the returned `CapabilitySnapshot` into a new generation, and preserves diagnostics. Existing refresh semantics stay fail-soft.

**Named tests:** `detect availableModels become generation capabilities`, `codex cache diagnostics are retained`, `opencode verbose timeout is a diagnostic not a block`, `capability summary and registry share generation id`, `unknown effort string remains dropped`.

**Fixtures:** success = Codex cache plus OpenCode verbose; failure = corrupt cache; cancellation = abort before port read; injected crash = port throws.

**Verification receipt:** targeted tests plus proof that missing cache keeps declarative facts and no prompt waits on capability refresh.

### P1-12e - `RUNTIME-ADAPTER-DERIVATION`

**One invariant:** provider adapter maps are derived from the same generation facts used for routing.

**Preconditions/dependencies:** 12d and `buildProviders(...)`/`buildAuthenticatedProviders(...)`.

**Maximum file set:**

- `src/providers/registry.ts`
- `src/core/provider-generation.ts`
- `test/unit/provider-registry.test.ts`
- `test/unit/provider-generation-runtime.test.ts` (new)

**Behavioral diff:** add `buildRuntimeGeneration(...)` or equivalent wrapper that derives installed adapters and authenticated routable adapters from a generation without re-detecting. Existing exports stay unchanged for flag-off rollback.

**Named tests:** `installed adapter map matches legacy buildProviders`, `authenticated runtime excludes signed-out provider`, `logout generation removes provider before probe completes`, `effort flag still reaches Claude and Grok adapters`, `adapter derivation does not mutate generation`.

**Fixtures:** success = installed signed-in env; failure = signed-out installed provider; cancellation = N/A pure; injected crash = adapter factory failure returns failed diagnostic under injected seam.

**Verification receipt:** include legacy parity table for installed/authenticated provider maps.

### P1-12f - `MENU-GENESIS-NONBLOCKING-STARTUP`

**One invariant:** first menu prompt and chat composer render from a genesis generation without awaiting provider or capability probes.

**Preconditions/dependencies:** 12e. No route/executor consumption yet.

**Maximum file set:**

- `src/interface/menu.ts`
- `src/interface/ui/provider-registry-flag.ts` (new)
- `src/infra/config.ts`
- `test/unit/provider-registry-flag.test.ts` (new)
- `test/unit/menu-flow.test.ts`

**Behavioral diff:** add default-off flag parser/config mirror and construct a generation store from `ctx.env` when explicitly enabled. On the live-region menu path, start refresh after first paint. On chat entry, show composer before capability refresh. Flag off is byte-identical.

**Named tests:** `flag defaults false for absent false zero and garbage`, `explicit env or config true enables generation store`, `flag off menu snapshots match legacy`, `flag on first paint occurs before fake detect resolves`, `chat composer visible before capability refresh`, `late refresh does not paint over subflow`.

**Fixtures:** success = fake live-region sink; failure = refresh rejects; cancellation = leave menu before refresh resolves; injected crash = flag parser throws and falls back off.

**Verification receipt:** include first-paint timing marks and changed-file list.

### P1-12g - `ORCHESTRATE-GENERATION-CONSUMPTION`

**One invariant:** route, preflight, work, web-search, and native-session helpers consume one generation view for a turn.

**Preconditions/dependencies:** 12f and existing preflight deps.

**Maximum file set:**

- `src/core/types.ts`
- `src/core/orchestrate.ts`
- `src/interface/preflight-deps.ts`
- `src/interface/menu.ts`
- `test/unit/orchestrate-provider-generation.test.ts` (new)
- `test/unit/preflight-deps.test.ts`
- `test/unit/menu-flow.test.ts`

**Behavioral diff:** add optional `providerGeneration`/`providerGenerationStore` deps. Under flag injection, build available models, authenticated providers, capability registry, plan info, cooldowns, and web-search provider choice from the generation. Do not call direct detection or capability refresh in route/executor code.

**Named tests:** `one turn records turnStart generation id`, `preflight and work see same capability registry`, `web search helper uses generation-authenticated provider`, `native session omits provider invalidated by generation`, `generation change before stream reroutes once`, `stream-open generation change does not duplicate call`.

**Fixtures:** success = stable generation; failure = generation changes selected provider to signed out; cancellation = abort before stream open; injected crash = generation store current throws and turn fails closed before provider call.

**Verification receipt:** include provider-call count and generation-id matrix.

### P1-12h - `LOGIN-LOGOUT-COOLDOWN-INVALIDATION`

**One invariant:** auth/account/cooldown mutations publish a new generation before any dependent route or retry.

**Preconditions/dependencies:** 12g.

**Maximum file set:**

- `src/interface/menu.ts`
- `src/core/provider-generation.ts`
- `test/unit/menu-provider-generation-invalidation.test.ts` (new)
- `test/unit/menu-flow.test.ts`

**Behavioral diff:** wire inline login, root account menus, logout/account-change flows, Retry-After/rate-limit observations, correlated-429 account fanout disablement, and cooldown expiry to generation invalidation. Existing in-memory maps remain for flag-off rollback.

**Named tests:** `inline relogin publishes login generation before retry deps`, `logout makes provider unroutable immediately`, `rate-limit publishes cooldown before fallback route`, `Retry-After duration is preserved`, `cooldown expiry removes fact through new generation`, `account change invalidates only affected provider facts`.

**Fixtures:** success = login then retry; failure = login fails; cancellation = user declines login; injected crash = refresh after login throws and prior generation remains honest.

**Verification receipt:** include edge `12->10` evidence table: Retry-After and cooldown facts visible before retry.

### P1-12i - `LATENCY-RECEIPTS-AND-PROGRESSIVE-FEEL`

**One invariant:** responsiveness budgets are measured, receipted, and visible without stealing input.

**Preconditions/dependencies:** 12h.

**Maximum file set:**

- `src/core/provider-generation.ts`
- `src/core/provider-latency-receipt.ts` (new)
- `src/interface/menu.ts`
- `test/unit/provider-latency-receipt.test.ts` (new)
- `test/unit/menu-flow.test.ts`

**Behavioral diff:** add monotonic latency marks, session and per-turn provider latency receipts, progressive provider-checking receipts, repaint coalescing after generation commits, and cancellation-to-no-new-provider-open assertions.

**Named tests:** `menu first prompt mark precedes refresh settle`, `chat prompt mark precedes recap and capability settle`, `progress receipt appears after 250ms pending`, `generation commit repaint keeps typed input`, `cancelled turn opens no later provider stream`, `p95 fake startup budget is computed from samples not test runtime`.

**Fixtures:** success = fake timers and staged refresh; failure = p95 threshold miss fixture; cancellation = ESC during pending refresh; injected crash = receipt sink throws.

**Verification receipt:** include p95 table for fake-probe runs and a note that values are local targets, not universal host claims.

### P1-12j - `ITEM10-RETRY-SEAM`

**One invariant:** Item 10 can decide safe retry from generation, cooldown, and Retry-After facts without re-probing providers.

**Preconditions/dependencies:** 12i. Item 10 implementation is not required.

**Maximum file set:**

- `src/core/provider-generation.ts`
- `src/core/types.ts`
- `test/unit/provider-generation-retry-seam.test.ts` (new)

**Behavioral diff:** add typed retry-facing selector helpers: current routable providers, cooling providers, retry-after facts, and generation freshness predicate. No exactly-once state machine.

**Named tests:** `safe retry rejects stale generation`, `Retry-After provider is cooling until exact ms`, `all providers cooling returns wait decision not blind retry`, `generation id can be attached to future work-unit state`, `provider-native session cannot override cooldown fact`.

**Fixtures:** success = provider A cooling, provider B ready; failure = stale generation; cancellation = N/A pure; injected crash = malformed cooldown fact rejected.

**Verification receipt:** include explicit `12->10` matrix.

### P1-12k - `ITEM13-GOAL-SCHEDULING-SEAM`

**One invariant:** goal scheduling sees the current generation and reacts to generation changes before launch.

**Preconditions/dependencies:** 12i. Item 13 implementation is not required.

**Maximum file set:**

- `src/core/provider-generation.ts`
- `src/core/types.ts`
- `test/unit/provider-generation-goal-seam.test.ts` (new)

**Behavioral diff:** add goal-facing snapshot view with generation id, routable providers by tier, capability registry, and change policy: enqueue/park may use stale facts; launch requires current facts.

**Named tests:** `goal launch requires current generation`, `goal park records stale generation honestly`, `capability loss blocks launch with needs-provider`, `new ready provider wakes schedulable goal`, `cooldown generation defers goal without marking failed`.

**Fixtures:** success = generation advances from no provider to ready provider; failure = stale launch; cancellation = N/A pure; injected crash = invalid capability view fails closed.

**Verification receipt:** include explicit `12->13` matrix.

### P1-12l - `DARK-PRODUCTION-COMPOSITION`

**One invariant:** one explicit default-off flag composes generation store, async startup, route consumption, invalidation, and latency receipts across interactive, one-shot, and REPL entry points.

**Preconditions/dependencies:** 12a-12k.

**Maximum file set:**

- `src/infra/config.ts`
- `src/interface/ui/provider-registry-flag.ts`
- `src/interface/menu.ts`
- `src/interface/run.ts`
- `src/interface/repl.ts`
- `src/cli.ts`
- `test/unit/provider-registry-flag.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/run.test.ts`
- `test/unit/repl.test.ts`
- `test/unit/orchestrate-provider-generation.test.ts`

**Behavioral diff:** compose the feature for every entry point under `MYSHELL_PROVIDER_REGISTRY_V1` / `experimentalProviderRegistryV1`. Off path uses legacy env/caps closures. On path passes one generation store through the stack.

**Named tests:** `flag off interactive one-shot and REPL snapshots match legacy`, `flag on entry points create genesis generation`, `flag on nontrivial turn records generation id`, `old capability memo is not consumed inside V1 route`, `unset flag rollback restores legacy startup receipts`, `probe refresh crash is fail-soft`.

**Fixtures:** success = each entry point; failure = store constructor unavailable; cancellation = process exits during refresh; injected crash = subscription callback throws.

**Verification receipt:** full targeted command set plus `npm run test` if entry-point snapshots change.

### P1-12m - `EVAL-GATE-AND-AUTHORITY-GUARD`

**One invariant:** enabled code cannot bypass the generation authority, and default remains off.

**Preconditions/dependencies:** 12l.

**Maximum file set:**

- `test/arch/provider-generation-authority-guard.test.ts` (new)
- `test/unit/provider-latency-receipt.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/orchestrate-provider-generation.test.ts`
- `docs/r7-item12-provider-registry-contract.md`

**Behavioral diff:** add architecture guard forbidding direct `detectEnvironment`, `refreshCapabilities`, or provider-cache reads in flag-on route/executor paths except the generation scheduler. Add eval runner/fixture docs for latency and generation consistency. Record dark acceptance receipt in this document after artifacts pass. Default remains off.

**Named tests:** `flag on route reads provider generation`, `flag on goal seam reads provider generation`, `flag on retry seam reads cooldown generation`, `direct capability refresh in executor is rejected`, `fake startup p95 meets gate`, `flag off snapshots remain unchanged`.

**Fixtures:** success = guard corpus; failure = synthetic direct refresh import; cancellation = aborted eval; injected crash = truncated eval artifact rejected.

**Verification receipt:** artifact path/hash, fixture counts, p95/p99 tables, authority guard output, rollback proof, and no-default-change proof.

### P1-12n - `PROMOTION-CANDIDATE-ONLY`

**One invariant:** default-on is considered only after dark eval, authority guards, and human gate are green on the exact merge candidate.

**Preconditions/dependencies:** 12m plus Item 10/13 consumers respecting the seams where implemented. Missing Item 10 or Item 13 implementation blocks default-on for their launch paths but not dark completion.

**Cancel conditions:** missing eval artifact, p95/hard-gate miss, direct authority bypass, stale artifact head, generation mismatch in any executor, flag-off drift, rollback proof missing, or human gate absent.

**Maximum file set:**

- `src/interface/ui/provider-registry-flag.ts`
- `src/infra/config.ts`
- `test/unit/provider-registry-flag.test.ts`
- `docs/r7-item12-provider-registry-contract.md`

**Exact behavioral diff:** if and only if a human-approved promotion gate exists, absent env/config may select V1 while explicit false remains rollback for one release. This slice may cancel with no edits; cancellation is correct when the eval is not green.

**Named tests:** `absent flag defaults V1 only after recorded promotion gate`, `explicit false restores legacy provider path`, `default startup keeps first prompt budget`, `promotion receipt artifact head matches tree`.

**Verification receipt:** include human gate reference, eval artifact hashes, exact rollback command, before/after default table, and north-star drift check.

## 10. Cross-slice acceptance and definition of done

After every completed implementation slice, run its receipt plus:

```bash
git diff --check
git diff --name-only
npm run typecheck
npx vitest run test/unit/provider-generation.test.ts test/unit/provider-generation-store.test.ts
```

The changed-file list must be a subset of that slice's maximum set. A test pass with no flag-off snapshot, no cancellation fixture, no slow-probe timeout fixture, or no generation-id receipt is not acceptance.

Item 12 is implemented dark when 12m is green. It is promoted only if 12n's prerequisites and human gate are satisfied. The implementation satisfies Item 12 only if all of the following are simultaneously true:

- startup prompt and chat composer do not wait for provider/capability probes;
- one immutable generation exists synchronously at startup;
- every enabled executor consumes the same generation facts and records the generation id it used;
- login/logout/account/cooldown/Retry-After/slow-probe events publish new generations rather than mutating closure state;
- route reaction reroutes before stream open when selected facts become invalid;
- capability unknowns remain absent and never become guessed false/true facts;
- latency receipts measure p95/p99 from marks, not anecdotes or test runtime;
- flag-off rollback restores legacy provider/capability behavior without deleting additive generation receipts;
- named `12->10` and `12->13` seams are tested before those items rely on provider facts.

## 11. Adversarial self-challenge and fixes

**Challenge 1: could this just wrap the old mutable env in a new object?** Yes, if `mutableCtx.env` remains the authority and generation ids are decorative. Fix: 12g and 12m require route/executor authority guards; direct detection/capability reads are forbidden under the flag.

**Challenge 2: could async startup route on stale or unknown facts and call a signed-out provider?** Yes, if pending facts are treated as ready. Fix: genesis may be partial, but routable providers require known authenticated facts; pending/timed-out providers are not routable unless a prior generation proves auth and the stale receipt is explicit.

**Challenge 3: could late probes corrupt the UI after the user left?** Yes, current code already guards recap with live state but provider refresh needs the same discipline. Fix: subscription callbacks and repaint code must check live menu/conversation state; cancelled refreshes cannot publish success after abort.

**Challenge 4: could latency receipts become vanity metrics?** Yes, if they use Vitest runtime or one manual launch. Fix: required monotonic marks, fake-probe p95/p99 fixtures, local smoke artifacts, host info, and hard gates before promotion.

**Challenge 5: could cooldown facts be too ephemeral for Item 10?** Yes, if they remain only in a map that disappears before retry/resume. Fix: generation facts expose Retry-After/cooldown before retry, and Item 10 is explicitly blocked from claiming safe retry without that seam.

**Challenge 6: could goals become busier but not smarter?** Yes, if Item 13 schedules from stale capacity facts. Fix: goal launch requires current generation; stale facts can park or ask, not launch.

## 12. North-star drift check

Does this make the one chat feel instant and elite, or add ceremony?

It moves toward the north-star only if the registry becomes invisible infrastructure: the prompt appears immediately, provider readiness updates quietly, routing never lies about signed-in models, retries respect real cooldowns, and goals launch only when current capability facts support them.

It adds ceremony if the app writes generation receipts while still blocking startup on probes, if users see noisy provider status instead of a calm prompt, or if route/executor code keeps private provider facts. The guardrail is concrete: instant prompt, one immutable generation, progressive receipts, generation-id route evidence, latency p95 artifacts, dark flag, and rollback.
