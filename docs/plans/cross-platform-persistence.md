# Cross-Platform Persistence Plan

Date: 2026-06-29

## Executive Summary

`myshell-tools` already has the right instinct on Replit: do not trust an ephemeral home directory. The current implementation is still split between a Replit-aware `defaultStateHome()` path, project-local `.myshell-tools` helpers, and a few direct `os.homedir()` calls. This plan consolidates all myshell-owned persistence behind one path/layout module, moves local machine state to OS-correct roots, keeps cloud IDE state inside the durable workspace, and migrates old state without deletion.

The minimal product decision is: POSIX keeps the legacy `~/.myshell-tools` default unless the user explicitly sets XDG variables; Windows uses `%APPDATA%` for config and `%LOCALAPPDATA%` for state/cache/credentials; Replit/Codespaces/Gitpod anchor all roots to the persistent workspace. This balances correctness with low surprise for current users.

## Sources

| Topic | Source | Design use |
| --- | --- | --- |
| XDG config/state/cache semantics | Freedesktop XDG Base Directory Specification: https://specifications.freedesktop.org/basedir-spec/latest/ | `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`; absolute-path requirement; 0700 create guidance. |
| Windows roaming vs local app data | Microsoft `Environment.SpecialFolder`: https://learn.microsoft.com/en-us/dotnet/api/system.environment.specialfolder | `%APPDATA%` maps to roaming app data; `%LOCALAPPDATA%` maps to non-roaming local app data; user profile root should not be used for app files. |
| Codespaces env and persistence | GitHub Codespaces default env vars: https://docs.github.com/en/codespaces/developing-in-a-codespace/default-environment-variables-for-your-codespace and persistence docs: https://docs.github.com/en/codespaces/developing-in-a-codespace/persisting-environment-variables-and-temporary-files | `CODESPACES=true`; `/workspaces` is persistent across stop/start and rebuild; home is not durable across rebuild. |
| Gitpod env | Gitpod/Ona environment variables: https://ona.com/docs/classic/user/configure/workspaces/environment-variables | `GITPOD_WORKSPACE_ID`, `GITPOD_WORKSPACE_URL`, `GITPOD_REPO_ROOT`. |
| Replit/DATA lesson | `docs/research/data-remote.md` | Borrow workspace persistence; do not borrow symlinked provider homes, `~/.ssh`, broad bypass aliases, or background updater behavior. |

## Current State Inventory

| Area | Current path behavior | Module(s) | Status |
| --- | --- | --- | --- |
| Config | `<defaultStateHome()>/.myshell-tools/config.json` | `src/infra/config.ts` | Uses Replit-aware fallback, but config and state are not separated. |
| Conversations | `<defaultStateHome()>/.myshell-tools/conversations/` | `src/infra/conversations.ts`, `conversation-store.ts` | Uses `defaultStateHome()`. |
| Conversation archive | `<defaultStateHome()>/.myshell-tools/.session-archive/` | `src/infra/session-mirror.ts` | Uses `defaultStateHome()`. |
| Goals | `<defaultStateHome()>/.myshell-tools/goals/` | `src/infra/goal-store.ts` | Uses `defaultStateHome()`. |
| Rules | `<defaultStateHome()>/.myshell-tools/rules/` | `src/infra/rules-store.ts` | Uses `defaultStateHome()`. |
| User memory | `<defaultStateHome()>/.myshell-tools/memory/` | `src/infra/user-memory-store.ts`, `taste-ledger.ts` | Uses `defaultStateHome()`. |
| Myshell credentials | `<defaultStateHome()>/.myshell-tools/credentials.json` | `src/infra/credentials.ts` | Uses `defaultStateHome()`, mode `0600`; Windows ACL is only best-effort via chmod. |
| Subscriptions/account homes | `<defaultStateHome()>/.myshell-tools/subscriptions.json`, provider homes below it | `src/infra/subscriptions.ts` | Uses `defaultStateHome()`, mode `0600` for subscriptions. |
| Update cache | `<defaultStateHome()>/.myshell-tools/update-check.json` | `src/infra/update-check.ts` | Uses `defaultStateHome()`, should become cache root. |
| Health state probe | `<defaultStateHome()>/.myshell-tools` | `src/infra/health.ts` | Uses `defaultStateHome()`; ledger probe separately uses cwd. |
| Ledger | `<cwd>/.myshell-tools/ledger.jsonl` | `src/infra/paths.ts`, `ledger.ts` | Bypasses `defaultStateHome()`; local repo pollution risk; only accidentally good on Replit. |
| Session log | `<cwd>/.myshell-tools/sessions/current.jsonl` | `src/infra/paths.ts`, `session.ts` | Bypasses `defaultStateHome()`. |
| Intent versions | `<cwd>/.myshell-tools/intent-versions.jsonl` | `src/infra/paths.ts`, `intent-store.ts` | Bypasses `defaultStateHome()`. |
| Eval results | `<cwd>/.myshell-tools/eval-results.jsonl` | `src/infra/paths.ts`, `eval-store.ts` | Bypasses `defaultStateHome()`. |
| Command audit | `<cwd>/.myshell-tools/command-audit.jsonl` | `src/infra/command-audit.ts` | Bypasses `defaultStateHome()`. |
| Evidence snapshots | Caller-provided `homeDir`, currently often `cwd` | `src/infra/evidence-store.ts`, `evidence-sink.ts`, `cli.ts` | Bypasses central layout at call sites. |
| Provider native sessions | Provider homes (`~/.claude`, `~/.codex`, env overrides) | `src/providers/native-sessions.ts` | Not myshell-owned state; direct `homedir()` is acceptable only if env override is centralized. |
| Provider detection | Provider homes (`~/.claude`, `~/.codex`, XDG data, etc.) | `src/providers/detect.ts`, `claude-oauth-refresh.ts`, `model-capability-port.ts` | Mostly provider-owned state; should use provider-home resolver for consistency. |
| Tab-completion dynamic memory | Direct `os.homedir()` in one memory-store construction | `src/interface/menu-completion.ts` | Bypass: myshell-owned memory must use central layout/default store. |

## Design Decisions

| Decision | Chosen behavior | Reason |
| --- | --- | --- |
| POSIX default | Keep legacy `~/.myshell-tools` when no XDG variable is set. | Avoids breaking existing users and keeps migration optional. Still honors XDG when users opt into XDG. |
| POSIX with XDG | Config: `$XDG_CONFIG_HOME/myshell-tools`; state/secrets: `$XDG_STATE_HOME/myshell-tools`; cache: `$XDG_CACHE_HOME/myshell-tools`. If one var is set, use it for that category only. | Matches XDG category semantics and keeps explicit user policy authoritative. Ignore relative XDG paths. |
| macOS | Same POSIX rule for this release. | The repo already behaves POSIX-style. Native `~/Library/Application Support` can be a future major-version move; mixing it now creates avoidable churn. |
| Windows config | `%APPDATA%\myshell-tools\config.json`, with fallback to `%USERPROFILE%\AppData\Roaming\myshell-tools`. | Config can roam; Microsoft documents ApplicationData as roaming user app data. |
| Windows state/secrets/cache | `%LOCALAPPDATA%\myshell-tools\...`, with fallback to `%USERPROFILE%\AppData\Local\myshell-tools`. | Conversations, goals, ledgers, credentials, account homes, and caches should not roam or sync by default. Do not rely on `HOME`. |
| Cloud IDEs | All categories resolve to `<persistent workspace>/.myshell-tools/...`. | Durability beats platform purity in ephemeral-container IDEs; this is the `data-remote` lesson implemented through myshell paths, not symlinks. |
| Project-scoped records | Move local machine project records under `stateRoot/projects/<projectKey>/...`; cloud can still use workspace `.myshell-tools/projects/<projectKey>/...`. | Keeps ledgers/audits out of repos on normal machines while preserving per-project grouping. |
| Provider credentials | Use vendor CLI env overrides to point provider homes at myshell-managed provider-home dirs only when necessary or account-scoped. Never symlink `~/.ssh`, `~/.claude`, `~/.codex`, or raw home dirs. | Reduces credential blast radius and avoids `data-remote`'s raw-home symlink risk. |

## Proposed Layout

### Local Linux/macOS, No XDG Variables

Legacy-compatible default:

```text
~/.myshell-tools/
  config.json
  credentials.json
  conversations/
  goals/
  memory/
  rules/
  subscriptions.json
  provider-homes/
  projects/<projectKey>/
    ledger.jsonl
    sessions/current.jsonl
    intent-versions.jsonl
    eval-results.jsonl
    command-audit.jsonl
    evidence/
  update-check.json
```

### Linux/macOS With XDG Variables

Only absolute XDG values count. Relative values are ignored.

```text
$XDG_CONFIG_HOME/myshell-tools/config.json
$XDG_STATE_HOME/myshell-tools/
  credentials.json
  conversations/
  goals/
  memory/
  rules/
  subscriptions.json
  provider-homes/
  projects/<projectKey>/
$XDG_CACHE_HOME/myshell-tools/update-check.json
```

If only `XDG_CONFIG_HOME` is set, only config moves. If only `XDG_STATE_HOME` is set, state/secrets move. This avoids surprising partial-environment users.

### Windows

```text
%APPDATA%\myshell-tools\config.json
%LOCALAPPDATA%\myshell-tools\
  credentials.json
  conversations\
  goals\
  memory\
  rules\
  subscriptions.json
  provider-homes\
  projects\<projectKey>\
  cache\update-check.json
```

Fallbacks, in order:

1. Config: `APPDATA`, then `USERPROFILE\AppData\Roaming`, then `os.homedir()\AppData\Roaming`.
2. State/cache/secrets: `LOCALAPPDATA`, then `USERPROFILE\AppData\Local`, then `os.homedir()\AppData\Local`.
3. Never use `HOME` on Windows for default resolution. Tests must inject `USERPROFILE`, not just `HOME`.

### Replit, Codespaces, Gitpod, Similar Cloud IDEs

```text
<persistentWorkspace>/.myshell-tools/
  config.json
  credentials.json
  conversations/
  goals/
  memory/
  rules/
  subscriptions.json
  provider-homes/
  projects/<projectKey>/
  cache/update-check.json
```

Workspace resolution rules:

| Environment | Detection | Workspace root |
| --- | --- | --- |
| Replit | `REPL_ID`, `REPLIT_DEV_DOMAIN`, `REPL_SLUG`, or `REPL_OWNER` | `cwd`, unless a future explicit `MYSHELL_STATE_ROOT` is set. |
| Codespaces | `CODESPACES === 'true'` or `CODESPACE_NAME` | `GITHUB_WORKSPACE` if absolute; else nearest `/workspaces/<repo>` ancestor; else `cwd`. |
| Gitpod | `GITPOD_WORKSPACE_ID` or `GITPOD_WORKSPACE_URL` | `GITPOD_REPO_ROOT` if absolute; else `cwd`. |
| Generic cloud/container opt-in | `MYSHELL_CLOUD_WORKSPACE` absolute path | That path. |

The resolver must not assume every SSH/container is ephemeral. SSH/headless affects login UX, not state placement, unless a known durable workspace signal exists or the user sets `MYSHELL_STATE_ROOT`.

## New Module API

Replace `src/infra/state-dir.ts` and `src/infra/paths.ts` with a single layout authority, likely `src/infra/state-layout.ts`. Keep compatibility exports during migration.

```ts
export type StateCategory = 'config' | 'state' | 'cache';

export type StateLocationKind =
  | 'cloud-workspace'
  | 'windows-known-folder'
  | 'xdg'
  | 'legacy-posix';

export interface StateContext {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
  readonly homeDir: string;
}

export interface ProjectStateDirs {
  readonly projectKey: string;
  readonly root: string;
  readonly ledgerFile: string;
  readonly sessionFile: string;
  readonly sessionsDir: string;
  readonly intentVersionsFile: string;
  readonly evalResultsFile: string;
  readonly commandAuditFile: string;
  readonly evidenceDir: string;
}

export interface AppStateLayout {
  readonly kind: StateLocationKind;
  readonly appName: 'myshell-tools';
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly legacyRoot: string;
  readonly cloud: null | {
    readonly provider: 'replit' | 'codespaces' | 'gitpod' | 'generic';
    readonly workspaceRoot: string;
  };
  readonly paths: {
    readonly configFile: string;
    readonly credentialsFile: string;
    readonly conversationsDir: string;
    readonly conversationArchiveDir: string;
    readonly goalsDir: string;
    readonly memoryDir: string;
    readonly rulesDir: string;
    readonly subscriptionsFile: string;
    readonly providerHomesDir: string;
    readonly updateCacheFile: string;
    readonly migrationDir: string;
  };
}

export function resolveStateLayout(ctx: StateContext): AppStateLayout;
export function defaultStateContext(): StateContext;
export function defaultStateLayout(): AppStateLayout;
export function projectStateDirs(layout: AppStateLayout, cwd: string): ProjectStateDirs;

export function isCloudIde(env: NodeJS.ProcessEnv): boolean;
export function isReplit(env: NodeJS.ProcessEnv): boolean; // compatibility export

// Compatibility shims for old call sites. Mark deprecated in comments.
export function defaultStateHome(): string; // returns defaultStateLayout().stateRoot parent-compatible only where safe
export function resolveStateHome(env: NodeJS.ProcessEnv, cwd: string, home: string): string;
```

Notes:

- The main resolver is pure and never throws.
- `defaultStateContext()` is the only place allowed to read `process.env`, `process.cwd()`, `process.platform`, and `os.homedir()`.
- Tests should prefer `resolveStateLayout(ctx)` with injected `homeDir`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, and `cwd`.
- Old `homeDir` options should be migrated to `layout?: AppStateLayout` or `stateRoot?: string` only as a short-term compatibility bridge.

## Consumer Changes

| Module | Change |
| --- | --- |
| `config.ts` | Read/write `layout.paths.configFile`. Keep `loadConfig(layoutOrRoot?)` compatibility only for tests until call sites move. |
| `conversations.ts` | Use `layout.paths.conversationsDir`. |
| `session-mirror.ts` | Use `layout.paths.conversationArchiveDir`. |
| `goal-store.ts` | Use `layout.paths.goalsDir`. |
| `rules-store.ts` | Use `layout.paths.rulesDir`. |
| `user-memory-store.ts`, `taste-ledger.ts` | Use `layout.paths.memoryDir`; remove direct `os.homedir()` construction in `menu-completion.ts`. |
| `credentials.ts` | Use `layout.paths.credentialsFile`; move provider persistent-home helpers to a provider-home resolver based on `layout.paths.providerHomesDir`. |
| `subscriptions.ts` | Use `layout.paths.subscriptionsFile` and `layout.paths.providerHomesDir`. |
| `update-check.ts` | Use `layout.paths.updateCacheFile`. |
| `health.ts`, `doctor.ts` | Report config/state/cache/project dirs from `AppStateLayout`; replace separate state/ledger probes with layout-aware probes. |
| `paths.ts` | Either delete after migration or reduce to wrappers around `projectStateDirs()`. No raw `join(cwd, '.myshell-tools')` in production code. |
| `ledger.ts`, `session.ts`, `intent-store.ts`, `eval-store.ts`, `command-audit.ts` | Accept `ProjectStateDirs` or `AppStateLayout + cwd`; write under `projects/<projectKey>/...`. |
| `evidence-store.ts`, `evidence-sink.ts`, `cli.ts` | Pass `projectStateDirs(layout, cwd).evidenceDir` or a project root, not raw `cwd`. |
| `providers/native-sessions.ts`, `detect.ts`, `claude-oauth-refresh.ts` | Keep provider-owned path logic, but consume a shared provider-home resolver for cloud/account overrides. |

## Migration Plan

Add `src/infra/state-migration.ts` with an explicit runner:

```ts
export interface MigrationPlan {
  readonly fromRoots: readonly string[];
  readonly to: AppStateLayout;
  readonly actions: readonly MigrationAction[];
}

export function planStateMigration(layout: AppStateLayout, ctx: StateContext): MigrationPlan;
export async function runStateMigration(plan: MigrationPlan): Promise<MigrationReport>;
```

Run migration once at CLI startup before loading config, but keep it fail-soft. A migration failure must not prevent the tool from starting; it should surface a doctor/health warning with the report path.

### Candidate Old Locations

| Source | When considered |
| --- | --- |
| `<homeDir>/.myshell-tools` | Always, unless equal to new root. This captures old POSIX, old Windows under `USERPROFILE`, and old Replit before workspace redirect. |
| `<cwd>/.myshell-tools` | Always, unless equal to cloud/new root. This captures old ledger/session/eval/intent/command-audit. |
| `process.env.HOME/.myshell-tools` on Windows | Only if `HOME` is set and differs from `USERPROFILE`; read-only candidate for users/tests that accidentally wrote there. |
| `.replit-tools/.{claude,codex,grok}-persistent` | Cloud provider-home migration only; never copy `~/.ssh`. |

### Algorithm

1. Resolve `AppStateLayout` and candidate old roots.
2. Create `layout.paths.migrationDir` with mode `0700`.
3. Write a migration manifest draft with timestamp, source roots, destination roots, and per-item status. Update it after each completed action.
4. Copy, never move. Do not delete old files.
5. For each file:
   - If destination is missing: copy bytes, preserve relative path, set mode `0600` for secrets/private JSON/JSONL where appropriate.
   - If destination exists and bytes are identical: mark `already-present`.
   - If destination exists and bytes differ: keep destination; copy source to `migration-conflicts/<relative>.<stamp>` with mode `0600`; record conflict.
6. For grow-only JSONL files:
   - `ledger.jsonl`, `command-audit.jsonl`, `intent-versions.jsonl`, `eval-results.jsonl`, `memory/taste.jsonl`: merge by exact-line hash, preserving destination order then adding unique old lines.
   - `sessions/current.jsonl`: do not merge into an active current session. Copy old current session to `projects/<projectKey>/sessions/imported-<stamp>.jsonl`.
7. For indexed stores:
   - `conversations/`, `goals/`, `rules/`, `memory/facts/`: copy missing files and preserve conflicts. Let each store's existing corrupt-index recovery rebuild indexes later.
8. For credentials:
   - If destination is missing: copy `credentials.json` with `0600`.
   - If both exist: never merge token-bearing JSON automatically. Preserve old as a conflict file with `0600` and report.
9. For provider homes:
   - Copy only provider-specific dirs managed by myshell/data-remote (`.replit-tools/.claude-persistent`, `.codex-persistent`, `.grok-persistent`) into `provider-homes/default/<provider>` when the destination is missing.
   - Do not copy `.ssh-persistent`, `~/.ssh`, arbitrary `~/.config`, or provider dirs not explicitly requested by an account flow.
10. Write a final manifest status: `complete`, `partial`, or `conflicts`.

### Idempotency and Recovery

- Re-running migration reads the manifest and filesystem state, but filesystem checks are authoritative.
- Partial copies are safe because each file copy writes to a temp file and renames into place.
- Corrupt JSON is copied as bytes; store modules handle parsing/recovery.
- Conflicts are never overwritten.
- Old roots may optionally receive a non-secret `.migrated-to` pointer, but only when they are writable. This is diagnostic only.

## Security Requirements

| Risk | Requirement |
| --- | --- |
| Secrets in git | If `stateRoot` is inside a git worktree, ensure `.gitignore` contains `.myshell-tools/`; if it cannot be written, show a startup health error. |
| Overbroad DATA-style persistence | Never persist `~/.ssh`; never symlink provider CLI homes; never install aliases with permission/sandbox bypass flags; never run background CLI auto-updates. |
| Credential file modes | Create app state dirs with `0700` where possible. Write `credentials.json`, subscriptions, provider auth homes, goals/rules/memory items, evidence, and token-bearing backups with `0600`. |
| Windows ACLs | Do not rely on `HOME`; place secrets under `%LOCALAPPDATA%`, which inherits the user's profile ACL. `chmod(0o600)` remains best-effort. Add a follow-up task to investigate a no-shell Windows ACL hardening helper if needed. |
| Synced/shared locations | Avoid `%APPDATA%` for credentials and state. On cloud workspaces, warn that `.myshell-tools` contains secrets and must stay gitignored. |
| Secret logs | Migration reports must list paths and status, not token contents or JSON snippets. |
| Provider OAuth refresh | Continue to refresh provider-owned credentials in place only when a stable vendor file exists; never copy refresh tokens into myshell's own credential JSON. |

## Test Plan

| Test group | Cases |
| --- | --- |
| Pure layout matrix | Linux no XDG; Linux absolute XDG; relative XDG ignored; macOS same; Windows with APPDATA/LOCALAPPDATA; Windows with only USERPROFILE; Windows HOME set differently; Replit; Codespaces with `GITHUB_WORKSPACE`; Codespaces `/workspaces/<repo>` fallback; Gitpod with `GITPOD_REPO_ROOT`; generic `MYSHELL_CLOUD_WORKSPACE`. |
| Consumer wiring | Every store writes to injected layout temp dirs; no test must mutate the real user profile. Add an arch test that production modules do not call `os.homedir()` except `state-layout.ts` and provider-owned path resolvers. |
| Migration | Missing destination copies; identical destination skips; conflicting files preserved; JSONL merge dedupes exact lines; credentials conflict does not merge; corrupt index copied and later recovered by store; partial manifest resumes. |
| Security | POSIX modes for dirs/files; `.gitignore` insertion in cloud/repo-root state; no `.ssh` copy; report redacts content; Windows path resolution ignores `HOME`. |
| Replit/cloud | Replit env anchors to `cwd`; Codespaces anchors to persistent workspace; Gitpod uses `GITPOD_REPO_ROOT`; provider login env dirs resolve under `.myshell-tools/provider-homes`, not `.replit-tools`. |
| Regression | Existing `loadConfig(tempHome)` tests pass through compatibility shim; legacy `~/.myshell-tools` on POSIX no-XDG remains the same; `doctor` reports actual resolved dirs. |

## Ordered Worker Task List

1. Add `src/infra/state-layout.ts` with the pure API above and compatibility exports from `state-dir.ts`.
2. Add unit tests for the full layout matrix, especially Windows `USERPROFILE` vs `HOME`.
3. Add `projectStateDirs()` and update `paths.ts` to delegate to it.
4. Migrate app-global stores to accept/use `AppStateLayout` paths.
5. Migrate project-scoped stores (`ledger`, `session`, `intent-store`, `eval-store`, `command-audit`, `evidence`) to `projects/<projectKey>`.
6. Replace the `menu-completion.ts` direct `os.homedir()` store construction with central layout/default store.
7. Add provider-home resolver and move Replit provider persistence off `.replit-tools` for new writes; keep read-only fallback for migration.
8. Implement `state-migration.ts` with manifest, copy/merge/conflict behavior.
9. Wire fail-soft migration before first config load in `cli.ts`.
10. Update health/doctor to display config/state/cache/project roots and migration warnings.
11. Update docs/README references that currently say `~/.myshell-tools` or `<cwd>/.myshell-tools`.
12. Run unit, integration, TypeScript, ESLint, and a Windows-path-specific test subset.

## Open Questions for the Human

| Question | Default recommendation |
| --- | --- |
| Should macOS use `~/Library/Application Support` in a future major release? | Not in this slice; keep POSIX/XDG behavior for compatibility. |
| Should local ledgers remain visible in the repo for users who like project-local artifacts? | Default to app state with project keys; add an opt-in later if requested. |
| Should migration run silently or ask first? | Run copy-only migration silently and report conflicts; because old files are never deleted, risk is low. |
| Should Windows ACL hardening shell out to `icacls`? | Not initially. Use `%LOCALAPPDATA%` and best-effort chmod; revisit if threat model requires explicit ACL rewrites. |
| Should provider credential homes be migrated automatically from `.replit-tools`? | Yes for known provider dirs only, no for `.ssh` and arbitrary home/config dirs. |

## Non-Goals

- No raw `~/.ssh` persistence.
- No provider CLI symlink farm.
- No broad `--dangerously-*` aliases or bypass flags.
- No background auto-update of provider CLIs.
- No remote/mobile control surface in this feature.
- No deletion of legacy state during migration.
