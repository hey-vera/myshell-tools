# Phase 4 Control Panel Spec

Region 2 of `docs/PANEL-NAV-SPEC.md` is the fullscreen Control Panel content. Phase 1 already made the panel route reachable from chat and added the bottom legend. This spec does not change that navigation work. It defines the data, model, rendering, and validation work needed to make the Control Panel useful without fabricating quota or overflowing the terminal.

## Current Reality

The current Control Panel is structurally present but thin:

- `src/interface/ui/ControlPanel.tsx` renders a title, summary line, three tabs, and a footer.
- `src/interface/ui/control-panel-model.ts` derives active goal count, execution phase, provider observations, read-only settings, and a hard-coded `quotaLabel: 'unavailable in UI state'`.
- `src/interface/ui/GoalsPanel.tsx` and `src/interface/ui/goals-panel-model.ts` are reused for the Control Panel Goals tab.
- `src/interface/menu.ts` owns the real persistent goal store through `createFileGoalStore()`, `syncBoard()`, and `toBoardRow()`.
- `toBoardRow()` currently attaches `todos` only when `g.state === 'running'`.
- `UiState.board` can already carry optional `GoalBoardRow.todos`, but the state comment still describes them as a running-goal checklist.
- Real quota/capacity signals exist in the conversation loop, account store, cooldown maps, ledger, and provider environment, but almost none of them are in `UiState`.

Phase 4 must keep the honesty rule: show real observed facts, or show `unknown`. Do not show fake quota percentages, inferred remaining capacity, or a "quota health" score.

## Goals

1. Show per-goal to-do lists for active and inactive goals in the Goals tab.
2. Keep board sync bounded so every sync does not grow with arbitrary roadmap size.
3. Replace the hard-coded quota label with real observed quota/cooldown/capacity facts, and explicit `unknown` where the app lacks a signal.
4. Make Settings interactive only for settings that already have a tested mutation path.
5. Add viewport-safe tab, selection, and scroll behavior for small terminals.

## Non-Goals

- No quota percentages.
- No inferred remaining messages/tokens.
- No mouse controls.
- No new provider probes just to draw the panel.
- No broad settings editor for every `AppConfig` field.
- No changes to `src/` or tests in this design pass.

## 1. Per-Goal To-Do Lists

### Projection Change

Change the persistent board projection in `src/interface/menu.ts`, inside `runChatLoop()`:

- Function to touch: `toBoardRow(g: Goal, allGoals: readonly Goal[]): GoalBoardRow`.
- Current behavior: `todos` is included only for `g.state === 'running'`.
- Required behavior: include bounded todos for every in-scope goal, regardless of lifecycle state.

Add a local projection cap:

```ts
const BOARD_TODO_SYNC_LIMIT = 8;
```

Use:

```ts
const todoLimit = Math.min(ROADMAP_LIMIT, BOARD_TODO_SYNC_LIMIT);
const todoItems = g.roadmap.slice(0, todoLimit);
const todos = todoItems.map((item) => ({
  id: item.id,
  text: item.text,
  status: item.status,
}));
const todoOverflow = Math.max(0, g.roadmap.length - todos.length);
```

Rationale:

- `ROADMAP_LIMIT` is currently 8 in `src/core/goal-todo.ts`, so existing goals are already naturally bounded.
- Keeping an explicit board projection cap prevents future roadmap-limit increases from silently bloating every `board/sync`.
- The projection remains a store snapshot. The reducer still re-derives live `agents` from `state.goals`.

### State Shape

Touch `src/interface/ui/state.ts`:

- Update `GoalBoardRow.todos` comment from running-only to bounded persistent to-dos.
- Add optional overflow metadata:

```ts
readonly todoOverflow?: number;
```

Only include `todoOverflow` when it is greater than 0. This keeps current payloads small and tests straightforward.

Touch `src/interface/ui/reduce.ts`:

- No new reducer logic is needed for board sync. The current `board/sync` replacement and agent-count overlay preserve unknown row fields via `{ ...row, agents: live }`.
- Add reducer tests only to lock in preservation if a future refactor narrows the row shape.

### Goals Tab Model

Do not continue using `GoalsPanelBody` as the full Control Panel Goals tab. It renders a flat list and expands todos inline, which is not enough for a viewport-bounded detail panel.

Touch `src/interface/ui/control-panel-model.ts`:

- Replace `goals: GoalsPanelModel` with a richer model, or add `controlGoals` beside the legacy `goals` during migration.
- Recommended shape:

```ts
export interface ControlPanelGoalRow {
  readonly id: string;
  readonly title: string;
  readonly state: GoalBoardRow['state'];
  readonly glyph: string;
  readonly done: number;
  readonly total: number;
  readonly agents: number;
  readonly scope: GoalBoardRow['scope'];
  readonly depth: number;
  readonly selected: boolean;
  readonly verdict?: string;
}

export interface ControlPanelGoalDetail {
  readonly id: string;
  readonly title: string;
  readonly state: GoalBoardRow['state'];
  readonly done: number;
  readonly total: number;
  readonly agents: number;
  readonly scope: GoalBoardRow['scope'];
  readonly verdict?: string;
  readonly approach?: GoalBoardRow['approach'];
  readonly todos: readonly GoalBoardTodoRow[];
  readonly todoOverflow: number;
}

export interface ControlPanelGoalsModel {
  readonly goalIds: readonly string[];
  readonly highlightedGoalId?: string;
  readonly rows: readonly ControlPanelGoalRow[];
  readonly detail?: ControlPanelGoalDetail;
}
```

Build it from `state.board` and `state.goalsPanel.highlightedGoalId`, using the same effective-highlight fallback as `buildGoalsPanelModel()`.

Important: merge live `state.goals` only for real live execution overlays that already exist, such as agents/tool counts. Do not invent work state for inactive persisted goals.

### Goals Tab Rendering

Touch `src/interface/ui/ControlPanel.tsx`:

- Stop rendering `<GoalsPanelBody model={model.goals} />` for the Control Panel.
- Render a Control Panel native `GoalsTab`.
- `j`/`k` and Up/Down select goals.
- Selecting a new goal resets the detail scroll offset to 0.
- `PageUp`/`PageDown` scroll the highlighted goal detail, not the whole terminal.

Layout:

- Wide terminal, `columns >= 96`: two panes.
  - Left: goal list, fixed width around 38-42 columns.
  - Right: highlighted detail.
- Narrow terminal, `columns < 96`: stacked content.
  - Top: bounded goal list.
  - Bottom: highlighted detail.
- Tiny height: prefer showing the selected goal plus a few detail rows over showing many collapsed goals.

The detail panel shows:

- title, state, scope, agents, verdict if present;
- approach line only when real `row.approach` exists;
- to-do rows from `row.todos`;
- `+N more to-dos not synced` when `todoOverflow > 0`.

No long list is rendered directly. All lists must go through a planner that returns visible rows plus overflow indicators.

### Goal List and Detail Scrolling

Touch `src/interface/ui/state.ts`:

Extend `ControlPanelUiState` with scroll offsets:

```ts
readonly statusScroll: number;
readonly goalsListScroll: number;
readonly goalsDetailScroll: number;
readonly settingsScroll: number;
```

Initial values: 0.

Touch `Action`:

```ts
| {
    readonly type: 'control-panel/scroll';
    readonly section: ControlPanelSection;
    readonly target?: 'list' | 'detail';
    readonly delta: number;
  }
```

Touch `src/interface/ui/reduce.ts`:

- Handle `control-panel/scroll` only when the panel is enabled and open.
- Store non-negative offsets: `Math.max(0, current + delta)`.
- On `control-panel/set-section`, keep each section's own previous scroll offset.
- On `control-panel/highlight-goal`, set `goalsDetailScroll` to 0.
- The view/model clamps offsets to the actual maximum after it knows viewport height.

Keyboard:

- `Tab` / `Shift+Tab`: switch tabs.
- `j` / `k`, Up/Down: select goals on Goals tab.
- `PageUp` / `PageDown`: scroll active tab content by one page.
- `u` / `d`: optional aliases for PageUp/PageDown if Ink key support is inconsistent.
- `Home` / `End`: optional, but useful for long lists.
- `Esc` / `Ctrl+G` / Left: close to chat, consistent with Phase 1 route ownership.

## 2. Real Quota, Cooldown, and Capacity State

### Honesty Rule

The panel may show:

- observed account status;
- observed provider auth/install/plan labels;
- observed provider/account cooldown timers;
- observed session token consumption from the ledger;
- observed current pressure derived from cooldown count;
- observed running provider/model state from `UiState.stream.panelists` and `UiState.goals[].agents`;
- configured policy/mode labels when synced from config.

The panel must not show:

- remaining subscription quota;
- percent quota used;
- reset time;
- "capacity remaining";
- "provider health score";
- estimated message count;
- any number derived from provider reputation instead of a real signal.

When the signal is unavailable, render `unknown`, not `0`, `100%`, or `healthy`.

### Real Signals Already Available Today

These are wireable today because they already exist in the codebase:

1. Provider install/auth/plan/model inventory
   - Source: `mutableCtx.env` in `src/interface/menu.ts`.
   - Current use: `toolStateProviders`, `buildToolStateContext()`, `planInfos`.
   - Real fields: provider id, installed, authenticated, `plan`, advertised model count.
   - Missing from `UiState`: yes.

2. Provider runtime observations
   - Source: `UiState.stream.panelists` and `UiState.goals[].agents`.
   - Current use: `buildControlPanelModel().providers`.
   - Real fields: provider, model, run state, attempt, tokens when reported.
   - Missing from `UiState`: no, already present.

3. Provider cooldowns
   - Source: `providerCooldownUntil` in `src/interface/menu.ts`.
   - Current use: `availableAfterCooldown()`, `currentPressure()`, evidence receipts.
   - Real field: expiry epoch ms per provider after observed 429/rate-limit.
   - Missing from `UiState`: yes.

4. Account store
   - Source: `readSubscriptions()` and `SubscriptionAccount` in `src/infra/subscriptions.ts`.
   - Current use: Accounts menu, account routing, `enrichDepsWithAccounts()`.
   - Real fields: id, provider, kind, label, enabled, status, plan, priority, lastUsedAt, expiresAt.
   - Missing from `UiState`: yes.

5. Account cooldowns
   - Source: `accountCooldownUntil` in `src/interface/menu.ts`.
   - Current use: `selectSubscriptionAccount()` via `OrchestrateDeps.accountCooldownUntil`.
   - Real field: expiry epoch ms per account after observed 429/rate-limit.
   - Missing from `UiState`: yes.

6. Session token consumption
   - Source: `sessionConsumption` and `sessionTokensByAccount` in `src/interface/menu.ts`.
   - Current use: `deriveLiveProviderOrder()`, evidence receipt, normalized account selection.
   - Real field: observed input+output tokens from ledger entries for the current conversation.
   - Caveat: missing provider usage may record zero or be absent; display as "observed tokens", not quota.
   - Missing from `UiState`: yes.

7. Quota pressure
   - Source: `currentPressure()` in `src/interface/menu.ts`, backed by `pressureFromSignals({ rateLimitedProviderCount })`.
   - Current use: quota shedding, governor pressure, scheduler caps.
   - Real field: `0 | 1 | 2 | 3`, derived only from active cooldowns.
   - Missing from `UiState`: mostly yes. `UiState.pressure` exists, but no action currently updates it.

8. Scheduler pressure/capacity
   - Source: `src/core/scheduler.ts::planSchedule()` and menu scheduler wiring around `schedTurnCallBudget`, `currentPressure()`, `crossGoalCap()`.
   - Current use: active goal scheduling.
   - Real fields: active limit, queued/running split, pressure lowering to single-file.
   - Missing from `UiState`: active/queued goal states are partly visible through board/live goals; the scheduler's active limit and cap reason are not.

### Signals That Need New Provider Support

These are not wireable honestly today:

- remaining subscription quota;
- quota reset timestamp;
- provider-side message allowance;
- account-level remaining quota;
- model-specific remaining capacity;
- true "performance percent";
- whether a provider is healthy before it has been used this session.

The Status tab should render:

```text
Quota remaining: unknown (not exposed by provider CLIs)
Cooldown pressure: 1/3 (1 provider cooling down)
```

not:

```text
Quota: 72%
Capacity: healthy
```

### UiState Additions

Touch `src/interface/ui/state.ts`:

Add a capacity/status slice:

```ts
export interface UiProviderCapacityRow {
  readonly provider: ProviderId;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly planRaw: string | null;
  readonly planLabel: string;
  readonly planConfidence: 'observed' | 'inferred' | 'none';
  readonly availableModelCount: number;
  readonly cooldownUntil?: number;
  readonly sessionTokens?: number;
}

export interface UiAccountCapacityRow {
  readonly id: string;
  readonly provider: SubscriptionProvider;
  readonly label: string;
  readonly enabled: boolean;
  readonly status: AccountStatus;
  readonly planRaw: string | null;
  readonly planLabel: string;
  readonly priority: AccountPriority;
  readonly lastUsedAt?: string;
  readonly expiresAt?: string;
  readonly cooldownUntil?: number;
  readonly sessionTokens?: number;
}

export interface UiCapacityState {
  readonly observedAtMs: number;
  readonly providers: readonly UiProviderCapacityRow[];
  readonly accounts: readonly UiAccountCapacityRow[];
  readonly pressure: 0 | 1 | 2 | 3;
  readonly shedPlan?: {
    readonly recapRefresh: boolean;
    readonly memoryWidth: 'full' | 'identity-only';
    readonly intentPass: boolean;
    readonly coreAnswer: true;
  };
  readonly accountParallelismDisabledProviders: readonly SubscriptionProvider[];
}
```

Add `capacity?: UiCapacityState` to `UiState`.

Add action:

```ts
| { readonly type: 'capacity/sync'; readonly capacity: UiCapacityState }
```

Touch `src/interface/ui/reduce.ts`:

- `capacity/sync` replaces the capacity slice.
- Also mirror `state.pressure = action.capacity.pressure` if the existing `pressure` field is retained for InputBox placeholder behavior.

Touch `src/interface/ui/mount.tsx` and `src/interface/stream-filter.ts`:

- Extend the output sink/bridge with `syncCapacity(capacity)`.
- Dispatch `capacity/sync`.

Touch `src/interface/menu.ts`:

- Add `syncCapacity()` next to `syncBoard()`.
- Call it:
  - at chat-loop entry after provider/account snapshots are available;
  - after `noteRateLimit()` changes cooldown state;
  - after account store mutations/login/detection refreshes;
  - after ledger-backed `sessionConsumption` changes if the panel is open or at turn settlement.
- The function must be fail-soft, like `syncBoard()`.

Build the snapshot from existing sources only:

- `mutableCtx.env` for provider installed/auth/plan/models;
- `classifyPlan()` / `planDisplayLabel()` for plan labels;
- `providerCooldownUntil`;
- `readSubscriptions()` for accounts;
- `accountCooldownUntil`;
- `sessionConsumption`;
- `sessionTokensByAccount`;
- `currentPressure()`;
- `currentShedPlan()`;
- `accountParallelismDisabledProviders`.

Do not call provider CLIs just for this panel refresh.

### Status Tab Rendering

Touch `src/interface/ui/control-panel-model.ts`:

- Replace `quotaLabel` with structured status rows.
- Keep `quotaRemaining: 'unknown'` explicit.
- Surface real sections:
  - Execution: phase, turn active, active goals, live providers.
  - Provider observations: current run states from `stream.panelists` and `goals[].agents`.
  - Accounts: active/total by provider and account rows when present.
  - Plans: observed plan labels and confidence.
  - Cooldowns: provider/account cooldown timers if `cooldownUntil > now`.
  - Pressure: `capacity.pressure`, with a reason such as `from N active cooldowns`.
  - Observed session tokens: provider/account totals when non-empty.
  - Unknowns: quota remaining/reset/capacity remaining.

Touch `src/interface/ui/ControlPanel.tsx`:

- Replace the one-line `Quota: unavailable in UI state` with the rows above.
- The top summary line should be short:

```text
2 active goals | pressure 1/3 | quota remaining unknown | providers claude:running, codex:done
```

- If `state.capacity` is absent, Status tab should say:

```text
Capacity snapshot: unknown
Quota remaining: unknown
Cooldowns: unknown
```

That is more honest than showing no pressure.

## 3. Settings Tab

The current Settings tab shows implementation flags:

- Persistent board
- Standalone Goals Panel
- Control Panel

After Phase 1-3 promotion, those rows should not be editable settings. They are product surfaces, not user preferences. Remove or move them to a read-only Diagnostics subsection only while the cleanup is in progress.

### Interactive Settings With Real Tested Mutation Paths

These can become interactive once a config snapshot and mutation bridge are added to `UiState`/`InkAppBridge`. They already have real menu paths in `src/interface/menu-settings.ts` and persistence through `saveConfig()`:

- New conversation mode
  - Existing path: `runModeSelect()`.
  - Persists: `AppConfig.mode`.
  - Control Panel control: segmented row `Auto / Budget / Balanced / High / Max`.

- Oversight
  - Existing path: `runOversightSelect()`.
  - Persists: `AppConfig.oversight`.
  - Control Panel control: segmented row `review-all / checkpoint / autonomous`.

- Output detail
  - Existing path: `runVerbositySelect()` currently private.
  - Persists: `AppConfig.verbosity`.
  - Control Panel control: segmented row `quiet / normal / verbose`.
  - Implementation note: extract/export a pure mutation helper instead of duplicating persistence logic.

- Appearance theme
  - Existing path: `toggleColorTheme()` currently private.
  - Persists: `AppConfig.colorTheme`.
  - Control Panel control: toggle `dark / light`.
  - Caveat: current behavior says it takes effect on next launch. Panel must say or model that honestly.

- Memory
  - Existing path: `toggleMemory()` currently private.
  - Persists: `AppConfig.memory`.
  - Control Panel control: toggle.

- Learned preferences
  - Existing path: `toggleLearnedTaste()` currently private.
  - Persists: `AppConfig.experimentalTaste`.
  - Control Panel control: toggle.

- Codebase awareness
  - Existing path: `toggleCodebaseAwareness()` currently private.
  - Persists: `AppConfig.codebaseAwareness`.
  - Control Panel control: toggle.

- Set as default shell
  - Existing path: `toggleDefaultShell()` and `applyDefaultShellResult()`.
  - Persists: `AppConfig.setAsDefault` and `defaultShellOptOut` only after install/uninstall succeeds.
  - Control Panel control: action row with confirmation, because it runs installation/uninstallation.

### Read-Only or Omitted Settings

Keep these read-only or omit them in Phase 4:

- Provider auth and account rows: display in Status, mutate via Accounts/Login flows.
- Quota and cooldowns: display only.
- `experimental*` rollout flags: not a Control Panel settings surface.
- Board, Goals Panel, Control Panel enabled flags: product state, not user settings after promotion.
- Panel/hedge/native-session advanced config: do not expose until there is a deliberate tested settings UX.
- Timeout, memory decay, memory max facts, default memory scope, memory approval: config-file-only today.

### Settings Plumbing

Touch `src/interface/ui/state.ts`:

- Add `settings?: UiSettingsSnapshot` with only the rows the panel can display.

Touch `src/interface/ui/App.tsx` / bridge:

- Add a callback for setting mutations, e.g. `onControlPanelSettingAction(action)`.

Touch `src/interface/menu.ts`:

- Implement the mutation handler by calling extracted helpers from `menu-settings.ts`.
- After mutation, re-sync `UiSettingsSnapshot` into `UiState`.

Important: do not let the React component call `saveConfig()` directly. The component should emit an intent; the menu/composition layer owns I/O.

## 4. Layout and Scroll Safety

### Control Panel Viewport Contract

Touch `src/interface/ui/App.tsx`:

- Pass geometry into the panel:

```tsx
<ControlPanel
  rows={Math.max(1, liveRows - 1)}
  columns={liveColumns}
  ...
/>
```

Touch `src/interface/ui/ControlPanel.tsx`:

- Accept `rows` and `columns`.
- Do not rely on parent `overflowY="hidden"` as the only safety mechanism.
- Compute an internal render budget.

Recommended fixed rows:

- title row: 1
- summary row: 1, omit first when height is very small
- tabs row: 1
- footer row: 1

Content rows:

```text
contentRows = max(1, rows - fixedRows)
```

If `rows < 6`, collapse the summary row. If `rows < 4`, render title/tabs/footer minimally and one content row.

### Section Model

Keep top-level sections as tabs:

1. Status
2. Goals
3. Settings

Keyboard:

- `Tab` moves to next tab.
- `Shift+Tab` moves to previous tab.
- Each tab owns its own scroll offset.
- Switching tabs preserves the previous scroll position for that tab.
- `PageUp`/`PageDown` scroll the active tab by `contentRows - 1`.
- `j`/`k` select rows only where the active tab has selectable rows:
  - Goals: select goal.
  - Settings: select actionable setting row.
  - Status: no selection in Phase 4 unless action rows are added.

### Overflow Indicators

Every list planner returns:

```ts
{
  rows: readonly RenderRow[];
  hiddenBefore: number;
  hiddenAfter: number;
}
```

Render indicators inside the section budget:

- top: `... N above`
- bottom: `... N more`

Indicators consume rows. The planner must reserve them before returning visible content.

### Goals Tab Budget

Wide layout:

- Left pane and right pane share the same `contentRows`.
- Left goal list is independently windowed by `goalsListScroll`, but auto-adjusted so the highlighted goal is visible.
- Right detail is independently windowed by `goalsDetailScroll`.

Narrow layout:

- Use stacked panes.
- Allocate at least 3 rows to goal list when possible.
- Allocate remaining rows to detail.
- When `contentRows <= 5`, show:
  - one selected goal row;
  - remaining rows for detail/todos.

### Status Tab Budget

Status rows should be grouped but still flattened through one scroll planner:

1. Execution
2. Providers
3. Accounts
4. Cooldowns and pressure
5. Observed tokens
6. Unknowns

All groups are plain rows in the planner. Group headings count as rows. If a group does not fit, scrolling reveals it; the component never renders it outside the budget.

### Settings Tab Budget

Settings rows are a selectable list plus optional detail/help line for the selected row. The detail line is part of the same content budget. If height is tiny, render only the selected row and footer.

## Buildable Worklist

### Phase 4A: Board Projection for Inactive Todos

Files:

- `src/interface/ui/state.ts`
- `src/interface/menu.ts`
- `src/interface/ui/reduce.ts`
- tests under `test/unit` and `test/ui`

Tasks:

1. Add `GoalBoardRow.todoOverflow?: number`.
2. Update `GoalBoardRow.todos` documentation to active and inactive bounded todos.
3. Add `BOARD_TODO_SYNC_LIMIT = 8` near `toBoardRow()`.
4. Change `toBoardRow()` to include bounded todos for every goal with roadmap items.
5. Include `todoOverflow` when truncated.
6. Add tests proving parked/done/failed goals can carry todos through board sync.

Validation:

- Create or fixture a parked goal with roadmap items.
- Open Control Panel Goals tab.
- Confirm inactive goal todos appear in the highlighted detail.
- Confirm a goal with more than the cap shows an overflow count.

### Phase 4B: Native Control Panel Goals Tab

Files:

- `src/interface/ui/control-panel-model.ts`
- `src/interface/ui/ControlPanel.tsx`
- `src/interface/ui/state.ts`
- `src/interface/ui/reduce.ts`
- `src/interface/ui/App.tsx`
- possibly keep `src/interface/ui/goals-panel-model.ts` for standalone legacy tests only

Tasks:

1. Add `ControlPanelGoalsModel`.
2. Add control-panel scroll offsets and `control-panel/scroll` action.
3. Pass viewport rows/columns from `App.tsx` to `ControlPanel`.
4. Replace `<GoalsPanelBody>` in the Control Panel with a native `GoalsTab`.
5. Implement goal-list and detail planners with overflow indicators.
6. Reset detail scroll on highlighted-goal change.
7. Keep `nextGoalId()` or move it into a shared helper.

Validation:

- `j/k` changes highlighted goal.
- PageUp/PageDown scrolls a long selected goal detail.
- A 10+ goal board does not overflow.
- A long todo list does not overflow.
- A narrow terminal uses stacked layout.
- A tiny terminal renders bounded rows and footer without scrollback duplication.

### Phase 4C: Real Capacity Snapshot

Files:

- `src/interface/ui/state.ts`
- `src/interface/ui/reduce.ts`
- `src/interface/ui/mount.tsx`
- `src/interface/stream-filter.ts`
- `src/interface/menu.ts`
- `src/interface/ui/control-panel-model.ts`
- `src/interface/ui/ControlPanel.tsx`

Tasks:

1. Add `UiCapacityState` and `capacity/sync`.
2. Extend the output sink with `syncCapacity()`.
3. Build capacity snapshots from existing menu loop sources.
4. Dispatch snapshots at chat entry, after rate-limit updates, and after account/config changes.
5. Replace `quotaLabel` with structured status rows.
6. Render `Quota remaining: unknown` explicitly.

Validation:

- With no capacity snapshot, Status shows unknowns.
- With authenticated provider plans, Status shows observed plan labels.
- After an observed 429/rate-limit, Status shows provider/account cooldown and pressure.
- Session token totals appear only when ledger entries exist.
- No fake percentages appear anywhere.

### Phase 4D: Settings Snapshot and Safe Mutations

Files:

- `src/interface/ui/state.ts`
- `src/interface/ui/reduce.ts`
- `src/interface/ui/App.tsx`
- `src/interface/ui/ControlPanel.tsx`
- `src/interface/menu.ts`
- `src/interface/menu-settings.ts`

Tasks:

1. Add `UiSettingsSnapshot`.
2. Extract or export tested mutation helpers from `menu-settings.ts` where needed.
3. Add bridge intent for setting actions.
4. Implement interactive rows only for the settings listed above.
5. Keep all other rows read-only or omitted.
6. Re-sync settings after successful mutation.

Validation:

- Mode changes persist via the same config path as Settings menu.
- Oversight changes persist.
- Verbosity changes persist.
- Memory/learned taste/codebase awareness toggles persist.
- Default shell action mutates config only when install/uninstall succeeds.
- No promoted Control Panel/Goals Panel flag toggle remains as a user setting.

### Phase 4E: Live PTY Validation

Run in a real PTY/Ink session, not only pure unit tests:

1. Empty chat buffer: Right opens Control Panel.
2. Control Panel: Left/Esc closes to chat.
3. Goals tab: inactive goals appear.
4. Goals tab: inactive todos appear for the selected inactive goal.
5. Goals tab: long goal/todo lists show overflow indicators and never exceed viewport.
6. Status tab: real provider/account/plan/cooldown/token signals appear when present.
7. Status tab: quota remaining says `unknown` when no provider exposes it.
8. Settings tab: only tested settings mutate; read-only rows do not pretend to toggle.
9. Resize terminal smaller while the panel is open; no duplicated scrollback or overlapping rows.
10. Windows Terminal / PowerShell PageUp/PageDown and Shift+Tab sequences behave as expected; if not, `u/d` aliases remain documented in the footer.

## Acceptance Criteria

- `docs/PANEL-NAV-SPEC.md` Region 2 is implemented without reviving a standalone Goals Panel as a core route.
- `toBoardRow()` projects bounded todos for active and inactive goals.
- The Control Panel Goals tab renders list plus highlighted detail, with scroll-safe todos.
- Status tab removes the hard-coded quota label.
- Status tab shows real observed signals or explicit `unknown`.
- Settings tab mutates only fields with real tested mutation paths.
- Every tab is viewport bounded and renders overflow indicators instead of overflowing.
- Live PTY validation proves inactive todos appear and quota reporting is honest.
