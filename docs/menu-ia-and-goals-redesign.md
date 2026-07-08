# myshell-tools v3.159.0 Menu IA, Auto Mode, and Goal Steward Redesign

Status: design doc only. No source or tests changed.

## Product Stance

myshell-tools is a subscription-first chat/orchestration tool for Claude, Codex, Grok, and OpenCode accounts. The control panel should help the owner start work, resume work, manage accounts, and understand whether the tool is usable. It should not feel like a token-billing dashboard.

The redesign therefore treats:

- conversations as the primary home-screen object;
- provider install/auth/account state as system readiness, not "ready" marketing copy;
- Auto as the default intelligence posture, not an alias for Max;
- mode as two scoped concepts: the global default for new conversations, and each conversation's own mode;
- goals as conversation/work context, not a top-level home list;
- usage/cost as advanced diagnostics, not primary UI.

## Current State, Grounded

### Provider Status

Current provider header rendering is in `src/interface/menu-display.ts`.

- Claude and Codex are always rendered in the header loop at `src/interface/menu-display.ts:187`.
- Not installed includes an install command at `src/interface/menu-display.ts:195`.
- Installed and authenticated renders as `<provider>: ready` at `src/interface/menu-display.ts:197`.
- Installed but unauthenticated renders `not signed in` at `src/interface/menu-display.ts:199`.
- OpenCode renders only when installed at `src/interface/menu-display.ts:204` and uses the same `ready` wording at `src/interface/menu-display.ts:211`.
- Grok renders only when installed at `src/interface/menu-display.ts:220` and uses the same `ready` wording at `src/interface/menu-display.ts:224`.

The main menu already has subscription-aware account labels:

- The subscriptions flag is read at `src/interface/menu-render.ts:161`.
- With the flag on, Auth rows become `Claude Accounts`, `Codex Accounts`, `OpenCode Accounts`, and `Grok Accounts` at `src/interface/menu-render.ts:162`.
- Without the flag, missing OpenCode and Grok use the clunky parenthetical `Login opencode (installs it first)` and `Login grok (installs it first)` at `src/interface/menu-render.ts:164` and `src/interface/menu-render.ts:176`.
- The underlying handlers really do install first for OpenCode and Grok when needed at `src/interface/menu.ts:7129` and `src/interface/menu.ts:7182`.

The new multi-account menus already track richer account state:

- Account status values are `active`, `expired`, `auth-failed`, `disabled`, and `unknown` in `src/infra/subscriptions.ts:15`.
- Account rows display label, priority, expiry, and status in `src/interface/menu-claude-accounts.ts:39`.
- Claude account creation verifies scoped auth before saving at `src/interface/menu-claude-accounts.ts:106`.
- The account menus list accounts or `(no accounts)` at `src/interface/menu-claude-accounts.ts:467`.

### Mode and Auto

Current Auto is not a standalone mode. It resolves to one of the existing three policy presets.

- Persisted `AppConfig.mode` is optional and can only be `cost-saver`, `balanced`, or `quality-first` at `src/infra/config.ts:49`.
- `AppConfig.intensity` separately supports `auto | 1 | 2 | 3 | 4 | 5` at `src/infra/config.ts:51`.
- `Mode` is only the three-preset union at `src/core/policy.ts:100`.
- The current labels are Efficient, Balanced, and Max at `src/core/policy.ts:107`.
- `autoModeForPlanInfos` maps Max plan -> `quality-first`, Pro -> `balanced`, Free -> `cost-saver` at `src/core/policy.ts:249`.
- `resolveAutoMode` delegates to that plan-to-mode mapping at `src/interface/menu-auto-mode.ts:102`.
- The main screen computes `eff = config.mode ?? autoMode` at `src/interface/menu-render.ts:112`, so unset mode is just the detected preset.
- The settings menu says `Auto - picks from your subscriptions (now: Max/Balanced/etc.)` at `src/interface/menu-settings.ts:82`.

There is already useful per-turn substrate:

- `autoIntensityForTurn` chooses a numeric intensity from tier, risk, depth, escalation, and review need at `src/core/capacity-allocator.ts:207`.
- Auto-stage uses that per-turn intensity when the conversation/config intensity is `auto` at `src/interface/auto-stage.ts:281`.
- The scheduler path does the same for cross-goal concurrency at `src/interface/menu.ts:4539`.
- The governor classifies task shape and sets `turnCallBudget` per turn at `src/core/governor.ts:669` and `src/core/governor.ts:681`.
- The governor's current base budget is still keyed to the three legacy modes through `baseBudgetForMode` at `src/core/governor.ts:330`.

Conversation-scoped tuning already exists, but it is not visible enough:

- `ConversationMeta` has a conversation-scoped `intensity` override at `src/infra/conversation-store.ts:39`.
- `ConversationStore.setIntensity` exists at `src/infra/conversation-store.ts:89`.
- Conversation index persistence preserves numeric intensity but omits `auto` at `src/infra/conversations.ts:129`.
- `resolveIntensity` prioritizes conversation intensity over global config at `src/interface/menu-auto-mode.ts:45`.
- The current conversation list renderer does not show mode or intensity; it renders relative time, title, category, and message count at `src/interface/menu-display.ts:295`.

Design implication: per-conversation mode is a real product concept already. The menu IA should expose it directly instead of hiding it behind settings or chat state.

### Main Menu IA

The current home/control panel mixes primary, advanced, and diagnostic actions.

- The home always renders the budget/activity line at `src/interface/menu-render.ts:102`.
- It renders the mode line at `src/interface/menu-render.ts:108`.
- It renders Recent conversations at `src/interface/menu-render.ts:127`.
- It renders a separate parked-goals section when parked goals exist at `src/interface/menu-render.ts:145`.
- The menu rows are built at `src/interface/menu-render.ts:194`.
- Top-level conversation actions include Continue, New, Resume numbered, Manage, Import native, and Raw provider session at `src/interface/menu-render.ts:196`.
- Auth rows are top-level at `src/interface/menu-render.ts:178`.
- Manage goals appears under Options when parked goals exist at `src/interface/menu-render.ts:203`.
- Change mode, Settings, Diagnose, Usage (tokens), Update, and Quit are all Options at `src/interface/menu-render.ts:208`.

### Doctor

Doctor is not fake, but it is not a good home-screen action.

- The menu dispatches `[d]` to `runDoctor(out)` without fix mode at `src/interface/menu.ts:7251`.
- `runDoctor` detects providers, probes state writability, probes ledger writability, checks pricing staleness, and computes Claude token status at `src/commands/doctor.ts:250`.
- The report includes platform, Node, state dir, ledger dir, pricing table, providers, auth, plan, and token status at `src/commands/doctor.ts:79`.
- Fix mode exists but is only used when `opts.fix` is true at `src/commands/doctor.ts:283`.
- The CLI `doctor/status/check` path can pass `--fix` at `src/cli.ts:483`.
- The main screen already surfaces health issues automatically at `src/interface/menu-render.ts:77`.
- The health evaluator is intentionally designed so users should not need to run diagnostics when healthy at `src/infra/health.ts:4`.

Verdict: Doctor "works" as a diagnostic report, but `[d]` feels broken because it does not repair and mostly repeats readiness already shown on the panel. Remove it from the top-level panel. Keep `myshell-tools doctor` and `myshell-tools doctor --fix`. Move repair affordances into Accounts/Settings only when a health issue exists.

### Usage / Tokens

Usage exists in two places.

- The always-on line renders calls and tokens via `renderBudgetLine` at `src/interface/menu-display.ts:258`.
- The source comment already says this is a subscription tool and dollars are misleading at `src/interface/menu-display.ts:243`.
- The top-level `$` row is `Usage (tokens)` at `src/interface/menu-render.ts:211`.
- The `$` handler dispatches to `runCost(ctx.cwd, out)` at `src/interface/menu.ts:7259`.
- `runCost` reads the ledger and prints a usage/efficiency report at `src/commands/cost.ts:162`.
- The report prints model calls, tokens, per-model usage, and a routing-efficiency ratio at `src/commands/cost.ts:73`.
- It explicitly avoids dollar figures because subscriptions are flat-rate at `src/commands/cost.ts:144`.

Verdict: remove `$` from the main panel. Keep the CLI report for advanced diagnostics and support. Do not show tokens as a home-screen primary signal. Quota/cooldown state should surface only where it affects action, for example as a provider row suffix or turn-level notice.

### Home Goals

The current home puts goals directly under Recent conversations.

- The Recent section renders at `src/interface/menu-render.ts:127`.
- Parked goals then render as a separate section at `src/interface/menu-render.ts:145`.
- `renderParkedSection` shows `Goals - Parked` and `press g to manage goals` at `src/commands/goals.ts:137`.
- Stale parked goals are only dimmed at `src/commands/goals.ts:147`.

This is the clunky shape the owner is reacting to. Goals should not compete with conversations on the home screen.

## Proposed Home Screen

Home should be conversations-first. Goals are not a home list. If a conversation has active/stale goals, the conversation row may carry a compact badge, but no goal title or goal controls appear until the conversation is opened.

```
myshell-tools v3.159.0
+------------------------------------------------------------+
| Providers                                                  |
| claude   installed, 2 active accounts (Max 20x, Pro)        |
| codex    installed, signed in                              |
| opencode not installed                                     |
| grok     installed, not signed in                          |
+------------------------------------------------------------+

New conversation default: Auto (smart)  |  Accounts: 3 active  |  Health: OK

Recent conversations
  [1]  5m ago   v3.159 menu IA redesign  | auto | 48 msgs | goals: active
  [2]  2h ago   multi-account routing     | max  | 36 msgs
  [3]  1d ago   OpenCode setup            | high | 12 msgs | goals: review
  [4]  4d ago   release notes             | auto | 9 msgs

Conversations
  [n] New
  [c] Continue last
  [1-9] Open numbered
  [e] Library

Controls
  [a] Accounts
  [m] New conversation mode
  [s] Settings
  [q] Quit
```

Rules:

- No `Goals - Parked` section on home.
- No `[g] Manage goals` on home.
- Badges are allowed because they are conversation metadata, not a second IA object:
  - `goals: active` means linked running/queued/parked goals exist.
  - `goals: review` means at least one linked goal is stale, blocked, or inactive.
  - No badge when there are no linked live goals.
- Every conversation row shows that conversation's current mode at a glance: `auto`, `budget`, `balanced`, `high`, or `max`.
- The top status line shows the global default applied to future new conversations.
- Selecting a conversation opens the goal surface in context.

## Proposed Control Panel IA

The control panel should have fewer top-level concepts:

```
Conversations
  [n] New
  [c] Continue last
  [1-9] Open numbered
  [e] Library

Accounts
  [a] Manage accounts

Controls
  [m] New conversation mode: Auto (smart)
  [s] Settings
  [q] Quit
```

Move or remove:

- Move `Resume a Claude/Codex session` into Library as `Import native session`.
- Move `Raw provider session` into Settings -> Advanced or Library -> Advanced.
- Remove `Diagnose` from top-level. Keep CLI `doctor`; show `Repair` only when health issues exist.
- Remove `Usage (tokens)` from top-level. Keep CLI `cost`.
- Remove home `[g] Manage goals`. Put goals inside conversation and Library details.
- Collapse `[j] [k] [o] [p]` Auth rows into `[a] Accounts` when subscriptions are enabled.
- If subscriptions are disabled, still prefer `[a] Accounts / Sign in` over four top-level rows.

## Provider Status Redesign

Replace "ready" with honest install/auth/account state.

Recommended header format:

```
Providers
claude   installed, 2 active accounts (Max 20x, Pro)
codex    installed, signed in
opencode not installed
grok     installed, not signed in
```

Provider status source priority:

1. If provider CLI is not installed: `not installed`.
2. If subscriptions flag is on and accounts exist:
   - `N active accounts` when active accounts exist.
   - include compact plan summary when known, for example `(Max 20x, Pro)`.
   - if all are disabled/auth-failed/expired: `accounts need attention`.
3. If installed and legacy auth probe is authenticated: `signed in`.
4. If installed but not authenticated: `not signed in`.

Do not use `ready`; it hides the difference between CLI installed, account signed in, and account pool health.

Auth/action copy:

```
Accounts
  [a] Manage accounts

Provider rows inside Accounts:
  claude    2 active, 1 disabled
  codex     signed in
  opencode  not installed     [install]
  grok      installed, not signed in  [sign in]
```

Remove the parenthetical `installs it first` from top-level labels. Installation is a next-step inside the account flow, where the current handlers already prompt before installing (`src/interface/menu.ts:7129`, `src/interface/menu.ts:7182`).

## Auto as the Smart Default

### Current Problem

Current Auto is plan-derived mode selection:

```
config.mode unset
  -> resolveAutoMode(env)
  -> autoModeForPlanInfos(plans)
  -> cost-saver | balanced | quality-first
  -> POLICY_PRESETS[that mode]
```

That means a strong subscription can make Auto land on `quality-first`, which the UI labels as Max. The owner wants Auto to be a standalone smart default where judgment decides per turn.

### Fresh Install Default

Fresh install default is Auto. Not Max. Not Balanced. Auto.

Current setup says Enter keeps "auto from your subscription" at `src/interface/menu-welcome.ts:161`, but that still resolves through the plan-to-preset path. In v3.159.0 IA, onboarding should say:

```
Mode: Auto (smart) is on by default.
It chooses effort each turn from task, risk, goals, and provider headroom.
```

No fresh user should have to choose a mode during setup. The first-run flow should only ask for account/setup items that are genuinely required. Mode can be changed later from the main menu default-mode control or per conversation.

### New Semantics

Use five user-facing choices:

- Auto (smart) - default. Per-turn judgment chooses intensity and levers.
- Budget - explicit low-quota override. Current `cost-saver`.
- Balanced - explicit middle override. Current `balanced`.
- High - future explicit stronger-than-balanced tier.
- Max - explicit maximum quality override. Current `quality-first`.

Mapping to current implementation:

| New label | Current key | Status |
| --- | --- | --- |
| Auto (smart) | mode unset, but no longer resolved to a preset | new behavior |
| Budget | `cost-saver` | rename from Efficient/Budget-compatible |
| Balanced | `balanced` | existing |
| High | none yet | future preset, can initially alias Balanced+more eager manager |
| Max | `quality-first` | existing |

Auto must not be displayed as `Mode: Max (auto)`. It should display:

```
Mode: Auto (smart)  |  per-turn effort from task + risk + provider headroom
```

The Mode picker:

```
Mode
  [1] Auto (smart)  active
      Decides effort each turn from task shape, risk, goal state, provider headroom.
  [2] Budget
      Conserve quota; no automatic top-model or panel.
  [3] Balanced
      Middle override; one strong pass when the turn earns it.
  [4] High
      More eager strong-model/review posture. (future; initially experimental)
  [5] Max
      Best-answer override; broadest panel/strong-model use.
```

### Auto Decision Model

Auto should use the judgment/governor substrate that already exists:

- Classify turn shape with governor (`quick`, `explain`, `build`, `investigate`, `decide`, `risky`) at `src/core/governor.ts:139`.
- Compute per-turn call budget in `allocate` at `src/core/governor.ts:681`.
- Compute per-turn intensity with `autoIntensityForTurn` at `src/core/capacity-allocator.ts:207`.
- Use subscription/account inventory as capacity, not as a mode alias, through `subscriptionInventoryFromEnvironment` at `src/interface/menu-auto-mode.ts:91`.

Auto policy:

```
if explicit mode selected:
  use explicit preset as a ceiling/floor, as today

if Auto:
  quick turn:
    budget 1, worker/IC, no panel, no review
  ordinary explain:
    budget 1-2 depending on confidence and provider headroom
  build/investigate:
    budget 2 when useful; allow depth and tests-first verification
  decide:
    allow poll/panel only for real fork and enough providers
  risky:
    allow strongest model, verification, and cross-vendor review when justified
  stale/active goal:
    treat goal state as part of shape; resume/clarify decisions use goal steward
```

Subscription plan changes what Auto can afford, not what Auto "is":

- Max accounts raise available headroom and allow bigger budgets when the turn earns them.
- Free/low-headroom accounts lower budget and veto top-model access.
- Unknown plan stays conservative-middle.
- Live quota/cooldown pressure shrinks budget, using the existing pressure model in `effectiveBudget` at `src/core/governor.ts:373`.

### Backward Compatibility

Do not break existing config files:

- Keep existing persisted keys: `cost-saver`, `balanced`, `quality-first`.
- Treat absent `config.mode` as Auto smart.
- Do not persist `mode: "auto"` unless a later migration needs it.
- Add display helpers that distinguish `effectiveMode` from `modeSource`.
- Keep `resolveAutoMode` temporarily for legacy paths and labels during migration, but do not use it as the canonical default policy once `MYSHELL_AUTO_SMART` is on.

## Mode Scope Model

There are two separate mode scopes. The UI must not blur them.

### Scope 1: Global Default for New Conversations

Meaning: the mode used when a new conversation is created.

Where shown:

- Main menu status line: `New conversation default: Auto (smart)`.
- Main menu quick key: `[m] New conversation mode`.

Behavior:

- Pressing `[m]` from the main menu changes only the default for future new conversations.
- It does not modify any existing conversation.
- It does not retune a conversation already open in another terminal.
- Fresh install starts with Auto.

Storage:

- Continue to use absent `config.mode` as Auto smart for backward compatibility.
- If explicit modes are persisted, use existing keys for Budget/Balanced/Max and add High only when the policy exists.

Main-menu quick picker:

```
New conversation mode
  [1] Auto (smart)  active
  [2] Budget
  [3] Balanced
  [4] High
  [5] Max

This changes new conversations only.
Existing conversations keep their own mode.
```

### Scope 2: Per-Conversation Mode

Meaning: the mode used by one conversation's future turns.

Where shown:

- Conversation list row: `[2] 2h ago  multi-account routing | max | 36 msgs`.
- Conversation detail in Library.
- Conversation header after opening: `Mode: max` or `Mode: auto`.

Behavior:

- To change an existing conversation, go to `Library -> select conversation -> Change mode`.
- The change applies only to that conversation.
- The main-menu `[m]` key does not touch it.

Conversation detail mockup:

```
Conversation
  multi-account routing
  Updated: 2h ago
  Mode: Max
  Messages: 36
  Goals: none

  [o] Open
  [m] Change this conversation's mode
  [r] Rename
  [p] Pin/unpin
  [x] Delete
  [Enter] Back
```

Per-conversation picker:

```
Conversation mode
  [1] Auto (smart)
  [2] Budget
  [3] Balanced
  [4] High
  [5] Max  active
  [0] Inherit new-conversation default

This changes only "multi-account routing".
```

### Conversation List Mode Display

The list should use compact lowercase labels:

- `auto`
- `budget`
- `balanced`
- `high`
- `max`

When a conversation inherits the global default, still render the resolved label, not blank. The goal is frictionless scanning.

Example:

```
[1] 3d ago  Building heyvera | max | 36 msgs
[2] 4d ago  Release notes    | auto | 9 msgs
```

This uses the existing `ConversationMeta.intensity` storage at `src/infra/conversation-store.ts:39` as the migration bridge, but the product-facing language should be mode, not numeric intensity.

## Settings Simplification

### Principle

Settings should not be a pile of implementation toggles. The product should make the right choice by default.

Rule:

- If a feature is simply better on, make it default-on, automated, and hide the toggle.
- If a feature is redundant or superseded by Auto/Goal Steward, remove it.
- Keep a toggle only when the user is making a genuinely meaningful preference, privacy, accessibility, or risk/autonomy choice.

Current settings are rendered in `src/interface/menu-settings.ts:303` and dispatched at `src/interface/menu-settings.ts:333`. Current config keys are declared in `src/infra/config.ts:34`.

### Simplified Settings Page

Target page:

```
Settings
  [1] New conversation mode: Auto (smart)
  [2] Oversight: checkpoint
  [3] Output detail: normal
  [4] Appearance: dark
  [5] Privacy & memory

  [Enter] Back
```

Optional secondary pages:

```
Privacy & memory
  [1] Memory: on
  [2] Learned preferences: on
  [3] Codebase awareness: on
  [Enter] Back
```

```
Setup
  Default shell: installed
  Repair: only shown when a real health issue exists
```

Do not expose routing, panel, hedge, intent, planner, or manager internals as normal settings.

### User-Visible Settings Verdict Table

This table audits the 16 rows currently shown by `runSettings` at `src/interface/menu-settings.ts:303`.

| Current setting | Current source | Verdict | Reasoning |
| --- | --- | --- | --- |
| Mode | `src/interface/menu-settings.ts:305`, `src/infra/config.ts:50` | keep-with-justification | Keep, but rename to `New conversation mode`. This is a user-facing default for future conversations, not an orchestration implementation flag. |
| Set as default shell | `src/interface/menu-settings.ts:306`, `src/infra/config.ts:36` | keep-with-justification | User-meaningful OS integration. Move out of primary Settings into Setup because it is not a daily tuning choice. |
| Update on launch | `src/interface/menu-settings.ts:307`, `src/infra/config.ts:59` | default-on-and-hide | On is clearly better for most users; updates already ask/announce. Keep env/config escape hatch for managed environments, but remove from normal Settings. |
| Native sessions | `src/interface/menu-settings.ts:308`, `src/infra/config.ts:67` | default-on-and-hide | Better context fidelity and less replay are product improvements. Once stable, automate and fail soft instead of asking users to reason about provider session plumbing. |
| Output detail | `src/interface/menu-settings.ts:309`, `src/infra/config.ts:105` | keep-with-justification | Real preference: quiet, normal, verbose changes how much terminal output the user wants. |
| Smart routing | `src/interface/menu-settings.ts:310`, `src/infra/config.ts:122` | default-on-and-hide | If routing is smarter, it should just run. Ambiguous-turn overhead should be managed by Auto/governor, not a user toggle. |
| Panel | `src/interface/menu-settings.ts:311`, `src/infra/config.ts:86` | default-on-and-hide | Cross-vendor panel should be governed per turn by Auto. A static panel switch duplicates mode/governor semantics. |
| Learned routing | `src/interface/menu-settings.ts:312`, `src/infra/config.ts:134` | default-on-and-hide | Observed-only learner can safely no-op with insufficient history. Hide it and make it part of routing intelligence. |
| Hedged escalation | `src/interface/menu-settings.ts:313`, `src/infra/config.ts:97` | default-on-and-hide | Latency hedge is a per-turn governor decision. Static toggle is too implementation-shaped. |
| Learned taste / prefs | `src/interface/menu-settings.ts:314`, `src/infra/config.ts:313` | keep-with-justification | Writes durable preference data. Default on is right, but privacy/data controls must remain accessible. Move under Privacy & memory. |
| Auto-goal | `src/interface/menu-settings.ts:315`, `src/infra/config.ts:140` | remove | Superseded by Auto smart default plus Goal Steward. A separate quality-first-only auto-goal switch creates redundant IA. |
| Partner style | `src/interface/menu-settings.ts:316`, `src/infra/config.ts:150` | remove | Redundant with Oversight, Auto judgment, and learned taste. The model should adapt conversational posture automatically. |
| Memory | `src/interface/menu-settings.ts:317`, `src/infra/config.ts:207` | keep-with-justification | Privacy kill-switch. Keep, but move under Privacy & memory. |
| Intent engine | `src/interface/menu-settings.ts:318`, `src/infra/config.ts:182` | default-on-and-hide | Core intelligence should be automatic. If off is needed for emergency, use a hidden rollback/basic escape hatch. |
| Oversight | `src/interface/menu-settings.ts:319`, `src/infra/config.ts:170` | keep-with-justification | Real autonomy/risk preference: review-all, checkpoint, autonomous. Keep prominent. |
| Theme | `src/interface/menu-settings.ts:320`, `src/infra/config.ts:190` | keep-with-justification | Accessibility/readability preference. Keep as Appearance. |

Visible settings outcome: 7 keep/grouped, 7 default-on-and-hide, 2 remove.

### Config-Key Audit

This table audits config keys from `src/infra/config.ts`. It separates durable user preferences from implementation flags that should not be normal settings.

| Config key | Source | Verdict | Reasoning |
| --- | --- | --- | --- |
| `onboarded` | `src/infra/config.ts:35` | keep internal | Setup state, not a setting. |
| `setAsDefault` | `src/infra/config.ts:36` | keep-with-justification | User chooses shell integration, but move to Setup. |
| `defaultShellOptOut` | `src/infra/config.ts:43` | keep internal | Migration/intent marker, not a setting. |
| `rollback` | `src/infra/config.ts:48` | keep hidden escape hatch | Emergency rollback is valid but should not clutter normal Settings. |
| `mode` | `src/infra/config.ts:50` | keep-with-justification | Global default for future conversations. Absent means Auto smart. |
| `intensity` | `src/infra/config.ts:52` | remove from UX | Numeric intensity is implementation language. Migrate to mode labels and per-conversation mode. |
| `autoUpdate` | `src/infra/config.ts:59` | default-on-and-hide | Keep opt-out for env/config, hide normal toggle. |
| `nativeSessions` | `src/infra/config.ts:67` | default-on-and-hide | Automate once stable; fail soft. |
| `experimentalVendorNeutralRouter` | `src/infra/config.ts:74` | default-on-and-hide | Routing should be product behavior, not user work. |
| `panel` | `src/infra/config.ts:86` | default-on-and-hide | Govern per turn through Auto. |
| `hedge` | `src/infra/config.ts:97` | default-on-and-hide | Govern per turn through Auto. |
| `verbosity` | `src/infra/config.ts:105` | keep-with-justification | Output preference. |
| `timeoutMs` | `src/infra/config.ts:111` | keep hidden advanced | Useful support escape hatch, not primary Settings. |
| `smartRoute` | `src/infra/config.ts:122` | default-on-and-hide | Better-on intelligence. |
| `learnRouting` | `src/infra/config.ts:134` | default-on-and-hide | Observed learner can no-op safely. |
| `autoGoal` | `src/infra/config.ts:140` | remove | Fold into Goal Steward/Auto. |
| `partnerStyle` | `src/infra/config.ts:150` | remove | Fold into Auto, taste, and oversight. |
| `oversight` | `src/infra/config.ts:170` | keep-with-justification | User autonomy preference. |
| `intentEngine` | `src/infra/config.ts:182` | default-on-and-hide | Core intelligence. |
| `colorTheme` | `src/infra/config.ts:190` | keep-with-justification | Accessibility/readability. |
| `codebaseAwareness` | `src/infra/config.ts:199` | keep-with-justification | Default on, but belongs under Privacy & memory because it controls local code context injection. |
| `memory` | `src/infra/config.ts:207` | keep-with-justification | Privacy kill-switch. |
| `memoryDefaultScope` | `src/infra/config.ts:211` | keep hidden advanced | Advanced memory policy, not normal Settings. |
| `memoryApproval` | `src/infra/config.ts:215` | keep hidden advanced | Privacy policy escape hatch. Normal default should be safe. |
| `memoryDecayDays` | `src/infra/config.ts:220` | keep hidden advanced | Tuning parameter, not normal Settings. |
| `memoryMaxFactsPerScope` | `src/infra/config.ts:225` | keep hidden advanced | Tuning parameter, not normal Settings. |
| `experimentalInk` | `src/infra/config.ts:233` | promoted (default ON via MYSHELL_INK; opt-out only) | Ink renderer is now the default (legacy via MYSHELL_INK=0 or experimentalInk:false). Docstring in config was stale vs actual default. |
| `experimentalBasic` | `src/infra/config.ts:246` | keep hidden escape hatch | Emergency simplification flag. |
| `experimentalScheduler` | `src/infra/config.ts:257` | default-on-and-hide | Goal scheduling should be automated. |
| `experimentalGovernor` | `src/infra/config.ts:270` | default-on-and-hide | Auto depends on governor behavior. |
| `experimentalVerify` | `src/infra/config.ts:285` | default-on-and-hide | Verification should be automatic when relevant. |
| `experimentalTrust` | `src/infra/config.ts:299` | default-on-and-hide | Trust receipt should be product behavior. |
| `experimentalTaste` | `src/infra/config.ts:313` | keep-with-justification | Durable preference data. Keep privacy control. |
| `experimentalJudgment` | `src/infra/config.ts:328` | default-on-and-hide | Judgment is core Auto behavior. |
| `experimentalUnifyPreflight` | `src/infra/config.ts:341` | default-on-and-hide | Internal orchestration simplification. |
| `experimentalRiskSignals` | `src/infra/config.ts:353` | default-on-and-hide | Better risk detection should be automatic. |
| `experimentalRequiredInvestigation` | `src/infra/config.ts:364` | default-on-and-hide | Better grounding should be automatic. |
| `experimentalPreflightGuard` | `src/infra/config.ts:375` | default-on-and-hide | Guardrails should be automatic. |
| `experimentalTribunal` | `src/infra/config.ts:389` | default-on-and-hide | Auto/governor should decide when rival builds are warranted. |
| `experimentalResearch` | `src/infra/config.ts:401` | default-on-and-hide | Research should be task-driven, not a normal toggle. |
| `experimentalBoard` | `src/infra/config.ts:411` | default-on-and-hide | Goal/board state should just work. |
| `experimentalAutoGoal` | `src/infra/config.ts:423` | remove | Duplicate of Goal Steward/Auto direction. |
| `experimentalUnderstanding` | `src/infra/config.ts:436` | default-on-and-hide | Whole-picture understanding is core intelligence. |
| `experimentalPlanningDepth` | `src/infra/config.ts:438` | default-on-and-hide | Auto should choose depth. |
| `experimentalItemParking` | `src/infra/config.ts:447` | default-on-and-hide | Blocking/clarify behavior should be automatic. |
| `experimentalTrulyComplete` | `src/infra/config.ts:464` | default-on-and-hide | Completion honesty should not be optional in normal UX. |
| `experimentalManager` | `src/infra/config.ts:479` | default-on-and-hide | Goal manager is part of Goal Steward. |
| `experimentalRoles` | `src/infra/config.ts:491` | default-on-and-hide | Model-role selection is internal orchestration. |
| `experimentalLevelDial` | `src/infra/config.ts:503` | remove from UX | Superseded by user-facing modes and Auto. |
| `experimentalDraftGoals` | `src/infra/config.ts:516` | default-on-and-hide | Drafting should be governed by Goal Steward. |
| `experimentalAutoBrain` | `src/infra/config.ts:533` | default-on-and-hide | Auto brain is product behavior. |
| `experimentalByproductFallback` | `src/infra/config.ts:549` | default-on-and-hide | Internal fallback, not a setting. |
| `experimentalProviderEffort` | `src/infra/config.ts:566` | default-on-and-hide | Provider effort is an Auto/governor lever. |
| `experimentalSubscriptions` | `src/infra/config.ts:573` | default-on-and-hide after rollout | Accounts are core product IA; keep hidden rollout flag only during migration. |
| `experimentalAccountParallelism` | `src/infra/config.ts:582` | default-on-and-hide | Account parallelism should be governed per turn. |
| `seen` | `src/infra/config.ts:591` | keep internal | First-touch bookkeeping, not a setting. |

## Goal Lifecycle Audit

### What Exists

Goal model:

- Goal lifecycle is documented as `parked -> queued -> running -> done | failed` at `src/core/goal-todo.ts:10`.
- Actual states also include `blocked` and `superseded` at `src/core/goal-todo.ts:43`.
- A goal owns its roadmap at `src/core/goal-todo.ts:104`.
- `createdAt` and `lastTouched` exist at `src/core/goal-todo.ts:116`.

Store:

- Goals are born parked at `src/infra/goal-store.ts:503`.
- `setState` bumps `lastTouched` but only records state at `src/infra/goal-store.ts:539`.
- The store explicitly does not execute a goal roadmap at `src/infra/goal-store.ts:311`.

Display and staleness:

- Staleness is a pure age check at `src/core/goal-todo.ts:465`.
- The default stale window is 30 days at `src/core/goal-todo.ts:461`.
- Stale parked goals are only dimmed in the parked section at `src/commands/goals.ts:147`.

Goal context:

- Chat has a lazy `currentGoalContext` snapshot at `src/interface/menu.ts:2115`.
- `formatGoalsForContext` injects current goals into the prompt at `src/core/goal-todo.ts:697`.
- The injected context says the partner owns these goals at `src/core/goal-todo.ts:754`.

Goal operation paths:

- `/goals` lists running, queued, and parked goals at `src/commands/goals.ts:158`.
- `/todo` creates a parked goal at `src/commands/goals.ts:216`.
- `/goals go <n>` promotes a parked goal to running and calls `runGoalLoop` at `src/interface/menu.ts:5924`.
- If completion is verified, it sets the goal done at `src/interface/menu.ts:5960`.
- If not completed, the goal can stay running for later revisit at `src/interface/menu.ts:5957`.
- Background goals set done only if verified; otherwise the notification says paused at `src/interface/menu.ts:3835`.
- Draft goals can be created inactive after a successful turn at `src/interface/menu.ts:6403`.

Planning and re-planning:

- The planning brain can stage goals or ask one clarifying question at `src/core/goal-plan.ts:6`.
- Goal proposal rendering is concrete at `src/core/goal-proposal.ts:119`.
- Replan can maintain a goal's to-do list before the manager cycle at `src/core/goal-replan.ts:6`.
- Replan is scoped to a running manager cycle, not a session-start audit.

Meta decision:

- The DecisionEngine sees goals in full context at `src/interface/menu.ts:3327`.
- It can accept, pause, background, adjust, clarify, or plan based on the current user input at `src/interface/meta-decision.ts:211`.
- Mutating actions require authorization from the literal current user line at `src/interface/meta-decision.ts:152`.

### What Is Missing

There is no mechanism that proactively revisits existing goals on session start or home.

Specifically absent:

- No startup pass that scans `parked`, `queued`, `running`, or `blocked` goals and classifies stale/inactive ones.
- No automatic detection that a `running` goal has no active background controller after restart.
- No action policy for stale goals: resume, clarify, complete, cancel, or leave alone.
- No home/session prompt that says "this conversation has a stale goal that needs review" before normal chat.
- No goal steward loop that advances a goal unless the user explicitly invokes `/goals go`, accepts a plan, or a background launch is already started.

The owner's "floating inactive goal" report matches the code: the system can create inactive/parked goals, display them, and include them in prompt context, but it does not own their lifecycle after creation.

## Goal Management Intelligence Design

Introduce a Goal Steward layer. It should be conservative at first: audit and surface before it mutates. It should become more autonomous only when Auto and oversight settings permit it.

### Goal Steward Responsibilities

1. Audit live goals:
   - `parked`, `queued`, `running`, and `blocked`.
   - scoped to current conversation first, then current project.
   - classify stale using `lastTouched`.
   - classify inactive running goals after process restart or missing background controller.

2. Decide next best action:
   - `resume`: goal is still relevant, unblocked, and owner intent is clear.
   - `ask`: goal is stale, ambiguous, blocked, or likely outdated.
   - `complete`: only when existing evidence already proves completion, for example verified goal verdict.
   - `cancel/supersede`: only with explicit user confirmation unless a later policy adds safe auto-supersession.
   - `no-op`: recent or low-value goals.

3. Surface in the right place:
   - Home: conversation badges only, no goal list.
   - Conversation open: concise goal review card before the prompt.
   - During chat: current goals remain in prompt context.
   - Library: conversation detail can show linked goals.

4. Feed Auto:
   - Goal state becomes an input to per-turn judgment.
   - A stale active goal should raise the chance of an `ask` or `resume` action when the user reopens that conversation.
   - Explicit Budget/Balanced/High/Max modes still bound how much work Auto can spend.

### Goal Steward Data Shape

Add a pure core decision type later, for example:

```ts
type GoalStewardFinding =
  | { kind: 'healthy'; goalId: string }
  | { kind: 'stale-parked'; goalId: string; ageDays: number }
  | { kind: 'inactive-running'; goalId: string; ageDays: number }
  | { kind: 'blocked'; goalId: string; reason: 'clarify' | 'dependency' | 'unverifiable' }
  | { kind: 'verified-complete'; goalId: string };

type GoalStewardRecommendation =
  | { action: 'surface'; goalIds: string[] }
  | { action: 'ask'; goalId: string; question: string }
  | { action: 'resume'; goalId: string }
  | { action: 'mark-done'; goalId: string; evidence: string }
  | { action: 'cancel-confirm'; goalId: string; reason: string }
  | { action: 'none' };
```

The first implementation can be purely deterministic:

- stale if `isStale(goal, nowIso)` is true;
- inactive running if state is `running` and there is no in-memory background controller for that id;
- blocked reason via existing `itemBlockReason` at `src/core/goal-manager.ts:170`;
- verified complete via `goal.goalVerdict` and `isGoalVerifiedDone` at `src/core/goal-todo.ts:95`.

### Conversation-Open UX

When a conversation opens and linked live goals exist:

```
Goals for this conversation
  1. v3.159 menu IA redesign       running, inactive since Jun 24
     Suggested: review and resume

  [r] Resume  [a] Ask what changed  [d] Dismiss for now  [x] Cancel goal
```

For a parked stale goal:

```
Goal review
  "OpenCode setup cleanup" has been parked for 42 days.

  [r] Resume it
  [u] Update the goal first
  [x] Cancel it
  [Enter] Skip
```

For a blocked goal:

```
Goal needs input
  "Harden auth refresh" is blocked on:
  Clarify: which token path should remain supported?

  Answer now, or press Enter to skip.
```

### Smallest First Slice

Ship the first slice behind `MYSHELL_GOAL_STEWARD=1` / `experimentalGoalSteward`.

Scope:

- Add a pure audit function that reads already-stored fields and returns findings.
- Home only adds conversation badges, no goal titles.
- On conversation open, show one review prompt for the highest-priority linked stale/inactive/blocked goal.
- No autonomous resume.
- No model call.
- The only automatic mutation allowed is `verified-complete -> done`, and only when `goalVerdict` is already `passing` or `reviewed`.

Why this first:

- It solves the "floating inactive goal" problem visibly.
- It keeps owner control.
- It uses existing fields and store methods.
- It does not change model routing or goal execution semantics.

### Later Intelligence Slice

Once the deterministic audit is trusted:

- Add a manager-tier Goal Steward model call only when deterministic rules say the goal is stale/ambiguous and the answer is not obvious.
- Feed findings into the DecisionEngine full context.
- Add a new meta intent such as `goal_steward_review`, but keep mutations authorized by user selection unless oversight is autonomous.
- Let Auto choose whether to resume in background, ask, or leave parked.

## Phased Build Plan

### Phase 0: Doc and Baselines

Flag: none.

- Land this design doc.
- Add golden snapshots later before behavior changes.
- No source behavior change.

### Phase 1: Home IA Cleanup

Flag: `MYSHELL_MENU_IA_V3=1`, config `experimentalMenuIaV3`.

- Add `New conversation default: Auto (smart)` to the main panel.
- Add per-conversation mode labels to every conversation row: `auto`, `budget`, `balanced`, `high`, or `max`.
- Hide the home parked-goals section currently rendered at `src/interface/menu-render.ts:145`.
- Remove home `[g] Manage goals` currently inserted at `src/interface/menu-render.ts:203`.
- Remove top-level Diagnose and Usage rows currently inserted at `src/interface/menu-render.ts:210`.
- Keep CLI `doctor` and `cost`.
- Keep legacy menu when flag is off.

Shippable result: cleaner home with mode visible at a glance and no source/test behavior change outside flag.

### Phase 2: Provider/Accounts Header

Flag: same as Phase 1 or `MYSHELL_PROVIDER_STATUS_V2=1`.

- Replace `ready` wording in `renderHeaderLines`.
- Add account summary when subscriptions are enabled.
- Collapse Auth rows into `[a] Accounts`.
- Move provider install/sign-in actions into the Accounts screen.
- Keep `[j]/[k]/[o]/[p]` handlers internally during transition for backward test coverage, but stop advertising them in the v3 IA.

Shippable result: status reflects installed/auth/account state honestly.

### Phase 3: Remove Usage and Diagnose From Primary IA

Flag: same as Phase 1.

- Remove `$` from home and do not show tokens as a primary panel item.
- Keep `myshell-tools cost` for support.
- Remove `[d]` from home.
- Add `Repair` inside Accounts or Settings only when `healthIssues.length > 0`.
- If a user explicitly runs CLI `doctor --fix`, keep full repair behavior.

Shippable result: less clutter, no loss of advanced diagnostics.

### Phase 4: Auto Smart Default

Flag: `MYSHELL_AUTO_SMART=1`, config `experimentalAutoSmart`.

- Make fresh install default Auto smart with no setup-time mode question.
- Display unset `config.mode` as `Auto (smart)`, not resolved Max/Balanced.
- Treat main-menu `[m]` as the default mode for future new conversations only.
- Add Library -> Conversation -> Change mode for per-conversation mode.
- Keep explicit persisted modes unchanged.
- Add UI labels Budget/Balanced/High/Max.
- Initially leave High hidden or experimental if no policy exists.
- Route Auto through per-turn governor/intensity decisions instead of selecting a fixed preset up front.
- Plan-derived subscription info becomes capacity/headroom, not Auto's identity.

Shippable result: default Auto feels smart, fresh installs start in Auto, and mode scope is no longer ambiguous.

### Phase 5: Settings Simplification

Flag: `MYSHELL_SETTINGS_V3=1`, config `experimentalSettingsV3`.

- Replace the 16-row toggle pile with the simplified Settings page.
- Keep only New conversation mode, Oversight, Output detail, Appearance, and Privacy & memory on the primary page.
- Default-on-and-hide routing, panel, hedge, learned routing, native sessions, update-on-launch, and intent engine.
- Remove Auto-goal and Partner style as separate settings.
- Keep hidden config/env escape hatches for rollback, timeout, and managed-environment needs.

Shippable result: settings becomes a small preference page instead of an implementation control panel.

### Phase 6: Goal Steward Deterministic Audit

Flag: `MYSHELL_GOAL_STEWARD=1`, config `experimentalGoalSteward`.

- Add pure audit over goals by conversation/project.
- Add conversation-row badges only.
- Show one conversation-open review prompt for stale/inactive/blocked goals.
- Do not auto-run.
- Allow evidence-only auto-mark-done when `goalVerdict` is already verified.

Shippable result: stale goals stop floating invisibly.

### Phase 7: Goal Steward + Auto Integration

Flag: `MYSHELL_GOAL_STEWARD=1` and `MYSHELL_AUTO_SMART=1`.

- Feed steward findings into DecisionEngine full context.
- Add goal-steward action recommendations.
- Let Auto decide whether to ask, resume foreground, resume background, or no-op based on goal state, task shape, risk, oversight, and provider headroom.
- Explicit Budget/Balanced/High/Max modes remain overrides.

Shippable result: the judgment system actually manages goals instead of merely remembering them.

### Phase 8: Stabilize and Retire Legacy IA

Flag: defaults on after snapshot/test confidence.

- Make v3 IA default.
- Keep CLI doctor/cost.
- Keep old config mode values readable.
- Remove old home Auth rows and top-level usage/doctor only after migration period.
- Retire settings toggles that are now automated default-on internals.

## Final Recommended Product Shape

Home is a numbered conversation launcher with provider/account readiness, the global new-conversation default mode, and each conversation's own mode. Goals are hidden until the user opens a conversation, except for compact conversation badges. Accounts are one top-level entry. Auto is the fresh-install default and makes per-turn effort decisions. Doctor and Cost remain support/CLI tools, not home-screen features. Settings are reduced to real user preferences. Goal Steward owns stale/inactive goal review, starting with deterministic audit and later integrating with Auto.
