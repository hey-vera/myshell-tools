# myshell-tools Home Menu Redesign Audit

Scope: main menu / home screen only. This audit is based on the current render code, not just the screenshot.

## Source Map

The current home screen is built here:

- `src/interface/menu-render.ts:48-163` - `renderMainScreen()`, the top-level home screen assembler.
- `src/interface/menu-display.ts:188-228` - `renderHeaderLines()`, provider/auth lines inside the box.
- `src/interface/menu-display.ts:245-272` - `renderBudgetLine()`, usage/empty-state line including "No runs yet".
- `src/interface/menu-display.ts:329-355` - `renderConversationList()`, numbered recent conversation rows.
- `src/ui/tui.ts:132-157` - `box()`, the double-line header box.
- `src/ui/tui.ts:236-253` - `menu()`, grouped action sections with repeated `--- Section` separators.
- `src/infra/health.ts:136-155` - migration warning message authoring.
- `src/interface/menu.ts:7133-7211` - dispatch for `[q]`, `[n]`, `[c]`, and `[1-9]`.
- `src/interface/ui/BottomLegend.tsx:10-18` and `src/interface/ui/InputBox.tsx:208-220,536-548` - chat-screen left/right arrow affordances that are not taught on the home screen.
- `src/interface/menu-settings.ts:121-135` - mode picker confirmation string, another copy of "New conversation default".

## Brutally Honest Verdict

The current screen is not a menu; it is a startup log, status panel, empty-state prompt, settings summary, health summary, recents list, and command reference dumped in sequence. The user is right: this is clunky because the layout has no opinion about what the user is supposed to do next.

The biggest flaw is information architecture. Persistent state belongs in the header. Workable choices belong next to the objects they operate on. Warnings belong in a subdued notices area unless they block action. Right now those layers are interleaved, so every line competes with every other line.

## Severity-Ranked Issues

### 1. P0 - Terminology is broken: "runs" vs "conversations"

Source: `src/interface/menu-display.ts:257-261`.

`renderBudgetLine()` returns `No runs yet - press n to start` when `spend.calls === 0`. This is wrong on three levels:

- The primary object on this screen is a conversation, not a run.
- The command section says `Conversations`; the empty state says `runs`; the recent section says `conversations`.
- The condition is usage-ledger based, not conversation-store based. A user could have conversations but zero counted provider calls, or usage loading could make this line conceptually detached from the list below.

This is the line that makes the product feel internally confused.

### 2. P0 - The header box is wasted on low-value auth inventory

Source: `src/interface/menu-render.ts:51-55`, `src/interface/menu-display.ts:188-228`, `src/ui/tui.ts:132-157`.

The box gets the highest visual weight on the screen. It currently says:

- product/version
- four provider auth statuses

That is not enough to justify the visual mass. Worse, the useful state a user needs before starting a conversation is outside the box:

- default mode: `src/interface/menu-render.ts:91-104`
- accounts/health summary: `src/interface/menu-render.ts:107-123`
- key hints: absent from legacy home, despite existing elsewhere in Ink UI

The result is an expensive header and a messy body.

### 3. P0 - Mode/default is duplicated and split across body and controls

Sources:

- `src/interface/menu-render.ts:91-104` - `New conversation default: Auto (smart) ... press m to change`
- `src/interface/menu-render.ts:157` - `[m] New conversation mode: Auto (smart)`
- `src/interface/menu-settings.ts:133-134` - mode picker confirmation: `New conversation default: ...`

The screen repeats the same concept twice with slightly different labels: "default" and "mode". One is passive status, one is command, but they are not visually connected. This is exactly the kind of duplication that makes a TUI feel assembled instead of designed.

### 4. P0 - The migration warning is visually over-promoted

Sources:

- `src/infra/health.ts:136-155` authors the warning.
- `src/interface/menu-render.ts:71-75` prints every health issue immediately under the header.

`State migration had 1 conflict(s). Old files were preserved - see <path>` is not a stop-the-world warning for most users. It is a notice. Putting it directly under the largest visual element makes it feel like danger before the user has context. The copy also sounds internal and bureaucratic.

Better: one subdued notice line below the header, with a short label and a clear destination: `Notice: state migration kept old files. Run doctor for details.` The full path belongs in the detailed health/doctor surface, not on the home screen. If the product wants this reachable from home, add a deliberate `[h] Health` command instead of leaving `Health: 1 issue` as inert text.

### 5. P1 - `[1-9] Open numbered` is in the wrong place

Sources:

- `src/interface/menu-render.ts:126-140` renders Recent rows.
- `src/interface/menu-render.ts:150-161` renders the command menu.
- `src/interface/menu.ts:7188-7211` dispatches numeric keys against `metas[digit - 1]`.

Number keys operate on the visible Recent list, but the hint is separated from that list and buried inside the Conversations command group. This is why it feels awkward. The affordance belongs in the Recent header or as a tiny hint directly under the list, not as a global menu item.

Also, empty state still prints `[1-9] Open numbered`, which is nonsensical when there are no numbered rows.

### 6. P1 - Empty state is passive and split-brained

Sources:

- `src/interface/menu-render.ts:77-87` unauthenticated CTA.
- `src/interface/menu-display.ts:257-261` empty usage/status line.
- `src/interface/menu-render.ts:131-135` empty recent list.
- `src/interface/menu.ts:7182-7184` continue-last fallback.

For a signed-in first-time user, the screen says both:

- `No runs yet - press n to start`
- `(no conversations yet)`

That is redundant and semantically misaligned. For an unauthenticated user it says:

- `Not signed in yet - press [a] Accounts to get started`
- `Sign in to begin`
- `(no conversations yet)`

That is three empty-state fragments instead of one decisive next step.

### 7. P1 - Visual hierarchy is upside down

Source: `src/interface/menu-render.ts:55-161`.

The order is:

1. box
2. update warnings
3. health warnings
4. sign-in CTA
5. usage or empty usage
6. default mode
7. accounts/health summary
8. Recent
9. menu sections

This reads like implementation order, not user priority. The product should answer:

1. Am I ready?
2. What happens if I press `n`?
3. What can I continue?
4. What other commands are available?

The current screen answers those questions in fragments.

### 8. P1 - "Accounts | Health" is dead text with weak information scent

Source: `src/interface/menu-render.ts:107-123`.

`Accounts | Health: 1 issue` is dimmed status text, not an action, even though Accounts is actionable via `[a]` and Health presumably belongs under diagnostics/settings. If it is a status, it belongs in the header. If it is a command, it needs a key. As written, it is neither.

### 9. P1 - Provider status is too verbose for the home surface

Source: `src/interface/menu-display.ts:196-216`.

Four provider lines are useful during setup, but once the user is signed in, listing `claude: signed in / codex: signed in / opencode: signed in / grok: signed in` consumes prime space without answering the important question: "Can I start?" A compact summary is better:

`Providers: 4 ready (claude, codex, opencode, grok)`

Provider-level detail belongs behind `[a] Accounts`.

### 10. P1 - The command menu is a taxonomy, not a command surface

Sources:

- `src/interface/menu-render.ts:150-161`
- `src/ui/tui.ts:236-253`

`menu()` groups every command under repeated section separators. That creates a lot of vertical chrome for eight commands. The main menu needs scannable primary actions, not a taxonomic list. The current structure makes `[n] New` and `[q] Quit` visually equivalent.

### 11. P2 - Key hints are incomplete and inconsistent across app surfaces

Sources:

- Home screen has no arrow hints in `src/interface/menu-render.ts:150-161`.
- Chat Ink legend has arrows in `src/interface/ui/BottomLegend.tsx:10-18`.
- Empty-buffer arrow behavior is implemented in `src/interface/ui/InputBox.tsx:208-220,536-548`.
- Ctrl+C model is documented in `src/interface/menu-display.ts:387-408`.

Users should not have to discover left/right arrows and rapid Ctrl+C behavior by accident. However, the home screen should not dump a manual either. Put a compact "Keys" row in the header:

`Keys: n new | 1-7 open recent | a accounts | m mode | q quit`

For chat-only keys, use:

`Chat: left back | right panel | Ctrl+C x2 menu | x3 exit`

Do not say "Ctrl+C twice = exit" unless the code is changed. Current code says count 2 means menu and count 3 means exit.

### 12. P2 - Update copy is too large for the home screen

Source: `src/interface/menu-render.ts:57-69`.

The `npx` update block is three lines plus a command. That may be correct once, but it is too much for the main home frame. It should collapse to a notice line and let `[u]` or Health/Settings carry details.

### 13. P2 - "Recent" and "Conversations" fight each other

Sources:

- `src/interface/menu-render.ts:126-140` section label `Recent`.
- `src/interface/menu-render.ts:151-155` section label `Conversations`.

There are recent conversations and conversation commands. The two headers look like peer sections, but one is content and the other is commands. Better:

- Body section: `Recent conversations`
- Action row: `n New conversation | c Continue last | e Library`
- Numeric hint belongs with `Recent conversations`.

### 14. P2 - Rows are dense in the wrong ways

Source: `src/interface/menu-display.ts:335-355`.

Conversation rows include number, pin spacer, time, title, category, mode, message count, goal status, and optional recap. This is defensible for a library view, but heavy for a home screen. On home, keep rows short:

`[1] 2h  Fix auth refresh regression        auto  42 msgs`

Move category/goal/recap to Library or a second dim line only when truly valuable.

### 15. P2 - The design does not adapt enough to empty vs populated states

Source: `src/interface/menu-render.ts:126-161`.

The same command block is rendered whether there are zero or seven conversations. Empty state should not show numeric-open hints. Populated state should make numbers prominent and reduce generic `Continue last` emphasis.

## Terminology Decision

Use `conversation` for the user-facing home screen.

Justification:

- The persistent object is already `ConversationMeta`.
- The home menu already has `Recent`, `Conversations`, `Continue last`, and `Library`.
- `run` is overloaded internally: provider calls, one-shot CLI runs, model invocations, and background work. It is not the right noun for a user choosing what to open.
- Usage can still say `provider calls` where it is explicitly about ledger/accounting, but the empty state must not say `runs`.

Concrete rule:

- Home screen: `conversation`, `recent`, `message`, `provider`, `account`, `mode`.
- Usage/accounting: `provider call`, `tokens`.
- One-shot CLI help may keep `run` for the command name only.

## Redesign Principles

1. The box owns persistent state: version, readiness, default mode, provider/account health, and global key hints.
2. The body owns user work: recent conversations and the primary action row.
3. Notices are calm and secondary unless blocking.
4. Numeric shortcuts live with numbered rows.
5. Empty state is one coherent block, not three fragments.
6. Home is not a settings page. It should show the current default and the key to change it, not explain the whole policy.

## Proposed Empty-State Home

ASCII-only mockup:

```text
+------------------------------------------------------------------+
| myshell-tools v3.162.0 (latest)                                  |
| Ready: 4 providers signed in                                     |
| New conversation: Auto (smart)  [m] change                       |
| Accounts: 4 ready  |  Health: 1 notice  [a] accounts             |
| Keys: n new  |  e library  |  s settings  |  q quit              |
+------------------------------------------------------------------+

Notice: state migration kept old files. Run doctor for details.

Recent conversations
  No conversations yet.

  [n] New conversation
  [e] Open library
```

Unauthenticated empty-state variant:

```text
+------------------------------------------------------------------+
| myshell-tools v3.162.0 (latest)                                  |
| Not ready: no provider signed in                                 |
| New conversation: Auto (smart)  [m] change                       |
| Accounts: action needed  [a] sign in                             |
| Keys: a accounts  |  s settings  |  q quit                       |
+------------------------------------------------------------------+

Sign in to start conversations.

Recent conversations
  No conversations yet.

  [a] Accounts / Sign in
```

Notes:

- There is no `No runs yet`.
- There is no `[1-9]` hint because there are no rows.
- The migration notice is demoted and shortened.
- The mode line appears once, in the header.
- Auth readiness is summarized, not listed as four noisy provider strings.

## Proposed Populated-State Home

ASCII-only mockup:

```text
+------------------------------------------------------------------+
| myshell-tools v3.162.0 (latest)                                  |
| Ready: 4 providers signed in                                     |
| New conversation: Auto (smart)  [m] change                       |
| Usage today: 2 provider calls, 18.4k tokens                      |
| Accounts: 4 ready  |  Health: OK  |  q quit                      |
+------------------------------------------------------------------+

Recent conversations                         press 1-7 to open
  [1] 12m  Finish install flow tests             auto   18 msgs
  [2] 3h   Audit provider auth fallback          max    42 msgs
  [3] 1d   Menu IA redesign                      auto    9 msgs

Actions
  [n] New conversation   [c] Continue last   [e] Library
  [a] Accounts           [s] Settings
```

Optional chat-navigation hint, only if the product wants home to teach chat controls:

```text
Chat keys: Left returns to menu, Right opens control panel, Ctrl+C x2 menu, x3 exit.
```

I would not include that line in the normal populated home unless user research shows people miss it. If included, put it in the header, not as another body section.

## What Moves Into The Box

Move in:

- Version and update status.
- Readiness summary: signed-in provider count, or "Not ready".
- New conversation default: mode label and `[m] change`.
- Accounts summary and health count.
- Compact top-level key hints.
- Optional usage-today line when nonzero.

Keep out:

- Full provider-by-provider auth details. Put them under Accounts.
- Full migration manifest paths. Put them under Health.
- Recent conversations. They are the body.
- Long update install commands. Put them behind `[u] update` or Health/Settings.

## Key-Hint Placement

Use three tiers:

1. Header keys: global from home - `n`, `a`, `m`, `s`, `q`.
2. Recent-list keys: numeric shortcuts, shown only when rows exist - `press 1-7 to open`.
3. Chat keys: only in chat chrome or a compact home header hint if necessary - Left, Right, Ctrl+C model.

Important correction: current Ctrl+C behavior is not "twice = exit". `src/interface/menu-display.ts:406-408` maps:

- one press: cancel/hint
- two rapid presses: return to menu
- three rapid presses: exit app

Do not teach a false shortcut in the redesign.

## Actionable Change Plan

### 1. Rename the empty-state line

Files:

- `src/interface/menu-display.ts`
- `test/unit/menu.test.ts`
- `test/unit/menu-render.test.ts`

Edit:

- Change `renderBudgetLine()` zero-call authenticated result from `No runs yet - press n to start` to either:
  - `No conversations yet. Press n to start one.`, or preferably
  - remove this line from the body and let the Recent empty-state own it.

Risk: low if string-only. Medium if `renderBudgetLine()` is re-scoped from empty-state to usage-only because tests assume it handles first-run state.

Blast radius: menu render tests and any PTY snapshot/string assertions.

### 2. Build a home header view model

Files:

- `src/interface/menu-render.ts`
- likely `src/interface/menu-display.ts`

Edit:

- Add a helper such as `renderHomeHeaderLines({ env, config, spend, healthIssues, accountStates, authed, spendLoading })`.
- Feed that into `box()` instead of raw `renderHeaderLines()`.
- Keep `renderHeaderLines()` for Accounts or doctor-like detailed status, but stop using it directly on home.

Risk: medium. The code is pure render, but tests assert auth text appears in the home header after login.

Blast radius: `test/unit/menu.test.ts`, `test/unit/menu-render.test.ts`, `test/unit/menu-flow.test.ts` assertions around `signed in`.

### 3. Remove duplicated mode body line

Files:

- `src/interface/menu-render.ts`
- `test/unit/menu-render.test.ts`

Edit:

- Delete or relocate lines `91-104`.
- Keep `[m]` as a command, but label it `Mode` or `[m] Change mode`, not `New conversation mode: Auto (smart)` if the header already shows the value.

Risk: low to medium. Main risk is tests checking `Auto (smart)` and `per-turn effort...` in the body.

Blast radius: render tests for auto-smart suffix.

### 4. Collapse account and health body summary into header

Files:

- `src/interface/menu-render.ts`

Edit:

- Move lines `107-123` into the new header helper.
- Make the header line actionable: `Accounts: 4 ready [a]` and `Health: 1 notice`.

Risk: low.

Blast radius: string assertions only.

### 5. Demote health and migration copy

Files:

- `src/interface/menu-render.ts`
- `src/infra/health.ts`
- `test/unit/health.test.ts`

Edit:

- For `migration-conflicts`, change home rendering to a short notice. Do not necessarily change `HealthIssue.message` if other commands need full detail.
- Better: add optional `shortMessage` or a render helper in `menu-render.ts` that maps known health IDs to home-safe copy.
- Render warnings under a `Notice:` line, not a warning icon pile directly under the header.

Risk: medium. Health messages may have tests that expect exact text.

Blast radius: health tests, menu render snapshots/string checks.

### 6. Put numeric shortcut hint on the Recent header

Files:

- `src/interface/menu-render.ts`
- possibly `src/ui/tui.ts` if adding a right-aligned section header helper

Edit:

- Replace `separator('Recent')` with a home-specific line:
  - `Recent conversations                         press 1-7 to open`
- Only show numeric hint when `convLines.length > 0`.
- Remove `{ key: '1-9', label: 'Open numbered', section: 'Conversations' }` from the global menu.

Risk: low. Dispatch remains unchanged at `src/interface/menu.ts:7188-7211`.

Blast radius: menu-render tests and any docs/smokes that expect `[1-9]`.

### 7. Replace generic `menu()` for the home screen

Files:

- `src/interface/menu-render.ts`
- leave `src/ui/tui.ts` alone unless other menus need grouped rendering

Edit:

- Stop using `menu()` for the home screen.
- Render a compact action block manually so primary actions can sit on one line:
  - `[n] New conversation   [c] Continue last   [e] Library`
  - `[a] Accounts           [s] Settings        [q] Quit`
- Hide `[c] Continue last` when there are zero conversations, or dim/disable it explicitly.

Risk: medium because tests may assert section labels are absent/present.

Blast radius: `test/unit/menu-render.test.ts`, PTY smoke expectations.

### 8. Simplify provider status on home

Files:

- `src/interface/menu-display.ts`
- `src/interface/menu-render.ts`

Edit:

- Add a compact provider summary:
  - `Ready: 4 providers signed in`
  - `Not ready: no provider signed in`
  - `Partial: 1 provider signed in, 2 need sign-in`
- Keep full provider list in Accounts.

Risk: medium. Existing tests explicitly assert `claude: signed in` appears after login.

Blast radius: menu-flow tests around auth refresh and onboarding.

### 9. Separate usage from conversation empty state

Files:

- `src/interface/menu-display.ts`
- `src/interface/menu-render.ts`

Edit:

- Make `renderBudgetLine()` return usage only:
  - loading
  - nonzero usage
  - empty string/null when no usage
- Render conversation empty state based on `metas.length`, not ledger calls.

Risk: medium because `renderBudgetLine()` has direct unit tests.

Blast radius: unit tests for zero spend, main-screen output.

### 10. User judgment required: broader terminology sweep

Files:

- `src/interface/*`
- `src/core/*`
- `src/commands/*`
- tests and docs

Question:

- Should only the home screen use `conversation`, or should the whole product rename user-facing `run` language where it does not refer to the literal `myshell run` command?

Recommendation:

- Phase 1: fix home screen only.
- Phase 2: audit all user-facing `run/runs` strings and classify them:
  - keep: command names and internal/provider execution
  - rename: user-visible saved work, chat history, and first-run empty states

Risk: high if done broadly. The word `run` appears across orchestration, provider calls, tests, and docs. A global rename would be noisy and easy to overdo.

## Suggested Implementation Order

1. Add tests for the desired home screen shape before editing strings.
2. Introduce compact header helper.
3. Move mode/account/health summaries into header.
4. Replace body empty-state logic with conversation-store-based logic.
5. Move numeric hint to Recent header and remove `[1-9]` global command row.
6. Demote migration warning rendering.
7. Update PTY smoke expectations.
8. Only then consider broader terminology cleanup.

## Acceptance Criteria

- Empty signed-in home contains `No conversations yet`, not `No runs yet`.
- Empty signed-in home shows one primary next action: `[n] New conversation`.
- Empty unauthenticated home shows one primary next action: `[a] Accounts / Sign in`.
- Header contains the current new-conversation mode exactly once.
- Body does not contain both a mode status line and a mode command with duplicated value.
- `[1-9]` hint appears only when recent numbered rows exist, and appears adjacent to those rows.
- Migration conflicts render as a calm notice on home, with full details available elsewhere.
- Home screen still exposes Accounts, Settings, Library, and Quit without requiring help.

## v2 (10/10 pass)

### Brutal Self-Critique Of v1

v1 was cleaner than the current screen but still awkward: the `+---+` ASCII made it look like a design sketch instead of the product, the five-line header tried to hold readiness, mode, accounts, health, usage, and keys at once, and the result was a cramped status sandwich rather than a brain-dead-simple menu. It also kept too much v1 baggage: `Health: 1 notice`, `Run doctor for details`, and a decorative "Actions" block that still made the user parse categories instead of just choosing. The mockup had alignment, but not discipline. It reduced clutter without establishing a single obvious next action.

### Why The Reference Reads Clean

The Steve Moraco reference works because it is operationally humble:

- One stable key legend up top.
- A tiny Recent list.
- A flat command list with the key in the same left column every time.
- One `Choice:` prompt.

The awkward parts are also clear: two stacked top boxes and a mid-screen title box are too much ceremony. For myshell-tools, keep the stable legend and flat choice model, but use one product box only.

### v2 Empty State

Signed in, no conversations:

```text
╔════════════════════════════════════════════════════════════════════╗
║  myshell-tools v3.162.0 (latest)                                  ║
╠════════════════════════════════════════════════════════════════════╣
║  Keys: n=new  c=continue  1-9=open recent  a=accounts  q=quit      ║
║  Chat: Ctrl+C x2=menu  Ctrl+C x3=exit                              ║
║  Ready: claude codex opencode grok  |  New: Auto (smart)           ║
╚════════════════════════════════════════════════════════════════════╝

Recent
  No conversations yet.

  [n] New conversation
  [e] Library
  [a] Accounts

Choice:
```

Not signed in, no conversations:

```text
╔════════════════════════════════════════════════════════════════════╗
║  myshell-tools v3.162.0 (latest)                                  ║
╠════════════════════════════════════════════════════════════════════╣
║  Keys: a=sign in  s=settings  q=quit                               ║
║  Chat: Ctrl+C x2=menu  Ctrl+C x3=exit                              ║
║  Not ready: sign in to start conversations                         ║
╚════════════════════════════════════════════════════════════════════╝

  [a] Sign in
  [s] Settings

Choice:
```

Design call: the unauthenticated empty state should not show `n`, `c`, or `1-9`. They are not the next step. The one obvious action is sign in.

### v2 Populated State

```text
╔════════════════════════════════════════════════════════════════════╗
║  myshell-tools v3.162.0 (latest)                                  ║
╠════════════════════════════════════════════════════════════════════╣
║  Keys: n=new  c=continue  1-9=open recent  a=accounts  q=quit      ║
║  Chat: Ctrl+C x2=menu  Ctrl+C x3=exit                              ║
║  Ready: 4 providers  |  New: Auto (smart)  |  Today: 2 calls       ║
╚════════════════════════════════════════════════════════════════════╝

Recent
  [1] 12m  Finish install flow tests
  [2] 3h   Audit provider auth fallback
  [3] 1d   Menu home redesign

  [c] Continue last       claude:9a03cdbc
  [n] New conversation
  [e] Library
  [a] Accounts
  [m] Mode                Auto (smart)

Choice:
```

This is intentionally flatter than v1. No Health row. No warning block. No duplicate `New conversation default`. No `[1-9] Open numbered` command floating away from the numbered rows. Recent rows teach numbers by existing.

### Self-Healing Health / Doctor Model

The product should stop making health a visible user chore. Startup should silently prevent breakage, repair what it can, and only ask the user when the tool cannot proceed without a real human choice.

Auto-resolve silently:

- State migration copies, JSONL dedupe merges, conflict archiving, and manifest writing.
- Pricing cache staleness.
- Gitignore protection for `.myshell-tools/`.
- Default-shell hook repair when the user has already opted in.
- Provider-home persistence setup.
- Non-fatal update checks.

Surface only when unavoidable:

- State directory is not writable and no fallback can be selected automatically.
- Ledger directory is not writable and usage/history would be lost.
- Node is below the supported runtime and continuing is genuinely unsafe.
- No provider is signed in when the user tries to start a conversation.
- A credential conflict exists and the currently active credentials fail auth, meaning the user must choose/sign in again.

Migration-conflict case:

- Current code already preserves both sides: `src/infra/state-migration.ts:574-595` keeps the destination active and copies the source into `migration/conflicts`.
- Treat that as successful self-healing, not a home-screen warning.
- Rename the resulting status away from user-danger language. Suggested statuses:
  - `complete`
  - `complete-with-archive`
  - `partial`
- Do not push `State migration had 1 conflict(s)` through `evaluateHealth()`.
- If a conflicting file is non-secret and mergeable, merge deterministically.
- If it is secret or non-mergeable, keep the active destination, archive the old source, and continue. If auth works, say nothing. If auth fails later, Accounts owns the repair.

Doctor verdict:

Delete the user-facing Doctor/Health surface from the home menu and normal docs. Keep a hidden `doctor/status/check --fix` support and CI entry point for diagnostics, but do not ask normal users to run it.

### v2 Change Plan (Supersedes v1)

1. Replace home renderer with one-box, flat-choice layout.

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu-display.ts`
- `src/ui/tui.ts` only if a tiny helper is needed for aligned rows

Edit:

- Build one header box using the existing `box()` style.
- Header lines: key legend, chat escape model, readiness/default summary.
- Body: `Recent`, then flat command list, then `Choice:`.
- Do not call generic `menu()` for the home screen.

Risk: medium. Pure render, but many string tests will move.

Blast radius: `test/unit/menu-render.test.ts`, `test/unit/menu.test.ts`, `test/unit/menu-flow.test.ts`, PTY smokes.

2. Make empty state conversation-store-based.

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu-display.ts`

Edit:

- Stop using `renderBudgetLine()` as an empty-state source.
- If `metas.length === 0`, show `No conversations yet.` under Recent.
- Remove `No runs yet` entirely.

Risk: medium. Existing zero-spend tests assert that copy.

Blast radius: `renderBudgetLine()` tests and menu-render assertions.

3. Remove Health/Doctor from normal home UI.

Files:

- `src/interface/menu-render.ts`
- `src/interface/menu.ts`
- `src/cli.ts`
- `src/ui/help.ts`

Edit:

- Do not render health issue counts on home.
- Remove or keep hidden `[d]` dispatch. If kept, do not advertise it.
- Keep `doctor/status/check --fix` as hidden support/CI commands, not user-facing menu choices.
- Remove help/docs language that tells normal users to run doctor.

Risk: medium. Doctor is already hidden-ish in CLI comments, but menu dispatch still exists.

Blast radius: `test/unit/doctor.test.ts`, `test/unit/help.test.ts`, any menu tests that assert `[d]` absent/present.

User judgment needed:

- Full deletion of the command is not recommended yet because support/CI value is real. Delete from user-facing UI; keep hidden CLI.

4. Reclassify migration conflicts as self-healed archives.

Files:

- `src/infra/state-migration.ts`
- `src/infra/health.ts`
- `src/cli.ts`
- `test/unit/state-migration.test.ts`
- `test/unit/health.test.ts`

Edit:

- Add a non-alarming migration status such as `complete-with-archive`, or keep `conflicts` internally but do not convert it to `HealthIssue`.
- Keep current archive behavior for non-mergeable conflicts.
- For JSONL, keep dedupe merge.
- Optional: add deterministic merge for safe JSON files only after schema review.

Risk: medium-high. Migration touches user state and secrets. Preserve copy-only behavior.

Blast radius: migration and health tests.

User judgment needed:

- Whether config conflicts should be merged by schema or simply archived. Recommendation: archive first, schema-merge later.

5. Compact provider readiness.

Files:

- `src/interface/menu-display.ts`
- `src/interface/menu-render.ts`

Edit:

- Home shows `Ready: 4 providers` or provider names only when short.
- Full provider detail moves to Accounts.

Risk: medium because tests expect `claude: signed in` on the first main screen.

Blast radius: onboarding/auth-refresh tests.

6. Teach only real keys.

Files:

- `src/interface/menu-display.ts`
- `src/interface/menu-render.ts`
- `src/interface/ui/BottomLegend.tsx`

Edit:

- Home legend says `Ctrl+C x2=menu` and `Ctrl+C x3=exit`, matching `interpretInterrupt()`.
- Do not mention left/right on home unless home actually supports them. Keep left/right in chat chrome.

Risk: low.

Blast radius: copy tests only.

7. Update tests around the new first-screen contract.

Files:

- `test/unit/menu-render.test.ts`
- `test/unit/menu.test.ts`
- `test/unit/menu-flow.test.ts`
- PTY smoke scripts if they assert old copy

New assertions:

- Home contains `Choice:`.
- Home does not contain `No runs yet`.
- Home does not contain `Health:`.
- Home does not contain `run doctor`.
- Empty unauthenticated home advertises `[a] Sign in` as the primary action.
- Populated home shows numeric recents and no standalone `[1-9] Open numbered` line.

Risk: low.

Blast radius: tests only.
