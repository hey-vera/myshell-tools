# Menu + Workspace Design v3

Date: 2026-07-03

Status: definitive pre-code design round. This supersedes `docs/menu-home-redesign-audit.md` v1/v2 for the home screen, workspace binding, new-conversation flow, and doctor/health visibility.

## Brutal Design Verdict

The old menu tried to be a dashboard. v2 tried to be a cleaner dashboard. That was still not enough. A true 10/10 terminal home screen should behave like a session launcher: tell me where I am, show the few sessions I can resume, show the one command I probably want, and put the cursor at a choice prompt. Anything that is not a decision at launch is noise.

The product has richer state than the Steve Moraco `data-tools/replit-tools` reference, but that is not a license to show all of it. Rich state belongs behind ranking and grouping. The home screen should reveal structure, not inventory.

## Online Research Findings

Sources accessed live on 2026-07-03.

### 1. Mature TUIs organize by task and object, not by decorative chrome

- K9s describes itself as a terminal UI for navigating, observing, and managing deployed applications, and emphasizes continual live observation plus commands on observed resources. Its value is not a box; it is fast movement through resource views and commands. Source: [K9s homepage](https://k9scli.io/) says K9s watches resources and offers subsequent commands to interact with them.
- K9s command mode uses a colon prompt and accepts resource names, aliases, namespace arguments, and filters. Source: [K9s commands](https://k9scli.io/topics/commands/) documents `:` commands, `?` help, `ctrl-a` aliases, and `:q`/Ctrl+C exit.
- K9s also supports aliases and autosuggestions in command mode, including arrow navigation and Tab/Ctrl-F accept. Source: [K9s aliases](https://k9scli.io/topics/aliases/).
- gh-dash is explicitly built around user-defined, per-repo PR/issues sections, custom hotkeys, and workflow-specific actions. Source: [gh-dash README](https://github.com/dlvhdr/gh-dash) feature list.

Design extraction:

- Section by object/context: repo, session, resource, issue/PR.
- Put commands near the object they operate on.
- Keep the always-visible command vocabulary short; use help or subflows for the rest.
- Do not use boxes as organization by themselves. Use alignment, grouping, and key columns.

### 2. Modern terminal pickers are type-to-filter lists, not tree-first navigators

- fzf calls itself a general-purpose command-line fuzzy finder and interactive terminal toolkit; it reads a list from stdin and writes the selected item to stdout. Source: [fzf README](https://github.com/junegunn/fzf), usage and highlights.
- fzf's value is that it handles arbitrary lists: files, command history, processes, hostnames, bookmarks, commits, and custom menus. Source: [fzf README](https://github.com/junegunn/fzf).
- zoxide uses fzf for completions and interactive selection. Source: [zoxide README](https://github.com/ajeetdsouza/zoxide), "Install fzf (optional)" section.
- Atuin records cwd/host/session/duration/exit context for shell history and exposes interactive fuzzy search. Source: [Atuin README](https://github.com/atuinsh/atuin) and [Atuin search docs](https://docs.atuin.sh/cli/reference/search/).
- Zellij's session-management docs show the right mental model for workspace/session launch: a welcome screen lets users start, attach, or resurrect sessions; the new-session flow can choose a specific folder via filepicker. Source: [Zellij session management](https://zellij.dev/tutorials/session-management/).

Design extraction:

- For folder selection, start from a ranked list and fuzzy filter it.
- Tree navigation is useful as a fallback for unknown folders, but it is slower as the primary path.
- Recency/frequency matter: a workspace picker should rank current cwd, conversation workspaces, and recently used project roots before raw filesystem traversal.
- The first picker version should be in-process, not external `fzf`, because this repo has no `fzf` dependency and already has fuzzy ranking/completion helpers.

### 3. The prompt must be visually typeable, not just implied

- Gum exposes `choose`, `input`, and `write` as separate primitives: menus and input are different surfaces. Source: [Gum README](https://github.com/charmbracelet/gum).
- Starship's whole value proposition is a minimal prompt that shows information only as needed, and its advanced docs show transient prompt/right-prompt patterns that move context away from the input point. Sources: [Starship homepage](https://starship.rs/) and [Starship advanced config](https://starship.rs/advanced-config/).

Design extraction:

- Use a real prompt affordance: `Choice: ▌` or `› `.
- Do not bury the cursor after a wall of status text.
- Keep status above; keep choice at the bottom.
- Right-side/tucked hints are acceptable, but the input location must be obvious.

### 4. The best tools avoid clutter by hiding detail behind interaction

- lazygit exposes keybindings through `?`, and its README points users to keybinding docs rather than printing everything in the main view. Source: [lazygit README](https://github.com/jesseduffield/lazygit), usage/keybindings section.
- K9s uses `?` and command mode/aliases rather than a permanent full command reference. Source: [K9s commands](https://k9scli.io/topics/commands/).
- gh-dash emphasizes user-defined per-repo sections and configurable actions, meaning the surface is shaped around what matters to the user's workflow. Source: [gh-dash README](https://github.com/dlvhdr/gh-dash).

Design extraction:

- Home should not explain settings, doctor, cost, mode policy, or account details.
- Home can show mode/account readiness in one status line.
- Everything else moves to Accounts, Mode, Library, or hidden support commands.

## Codebase Grounding

### Conversation metadata has no workspace binding today

`src/infra/conversation-store.ts:21-51` defines `ConversationMeta` with:

- `id`
- `title`
- `createdAt`
- `updatedAt`
- `messageCount`
- `pinned`
- `category`
- recap fields
- `intensity`
- `activation`
- `mode`

There is no `cwd`, `workspaceRoot`, `repoRoot`, or `projectKey` field.

The contract comment at `src/infra/conversation-store.ts:4-8` says conversations live in a global store so they follow the user across projects. That is directly at odds with repo-first home grouping unless we add workspace metadata.

### The file-backed store preserves only known metadata fields

`src/infra/conversations.ts:97-127` normalizes index entries and only carries known fields. A new `workspaceRoot` field must be added here or it will vanish on read.

`src/infra/conversations.ts:404-425` creates new metadata. Creation currently accepts only `(title, mode?)` and stamps mode; it does not receive cwd or workspace.

`src/infra/conversations.ts:480-492` rewrites metadata on append and explicitly rebuilds the object field-by-field. A new workspace field must be preserved here or it will be dropped after the first message.

`src/infra/conversations.ts:284-300` rebuilds an index from message logs when the index is corrupt. Existing `.jsonl` logs contain messages, not workspace metadata, so recovered legacy conversations cannot reliably recover workspaceRoot unless message entries are changed too or a sidecar exists.

### New conversation creation assumes process/menu cwd

`src/interface/menu.ts:7138-7156` handles `[n] New conversation`, checks auth, creates `ctx.store.create('', convMode)`, then immediately enters `runChatLoop(...)`.

There is no new-conversation workspace choice screen today.

### Turn execution assumes `ctx.cwd`, not conversation cwd

`src/interface/menu.ts:290-423` defines `MenuContext`, including `cwd`.

`src/cli.ts:1084-1095` builds `menuCtx` with `cwd`, then passes that context to the menu.

Inside chat, many features read `ctx.cwd`:

- repo/environment context: `src/interface/menu.ts:4045-4061`, `buildEnvironmentContext(ctx.cwd, nodeRepoScanPort)`
- project key: `src/interface/menu.ts:2716-2718`, `resolveProjectKey(ctx.cwd)`
- preflight deps: `src/interface/menu.ts:2327-2333`, `cwd: ctx.cwd`
- orchestrate deps: `src/interface/menu.ts:2350-2362`, `cwd: ctx.cwd`
- attachments: `src/interface/menu.ts:5997`, `resolveImageAttachments(line, { cwd: ctx.cwd })`
- ledger/cost: `src/interface/menu.ts:6974`, `readLedger(ctx.cwd)`
- command audit: `src/interface/menu.ts:6633`, `createCommandAuditRecorder({ cwd: ctx.cwd })`
- account menus pass cwd: `src/interface/menu.ts:7274`, `7279`, `7287`

This means "conversation has a workspace" is not just display metadata if the user expects resumed chats to run in that folder. The execution cwd must be chosen per conversation or per chat loop.

### Repo context is computed from a cwd at runtime

`src/core/repo-map.ts:367-388` defines `EnvironmentFacts`, including `cwd`, `repoName`, `gitRoot`, `branch`, `dirtyCount`, project type, docs, entries, ranked files, and total tracked files.

`src/core/repo-map.ts:529-620` builds that environment block from the cwd passed in.

`src/infra/repo-scan.ts:34-46` finds the git toplevel for a given cwd. This is reusable for resolving a workspace root, but there is no conversation binding today.

`src/infra/state-layout.ts:36-46` already has cwd-derived project state directories, and `deriveProjectKey` at `src/infra/state-layout.ts:92-97` uses cwd. That supports project-scoped ledgers/evidence but does not bind conversations.

### Existing fuzzy/path utilities can seed the picker

`src/interface/menu-completion.ts:196-268` has `fuzzyRank()` and path-token expansion.

`src/interface/menu-completion.ts:279-283` starts `matchPathEntries()`, which sorts directory hits before files and caps results.

`src/interface/menu-completion.ts:345-376` composes async completion over injected `readdir`.

These are not a full picker, but they are enough to avoid adding an external dependency for v1 of workspace picking.

## Workspace Feature Scope Verdict

### What is a ~2-4 hour change

Store and show workspace metadata only:

- Add `workspaceRoot?: string | null` to `ConversationMeta`.
- Add normalisation/preservation in `src/infra/conversations.ts`.
- Change `ConversationStore.create()` to accept a workspace option or new options object.
- Default new conversations to the current shell cwd or git root.
- Group home Recent by workspaceRoot/repo label.
- Treat legacy conversations with no workspaceRoot as `Legacy` or `No workspace`.

This is not enough for correctness if the user resumes a conversation from a different cwd. It only makes the menu look repo-aware.

### What is a 1-2 day change

Good home + new-conversation picker:

- Add the v3 home renderer.
- Add `runNewConversationFlow()` with current workspace and picker entry.
- Build a small in-process fuzzy workspace picker using existing ranking helpers.
- Gather candidates from current cwd/git root, existing conversation workspaceRoots, and maybe recently seen project state dirs.
- Stamp the chosen workspaceRoot on create.

This gives a polished launch experience but still needs careful execution-cwd threading.

### What is a multi-day change

Fully correct folder-per-conversation execution:

- Thread an `activeCwd`/`conversationCwd` through `runChatLoop`, `buildDeps`, preflight, repo-map, memory project key, attachments, command audit, ledger, verification, evidence, goal review, PLAN.md export, and account helper call sites.
- Make resume/open-numbered/continue-last choose the conversation workspaceRoot.
- Decide whether cost/ledger remains launch-cwd scoped or conversation-workspace scoped.
- Decide whether project-scoped memory/goals follow workspaceRoot, current process cwd, or both.
- Add migration/compat behavior for old conversations.

Honest estimate: 2-4 engineering days with tests, more if project-memory/goal semantics need careful product review.

### Migration implication

Existing conversations have no workspaceRoot. Do not guess silently from the current cwd. That would mislabel old global conversations as whatever folder the user happened to launch from.

Recommended legacy policy:

- `workspaceRoot` absent means `legacy/global`.
- Home shows legacy conversations below current-workspace conversations.
- On first resume of a legacy conversation, quietly keep it legacy unless the user chooses `w` / "Attach workspace" in Library.
- Optional later: offer a one-time "attach this conversation to current workspace?" prompt only when the user opens it from a repo and the title/recap strongly matches that repo. That is not v1.

## v3 Design Commitments

### Layout commitment

Use one box, not two boxes and not a fully box-free layout.

Reasoning:

- The product already has a strong `box()` primitive in `src/ui/tui.ts:132-157`.
- The Moraco reference's stable legend box works; its extra title box is the awkward part.
- Research points to fast object lists and command prompts, not box-heavy dashboards.
- One box gives a stable "where am I / what keys work" region. Everything below it is the session manager.

### Picker commitment

Use an in-process fzf-style fuzzy list over ranked workspace candidates.

Reasoning:

- fzf/zoxide/Atuin prove that type-to-filter over a ranked list is the fast modern pattern.
- Zellij proves that choosing a folder is legitimate in session creation.
- This repo has no fzf dependency and should not require an external binary for the core flow.
- This repo already has `fuzzyRank`, path expansion, and async readdir seams.

### Prompt commitment

Every selection screen ends with `Choice: ▌`.

Reasoning:

- The current `> ` is too easy to miss.
- Gum separates choice/input primitives; Starship keeps prompt information minimal and context away from the input point.
- `Choice: ▌` is explicit without being wordy.

## Final Home Screen

### Empty, Signed In

```text
╔════════════════════════════════════════════════════════════════════╗
║  myshell-tools v3.162.0 (latest)                                  ║
╠════════════════════════════════════════════════════════════════════╣
║  Keys: n=new  e=library  a=accounts  q=quit                        ║
║  Chat: Ctrl+C x2=menu  Ctrl+C x3=exit                              ║
║  Workspace: myshell-tools  |  Ready: 4 providers  |  New: Auto     ║
╚════════════════════════════════════════════════════════════════════╝

Recent in myshell-tools
  No conversations yet.

  [n] New conversation
  [e] Library
  [a] Accounts

Choice: ▌
```

### Empty, Not Signed In

```text
╔════════════════════════════════════════════════════════════════════╗
║  myshell-tools v3.162.0 (latest)                                  ║
╠════════════════════════════════════════════════════════════════════╣
║  Keys: a=sign in  s=settings  q=quit                               ║
║  Workspace: myshell-tools                                          ║
║  Not ready: sign in to start conversations                         ║
╚════════════════════════════════════════════════════════════════════╝

  [a] Sign in
  [s] Settings

Choice: ▌
```

### Populated

```text
╔════════════════════════════════════════════════════════════════════╗
║  myshell-tools v3.162.0 (latest)                                  ║
╠════════════════════════════════════════════════════════════════════╣
║  Keys: n=new  c=continue  1-9=open  e=library  a=accounts  q=quit  ║
║  Chat: Ctrl+C x2=menu  Ctrl+C x3=exit                              ║
║  Workspace: myshell-tools  |  Ready: 4 providers  |  New: Auto     ║
╚════════════════════════════════════════════════════════════════════╝

Recent in myshell-tools
  [1] 12m  Menu workspace design v3              codex · auto
  [2] 3h   Fix auth refresh tests                claude · max

Other workspaces
  data-tools/replit-tools
    [3] 40h  Port session manager behavior       claude · auto
  global
    [4] 2d   Subscription model notes            grok · auto

  [c] Continue last
      └─ codex · Menu workspace design v3 · 12m
  [n] New conversation
  [e] Library
  [a] Accounts
  [m] Mode                 Auto

Choice: ▌
```

Notes:

- `[1-9]` is taught by the numbered rows and the header, not by a standalone command line.
- Current workspace conversations come first.
- Other workspaces are visible but demoted.
- "global" is the legacy/no-workspace bucket.
- Health/doctor does not appear.
- Usage is omitted unless the user asks for cost. It is not a launch decision.

## Final New-Conversation Flow

### New Conversation Workspace Choice

```text
╔════════════════════════════════════════════════════════════════════╗
║  New conversation                                                  ║
╠════════════════════════════════════════════════════════════════════╣
║  Pick where this conversation should work.                         ║
║  New: Auto  |  Providers: claude codex opencode grok               ║
╚════════════════════════════════════════════════════════════════════╝

                      [1] Current workspace
                          C:\Users\Josh\Desktop\Github\Repositories\myshell-tools

  [2] Pick workspace...
  [m] Mode                 Auto

← back                                                     Choice: ▌
```

Behavior:

- Press `1`: create conversation in the resolved current workspace and enter chat.
- Press Enter: same as `1`, because the primary option is centered and obvious.
- Press `2`: open workspace picker.
- Left arrow: back to home. The hint is tucked bottom-left so it is discoverable but not competing with `1`.
- Press `m`: change mode before creating.

### Workspace Picker

Pattern: in-process fzf-style fuzzy list.

```text
╔════════════════════════════════════════════════════════════════════╗
║  Pick workspace                                                    ║
╠════════════════════════════════════════════════════════════════════╣
║  Type to filter. Enter selects. Esc/Left returns.                  ║
╚════════════════════════════════════════════════════════════════════╝

Filter: ▌

  [1] myshell-tools              current   C:\Users\Josh\Desktop\Github\Repositories\myshell-tools
  [2] replit-tools               recent    C:\Users\Josh\Desktop\Github\Repositories\data-tools\replit-tools
  [3] Github\Repositories        parent    C:\Users\Josh\Desktop\Github\Repositories
  [4] Desktop                    parent    C:\Users\Josh\Desktop

← back
```

Candidate ranking:

1. Current git root if available; else current cwd.
2. Workspaces from existing conversations, sorted by latest conversation update.
3. Parent directories of current cwd.
4. Optional later: zoxide-like frecency from a local workspace-recent file.

No tree navigator in v1. A tree is slower and visually larger. Add it later only as `[t] Browse filesystem` if users need deep unknown paths.

## Self-Healing Doctor Model

The v2 decision stands:

- Delete Doctor/Health from the user-facing home/menu/docs.
- Keep hidden `doctor/status/check --fix` for support and CI.
- Startup self-heals silently where safe.
- Surface only unavoidable user decisions inline at the moment they block the task.

Migration conflicts:

- Current code already archives source conflicts while leaving the active destination untouched at `src/infra/state-migration.ts:574-595`.
- Treat that as self-healed archive, not a home warning.
- Stop converting migration conflicts into `HealthIssue` in `src/infra/health.ts:136-155`.

## Consolidated Change Plan

### 1. Add workspace fields to conversation model

Files:

- `src/infra/conversation-store.ts`
- `src/infra/conversations.ts`
- `test/unit/conversations.test.ts`

Edits:

- Add `workspaceRoot?: string | null` to `ConversationMeta`.
- Add optional `workspaceLabel?: string | null` only if label caching is desired; otherwise compute labels at render.
- Change `create(title, mode?)` to `create(title, opts?)` or add a third `workspaceRoot` param. Prefer `create(title, { mode, workspaceRoot })` for future-proofing.
- Normalise `workspaceRoot` in `normaliseMeta()`.
- Preserve workspace fields in append/rename/pin/category/mode updates.
- Rebuild-index fallback leaves workspace absent.

Blast radius: medium. Many tests call `store.create(title, mode)`. A backwards-compatible overload reduces churn.

User judgment:

- Should workspaceRoot be exact selected cwd or git root when inside a repo? Recommendation: git root for repos, cwd for non-repo folders.

### 2. Add workspace resolution helper

Files:

- new `src/infra/workspace.ts` or `src/interface/menu-workspace.ts`
- `src/infra/repo-scan.ts`
- tests under `test/unit/workspace.test.ts`

Edits:

- `resolveWorkspaceRoot(cwd, repoScanPort)` returns git toplevel or resolved cwd.
- `workspaceLabel(root)` returns repo basename plus optional parent disambiguation.
- Must be fail-soft and cross-platform.

Blast radius: low.

User judgment:

- Display full absolute path in picker, short label on home. Recommended yes.

### 3. Replace home renderer with v3 session-manager layout

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu-display.ts`
- maybe `src/ui/tui.ts` if adding `alignedPrompt()` or row helper
- `test/unit/menu-render.test.ts`
- `test/unit/menu.test.ts`

Edits:

- Stop using generic `menu()` for the home screen.
- Render one `box()`.
- Render workspace-grouped recents.
- Add `Choice: ▌` from the render path, and remove the separate `out.write('> ')` from `src/interface/menu.ts:7010` or make renderer return whether it wrote a prompt.
- Hide unavailable commands in not-signed-in state.
- Show `[c] Continue last` with tree sub-line only when a last conversation exists.

Blast radius: high for output tests, low for runtime behavior.

User judgment:

- Whether to include `/=filter` in the first implementation. Recommendation: show only once filter is implemented.

### 4. Implement new-conversation flow before `ctx.store.create`

Files:

- `src/interface/menu.ts`
- new `src/interface/menu-new-conversation.ts`
- `src/interface/menu-settings.ts` only if reusing mode picker
- `test/unit/menu-flow.test.ts`

Edits:

- Replace direct `[n]` create path at `src/interface/menu.ts:7138-7156` with `runNewConversationFlow()`.
- Flow returns `{ kind: 'start'; workspaceRoot; mode } | { kind: 'back' } | { kind: 'exit' }`.
- Press `1`/Enter starts in current workspace.
- Press `2` opens workspace picker.
- Left arrow returns home in Ink path; in legacy raw key path map left-arrow escape sequence to back for this screen.

Blast radius: medium-high. Menu input handling and tests are sensitive.

User judgment:

- Whether new conversations should ask workspace every time. Recommendation: yes, but make Current+Enter frictionless.

### 5. Build in-process workspace picker

Files:

- new `src/interface/workspace-picker.ts`
- maybe reuse `src/interface/menu-completion.ts`
- tests under `test/unit/workspace-picker.test.ts`

Edits:

- Reuse `fuzzyRank()` semantics or extract it to a shared pure helper if import direction gets ugly.
- Candidate sources: current root, existing conversation workspaceRoots, parent dirs.
- Optional `Filter:` input with live redraw under Ink; legacy line-mode can accept typed query then render matches.
- Select by number.

Blast radius: medium if live redraw is implemented immediately; low if first version is line-mode query plus number.

User judgment:

- Live fuzzy filtering now or after schema/home. Recommendation: first implementation can be number + optional filter query; polish to live later.

### 6. Thread conversation workspace into execution cwd

Files:

- `src/interface/menu.ts`
- `src/core/types.ts` only if deps shape changes
- `src/interface/preflight-deps.ts`
- tests touching chat/menu flow, repo-map, attachments, ledger, evidence

Edits:

- In `runChatLoop`, derive `activeCwd = convMeta.workspaceRoot ?? ctx.cwd`.
- Replace `ctx.cwd` with `activeCwd` inside the chat loop where behavior should follow conversation workspace.
- Keep global menu/accounts/update operations on `ctx.cwd` unless they are conversation-specific.
- Ensure `buildEnvironmentContext`, `resolveProjectKey`, command audit, attachments, verify/evidence, and orchestrate deps use `activeCwd`.

Blast radius: high. This is the real feature.

User judgment:

- Ledger scope. Recommendation: conversation/workspace cwd, because cost/activity should follow the workspace context.
- Legacy conversation behavior. Recommendation: use launch cwd for legacy until user attaches workspace.

### 7. Sort/filter home by current workspace

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu-display.ts`
- tests

Edits:

- Current workspace group first.
- Other groups sorted by most recent conversation.
- Numbering remains global top-to-bottom so `[1-9]` dispatch can still index the visible `metas`.
- If display order differs from `ctx.store.list()`, pass the visible ordered list to dispatch or keep an index map. Current dispatch uses `metas[digit - 1]` at `src/interface/menu.ts:7188-7193`, so this must be updated.

Blast radius: medium. Numeric-open behavior can break if render order and dispatch order diverge.

User judgment:

- How many other-workspace conversations to show. Recommendation: current workspace up to 5, other workspaces up to 4 total.

### 8. Remove user-facing doctor/health

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu.ts`
- `src/infra/health.ts`
- `src/cli.ts`
- `src/ui/help.ts`
- `test/unit/health.test.ts`
- `test/unit/help.test.ts`
- `test/unit/menu-render.test.ts`

Edits:

- Stop rendering health counts/warnings on home.
- Remove advertised `[d] Doctor`; optionally keep hidden dispatch only in debug/support builds.
- Keep CLI `doctor/status/check --fix` hidden and scriptable.
- Do not create `HealthIssue` for migration archives.

Blast radius: medium.

User judgment:

- Full CLI command deletion vs hidden command. Recommendation: hidden command.

### 9. Update documentation and tests

Files:

- `README.md`
- `CHANGELOG.md` when implementation lands
- unit and PTY smoke tests

Edits:

- Replace home screenshots/copy.
- Add tests for:
  - no `No runs yet`
  - no `Health:` / `doctor` on home
  - `Choice:`
  - workspaceRoot persists
  - workspaceRoot survives append/update
  - legacy missing workspaceRoot normalizes cleanly
  - visible numeric order matches dispatch order
  - new conversation flow Enter chooses Current

Blast radius: broad test churn, mostly string-level.

## Final Decisions Still Needed From User

1. Workspace root semantics: git root vs exact cwd. Recommendation: git root inside a repo, exact cwd outside.
2. Legacy conversations: keep global vs prompt to attach. Recommendation: keep global, no prompt.
3. Picker polish level for first implementation: live fuzzy vs simpler filter-then-number. Recommendation: filter-then-number first, live later.
4. Ledger scope after workspace binding. Recommendation: workspace/conversation cwd.
5. Whether `/=filter` is implemented in v3 home or omitted until later. Recommendation: omit until implemented.

## v4 (data-tools-structured, human-approved direction)

### Brutal Self-Critique Of v3

v3 was wrong in the exact way the user called out: it took a correct research principle ("organize around objects, not boxes") and applied it too literally against the taste of a real product the user likes. The single header box crammed command legend, chat escape model, workspace, readiness, and mode into one undivided rectangle, so the eye had no pause points and everything blurred into chrome. It was "neater" than the old menu but not cleaner. The data-tools layout wins because it separates ideas inside and between boxes: key legend, chat behavior, recent list, session manager, controls, prompt. v4 accepts that human judgment and uses boxes as structure, not decoration.

### Style Decision

Use the rounded single-line style:

```text
┌ ─ ┐
│   │
├ ─ ┤
└ ─ ┘
```

Justification:

- It matches the data-tools reference the user likes.
- It is calmer and less visually heavy than the current double-line `╔═╗` header.
- `src/ui/tui.ts` already defines rounded chars for `panel()` at `src/ui/tui.ts:267-303` and a rounded `divider()` at `src/ui/tui.ts:316-319`.
- The existing `box()` at `src/ui/tui.ts:132-157` only supports a double-line title divider and cannot render arbitrary internal `├─┤` sections.

Tiny helper needed:

- Add `sectionBox(sections, opts)` or `panelSections(title, sections, color, opts)` in `src/ui/tui.ts`.
- It should use `ROUNDED.tl/tr/bl/br/h/v/ml/mr`.
- It should handle display width via `visibleLength`, `truncateToWidth`, and `pad`, just like `box()`.
- It should allow a small title line or no title.
- It should render internal dividers between sections.

### Where Status Goes

Status does not belong in the top key legend box. The top box is muscle memory only:

- menu keys
- chat escape keys

Workspace/readiness/mode belongs in the small session-manager box immediately before controls. That is the moment the user is choosing what to do, so it is useful context there without polluting the key legend.

### v4 Home Empty, Signed In

```text
┌──────────────────────────────────────────────────────────────┐
│ At myshell-tools menu:                                       │
│ n = new conversation      c = continue last                  │
│ e = library               a = accounts                       │
│ m = mode                  q = quit                           │
├──────────────────────────────────────────────────────────────┤
│ In chat:                                                     │
│ Ctrl+C x2 = back to menu                                     │
│ Ctrl+C x3 = exit to shell                                    │
└──────────────────────────────────────────────────────────────┘

Recent in myshell-tools
  No conversations yet.

┌─ myshell-tools ──────────────────────────────────────────────┐
│ Workspace: C:\...\Repositories\myshell-tools                  │
│ New: Auto (smart)  ·  Ready: 4 providers                     │
└──────────────────────────────────────────────────────────────┘

[n] New conversation
[e] Library
[a] Accounts
[m] Mode                         Auto (smart)
[q] Quit

Choice: ▌
```

### v4 Home Empty, Not Signed In

```text
┌──────────────────────────────────────────────────────────────┐
│ At myshell-tools menu:                                       │
│ a = sign in               s = settings                       │
│ q = quit                                                     │
├──────────────────────────────────────────────────────────────┤
│ In chat:                                                     │
│ Ctrl+C x2 = back to menu                                     │
│ Ctrl+C x3 = exit to shell                                    │
└──────────────────────────────────────────────────────────────┘

┌─ myshell-tools ──────────────────────────────────────────────┐
│ Workspace: C:\...\Repositories\myshell-tools                  │
│ Not ready: sign in to start conversations                    │
└──────────────────────────────────────────────────────────────┘

[a] Sign in
[s] Settings
[q] Quit

Choice: ▌
```

### v4 Home Populated

```text
┌──────────────────────────────────────────────────────────────┐
│ At myshell-tools menu:                                       │
│ n = new conversation      c = continue last                  │
│ e = library               a = accounts                       │
│ m = mode                  q = quit                           │
├──────────────────────────────────────────────────────────────┤
│ In chat:                                                     │
│ Ctrl+C x2 = back to menu                                     │
│ Ctrl+C x3 = exit to shell                                    │
└──────────────────────────────────────────────────────────────┘

Recent in myshell-tools
  [1] 12m  Menu workspace design v4              codex · auto
  [2] 3h   Fix auth refresh tests                claude · max

Other workspaces
  data-tools/replit-tools
  [3] 40h  Port session manager behavior         claude · auto

  global
  [4] 2d   Subscription model notes              grok · auto

┌─ myshell-tools ──────────────────────────────────────────────┐
│ Workspace: C:\...\Repositories\myshell-tools                  │
│ New: Auto (smart)  ·  Ready: 4 providers                     │
└──────────────────────────────────────────────────────────────┘

[c] Continue last
    └─ codex · Menu workspace design v4 · 12m
[1-9] Resume numbered above
[e] Library / all conversations
[n] New conversation
[a] Accounts
[m] Mode                         Auto (smart)
[q] Quit

Choice: ▌
```

### v4 New Conversation Choice

```text
┌──────────────────────────────────────────────────────────────┐
│ New conversation:                                            │
│ 1 = use current workspace                                    │
│ 2 = pick workspace                                           │
│ m = mode                                                     │
├──────────────────────────────────────────────────────────────┤
│ Navigation:                                                  │
│ ← = back to menu                                             │
│ Enter = use current workspace                                │
└──────────────────────────────────────────────────────────────┘

┌─ Current workspace ──────────────────────────────────────────┐
│ C:\...\Repositories\myshell-tools                            │
│ New: Auto (smart)  ·  Ready: 4 providers                     │
└──────────────────────────────────────────────────────────────┘

                      [1] Current
                          C:\Users\Josh\Desktop\Github\Repositories\myshell-tools

[2] Pick workspace...
[m] Mode                         Auto (smart)

Choice: ▌
```

### v4 Workspace Picker

```text
┌──────────────────────────────────────────────────────────────┐
│ Pick workspace:                                              │
│ Type to filter                                               │
│ 1-9 = select                                                 │
├──────────────────────────────────────────────────────────────┤
│ Navigation:                                                  │
│ ← = back                                                     │
│ Enter = select first match                                   │
└──────────────────────────────────────────────────────────────┘

Filter: ▌

  [1] myshell-tools              current
      C:\Users\Josh\Desktop\Github\Repositories\myshell-tools
  [2] replit-tools               recent
      C:\Users\Josh\Desktop\Github\Repositories\data-tools\replit-tools
  [3] Github\Repositories        parent
      C:\Users\Josh\Desktop\Github\Repositories
  [4] Desktop                    parent
      C:\Users\Josh\Desktop

Choice:
```

### Layout Decisions Still Needing User Judgment

1. Rounded vs double-line for the whole product. Recommendation: rounded for menu/session-manager surfaces; keep double-line only where already used until touched.
2. Whether unauthenticated home should show `n` as disabled or hide it. Recommendation: hide it; one action is sign in.
3. Whether workspace absolute path should be allowed to overflow/truncate. Recommendation: truncate middle path segments, not the repo name.
4. Whether `[1-9] Resume numbered above` stays in controls. Recommendation: yes in populated state only, because it mirrors data-tools and reinforces the numbered list without polluting the top legend.
5. Whether the session-manager context box title should be product name or workspace name. Recommendation: workspace name, because this feature is now repo-first.

## v5 (final structure: info-top-box, single conversations list, title-only second box, ESC/back nav, ! shell passthrough)

### Brutal Correction

v4 got the structural rhythm closer, but it still misunderstood the top box. The top box should not teach controls; it should calmly state the current operating context. Putting controls in that box makes the controls feel like status and makes the actual control list below feel redundant. v5 fixes the hierarchy: top box is info/status only, conversations are one simple list, the second box is a title-only break, controls are flat, and the prompt/footer owns navigation hints.

### Navigation Model

Global navigation copy:

```text
← back · ESC shell
```

Placement: a single dim footer line directly below `Choice: ▌` or `Filter: ▌` on every menu/subflow. No box. No Ctrl+C copy.

Behavior:

- Left arrow pops exactly one menu stack level from any depth.
- ESC exits myshell-tools entirely back to the shell from any depth.
- Conversations autosave on append (`src/infra/conversations.ts:446-497`), so ESC-from-deep-conversation is safe: a full exit may end the UI immediately, but prior turns are already persisted and the active partial input is the only thing intentionally discarded.
- Ctrl+C can still exist as an emergency terminal interrupt internally, but it is not a designed UI affordance and should not be taught on the home/menu surface.

### Shell Passthrough

Design:

- Inside a conversation, any input whose first character is `!` runs in the shell.
- Example: `!npm publish`
- It is not sent to the model as a chat message.
- Output streams inline in the conversation transcript area:

```text
$ npm publish
...stdout/stderr...
exit 0
```

Plan:

- Intercept at the top of `runOneChatInput(line)` in `src/interface/menu.ts:1783`, after `/back`/`/exit` handling if those remain text aliases, but before slash-command dispatch and before provider/auth gating at `src/interface/menu.ts:5941-5953`.
- Use the active conversation workspace cwd, not the launch cwd, once workspace execution binding lands.
- Run through the command gate before execution. Dangerous commands should require confirmation; denied commands print `not run`.
- Stream stdout/stderr to `out` without model framing.
- Do not append it as a user chat message. If persistence is needed later, add a local/system transcript entry type deliberately; do not fake it as assistant output.

Blast radius:

- Medium. Touches chat input dispatch, command gate integration, streaming output, tests for `/help` copy, and queued-turn behavior.
- It must not collide with image/file mentions or shell history because the trigger is only first character `!`.

Safety note:

- This is shell execution, not AI execution. It should be explicit, local, visible, and gated. No model should rewrite or "helpfully fix" the command before running.

### v5 Home Populated - Rounded

```text
┌──────────────────────────────────────────────────────────────┐
│ Workspace          myshell-tools                             │
│ Path               C:\...\Repositories\myshell-tools          │
├──────────────────────────────────────────────────────────────┤
│ New conversation   Auto (smart)                              │
│ Providers          4 ready                                   │
│ Version            v3.162.0 latest                           │
└──────────────────────────────────────────────────────────────┘

Conversations
  [1] 12m  myshell-tools   Menu workspace design v5       codex · auto
  [2] 3h   myshell-tools   Fix auth refresh tests         claude · max
  [3] 40h  replit-tools    Port session manager behavior  claude · auto
  [4] 2d   global          Subscription model notes       grok · auto

┌─ Session Manager ────────────────────────────────────────────┐
└──────────────────────────────────────────────────────────────┘

[c] Continue last
    └─ codex · Menu workspace design v5 · 12m
[n] New conversation
[e] Library / all conversations
[a] Accounts
[m] Mode                         Auto (smart)
[q] Quit

Choice: ▌
← back · ESC shell
```

### v5 Home Populated - Double

```text
╔══════════════════════════════════════════════════════════════╗
║  Workspace          myshell-tools                           ║
║  Path               C:\...\Repositories\myshell-tools        ║
╠══════════════════════════════════════════════════════════════╣
║  New conversation   Auto (smart)                            ║
║  Providers          4 ready                                 ║
║  Version            v3.162.0 latest                         ║
╚══════════════════════════════════════════════════════════════╝

Conversations
  [1] 12m  myshell-tools   Menu workspace design v5       codex · auto
  [2] 3h   myshell-tools   Fix auth refresh tests         claude · max
  [3] 40h  replit-tools    Port session manager behavior  claude · auto
  [4] 2d   global          Subscription model notes       grok · auto

╔══════════════════════════════════════════════════════════════╗
║  Session Manager                                            ║
╚══════════════════════════════════════════════════════════════╝

[c] Continue last
    └─ codex · Menu workspace design v5 · 12m
[n] New conversation
[e] Library / all conversations
[a] Accounts
[m] Mode                         Auto (smart)
[q] Quit

Choice: ▌
← back · ESC shell
```

### v5 Home Empty, Signed In

```text
┌──────────────────────────────────────────────────────────────┐
│ Workspace          myshell-tools                             │
│ Path               C:\...\Repositories\myshell-tools          │
├──────────────────────────────────────────────────────────────┤
│ New conversation   Auto (smart)                              │
│ Providers          4 ready                                   │
│ Version            v3.162.0 latest                           │
└──────────────────────────────────────────────────────────────┘

Conversations
  No conversations yet.

┌─ Session Manager ────────────────────────────────────────────┐
└──────────────────────────────────────────────────────────────┘

[n] New conversation
[e] Library
[a] Accounts
[m] Mode                         Auto (smart)
[q] Quit

Choice: ▌
← back · ESC shell
```

### v5 Home Empty, Not Signed In

```text
┌──────────────────────────────────────────────────────────────┐
│ Workspace          myshell-tools                             │
│ Path               C:\...\Repositories\myshell-tools          │
├──────────────────────────────────────────────────────────────┤
│ New conversation   Auto (smart)                              │
│ Providers          none signed in                            │
│ Version            v3.162.0 latest                           │
└──────────────────────────────────────────────────────────────┘

Conversations
  Sign in to start conversations.

┌─ Session Manager ────────────────────────────────────────────┐
└──────────────────────────────────────────────────────────────┘

[a] Sign in
[s] Settings
[q] Quit

Choice: ▌
← back · ESC shell
```

### v5 New Conversation Choice

```text
┌──────────────────────────────────────────────────────────────┐
│ Workspace          myshell-tools                             │
│ Path               C:\...\Repositories\myshell-tools          │
├──────────────────────────────────────────────────────────────┤
│ New conversation   Auto (smart)                              │
│ Providers          4 ready                                   │
│ Version            v3.162.0 latest                           │
└──────────────────────────────────────────────────────────────┘

┌─ New Conversation ───────────────────────────────────────────┐
└──────────────────────────────────────────────────────────────┘

                      [1] Current
                          C:\Users\Josh\Desktop\Github\Repositories\myshell-tools

[2] Pick workspace...
[m] Mode                         Auto (smart)

Choice: ▌
← back · ESC shell
```

### v5 Workspace Picker

```text
┌──────────────────────────────────────────────────────────────┐
│ Workspace          Pick workspace                            │
│ Current            C:\...\Repositories\myshell-tools          │
├──────────────────────────────────────────────────────────────┤
│ Filter             type to narrow                            │
│ Select             Enter first match or press 1-9            │
└──────────────────────────────────────────────────────────────┘

Filter: ▌

  [1] myshell-tools              current
      C:\Users\Josh\Desktop\Github\Repositories\myshell-tools
  [2] replit-tools               recent
      C:\Users\Josh\Desktop\Github\Repositories\data-tools\replit-tools
  [3] Github\Repositories        parent
      C:\Users\Josh\Desktop\Github\Repositories
  [4] Desktop                    parent
      C:\Users\Josh\Desktop

← back · ESC shell
```

### Box Helper Note

`src/ui/tui.ts` currently has:

- `box()` at `src/ui/tui.ts:132-157`: double-line, title row plus one built-in divider, no arbitrary internal dividers.
- `panel()` at `src/ui/tui.ts:267-303`: rounded, optional title in the top border, no internal section dividers.
- `divider()` at `src/ui/tui.ts:316-319`: standalone rounded divider.

v5 needs a tiny shared helper:

- `sectionBox(sections, { style: 'rounded' | 'double', title?, width? })`
- supports one or more sections with internal dividers
- supports title-only boxes
- uses existing `visibleLength`, `truncateToWidth`, and `pad`
- allows the product to render the rounded and double alternatives from one model before the user chooses a final house style

### Layout Decisions Still Needing User Judgment

1. Rounded vs double for final shipping style. Recommendation: rounded, because the user explicitly likes the data-tools rhythm and it is lighter.
2. Whether ESC exits immediately from a running model turn or first cancels the turn then exits. Recommendation: ESC exits the app; if a turn is running, cancel and exit after cleanup.
3. Whether `!` shell passthrough output should persist in the conversation log. Recommendation: not initially; print inline only. Add persistent local transcript entries later if users ask.
4. Whether `[1-9] Resume numbered above` should remain in the controls. Recommendation: remove it from controls in v5; numbered rows and key handling are enough. The user explicitly requested controls list `(c/n/e/a/m/q)`.
