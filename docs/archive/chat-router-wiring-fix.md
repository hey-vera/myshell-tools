# Chat Router Wiring Fix Plan

## Diagnosis

### 1. Wiring Gap

Live chat does not use the vendor-neutral router because the default-on resolver is never threaded into the normal `menu.ts -> orchestrate.ts -> runWorkCall()` path.

The resolver itself is default-on: `vendorNeutralRouterEnabled()` returns `true` unless `MYSHELL_VENDOR_NEUTRAL_ROUTER` is an explicit off value or `config.experimentalVendorNeutralRouter === false` (`src/core/route-types.ts:91-106`). But the only live work-call switch is `WorkCallInput.vendorNeutralEnabled?: boolean` (`src/core/work-call.ts:586`), and `runWorkCall()` only takes the vendor-neutral branch when that input is `true` and `deps.capabilityRegistry` exists (`src/core/work-call.ts:1200-1215`).

`orchestrate.ts` delegates to `runWorkCall()` at `src/core/orchestrate.ts:2067-2127` without passing `vendorNeutralEnabled`. `menu.ts` builds `availableModels`, `authenticatedProviders`, and `capabilityRegistry` (`src/interface/menu.ts:2161-2172`, `src/interface/menu.ts:2376`), but there is no `vendorNeutralRouterEnabled` import or `vendorNeutralEnabled` field in the chat deps object. So the runtime default is not "false by config"; it is "undefined because the composition root never passes the default-on flag through."

### 2. Pick Check

If the current vendor-neutral router were wired for a worker turn with Claude Max plus OpenCode Go authenticated, it would not necessarily avoid the dead worker model on the first attempt.

With the advertised Claude model list from detection (`['opus', 'sonnet', 'haiku']`, `src/providers/detect.ts:592`) and OpenCode model `opencode-go/deepseek-v4-flash`, the vendor-neutral scores are:

- `claude/haiku` aliasing `claude-haiku-4-5`: worker suitability `85`, admitted worker-only (`src/core/model-capabilities.ts:246-264`).
- `opencode/opencode-go/deepseek-v4-flash`: fast morphology gives worker score `60` with no verbose facts: `40 + fastBonus(20)` in `opencodeTierRank()` (`src/core/route-types.ts:217-276`).

Therefore the first vendor-neutral worker decision is still `provider: "claude", model: "haiku"` or its detected/priced alias `claude-haiku-4-5`, not OpenCode. It avoids the dead model only after failover excludes the already-tried Claude provider; then routing over the remaining authenticated provider pool selects `provider: "opencode", model: "opencode-go/deepseek-v4-flash"` because it is worker-admitted and adapter-passable.

### 3. Dead-Model Failover

`work-call.ts` already intends cross-provider failover for recoverable provider/model failures. Empty output is converted into a recoverable model error at `src/core/work-call.ts:1413-1424`, and the failure branch computes remaining untried authenticated providers at `src/core/work-call.ts:1761-1775`.

The blocker is call-budget ordering. The loop condition requires `callBudgetAvailable()` even when `failoverPool !== null` (`src/core/work-call.ts:1178-1179`), and after the first provider invocation the code breaks before entering the failure/failover branch when `turnCallBudget` is exhausted (`src/core/work-call.ts:1673-1676`). The governor sets `turnCallBudget = 1` for quick turns (`src/core/governor.ts:681-687`), so a dead first worker model produces the observed terminal `attempts: 1` instead of trying the next authenticated provider.

The fix is not provider-specific: make queued provider failover independent of the governor's ordinary per-turn call budget, matching the existing comment that failover is "one run per authenticated provider at this tier" and independent of the ordinary attempt ceiling (`src/core/work-call.ts:1775-1779`).

## Recommended Change Set

Smallest vendor-agnostic change set:

1. Wire the default-on vendor-neutral router flag from the composition root into work calls.
2. Let recoverable empty/model/provider failures queue and execute cross-provider failover even when the ordinary `turnCallBudget` is spent.

Blast radius: routing selection and retry control only. No provider is hardcoded, no worker preference is encoded, and timeouts remain terminal.

### A. Router Wiring

Add config support and pass the resolved boolean through the existing work-call switch.

Before, `AppConfig` has no vendor-neutral opt-out field (`src/infra/config.ts:34`):

```ts
export interface AppConfig {
  onboarded: boolean;
  setAsDefault: boolean;
```

After:

```ts
export interface AppConfig {
  onboarded: boolean;
  setAsDefault: boolean;
  experimentalVendorNeutralRouter?: boolean;
```

Before, `OrchestrateDeps` has no router flag (`src/core/types.ts:347`):

```ts
export interface OrchestrateDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
```

After:

```ts
export interface OrchestrateDeps {
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly vendorNeutralEnabled?: boolean;
```

Before, `orchestrate.ts` calls `runWorkCall()` without the flag (`src/core/orchestrate.ts:2067-2127`):

```ts
yield* runWorkCall({
  task,
  deps: depsWithIntent,
  signal,
  ...
  startTier: currentTier,
```

After:

```ts
yield* runWorkCall({
  task,
  deps: depsWithIntent,
  signal,
  ...
  startTier: currentTier,
  ...(deps.vendorNeutralEnabled === true ? { vendorNeutralEnabled: true } : {}),
```

Before, `menu.ts` passes registry/model/auth data but no vendor-neutral boolean (`src/interface/menu.ts:2369-2376`):

```ts
...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
...(caps.registry !== undefined ? { capabilityRegistry: caps.registry } : {}),
```

After:

```ts
...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
...(caps.registry !== undefined ? { capabilityRegistry: caps.registry } : {}),
...(vendorNeutralRouterEnabled(process.env, mutableCtx.config)
  ? { vendorNeutralEnabled: true }
  : {}),
```

Also import `vendorNeutralRouterEnabled` in `menu.ts`.

### B. Cross-Provider Failover Despite Quick-Turn Budget

Before, queued failover is still blocked by `callBudgetAvailable()` (`src/core/work-call.ts:1178-1179`), and the first exhausted call breaks before failover is computed (`src/core/work-call.ts:1673-1676`):

```ts
mainLoop: while (
  (attempts < deps.policy.maxAttempts || failoverPool !== null) &&
  callBudgetAvailable()
) {
  ...
  if (!callBudgetAvailable()) break mainLoop;

  if (!success) {
    ...
```

After:

```ts
mainLoop: while (
  failoverPool !== null ||
  (attempts < deps.policy.maxAttempts && callBudgetAvailable())
) {
  ...
  if (!success) {
    ...
    // Existing remaining-provider failover block stays before this budget stop.
    if (remaining.length > 0) {
      ...
      failoverPool = remaining;
      continue mainLoop;
    }

    if (!callBudgetAvailable()) break mainLoop;
    ...
  }

  if (!callBudgetAvailable()) break mainLoop;
```

This preserves the budget for normal escalation/review/repair while allowing the already-designed provider failover path to recover from dead worker models. Timeout remains terminal because the timeout branch returns before failover.

## Verification Plan

Unit assertions:

1. Router wiring: with `MYSHELL_VENDOR_NEUTRAL_ROUTER` unset and `capabilityRegistry` present, a chat work call enters the vendor-neutral branch by default. With `MYSHELL_VENDOR_NEUTRAL_ROUTER=0`, it stays on legacy `route()`.
2. Pick check: vendor-neutral worker route with `claude: ['opus', 'sonnet', 'haiku']` and `opencode: ['opencode-go/deepseek-v4-flash']` first selects `claude/haiku`; after excluding/tried Claude and routing over `['opencode']`, it selects `opencode/opencode-go/deepseek-v4-flash`.
3. Failover regression: `turnCallBudget: 1`, first provider returns `done.text = ''`, second authenticated provider returns `OK`; final is success with `attempts: 2` and a `failover` event.

Suggested focused command:

```bash
node --import tsx/esm --test test/unit/vendor-neutral-wiring.test.ts test/unit/vendor-neutral-route.test.ts test/unit/work-call-failover.test.ts
```

Real smoke after build/install:

```bash
MYSHELL_VENDOR_NEUTRAL_ROUTER=1 myshell-tools run "Reply with exactly: OK"
```

Confirm the turn no longer ends as `Failed - tier: worker, 0 tokens, attempts: 1`. If the first worker model is still dead, the expected behavior is a visible failover and a successful OpenCode-backed response, with the ledger showing a failed Claude worker attempt followed by an OpenCode worker attempt using `opencode-go/deepseek-v4-flash`.
