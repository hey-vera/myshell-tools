# Slice 2 Claude Accounts Spec

Status: implementation spec only. Do not edit source or tests as part of this
document change.

This slice extends the shipped Slice 1 OpenCode account path to Claude OAuth
accounts first, while generalizing the account model and selector enough that
Codex and Grok can be added in Slice 3 without another OpenCode-specific fork.

Hard constraints from the design docs:

- Vendor credential homes are the account boundary: Claude uses
  `CLAUDE_CONFIG_DIR`, Codex uses `CODEX_HOME`, Grok uses `GROK_HOME`, and
  OpenCode currently uses `XDG_DATA_HOME` in the shipped Slice 1 implementation
  ([docs/subscription-management-design.md:322](subscription-management-design.md:322),
  [docs/subscription-management-design.md:324](subscription-management-design.md:324),
  [docs/subscription-management-design.md:326](subscription-management-design.md:326),
  [docs/subscription-management-design.md:328](subscription-management-design.md:328),
  [docs/subscription-management-design.md:330](subscription-management-design.md:330)).
- Existing login and detection should be reused with account-scoped env
  ([docs/subscription-management-design.md:500](subscription-management-design.md:500),
  [docs/subscription-management-design.md:506](subscription-management-design.md:506),
  [docs/subscription-management-design.md:865](subscription-management-design.md:865),
  [docs/subscription-management-design.md:873](subscription-management-design.md:873)).
- Account routing must select by normalized load and account cooldown, not by
  provider cooldown alone
  ([docs/subscription-management-design.md:574](subscription-management-design.md:574),
  [docs/subscription-management-design.md:580](subscription-management-design.md:580),
  [docs/subscription-management-design.md:582](subscription-management-design.md:582),
  [docs/subscription-management-design.md:761](subscription-management-design.md:761)).
- Account selection and account env execution must ship together for Claude
  routing, because a selected `accountId` without the matching child env makes
  receipts and cooldowns false
  ([docs/subscription-management-redteam.md:170](subscription-management-redteam.md:170),
  [docs/subscription-management-redteam.md:189](subscription-management-redteam.md:189),
  [docs/subscription-management-redteam.md:322](subscription-management-redteam.md:322),
  [docs/subscription-management-redteam.md:323](subscription-management-redteam.md:323)).
- macOS Claude multi-OAuth must be blocked because Claude Code stores OAuth
  tokens in a shared Keychain service not namespaced by `CLAUDE_CONFIG_DIR`
  ([docs/subscription-management-redteam.md:30](subscription-management-redteam.md:30),
  [docs/subscription-management-redteam.md:38](subscription-management-redteam.md:38),
  [docs/subscription-management-redteam.md:49](subscription-management-redteam.md:49),
  [docs/subscription-management-redteam.md:51](subscription-management-redteam.md:51)).

## Existing Slice 1 Surface

Slice 1 already shipped these integration points:

- `src/infra/subscriptions.ts` stores only OpenCode accounts today:
  `SubscriptionProvider = 'opencode'` at
  [src/infra/subscriptions.ts:11](../src/infra/subscriptions.ts:11),
  `OpencodeSubscriptionAccount` at
  [src/infra/subscriptions.ts:15](../src/infra/subscriptions.ts:15),
  `SubscriptionsFileV1.accounts` at
  [src/infra/subscriptions.ts:29](../src/infra/subscriptions.ts:29), and
  `SubscriptionAccount = OpencodeSubscriptionAccount` at
  [src/infra/subscriptions.ts:34](../src/infra/subscriptions.ts:34).
- OpenCode account homes are
  `<stateHome>/.myshell-tools/opencode-accounts/<accountId>` via
  [src/infra/subscriptions.ts:59](../src/infra/subscriptions.ts:59), and its
  auth path is `<homeDir>/opencode/auth.json` via
  [src/infra/subscriptions.ts:63](../src/infra/subscriptions.ts:63).
- The `[o]` account screen is implemented in
  `src/interface/menu-opencode-accounts.ts`, including row rendering at
  [src/interface/menu-opencode-accounts.ts:20](../src/interface/menu-opencode-accounts.ts:20),
  hidden secret input at
  [src/interface/menu-opencode-accounts.ts:59](../src/interface/menu-opencode-accounts.ts:59),
  account creation at
  [src/interface/menu-opencode-accounts.ts:111](../src/interface/menu-opencode-accounts.ts:111),
  edit actions at
  [src/interface/menu-opencode-accounts.ts:180](../src/interface/menu-opencode-accounts.ts:180),
  priority selection at
  [src/interface/menu-opencode-accounts.ts:263](../src/interface/menu-opencode-accounts.ts:263),
  and delete at
  [src/interface/menu-opencode-accounts.ts:238](../src/interface/menu-opencode-accounts.ts:238).
- The subscriptions flag is `subscriptionsEnabled()` at
  [src/interface/ui/subscriptions-flag.ts:5](../src/interface/ui/subscriptions-flag.ts:5).
  The main menu already uses it for the OpenCode label at
  [src/interface/menu-render.ts:161](../src/interface/menu-render.ts:161) and
  for `[o]` dispatch at
  [src/interface/menu.ts:7048](../src/interface/menu.ts:7048).
- `ProviderRequest` already has optional `accountId` and `accountEnv` at
  [src/providers/port.ts:98](../src/providers/port.ts:98) and
  [src/providers/port.ts:104](../src/providers/port.ts:104). The comments still
  say OpenCode-only and must be generalized.
- OpenCode env injection is already extracted as `buildOpencodeEnv()` at
  [src/providers/opencode.ts:118](../src/providers/opencode.ts:118), merging
  `req.accountEnv` last at
  [src/providers/opencode.ts:125](../src/providers/opencode.ts:125), and used
  for the spawn env at
  [src/providers/opencode.ts:194](../src/providers/opencode.ts:194).
- The pure OpenCode selector is in
  [src/core/opencode-account-routing.ts:48](../src/core/opencode-account-routing.ts:48);
  it filters enabled, non-expired, non-cooling accounts and chooses the minimum
  `(sessionTokensByAccount[id] ?? 0) / priorityWeight` at
  [src/core/opencode-account-routing.ts:61](../src/core/opencode-account-routing.ts:61)
  through [src/core/opencode-account-routing.ts:98](../src/core/opencode-account-routing.ts:98).
- Work-call selects OpenCode accounts at
  [src/core/work-call.ts:1355](../src/core/work-call.ts:1355), sets
  `XDG_DATA_HOME` at
  [src/core/work-call.ts:1367](../src/core/work-call.ts:1367), threads
  `accountId` and `accountEnv` into `ProviderRequest` at
  [src/core/work-call.ts:1407](../src/core/work-call.ts:1407), and records
  `accountId` in ledgers/finals at
  [src/core/work-call.ts:1536](../src/core/work-call.ts:1536) and
  [src/core/work-call.ts:2493](../src/core/work-call.ts:2493).
- Menu state already maintains `opencodeAccountCooldownUntil` and
  `sessionTokensByAccount` at
  [src/interface/menu.ts:1053](../src/interface/menu.ts:1053) and
  [src/interface/menu.ts:1057](../src/interface/menu.ts:1057), seeds account
  tokens from ledger entries at
  [src/interface/menu.ts:1370](../src/interface/menu.ts:1370), and cools the
  specific account on rate-limit finals at
  [src/interface/menu.ts:1644](../src/interface/menu.ts:1644).

## Generalized Account Model

Update `src/infra/subscriptions.ts` around the current types at
[src/infra/subscriptions.ts:10](../src/infra/subscriptions.ts:10). The model must
be generalized without making existing OpenCode account literals or tests add a
new required field. The safe approach is a stored compatibility type plus a
normalized helper.

```ts
export type SubscriptionAccountId = string;
export type SubscriptionProvider = 'opencode' | 'claude' | 'codex' | 'grok';
export type SubscriptionAccountKind = 'api-key' | 'oauth-sub';
export type OpencodePool = 'zen' | 'go';
export type AccountPriority = 'low' | 'medium' | 'high' | 'disabled';
export type AccountStatus = 'active' | 'expired' | 'auth-failed' | 'disabled' | 'unknown';

export interface SubscriptionAccountBase {
  readonly id: SubscriptionAccountId;
  readonly provider: SubscriptionProvider;
  readonly kind: SubscriptionAccountKind;
  readonly label: string;
  readonly homeDir: string;
  readonly priority: AccountPriority;
  readonly priorityWeight: number;
  readonly expiresAt?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly status?: AccountStatus;
  readonly plan?: string | null;
}

export interface OpencodeSubscriptionAccount {
  readonly id: SubscriptionAccountId;
  readonly provider: 'opencode';
  // Optional only for legacy/source compatibility. Treat missing as 'api-key'.
  readonly kind?: 'api-key';
  readonly label: string;
  readonly pool: OpencodePool;
  readonly homeDir: string;
  readonly priority: AccountPriority;
  readonly priorityWeight: number;
  readonly expiresAt?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly status?: AccountStatus;
  readonly plan?: string | null;
}

export interface ClaudeSubscriptionAccount extends SubscriptionAccountBase {
  readonly provider: 'claude';
  readonly kind: 'oauth-sub';
}

export interface CodexSubscriptionAccount extends SubscriptionAccountBase {
  readonly provider: 'codex';
  readonly kind: 'oauth-sub';
}

export interface GrokSubscriptionAccount extends SubscriptionAccountBase {
  readonly provider: 'grok';
  readonly kind: 'oauth-sub';
}

export type SubscriptionAccount =
  | OpencodeSubscriptionAccount
  | ClaudeSubscriptionAccount
  | CodexSubscriptionAccount
  | GrokSubscriptionAccount;

export interface SubscriptionsFileV1 {
  readonly version: 1;
  readonly accounts: readonly SubscriptionAccount[];
}
```

Why `OpencodeSubscriptionAccount.kind` is optional: existing tests construct
OpenCode account literals without `kind`, for example
[test/unit/subscriptions.test.ts:154](../test/unit/subscriptions.test.ts:154) and
[test/unit/opencode-account-routing.test.ts:28](../test/unit/opencode-account-routing.test.ts:28).
Making `kind` required on the exported OpenCode type would turn Slice 2 into an
unrelated fixture churn. New non-OpenCode accounts must have required `kind`.

Add helpers in `src/infra/subscriptions.ts` near the current path helpers at
[src/infra/subscriptions.ts:51](../src/infra/subscriptions.ts:51):

```ts
export function subscriptionAccountKind(account: SubscriptionAccount): SubscriptionAccountKind {
  if (account.provider === 'opencode') return account.kind ?? 'api-key';
  return account.kind;
}

export function getProviderAccountHome(
  provider: SubscriptionProvider,
  accountId: string,
  stateHome?: string,
): string {
  const root = join(getSubscriptionsDir(stateHome), 'provider-homes');
  return join(root, provider, accountId);
}

export function getClaudeAccountHome(accountId: string, stateHome?: string): string {
  return getProviderAccountHome('claude', accountId, stateHome);
}

export function accountEnvFor(account: SubscriptionAccount): Readonly<Partial<NodeJS.ProcessEnv>> {
  if (account.provider === 'claude') return { CLAUDE_CONFIG_DIR: account.homeDir };
  if (account.provider === 'codex') return { CODEX_HOME: account.homeDir };
  if (account.provider === 'grok') return { GROK_HOME: account.homeDir };
  return { XDG_DATA_HOME: account.homeDir };
}
```

Home mapping for this slice:

- Claude: `CLAUDE_CONFIG_DIR=<account.homeDir>`.
- Codex: `CODEX_HOME=<account.homeDir>` but no Codex account creation/routing in
  Slice 2.
- Grok: `GROK_HOME=<account.homeDir>` but no Grok account creation/routing in
  Slice 2.
- OpenCode: keep the shipped Slice 1 behavior exactly:
  `XDG_DATA_HOME=<account.homeDir>` only. Do not move existing OpenCode accounts
  from `opencode-accounts` to `provider-homes/opencode` in Slice 2 because
  `getOpencodeAccountHome()` is already tested to return `opencode-accounts` at
  [test/unit/subscriptions.test.ts:71](../test/unit/subscriptions.test.ts:71).

Add a Claude factory next to `newOpencodeAccount()` at
[src/infra/subscriptions.ts:112](../src/infra/subscriptions.ts:112):

```ts
export function newClaudeAccount(input: {
  id: string;
  label: string;
  priority?: AccountPriority;
  expiresAt?: string;
  nowIso: string;
  stateHome?: string;
}): ClaudeSubscriptionAccount {
  const resolvedPriority = input.priority ?? 'medium';
  return {
    id: input.id,
    provider: 'claude',
    kind: 'oauth-sub',
    label: input.label,
    homeDir: getClaudeAccountHome(input.id, input.stateHome),
    priority: resolvedPriority,
    priorityWeight: priorityWeight(resolvedPriority),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    enabled: resolvedPriority !== 'disabled',
    createdAt: input.nowIso,
    status: 'unknown',
  };
}
```

### Migration

Keep `version: 1`. This is a widening migration, not a format break.

- Existing `subscriptions.json` files with only OpenCode accounts remain valid.
  `readSubscriptions()` currently returns `parsed.accounts` directly at
  [src/infra/subscriptions.ts:76](../src/infra/subscriptions.ts:76). Slice 2
  should validate enough to discard obviously malformed records but must not
  require `kind` on OpenCode accounts.
- On read, treat an OpenCode account with missing `kind` as `api-key` through
  `subscriptionAccountKind()`. Do not rewrite the file just because `kind` is
  missing.
- On write, preserve account objects as supplied. Do not inject `kind` into
  OpenCode accounts created by `newOpencodeAccount()` unless a future test update
  explicitly opts into that shape. `writeSubscriptions()` must continue using
  atomic mode `0o600` at
  [src/infra/subscriptions.ts:91](../src/infra/subscriptions.ts:91).
- New Claude accounts are appended as generalized records with `kind:
  'oauth-sub'`, `provider: 'claude'`, and a `provider-homes/claude/<accountId>`
  home.
- If `subscriptions.json` is corrupt, preserve the existing fail-soft behavior:
  `readSubscriptions()` returns `{ version: 1, accounts: [] }` at
  [src/infra/subscriptions.ts:71](../src/infra/subscriptions.ts:71) through
  [src/infra/subscriptions.ts:81](../src/infra/subscriptions.ts:81). The redteam
  requires falling back to provider-level behavior rather than stranding users
  ([docs/subscription-management-redteam.md:311](subscription-management-redteam.md:311)).

## Generic Selector API

Replace the OpenCode-specific selector implementation with a provider-generic
selector while preserving the current exports. The current file is pure by design
([src/core/opencode-account-routing.ts:4](../src/core/opencode-account-routing.ts:4)),
so either keep the file name for compatibility or add
`src/core/subscription-account-routing.ts` and re-export wrappers from the old
file.

Generic API:

```ts
export function selectSubscriptionAccount<T extends SubscriptionAccount>(input: {
  accounts: readonly T[];
  provider: SubscriptionProvider;
  pool?: OpencodePool;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): T | null;
```

Algorithm must remain the same as the shipped OpenCode math:

1. Keep only accounts where `account.provider === input.provider`.
2. If `input.provider === 'opencode'`, also require `account.pool === input.pool`.
   If the provider is Claude/Codex/Grok, ignore `pool`.
3. Keep only `enabled === true`, `priority !== 'disabled'`,
   `priorityWeight > 0`, and `expiresAt` absent or future. This matches the
   current OpenCode filters at
   [src/core/opencode-account-routing.ts:61](../src/core/opencode-account-routing.ts:61).
4. Exclude cooling accounts using `cooldownUntil.get(account.id) > nowMs`, unless
   all eligible accounts are cooling. Preserve the current never-strand behavior
   from [src/core/opencode-account-routing.ts:79](../src/core/opencode-account-routing.ts:79)
   through [src/core/opencode-account-routing.ts:86](../src/core/opencode-account-routing.ts:86).
5. Select the minimum normalized load:
   `(sessionTokensByAccount[account.id] ?? 0) / account.priorityWeight`, as
   currently computed at
   [src/core/opencode-account-routing.ts:71](../src/core/opencode-account-routing.ts:71).
6. Preserve the stable tiebreaker: `createdAt`, then lexical `id`, currently at
   [src/core/opencode-account-routing.ts:89](../src/core/opencode-account-routing.ts:89)
   through [src/core/opencode-account-routing.ts:96](../src/core/opencode-account-routing.ts:96).

Compatibility wrapper:

```ts
export function selectOpencodeAccount(input: {
  accounts: readonly OpencodeSubscriptionAccount[];
  pool: OpencodePool;
  nowMs: number;
  cooldownUntil: ReadonlyMap<string, number>;
  sessionTokensByAccount: Readonly<Record<string, number>>;
}): OpencodeSubscriptionAccount | null {
  return selectSubscriptionAccount({
    accounts: input.accounts,
    provider: 'opencode',
    pool: input.pool,
    nowMs: input.nowMs,
    cooldownUntil: input.cooldownUntil,
    sessionTokensByAccount: input.sessionTokensByAccount,
  });
}
```

Keep `opencodePoolForModel()` unchanged at
[src/core/opencode-account-routing.ts:26](../src/core/opencode-account-routing.ts:26).
OpenCode call sites continue to call the wrapper. Claude call sites call
`selectSubscriptionAccount({ provider: 'claude', accounts, ... })` directly.

## Claude Accounts Menu

Add `src/interface/menu-claude-accounts.ts`, mirroring
`src/interface/menu-opencode-accounts.ts`.

Required imports and reuse:

- Reuse `readMenuKey()` from
  [src/interface/menu-opencode-accounts.ts:3](../src/interface/menu-opencode-accounts.ts:3).
- Reuse priority and expiry screen patterns from
  [src/interface/menu-opencode-accounts.ts:263](../src/interface/menu-opencode-accounts.ts:263)
  and [src/interface/menu-opencode-accounts.ts:283](../src/interface/menu-opencode-accounts.ts:283).
- Reuse `readSubscriptions()` and `updateSubscriptions()` from
  [src/interface/menu-opencode-accounts.ts:12](../src/interface/menu-opencode-accounts.ts:12)
  and [src/interface/menu-opencode-accounts.ts:13](../src/interface/menu-opencode-accounts.ts:13).
- Reuse `runLogin()` from
  [src/commands/login.ts:309](../src/commands/login.ts:309). The Claude command
  definitions and guidance are already in `LOGIN_COMMAND.claude` at
  [src/commands/login.ts:57](../src/commands/login.ts:57) and the code flow
  guidance at [src/commands/login.ts:13](../src/commands/login.ts:13).
- Reuse `detectProvider()` for verification, as `runLogin()` already does inside
  `verifyPostLogin()` at
  [src/commands/login.ts:264](../src/commands/login.ts:264).

Screen:

```text
Claude Accounts

  #  label                 priority  expiry       status
  1  Claude Max personal   high      2026-07-28   active
  2  Claude work           medium    -            auth-failed

  [c] create
  [e] edit
  [b] back
```

Row status:

- `disabled` if `enabled === false` or `priority === 'disabled'`.
- `expired` if `expiresAt` is in the past.
- `auth-failed` if the last account detection failed.
- `active` if detection authenticated the account.
- `unknown` when never verified.

Create flow:

1. In `createClaudeAccountFlow()`, read the current store and filter
   `provider === 'claude'`.
2. Apply the macOS guard before creating any directory or running login. Exact
   location: `src/interface/menu-claude-accounts.ts`, inside
   `createClaudeAccountFlow()`, immediately after `readSubscriptions()` and
   before `newClaudeAccount()`, `mkdir(account.homeDir)`, or `runLogin()`.
3. Generate `acct_` id using `clock.uuid()` exactly like OpenCode does at
   [src/interface/menu-opencode-accounts.ts:107](../src/interface/menu-opencode-accounts.ts:107).
4. Build a `ClaudeSubscriptionAccount` with `newClaudeAccount()`.
5. Create `account.homeDir` with mode `0o700`.
6. Run the existing Claude OAuth login with account env:
   `runLogin(out, 'claude', { readLine, confirm, suspendStdin, accountEnv:
   { CLAUDE_CONFIG_DIR: account.homeDir } })`.
7. Verify success by checking `<account.homeDir>/.credentials.json` exists and
   account-scoped `detectProvider('claude', { env, cwd, credentialFileFallback:
   true, storedCredentialInjection: false })` reports authenticated. The verified
   credential path is grounded in `resolveClaudeCredsPath()` honoring
   `CLAUDE_CONFIG_DIR` at
   [src/infra/claude-oauth-refresh.ts:171](../src/infra/claude-oauth-refresh.ts:171)
   through [src/infra/claude-oauth-refresh.ts:178](../src/infra/claude-oauth-refresh.ts:178).
8. Prompt optional label and expiry after successful auth, mirroring OpenCode's
   expiry and label prompts at
   [src/interface/menu-opencode-accounts.ts:76](../src/interface/menu-opencode-accounts.ts:76)
   and [src/interface/menu-opencode-accounts.ts:92](../src/interface/menu-opencode-accounts.ts:92).
   Default label: `Claude 1`, `Claude 2`, etc.
9. Append the record with `status: 'active'`, detected `plan`, optional
   `expiresAt`, and `lastUsedAt` absent. On auth failure, offer retry or delete
   the just-created scoped home; do not append an enabled account that cannot be
   authenticated.

`runLogin()` change required to support this reuse:

- Add `accountEnv?: Readonly<Partial<NodeJS.ProcessEnv>>` to the existing opts
  object at [src/commands/login.ts:312](../src/commands/login.ts:312).
- In `runCodeMethodForProvider()`, add an optional account env parameter and
  merge it last after `loginPersistentEnv()` where `childEnv` is currently built
  at [src/commands/login.ts:220](../src/commands/login.ts:220).
- In the browser path, merge `opts.accountEnv` last where `childEnv` is currently
  built at [src/commands/login.ts:350](../src/commands/login.ts:350).
- Keep `verifyPostLogin()` unchanged in behavior, but pass the account-scoped
  child env it already accepts at
  [src/commands/login.ts:264](../src/commands/login.ts:264) through
  [src/commands/login.ts:275](../src/commands/login.ts:275).

Edit flow:

- Show provider, id, status, priority, expiry, enabled, plan.
- Actions:
  - `[p] priority`: low/medium/high/disabled, same weights as
    `priorityWeight()` at
    [src/infra/subscriptions.ts:40](../src/infra/subscriptions.ts:40).
  - `[x] set/clear expiry`.
  - `[t] toggle enabled`.
  - `[r] re-auth`: rerun `runLogin(out, 'claude', { accountEnv:
    { CLAUDE_CONFIG_DIR: account.homeDir }, ... })`, then rerun detection and
    update `status`, `plan`, and `expiresAt` if derivable.
  - `[d] delete`: remove the record with `updateSubscriptions()`, then delete the
    scoped home only if it is under
    `<stateHome>/.myshell-tools/provider-homes/claude/`. Use the same containment
    pattern as `deleteOpencodeAccountHome()` at
    [src/infra/subscriptions.ts:166](../src/infra/subscriptions.ts:166)
    through [src/infra/subscriptions.ts:175](../src/infra/subscriptions.ts:175).

## macOS Guard

The guard lives in the new menu create flow, not in routing and not in
`runLogin()`, because it must show a hard platform notice before account
creation as required by
[docs/subscription-management-redteam.md:52](subscription-management-redteam.md:52).

Exact implementation point:

```ts
// src/interface/menu-claude-accounts.ts
async function createClaudeAccountFlow(..., platform: NodeJS.Platform = process.platform) {
  const file = await readSubscriptions();
  const existingClaudeOauth = file.accounts.filter(
    (a) => a.provider === 'claude' && subscriptionAccountKind(a) === 'oauth-sub',
  );
  if (platform === 'darwin' && existingClaudeOauth.length >= 1) {
    out.write(
      yellow(
        'Claude Code OAuth accounts cannot be isolated on macOS because Claude stores OAuth tokens in a shared Keychain service. Keep the existing Claude account or delete it before creating another.',
        out.color,
      ) + '\n',
    );
    return;
  }
  // only now create account home and run login
}
```

Rules:

- macOS may create the first Claude OAuth account.
- macOS must block creating the second Claude OAuth account.
- Re-auth of the existing single macOS Claude account is allowed.
- Linux and Windows follow normal multi-account creation.
- The guard is test-injected by passing `platform` into
  `runClaudeAccountsMenu()` or `createClaudeAccountFlow()`; do not read
  `process.platform` inside pure helpers.

## Main Menu Gating

Update the existing `[j]` label and dispatch only when subscriptions are enabled.

Label:

- Current fixed label is at
  [src/interface/menu-render.ts:171](../src/interface/menu-render.ts:171):
  `{ key: 'j', label: 'Login Claude', section: 'Auth' }`.
- Change to:
  - flag off: `Login Claude`.
  - flag on: `Claude Accounts`.

Dispatch:

- Current `[j]` always calls `loginFn(out, 'claude', ...)` at
  [src/interface/menu.ts:7021](../src/interface/menu.ts:7021) through
  [src/interface/menu.ts:7028](../src/interface/menu.ts:7028).
- Change to mirror `[o]` at
  [src/interface/menu.ts:7048](../src/interface/menu.ts:7048):

```ts
if (key === 'j') {
  if (subscriptionsEnabled(process.env, mutableCtx.config)) {
    await runClaudeAccountsMenu(out, readLine, confirm, ctx.clock, {
      login: loginFn,
      suspendStdin,
      inkReadKey,
      cwd: ctx.cwd,
    });
    await refreshEnvironmentIfStale(true);
    continue;
  }
  await loginFn(out, 'claude', {
    readLine,
    confirm,
    ...(suspendStdin !== undefined ? { suspendStdin } : {}),
  });
  await refreshEnvironmentIfStale(true);
  continue;
}
```

Flag-off guarantee:

- Do not import or run the Claude account menu on the flag-off path.
- Do not read `subscriptions.json` for `[j]` on the flag-off path.
- The existing single Claude login behavior stays the code path at
  [src/interface/menu.ts:7021](../src/interface/menu.ts:7021).

## Claude Detection

The verified Claude credential path is
`<CLAUDE_CONFIG_DIR>/.credentials.json`. Existing code already resolves exactly
that in `resolveClaudeCredsPath()` at
[src/infra/claude-oauth-refresh.ts:176](../src/infra/claude-oauth-refresh.ts:176)
through [src/infra/claude-oauth-refresh.ts:178](../src/infra/claude-oauth-refresh.ts:178).

Add an account helper in `src/infra/subscriptions.ts` or a small new
`src/infra/subscription-detect.ts`:

```ts
export async function detectSubscriptionAccount(input: {
  account: SubscriptionAccount;
  cwd: string;
  nowMs: number;
}): Promise<{ status: AccountStatus; plan: string | null; expiresAt?: string }> {
  const env = { ...process.env, ...accountEnvFor(input.account) };
  if (input.account.provider === 'claude') {
    await refreshClaudeOauthIfNeeded({
      env,
      cwd: input.cwd,
      home: input.account.homeDir,
    });
    const status = await detectProvider('claude', {
      env,
      cwd: input.cwd,
      credentialFileFallback: true,
      storedCredentialInjection: false,
    });
    // active/auth-failed comes from status.authenticated
    // plan comes from status.plan
    // expiresAt comes from parsing claudeAiOauth.expiresAt in .credentials.json
  }
}
```

Important details:

- Use `storedCredentialInjection: false`; account detection must not allow the
  legacy `CLAUDE_CODE_OAUTH_TOKEN` fallback to authenticate the wrong account.
  `detectProvider()` accepts this option at
  [src/providers/detect.ts:471](../src/providers/detect.ts:471) through
  [src/providers/detect.ts:478](../src/providers/detect.ts:478).
- `detectProvider('claude')` already runs `claude --version` with the child env
  at [src/providers/detect.ts:503](../src/providers/detect.ts:503) and
  `claude auth status` with that env at
  [src/providers/detect.ts:515](../src/providers/detect.ts:515).
- Plan enrichment from `.credentials.json` is already implemented at
  [src/providers/detect.ts:568](../src/providers/detect.ts:568) through
  [src/providers/detect.ts:580](../src/providers/detect.ts:580).
- Expiry comes from `claudeAiOauth.expiresAt`, parsed by
  `parseClaudeOauth()` and used for credential fallback at
  [src/providers/detect.ts:368](../src/providers/detect.ts:368) through
  [src/providers/detect.ts:372](../src/providers/detect.ts:372). If
  `expiresAt` is absent, leave account `expiresAt` unset.
- Do not disable an account only because refresh failed. The redteam requires a
  subsequent auth probe before marking unusable
  ([docs/subscription-management-redteam.md:160](subscription-management-redteam.md:160),
  [docs/subscription-management-redteam.md:165](subscription-management-redteam.md:165)).

Status update after create/re-auth:

- `authenticated === true` and not expired: `status: 'active'`.
- `authenticated === false`: `status: 'auth-failed'`, `enabled` unchanged unless
  the user explicitly disables it.
- `expiresAt` in the past: `status: 'expired'`, and selector excludes it.
- `enabled === false` or `priority === 'disabled'`: render `disabled`.

## Claude Adapter Account Env Injection

Current Claude adapter before:

```ts
let childEnv: NodeJS.ProcessEnv = process.env;
try {
  childEnv = await claudeEnvWithStoredFallback(process.env, req.cwd);
} catch {
  // Never throw - fall back to the unmodified env
}
```

This code is at [src/providers/claude.ts:254](../src/providers/claude.ts:254)
through [src/providers/claude.ts:261](../src/providers/claude.ts:261), and the
spawn uses `env: childEnv` at
[src/providers/claude.ts:267](../src/providers/claude.ts:267) through
[src/providers/claude.ts:274](../src/providers/claude.ts:274).

Required after:

```ts
export async function buildClaudeEnv(
  req: ProviderRequest,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const accountScopedBase = {
    ...parentEnv,
    ...(req.accountEnv ?? {}),
  };
  try {
    const withFallback = await claudeEnvWithStoredFallback(
      accountScopedBase,
      req.cwd,
      req.accountEnv === undefined,
    );
    return {
      ...withFallback,
      ...(req.accountEnv ?? {}),
    };
  } catch {
    return accountScopedBase;
  }
}
```

Then in `runClaudeRaw()`:

```ts
const childEnv = await buildClaudeEnv(req);
```

Rules:

- `req.accountEnv` must override global/Replit env so
  `CLAUDE_CONFIG_DIR=<account.homeDir>` wins.
- When `req.accountEnv` exists, disable stored credential fallback. Otherwise a
  legacy `CLAUDE_CODE_OAUTH_TOKEN` can shadow the selected account.
- Without `req.accountEnv`, the behavior must be equivalent to the current
  `claudeEnvWithStoredFallback(process.env, req.cwd)` path.
- Add unit tests for `buildClaudeEnv()` exactly like OpenCode tests cover
  `buildOpencodeEnv()` at
  [test/unit/opencode-account-routing.test.ts:309](../test/unit/opencode-account-routing.test.ts:309).

Also update `ProviderRequest` comments at
[src/providers/port.ts:94](../src/providers/port.ts:94) and
[src/providers/port.ts:100](../src/providers/port.ts:100) to say
subscription-account, not OpenCode-only.

## Claude Account-Aware Routing

Half B wires Claude account routing into the same vertical path already used by
OpenCode.

Types:

- In `src/core/types.ts`, replace `opencodeAccounts?: readonly
  OpencodeSubscriptionAccount[]` at
  [src/core/types.ts:476](../src/core/types.ts:476) with:

```ts
readonly subscriptionAccounts?: readonly import('../infra/subscriptions.js').SubscriptionAccount[];
readonly accountCooldownUntil?: ReadonlyMap<string, number>;
```

- Keep deprecated `opencodeAccounts` and `opencodeAccountCooldownUntil` for a
  short compatibility step, or update all current call sites in one patch. If
  kept, `work-call.ts` should merge both into a single local candidate list.

Menu deps:

- `enrichDepsWithAccounts()` currently returns `opencodeAccounts: accounts` at
  [src/interface/menu.ts:2774](../src/interface/menu.ts:2774). Change it to pass
  `subscriptionAccounts: accounts` and `accountCooldownUntil`.
- The early return at
  [src/interface/menu.ts:2749](../src/interface/menu.ts:2749) is the flag-off
  byte-identical guard and must remain the first line of the enrichment function.

Work-call selection:

Current before:

```ts
const openCodeAccount =
  decision.provider === 'opencode' &&
  deps.opencodeAccounts !== undefined &&
  deps.opencodeAccounts.length > 0
    ? selectOpencodeAccount(...)
    : null;
const accountEnv =
  openCodeAccount !== null
    ? { XDG_DATA_HOME: openCodeAccount.homeDir }
    : undefined;
```

This is at [src/core/work-call.ts:1355](../src/core/work-call.ts:1355) through
[src/core/work-call.ts:1370](../src/core/work-call.ts:1370).

Required after:

```ts
const subscriptionAccount =
  deps.subscriptionAccounts !== undefined &&
  deps.subscriptionAccounts.length > 0 &&
  (decision.provider === 'opencode' || decision.provider === 'claude')
    ? selectSubscriptionAccount({
        accounts: deps.subscriptionAccounts,
        provider: decision.provider,
        ...(decision.provider === 'opencode'
          ? { pool: opencodePoolForModel(decision.model) ?? 'zen' }
          : {}),
        nowMs: deps.clock.now(),
        cooldownUntil: deps.accountCooldownUntil ?? new Map(),
        sessionTokensByAccount: deps.sessionTokensByAccount ?? {},
      })
    : null;

const accountEnv =
  subscriptionAccount !== null ? accountEnvFor(subscriptionAccount) : undefined;
```

Then replace `openCodeAccount` references with `subscriptionAccount` for:

- `tier-start.accountId` at
  [src/core/work-call.ts:1384](../src/core/work-call.ts:1384).
- `ProviderRequest.accountId/accountEnv` at
  [src/core/work-call.ts:1407](../src/core/work-call.ts:1407).
- `onAccountUsed()` at
  [src/core/work-call.ts:1418](../src/core/work-call.ts:1418).
- ledger record account id at
  [src/core/work-call.ts:1536](../src/core/work-call.ts:1536).
- success/failure finals through the existing `openCodeAccount` spread sites,
  including [src/core/work-call.ts:1712](../src/core/work-call.ts:1712),
  [src/core/work-call.ts:1768](../src/core/work-call.ts:1768),
  [src/core/work-call.ts:1916](../src/core/work-call.ts:1916), and
  [src/core/work-call.ts:2493](../src/core/work-call.ts:2493).

Routing rules:

- Apply Claude account routing only when subscriptions are on, at least one
  Claude account exists, and `decision.provider === 'claude'`.
- If no account is eligible, fall back to the global Claude path with no
  `accountId` and no `accountEnv`.
- OpenCode behavior remains identical via the wrapper and `opencodePoolForModel()`.
- Codex/Grok are deferred. The generic model can store them, but work-call must
  not select them until Slice 3.

Cooldown and ledger:

- Rename `opencodeAccountCooldownUntil` at
  [src/interface/menu.ts:1053](../src/interface/menu.ts:1053) to
  `accountCooldownUntil`, or create an alias in Half B. It remains keyed by
  account id.
- Existing ledger guard already accepts optional non-empty `accountId` at
  [src/infra/jsonl-guards.ts:186](../src/infra/jsonl-guards.ts:186) through
  [src/infra/jsonl-guards.ts:192](../src/infra/jsonl-guards.ts:192). Update the
  comment from OpenCode-only to subscription-account.
- Existing session token accounting already increments by `entry.accountId` at
  [src/interface/menu.ts:1346](../src/interface/menu.ts:1346) and seeds from old
  ledger entries at [src/interface/menu.ts:1370](../src/interface/menu.ts:1370).
  This can stay unchanged.
- Existing cooldown fallback already reads `final.accountId` at
  [src/interface/menu.ts:1644](../src/interface/menu.ts:1644). Rename comments
  from OpenCode-only to subscription-account.

## Tests

Half A tests:

- `subscriptions.test.ts`: existing OpenCode tests pass unchanged. Add tests that
  `readSubscriptions()` accepts legacy OpenCode accounts without `kind`, new
  Claude accounts include `kind: 'oauth-sub'`, and `accountEnvFor()` maps
  Claude/Codex/Grok/OpenCode homes correctly.
- `subscription-account-routing.test.ts`: generic selector filters disabled,
  expired, wrong provider, wrong OpenCode pool, cooling accounts, and preserves
  all-cooling fallback plus stable tiebreakers. Keep existing
  `opencode-account-routing.test.ts` imports working.
- `menu-claude-accounts.test.ts`: injected fake `login` and fake detection create
  one Claude account, update label/expiry/priority/enabled/status, re-auth, and
  delete scoped home.
- macOS guard test: with `platform: 'darwin'` and one existing Claude OAuth
  account, `[c] create` prints the Keychain limitation and does not call login or
  create a directory. With zero existing accounts, first create is allowed.
- Login env test: `runLogin()` passes `CLAUDE_CONFIG_DIR` through both browser
  and code paths and merges it after `loginPersistentEnv()`.
- Detection test: account-scoped Claude detection calls `detectProvider('claude',
  { env: { CLAUDE_CONFIG_DIR: home }, storedCredentialInjection: false })` and
  reads `<home>/.credentials.json`.

Half B tests:

- `claude-adapter.test.ts`: `buildClaudeEnv(reqWithAccountEnv)` includes
  `CLAUDE_CONFIG_DIR` and disables legacy token fallback; absent `accountEnv`
  preserves current behavior.
- `work-call` unit test: with subscriptions on, two Claude accounts, and
  `decision.provider === 'claude'`, selected account id is threaded into
  `ProviderRequest.accountId`, `ProviderRequest.accountEnv.CLAUDE_CONFIG_DIR`,
  `tier-start.accountId`, ledger entry, and final.
- Work-call fallback test: no Claude accounts or no eligible Claude accounts
  means no `accountId` and no `accountEnv`.
- Cooldown test: rate-limit final for one Claude account cools only that account;
  sibling Claude account remains eligible.
- Flag-off byte-identical test: when `subscriptionsEnabled()` is false, menu does
  not read `subscriptions.json`, `[j]` calls the existing single login, deps omit
  account fields, provider request omits `accountId/accountEnv`, and ledger omits
  `accountId`.
- Existing OpenCode tests continue to pass, including OpenCode env injection
  around [test/unit/opencode-account-routing.test.ts:309](../test/unit/opencode-account-routing.test.ts:309).

## Split Build Order

### Half A: model, selector, Claude menu, create, detection

1. Generalize `src/infra/subscriptions.ts` types, helpers, Claude factory, and
   account env resolver while keeping OpenCode factory/output compatible.
2. Add `selectSubscriptionAccount()` and keep `selectOpencodeAccount()` as a thin
   wrapper. No work-call behavior change yet.
3. Extend `runLogin()` opts with `accountEnv` and thread it through the existing
   Claude browser/code login paths.
4. Add `detectSubscriptionAccount()` for Claude using
   `CLAUDE_CONFIG_DIR=<homeDir>`, `refreshClaudeOauthIfNeeded()`,
   `detectProvider()`, and `storedCredentialInjection: false`.
5. Add `src/interface/menu-claude-accounts.ts`, including macOS second-account
   guard, create, edit, re-auth, delete, and status refresh.
6. Gate main menu `[j]` label/dispatch on `subscriptionsEnabled()`. Flag off
   remains the existing single Claude login.

Half A does not route normal Claude work calls through accounts yet.

### Half B: Claude account-aware routing and cooldown

1. Rename or generalize orchestrate deps from OpenCode-only account fields to
   subscription-account fields in `src/core/types.ts`.
2. Change `enrichDepsWithAccounts()` in `src/interface/menu.ts` to pass the mixed
   account list and generic cooldown map, still behind the early flag guard.
3. Change `work-call.ts` account selection to use
   `selectSubscriptionAccount()` for `decision.provider === 'claude'` and retain
   OpenCode pool behavior.
4. Add `accountEnvFor(subscriptionAccount)` to `ProviderRequest`.
5. Add `buildClaudeEnv()` and use it in `src/providers/claude.ts` so
   `req.accountEnv.CLAUDE_CONFIG_DIR` reaches the child process.
6. Generalize account cooldown comments/fields and keep ledger `accountId`
   behavior unchanged.
7. Run the full OpenCode account routing test set plus new Claude routing/env
   tests.

## Deferred

- Codex and Grok account creation/routing.
- Parallel or hedge across accounts.
- Auto/smart account balancing.
- Custom numeric priority weights.
- Native session scoping by account beyond preserving existing behavior. Redteam
  calls this out as a future risk at
  [docs/subscription-management-redteam.md:193](subscription-management-redteam.md:193)
  and design docs at
  [docs/subscription-management-design.md:973](subscription-management-design.md:973).
