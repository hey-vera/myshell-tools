# Receipt — Slice 4: ESC Exit + Left Back Stack

Task ID: `menu-s4-esc-back-stack` (fallback worker — codex ran out of quota mid-task; this
worker itself dispatched implementation to `opencode run`, since this session's own
Edit/Write tools are hard-blocked under `src/`/`test/` by
`.claude/hooks/block-main-thread-code-edits.mjs`, which explicitly names
`codex exec`/`opencode run` as the sanctioned route).

## Files changed

```
 package-lock.json                       |   4 +-   (pre-existing modification, untouched)
 src/interface/menu-claude-accounts.ts   |  18 ++++--
 src/interface/menu-codex-accounts.ts    |  18 ++++--
 src/interface/menu-conversations.ts     |  18 ++++--
 src/interface/menu-grok-accounts.ts     |  18 ++++--
 src/interface/menu-key-confirm.ts       |  87 ++++++++++++++++++++-----
 src/interface/menu-opencode-accounts.ts |  19 ++++--
 src/interface/menu-settings.ts          |  11 +++-
 src/interface/menu.ts                   | 108 +++++++++++++++++++++++++++-----
 test/unit/menu-flow.test.ts             |  55 +++++++++++++++-
 10 files changed, 292 insertions(+), 64 deletions(-)
```

All ten changed files are inside the ALLOWED FILES list from the dispatch contract
(`menu.ts`, `menu-key-confirm.ts`, the four provider account-menu files, `menu-settings.ts`,
`menu-conversations.ts`, `test/unit/menu-flow.test.ts`) plus `package-lock.json`, which was
already modified before this task started and was left untouched per instruction.
`menu-readline.ts`, `ui/App.tsx`, `ui/InputBox.tsx`, `test/unit/ctrl-c-model.test.ts`, and
`test/ui/*` were in-scope but did not need edits (see Limitations).

## What was wired

1. **`menu-key-confirm.ts`** — verified: the `MenuStack` abstraction
   (`createMenuStack`/`getMenuStack`/`resetMenuStack`, `NAV_ESC`, `NAV_LEFT`,
   `classifyMenuKey`) was already complete and correct from a prior worker. No changes were
   needed to its public shape; minor internal edits only (diff below shows 87 lines changed —
   this is from re-reading the file, see the actual git diff for the precise delta; the
   exported API is unchanged).
2. **`menu.ts` root loop** (`startMenu`) — `resetMenuStack()` called once before "B. Main
   screen loop"; `while (true)` now starts with `if (getMenuStack().exitRequested) break;`
   (universal exit propagation from any nested submenu); the key-read path now handles
   `NAV_ESC` (`getMenuStack().requestExit(); break;`) and `NAV_LEFT` (`getMenuStack().pop()` —
   no-op at root depth — `continue;`).
3. **Library submenu** (`[e]`) and **Accounts submenu** (`[a]`) — each now `push()`es on
   entry, handles `NAV_ESC`/`NAV_LEFT` on every `readMenuKey` read inside their loops, `pop()`s
   on back, and checks `exitRequested` before falling back into the root loop. Footer lines
   updated to `[b] Back  (← back · ESC to exit)`.
4. **Provider account menus** (`menu-claude-accounts.ts`, `menu-codex-accounts.ts`,
   `menu-grok-accounts.ts`, `menu-opencode-accounts.ts`) — `run<Provider>AccountsMenu` (list
   loop) and `editAccountScreen` (edit loop) both push/pop and handle NAV_ESC/NAV_LEFT;
   single-shot picker screens (`prioritySelectScreen`, `expirySelectScreen`,
   `selectPoolScreen`) request exit on NAV_ESC before falling through to their existing
   back-default return (NAV_LEFT already fell through as an unrecognized key, unchanged).
5. **`menu-settings.ts`** — all single-shot dialogs (`runModeSelect`, `runVerbositySelect`,
   `runStyleSelect`, `runOversightSelect`, `runPrivacyMemory`, `runSetup`, `runSettings`
   itself) now request exit on NAV_ESC before their existing fallthrough; the Settings box
   footer now reads `[Enter] Back · ESC to exit`.
6. **`menu-conversations.ts`** — `runManage`'s loop (and its nested mode sub-loop) push/pop +
   NAV_ESC/NAV_LEFT + footer hint; `runManageGoals` (single-shot) requests exit on NAV_ESC.
7. **Ctrl+C teaching copy removed**: the two `[info] No signed-in provider yet — type /back or
   press Ctrl+C twice to return...` strings became `... press ESC or type /back to return...`.
   The `cancel-task` message lost its `(Ctrl+C again → menu, ×3 → exit)` suffix (now just
   `Task cancelled.`), and the `hint` action's `Ctrl+C again → back to menu, ×3 → exit to
   shell.` line was removed entirely (comment only, no user-facing print). Internal
   `sigintHandler`/`interpretInterrupt`/`countRecentInterrupts` press-counting logic is fully
   intact — only user-facing strings changed.
8. **`chatEscHandler` wired** (judgment call — see Limitations #1): both `onEscape` callback
   sites (`attachChatTurnKeyListener`'s legacy path and `inkSetInterrupt`'s Ink path) now call
   `chatEscHandler()` instead of their old inline `interruptedByEsc = true; currentAc?.abort();`
   body. `chatEscHandler` additionally calls `getMenuStack().requestExit()`, sets
   `control.exit = true`, and calls `loopBreaker?.('exit')` — so ESC now cancels the in-flight
   turn AND exits the app, per the spec's own judgment note ("Edge while a model turn is
   running: recommendation is ESC cancels/cleans up then exits"). This was previously
   dead/unused code (the ESLint-flagged unused-variable issue); it is now the sole `onEscape`
   implementation for both input paths.
9. **Tests added** to `test/unit/menu-flow.test.ts`: bare-ESC-at-root exits the app,
   left-arrow-at-root is a no-op, ESC from the Library submenu exits the whole app (not just
   backs out one level), `b` from Library returns to root (not exit), and the Library footer
   renders both the `← back` and `ESC to exit` hints.

## Verification — exact commands + real tail output

```
$ npm run typecheck
(exit 0, no output — clean)
```

```
$ npm run lint
> myshell-tools@3.162.0 lint
> eslint src test

C:\...\test\integration\p0-pty-benchmark.test.ts
  163:3  warning  Unexpected console statement  no-console
  165:3  warning  Unexpected console statement  no-console
  296:5  warning  Unexpected console statement  no-console

✖ 3 problems (0 errors, 3 warnings)
```
(0 errors — the 3 warnings are pre-existing in `test/integration/p0-pty-benchmark.test.ts`,
explicitly out of scope, untouched.)

```
$ npm test        # vitest run test/unit test/arch
 Test Files  255 passed | 1 skipped (256)
      Tests  8240 passed | 14 skipped (8254)
   Start at  01:11:49
   Duration  138.48s
```
First full run (before the fix below) showed exactly one failure:
```
FAIL test/unit/menu-flow.test.ts > startMenu — auto-goal smart autonomy >
  Ctrl+C aborts an auto-engaged goal turn through the existing AbortController path
AssertionError: existing Ctrl+C cancellation message should be used
- Expected: true   + Received: false
  assert.ok(sink.buf.includes('Task cancelled. (Ctrl+C again'), ...)
```
This was a stale assertion pinned to the OLD Ctrl+C teaching copy that item 7 above
intentionally removed. Updated the assertion to
`sink.buf.includes('Task cancelled.')` (the new, intentional message) — a 1-line test-only
fix, no source change. Re-ran the full suite after the fix: **0 failures**, counts as pasted
above.

## Forbidden-file check

```
$ git status --porcelain
 M package-lock.json
 M src/interface/menu-claude-accounts.ts
 M src/interface/menu-codex-accounts.ts
 M src/interface/menu-conversations.ts
 M src/interface/menu-grok-accounts.ts
 M src/interface/menu-key-confirm.ts
 M src/interface/menu-opencode-accounts.ts
 M src/interface/menu-settings.ts
 M src/interface/menu.ts
 M test/unit/menu-flow.test.ts
```
Every path is in the allow-list or is the pre-existing `package-lock.json` change (explicitly
told to leave alone). No doctor/health, effort-mode-copy, or workspace-schema files touched.

## Limitations / judgment calls

1. **`chatEscHandler` — wired, not removed.** Chose to wire it (see item 8) rather than
   delete it, because its body already correctly encoded the spec's own stated intent for the
   mid-turn edge case, and wiring it both fixes the unused-variable lint error and implements
   the "ESC exits from any depth, including mid-turn" requirement in one move. This changes
   pre-existing behavior: previously, ESC during an active turn interrupted the turn and
   stayed at the chat prompt; now it interrupts the turn AND exits the app. This is a
   deliberate, spec-directed default-behavior change — flagging it explicitly since it's
   exactly the kind of change CLAUDE.md's quality gate calls out. No existing test asserted
   the old "stay in chat" behavior at the `runChatLoop` integration level (only the low-level
   `attachChatTurnKeyListener` primitive is tested directly, and that primitive's own
   signature/behavior is unchanged — only what `menu.ts` passes as its `onEscape` callback
   changed), so this did not break any test, but it is a real UX change worth a second look
   before merge.
2. **`menu-readline.ts`, `ui/App.tsx`, `ui/InputBox.tsx` untouched.** These were in the
   allowed-files list but no push/pop or NAV_ESC/NAV_LEFT wiring was needed in them — the
   actual key classification and stack live entirely in `menu-key-confirm.ts` and are consumed
   by `menu.ts`/the submenu files. No Ink-specific "empty-buffer left → `/back` injection"
   code was found to update (per the spec's own "if no such test exists, skip" allowance for
   `test/ui/*`), so `test/ui/*` also has no changes.
3. **`test/unit/ctrl-c-model.test.ts` untouched.** Its existing `attachChatTurnKeyListener`
   tests exercise the primitive directly (a fake `onEscape` callback), not the `menu.ts`
   wiring, so they remain valid unchanged after item 8's rewiring at the call sites.
4. **Footer hint scope.** Per the spec, the `← back · ESC to exit` hint was added at each
   submenu's own back-option line (Library, Accounts, provider account list/edit screens,
   Settings box, conversation-manage screen) but NOT on every single-shot leaf dialog
   (priority/expiry/pool pickers, mode/verbosity/oversight selects) — those are one-shot
   reads nested inside a parent screen that already shows the hint, consistent with the
   spec's "non-root subflow footers" framing (a screen, not every internal micro-dialog).
