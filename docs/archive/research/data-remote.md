# Research: `npx data-remote` / DATA Tools

Date: 2026-06-29

## Executive Take

- `data-remote` is not, in the published artifact I inspected, a phone/web remote-control tunnel for Claude Code. It is a Replit bootstrap/persistence tool for Claude Code and Codex CLI.
- Its strongest idea is practical: Replit wipes most of `$HOME` on restart, so DATA Tools moves agent state into `/home/runner/workspace/.replit-tools/`, symlinks ephemeral homes back to it, and starts a session picker on shell launch.
- The package also does risky things: it persists OAuth/refresh tokens and SSH keys, rewrites `.replit`, writes `.config/bashrc`, stores very long history, auto-updates Claude/Codex in the background, and launches Claude/Codex aliases with broad bypass flags.
- For `myshell-tools`, the overlap is not "remote access" so much as "cloud IDE survival": persistent provider homes, session continuity, Replit shell autoload, and headless login.
- `myshell-tools` already has major adjacent pieces: multi-provider orchestration, conversation storage, native session continuity, Replit autoload work, OAuth/login handling, account isolation, command gates, and provider-neutral routing.
- Recommendation: partially incorporate the good persistence/session-management ideas, but do not clone the tool. If adding remote/mobile control, build it as a first-class, authenticated `myshell serve` feature rather than shell aliases plus bypass flags.

## Verified Facts

### Package Identity

Source: npm registry metadata and published tarball.

- Package name: `data-remote`.
- Latest version verified: `1.2.44`.
- Published package description: "DATA Tools - One command to set up Claude Code and Codex CLI on Replit with full persistence".
- Author in registry/package: `stevemoraco`.
- License: MIT.
- Node engine: `>=16.0.0`.
- Binary: `data-remote` -> `index.js`.
- Repository/homepage: `https://github.com/stevemoraco/DATAtools`.
- Keywords: `replit`, `claude`, `codex`, `claude-code`, `persistence`, `session`, `cli`.
- Latest publish time in registry metadata: `2026-05-28T06:30:41.286Z`.
- Weekly downloads from npm downloads API for `2026-06-22` through `2026-06-28`: `55`.
- Published tarball contains 7 files: `index.js`, `package.json`, `README.md`, `install.sh`, and three scripts under `scripts/`.

Sources:

- `https://registry.npmjs.org/data-remote`
- `https://registry.npmjs.org/data-remote/latest`
- `https://api.npmjs.org/downloads/point/last-week/data-remote`
- `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`
- `https://github.com/stevemoraco/DATAtools`

### README Positioning

The published README describes DATA Tools as a one-command Replit setup for Claude Code and Codex CLI with persistence and token refresh. The README's problem statement is that Replit containers wipe files outside `/home/runner/workspace/`, including installed CLIs, conversations, auth tokens, and shell history. It says the installer will install Claude Code and Codex if missing, preserve existing config, set up persistence, refresh OAuth tokens, and launch a session picker.

Important naming inconsistency: the README quickstart says `npx -y replit-tools`, while the package actually inspected is `data-remote` and its executable is `data-remote`. The helper script `setup-claude-code.sh` sets `PACKAGE_NAME="data-remote"`, so the published package appears to be the current npm name while docs still carry `replit-tools` wording.

Sources:

- Published tarball README: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`
- GitHub README rendering: `https://github.com/stevemoraco/DATAtools`

## What Running `npx data-remote` Actually Does

Verified from the published `index.js`; it does not parse `process.argv`, so the binary exposes no first-class subcommands or flags.

Step by step:

1. Requires a Replit-like workspace. It exits if `/home/runner/workspace` does not exist.
2. Prints a DATA Tools banner and checks npm for updates using `npm view data-remote version`.
3. Defines persistent locations under `/home/runner/workspace/.replit-tools/`:
   - `.claude-persistent/`
   - `.codex-persistent/`
   - `.claude-sessions/`
   - `.persistent-home/`
   - `.claude-versions/`
   - `.logs/`
   - `scripts/`
   - `.ssh-persistent/`
4. Detects Claude config env vars: `CLAUDE_CONFIG_DIR`, `CLAUDE_WORKSPACE_DIR`, `CLAUDE_DATA_DIR`, `CLAUDE_HOME`.
5. Detects Codex config env vars: `CODEX_HOME`, `CODEX_CONFIG_DIR`, `CODEX_DATA_DIR`.
6. Creates the persistent directories.
7. Migrates old DATA Tools locations into `.replit-tools/` if present and if custom config dirs are not being used.
8. Installs Claude Code if missing via `curl -fsSL https://claude.ai/install.sh | bash`.
9. Installs Codex CLI if missing via `npm i -g @openai/codex`.
10. Symlinks ephemeral home paths into persistent workspace storage:
    - `~/.claude` -> Claude persistent dir
    - `~/.codex` -> Codex persistent dir
    - `~/.ssh` -> `.replit-tools/.ssh-persistent`
    - `~/.local/share/claude/versions` -> `.replit-tools/.claude-versions`
    - `~/.local/bin/claude` -> latest persisted Claude binary
11. Copies three helper scripts into `.replit-tools/scripts/`.
12. Writes `/home/runner/workspace/.config/bashrc`.
13. Updates `.replit` with an `onBoot` line that sources `setup-claude-code.sh`.
14. Updates `.gitignore` to ignore `.replit-tools/`.
15. Sets process env for Claude/Codex paths.
16. Checks Claude auth status and warns if login is needed.
17. Spawns an interactive bash shell using the generated `.config/bashrc`, which then sources the setup and session-manager scripts.

Sources:

- `index.js` in tarball: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`
- GitHub source index: `https://github.com/stevemoraco/DATAtools/blob/main/index.js`

## Commands, Aliases, and Flags

### `data-remote` CLI

Verified: `index.js` has no `process.argv` references, so `data-remote` itself has no meaningful subcommands or flags in version `1.2.44`. `npx data-remote --help` would still run the installer flow because args are ignored.

### Generated aliases

The generated shell startup config and session manager create aliases/functions after install.

README-advertised aliases:

- `cr`: continue last Claude session.
- `claude-resume`: same general purpose as `cr`.
- `claude-new`: start new Claude session.
- `claude-pick`: Claude's built-in picker.
- `cm` / `claude-menu`: show the session manager.
- `l` / `claude-login`: login to Claude.

Additional aliases verified in `claude-session-manager.sh`:

- `j`: `claude /login --dangerously-skip-permissions`.
- `k`: `codex login --device-auth`.
- `codex-new`: starts Codex with `--dangerously-bypass-approvals-and-sandbox`.
- `codex-resume`: resumes Codex with `--dangerously-bypass-approvals-and-sandbox resume`.

Session manager menu choices verified in script:

- Number keys: resume recent Claude/Codex session.
- `c`: continue the terminal's last session.
- `r`: pick from full recent session list.
- `n`: new Claude session.
- `m`: new Codex session.
- `j`: Claude login.
- `k`: Codex login.
- `s`: skip to shell.

Helper script flags:

- `setup-claude-code.sh --refresh`: forces Claude detection/update refresh.
- `claude-auth-refresh.sh --status`: token status.
- `claude-auth-refresh.sh --force`: force token refresh.

Sources:

- Published README and scripts: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`
- GitHub README/source: `https://github.com/stevemoraco/DATAtools`

## How It Works Internally

### Persistence Strategy

The mechanism is simple and effective:

- Treat `/home/runner/workspace` as the only durable filesystem.
- Move Claude, Codex, shell history, Claude binaries, session metadata, logs, and SSH material under `.replit-tools/`.
- Symlink standard CLI locations back to that durable store.
- Re-run repair/setup code on both container boot and shell start.

This is explicitly Replit-targeted. The binary hard-codes `WORKSPACE = '/home/runner/workspace'` and exits elsewhere.

Sources:

- `index.js` and `setup-claude-code.sh`: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`

### Startup Hooks

DATA Tools uses three startup layers:

- `.replit` `onBoot` sources `.replit-tools/scripts/setup-claude-code.sh`.
- `.config/bashrc` sets env vars, sources setup, configures bash history, loads the session manager, and auto-shows the prompt unless `CLAUDE_NO_PROMPT=true`.
- Installed scripts perform repair, detection, auth refresh, and session picking.

Source:

- README "How It Works" and `index.js`: `https://github.com/stevemoraco/DATAtools`

### Session Picker

The session manager is a Bash script with embedded Node snippets. It:

- Reads Claude history from `~/.claude/history.jsonl` and project files under `~/.claude/projects/-home-runner-workspace`.
- Reads Codex sessions under `~/.codex/sessions`.
- Builds a combined recent-session list with IDs, tool name, timestamps, message counts, and prompt snippets.
- Stores per-terminal last-session state under `.replit-tools/.claude-sessions/<terminal>.json`.
- Resumes Claude via `claude -r <session> --dangerously-skip-permissions`.
- Resumes Codex via `codex --dangerously-bypass-approvals-and-sandbox resume <session>`.

Source:

- `scripts/claude-session-manager.sh`: `https://github.com/stevemoraco/DATAtools/tree/main/scripts`

### Token Refresh

`claude-auth-refresh.sh` reads Claude OAuth credentials from the Claude persistent directory, checks expiry, and posts refresh-token requests to Anthropic's OAuth token endpoint. Setup runs this on shell start if a credentials file exists and no recent refresh-failure marker blocks it. The README says refresh happens when less than 2 hours remain.

Sources:

- `scripts/claude-auth-refresh.sh`: `https://github.com/stevemoraco/DATAtools/tree/main/scripts`
- README token-refresh section: `https://github.com/stevemoraco/DATAtools`

### Configuration and Archive Mirror

The setup script creates/reads `.replit-tools/config.json` with defaults:

- `recentWindowHours: 48`
- `persistenceDays: 365250`
- `autoUpdateHours: 24`
- `mirror.enabled: true`

It writes Claude `cleanupPeriodDays` and Codex `[history]` retention config. If mirroring is enabled, it copies Claude/Codex session data into `.replit-tools/.session-archive/` in an append/growth-only style, so deletion from provider stores does not necessarily delete archive copies.

Source:

- `scripts/setup-claude-code.sh`: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`

### Auto-Update

The setup script includes a daily cached background update for Claude and Codex:

- `claude install latest`
- `codex update`

This is separate from the top-level package update check.

Source:

- `scripts/setup-claude-code.sh`: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`

## What It Does Not Appear To Do

I found no verified evidence in the npm tarball for:

- A web UI.
- A phone/mobile UI.
- A remote-control relay.
- Pairing codes.
- Tunneling.
- WebSocket control.
- Browser-based Claude/Codex driving.

The package name `data-remote` and the user-supplied context suggested possible remote/mobile control, but the actual published `1.2.44` artifact is a Replit persistence and session-management installer.

If a separate private/community "DATA remote" exists, I could not verify it from public npm/GitHub/source inspection.

## Why People Use It / Audience

Verified use case:

- Developers using Claude Code and/or Codex CLI inside Replit.
- Users who lose installed CLIs, credentials, conversations, shell history, SSH config, or Claude binaries after Replit container restarts.
- Users who want new Replit shell tabs to reopen a recent Claude/Codex session quickly.
- Users who want Claude OAuth refresh handled automatically during long-running Replit sessions.

Public adoption signals are modest:

- npm reported 55 downloads for the week `2026-06-22` to `2026-06-28`.
- The GitHub repo page showed 1 star and 0 forks when opened on 2026-06-29.

Unverified:

- I did not find public web-search evidence for broader DATA community discussions, videos, X/Twitter threads, or user testimonials about `data-remote`.
- The user's statement that Steve Moraco is associated with the DATA / Claude Code power-use community may be true, but I did not independently verify it through public sources during this pass.

Sources:

- npm downloads API: `https://api.npmjs.org/downloads/point/last-week/data-remote`
- GitHub repo page: `https://github.com/stevemoraco/DATAtools`

## Security and Operational Risks

These are verified behaviors plus risk analysis.

- Credential persistence: `.replit-tools/.claude-persistent/` and `.replit-tools/.codex-persistent/` contain high-value auth material and conversations. The README acknowledges these are critical secrets and adds `.replit-tools/` to `.gitignore`.
- SSH persistence: the installer also persists `~/.ssh` into `.replit-tools/.ssh-persistent`, which can preserve private keys in the workspace. It tightens permissions but increases blast radius if workspace files are exposed.
- Broad bypass defaults: generated aliases and menu commands use Claude `--dangerously-skip-permissions` and Codex `--dangerously-bypass-approvals-and-sandbox`. That makes fast Replit agent use easier but weakens local safety boundaries.
- Shell/profile mutation: it writes `.config/bashrc`, updates `.replit`, and appends `.gitignore`. This is normal for a bootstrapper but should be transparent and reversible.
- Auto-update behavior: background `claude install latest` / `codex update` changes runtime tools without an explicit per-update approval.
- Long retention and mirror archive: default `persistenceDays` is effectively "forever" and archive mirroring can retain conversations after provider deletion, which may conflict with user expectations around deletion/privacy.
- Token refresh: automatic refresh is convenient, but it means the tool reads and rewrites OAuth credential files. Any bug or logging mistake here would be high impact.
- Hard-coded Replit path: safer in that it avoids broad accidental install elsewhere, but brittle if Replit paths change or if users expect generic cloud/SSH support.

Sources:

- Published README security table: `https://github.com/stevemoraco/DATAtools`
- Published scripts: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`

## Relevance to `myshell-tools`

Local repo sources skimmed:

- `README.md`
- `CLAUDE.md`
- `CHANGELOG.md`
- `src/cli.ts`
- `src/interface/menu.ts`
- `src/providers/registry.ts`
- `src/providers/port.ts`
- `src/interface/run.ts`
- `src/infra/conversations.ts`
- `src/infra/session.ts`

### What `myshell-tools` Is

`myshell-tools` is a multi-provider shell CLI/TUI that drives existing subscription CLIs: Claude Code, Codex, OpenCode, and Grok. It provides:

- Interactive control panel and one-shot `run`.
- Provider detection/auth/install flows.
- Routing across providers/models.
- Cross-vendor review.
- Conversations stored as JSONL under `~/.myshell-tools/conversations/`.
- Session/ledger storage under `.myshell-tools/`.
- Native provider-session continuity for Claude/Codex when enabled.
- Goal mode, smart parallel goals, account management, and rate-limit/cooldown handling.
- Container/SSH sign-in flow and Replit shell autoload work.

Local references:

- `README.md`
- `src/cli.ts`
- `src/interface/menu.ts`
- `src/providers/port.ts`
- `src/infra/conversations.ts`
- `CHANGELOG.md`

### Overlap

High overlap:

- Both target subscription CLI workflows, not API-key-first usage.
- Both care about cloud/container/SSH environments.
- Both manage session continuity and provider credential homes.
- Both use shell startup hooks to make a coding-agent workflow survive Replit/container restarts.
- Both need to avoid pretending about provider state; the working state is in vendor CLI files and sessions.

Low overlap:

- DATA Tools does not orchestrate models or route work.
- DATA Tools does not own a real conversation abstraction above the provider CLIs.
- DATA Tools is Replit-specific; `myshell-tools` is multi-environment and multi-provider.
- DATA Tools' session picker launches raw provider CLIs; `myshell-tools` wraps provider CLIs behind a typed provider port and own conversation loop.

## Should `myshell-tools` Incorporate Ideas?

Recommendation: partially incorporate.

Do not copy `data-remote` as a feature wholesale. Its core persistence trick is useful, but `myshell-tools` already has stronger primitives and should not inherit broad bypass aliases or hidden background mutations.

Incorporate:

- A Replit/cloud persistence audit command that reports where Claude/Codex/Grok/OpenCode credentials and sessions live, whether they survive restart, and what `myshell-tools` will do.
- A reversible managed hook for Replit shell startup, building on the existing `install`/Replit autoload work.
- Provider-home persistence for all providers using explicit env dirs:
  - Claude: `CLAUDE_CONFIG_DIR`
  - Codex: `CODEX_HOME`
  - Grok: `GROK_HOME`
  - OpenCode: account-scoped data homes already fit this pattern
- A safe native-session library view that imports/lists/resumes Claude/Codex sessions into `myshell-tools`, not raw bypass shells.
- Token-expiry visibility and repair prompts, but avoid directly rewriting vendor OAuth tokens unless the vendor CLI exposes a stable supported refresh command.
- Explicit retention settings for conversation/session archives, defaulting to conservative retention rather than near-infinite.

Skip:

- Persisting `~/.ssh` by default.
- Default aliases that bypass provider permissions/sandboxes.
- Auto-updating provider CLIs in the background without clear user consent.
- Mirroring deleted conversations forever by default.
- A package whose top-level command ignores args and mutates startup files immediately.

## If `myshell-tools` Adds Remote/Mobile Access

This should be a separate design from DATA Tools because DATA Tools does not implement remote/mobile control in the inspected artifact.

Clean architecture for this codebase:

1. Add `myshell-tools serve` or `myshell remote`.
2. Run a local HTTP/WebSocket server bound to `127.0.0.1` by default.
3. Expose a small typed control API over existing internal abstractions:
   - list conversations from `ConversationStore`
   - read/append messages
   - start/abort a turn through `runTask`
   - stream `CoreEvent` output
   - inspect provider/env status
   - manage goals
4. Keep orchestration in-process. Do not script keystrokes into the TUI.
5. For external access, require an explicit tunnel mode:
   - user-provided reverse tunnel URL, or
   - supported provider like Tailscale/Cloudflare Tunnel, or
   - a tiny relay service if this product is meant to support nontechnical users.
6. Use short-lived pairing:
   - show a one-time code in the terminal
   - exchange for a device token
   - store hashed token with expiry in `~/.myshell-tools/remote.json`
   - allow revocation from the TUI/CLI
7. Enforce permissions at the `myshell-tools` command gate, not at the web client.
8. Default remote mode should be read-only until the user explicitly enables "send prompts" and separately enables "allow local writes/commands".
9. Stream output using the existing event model rather than terminal scraping.

Could `myshell-tools` do it better than DATA Tools?

Yes, if the scope is remote/mobile control or durable cloud sessions:

- Multi-provider by construction instead of Claude-first scripts.
- Uses typed provider ports and `CoreEvent` streams instead of shell aliases.
- Already has command gating, oversight, risk classification, conversations, goals, ledgers, account isolation, and cooldowns.
- Can make auth explicit and revocable instead of relying on a shell profile and raw CLI bypass flags.
- Can expose provider status honestly through the existing detection layer.

Main security requirements:

- Bind local-only by default.
- Require opt-in for remote network exposure.
- Pair with short-lived codes and scoped tokens.
- CSRF protection for browser clients.
- SameSite/HttpOnly cookies or bearer tokens with origin checks.
- No unauthenticated LAN access.
- Never expose raw provider OAuth tokens or credential files.
- Redact secrets from logs and streamed command output.
- Require confirmation for destructive/high-risk commands even from a paired remote client.
- Rate-limit prompt submission and login attempts.
- Add audit logs for remote actions.
- Provide `myshell remote off` / revoke-all.

## Rough Effort Sketch

Low-risk Replit persistence polish: 2-4 days.

- Audit existing Replit autoload/persistent env behavior.
- Add `doctor` checks for provider home persistence.
- Add reversible hook visibility.
- Add tests around Replit path and env handling.

Native session library/import improvements: 4-7 days.

- Normalize Claude/Codex native session scanning.
- Present provider sessions in `Library`.
- Import/resume through `myshell-tools` conversation model.
- Add corruption and empty-session guards.

Remote/mobile MVP: 2-3 weeks.

- WebSocket event bridge over `runTask`.
- Conversation list/detail/send/abort endpoints.
- Pairing/token model.
- Local web client or minimal mobile-friendly page.
- Security review and integration tests.

Production-grade remote: 4-6+ weeks.

- Tunnel/relay strategy.
- Device management/revocation.
- E2E tests.
- Stronger audit logs.
- UX for command approvals.
- Threat-model review.

## Bottom Line

`data-remote` is best understood as a compact Replit survival kit for Claude Code/Codex, not as a general remote-control layer. Its appeal is that it makes Replit feel persistent and sessionful with one `npx` command. `myshell-tools` should borrow the persistence and session-discovery lessons, but implement them through its own provider registry, conversation store, command gate, and account isolation. If true remote/mobile access is desired, `myshell-tools` can do it materially better by adding an authenticated event-driven remote surface instead of exposing raw provider CLIs through permissive shell aliases.

## Sources

- npm registry package metadata: `https://registry.npmjs.org/data-remote`
- npm latest metadata: `https://registry.npmjs.org/data-remote/latest`
- npm downloads API: `https://api.npmjs.org/downloads/point/last-week/data-remote`
- npm tarball inspected: `https://registry.npmjs.org/data-remote/-/data-remote-1.2.44.tgz`
- npm package page: `https://www.npmjs.com/package/data-remote`
- GitHub repository: `https://github.com/stevemoraco/DATAtools`
- GitHub source index: `https://github.com/stevemoraco/DATAtools/blob/main/index.js`
- GitHub scripts directory: `https://github.com/stevemoraco/DATAtools/tree/main/scripts`
- Local `myshell-tools` references: `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `src/cli.ts`, `src/interface/menu.ts`, `src/providers/registry.ts`, `src/providers/port.ts`, `src/interface/run.ts`, `src/infra/conversations.ts`, `src/infra/session.ts`
