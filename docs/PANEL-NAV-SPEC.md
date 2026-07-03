# PANEL + NAVIGATION Build Spec

## Owner Intent

The shipped home surface is the chat conversation window. The user types in a type box. Under the type box is a pinned legend:

`← back to menu` on the left, `control panel →` on the right.

The chat surface has an inline goals strip above the type box. It shows current goals, both active and inactive, as a compact live glance. The fullscreen Control Panel opens from chat with Right. Left returns toward the menu. The prior de-drift verdict for `MYSHELL_GOALS_PANEL` and `MYSHELL_CONTROL_PANEL` is reversed: both concepts are core UX and must be promoted to unconditional behavior, with no permanent off switch.

## Current Implementation

### Flags

`src/interface/ui/goals-panel-flag.ts` and `src/interface/ui/control-panel-flag.ts` are still explicit opt-in gates. They return true only for truthy env values or `config.experimentalGoalsPanel` / `config.experimentalControlPanel`.

`src/interface/ui/mount.tsx` configures both at mount through `configureGoalsPanelStore()` and `configureControlPanelStore()`. Control Panel supersedes standalone Goals Panel: when Control Panel is on, only the Control Panel bridge route is armed.

Gap: the owner wants these surfaces always on. The current code is built around an off guarantee and tests assert the dark path.

### Goals Panel Today

`src/interface/ui/GoalsPanel.tsx` renders a fullscreen `Goals · To-dos` view from `UiState.board`. It shows:

- title and close hint;
- one goal row per board goal;
- to-dos only under the currently highlighted goal;
- keyboard navigation with `Up`/`Down` or `j`/`k`;
- close with `Esc` or `Ctrl+G`;
- left/right arrows ignored.

`src/interface/ui/goals-panel-model.ts` builds rows from `UiState.board`, uses the first goal as default highlight, and expands only `row.todos` for the highlighted goal.

Gap: the owner asked for an inline compact strip inside chat above the type box, not a standalone fullscreen goals page. The current feature is fullscreen, opened by `Ctrl+G`, and expanded around highlighted to-dos. It is closer to a precursor for the Control Panel Goals tab than to the desired inline goals strip.

### Control Panel Today

`src/interface/ui/ControlPanel.tsx` renders a fullscreen panel with tabs:

- `Status`: active goal count, execution phase, provider observations, quota label;
- `Goals`: reuses `GoalsPanelBody`;
- `Settings`: read-only setting rows.

Keyboard behavior:

- `Esc` or `Ctrl+G` closes;
- `Tab` / `Shift+Tab` switches tabs;
- on the Goals tab, `Up`/`Down` or `j`/`k` moves highlighted goal.

`src/interface/ui/control-panel-model.ts` derives data from `UiState`: board, live goals, stream panelists, board flag state, goals/control panel enabled state. `quotaLabel` is currently hard-coded to `unavailable in UI state`; settings are display-only.

Gap: the current Control Panel is structurally close to Region 2 but is incomplete for the vision. It lacks a direct Right-arrow route, has no per-goal action controls, does not show all per-goal to-dos unless the board row carries them, does not expose real quota/cooldown state, and cannot insert a goal ID/message into chat.

### Mounting And Input Today

`src/interface/ui/App.tsx` conditionally renders:

- Control Panel fullscreen when `uiState.controlPanel.enabled && open`;
- standalone Goals Panel fullscreen when Control Panel is not enabled and Goals Panel is open;
- otherwise chrome/status/stream plus `InputBox`.

`InputBox` is hidden and inactive while any fullscreen panel is open. The only chat-side panel shortcut today is empty-buffer `Ctrl+G`, routed through `onToggleFullscreenPanel`.

`src/interface/ui/InputBox.tsx` already owns the stable `useInput` path. It uses:

- bare Left/Right for cursor movement;
- Ctrl/Meta Left/Right for word movement;
- Up/Down for multiline movement or history;
- pending single-key reads for menu capture;
- bare `Esc` during a turn for interrupt.

Gap: literal global Left/Right navigation collides with normal text editing. Ink can deliver arrow keys, but it cannot know whether a user meant "move cursor" or "navigate app" while the composer owns focus. The build must define a focus-sensitive key model.

### Goal Data Today

The real source is already present. In `src/interface/menu.ts`, `createFileGoalStore()` is the persistent goal store. `syncBoard()` reads `goalStore.list()`, filters to current project/global goals, orders active work first, shapes rows with `roadmapProgress()`, `goalGlyph()`, `goalVerdictTag()`, `goalDepth()`, then dispatches `out.syncBoard(rows)`. `createInkOutputSink().syncBoard()` turns that into a `board/sync` action, filling `UiState.board`.

Important limitation: `toBoardRow()` currently includes `todos` only when `g.state === 'running'`. That is enough for the existing board's running checklist, but not enough for the Control Panel's "per-goal to-do lists" for inactive goals.

## Feasibility Assessment

### Inline Goals Strip Above Type Box

Feasible in Ink. The right implementation is not the existing fullscreen `GoalsPanel`; it should be a new compact `GoalQuickStrip` rendered in the normal chat route immediately above the composer. It should consume `UiState.board` plus live `UiState.goals` overlays.

Terminal limit: there is no CSS-style fixed positioning. "Pinned" means the App renders the strip/composer/legend at the bottom of the Ink tree and reserves rows in the height planner. If the transcript grows, Ink scrollback still exists above; the live region remains bounded by the planner.

### Pinned Legend Under Type Box

Feasible. Render a one-row `BottomLegend` immediately after `InputBox` while chat is active:

`← back to menu                                      control panel →`

It must be counted in the layout budget. Add a constant such as `LEGEND_ROWS = 1`, and reserve `inputBoxRows + LEGEND_ROWS` for the dock so status/stream/strip cannot overflow the viewport.

### Left/Right Navigation Without Breaking Typing

Bare Left/Right cannot be global while the composer is editing text. They already mean cursor movement and word movement variants in `InputBox`.

Required key-capture model:

- Chat route, composer focused, buffer empty:
  - bare Left opens the main menu route / exits chat loop;
  - bare Right opens Control Panel;
  - this is safe because there is no cursor movement to preserve.
- Chat route, composer focused, buffer non-empty:
  - bare Left/Right remain editor cursor movement;
  - the legend stays visible, but navigation is deferred until the draft is submitted or cleared;
  - optional one-line nudge on attempted edge navigation is acceptable only if it does not steal the key.
- Control Panel route:
  - composer inactive; panel owns `useInput`;
  - bare Left closes Control Panel back to chat;
  - a second Left from empty chat returns to menu;
  - Right may either no-op or advance panel sub-focus, but must not open nested panels.
- Main menu route:
  - existing menu single-key capture can ignore arrows or treat Right as "continue/open chat" only if explicitly designed later. This spec does not require changing menu arrows.
- Always keep `Ctrl+G` during transition as an alias for open/close panel until live validation proves bare Right is reliable across terminals.

Hard limit: a literal "Right arrow always opens panel" is not compatible with a focused text editor. The only honest terminal UX is focus-sensitive bare arrows plus a non-colliding alias.

### Per-Goal To-Do Lists

Feasible. The data already exists as goal roadmap items in `Goal.roadmap`. To support inactive goals, the board projection must include bounded `todos` for all relevant goals, not only running goals.

Terminal limit: a fullscreen panel can still overflow. The Control Panel must implement capped/scrollable sections: e.g. one highlighted goal expanded at a time, `j/k` selection, `PageUp/PageDown` or `u/d` for list scrolling, and a visible overflow count. It should never render every todo for every goal unbounded.

### "Chat About This Goal" Button

Feasible as a keyboard action, not a mouse button. Ink can render a button-like label, but terminal input is key-driven.

Recommended action:

- In Control Panel Goals tab, pressing `Enter` or `c` on a highlighted goal closes the panel, focuses chat, and inserts `@goal:<id> ` into the composer.
- This requires adding an imperative `InputBoxBridge.insertText(text)` or `setDraft(text)` method.

### Panel Type Box That Sends To Chat

Feasible, but higher risk. It means either embedding a second editor in the panel or reusing `InputBox` in a different route. Nested editors are a focus-trap risk.

Recommended phase:

- Do not ship this in the first promotion.
- Later add a simple one-line `PanelCommandBox` only in the Control Panel footer.
- On confirm, close the panel, focus chat, and either insert the message into the composer or submit it as a chat line, depending on explicit product choice.

Hard limit: terminals do not give rich focus semantics. The app must enforce a single active `useInput` owner per route.

## Target UX

### Routes

Define a small route model in UI state:

- `menu`: main menu chrome is active; composer hidden.
- `chat`: conversation surface is active; composer and legend visible.
- `controlPanel`: fullscreen panel active; composer hidden/inactive.

The existing menu loop still owns the main menu's data fetch and key decisions. The Ink app should expose explicit bridge actions for route changes so chat Left can return to menu without pretending to type `/back`.

### Chat Route Component Tree

Recommended final tree:

```text
App
  ErrorBoundary
    AppBody
      CommittedTranscript
      RouteSurface
        ChatSurface
          LiveChrome?            // menu/sub-flow frame only outside active chat
          StatusBlock            // existing live status
          Stream                 // existing live prose tail
          GoalQuickStrip         // new Region 1, compact, above composer
          ChatDock
            InputBox
            BottomLegend
        ControlPanelSurface
          ControlPanel           // Region 2 fullscreen
```

`GoalQuickStrip` is not a card-heavy board. It is a compact list:

```text
goals  3 total · 1 active
● g123 Build panel nav  2/5 · running · 2 workers
○ g119 Clean docs       4/4 · done
◌ g120 Release polish   1/6 · parked
```

Rules:

- show active and inactive goals;
- quick-view stats only;
- no per-goal todo expansion in the strip;
- cap height to 3-5 rows depending on terminal height;
- active/running/queued rows sort first, then parked, then terminal;
- merge live `UiState.goals` data into persisted `UiState.board` by id for worker/tool counts;
- if no goals exist, collapse to zero rows unless the owner wants an empty state later.

### Control Panel Component Tree

```text
ControlPanel
  ControlPanelHeader
    status stats: active goals, providers, cooldowns/quota, current mode
  ControlPanelTabs
    Status
    Goals
    Settings
  StatusSection
    provider/account health
    rate-limit/cooldown state
    session spend/tokens where available
  GoalsSection
    goal list
    highlighted goal details
    per-goal todo list
    actions: chat-about-goal, pause/resume/archive later
  SettingsSection
    existing settings, initially read-only where mutation support is not ready
  ControlPanelFooter
    ← chat · Tab sections · ↑↓/j/k select · Enter chat about goal · Esc close
```

Do not keep a separate standalone fullscreen Goals Panel as a shipped route. Reuse its model/body concepts inside the Control Panel Goals tab, but Region 1 is the inline strip and Region 2 is the Control Panel.

## State And Data Sources

### Goals

Use existing sources:

- persistent: `GoalStore` via `syncBoard()` and `board/sync`;
- live execution: reducer-owned `UiState.goals`;
- live worker/tool counts: `GoalView.agents` and `GoalView.toolCount`;
- todos: `Goal.roadmap` shaped into `GoalBoardTodoRow`.

Required changes:

- Make board sync unconditional for the Ink chat route, or replace `MYSHELL_BOARD` with no-off default behavior if the board remains the sync switch.
- Include bounded todos for all goals in `toBoardRow()`, not only running goals. The inline strip ignores the todo rows; Control Panel uses them.
- Add a selector such as `selectGoalQuickRows(state)` that merges `state.board` and `state.goals` without fabricating counts.

### Settings

Start with the current `ControlPanelSettingRow` model, but remove flag-setting rows once flags are promoted. The panel should not show "Standalone Goals Panel: enabled" or "Control Panel: enabled" after these are unconditional; that leaks implementation history.

### Provider/Quota/Health

Current Control Panel provider folding is available from `stream.panelists` and `goals[].agents`. Health and update warnings are already surfaced in the main menu path. Real quota is not yet in `UiState`; `quotaLabel` is hard-coded.

Phase 2 should add a `capacity` or `health` slice to `UiState` that the menu/run loop can update from:

- ledger/spend summary;
- provider auth state;
- known cooldown maps;
- health issues.

Until then, label unknowns honestly. Do not show fake quota percentages.

### Chat Draft Insertion

Add an `InputBoxBridge` method:

```ts
insertText(text: string): void
setDraft(text: string): void
focusComposer(): void // if needed as a semantic bridge method
```

The Control Panel action should dispatch an app-level intent, not mutate editor state from the reducer. The App bridge is the right impure seam.

## Keybinding And Focus Model

### Chat

- `Enter`: submit chat.
- `Alt+Enter`: newline, unchanged.
- `Left` / `Right` with non-empty buffer: editor cursor movement, unchanged.
- `Left` with empty buffer: return to menu.
- `Right` with empty buffer: open Control Panel.
- `Ctrl+G`: open Control Panel alias during rollout.
- `Esc` during running turn: interrupt, unchanged.
- `/back`: remains a command path to menu.

### Control Panel

- `Left`: close panel to chat.
- `Esc`: close panel to chat.
- `Ctrl+G`: close panel alias during rollout.
- `Tab` / `Shift+Tab`: switch sections.
- `Up`/`Down` or `j`/`k`: select rows in the active section.
- `Enter` or `c` on a goal: close panel and insert `@goal:<id> ` into chat.
- `PageUp`/`PageDown` or `u`/`d`: section scroll once implemented.

### Main Menu

No required arrow change in Phase 1. The owner requirement is satisfied by Left from chat returning to the menu and Right from chat opening the panel.

## Promotion Plan

Each phase must land green and on. Do not leave a new dark flag.

### Phase 1: Make The Existing Control Panel Always Reachable

1. Change mount behavior so Control Panel is configured enabled unconditionally.
2. Keep `Ctrl+G` as an alias and add empty-buffer Right to open Control Panel.
3. Add empty-buffer Left to return to menu through an explicit bridge/menu-loop signal.
4. Render `BottomLegend` under the chat composer and reserve one row in layout.
5. Update tests that currently assert off/unarmed behavior.

This phase can still use the existing Control Panel visuals. It proves route ownership and terminal key capture first.

### Phase 2: Replace Standalone Goals Panel With Inline Goals Strip

1. Add `GoalQuickStrip` above `InputBox`.
2. Drive it from a pure selector over `UiState.board` and `UiState.goals`.
3. Make goal board sync unconditional for chat, or otherwise ensure `UiState.board` is populated without `MYSHELL_GOALS_PANEL`.
4. Delete the standalone fullscreen Goals Panel route from normal navigation; keep `GoalsPanelBody` only as a reusable Control Panel body if still useful.
5. Update layout budget so `StatusBlock + Stream + GoalQuickStrip + InputBox + BottomLegend` never exceeds terminal height.

This phase realizes Region 1.

### Phase 3: Delete Flags And Config Surface

1. Delete `src/interface/ui/goals-panel-flag.ts` and `src/interface/ui/control-panel-flag.ts`.
2. Remove `experimentalGoalsPanel` and `experimentalControlPanel` from `AppConfig`, config docs, and config round-trip tests.
3. Remove `goals-panel/configure` and `control-panel/configure` actions, or make the final state shape no longer contain `enabled` booleans.
4. Remove "off guarantee" tests and replace with always-on route tests.
5. Remove settings rows that expose the promoted features as toggles.
6. Remove `MYSHELL_GOALS_PANEL` and `MYSHELL_CONTROL_PANEL` documentation references except migration notes/changelog.

This is the real no-permanent-off cleanup. A temporary "always true" function is acceptable only inside Phase 1; it is not the endpoint.

### Phase 4: Build The Full Control Panel

1. Expand Goals tab into list + highlighted detail layout.
2. Include per-goal todo lists for inactive and active goals by shaping roadmap rows for all goals.
3. Add bounded scrolling/collapse for long goal and todo lists.
4. Add honest provider/cooldown/capacity state to `UiState`; remove the hard-coded quota label.
5. Keep settings read-only unless each setting has a tested mutation path.

This realizes Region 2 without over-rendering the terminal.

### Phase 5: Chat-About-Goal And Panel Input

1. Add `InputBoxBridge.insertText()` and tests for preserving existing draft text.
2. Add `Enter`/`c` on highlighted goal to insert `@goal:<id> ` and return to chat.
3. Validate that the inserted goal token works with existing completion/context paths.
4. Only then consider a panel-local type box. If added, keep it as the single active input owner while the panel is open and make confirm return to chat.

## Live Validation Required

These must be validated in a real PTY/Ink run, not only pure unit tests:

- Empty chat buffer: Right opens Control Panel; Left returns to main menu.
- Non-empty chat buffer: Left/Right move cursor and do not navigate.
- Control Panel open: InputBox is inactive; panel consumes `j/k`, arrows, `Tab`, `Esc`, `Ctrl+G`.
- Returning from panel restores chat input without losing the draft.
- Bottom legend remains visible under the type box at common terminal sizes.
- Tiny terminal heights do not overflow or duplicate scrollback.
- Goal creation/mutation causes the inline strip to update without restarting the app.
- Inactive goals appear in the inline strip.
- Inactive per-goal todos appear in the Control Panel after the board projection includes them.
- Windows Terminal / PowerShell arrow sequences are delivered by Ink as expected.
- `Ctrl+G` alias still works during rollout.
- `/back` and Ctrl+C menu/exit behavior remain unchanged.

## Non-Goals

- Do not build mouse-clickable buttons. Terminal buttons are keyboard affordances.
- Do not show fake quota percentages or inferred provider capacity.
- Do not keep env/config flags as long-term user switches.
- Do not make the standalone Goals Panel a third core route; it either becomes the inline strip or is folded into the Control Panel.

