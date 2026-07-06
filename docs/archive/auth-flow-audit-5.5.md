# Auth flow audit - 2026-06-05

Scope: `src/commands/login.ts`, `src/interface/menu.ts`, provider trust prompts, and sibling inherited-stdio handoffs.

## Findings

1. Confirmed: onboarding used stale auth state after a successful vendor login.
   `runWelcome` builds a local `env` from `ctx.env` at [src/interface/menu.ts:1296](../src/interface/menu.ts#L1296), then loops installed unauthenticated providers at [src/interface/menu.ts:1384](../src/interface/menu.ts#L1384)-[1405](../src/interface/menu.ts#L1405). Before this fix it called `loginFn` but did not re-run `detectEnvironmentFn` inside the loop. A successful Claude login could therefore leave the onboarding loop deciding subsequent auth prompts from the pre-login snapshot. With default-yes prompts, a leftover blank line from a child could be consumed as acceptance of the next stale auth prompt. Fix: re-detect immediately after each accepted onboarding login at [src/interface/menu.ts:1401](../src/interface/menu.ts#L1401)-[1403](../src/interface/menu.ts#L1403).

2. Confirmed: browser-mode login trusted exit code 0 more than fresh credentials.
   Code-mode login correctly hands stdio to the vendor child at [src/commands/login.ts:196](../src/commands/login.ts#L196)-[209](../src/commands/login.ts#L209), then verifies with `detectProvider` at [src/commands/login.ts:211](../src/commands/login.ts#L211)-[229](../src/commands/login.ts#L229). Browser-mode used the same inherited-stdio handoff at [src/commands/login.ts:337](../src/commands/login.ts#L337)-[349](../src/commands/login.ts#L349), but treated `exitCode === 0` as success. Vendor CLIs can exit 0 after a cancelled login, failed paste, or first-run trust dialog. Fix: shared `verifyPostLogin` probes real credentials at [src/commands/login.ts:232](../src/commands/login.ts#L232)-[255](../src/commands/login.ts#L255), and browser-mode now uses it at [src/commands/login.ts:351](../src/commands/login.ts#L351)-[355](../src/commands/login.ts#L355).

3. Confirmed: a post-child blank line could bleed into the next prompt.
   `createLineReader.suspend()` correctly pauses readline/stdin before inherited-stdio children at [src/interface/menu.ts:912](../src/interface/menu.ts#L912)-[939](../src/interface/menu.ts#L939), and it intentionally avoids `stdin.read()` because that can race the child. `resume()` re-primes the TTY at [src/interface/menu.ts:940](../src/interface/menu.ts#L940)-[980](../src/interface/menu.ts#L980), but clearing `buffered` only at the start of `resume()` missed a blank `line` event emitted just after resume. That blank could auto-answer a default prompt or make a prompt appear to flash. Fix: for TTY resumes, suppress one immediate empty line and clear only if no new line arrived in the short handoff window at [src/interface/menu.ts:866](../src/interface/menu.ts#L866)-[879](../src/interface/menu.ts#L879) and [src/interface/menu.ts:949](../src/interface/menu.ts#L949)-[959](../src/interface/menu.ts#L959).

4. Confirmed safe: main menu auth handlers refresh state after explicit login.
   `[j]`, `[k]`, and `[o]` all call `loginFn` with the shared `readLine`, `confirm`, and `suspendStdin` seams, then refresh `mutableCtx.env`: Claude at [src/interface/menu.ts:3426](../src/interface/menu.ts#L3426)-[3433](../src/interface/menu.ts#L3433), Codex at [src/interface/menu.ts:3437](../src/interface/menu.ts#L3437)-[3444](../src/interface/menu.ts#L3444), opencode at [src/interface/menu.ts:3451](../src/interface/menu.ts#L3451)-[3463](../src/interface/menu.ts#L3463) and after login at [src/interface/menu.ts:3457](../src/interface/menu.ts#L3457)-[3462](../src/interface/menu.ts#L3462). The loop-back was not from these handlers misreading `runLogin`'s return value; they ignore it and rely on detection.

5. Confirmed safe after 3.12.2: pre-chat auth refreshes state.
   `promptForAuthBeforeChat` exits immediately when any provider is authenticated at [src/interface/menu.ts:1241](../src/interface/menu.ts#L1241), directly logs into a single installed provider at [src/interface/menu.ts:1253](../src/interface/menu.ts#L1253)-[1265](../src/interface/menu.ts#L1265), and re-detects after selected login at [src/interface/menu.ts:1257](../src/interface/menu.ts#L1257)-[1263](../src/interface/menu.ts#L1263). This path was not the reported post-login loop.

6. Vendor trust prompts are inherited-stdio prompts, so they are exposed to the same handoff class.
   Codex headless runs avoid the workspace trust gate by passing `--skip-git-repo-check` from [src/providers/codex.ts:72](../src/providers/codex.ts#L72)-[79](../src/providers/codex.ts#L79). Login commands do not pass that flag because they invoke vendor auth flows directly. Claude headless runs use `claude -p` with permission flags in [src/providers/claude.ts:126](../src/providers/claude.ts#L126)-[148](../src/providers/claude.ts#L148); Claude's interactive `/login` can still show its own first-run trust/onboarding prompt during the inherited-stdio child launched from [src/commands/login.ts:200](../src/commands/login.ts#L200)-[206](../src/commands/login.ts#L206). The fix is not to parse vendor prompt text; it is to ensure myshell releases and reacquires stdin cleanly around the child.

7. Sibling risk: `doctor --fix` has a double-handoff shape.
   `runDoctor` creates a `LineReader` and `suspendStdin` at [src/commands/doctor.ts:273](../src/commands/doctor.ts#L273)-[285](../src/commands/doctor.ts#L285). `runFixPass` then wraps sign-in calls with an outer suspend at [src/commands/doctor.ts:374](../src/commands/doctor.ts#L374)-[385](../src/commands/doctor.ts#L385), while the default `loginFn` is `runLogin`, which can also suspend internally. This was not the live menu path, and changing the doctor seam would widen the patch; it should be cleaned up separately by threading the same login options shape used by `startMenu`.

8. Sibling inherited-stdio path: raw provider sessions.
   `runRawProviderSession` suspends stdin, launches the selected vendor CLI with `stdio: 'inherit'`, and resumes at [src/interface/menu.ts:2165](../src/interface/menu.ts#L2165)-[2170](../src/interface/menu.ts#L2170). It benefits from the same `createLineReader.resume()` blank-line suppression fix.

## Root Cause

The live symptom required two bugs to line up:

- State bug: onboarding did not refresh its local environment snapshot after the vendor login persisted credentials, so subsequent first-run auth prompts could be driven from stale unauthenticated state.
- Input handoff bug: after an inherited-stdio child returned, a trailing Enter could arrive after `resume()` had already cleared buffers, then be consumed by the next prompt. With default-yes onboarding auth prompts, that looks like a brief prompt flash followed by another authorization flow.

The browser-mode credential probe gap was a sibling correctness defect in the same flow: it could print success on exit 0 even when detection would still say unauthenticated.

## Tests Added

- `test/unit/menu-flow.test.ts`: explicit `[j]` login re-detects authenticated state and returns to the home menu without another login call.
- `test/unit/menu-flow.test.ts`: onboarding re-detects after an accepted login, so stale auth prompts are skipped and a blank line cannot default-accept the next provider sign-in.
- `test/unit/menu-flow.test.ts`: `createLineReader.resume()` drops one immediate blank line left by an inherited-stdio child.
