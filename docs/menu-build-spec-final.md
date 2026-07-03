# Final Home Menu + Workspace Build Spec

Date: 2026-07-03

Canonical source: `docs/HANDOFF.md`.

This document supersedes `docs/menu-home-redesign-audit.md` and `docs/menu-workspace-design-v3.md` for implementation. Do not re-innovate the structure. Build the locked data-tools-style skeleton below.

## Non-Negotiable Decisions

- Rounded boxes for menu/session surfaces.
- Home flow order:
  1. Effort Mode box with internal divider.
  2. One Recent list.
  3. Small centered `Session Manager` title box.
  4. Flat controls.
  5. `Choice: ▌`.
  6. Footer: root menu shows `ESC to exit`; subflows show `← back · ESC to exit`.
- `ESC` exits myshell-tools to the shell from any depth.
- Left arrow is real back: pop exactly one menu stack level from any non-root depth.
- Root menu has no back hint.
- `!` as first character inside a conversation runs a shell command, not a chat turn.
- Delete user-facing Doctor/Health. Startup self-heals silently where safe.
- Migration conflict becomes a self-healed archive path, not a warning.
- User-facing `mode` becomes `Effort Mode`.
- Conversations are workspace-bound via `workspaceRoot = git root else exact cwd`.
- Workspace UI must not ship if execution still runs from the launch cwd. No lying UI.

## Locked Mockups

### Home - Populated

```text
┌────────────────────────────────────────────────┐
│ Effort Mode:  Auto (smart)                     │
│ Picks the right effort each turn from task,     │
│ risk, and provider headroom.                    │
├────────────────────────────────────────────────┤
│ m = switch modes            Auto recommended    │
└────────────────────────────────────────────────┘

Recent (myshell-tools):
[1] 12m  Menu workspace design        codex · auto
[2] 3h   Fix auth refresh tests       claude · max
[3] 40h  replit-tools · Port session  claude · auto

┌───────────────────────────┐
│      Session Manager      │
└───────────────────────────┘

[c] Continue last
    └─ codex · Menu workspace design · 12m
[1-9] Open numbered above
[n] New conversation
[e] Library / all conversations
[a] Accounts
[q] Quit

Choice: ▌
ESC to exit
```

### Home - Empty, Signed In

```text
┌────────────────────────────────────────────────┐
│ Effort Mode:  Auto (smart)                     │
│ Picks the right effort each turn from task,     │
│ risk, and provider headroom.                    │
├────────────────────────────────────────────────┤
│ m = switch modes            Auto recommended    │
└────────────────────────────────────────────────┘

Recent (myshell-tools):
No conversations yet.

┌───────────────────────────┐
│      Session Manager      │
└───────────────────────────┘

[n] New conversation
[e] Library / all conversations
[a] Accounts
[q] Quit

Choice: ▌
ESC to exit
```

### Home - Empty, Not Signed In

```text
┌────────────────────────────────────────────────┐
│ Effort Mode:  Auto (smart)                     │
│ Picks the right effort each turn from task,     │
│ risk, and provider headroom.                    │
├────────────────────────────────────────────────┤
│ m = switch modes            Auto recommended    │
└────────────────────────────────────────────────┘

Recent (myshell-tools):
Sign in to start conversations.

┌───────────────────────────┐
│      Session Manager      │
└───────────────────────────┘

[a] Accounts / Sign in
[q] Quit

Choice: ▌
ESC to exit
```

### New Conversation Choice

```text
┌────────────────────────────────────────────────┐
│ Effort Mode:  Auto (smart)                     │
│ Picks the right effort each turn from task,     │
│ risk, and provider headroom.                    │
├────────────────────────────────────────────────┤
│ m = switch modes            Auto recommended    │
└────────────────────────────────────────────────┘

┌───────────────────────────┐
│     New Conversation      │
└───────────────────────────┘

                 [1] Current
                     C:\Users\Josh\Desktop\Github\Repositories\myshell-tools

[2] Pick workspace...

Choice: ▌
← back · ESC to exit
```

Behavior:

- Enter equals `[1] Current`.
- `[1] Current` resolves to git root inside a repo, otherwise exact cwd.
- `[2] Pick workspace...` opens the fuzzy workspace picker.
- `m` still switches Effort Mode from this screen because it is advertised in the Effort box.

### Workspace Picker

```text
┌───────────────────────────┐
│      Pick Workspace       │
└───────────────────────────┘

Filter: ▌

[1] myshell-tools       current
    C:\Users\Josh\Desktop\Github\Repositories\myshell-tools
[2] replit-tools        recent
    C:\Users\Josh\Desktop\Github\Repositories\data-tools\replit-tools
[3] Github\Repositories parent
    C:\Users\Josh\Desktop\Github\Repositories
[4] Desktop             parent
    C:\Users\Josh\Desktop

← back · ESC to exit
```

Behavior:

- Type filters immediately when Ink input is active.
- In non-Ink/legacy mode, filter can be line-mode first, then number select. Do not block the whole project on live filtering.
- Enter selects the first visible match.
- Number selects that row.
- Left arrow returns to New Conversation.
- ESC exits the app.

## Implementation Gating

The final release must include all workspace execution work. Do not publish a UI that implies conversations run in their workspace while `runChatLoop` still uses the launch `ctx.cwd`.

Safe early polish on a branch:

- The Effort Mode home skeleton can land before workspace execution if the Recent list remains launch-cwd/global and does not show a misleading workspace location column.
- Doctor/Health removal can land early because it is independent.
- Workspace picker and workspace-labelled Recent rows must remain hidden or test-only until execution cwd is threaded.

Release rule:

- Ship all workspace UI, workspace schema, picker, and cwd-threading together.

## Ordered Implementation Slices

### Slice 0 - TUI Box Primitives

Estimate: 0.5 day.

Files:

- `src/ui/tui.ts`
- `test/unit/tui.test.ts`

Build:

- Add `sectionBox(sections, opts)` for rounded multi-section boxes.
- Add `titleBox(title, opts)` for the small centered title box.
- Both must use existing `visibleLength`, `truncateToWidth`, and `pad`.
- Keep `box()` for existing double-line callers.

Blast radius:

- Low. New helpers only.

Test strategy:

- Unit tests for width, internal divider, title centering, ANSI-free output, truncation.

User judgment:

- None. Rounded is locked.

### Slice 1 - Home Render Skeleton, No Workspace Claims

Estimate: 1 day.

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu-display.ts`
- `src/interface/menu.ts`
- `test/unit/menu-render.test.ts`
- `test/unit/menu.test.ts`
- `test/unit/menu-flow.test.ts`
- PTY smoke fixtures/scripts as needed

Build:

- Replace current home renderer with the locked skeleton.
- Render Effort Mode top box.
- Render one `Recent (<current workspace label>):` list.
- Render centered `Session Manager` box.
- Render flat controls.
- Move `Choice: ▌` into the render path or make `startMenu` write it instead of `> `.
- Root footer is only `ESC to exit`.
- Hide workspace location column until Slice 9/10 are complete unless this is a non-release branch.

Blast radius:

- High in string assertions; medium runtime risk.

Test strategy:

- Golden-ish render tests using exact substrings:
  - `Effort Mode:`
  - `Session Manager`
  - `Choice:`
  - `ESC to exit`
  - no `No runs yet`
  - no `Health:`
  - no `doctor`
- PTY smoke updated for `Choice:`.

User judgment:

- None. Skeleton locked.

### Slice 2 - Effort Mode Rename

Estimate: 0.5 day.

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu-settings.ts`
- `src/interface/menu-display.ts`
- `src/interface/menu-auto-mode.ts` if copy lives there
- `test/unit/menu-render.test.ts`
- `test/unit/menu-mode-scope.test.ts`
- `test/unit/menu-flow.test.ts`
- README/help docs if they mention user-facing mode

Build:

- User-facing copy becomes `Effort Mode`.
- Keep internal type names (`mode`, `ConversationMode`) unless a broader refactor is explicitly approved.
- Locked copy:
  - `Effort Mode:  Auto (smart)`
  - `m = switch modes            Auto recommended`

Blast radius:

- Low-medium. Mostly copy.

Test strategy:

- Update string assertions.
- Add assertion that home does not show `New conversation default`.

User judgment:

- None.

### Slice 3 - Delete User-Facing Doctor/Health + Self-Heal Migration

Estimate: 0.75-1 day.

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu.ts`
- `src/infra/health.ts`
- `src/infra/state-migration.ts`
- `src/cli.ts`
- `src/ui/help.ts`
- `test/unit/health.test.ts`
- `test/unit/state-migration.test.ts`
- `test/unit/help.test.ts`
- `test/unit/menu-render.test.ts`

Build:

- Remove health/doctor from home rendering.
- Remove advertised `[d] Doctor`.
- Keep hidden `doctor/status/check --fix` CLI entry point for CI/support.
- In migration, classify archived conflicts as `complete-with-archive` or otherwise stop converting archive-only conflict reports into `HealthIssue`.
- `evaluateHealth()` should only surface unavoidable user decisions.

Blast radius:

- Medium. Health and migration tests change.

Test strategy:

- Migration archive case returns non-alarming status.
- Home never renders migration warning.
- Help no longer advertises Doctor as normal user flow.
- Hidden CLI still works for tests/support.

User judgment:

- None. Locked.

### Slice 4 - ESC Exit + Left Back Stack

Estimate: 1-2 days.

Files:

- `src/interface/menu.ts`
- `src/interface/menu-key-confirm.ts`
- `src/interface/menu-readline.ts`
- `src/interface/ui/App.tsx`
- `src/interface/ui/InputBox.tsx`
- submenu modules under `src/interface/menu-*-accounts.ts`
- `src/interface/menu-settings.ts`
- `src/interface/menu-conversations.ts`
- `test/unit/ctrl-c-model.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/ui/*`

Build:

- Introduce a menu navigation stack abstraction.
- ESC exits the app from any menu/subflow.
- Left arrow pops one stack level from any non-root depth.
- Root only shows `ESC to exit`, not back.
- Remove Ctrl+C x2/x3 UI copy.
- Keep Ctrl+C internal emergency handling if needed, but stop teaching it.

Blast radius:

- High. Input semantics across menus/subflows.

Test strategy:

- Pure key classification tests for ESC vs left.
- Menu-flow tests for root ESC exit, nested left back, nested ESC exit.
- Ink tests for empty-buffer left behavior updated from `/back` injection to stack-pop where appropriate.

User judgment:

- Edge while a model turn is running: recommendation is ESC cancels/cleans up then exits.

### Slice 5 - `!` Shell Passthrough In Conversations

Estimate: 1 day.

Files:

- `src/interface/menu.ts`
- new `src/interface/shell-passthrough.ts` or similar
- `src/core/command-gate.ts` if integration helper needed
- `test/unit/menu-flow.test.ts`
- new unit tests for shell passthrough helper

Build:

- Intercept at the top of `runOneChatInput(line)` around `src/interface/menu.ts:1783`.
- Trigger only if `line[0] === '!'`.
- Command is `line.slice(1).trim()`.
- Empty `!` prints a short usage line and returns to prompt.
- Run in active conversation cwd after cwd-threading lands.
- Use command gate before executing.
- Stream stdout/stderr inline.
- Do not send to model.
- Do not persist to conversation log initially.

Blast radius:

- Medium. Chat input dispatch and command safety.

Test strategy:

- `!echo hi` runs injected shell runner and does not call orchestrate.
- Dangerous/denied command does not run.
- `hello !cmd` remains normal chat.
- `!` alone is handled.
- Queued-turn drain does not accidentally run shell commands unless first char is `!`.

User judgment:

- Whether to persist shell output later. Recommendation: no for v1.

### Slice 6 - Workspace Schema

Estimate: 1 day.

Files:

- `src/infra/conversation-store.ts`
- `src/infra/conversations.ts`
- `test/unit/conversations.test.ts`

Build:

- Add `workspaceRoot?: string | null` to `ConversationMeta`.
- Update `ConversationStore.create()` to accept options: `create(title, { mode, workspaceRoot })`, keeping a compatibility overload if needed.
- Normalize `workspaceRoot` on read.
- Preserve `workspaceRoot` across append/rename/pin/category/recap/intensity/activation/mode mutations.
- Legacy missing field means global/unknown, not inferred current cwd.

Blast radius:

- Medium. Many tests call `create`.

Test strategy:

- Create persists workspaceRoot.
- Legacy entries without workspaceRoot still read.
- Append preserves workspaceRoot.
- Rebuilt index from JSONL leaves workspaceRoot absent.

User judgment:

- None. `git root else cwd` locked for new conversations.

### Slice 7 - Workspace Resolver + Candidate Model

Estimate: 1 day.

Files:

- new `src/infra/workspace.ts` or `src/interface/workspace.ts`
- `src/infra/repo-scan.ts`
- `src/interface/menu-completion.ts` if reusing/extracting fuzzy rank
- `test/unit/workspace.test.ts`
- `test/unit/workspace-picker.test.ts`

Build:

- `resolveWorkspaceRoot(cwd, repoScanPort)` returns git toplevel else resolved cwd.
- `workspaceLabel(root)` returns display label.
- Candidate ranking:
  1. current root
  2. prior conversation workspaceRoots by latest update
  3. parent dirs
- Extract/reuse `fuzzyRank()`.

Blast radius:

- Low-medium.

Test strategy:

- Git-root fallback cases with injected port.
- Windows path normalization.
- Candidate dedupe/ranking.
- Fuzzy filter deterministic.

User judgment:

- None.

### Slice 8 - New Conversation Flow + Picker (Hidden Until CWD Threading)

Estimate: 1-2 days.

Files:

- `src/interface/menu.ts`
- new `src/interface/menu-new-conversation.ts`
- new `src/interface/workspace-picker.ts`
- `test/unit/menu-flow.test.ts`
- `test/unit/workspace-picker.test.ts`

Build:

- Replace direct `[n]` create path at `src/interface/menu.ts:7138-7156`.
- Render locked New Conversation choice.
- Enter/[1] creates with current workspaceRoot.
- `[2]` opens fuzzy picker.
- Left returns home; ESC exits.
- Pass selected workspaceRoot to store create.
- Keep UI hidden behind an internal gate until Slice 9 completes if this branch is being published incrementally.

Blast radius:

- Medium-high. Main menu dispatch changes.

Test strategy:

- `[n] Enter` creates with current root.
- `[n] 2` opens picker and stores chosen root.
- left returns to home.
- ESC exits.

User judgment:

- None.

### Slice 9 - CWD Threading Through Chat Execution

Estimate: 2-4 days.

Files:

- `src/interface/menu.ts`
- `src/interface/preflight-deps.ts`
- `src/core/types.ts` only if deps shape changes
- `src/infra/ledger.ts` call sites if scope becomes active cwd
- `src/infra/command-audit.ts` call sites
- `src/infra/evidence-sink.ts` call sites
- `src/infra/evidence-store.ts` call sites
- `src/infra/verify-port.ts` call sites
- tests across menu-flow, repo-map, attachments, evidence, command audit, goals/memory

Build:

- In `runChatLoop`, compute `activeCwd = convMeta.workspaceRoot ?? ctx.cwd`.
- Replace conversation-specific `ctx.cwd` uses with `activeCwd`:
  - repo-map/environment context
  - resolveProjectKey
  - preflight deps
  - orchestrate deps
  - attachments
  - command audit
  - ledger/cost for conversation turns
  - evidence sink/store
  - verify/test execution
  - memory/taste/rules project scoping
  - goals projectKey
  - PLAN.md and related project file writes
- Keep app/global operations on launch `ctx.cwd`.

Blast radius:

- High. This is the core correctness work.

Test strategy:

- Resume conversation from different launch cwd still builds repo-map for conversation workspaceRoot.
- Attachments resolve relative to workspaceRoot.
- Command audit/evidence use workspaceRoot.
- Project memory and goals use workspace projectKey.
- Legacy no workspaceRoot falls back to launch cwd.

User judgment:

- None. Workspace execution correctness locked.

### Slice 10 - Workspace-Aware Recent List

Estimate: 0.75-1 day.

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu-display.ts`
- `src/interface/menu.ts`
- `test/unit/menu-render.test.ts`
- `test/unit/menu-flow.test.ts`

Build:

- Single Recent list only.
- Title format: `Recent (<current workspace label>):`.
- Each row has location column:
  - current workspace rows may omit redundant location if too wide only if tests prove readability; locked sample includes mixed rows.
  - non-current rows show `<location> · <title>` if width is tight.
- Current workspace sorts first; then recency.
- Visible render order must match numeric dispatch order. Current dispatch uses `metas[digit - 1]` at `src/interface/menu.ts:7188-7193`; update to use visible ordered list or an id map.

Blast radius:

- Medium. Numeric-open behavior risk.

Test strategy:

- Current workspace rows sort first.
- Non-current location appears inline.
- `[1]` opens first rendered row, not first raw store row.
- Empty signed-in/not-signed-in render locked copy.

User judgment:

- None.

### Slice 11 - Final Release Gate, Docs, PTY

Estimate: 1 day.

Files:

- `README.md`
- `CHANGELOG.md`
- `docs/menu-build-spec-final.md` if any final deltas
- `scripts/pty-smoke*.mjs`
- `test/integration/menu-cli.test.ts`
- `test/unit/menu-render.test.ts`
- `test/unit/menu-flow.test.ts`
- `test/ui/*`

Build:

- Update screenshots/copy.
- Ensure no user-facing doctor/health references.
- Ensure final home mockup matches locked skeleton.
- Run full unit/arch/UI/integration/PTY/type/lint gates.

Blast radius:

- Broad but mostly tests/docs.

Test strategy:

- See consolidated test plan below.

User judgment:

- None unless final PTY screenshots reveal visual mismatch.

## Recommended Slice Order

1. Slice 0 - TUI helpers.
2. Slice 1 - home skeleton without workspace claims.
3. Slice 2 - Effort Mode rename.
4. Slice 3 - doctor/health removal and self-heal.
5. Slice 4 - ESC/back-stack.
6. Slice 5 - `!` shell passthrough.
7. Slice 6 - workspace schema.
8. Slice 7 - workspace resolver/candidates.
9. Slice 9 - cwd-threading correctness.
10. Slice 8 - new-conversation flow/picker, enabled now that cwd is honest.
11. Slice 10 - workspace-aware Recent list, enabled now that cwd is honest.
12. Slice 11 - final release gate.

Why this order:

- Visible polish and doctor cleanup land early.
- The workspace UI remains hidden until execution is actually workspace-scoped.
- Schema/resolver can be built and tested before UI exposure.
- Cwd-threading is the hard blocker and must precede workspace-labelled Recent and picker release.

## Test Plan

### Existing Tests Expected To Change

- `test/unit/menu-render.test.ts`: home output, no health, Effort Mode, Session Manager, Choice prompt.
- `test/unit/menu.test.ts`: `renderBudgetLine()` no longer owns conversation empty state; Effort Mode copy.
- `test/unit/menu-flow.test.ts`: main menu prompt, `[n]` flow, numeric open order, ESC/back behavior, `!` shell passthrough.
- `test/unit/health.test.ts`: migration archive no longer surfaces as user warning.
- `test/unit/state-migration.test.ts`: `complete-with-archive` or equivalent non-warning classification.
- `test/unit/help.test.ts`: doctor hidden/support-only.
- `test/unit/conversations.test.ts`: workspaceRoot create/read/preserve.
- `test/unit/menu-completion.test.ts` or new workspace picker tests if fuzzy rank is extracted.
- `test/ui/*`: left/back and ESC behavior.
- PTY smoke scripts: locked home skeleton and `Choice: ▌`.

### New Tests Needed

- `sectionBox()` renders rounded internal divider and title-only box.
- Home populated render matches required landmarks:
  - `Effort Mode:`
  - `Recent (myshell-tools):`
  - `Session Manager`
  - `[c] Continue last`
  - `Choice:`
  - `ESC to exit`
- Home does not contain:
  - `No runs yet`
  - `Health:`
  - `doctor`
  - `Ctrl+C x2`
- Workspace root:
  - git root inside repo
  - cwd outside repo
  - Windows path normalize/preserve
  - legacy conversation missing workspaceRoot is valid
- New conversation:
  - Enter selects Current
  - `[1]` selects Current
  - `[2]` opens picker
  - picker selection stamps workspaceRoot
- Execution cwd:
  - repo-map uses workspaceRoot
  - attachments use workspaceRoot
  - preflight/orchestrate deps use workspaceRoot
  - command audit uses workspaceRoot
  - evidence/verify use workspaceRoot
  - memory/goals projectKey uses workspaceRoot
- `!` shell passthrough:
  - first-char only
  - no model call
  - command gate denial
  - output display

### Non-Flaky Test Rules

- Do not assert synchronous completion of fire-and-forget planner/recap/background work.
- Do not use brittle `retry:N` timing assertions.
- Prefer pure render tests and injected ports.
- For PTY, assert stable landmarks and order, not exact terminal repaint internals.
- For workspace cwd, use temp dirs and injected repo ports instead of real global git state.
- For shell passthrough, inject a fake shell runner; do not spawn real `npm publish`, `rm`, or platform-specific shells.

## Release Criterion

The release is ready only when:

- Final locked home renders.
- Doctor/Health is gone from user-facing surfaces.
- Effort Mode copy is consistent.
- ESC/back navigation works across root/subflows/conversations.
- `!` passthrough is gated and tested.
- WorkspaceRoot persists.
- New conversation can pick workspace.
- Resumed conversations execute in their workspaceRoot.
- Recent list location column reflects actual execution context.
- Full CI, UI tests, and PTY smokes are green.
