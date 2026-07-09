# Subscription Management Red-Team Findings

Status: adversarial review of `docs/subscription-management-design.md`. No source
or test files were edited.

## Evidence Base

Local code reviewed:

- `src/infra/credentials.ts`
- `src/infra/claude-oauth-refresh.ts`
- `src/commands/login.ts`
- `src/providers/detect.ts`
- `src/core/vendor-neutral-route.ts`
- `src/core/route.ts`
- `src/core/capacity-allocator.ts`
- `src/core/cooldown.ts`
- `src/cli.ts`

External references checked:

- OpenAI Codex repo and README: <https://github.com/openai/codex>
- Codex auth storage source: <https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/auth/storage.rs>
- Codex auth/refresh source: <https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/auth.rs>
- OpenCode repo: <https://github.com/anomalyco/opencode>
- OpenCode auth source: <https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/auth/index.ts>
- OpenCode global path source: <https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/global.ts>
- Claude Code macOS issue: <https://github.com/anthropics/claude-code/issues/20553>

The already-verified fact is incorporated as a hard constraint: OAuth home
isolation is platform-dependent. On Linux/Replit, and likely Windows, Claude,
Codex, and Grok credentials are file/config-home based. On macOS, Claude Code
OAuth tokens collide through a shared system Keychain service name that is not
namespaced by `CLAUDE_CONFIG_DIR`.

## MUST-FIX Issues

### 1. Critical: macOS Claude multi-OAuth is not viable with the proposed design

Failure scenario: a macOS user adds `Claude personal` and `Claude work`.
`subscriptions.json` has two accounts and two `CLAUDE_CONFIG_DIR` paths, but
Claude Code stores OAuth in Keychain under a shared service. The second login
silently replaces or shadows the first. myshell routes to account A while Claude
actually uses account B. Receipts, cooldowns, token accounting, and compliance
claims become false.

Recommended design change:

- Mark Claude multi-OAuth unsupported on macOS unless Anthropic fixes the
  Keychain namespace.
- On macOS, allow at most one Claude OAuth account in the account manager.
- Show a hard platform notice before account creation, not after failure.
- Keep account IDs and account-scoped homes for Claude on Linux/Windows only.
- Add a provider/platform capability matrix to the design. Account creation must
  check it before running login.

### 2. Critical: per-account pooling value is unproven because service limits may be per IP, device, org, or anti-abuse bucket

Failure scenario: a user signs into five Claude Max or ChatGPT Pro accounts from
one laptop. The local homes isolate tokens, but the vendor service rate-limits
by IP/device/browser fingerprint/payment family/abuse bucket. myshell fans out
across five accounts, all hit 429s together, and the product promise of pooling
collapses. Worse, myshell interprets correlated 429s as five independent account
cooldowns and keeps retrying siblings that are doomed.

Recommended design change:

- Downgrade "parallel pooling" from guaranteed behavior to "best effort where the
  vendor accounts have independent capacity."
- Add a `sharedLimitSuspected` runtime state per provider family. If two or more
  same-provider accounts hit quota errors within a short window, suppress same-
  provider fanout and surface "shared vendor limit suspected."
- Add explicit receipts: "Claude accounts appear to share a limit from this
  machine; routing will prefer other providers for now."
- Track 429 correlation by provider family and by account. Account cooldown alone
  is not enough.
- Before shipping beyond PoC, run an empirical matrix: 2 accounts, 2 concurrent
  calls, same IP, same provider, on Linux/Windows/macOS.

### 3. Critical: direct OpenCode `auth.json` writes are a schema-ownership and secret-handling trap

Failure scenario: myshell writes `{ "opencode": { "type": "api", "key": "..." } }`
based on today's OpenCode schema. OpenCode changes the `Info` union or provider
ID normalization. The account appears active in myshell's parser but fails at
runtime, or worse, points the key at the wrong gateway/provider. The key sits in
plaintext `auth.json` and myshell now owns a secret lifecycle it said it did not
own.

Evidence:

- OpenCode currently stores auth at `Global.Path.data/auth.json`, where
  `Global.Path.data` comes from XDG data plus `opencode`, not XDG config.
- OpenCode's `Info` schema currently includes `oauth`, `api`, and `wellknown`.
  The `api` variant is `{ type: "api", key, metadata? }`.
- OpenCode's writer uses `Auth.set()` and normalizes provider IDs by stripping
  trailing slashes before writing.

Recommended design change:

- Do not write OpenCode `auth.json` directly in the MVP.
- Prefer `opencode auth login` in an account-scoped XDG data/config home and let
  OpenCode own schema and writes.
- If non-interactive import is required later, implement it behind a compatibility
  probe that verifies `Auth.set()` semantics against the installed OpenCode
  version.
- Communicate that OpenCode API keys are plaintext on disk in OpenCode's auth
  file, protected only by filesystem permissions unless the vendor changes this.
- Store myshell metadata with `0o600`, but do not imply API keys are OS-keychain
  protected.

### 4. High: Codex isolation is not simply "`CODEX_HOME/auth.json`"; keyring mode exists

Failure scenario: myshell assumes Codex is always file-backed. A newer Codex
install or user config enables keyring/auto storage. Auth is stored in system
keyring, not just `CODEX_HOME/auth.json`. If the key is not namespaced correctly,
accounts collide; if myshell detection reads only `auth.json`, it may report
unauthenticated even though Codex can run.

Evidence:

- Codex source defines `AuthCredentialsStoreMode`: `file`, `keyring`, `auto`,
  `ephemeral`.
- File mode uses `CODEX_HOME/auth.json`.
- Keyring mode uses service `"Codex Auth"` and a key derived from a hash of
  `codex_home`, so current upstream appears to namespace keyring credentials by
  home path.
- myshell detection currently reads `resolveCodexAuthPath()` for plan enrichment,
  so it only understands the file path.

Recommended design change:

- Add Codex store-mode detection to account verification. Do not rely on
  `auth.json` existing.
- Treat `codex login status` as the primary auth check and file/keyring reads as
  optional enrichment only.
- Document Codex verdict as "likely isolated when Codex uses file mode or the
  current path-hashed keyring mode; must be reverified on Codex upgrades."
- Add a regression probe: two `CODEX_HOME`s, two logins, `codex login status`
  and model listing under both homes.

### 5. High: token refresh races are not account-aware

Failure scenario: two myshell instances start at the same time for the same
Claude account home. Both read the same refresh token. If Anthropic rotates
refresh tokens and treats reuse as invalid, instance A writes a new token while
instance B uses the old refresh token and marks the account failed. The account
gets cooled or disabled even though one refresh succeeded. With multiple account
homes this race becomes more likely.

Evidence:

- `refreshClaudeOauthIfNeeded()` uses per-credentials-path scratch files
  (`.myshell-bak` and `.myshell-tmp`) but no lock.
- The cooldown marker path is based on `home/.myshell-tools/.claude-refresh-failed`,
  not the account ID. If `home` remains the user home, all Claude accounts can
  share a refresh-failure cooldown.
- `cli.ts` calls one refresh before detection, using the current process env,
  not an account inventory loop.

Recommended design change:

- Add per-account refresh locks around credential refresh.
- Put refresh cooldown markers under the account identity, not only user home.
- Make refresh an account verification step, not a global startup step.
- Never disable on a refresh failure until a subsequent provider auth probe proves
  the credential is unusable.
- For Codex, do not implement myshell refresh; Codex owns refresh and includes
  explicit refresh-token-reuse/account-mismatch error handling upstream.

### 6. High: account-aware routing is deeper than Slice 4 and Slice 5 admit

Failure scenario: Slice 4 chooses `accountId=acct_claude_2`, but Slice 5 has not
threaded account env into provider execution yet. The route receipt says account
2; the spawned `claude` process uses the default home. Or Slice 5 threads env,
but native session state, ledgers, cooldowns, and available models are still
provider-keyed, so a future turn resumes a session under the wrong account.

Evidence:

- `buildDeps()` constructs `providers` from one `EnvironmentStatus` and
  `process.env`.
- `authenticatedProviders`, `availableModels`, and `planInfos` are provider
  keyed in `cli.ts`.
- `vendor-neutral-route.ts` builds candidates from `ProviderId`, not account ID.
- `capacity-allocator.ts` and `cooldown.ts` are provider-keyed.

Recommended design change:

- Combine account-aware routing and account-env execution into one vertical
  slice for a single low-risk provider first.
- Add `accountId` to the execution request before returning account route
  decisions.
- Scope native sessions, conversation continuation hints, cooldowns, receipts,
  and ledgers by account whenever account routing is enabled.

### 7. High: migration can silently adopt the wrong thing

Failure scenario: an existing single-sub user has a global `CLAUDE_CODE_OAUTH_TOKEN`
from old myshell plus a Claude-owned login. Slice 1 auto-adopts both or adopts
the stale token as the synthetic account. Later routing uses a deprecated token
that shadows the real Claude login. Or a user has OpenCode with three credentials
inside one auth file; migration creates one OpenCode account and loses the fact
that Go and Zen may be separate quota pools.

Recommended design change:

- Legacy adoption must preserve behavior exactly: one synthetic legacy account per
  current provider surface, not per guessed secret.
- For Claude, prefer Claude-owned credential over legacy `credentials.json` token;
  if both exist, keep the legacy token out of routing and show a cleanup notice.
- If a CLI is logged in but no myshell account exists, auto-adopt as
  `acct_legacy_<provider>` only under the flag and only as a pointer to the
  current default home. Do not copy or move credentials.
- OpenCode migration must inspect `auth.json` credential keys and available
  models. If multiple relevant credentials exist in one OpenCode home, mark the
  synthetic account as `opencode-legacy-mixed`, not a clean Zen or Go account.
- Do not delete provider homes on account delete unless the account was created
  by myshell and the path is under the managed provider-home root.

### 8. Medium: normalized-load math will hammer fresh high-weight accounts

Failure scenario: an existing normal account has 80k session tokens. A brand-new
High account has 0. `normalizedLoad = tokens / effectiveWeight` sends all traffic
to the new account until it "catches up." If it is high priority this may be
intended, but if it is newly added and unproven it can trigger immediate quota or
trust issues.

Recommended design change:

- Add warm-up behavior for newly added or newly reauthed accounts.
- Seed `sessionTokensByAccount` from provider/account historical ledger where
  possible, or use a short ramp: first N calls are capped regardless of weight.
- Add weighted round-robin or deficit scheduling instead of pure lowest
  normalized load when every account has zero tokens.
- At cold start, use stable hash plus priority buckets, not pure static order, to
  avoid deterministic hammering of the first account.

### 9. Medium: priority UI is under-specified for real capacity and intent

Failure scenario: user sets Low on an expensive Max account expecting it to be
overflow only. The normalized-load router still uses it during cold start because
everything is zero. Or user sets High on an account that is lower plan capacity,
and `detectedCapacityWeight` overrides user intent in a non-obvious way.

Recommended design change:

- Keep Low/Medium/High, but name the semantics precisely:
  - Low: eligible backup, not zero.
  - Medium: normal share.
  - High: primary share.
  - Disabled: never route.
- Add an explicit "overflow only" boolean if users need "use only when siblings
  fail." Do not overload Low for that.
- Show approximate target share after detected capacity is applied.

### 10. Medium: mode x pooling needs governor work before it is implementable

Failure scenario: design says Budget/Balanced/High/Max/Auto control account
pooling, but live policy is three modes with a separate 5-level scaffold that
comments say is not consumed. Account fanout cannot be honestly implemented by
editing only routing order; it must pass through governor call budgets, panel,
hedge, preflight, receipts, and failover logic.

Recommended design change:

- Treat account pooling as a governor feature, not only a router feature.
- Ship single-account-per-turn routing first.
- Add same-provider account hedging only after account IDs are accepted by
  governor, panel, hedge, work-call failover, and ledger.
- Do not expose Budget/Balanced/High/Max account semantics until the 5-level dial
  is live or mapped explicitly to current three-mode presets.

## Provider Isolation, Concurrency, and Rate-Limit Verdicts

| Provider | Login Isolation Verdict | Refresh Isolation Verdict | Model Listing Isolation Verdict | Concurrent Different Homes | Rate-Limit Pooling Verdict | Notes |
|---|---|---|---|---|---|---|
| Claude | Linux/Replit: likely yes with `CLAUDE_CONFIG_DIR`. Windows: likely but must test. macOS: no for multiple OAuth accounts due shared Keychain service. | myshell refresh currently single-env/global-startup, no per-account lock, and cooldown marker can be shared if `home` is not account-scoped. | Likely follows `CLAUDE_CONFIG_DIR` where file-backed; macOS Keychain breaks account identity. | Unknown. Need real CLI stress test for locks/temp/session files. | Unknown; must assume possible shared IP/device/account-family limits. | Design must block macOS multi-Claude and detect correlated 429s. |
| Codex | Likely yes, but not only `auth.json`: upstream supports file, keyring, auto, ephemeral. Current keyring key is path-hashed by `codex_home`, which is good but must be pinned in tests. | Codex owns refresh. Upstream has refresh-token reuse/account-mismatch handling. myshell should not touch tokens. | `codex login status` should follow `CODEX_HOME`; myshell plan enrichment currently only reads file auth. | Unknown. Need stress test for app server/session/global locks. | Unknown; ChatGPT plans may have account limits plus anti-abuse/shared device limits. | Do not claim "auth.json fully inside home" unless Codex store mode is file. |
| Grok | Uncertain. Local code assumes `GROK_HOME`; `loginPersistentEnv()` can set it, but `detectGrokProvider()` itself receives `baseEnv` and only works because `cli.ts` mutates `process.env['GROK_HOME']` on Replit. Windows/Linux need direct verification. | Unknown; myshell does not refresh Grok. | `grok models` should follow `GROK_HOME` if the CLI honors it; unverified. | Unknown. | Unknown; likely anti-abuse/shared IP limits possible. | Highest uncertainty because local code has no file parser and no source-backed verification here. |
| OpenCode | Yes for auth file if `XDG_DATA_HOME` is account-scoped before process start. Auth is in data home, not config home. Also set `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` for cleaner isolation. | OpenCode owns OAuth refresh. API keys do not refresh. | `opencode models` should follow XDG data/config if set before process start. | Moderate risk: OpenCode has global state/cache/tmp paths. `Global.Path.tmp` is `os.tmpdir()/opencode`, not account-scoped. | Depends on underlying provider/gateway. OpenCode Zen/Go gateway limits may be account/key based, but upstream/provider limits can still correlate. | Do not direct-write `auth.json` for MVP; let OpenCode own writes. |

## Token Refresh Race Findings

- Claude refresh is currently designed around one credential path. It accepts
  `env`, `cwd`, `home`, and `credsPath`, so it can be adapted, but `cli.ts` calls
  it once before detection. Multi-account needs an inventory loop.
- The current backup/temp names are per credential path, which helps different
  homes but does not protect same-account concurrent refresh.
- The refresh-failure marker is per `home`, not per credentials path or account.
  In a multi-account design, that can suppress refresh for sibling accounts.
- Codex refresh should remain vendor-owned. Upstream recognizes refresh-token
  reuse and account mismatch errors; myshell should observe failures through CLI
  status, not duplicate refresh logic.
- OpenCode refresh should remain vendor-owned. API-key accounts should not have
  fake expiry unless the user sets one.

## Migration Breakage Risks

- Legacy Claude token fallback can shadow a fresh Claude-owned login if not
  cleared/adopted carefully.
- Auto-adopting logged-in CLIs can create false confidence: a synthetic account
  points at a mutable global home that the user may later change outside myshell.
- OpenCode can hold multiple credentials in one `auth.json`; migrating it as one
  Zen or Go account is lossy.
- Existing ledgers have provider-level usage only. Backfilling per-account load
  is impossible except for synthetic legacy accounts.
- Existing native session state and conversation continuation may not be account
  safe. A resumed session started under one home must not continue under another.
- Deleting an adopted legacy account must not delete `~/.claude`, `~/.codex`,
  `~/.grok`, or the user's normal XDG OpenCode auth directory.
- If the flag is off, no new file should be required for current single-sub users.
  If the flag is on and `subscriptions.json` is corrupt, fall back to legacy
  provider-level behavior rather than strand the user.

## Slice Go/No-Go and Reordering

| Slice | Verdict | Reason | Required Change |
|---|---|---|---|
| 1. Account Store And Migration | No-Go as first behavior slice | Horizontal model first can create false confidence without proving provider isolation, login, detect, route, and execution work end-to-end. Migration also risks adopting wrong legacy state. | Make Slice 1 read-only schema + synthetic in-memory legacy inventory only, or move after vertical PoC. |
| 2. Account-Scoped Login And Detection | No-Go for all providers at once | Provider assumptions are uneven. Claude macOS fails, Codex keyring is nuanced, Grok uncertain, OpenCode direct import risky. | Start with OpenCode account-scoped XDG login/detect only. Add provider capability gates. |
| 3. Provider Management Menus | No-Go before PoC | UI will encode choices before platform/provider truth is proven. | Build minimal hidden/dev command or test harness first; menu after one provider works. |
| 4. Account-Aware Routing, Load, And Cooldown | Partial Go | Pure routing math can be written, but account route decisions without account execution are dangerous. | Combine with execution for one provider in the vertical PoC. |
| 5. Provider Adapter Account Env Execution | Must merge earlier | This is not later plumbing; it is what makes account routing true. | Merge with Slice 4 for the first provider. |
| 6. Account-Aware Panel/Hedge | No-Go until correlated limit detection exists | Same-provider parallelism is the riskiest product promise. | Ship only sequential account failover first. Add fanout after empirical rate-limit tests. |
| 7. Auto/Smart Balancing And Receipts | No-Go until account facts are reliable | Auto can hide bad account choices. Receipts are needed earlier for debugging. | Add minimal receipts in the vertical PoC; defer Auto/Smart balancing. |

Recommended order:

1. Vertical PoC: one provider, one routing path, real account env execution.
2. Provider/platform capability matrix and empirical isolation tests.
3. Read-only account store plus legacy synthetic adoption.
4. Minimal account manager for the proven provider.
5. Sequential account routing/cooldown/failover.
6. Add remaining providers one by one behind capability gates.
7. Only then add same-provider hedge/panel and Auto balancing.

## Smallest Vertical Proof of Concept First

Build OpenCode-only multi-key routing first.

Why OpenCode:

- It avoids OAuth/keychain collisions.
- Auth file location is clear: `$XDG_DATA_HOME/opencode/auth.json`.
- It can be isolated by spawning `opencode` with account-scoped XDG homes.
- It validates the real architecture: account store, account-scoped detection,
  account-scoped `opencode models`, route decision with account ID, provider env
  execution, ledger, and cooldown.

PoC scope:

- Hidden flag only.
- Manually create two OpenCode accounts by running `opencode auth login` twice,
  each with a distinct account-scoped XDG data/config/state/cache home.
- No direct `auth.json` write.
- No panel/hedge.
- Sequential routing only: choose the lower normalized account load for OpenCode
  models, execute with that account's env, record `accountId`.
- On 429, cool only that account; if a sibling succeeds, receipt says failover
  happened.

Success criterion:

- Add a second OpenCode key, run two turns, prove the second turn can execute
  under a different account home and ledger records the actual account used.

This is a better first slice than data-model-first because it cheaply validates
the only claim that matters: myshell can route and execute a real request through
one of multiple isolated provider credentials.

## Over-Engineered or Premature Parts To Cut

- Cut same-provider panel/hedge from MVP. It multiplies quota burn before shared
  limit behavior is understood.
- Cut Auto/Smart account balancing from MVP. Deterministic sequential routing is
  easier to verify and explain.
- Cut direct OpenCode key import from MVP. Use OpenCode's own auth flow.
- Cut expiry editing for API keys from MVP unless users explicitly ask for it.
  It is advisory metadata, not a core architecture proof.
- Cut custom priority numbers from first UI pass. Ship Low/Medium/High/Disabled,
  keep custom weights in config later.
- Cut provider management menus until one provider is proven end-to-end. A hidden
  developer command or test harness is enough for the PoC.
- Cut account-level capability bands for the first PoC. Use whatever `opencode
  models` returns and only prove account identity and execution isolation.

## Executive Summary

Top risk 1: Claude multi-OAuth must be blocked on macOS because Keychain collisions make account identity false.
Top risk 2: same-provider pooling may collapse under shared IP/device/vendor limits; detect correlated 429s before fanout.
Top risk 3: OpenCode direct `auth.json` writes make myshell own schema drift and plaintext secret handling.
Per-IP verdict: unproven for every provider; design must communicate best-effort pooling, not guaranteed pooled capacity.
Codex verdict: likely isolated by `CODEX_HOME`, but keyring/auto storage means "auth.json fully inside home" is false.
Grok verdict: highest uncertainty; `GROK_HOME` must be verified for login, refresh/status, and model listing.
Slice verdict: do not start with horizontal account store plus migration as the first proof.
Recommended first slice: vertical OpenCode PoC with two account-scoped XDG homes, sequential routing, execution, ledger, and cooldown.
