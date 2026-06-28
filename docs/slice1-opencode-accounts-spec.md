# Slice 1: OpenCode Accounts + Account-Aware Routing

Status: implementation spec only. Do not edit source or tests as part of this
doc task.

Slice 1 is the first shippable, flag-gated vertical slice for the multi-
subscription system: OpenCode multi-account management plus account-aware
routing/execution/cooldown. It intentionally combines the store, minimal menu,
routing decision, provider env injection, ledger attribution, and per-account
cooldown so account identity is true at execution time.

This spec follows `docs/subscription-management-design.md` and the red-team
reordering in `docs/subscription-management-redteam.md`, with one explicit
verified override: Slice 1 writes OpenCode's scoped `auth.json` directly because
there is no non-interactive `opencode auth login --key` path, and the schema has
been verified as exactly:

```json
{ "<providerId>": { "type": "api", "key": "<sk>" } }
```

Provider id is `"opencode"` for Zen and `"opencode-go"` for Go.

## Scope

Include only:

- Flag gate, default off: `config.experimentalSubscriptions === true` or
  `MYSHELL_SUBSCRIPTIONS` truthy.
- OpenCode account store at `<stateHome>/.myshell-tools/subscriptions.json`.
- OpenCode account create/edit/delete menu.
- Direct writer for `<account.homeDir>/opencode/auth.json`.
- Account-aware routing for OpenCode model ids only.
- OpenCode child env injection via `XDG_DATA_HOME`.
- Ledger `accountId` attribution.
- Per-account OpenCode cooldown.

Defer:

- Parallel or hedge across accounts.
- Auto/Smart balancing beyond normalized-load selection.
- Custom priority numbers in the UI.
- Claude/Codex/Grok/OAuth account management.
- Expiry enforcement beyond excluding expired accounts from routing.
- macOS-specific provider handling.
- Global-key migration or auto-import.

## Existing Anchors

- State home resolution is `src/infra/state-dir.ts:41-47` and
  `src/infra/state-dir.ts:55-60`. The design stores account state under
  `<stateHome>/.myshell-tools/subscriptions.json`
  (`docs/subscription-management-design.md:250-254`).
- Config follows optional experimental keys in `src/infra/config.ts:34-75`,
  defaults in `src/infra/config.ts:582-586`, load merge in
  `src/infra/config.ts:608-631`, and atomic save in
  `src/infra/config.ts:654-657`.
- Atomic writes use same-directory temp + rename at `src/infra/atomic.ts:191-203`.
- OpenCode auth path already honors `XDG_DATA_HOME` at
  `src/providers/detect.ts:793-805`.
- OpenCode model ids include provider prefixes such as `opencode/...` and
  `opencode-go/...` per `src/providers/detect.ts:808-823`.
- OpenCode adapter builds `run --format json [-m provider/model]` at
  `src/providers/opencode.ts:90-110`.
- OpenCode adapter currently builds child env from `process.env` and
  `replitPersistentEnv(...)` at `src/providers/opencode.ts:174-179`, then passes
  `env: childEnv` into `spawnGuarded` at `src/providers/opencode.ts:184-190`.
- `spawnGuarded` passes caller options through to execa at
  `src/providers/hang-cap.ts:92-103`.
- Provider request type lives at `src/providers/port.ts:35-80`.
- Menu Auth rows are rendered at `src/interface/menu-render.ts:154-169`.
- Main menu key loop reads one key at `src/interface/menu.ts:6802-6808`.
- Existing `[o]` OpenCode login handler is at `src/interface/menu.ts:6945-6985`.
- Settings-style single-key screens use `readMenuKey()` at
  `src/interface/menu-settings.ts:101-115`; `readMenuKey()` itself is
  `src/interface/menu-key-confirm.ts:190-204`.
- Readline echo can already be muted through `ReadlineOutputProxy` at
  `src/interface/menu.ts:454-481` and the `ReadlineEchoController` seam at
  `src/interface/menu-readline.ts:81-96`.
- Provider-level cooldown is currently `Map<ProviderId, number>` in
  `src/interface/menu.ts:1044-1049`, filtered at
  `src/interface/menu.ts:2185-2192`, and updated at
  `src/interface/menu.ts:1603-1630`.
- `cooldownExpiry()` and non-stranding provider filtering are in
  `src/core/cooldown.ts:25-32` and `src/core/cooldown.ts:49-59`.
- Per-session provider token load is accumulated in
  `src/interface/menu.ts:1328-1338` and seeded from the ledger at
  `src/interface/menu.ts:1351-1356`.
- Live provider order currently normalizes provider load at
  `src/interface/menu.ts:2273-2295`.
- `OrchestrateDeps` currently carries provider cooldown and session load fields at
  `src/core/types.ts:347-386`, plus `availableModels` and
  `authenticatedProviders` at `src/core/types.ts:414-462`.
- Main provider execution request/ledger paths are at
  `src/core/work-call.ts:992-1008` and `src/core/work-call.ts:1033-1050`, and at
  `src/core/work-call.ts:1359-1383` and `src/core/work-call.ts:1470-1494`.
- Internal reviewer request/ledger path is `src/core/work-call.ts:2064-2093` and
  `src/core/work-call.ts:2130-2145`; do not account-route reviewer runs in Slice 1
  unless the implementation routes them through the same helper without adding
  panel/hedge behavior.
- Ledger entry type is `src/core/types.ts:181-219`; ledger writes are append-only
  through `src/infra/ledger.ts:20-27`.
- Renderer captures provider-level 429s at `src/interface/render.ts:727-731` and
  returns them at `src/interface/render.ts:1107-1111`; runTask exposes that shape
  at `src/interface/run.ts:23-47` and `src/interface/run.ts:91-97`.

## Flag Wiring

Add to `src/infra/config.ts`:

```ts
export interface AppConfig {
  // ...
  /**
   * EXPERIMENTAL OpenCode account subscriptions (default off).
   * When true, and/or MYSHELL_SUBSCRIPTIONS is truthy, myshell may read
   * subscriptions.json, show the OpenCode Accounts menu, and route OpenCode
   * model calls through account-scoped XDG_DATA_HOME.
   */
  experimentalSubscriptions?: boolean;
}
```

Do not add it to `DEFAULTS`; absence means false.

Add `src/interface/ui/subscriptions-flag.ts`:

```ts
import type { AppConfig } from '../../infra/config.js';

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);

export function subscriptionsEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: Pick<AppConfig, 'experimentalSubscriptions'> | undefined,
): boolean {
  if (config?.experimentalSubscriptions === true) return true;
  const raw = env?.['MYSHELL_SUBSCRIPTIONS'];
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}
```

Read the flag in `startMenu()` once per menu action/turn from
`process.env` and `mutableCtx.config`, next to the existing feature flag reads
around `src/interface/menu.ts:1340-1348` and `src/interface/menu.ts:2296-2302`.

Flag-off contract:

- Do not read `subscriptions.json`.
- Do not render account-management labels.
- Do not pass new account fields into `OrchestrateDeps`.
- Do not set `ProviderRequest.accountId` or `ProviderRequest.accountEnv`.
- Do not add ledger `accountId`.
- Leave the existing `[o]` login flow at `src/interface/menu.ts:6945-6985`
  unchanged.

## Account Types

Create `src/infra/subscriptions.ts` with these exported types:

```ts
export type SubscriptionAccountId = string;
export type SubscriptionProvider = 'opencode';
export type OpencodePool = 'zen' | 'go';
export type AccountPriority = 'low' | 'medium' | 'high' | 'disabled';

export interface OpencodeSubscriptionAccount {
  readonly id: SubscriptionAccountId;
  readonly provider: 'opencode';
  readonly label: string;
  readonly pool: OpencodePool;
  /**
   * Absolute XDG_DATA_HOME for this account. The secret lives at:
   *   <homeDir>/opencode/auth.json
   */
  readonly homeDir: string;
  readonly priority: AccountPriority;
  readonly priorityWeight: number;
  readonly expiresAt?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface SubscriptionsFileV1 {
  readonly version: 1;
  readonly accounts: readonly OpencodeSubscriptionAccount[];
}

export type SubscriptionAccount = OpencodeSubscriptionAccount;
```

Priority mapping is fixed:

```ts
export function priorityWeight(priority: AccountPriority): number {
  if (priority === 'low') return 25;
  if (priority === 'medium') return 100;
  if (priority === 'high') return 200;
  return 0;
}
```

Invariants:

- `id` is stable and never changes after creation.
- `provider` is always `'opencode'` in Slice 1.
- `homeDir` must be absolute.
- `priorityWeight` is derived, never independently edited.
- `priority === 'disabled'` implies `priorityWeight === 0`; the edit flow should
  also set `enabled: false` when choosing disabled.
- Secret key is never stored in `subscriptions.json`.

## Store API

`src/infra/subscriptions.ts` owns all store paths and validation.

Path layout:

```ts
// stateHome defaults to defaultStateHome(), matching config/state behavior.
// Cite: src/infra/state-dir.ts:55-60 and src/infra/config.ts:592-597.
<stateHome>/.myshell-tools/subscriptions.json
<stateHome>/.myshell-tools/opencode-accounts/<accountId>/opencode/auth.json
```

`homeDir` stored in the account record is:

```ts
join(stateHome, '.myshell-tools', 'opencode-accounts', accountId)
```

The auth file path is:

```ts
join(account.homeDir, 'opencode', 'auth.json')
```

API:

```ts
export function getSubscriptionsDir(stateHome?: string): string;
export function getSubscriptionsPath(stateHome?: string): string;
export function getOpencodeAccountHome(accountId: string, stateHome?: string): string;
export function getOpencodeAccountAuthPath(account: OpencodeSubscriptionAccount): string;

export async function readSubscriptions(stateHome?: string): Promise<SubscriptionsFileV1>;
export async function writeSubscriptions(file: SubscriptionsFileV1, stateHome?: string): Promise<void>;
export async function updateSubscriptions(
  updater: (file: SubscriptionsFileV1) => SubscriptionsFileV1,
  stateHome?: string,
): Promise<SubscriptionsFileV1>;

export function newOpencodeAccount(input: {
  id: string;
  label: string;
  pool: OpencodePool;
  priority?: AccountPriority;
  expiresAt?: string;
  nowIso: string;
  stateHome?: string;
}): OpencodeSubscriptionAccount;

export async function writeOpencodeAuthJson(input: {
  account: OpencodeSubscriptionAccount;
  apiKey: string;
}): Promise<void>;

export async function deleteOpencodeAccountHome(account: OpencodeSubscriptionAccount): Promise<void>;
```

Behavior:

- `readSubscriptions()` returns `{ version: 1, accounts: [] }` for missing files
  or corrupt/unrecognized JSON. Do not throw from the chat path.
- `writeSubscriptions()` creates the parent directory and writes JSON with
  `atomicWrite(path, JSON.stringify(file, null, 2), 0o600)` using
  `src/infra/atomic.ts:191-203`.
- `writeOpencodeAuthJson()` creates `<homeDir>/opencode`, then writes mode
  `0o600` exactly:

```ts
const providerId = account.pool === 'go' ? 'opencode-go' : 'opencode';
const body = {
  [providerId]: {
    type: 'api',
    key: apiKey,
  },
};
```

No extra fields, no alternate provider ids, no secret logging.

`deleteOpencodeAccountHome()` removes only the scoped directory under
`<stateHome>/.myshell-tools/opencode-accounts/<accountId>`. Resolve the absolute
path first and assert it starts with the resolved `opencode-accounts` root before
recursive deletion.

## Menu Screens

When the subscriptions flag is off, keep `src/interface/menu-render.ts:154-169`
and `src/interface/menu.ts:6945-6985` unchanged.

When on, change only the OpenCode row label:

- If flag on: `[o] OpenCode Accounts`
- Claude/Codex/Grok rows stay as existing login rows in Slice 1.

Hook:

- Render label at `src/interface/menu-render.ts:158-168`.
- Dispatch key at `src/interface/menu.ts:6945-6985`: if flag on, call
  `runOpencodeAccountsMenu(...)`; else run the current login/install branch.

Add `src/interface/menu-opencode-accounts.ts`.

Main screen:

```text
OpenCode Accounts

  #  label                 pool  priority  expiry       status
  1  Zen personal          zen   high      2026-07-31   active
  2  Go work               go    medium    -            active

  [c] create
  [e] edit
  [b] back
```

Use `readMenuKey()` style, matching `src/interface/menu-settings.ts:101-115`.

Create flow:

1. `[c] create`.
2. Prompt for key with hidden input: `Paste OpenCode API key: `.
3. Choose pool:
   - `[z] Zen`
   - `[g] Go`
   - `[b] back`
4. Optional expiry date line input. Accept blank; accept `YYYY-MM-DD` and store
   as `YYYY-MM-DDT00:00:00.000Z`; reject invalid date with one retry then back.
5. Optional label line input. Blank defaults to `OpenCode Zen N` or `OpenCode Go N`.
6. Create account id with `ctx.clock.uuid()` or a stable prefixed id:
   `acct_<uuid-without-unsafe-chars>`.
7. Build account record using `newOpencodeAccount(...)`.
8. Write auth JSON first, then append account record. If the account record write
   fails after auth write, delete the newly created account home best-effort and
   report failure without printing the key.

Hidden input:

- There is no public existing secret prompt.
- Add minimal helper in `src/interface/menu-secret-input.ts`:

```ts
export async function readSecretLine(input: {
  out: OutputSink;
  readLine: () => Promise<string | null>;
  setEchoMuted?: (muted: boolean) => void;
  prompt: string;
}): Promise<string | null>;
```

- The helper writes the prompt, flushes, mutes readline echo, awaits `readLine()`,
  unmutes in `finally`, writes a newline, trims the result, and returns `null` on
  EOF.
- Wire `setEchoMuted` from the existing `ReadlineEchoController` created at
  `src/interface/menu.ts:6389-6420`. This is already the controller that suppresses
  readline output in `ReadlineOutputProxy` at `src/interface/menu.ts:472-481`.
- For injected test readers, `setEchoMuted` may be absent; tests assert the key is
  not written to the output sink.
- Do not support masked `******` output in Slice 1; hidden means no echo.

Edit flow:

1. `[e] edit`.
2. If more than one account, prompt for number with line input. If exactly one,
   select it.
3. Edit screen:

```text
Edit OpenCode Account: Zen personal

  pool: zen
  priority: high
  expiry: 2026-07-31
  enabled: yes

  [p] priority
  [x] set/clear expiry
  [t] toggle enabled
  [d] delete
  [b] back
```

4. `[p] priority` opens `[l] low`, `[m] medium`, `[h] high`, `[d] disabled`,
   `[b] back`. Recompute `priorityWeight`.
5. `[x] set/clear expiry` opens `[s] set`, `[c] clear`, `[b] back`.
6. `[t] toggle enabled` flips `enabled`; if enabling an account with
   `priority === 'disabled'`, set priority to `medium`.
7. `[d] delete` asks explicit confirmation, removes the account record, then
   deletes its scoped home dir. Never delete the global OpenCode auth path.

## Routing Model

Add account routing inputs to `OrchestrateDeps` in `src/core/types.ts`, near the
existing routing/cooldown fields at `src/core/types.ts:347-386`:

```ts
readonly opencodeAccounts?: readonly OpencodeSubscriptionAccount[];
readonly opencodeAccountCooldownUntil?: ReadonlyMap<string, number>;
readonly sessionTokensByAccount?: Readonly<Record<string, number>>;
```

These fields are absent when the flag is off or when there are no accounts.

Add optional execution fields to `ProviderRequest` in `src/providers/port.ts`,
near `src/providers/port.ts:35-80`:

```ts
readonly accountId?: string;
readonly accountEnv?: Readonly<Partial<NodeJS.ProcessEnv>>;
```

Only OpenCode uses these in Slice 1. Other adapters ignore them.

Add optional ledger field to `LedgerEntry` in `src/core/types.ts:181-219`:

```ts
readonly accountId?: string;
```

Update JSONL guard to accept optional string `accountId` and reject non-string.

Pool detection:

```ts
export function opencodePoolForModel(model: string): OpencodePool | null {
  if (model.startsWith('opencode-go/')) return 'go';
  if (model.startsWith('opencode/')) return 'zen';
  return null;
}
```

The placeholder model id `'opencode'` has unknown pool and must use the current
global path unchanged.

Selection:

```ts
export function selectOpencodeAccount(input: {
  accounts: readonly OpencodeSubscriptionAccount[];
  pool: OpencodePool;
  nowIso: string;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): OpencodeSubscriptionAccount | null;
```

Algorithm:

1. Keep only accounts where:
   - `provider === 'opencode'`
   - `pool` matches the model prefix
   - `enabled === true`
   - `priority !== 'disabled'`
   - `priorityWeight > 0`
   - no `expiresAt`, or `Date.parse(expiresAt) > now`
2. If none remain, return `null` and use the existing global OpenCode path.
3. Exclude cooling accounts where `cooldownUntil.get(account.id) > now`.
4. If all otherwise eligible accounts are cooling, ignore account cooldown for this
   selection so the user is not stranded. Disabled and expired accounts remain hard
   exclusions.
5. Choose the minimum:

```ts
normalizedLoad =
  (sessionTokensByAccount[account.id] ?? 0) / account.priorityWeight
```

6. Stable tie-breaker: `createdAt`, then `id` lexical.

No random selection in Slice 1.

## Work-Call Integration

Implement the account selection inside `runWorkCall`, not in the menu. The menu
loads accounts and passes immutable inputs; `runWorkCall` sees the resolved model
and can safely select the matching pool immediately before execution.

Before `src/core/work-call.ts:1359-1378` builds the request:

```ts
const account = select account only when:
  decision.provider === 'opencode'
  deps.opencodeAccounts exists and length > 0
  opencodePoolForModel(decision.model) !== null
```

After:

```ts
const accountEnv =
  account !== null
    ? { XDG_DATA_HOME: account.homeDir }
    : undefined;

const req: ProviderRequest = {
  model: decision.model,
  prompt,
  cwd: deps.cwd,
  sandbox: deps.sandbox,
  timeoutMs: deps.timeoutMs,
  ...(account !== null ? { accountId: account.id, accountEnv } : {}),
  // existing optional fields unchanged
};
```

Mirror the same helper at `src/core/work-call.ts:992-1006` if that request path is
still active for normal work calls in the implementation branch. Do not duplicate
selection logic inline.

Ledger after `src/core/work-call.ts:1470-1494`:

```ts
await deps.ledger.record({
  // existing fields...
  ...(account !== null ? { accountId: account.id } : {}),
});
```

Mirror at `src/core/work-call.ts:1033-1050` for the earlier request path.

`lastUsedAt`:

- Update account `lastUsedAt` after the provider run starts, not merely after
  routing. Practically, do it after `providerCalls++` and before/around
  `streamProvider(...)` at `src/core/work-call.ts:1381-1383`.
- Because core should not write the store directly, pass an optional callback:

```ts
readonly onAccountUsed?: (accountId: string, usedAtIso: string) => void | Promise<void>;
```

The menu callback updates `subscriptions.json` best-effort. A failure must not
fail the model call.

## OpenCode Env Injection

Modify only `src/providers/opencode.ts`.

Before `src/providers/opencode.ts:176-179`:

```ts
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...replitPersistentEnv(process.env, req.cwd),
};
```

After:

```ts
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...replitPersistentEnv(process.env, req.cwd),
  ...(req.accountEnv ?? {}),
};
```

Reason for ordering: account env must override Replit/global XDG values so
`resolveOpencodeAuthPath()` resolves to `<account.homeDir>/opencode/auth.json`
(`src/providers/detect.ts:799-805`).

Do not pass the API key in env. Only pass `XDG_DATA_HOME`.

## Menu-to-Core Wiring

At chat-session setup:

- Keep `providerCooldownUntil` at `src/interface/menu.ts:1044-1049`.
- Add `const opencodeAccountCooldownUntil = new Map<string, number>();`.
- Add `const sessionTokensByAccount: Record<string, number> = {};`.

In `accountingLedger.record` at `src/interface/menu.ts:1329-1338`:

```ts
if (entry.sessionId === convId && entry.accountId !== undefined) {
  sessionTokensByAccount[entry.accountId] =
    (sessionTokensByAccount[entry.accountId] ?? 0) + inputTokens + outputTokens;
}
```

When seeding from `readLedger()` at `src/interface/menu.ts:1351-1356`, add a
parallel helper to summarize account tokens from entries with `accountId`.
Existing ledgers without `accountId` simply seed nothing.

When building deps near `src/interface/menu.ts:2162-2192` and
`src/interface/menu.ts:2273-2295`:

```ts
const subsOn = subscriptionsEnabled(process.env, mutableCtx.config);
const opencodeAccounts =
  subsOn ? (await readSubscriptions().catch(() => ({ version: 1, accounts: [] }))).accounts : [];
```

Load once per turn, not on every keypress. If store read fails, use empty accounts
and preserve global behavior.

Pass to `orchestrate` only when `subsOn && opencodeAccounts.length > 0`:

```ts
opencodeAccounts,
opencodeAccountCooldownUntil,
sessionTokensByAccount,
onAccountUsed: async (accountId, usedAtIso) => { /* best-effort store update */ },
```

Do not alter `authenticatedProviders` or `availableModels` for Slice 1; provider
routing still chooses OpenCode as today, then account routing chooses an OpenCode
account underneath that decision.

## Account Cooldown

Use a parallel map for Slice 1:

```ts
const opencodeAccountCooldownUntil = new Map<string, number>();
```

Do not re-key provider-level cooldown in this slice.

Add to final/core/render plumbing:

- `CoreEvent` final gets optional `accountId?: string` near
  `src/core/types.ts:1181-1193`.
- `tier-start` may also get `accountId?: string` so renderers can track a running
  account if needed; keep it optional and hidden from normal UI.
- `renderStream()` return shape at `src/interface/render.ts:1107-1111` adds:

```ts
rateLimitedAccounts: readonly string[];
```

- `runTask()` return shape at `src/interface/run.ts:23-47` and
  `src/interface/run.ts:91-97` adds optional `rateLimitedAccounts`.

Where to populate:

- If a provider-event error is `rate-limit` and the current run has `accountId`,
  add that account id to `rateLimitedAccounts`, analogous to
  `src/interface/render.ts:727-731`.
- If a final is a failing rate-limit final with `accountId`, include it as a
  fallback, analogous to `noteRateLimit()` fallback logic at
  `src/interface/menu.ts:1613-1620`.

Update `noteRateLimit()` at `src/interface/menu.ts:1603-1643`:

```ts
const throttledAccounts = new Set(result.rateLimitedAccounts ?? []);
for (const id of throttledAccounts) {
  if ((opencodeAccountCooldownUntil.get(id) ?? 0) <= now) newlyCooledAccounts.push(id);
  opencodeAccountCooldownUntil.set(id, cooldownExpiry(now));
}
```

Provider cooldown remains unchanged for non-account paths. For an OpenCode account
429, also preserving the existing provider-level OpenCode cooldown is acceptable
for Slice 1 only if it does not prevent account selection. The account selector
must use `opencodeAccountCooldownUntil`, not `providerCooldownUntil`.

All-cooling behavior belongs in `selectOpencodeAccount()`, matching the
non-stranding principle in `src/core/cooldown.ts:39-59`.

## Backward Compatibility

- Flag off: current behavior is byte-identical.
- Flag on, no accounts: current global OpenCode auth remains in use.
- Flag on, corrupt store: fall back to no accounts and current global behavior.
- Flag on, accounts exist but no matching account for model pool: use current
  global OpenCode path.
- No auto-import or migration from global OpenCode auth in Slice 1.
- Deleting a Slice 1 account deletes only its scoped home directory, never the
  global `~/.local/share/opencode/auth.json` or any path resolved from ambient
  `XDG_DATA_HOME`.

## Tests

Add focused unit tests only; no broad integration suite is required for Slice 1.

Store:

- `readSubscriptions()` missing file returns version 1 empty accounts.
- Round trip writes and reads all fields.
- Corrupt file returns empty accounts and does not throw.
- `writeSubscriptions()` uses atomic private write; test by writing and reading,
  and, on non-win32, assert mode is not group/world-readable.
- `newOpencodeAccount()` creates absolute `homeDir` under
  `<stateHome>/.myshell-tools/opencode-accounts/<id>`.
- Delete home refuses a path outside the account root. Guard recursive-delete mode
  assertions on win32.

Priority:

- `priorityWeight('low') === 25`.
- `priorityWeight('medium') === 100`.
- `priorityWeight('high') === 200`.
- `priorityWeight('disabled') === 0`.

Auth writer:

- Zen writes exactly:

```json
{"opencode":{"type":"api","key":"sk-test"}}
```

- Go writes exactly:

```json
{"opencode-go":{"type":"api","key":"sk-test"}}
```

- No secret appears in `subscriptions.json`.
- On non-win32, auth file mode is not group/world-readable.

Selection:

- Matching-pool filter separates `opencode/...` Zen from `opencode-go/...` Go.
- Higher weight absorbs more load via normalized load.
- Cooling account is excluded when a sibling is available.
- If all eligible matching accounts are cooling, selector still returns one.
- Expired accounts are excluded.
- Disabled accounts are excluded.
- No matching eligible account returns `null`.
- Ties are stable by `createdAt`, then `id`.

Adapter/env:

- OpenCode adapter passes `XDG_DATA_HOME` from `req.accountEnv` through to
  `spawnGuarded` env and overrides `replitPersistentEnv`.
- Without `req.accountEnv`, env is unchanged.

Ledger/cooldown:

- Ledger record includes `accountId` when an account was selected.
- Ledger record omits `accountId` on global path.
- Session token accounting increments `sessionTokensByAccount[accountId]`.
- Renderer/runTask carries `rateLimitedAccounts`.
- `noteRateLimit()` cools only that account id; sibling remains selectable.

Flag off:

- With `experimentalSubscriptions` absent/false and no `MYSHELL_SUBSCRIPTIONS`,
  the menu does not read the store.
- ProviderRequest has no account fields.
- Ledger entry has no `accountId`.
- Existing `[o]` login handler is still used.

Windows guards:

- File permission mode assertions are non-win32 only.
- Recursive delete root-safety tests run on all platforms, but POSIX mode checks
  are skipped on win32.

## Build Order

1. Add flag type/helper and tests.
2. Add `src/infra/subscriptions.ts` types, path helpers, store read/write, priority
   mapping, auth writer, and store tests.
3. Add `menu-secret-input.ts` with hidden line input and tests using injected
   readers/output.
4. Add `menu-opencode-accounts.ts` create/edit/delete flows using `readMenuKey()`.
5. Wire `[o]` to account menu only when the flag is on; keep old login path when
   off.
6. Add optional `accountId` to `LedgerEntry`, JSONL guard, `CoreEvent.final`,
   renderer/runTask return shapes, and tests.
7. Add optional `accountId`/`accountEnv` to `ProviderRequest`.
8. Modify OpenCode adapter env merge so `req.accountEnv` overrides global/Replit
   XDG values.
9. Add pure OpenCode account selection helper and tests.
10. Pass accounts/cooldown/session-load from menu into `OrchestrateDeps` only when
    the flag is on and accounts exist.
11. In `runWorkCall`, select an account for concrete OpenCode model ids, stamp
    request/ledger/final with `accountId`, and call `onAccountUsed`.
12. Add account-level cooldown map/update in menu and tests for 429 sibling
    behavior.
13. Run the targeted unit tests plus existing OpenCode adapter/args tests.

## Acceptance Criteria

- A user can enable `MYSHELL_SUBSCRIPTIONS=1`, open `[o] OpenCode Accounts`, create
  one Zen and one Go account by pasting keys, and see records in
  `subscriptions.json`.
- Each account has a separate `<homeDir>/opencode/auth.json` with the exact
  verified schema.
- A routed `opencode/...` model runs with the selected Zen account's
  `XDG_DATA_HOME`.
- A routed `opencode-go/...` model runs with the selected Go account's
  `XDG_DATA_HOME`.
- The ledger records `accountId` for account-routed OpenCode calls.
- A 429 cools only the selected account id, not its sibling.
- With the flag off, no source path observes `subscriptions.json` and existing
  single global OpenCode auth behavior remains unchanged.

