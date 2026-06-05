# TUI input audit - 2026-06-05

Scope: diagnosis only. Files audited: `src/interface/menu.ts`, `src/interface/repl.ts`, `src/ui/tui.ts`, `src/commands/login.ts`, `src/cli.ts`, `src/infra/update-check.ts`.

## Executive diagnosis

The reported Replit web-shell failure is credible from the current code.

The menu has two independent problems:

1. Raw single-key mode is gated by `out.isTty && stdin.isTTY === true && typeof stdin.setRawMode === 'function'` in `readMenuKey` ([src/interface/menu.ts:1115](../src/interface/menu.ts#L1115)-[1117](../src/interface/menu.ts#L1117)). After the auto-update path suspends the parent readline and spawns a fresh `myshell-tools` with inherited stdio, the relaunched process can legitimately observe a non-raw-capable stdin shape in Replit's web shell, so `readMenuKey` immediately falls back to line mode.

2. The line-mode fallback returns `readLine()` verbatim from `readMenuKey` ([src/interface/menu.ts:1117](../src/interface/menu.ts#L1117), [1132](../src/interface/menu.ts#L1132)). The raw path normalizes to one lowercase printable character ([src/interface/menu.ts:1124](../src/interface/menu.ts#L1124)-[1127](../src/interface/menu.ts#L1127)); the line-mode path does not. The main dispatch loop compares exact strings such as `key === 'n'` and `key === 'j'` ([src/interface/menu.ts:3286](../src/interface/menu.ts#L3286), [3360](../src/interface/menu.ts#L3360)). If the fallback line contains `j\r`, trailing whitespace, or uppercase `J`, it is not dispatched and ultimately reaches the unknown/no-op path. That matches "press j + Enter, menu re-renders, no login".

## A. Why the menu falls into line mode

### Raw-mode gate

`startMenu` creates a single readline interface using `process.stdin` / `process.stdout`, with `terminal: out.isTty` ([src/interface/menu.ts:3101](../src/interface/menu.ts#L3101)-[3108](../src/interface/menu.ts#L3108)), then wraps it in `createLineReader` ([src/interface/menu.ts:3109](../src/interface/menu.ts#L3109)). The main loop writes `> ` and calls `readMenuKey(out, readLine)` ([src/interface/menu.ts:3265](../src/interface/menu.ts#L3265)-[3268](../src/interface/menu.ts#L3268)).

`readMenuKey` only attempts raw key reading when all three are true:

- `out.isTty`
- `stdin.isTTY === true`
- `typeof stdin.setRawMode === 'function'`

See [src/interface/menu.ts:1115](../src/interface/menu.ts#L1115)-[1117](../src/interface/menu.ts#L1117). If any condition fails, it returns `readLine()` immediately. That is the `>` prompt + key + Enter behavior.

`out.isTty` is derived from `process.stdout.isTTY === true` in the CLI output sink ([src/cli.ts:191](../src/cli.ts#L191)-[192](../src/cli.ts#L192)). The raw gate, however, depends on stdin separately. A process can have TTY stdout while stdin is not represented as a Node TTY stream with `isTTY === true` and `setRawMode`.

### Auto-update handoff path

The launch update path in `startMenu` runs before onboarding and before the main menu ([src/interface/menu.ts:3138](../src/interface/menu.ts#L3138)-[3227](../src/interface/menu.ts#L3227)). When auto-update is enabled and an update is available, `install()` suspends the menu's readline before running the updater and relauncher:

- `const resumeStdin = suspendStdin?.();` at [src/interface/menu.ts:3176](../src/interface/menu.ts#L3176)
- `doUpdate(out)` at [src/interface/menu.ts:3178](../src/interface/menu.ts#L3178)
- `relaunchFn()` at [src/interface/menu.ts:3194](../src/interface/menu.ts#L3194)
- parent resume in `finally` at [src/interface/menu.ts:3205](../src/interface/menu.ts#L3208)

The comment already names this exact failure class: parent reader races the relaunched process for keypresses and the new menu falls back to line mode ([src/interface/menu.ts:3172](../src/interface/menu.ts#L3172)-[3175](../src/interface/menu.ts#L3175)).

`suspendStdin` is implemented by `createLineReader.suspend()`:

- `rl.pause()` ([src/interface/menu.ts:903](../src/interface/menu.ts#L903)-[905](../src/interface/menu.ts#L905))
- `input.setRawMode(false)` when possible ([src/interface/menu.ts:908](../src/interface/menu.ts#L908)-[912](../src/interface/menu.ts#L912))
- clear buffered lines ([src/interface/menu.ts:913](../src/interface/menu.ts#L913)-[915](../src/interface/menu.ts#L915))
- `input.pause()` ([src/interface/menu.ts:921](../src/interface/menu.ts#L921)-[925](../src/interface/menu.ts#L925))

The updater and relauncher are both spawned with inherited stdio:

- `npm install -g myshell-tools@latest`, `stdio: 'inherit'` ([src/cli.ts:367](../src/cli.ts#L367)-[373](../src/cli.ts#L373))
- `myshell-tools ...`, `stdio: 'inherit'` ([src/cli.ts:391](../src/cli.ts#L391)-[397](../src/cli.ts#L397))

That means the new process inherits fd 0 from the web shell. There is no additional pty allocation or explicit stdin normalization in `src/infra/update-check.ts`; that file only decides whether an update exists and caches registry results. The actual self-update and relaunch behavior is injected from `src/cli.ts` into `MenuContext`.

### Root cause

The code assumes inherited fd 0 in the relaunched process will be a Node raw-capable TTY. On Replit web shell after this parent-process suspend + inherited-stdio update/relaunch sequence, that assumption can fail. If the new `process.stdin` reports `isTTY !== true` or lacks `setRawMode`, `readMenuKey` takes the line-mode fallback by design.

There is no recovery path in `readMenuKey`: it does not attempt to reopen `/dev/tty`, recreate `process.stdin` as a TTY stream, re-prime stdin, or retry raw detection after readline setup. It uses the one-shot stream shape it received.

## B. Why line-mode dispatch fails for `j` / `n`

### Normalization asymmetry

Raw mode:

- `readSingleKey()` returns the raw byte string ([src/interface/menu.ts:1014](../src/interface/menu.ts#L1014)-[1017](../src/interface/menu.ts#L1017)).
- `readMenuKey` rejects Enter and escape sequences ([src/interface/menu.ts:1120](../src/interface/menu.ts#L1120)-[1123](../src/interface/menu.ts#L1123)).
- A single printable char is lowercased and returned ([src/interface/menu.ts:1124](../src/interface/menu.ts#L1124)-[1127](../src/interface/menu.ts#L1127)).

Line mode:

- `readMenuKey` returns `readLine()` directly when raw is unavailable ([src/interface/menu.ts:1117](../src/interface/menu.ts#L1117)).
- It also returns `readLine()` directly after a raw-read exception ([src/interface/menu.ts:1130](../src/interface/menu.ts#L1130)-[1132](../src/interface/menu.ts#L1132)).

`createLineReader` trims lines before buffering or resolving waiters ([src/interface/menu.ts:865](../src/interface/menu.ts#L865)-[872](../src/interface/menu.ts#L872)), so the common LF-only case becomes `j`. That masks the bug in many terminals and tests. But `readMenuKey` itself does not guarantee the documented contract ("single lower-cased char", [src/interface/menu.ts:1103](../src/interface/menu.ts#L1103)-[1106](../src/interface/menu.ts#L1106)) for the fallback path. If an injected reader, platform newline quirk, or Replit readline behavior passes through `j\r`, `j `, `J`, or a multi-character line, dispatch is exact-string fragile.

### Exact comparisons that fail

The main menu only handles exact normalized keys:

- `key === 'q'` quit ([src/interface/menu.ts:3281](../src/interface/menu.ts#L3281))
- `key === 'n'` new conversation ([src/interface/menu.ts:3286](../src/interface/menu.ts#L3286))
- `key === 'c'` continue ([src/interface/menu.ts:3302](../src/interface/menu.ts#L3302))
- `parseInt(key, 10)` for conversation digits ([src/interface/menu.ts:3319](../src/interface/menu.ts#L3319)-[3320](../src/interface/menu.ts#L3320))
- `key === 'e'`, `i`, `r` ([src/interface/menu.ts:3336](../src/interface/menu.ts#L3336), [3342](../src/interface/menu.ts#L3342), [3350](../src/interface/menu.ts#L3350))
- `key === 'j'` Claude login ([src/interface/menu.ts:3360](../src/interface/menu.ts#L3360))
- `key === 'k'` Codex login ([src/interface/menu.ts:3371](../src/interface/menu.ts#L3371))
- `key === 'o'` opencode ([src/interface/menu.ts:3385](../src/interface/menu.ts#L3385))
- `key === 'u'`, `m`, `s`, `d`, `$` ([src/interface/menu.ts:3426](../src/interface/menu.ts#L3426), [3443](../src/interface/menu.ts#L3443), [3450](../src/interface/menu.ts#L3450), [3456](../src/interface/menu.ts#L3456), [3462](../src/interface/menu.ts#L3462))

The same exact-match dependency appears in submenus:

- auth-before-chat choices compare `choices.find((c) => c.key === key)` ([src/interface/menu.ts:1208](../src/interface/menu.ts#L1208)-[1214](../src/interface/menu.ts#L1214))
- setup mode uses `modeKey === '1' | '2' | '3'` ([src/interface/menu.ts:1351](../src/interface/menu.ts#L1351)-[1368](../src/interface/menu.ts#L1368))
- mode settings use `key === '1' | '2' | '3' | '4'` ([src/interface/menu.ts:1456](../src/interface/menu.ts#L1456)-[1464](../src/interface/menu.ts#L1464))
- verbosity uses `key === '1' | '2' | '3'` ([src/interface/menu.ts:1513](../src/interface/menu.ts#L1513)-[1520](../src/interface/menu.ts#L1520))
- settings uses `key === '1'` through `key === '10'` ([src/interface/menu.ts:1604](../src/interface/menu.ts#L1604)-[1629](../src/interface/menu.ts#L1629))
- manage uses `key === 'p' | 't' | 'r' | 'x'` ([src/interface/menu.ts:1877](../src/interface/menu.ts#L1877)-[1945](../src/interface/menu.ts#L1945))
- raw provider session parses the unnormalized choice ([src/interface/menu.ts:2083](../src/interface/menu.ts#L2083)-[2092](../src/interface/menu.ts#L2092))

For `j\r`, `key.length > 0`, so the main loop reaches the unknown option print ([src/interface/menu.ts:3467](../src/interface/menu.ts#L3467)-[3469](../src/interface/menu.ts#L3469)) and then loops back to render the menu. Depending on screen clearing in `renderMainScreen`, the user may only perceive "it re-rendered and did nothing".

### CR / whitespace / case failure points

Any valid menu choice can fail when line-mode returns:

- trailing carriage return: `j\r`, `n\r`
- trailing spaces or tabs: `j `, `n\t`
- uppercase: `J`, `N`
- multi-character input where first char is meaningful: `jfoo`

`parseYesNo` does the right normalization for yes/no line prompts ([src/interface/menu.ts:330](../src/interface/menu.ts#L330)-[343](../src/interface/menu.ts#L343)). `readMenuKey` needs the same boundary discipline for menu keys.

## C. Friction / redundant-step issues

1. Main menu requires Enter whenever raw gate fails. This is the reported primary friction and comes from the fallback at [src/interface/menu.ts:1117](../src/interface/menu.ts#L1117).

2. Yes/no confirms are single-key only when `makeConfirm` sees raw capability at construction time ([src/interface/menu.ts:1152](../src/interface/menu.ts#L1157)-[1165](../src/interface/menu.ts#L1165)). If stdin raw capability is lost after relaunch, all setup/update/auth confirms degrade to line-mode `y`/`n` + Enter.

3. Pressing `n` with no signed-in provider asks a second question instead of taking the user directly into the obvious sign-in path. `startMenu` calls `promptForAuthBeforeChat` before creating a conversation ([src/interface/menu.ts:3286](../src/interface/menu.ts#L3286)-[3288](../src/interface/menu.ts#L3288)); that function prints "No provider signed in yet. Sign in now?" and waits for another key ([src/interface/menu.ts:1208](../src/interface/menu.ts#L1208)-[1214](../src/interface/menu.ts#L1214)). If login fails or the user cancels, it returns to the menu ([src/interface/menu.ts:1226](../src/interface/menu.ts#L1228)-[1229](../src/interface/menu.ts#L1229)). For a frictionless flow, `n` should either route directly to the best installed provider login or create/open chat and handle auth inline without a redundant provider-selection prompt.

4. Some subflows still intentionally use full-line prompts for simple numeric picks:

- manage empty state requires Enter to go back ([src/interface/menu.ts:1868](../src/interface/menu.ts#L1868)-[1872](../src/interface/menu.ts#L1872))
- manage asks for a conversation number with `readLine()` after `p`, `t`, `r`, or `x` ([src/interface/menu.ts:1884](../src/interface/menu.ts#L1884)-[1930](../src/interface/menu.ts#L1930))
- native import asks "Pick a number..." via `readLine()` ([src/interface/menu.ts:2002](../src/interface/menu.ts#L2002)-[2007](../src/interface/menu.ts#L2007))
- structured question selector uses full lines for option selection ([src/interface/menu.ts:2225](../src/interface/menu.ts#L2225)-[2233](../src/interface/menu.ts#L2233))

These are less severe than the main menu because they collect numbers/text, but single-digit selection screens can use `readMenuKey` without losing scriptability if the fallback stays normalized.

5. `runSettings` advertises `[10] Auto-goal`, but `readMenuKey` raw mode only returns a single printable char ([src/interface/menu.ts:1124](../src/interface/menu.ts#L1127)). In raw mode, option 10 is unreachable because pressing `1` dispatches option 1 immediately ([src/interface/menu.ts:1610](../src/interface/menu.ts#L1610)-[1629](../src/interface/menu.ts#L1629)). In line mode, `10` can work. This is a raw-mode/line-mode behavioral split.

6. Chat itself is line-oriented by design: the chat prompt tells the user to type a message and press Enter ([src/interface/menu.ts:2291](../src/interface/menu.ts#L2291)-[2304](../src/interface/menu.ts#L2304)), then uses `readLine()` ([src/interface/menu.ts:2438](../src/interface/menu.ts#L2438)-[2444](../src/interface/menu.ts#L2444)). That is appropriate for free-text messages, but in-chat `/mode` reuses `runModeSelect`, so it inherits any `readMenuKey` fallback/raw issues ([src/interface/menu.ts:2479](../src/interface/menu.ts#L2479)-[2482](../src/interface/menu.ts#L2482)).

7. Login hands stdin to vendor CLIs correctly via `suspendStdin` and inherited stdio ([src/commands/login.ts:191](../src/commands/login.ts#L191)-[209](../src/commands/login.ts#L209), [326](../src/commands/login.ts#L326)-[337](../src/commands/login.ts#L337)), but after vendor login returns, the same `resume()` raw re-prime mechanism is relied on ([src/interface/menu.ts:927](../src/interface/menu.ts#L927)-[960](../src/interface/menu.ts#L960)). Any web-shell raw-mode loss after child handoff can make later menu prompts line-mode too.

`src/interface/repl.ts` is not the main menu path. It is intentionally line-oriented (`readline.createInterface`, prompt `myshell-tools> `, `rl.on('line')`) at [src/interface/repl.ts:39](../src/interface/repl.ts#L39)-[107](../src/interface/repl.ts#L107). It does not explain the reported `startMenu` bug, but it confirms there is a separate legacy path that requires Enter by design.

`src/ui/tui.ts` is rendering-only. It does not read stdin or alter raw mode.

## Concrete fix plan

### 1. Make raw single-key reliable after self-relaunch

Minimal target: `src/interface/menu.ts` and `src/cli.ts`.

1. Add a small helper in `src/interface/menu.ts` near `KeyInputStream` / `readSingleKey`:

   - `canReadRawKey(out, stdin): boolean`
   - `normalizeMenuKey(line: string | null): string | null`
   - optionally `openControllingTtyInput(): KeyInputStream | null` for Unix fallback.

2. Change `readMenuKey` ([src/interface/menu.ts:1110](../src/interface/menu.ts#L1110)-[1133](../src/interface/menu.ts#L1133)) so raw failure does not immediately give up if the process has a controlling TTY:

   - First try current `stdin`.
   - If `stdin.isTTY !== true` or `setRawMode` is missing and `out.isTty` is true, attempt to create a read stream for `/dev/tty` on Unix and use that for raw key input.
   - If raw still cannot be used, fall back to `normalizeMenuKey(await readLine())`.

   This directly addresses Replit/web-shell cases where inherited fd 0 is degraded but a controlling TTY is still available.

3. In the auto-update install path ([src/interface/menu.ts:3171](../src/interface/menu.ts#L3208)), do not resume the parent reader after a successful relaunch handoff. Today `finally` always calls `resumeStdin?.()` even after `relaunchFn()` has run ([src/interface/menu.ts:3205](../src/interface/menu.ts#L3208)). Track `handedOff = true` before returning success and skip resume in that case. The parent should close/exit quietly, not re-prime the same fd while the child owns the terminal.

4. In `src/cli.ts` relaunch ([src/cli.ts:391](../src/cli.ts#L397)), prefer replacing the process over spawning a nested child where feasible:

   - On Unix, use an `execvp`-style handoff if the project is willing to add that dependency/implementation.
   - Minimal no-new-dependency alternative: spawn/execa the child with inherited stdio as today, but make the parent close its readline and avoid resuming stdin once the child starts.

   The important invariant is one live menu reader per terminal.

5. Make `makeConfirm` use the same raw-capability helper and fallback normalization strategy as `readMenuKey` ([src/interface/menu.ts:1152](../src/interface/menu.ts#L1174)). Otherwise yes/no prompts will remain line-mode after the menu is fixed.

### 2. Normalize line-mode keys so dispatch never silently fails

Minimal target: `readMenuKey` only.

1. Implement `normalizeMenuKey(input: string | null): string | null`:

   - `null` -> `null`
   - `input.trim().toLowerCase()`
   - empty -> `''`
   - if length is 1 -> that char
   - if length > 1 and starts with a valid menu prefix only if explicitly desired; safest minimal behavior is return the trimmed lowercase string for multi-character settings such as `10`, while all one-key menus continue exact matching.

2. Replace both fallback returns:

   - [src/interface/menu.ts:1117](../src/interface/menu.ts#L1117): `return normalizeMenuKey(await readLine());`
   - [src/interface/menu.ts:1132](../src/interface/menu.ts#L1132): `return normalizeMenuKey(await readLine());`

3. Consider normalizing the raw path through the same helper after preserving the raw-specific treatment of Ctrl-C, Ctrl-D, Enter, and escape sequences. This keeps the contract centralized.

4. Add focused tests around `readMenuKey`:

   - line fallback `j\r` -> `j`
   - line fallback ` J ` -> `j`
   - line fallback `n\t` -> `n`
   - line fallback `''` / whitespace -> `''`
   - line fallback `null` -> `null`
   - line fallback `10` -> `10` if settings option 10 is kept

### 3. Remove friction / redundant presses

Minimal target: `src/interface/menu.ts`.

1. Fix settings option 10 first. Raw single-key menus cannot have a two-character item. In `runSettings` ([src/interface/menu.ts:1577](../src/interface/menu.ts#L1632)), change `[10] Auto-goal` to a single key such as `[a] Auto-goal`, and dispatch `key === 'a'`. This removes the raw/line behavior split.

2. Streamline `n` when no provider is signed in:

   - Current path: `n` -> `promptForAuthBeforeChat` -> provider choice -> login -> maybe return to menu ([src/interface/menu.ts:3286](../src/interface/menu.ts#L3298), [1178](../src/interface/menu.ts#L1230)).
   - Minimal fix: in `promptForAuthBeforeChat`, if exactly one installed unauthenticated provider exists, call `loginFn` directly instead of asking another key.
   - Better friction fix: choose a deterministic default provider from installed providers (Claude first if installed, then Codex, then opencode) and offer a single-key override only when multiple installed providers exist. After successful login, continue into the new chat automatically, as the current caller already does when the function returns true.

3. Convert single-digit selection subflows from `readLine()` to `readMenuKey` where the option set is one key:

   - native import pick at [src/interface/menu.ts:2002](../src/interface/menu.ts#L2007)
   - raw provider selection already uses `readMenuKey` ([src/interface/menu.ts:2083](../src/interface/menu.ts#L2085))
   - manage first command already uses `readMenuKey`, but the follow-up conversation number prompts ([src/interface/menu.ts:1884](../src/interface/menu.ts#L1930)) could use a one-key numeric selector for the first nine displayed conversations.

4. Remove "press Enter to go back" dead-end pauses where no decision is needed. For the empty manage screen, print "No conversations yet." and return immediately instead of waiting at [src/interface/menu.ts:1868](../src/interface/menu.ts#L1872).

5. Keep full-line input where text is inherently required:

   - chat messages ([src/interface/menu.ts:2438](../src/interface/menu.ts#L2444))
   - rename/category free text ([src/interface/menu.ts:1904](../src/interface/menu.ts#L1919))
   - structured free-text answers ([src/interface/menu.ts:2242](../src/interface/menu.ts#L2247))

## Minimal patch order

1. Patch `readMenuKey` fallback normalization and tests. This fixes `j`/`n` dispatch even when raw mode is unavailable.
2. Patch raw reacquisition / `/dev/tty` fallback and self-relaunch handoff. This fixes the root line-mode regression after update.
3. Patch `makeConfirm` to share the raw strategy. This keeps yes/no prompts single-key too.
4. Patch friction items: settings `[10]`, auth-before-chat direct login, empty manage return, single-key numeric picks.

The smallest user-visible hotfix is item 1 plus a regression test. The correct fix for the reported Replit sequence also needs item 2; otherwise the menu may still require Enter even though `j`/`n` would finally dispatch.
