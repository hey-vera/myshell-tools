# Subscription Management System Design

Status: design only. This document audits current code and proposes a flag-gated
multi-account subscription system. No `.ts` / `.tsx` source or tests were changed.

## Part 1 - Current-State Audit

### 1. Credentials Model

Current myshell credential storage is not a multi-account store.

- `src/infra/credentials.ts` documents a single JSON file at
  `<homeDir>/.myshell-tools/credentials.json` and says its current shape is
  `{ claudeOauthToken?: string }` (`src/infra/credentials.ts:4-6`).
- The actual `Credentials` interface has only `claudeOauthToken?` and
  `claudeTokenCapturedAt?` (`src/infra/credentials.ts:29-32`).
- Parsing accepts only those two keys (`src/infra/credentials.ts:130-144`).
- `saveClaudeToken()` overwrites those single fields in one object, preserving
  unknown keys but not adding any account list (`src/infra/credentials.ts:332-351`).
- `loadClaudeToken()` returns one token string or null (`src/infra/credentials.ts:174-180`).
- `applyStoredCredentials()` injects that one token into one env var,
  `CLAUDE_CODE_OAUTH_TOKEN` (`src/infra/credentials.ts:419-431`).
- The file is under the default state home, where Replit resolves to `cwd` and
  other systems resolve to the user's home (`src/infra/state-dir.ts:41-47`).
  Therefore the default path is:
  - Replit: `<cwd>/.myshell-tools/credentials.json`
  - Elsewhere: `<home>/.myshell-tools/credentials.json`
- Security today is file-permission based: the comments require `0o600` for
  credentials (`src/infra/credentials.ts:14-16`) and `saveClaudeToken()` writes
  with `atomicWrite(..., 0o600)` plus best-effort chmod (`src/infra/credentials.ts:349-357`).

Verdict: myshell stores at most one legacy Claude token. Claude, Codex, Grok,
and OpenCode primary auth state is otherwise vendor-CLI-owned and per provider,
not per account.

### 2. Auth Flows Already Implemented

`src/commands/login.ts` is the main auth orchestration seam. It delegates to
vendor CLIs and verifies with detection; it does not store raw secrets for
normal provider login.

Implemented login commands:

- Claude:
  - Browser/default: `claude /login` (`src/commands/login.ts:57-59`).
  - Code/headless: `claude /login` with guidance to choose a Claude subscription
    account and exit back to myshell (`src/commands/login.ts:76-92`).
  - The module explicitly says Claude persists its own credential and myshell
    captures nothing (`src/commands/login.ts:18-24`).
  - After successful Claude login, myshell clears the legacy stored token so it
    cannot shadow Claude's own login (`src/commands/login.ts:284-294`).
- Codex / GPT:
  - Browser/default: `codex login` (`src/commands/login.ts:57-60`).
  - Code/headless: `codex login --device-auth` (`src/commands/login.ts:94-101`).
- OpenCode:
  - Browser/default and code path both use `opencode auth login`
    (`src/commands/login.ts:60-63`, `src/commands/login.ts:103-114`).
  - This opens OpenCode's provider picker; OpenCode stores credentials itself
    (`src/commands/login.ts:27-33`, `src/commands/login.ts:105-113`).
  - There is no direct myshell "paste an SK and choose zen/go" flow today.
- Grok:
  - Browser/default: `grok login --oauth` (`src/commands/login.ts:64-65`).
  - Code/headless: `grok login --device-auth` (`src/commands/login.ts:116-125`).

Reusability:

- `runLogin(out, providerArg, opts)` is public and accepts a provider id
  (`src/commands/login.ts:309-319`), so it is reusable as "run provider login".
- It is not yet reusable as "create account N" because the child env points each
  vendor CLI at its normal credential home. The login-time Replit resolver creates
  one provider home per provider (`src/infra/credentials.ts:266-309`), not one per
  account.
- Provider adapters also spawn against process/global provider homes:
  - Claude builds env from `process.env` plus Claude fallback credentials
    (`src/providers/claude.ts:254-273`).
  - Codex builds env from `process.env` plus `replitPersistentEnv`
    (`src/providers/codex.ts:188-203`).
  - OpenCode builds env from `process.env` plus `replitPersistentEnv`
    (`src/providers/opencode.ts:174-190`).

Refresh/expiry:

- Claude has a dedicated refresh module that parses `claudeAiOauth` with
  `accessToken`, `refreshToken`, and `expiresAt` (`src/infra/claude-oauth-refresh.ts:54-57`,
  `src/infra/claude-oauth-refresh.ts:99-109`).
- `refreshClaudeOauthIfNeeded()` refreshes Claude credentials in place, backs up
  the file, writes `0o600`, and records a refresh-failure cooldown
  (`src/infra/claude-oauth-refresh.ts:296-382`).
- Codex plan detection decodes local JWT claims but does not refresh tokens itself
  (`src/providers/detect.ts:295-321`).
- OpenCode detects credential type and optional OAuth plan claims but does not
  refresh OpenCode credentials itself (`src/providers/detect.ts:765-790`).
- Grok auth detection reads CLI output; no refresh handling is present in the
  audited files (`src/providers/detect.ts:972-1035`).

### 3. Auth Detection

Detection is provider-level, not account-level.

- `ProviderStatus` has exactly one `authenticated` boolean and one `plan` string
  per provider id (`src/providers/detect.ts:44-52`).
- `EnvironmentStatus` has one `ProviderStatus` for each of `claude`, `codex`,
  `opencode`, and `grok` (`src/providers/detect.ts:54-61`).
- Claude detection runs `claude --version` and `claude auth status`, then returns
  a single `ProviderStatus` (`src/providers/detect.ts:503-595`).
- Codex detection runs `codex --version`, `codex login status`, then optionally
  reads one `auth.json` for plan enrichment (`src/providers/detect.ts:614-674`).
- OpenCode detection reads one OpenCode `auth.json` and treats it as authenticated
  when it has at least one recognized credential (`type:"oauth"` or `type:"api"`)
  (`src/providers/detect.ts:687-710`, `src/providers/detect.ts:835-898`).
- `opencodeCredentialCount()` can count multiple entries inside OpenCode's
  `auth.json`, but that count is collapsed to one provider-level authenticated
  boolean (`src/providers/detect.ts:723-737`).
- Grok detection runs `grok --version` and `grok models`, returning one
  provider-level status (`src/providers/detect.ts:972-1035`).
- Codex auth path resolution points to one `auth.json`, selected by `CODEX_HOME`,
  Replit persistent home, or `~/.codex` (`src/providers/detect.ts:333-349`).
- OpenCode auth path resolution points to one `$XDG_DATA_HOME/opencode/auth.json`
  or `~/.local/share/opencode/auth.json` (`src/providers/detect.ts:799-805`).

### 4. Routing And Load Spread

Current routing is provider/pool level. It does not select among multiple accounts
of the same provider.

- Legacy `route()` accepts `available: ProviderId[]`, `authenticatedProviders:
  ProviderId[]`, and `preferredOrder: ProviderId[]` (`src/core/route.ts:157-165`).
- The route algorithm chooses the first provider in the preference order, then
  chooses a model within that provider (`src/core/route.ts:179-216`,
  `src/core/route.ts:478-492`).
- Vendor-neutral routing builds candidates from `ProviderId` plus model, not
  account id (`src/core/vendor-neutral-route.ts:29-54`,
  `src/core/vendor-neutral-route.ts:240-290`).
- Vendor-neutral tiebreaking accounts for cooled pools, lower pool load, and
  session-hash rotation over `poolId`, provider, and model
  (`src/core/vendor-neutral-route.ts:154-200`).
- `RoutingCandidate` contains `provider`, `poolId`, and `model`; no account field
  exists (`src/core/route-types.ts:44-52`).
- `QuotaPoolId` currently distinguishes `claude`, `codex`, `grok`,
  `opencode-go`, `opencode-zen-or-free`, and `opencode-unknown-default`
  (`src/core/route-types.ts:16-23`).
- OpenCode pool identity is derived from model prefix:
  `opencode-go/` maps to `opencode-go`; `opencode/` maps to
  `opencode-zen-or-free` (`src/core/route-types.ts:294-317`).
- Capacity weights are per provider, not per account:
  `CapacityWeight` contains `provider`, `tier`, and `weight`
  (`src/core/capacity-allocator.ts:35-40`).
- `deriveBaselineOrder()` sorts provider ids by weight (`src/core/capacity-allocator.ts:97-121`).
- `deriveLiveProviderOrder()` normalizes session token load by provider weight
  and moves cooling providers last (`src/core/capacity-allocator.ts:243-293`).
- The menu wires this with provider-level session consumption and provider-level
  cooldowns (`src/interface/menu.ts:2273-2295`).

Verdict: OpenCode Go vs Zen already proves the router can reason about quota
pools below provider level, but only as model-prefix-derived pools. It cannot
represent N Claude accounts, N Codex accounts, N Grok accounts, or N OpenCode
keys as independently selectable identities.

### 5. Quota / Cooldown

Cooldown is per provider, not per account.

- The cooldown module says the caller stores `Map<ProviderId, number>` keyed by
  provider (`src/core/cooldown.ts:27-30`).
- `availableAfterCooldown()` accepts `authed: ProviderId[]` and
  `cooldownUntil: ReadonlyMap<ProviderId, number>` (`src/core/cooldown.ts:49-53`).
- The menu creates `providerCooldownUntil = new Map<ProviderId, number>()`
  (`src/interface/menu.ts:1044-1049`).
- The menu filters authenticated providers through that map before routing
  (`src/interface/menu.ts:2179-2192`).
- A completed turn records rate-limit cooldowns for providers and sets
  `providerCooldownUntil.set(id, cooldownExpiry(now))`
  (`src/interface/menu.ts:1603-1629`).
- Work-call failover computes remaining providers at the current tier, filters by
  authenticated providers, and queues a failover pool (`src/core/work-call.ts:1755-1769`,
  `src/core/work-call.ts:1849-1850`).

Verdict: a 429 sidelines the whole provider for a few minutes. If the user had
two Claude subscriptions, the current model cannot cool only the exhausted Claude
account while letting the sibling continue.

### 6. Parallelism

The system has provider-level parallelism, not account-level parallelism.

- Panel runs a concurrent panel of signed-in providers (`src/core/ensemble.ts:4-8`).
- `PanelPlan.candidates` is `readonly ProviderId[]` and requires distinct
  providers (`src/core/ensemble.ts:80-90`, `src/core/ensemble.ts:101-113`).
- `planPanel()` slices `authenticatedProviders` to choose candidates
  (`src/core/ensemble.ts:211-219`), and the vendor-neutral branch still maps one
  score per provider (`src/core/ensemble.ts:165-188`).
- Hedge starts a primary branch and may start a speculative branch in parallel
  (`src/core/hedge.ts:4-9`, `src/core/hedge.ts:1046-1178`).
- Hedge routes each branch with `ProviderId` candidates (`src/core/hedge.ts:244-290`).

Verdict: panel and hedge can fan out across providers. They cannot fan out across
multiple accounts of the same provider because there is no account identity in
the plan, route decision, provider request, ledger, or provider adapter env.

### 7. Modes And Judgment / Smart System

Current user-facing mode is a 3-mode policy with Auto as "unset config.mode";
there is also newer 5-level scaffolding that is not yet live.

- `AppConfig.mode` is optional; absent means Auto in the menu and one-shot paths
  (`src/infra/config.ts:49-52`, `src/interface/menu-settings.ts:78-84`).
- Current `Mode` is `cost-saver | balanced | quality-first`
  (`src/core/policy.ts:100`).
- User labels are Efficient, Balanced, Max (`src/core/policy.ts:107-111`).
- `POLICY_PRESETS` maps:
  - Efficient/cost-saver: no manager auto-open, no hedge, no panel
    (`src/core/policy.ts:376-404`).
  - Balanced: `DEFAULT_POLICY`, with adaptive flagship, hedge on, panel on hard
    turns, max panel providers 2 (`src/core/policy.ts:11-79`, `src/core/policy.ts:406`).
  - Max/quality-first: manager eligible, hedge on, hard-turn panel, max panel
    providers 3 (`src/core/policy.ts:408-435`).
- Auto mode chooses the strongest observed plan kind across authenticated
  providers: any Max -> quality-first, any Pro -> balanced, no observed plans ->
  balanced, all Free -> cost-saver (`src/core/policy.ts:239-267`).
- Auto Max 5x tuning narrows panel width to 2 when every Max signal is 5x
  (`src/core/policy.ts:338-374`).
- Smart routing is a separate toggle; config comments say it invokes a cheap
  worker classifier only for ambiguous turns (`src/infra/config.ts:113-122`).
- The performance governor maps mode to turn-call budgets:
  Max = 3, Balanced = 2, Efficient = 1 (`src/core/governor.ts:320-339`).
- Governor shrinks budget under quota pressure (`src/core/governor.ts:373-381`).
- Governor admits panels only for non-frugal mode, cross-vendor availability,
  budget >= 3, and decide/risky/investigate shapes (`src/core/governor.ts:556-565`).
- The config has a 5-level dial scaffold for Budget / Balanced / High / Max /
  Auto, but the comments state it is not yet consumed by live orchestrate/route
  (`src/infra/config.ts:493-503`).
- Auto Brain is default-on via experimental defaults and fuses byproduct route
  hints, deterministic classify floor, and taste memory bias, clamped to the
  user's capacity ceiling (`src/infra/config.ts:518-533`).

Verdict: account-balancing autonomy belongs in the same capacity/governor/router
layer that already resolves mode, pressure, panel, hedge, and Auto Brain. Today
that layer sees only providers and provider pools.

## Part 2 - Design

### A. Multi-Account Credential Model

Introduce a new account inventory as the source of truth for myshell-managed
accounts:

Path:

```text
<stateHome>/.myshell-tools/subscriptions.json
```

On Replit, `stateHome` remains the workspace; elsewhere it remains home, matching
existing state resolution (`src/infra/state-dir.ts:41-47`).

Schema:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "acct_01J...",
      "provider": "claude",
      "pool": "claude",
      "label": "Claude Max personal",
      "kind": "oauth-sub",
      "secretRef": {
        "storage": "vendor-home",
        "path": ".myshell-tools/provider-homes/claude/acct_01J..."
      },
      "oauth": {
        "expiresAt": "2026-07-28T14:00:00.000Z",
        "refreshable": true
      },
      "priorityWeight": 100,
      "enabled": true,
      "createdAt": "2026-06-28T00:00:00.000Z",
      "lastUsedAt": null,
      "lastVerifiedAt": null,
      "lastStatus": "unknown"
    }
  ]
}
```

Provider and pool:

```ts
type AccountProvider = 'claude' | 'codex' | 'grok' | 'opencode';
type AccountPool =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'opencode-zen'
  | 'opencode-go';
type AccountKind = 'oauth-sub' | 'api-key';
```

Rules:

- Claude, Codex/GPT, and Grok accounts are `kind: "oauth-sub"`.
- OpenCode accounts are `kind: "api-key"` and must choose `pool:
  "opencode-zen"` or `pool: "opencode-go"` at creation.
- Stable `id` is the routing identity. It never changes when the label, priority,
  expiry, status, or secret rotates.
- `label` is user-facing and defaults to a provider-specific sequence:
  `Claude 1`, `Claude 2`, `Codex 1`, `OpenCode Zen 1`.
- `priorityWeight` is an integer, default `100`, range `0..1000`.
- `enabled=false` excludes from routing but preserves credentials and history.
- `expiresAt` is optional. For OAuth, use token expiry if reliably known; otherwise
  null and keep using provider verification. For user-entered OpenCode keys,
  expiry is user-managed.
- `lastUsedAt` updates only after a run actually starts.
- `lastStatus` is non-secret display cache only: `active | expired | cooling |
  disabled | auth-failed | unknown`.

Secret handling:

- Do not log secret fields or serialize them into the normal ledger, receipts, or
  prompt context.
- Prefer vendor credential homes over raw token storage for OAuth. Create one
  isolated vendor home per account:
  - Claude: set `CLAUDE_CONFIG_DIR` to
    `.myshell-tools/provider-homes/claude/<accountId>`.
  - Codex: set `CODEX_HOME` to
    `.myshell-tools/provider-homes/codex/<accountId>`.
  - Grok: set `GROK_HOME` to
    `.myshell-tools/provider-homes/grok/<accountId>`.
  - OpenCode: set `XDG_CONFIG_HOME` and `XDG_DATA_HOME` to
    `.myshell-tools/provider-homes/opencode/<accountId>/{config,data}`.
- Store OpenCode API keys through OpenCode's own auth file when possible, because
  current detection already treats OpenCode-owned `auth.json` as the secure source
  (`src/providers/detect.ts:687-710`).
- VERIFY: if direct OpenCode key insertion is not supported or safe through a
  documented CLI/API, fall back to `opencode auth login` in the account-scoped
  XDG home and let OpenCode write its own secret file.
- All myshell-owned metadata files use atomic writes and mode `0o600`, following
  the existing credential pattern (`src/infra/credentials.ts:349-357`).
- Directory mode should be `0o700`.
- VERIFY: best cross-platform at-rest secret storage. On macOS/Windows/Linux,
  consider OS keychain integration for raw API keys if myshell ever stores them
  directly instead of delegating to vendor CLIs.

Migration:

1. Add a flag, e.g. `MYSHELL_SUBSCRIPTIONS_V1=1` or
   `experimentalSubscriptions: true`.
2. On first enabled load:
   - Create `subscriptions.json` if missing.
   - Detect existing provider-level auth exactly as today.
   - For each authenticated provider, create one synthetic account:
     `acct_legacy_<provider>` with `priorityWeight: 100`, `enabled: true`,
     `secretRef.storage: "legacy-provider-home"`.
   - Do not move credentials in slice 1. The legacy account points at the current
     default provider home and preserves behavior.
3. In a later migration, offer "isolate this account" to copy/reauth into an
   account-scoped vendor home.
4. If the flag is off, all current single-sub users keep the current path and
   behavior.
5. Keep the old `credentials.json` Claude token fallback until the current
   deprecation path is complete. It should import as a disabled or legacy Claude
   account only when no Claude-owned credential exists.

### B. Per-Provider Management Menu

Main control panel change:

```text
--- Auth
[j] Manage Claude accounts
[k] Manage Codex/GPT accounts
[o] Manage OpenCode accounts
[p] Manage Grok accounts
```

Existing single-key auth actions already live in the Auth section
(`src/interface/menu-render.ts:154-169`), so this is a label and dispatch
extension rather than a new navigation model.

Provider screen pattern:

```text
Claude Accounts

  #  label                 priority  expiry       status
  1  Claude Max personal   100       2026-07-28   active
  2  Claude work           50        -            cooling 03:12
  3  Claude backup         25        expired      disabled

  [c] create auth
  [e] edit auth
  [r] re-auth selected/expired
  [b] back
```

Codex/GPT:

```text
Codex/GPT Accounts

  #  label                 priority  expiry       status
  1  ChatGPT Pro           100       -            active
  2  Team workspace        75        -            active

  [c] create auth
  [e] edit auth
  [r] re-auth selected/expired
  [b] back
```

Grok:

```text
Grok Accounts

  #  label                 priority  expiry       status
  1  SuperGrok personal    100       -            active

  [c] create auth
  [e] edit auth
  [r] re-auth selected/expired
  [b] back
```

OpenCode:

```text
OpenCode Accounts

  #  label                 pool   priority  expiry       status
  1  Zen primary           zen    100       2026-12-31   active
  2  Go monthly            go     75        -            active
  3  Zen backup            zen    25        expired      disabled

  [c] create auth
  [e] edit auth
  [r] replace key
  [b] back
```

OpenCode create auth:

```text
Create OpenCode Account

  [z] OpenCode Zen key
  [g] OpenCode Go key
  [b] back

Choice:
```

Then:

```text
Paste SK for OpenCode Zen

  Input is hidden. The key is never printed or logged.
  Press Enter when done, or Esc to cancel.

SK:
```

Edit submenu:

```text
Edit Account: Claude Max personal

  provider: Claude
  id: acct_01J...
  status: active
  priority: 100
  expiry: 2026-07-28
  enabled: yes

  [l] label
  [w] priority weight
  [x] set/clear expiry
  [t] toggle enabled
  [r] re-auth / replace secret
  [d] delete
  [b] back
```

Delete confirmation:

```text
Delete Claude Max personal?

  This removes the account from myshell routing and deletes its account-scoped
  credential home. Conversation history and usage ledger remain.

  [y] delete
  [n] keep
```

Implementation notes:

- `c` for Claude/Codex/Grok runs the existing `runLogin()` provider flow, but
  with account-scoped env instead of global env.
- `c` for OpenCode creates an account-scoped OpenCode home and either:
  - safely writes/imports the key through a verified OpenCode-supported path, or
  - runs `opencode auth login` in that account home and guides the user to paste
    the key into OpenCode itself.
- After create/re-auth, run provider detection against that account env and update
  account status.
- Menus should use `readMenuKey()` style, matching Settings single-key behavior
  (`src/interface/menu-settings.ts:67-119`, `src/interface/menu-settings.ts:290-320`).

### C. Priority Model

Critique of editable percentages:

- Percentages create ambiguity: should they sum to 100 per provider, per pool,
  or globally across all accounts?
- They are brittle when adding or deleting accounts. Adding a second Claude
  account forces the user to renormalize the first.
- They do not compose cleanly with real capacity, cooldown, and mode. A 50 percent
  Claude Free account should not equal a 50 percent Claude Max account unless the
  user explicitly wants that.
- They make disabled/expired/cooling accounts awkward: the visible percentages no
  longer sum to 100 when an account is temporarily unavailable.

Recommendation: relative integer weights.

UI language:

- Show "priority" as a simple number, default `100`.
- Explain in helper text only when editing: "Higher numbers are used more often.
  200 gets about twice the traffic of 100 while both have headroom."
- Offer presets:
  - `25` overflow
  - `50` low
  - `100` normal
  - `200` primary
  - custom `0..1000`

Math:

Each route candidate gets an effective account weight:

```text
effectiveWeight =
  account.priorityWeight
  * detectedCapacityWeight
  * modeAccountSpreadFactor
```

Where:

- `priorityWeight` is user intent.
- `detectedCapacityWeight` reuses current capacity classification where possible,
  currently provider/plan based (`src/core/capacity-allocator.ts:42-95`).
- `modeAccountSpreadFactor` is normally 1, but Auto/Smart may adjust within the
  user's limits when load, latency, or recent failures indicate better headroom.

Selection:

- Replace `ProviderId` routing inventory with `AccountRouteCandidate`:

```ts
interface AccountRouteCandidate {
  accountId: string;
  provider: ProviderId;
  poolId: QuotaPoolId;
  model: string;
  priorityWeight: number;
  capacityWeight: number;
  effectiveWeight: number;
}
```

- Derive live order by normalized account load:

```text
normalizedLoad = sessionTokensByAccount[accountId] / effectiveWeight
```

- Choose the lowest normalized load among candidates within the same capability
  band, after filtering disabled, expired, and hard-cooling accounts.
- Cooldown is a hard exclusion when at least one eligible sibling remains. If all
  candidates are cooling, fall back to the least-recently-cooled candidate rather
  than strand the user, matching the current never-strand rule
  (`src/core/cooldown.ts:39-59`).
- Existing provider-level `deriveLiveProviderOrder()` becomes a compatibility
  adapter over accounts: group accounts by provider only for old call sites.

Example:

```text
Claude A weight 200, used 40k tokens -> normalized 200
Claude B weight 100, used  5k tokens -> normalized 50

Next Claude-capable route chooses B until the ratio approaches 2:1.
```

Why this is best:

- No sum-to-100 constraint.
- Adding accounts does not mutate existing accounts.
- It composes with actual plan capacity and cooldown.
- The UI remains simple.

### D. Expiry

Expiry semantics:

- `expiresAt` is advisory but enforced once set.
- At route time, exclude expired accounts.
- Expired means disabled for routing, not deleted.
- Status row shows `expired` and offers `[r] re-auth` or `[x] set/clear expiry`.
- Warn 14 days before expiry in provider account screens and a compact main-menu
  banner when an account that is enabled and used recently is near expiry.
- Re-auth clears auth-failed status and updates `expiresAt` if the provider
  exposes it.
- If an OAuth refresh succeeds, update `expiresAt`; if refresh fails, leave the
  account disabled only when the credential is actually unusable. A transient
  refresh failure should mark `auth-failed`/refresh-cooling, not delete.

Long-term robustness:

- Treat missing expiry as "unknown, verify through provider detection", not as
  expired.
- Track `lastVerifiedAt` separately so the UI can distinguish "unknown" from
  "known active".
- Never delete automatically on expiry.

### E. Mode x Pooling Interplay

Map the owner's names to current and future mode layers:

- Budget: current Efficient / `cost-saver`.
- Balanced: current `balanced`.
- High: new middle-high 5-level profile from level dial scaffolding.
- Max: current `quality-first`.
- Auto / Smart: no explicit `config.mode`; plan and task signals choose posture.

Recommended behavior:

Budget:

- Use one account per turn by default.
- Follow user priority literally through normalized load.
- No account-level panel or hedge unless explicitly forced.
- Fail over to another account only after recoverable error or rate limit.
- Cooldown is strict: a capped account steps aside while siblings run.

Balanced:

- Single primary account for ordinary turns.
- Failover across accounts of same provider before escalating to a different
  provider when capability is equal and the sibling has headroom.
- Existing hard-turn hedge/panel behavior remains provider-level unless the new
  subscription flag enables account-level expansion.
- Respect priority strongly.

High:

- Use account pools more actively for hard/substantial turns.
- Permit hedging across two accounts when:
  - accounts are distinct,
  - the task is high-risk, slow, or likely to escalate,
  - effective budget has room,
  - priorities do not mark the second account as overflow-only.
- Prefer provider diversity first for judgment; prefer same-provider sibling
  parallelism for latency/headroom.

Max:

- Highest permitted fanout.
- Existing max panel width 3 maps to account-aware candidate count, but preserve
  diversity rules for judgment panels:
  - For independent judgment, choose distinct providers first.
  - If fewer than needed providers exist, fill remaining slots with distinct
    accounts only when the task benefits from parallel throughput rather than
    model diversity.
- Can run multiple same-provider accounts in parallel for throughput-heavy work
  or hedged execution.

Auto / Smart:

- Use current auto plan classification as the initial posture
  (`src/core/policy.ts:239-267`).
- Then let governor and Auto Brain adjust account usage within a hard envelope:
  - user weights are hints, not absolute quotas;
  - disabled/expired accounts are hard exclusions;
  - Budget-like behavior under pressure;
  - High/Max-like pooling on hard turns with headroom.
- `smartRoute` remains task-tier classification, not account balancing
  (`src/infra/config.ts:113-122`). Account balancing should be a new router input
  so smart routing can feed it task shape but not own secret/account state.
- Governor owns extra calls because it already maps mode to call budget
  (`src/core/governor.ts:320-339`) and pressure to reduced budget
  (`src/core/governor.ts:373-381`).

### F. Routing Integration

Add a vendor-agnostic account layer below provider detection and above route
execution.

New concepts:

```ts
type AccountId = string;

interface AccountInventory {
  accounts: readonly SubscriptionAccount[];
  statuses: ReadonlyMap<AccountId, AccountRuntimeStatus>;
}

interface AccountRuntimeStatus {
  accountId: AccountId;
  provider: ProviderId;
  poolId: QuotaPoolId;
  authenticated: boolean;
  enabled: boolean;
  expired: boolean;
  coolingUntil?: number;
  plan?: string | null;
  availableModels: readonly string[];
}
```

Provider adapter execution:

- Extend `ProviderRequest` or provider run context with optional `accountId`.
- Resolve `accountId` to an account-scoped env before spawning the CLI.
- Keep provider adapter implementations vendor-agnostic at the port boundary:
  the account env resolver is injected, not hardcoded throughout route logic.

Routing:

1. Build `AccountRouteCandidate[]` from active accounts.
2. Expand each account into available models.
3. Derive `poolId`:
   - Claude/Codex/Grok: account-specific pool id should be distinct internally,
     e.g. `acct:<accountId>`, while preserving provider family for display.
   - OpenCode: include both account and declared pool:
     `acct:<accountId>:opencode-zen` or `acct:<accountId>:opencode-go`.
4. Apply hard filters:
   - enabled
   - not expired
   - authenticated
   - model supports hard requirements
   - not cooling unless all siblings are cooling
5. Score capability exactly as vendor-neutral routing does today.
6. Within comparable capability bands, select by normalized account load over
   effective weight.
7. Return route decision:

```ts
interface AccountRouteDecision extends RouteDecision {
  accountId: AccountId;
  poolId: string;
}
```

Cooldown:

- Replace `Map<ProviderId, number>` with `Map<AccountId, number>` for account
  cooldowns.
- Keep a derived provider-level cooldown view for existing receipts until all
  receipts are account-aware.
- On 429/rate-limit:
  - mark only the account that ran;
  - fail over to sibling accounts first if capability and mode allow;
  - then other providers;
  - then cooled fallback if all are cooling.

Ledger:

- Add optional account fields behind the flag:

```ts
accountId?: string;
accountLabel?: string;
poolId?: string;
```

- Do not store secrets.
- Use ledger account data for `sessionTokensByAccount`, replacing current
  provider-level session consumption.

Parallelism:

- Panel planning should accept account candidates, not only provider ids.
- Judgment panels should enforce provider diversity first. Same-provider accounts
  are not independent vendor minds.
- Throughput panels and hedges may use same-provider distinct accounts when:
  - mode permits;
  - account priorities allow;
  - no account is expired/disabled/cooling.

Backward compatibility:

- When no `subscriptions.json` exists or the flag is off, synthesize one account
  per authenticated provider in memory and preserve current `ProviderId` routing.

### G. Onboarding

Discovery paths:

- First-run unauthenticated CTA remains, but points to management:

```text
Not signed in yet - press [j] Claude, [k] Codex, [o] OpenCode, or [p] Grok to add an account
```

- After the first account exists, provider rows say "Manage ... accounts" rather
  than "Login ...".
- After creating account 1, success screen offers:

```text
Claude account added.

  [a] add another Claude account
  [m] manage priorities
  [b] back
```

- When the router sees only one account for an active provider, keep UI quiet.
  When the user adds account 2, show the priority helper once.
- Settings can include:

```text
[g] Subscription accounts: 4 active
```

but the fastest path should stay the provider keys on the main panel.

## Part 3 - Phased Flag-Gated Build Plan

### Slice 1 - Account Store And Migration

Flag: `experimentalSubscriptions` / `MYSHELL_SUBSCRIPTIONS_V1`.

Changes:

- Add `subscriptions.json` schema, loader, writer, validator, and migration.
- Synthesize legacy accounts from current provider detection.
- Add account metadata tests: parse, corrupt-file fallback, migration,
  permissions, unknown-key preservation.

Reuse:

- `defaultStateHome()` from `state-dir`.
- `atomicWrite()` and credential permission patterns.
- Current provider detection as the source for legacy account status.

Risk:

- Low if read-only migration is used first.
- Must not move or delete any existing vendor credential files.

Backward compatibility:

- Flag off: no behavior change.
- Flag on with no account store: one legacy account per authenticated provider.

### Slice 2 - Account-Scoped Login And Detection

Changes:

- Add account env resolver for Claude, Codex, Grok, and OpenCode.
- Run existing `runLogin()` flows with account-scoped env.
- Add account-scoped `detectAccount()` that delegates to existing provider
  detection using the account env.
- Implement OpenCode create flow with zen/go pool selection.

Reuse:

- `runLogin()` command definitions and guidance.
- `loginPersistentEnv()` concepts, but parameterized by account.
- `detectProvider()` parsing and plan enrichment.

Tests:

- Unit-test env resolution.
- Inject fake login/detect functions in menu tests.
- Verify secrets are never printed in paste flow.

Risk:

- Vendor CLIs may not all respect scoped homes equally. VERIFY with real CLIs.
- Direct OpenCode key insertion needs verification.

Backward compatibility:

- Existing login keys still work as "manage/create account" wrappers.

### Slice 3 - Provider Management Menus

Changes:

- Add provider account list screens and edit submenu.
- Create, re-auth, enable/disable, edit label, edit priority, set/clear expiry,
  delete.
- Add status rendering for active/expired/cooling/disabled/auth-failed.

Reuse:

- `readMenuKey()` and Settings menu patterns.
- Existing main Auth section.

Tests:

- Snapshot-ish pure render tests for menus.
- Interaction tests using injected key reader and fake account store.

Risk:

- Accidentally making account management too chatty. Keep rows dense and actions
  single-key.

Backward compatibility:

- Users with one legacy account see one row and can keep using it without edits.

### Slice 4 - Account-Aware Routing, Load, And Cooldown

Changes:

- Add account route candidates and account route decision.
- Add account-level cooldown map.
- Add account-level session token consumption.
- Feed priority weights into normalized-load routing.
- Keep provider-level route adapter for old paths.

Reuse:

- `vendor-neutral-route()` scoring and hard filters.
- `deriveLiveProviderOrder()` math, generalized to account ids.
- `resolveCooldownPools()` idea, but account id becomes the cooldown key.

Tests:

- Account weights route proportionally.
- A rate-limited account is skipped while sibling account runs.
- Expired/disabled accounts are excluded.
- All-cooling fallback does not strand.
- OpenCode zen/go pools stay separate.

Risk:

- This is the first behavior-changing slice. Keep flag off by default until canary.

Backward compatibility:

- Legacy account synthesis makes one-account routing identical.

### Slice 5 - Provider Adapter Account Env Execution

Changes:

- Thread `accountId` into `ProviderRequest` or execution context.
- Resolve account env immediately before spawn.
- Record `accountId` and `poolId` in ledger behind flag.

Reuse:

- Existing provider adapters and spawn logic.
- Existing Replit persistent env as fallback for legacy accounts.

Tests:

- Fake provider captures env for each account.
- Same provider with two accounts gets different homes.
- Ledger records account id without secret material.

Risk:

- Native sessions and account envs can interact badly if session ids are reused
  across accounts. Scope native session state by account id.

Backward compatibility:

- No `accountId` means current env path.

### Slice 6 - Account-Aware Panel/Hedge

Changes:

- Extend panel/hedge planners to consume account candidates.
- Add diversity policy:
  - judgment: providers first;
  - throughput/latency: accounts allowed.
- Add mode-specific fanout caps.

Reuse:

- Current `planPanel()` and `planHedge()` gates.
- Governor `turnCallBudget` and panel permission.

Tests:

- Budget mode never parallelizes accounts automatically.
- Max can hedge across two accounts.
- Judgment panel does not treat two Claude accounts as two vendors when another
  provider is available.

Risk:

- Quota burn if fanout is too eager. Let governor own call budgets.

Backward compatibility:

- Existing provider-level panel remains when only one account per provider exists.

### Slice 7 - Auto/Smart Balancing And Receipts

Changes:

- Feed account pool status into Auto Brain/governor as non-secret runtime facts.
- Add concise receipts: account label, pool, cooldown, failover reason.
- Add first-touch helper for priorities.

Reuse:

- `buildToolStateContext()` for non-secret subscription inventory.
- Evidence receipt cooldown display, generalized from provider to account.

Tests:

- Receipts never include tokens/API keys.
- Auto under pressure reduces fanout.
- Priority is a hint in Auto, hard exclusions still respected.

Risk:

- Too much UI noise. Default receipts should show provider/pool labels only when
  useful, not every hidden routing detail.

## Risks

- Vendor account isolation may vary by CLI. Codex/Claude/Grok/OpenCode homes must
  be verified before moving beyond legacy account synthesis.
- OpenCode API key handling is the sharpest security area. Prefer OpenCode-owned
  storage over myshell raw-key storage unless a secure local secret backend is
  implemented.
- Same-provider parallelism is not the same as independent judgment. The router
  must distinguish throughput from adjudication.
- Native sessions, learned routing, account ids, and provider homes must be keyed
  consistently or history may cross accounts.
- Existing ledgers lack account ids. Migration can only infer provider-level
  historical load for legacy accounts.
- UX can become cluttered for users with one subscription. Keep account menus
  discoverable but quiet until the user adds account 2.

## VERIFY List

- VERIFY provider-specific OAuth home isolation:
  - Claude: `CLAUDE_CONFIG_DIR` fully isolates OAuth login, refresh, and sessions.
  - Codex: `CODEX_HOME` fully isolates ChatGPT OAuth login and `auth.json`.
  - Grok: `GROK_HOME` fully isolates OAuth login and `grok models`.
  - OpenCode: `XDG_CONFIG_HOME` / `XDG_DATA_HOME` fully isolate auth and models.
- VERIFY OpenCode key import:
  - Is there a supported non-interactive `opencode` command for adding an API key?
  - Can myshell safely create `auth.json` entries, or must OpenCode own writes?
  - Exact provider ids for OpenCode Zen vs Go.
- VERIFY secure local secret storage best practice for cross-platform Node:
  - OS keychain library maturity.
  - fallback behavior for headless Linux/Replit.
  - backup/export story.
- VERIFY current provider OAuth token expiry semantics:
  - Claude `expiresAt`/refresh behavior across account-scoped homes.
  - Codex token refresh ownership and expiry fields.
  - Grok token expiry and refresh behavior.
- VERIFY whether same-provider concurrent CLI runs against distinct homes are safe
  under each vendor's rate-limit and local lock behavior.
