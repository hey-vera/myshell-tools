# Lag Watchdog Relaunch Design

## Summary

Design a v1 Ink UI watchdog that detects a genuinely stale interactive terminal UI, restarts `myshell-tools` through the existing proven relaunch path, and reopens the conversation the user was in by using a new persisted active-conversation marker.

The implementation should not invent process respawn logic. The existing `MenuContext.relaunch` supplied by `src/cli.ts` already re-execs `myshell-tools` with inherited stdio. The update flow in `src/interface/menu.ts` already proves the hard part: releasing the current stdin owner, optionally handing off pending startup input, spawning the fresh child, and avoiding parent TTY re-priming after a successful handoff.

The watchdog should be Ink-only for v1. The legacy terminal path has no persistent render loop to monitor and less structure for repaint timing.

## Existing Architecture Read

Relevant current behavior:

- `src/providers/hang-cap.ts` has the closest existing watchdog pattern: a wall-clock deadline around a bounded operation, best-effort force-stop, honest timeout reporting, and cleanup that never waits on a known hung async iterator. This shape is a good precedent, but it is scoped to provider subprocesses and should not be reused directly for UI process relaunch.
- `src/cli.ts` injects `relaunch: async (env) => execa('myshell-tools', process.argv.slice(2), { stdio: 'inherit', reject: false, env })`. This preserves the current CLI arguments and hands the terminal to the new process.
- `src/interface/menu.ts` wires `const relaunchFn = ctx.relaunch` into the self-update flow. That flow suspends the current `LineReader`, arms startup input when available, calls `relaunchFn`, and only resumes stdin if handoff fails. This is the process handoff model to reuse.
- `src/interface/ui/App.tsx` has an `ErrorBoundary` that restores cooked mode, resolves pending key reads with `\x03`, clears key capture, and delegates reader close plus Ink unmount to `onFatalError`.
- `src/interface/ui/mount.tsx` owns the Ink bridge, store, output sink, `LineReader`, `renderTurn`, and `onFatalError`. It also has the `beginFrame` / `endFrame` frame replacement mechanism that fixed prior menu lag by keeping the menu frame out of the growing `<Static>` transcript.
- `src/interface/ui/App.tsx` already reacts to an external terminal event, `stdout.on('resize')`, by bumping state to force a re-render.
- Conversation persistence already exists in `src/infra/conversations.ts` and `src/infra/conversation-store.ts`, and `runChatLoop` already replays a bounded recent transcript via `renderResumeTranscript` when the user manually re-enters a conversation.
- There is no persisted active conversation pointer today. Relaunch cannot know where to return without adding one.
- State path resolution exists in `src/infra/state-dir.ts`; the newer `src/infra/state-layout.ts` is the current path authority and should be extended so the marker lands under the app state root across Windows, XDG, legacy POSIX, and cloud-workspace layouts.

## Goals

- Detect an interactive Ink UI that is stale or unresponsive while the user is in a conversation.
- Relaunch via the existing `ctx.relaunch` mechanism after clean TTY teardown.
- Reopen the last active conversation automatically after relaunch.
- Preserve durable conversation history and user orientation without attempting full process snapshotting.
- Avoid relaunch loops.

## Non-Goals

- Do not recover from a Node process that is permanently inside a native synchronous call and never returns to the event loop. A JavaScript watchdog timer cannot fire in that state.
- Do not preserve an in-flight provider stream mid-token.
- Do not preserve scroll position, transient Ink reducer state, or unsent composer text in v1.
- Do not add a supervisor daemon or parent process outside the existing CLI.

## Detection

Use a combined detector. Event-loop lag alone can identify a blocked Node process after the loop returns, but it cannot tell whether the UI was expected to be idle. Frame heartbeat alone can false-positive while the app is legitimately waiting for input. The watchdog should require both "the UI should be making progress" and "progress is not happening" before relaunching.

### Signals To Record

Record these timestamps inside the Ink mount boundary:

- `lastEventLoopTickMs`: updated by a watchdog sampler every 500 ms.
- `lastUiCommitMs`: updated when UI output is committed to the Ink store. At minimum this means `createInkOutputSink().endFrame()`, `flush()`, `write()` committing outside a frame, and the turn driver dispatch path in `renderStreamInk`.
- `lastFrameBeginMs` and `lastFrameEndMs`: updated by `beginFrame()` and `endFrame()` for menu repaint timing.
- `lastInputMs`: updated by `InkAppBridge.onSubmit`, `readKey`, and menu key capture.
- `lastTurnActivityMs`: updated when a turn starts, when a provider event is rendered, and when a turn completes or resets.
- `suspendedSinceMs`: set while an inherited-stdio child owns the terminal through `LineReader.suspend()`. Detection is disabled while suspended.

Expose these through a small `UiWatchdogHeartbeat` owned by `mount.tsx`. Do not put wall-clock reads inside React render except for already injected clock-style seams.

### Sampling Strategy

Use `perf_hooks.monitorEventLoopDelay({ resolution: 20 })` plus a simple interval drift check:

- Start only when Ink is mounted, `out.isTty` is true, and the watchdog is enabled.
- Sample every 500 ms with a `setInterval`.
- On each sample:
  - Compute interval drift: `now - expectedNextSampleMs`.
  - Read and reset the event-loop delay histogram.
  - Treat the sample as bad if `drift >= 2_000 ms`, `histogram.max >= 2_000 ms`, or `histogram.percentile(99) >= 750 ms`.
  - Track consecutive bad samples.

Use the sampler to identify lag, not to immediately relaunch. A single 2 second block is visible but not enough to kill the shell.

### Stale UI Definition

The UI is "watched active" when all are true:

- Ink is mounted.
- The `LineReader` is not suspended for an inherited-stdio child.
- The app is in a conversation (`inkSetChatActive(true)` has been called and not yet cleared), or a turn is active in the Ink reducer.
- There has been user input or turn activity in the last 60 seconds.

The UI is "stale" when either condition is true:

- Hard stall: no event-loop sampler callback ran for at least 10 seconds, observed when the callback finally resumes.
- Active stale window: watched active, at least 3 consecutive bad event-loop samples, and no UI commit or turn activity for at least 8 seconds after the most recent input or turn start.

Recommended v1 thresholds:

- Sampler interval: 500 ms.
- Bad sample: drift or max event-loop delay at least 2 seconds, or p99 at least 750 ms.
- Relaunch threshold: 3 consecutive bad samples plus 8 seconds without UI progress while watched active.
- Hard stall threshold: one observed sample gap of at least 10 seconds while watched active.
- Cooldown before arming after launch: 15 seconds, so startup migration, provider detection, and update checks do not immediately self-relaunch.

These values are intentionally conservative. They avoid punishing normal provider latency because provider waiting should not block the event loop and should still update turn status/spinner output. They also avoid relaunching an idle menu or idle chat prompt.

### Why Not Only `beginFrame` / `endFrame`

`beginFrame` / `endFrame` are specific to menu live-frame replacement. They are valuable for menu repaint timing and should feed `lastUiCommitMs`, but they do not cover streaming turn renders or React state updates inside `AppBody`. The watchdog needs a mount-level heartbeat that sees both menu frames and turn-driver dispatches.

### Why Not Throw Into React

The watchdog should not throw into the `ErrorBoundary`. React error boundaries catch render/reducer exceptions during React work; a timer callback throwing outside render is not a reliable way to enter that path, and it risks an uncaught exception before TTY handoff. The watchdog should call a direct recovery callback. The `ErrorBoundary` and watchdog should share teardown/relaunch plumbing, but have distinct triggers.

## Recovery Mechanism

### Recommended Call Chain

Add a direct recovery path that lives outside React render:

1. `mountInk` creates the watchdog after the Ink instance and store are available.
2. The watchdog detects stale UI and calls `opts.onUnresponsive(reason, snapshot)`.
3. `startMenu` supplies `onUnresponsive` when it calls `mountInk`.
4. `startMenu` handles recovery through a reusable helper, for example `handoffRelaunch({ reason, conversationId })`.
5. `handoffRelaunch`:
   - Writes the active-conversation marker and relaunch-attempt marker.
   - Resolves pending key reads with `\x03` through existing Ink unmount behavior.
   - Closes the LineReader and unmounts Ink.
   - Suspends stdin using the same `suspendStdin` / `LineReader.suspend()` flow used by update/login handoff.
   - Arms startup input if `ctx.startupInput` and `inkRawInput` are available, mirroring the update flow.
   - Calls `relaunchFn(relaunchEnv)`.
   - If the child exits with code `0`, returns from `startMenu` without resuming stdin.
   - If relaunch fails, resumes stdin, disables the watchdog for the rest of this process, prints a concise warning, and either returns to the menu or exits cleanly.

The existing `relaunchFn` remains the only process creation function. The implementation should factor the current update-specific relaunch code into a shared internal helper rather than duplicating it.

### ErrorBoundary Composition

The `ErrorBoundary` path should be extended, but not by throwing watchdog errors into it.

Current fatal render path:

`App ErrorBoundary.componentDidCatch` -> `onBoundaryError` -> resolve pending key with `\x03` -> restore cooked mode -> `onFatalError` -> `reader.close()` -> `inkInstance.unmount()`.

Recommended fatal render path after this design:

`App ErrorBoundary.componentDidCatch` -> same local TTY cleanup -> `onFatalError(error)` in `mount.tsx` -> shared fatal-recovery callback in `startMenu`.

The shared recovery callback should receive a reason enum:

- `render-error`
- `watchdog-unresponsive`

For `render-error`, v1 can use the same relaunch machinery if an active conversation marker exists and loop guards permit it. If no active conversation exists, keep the current clean exit behavior. This keeps fatal render recovery and stale UI recovery consistent without relying on React to transport watchdog events.

### Parent Process Exit Semantics

The current update relaunch path waits for the child `myshell-tools` process to finish and returns its exit code. That means "handoff" is really inherited stdio delegation from parent to child, not `execve`. This is acceptable for v1 because the update path already uses it successfully.

For watchdog recovery, keep the same model:

- Parent tears down Ink and stops reading stdin.
- Child owns stdio.
- Parent awaits child.
- Parent does not resume its own TTY ownership after child exits with code `0`.

If future work wants true process replacement, that should be a separate design.

## Reopening The Conversation

### V1 Restore Scope

V1 should restore:

- The active conversation id.
- The conversation workspace root, if available from `ConversationMeta.workspaceRoot`.
- Normal conversation history orientation by reusing the existing `renderResumeTranscript` behavior in `runChatLoop`.
- Normal per-conversation mode, intensity, activation, recap, goals, and last-provider behavior that already flows through `runChatLoop` and the store.

The relaunched process should skip the manual menu selection and enter the marked conversation as if the user had selected it from the recent list. This means it should still pass through the same auth gate and goal review checks that manual resume uses, unless product wants a "force direct resume" later. Reusing those checks avoids reopening into a broken signed-out state.

### V1 Out Of Scope

Do not attempt to preserve:

- In-flight turn streaming state. Provider calls already persist completed messages through the `SessionWriter`; partial assistant text may not be durable or valid. On relaunch, the user sees durable history and can retry.
- Unsent composer text. Capturing it from the Ink input box would require a new explicit composer-state persistence seam and raises privacy/staleness questions. It is valuable, but not necessary for v1 recovery.
- Scroll position. The existing resume transcript is bounded and designed to orient users after manual resume. Persisting scroll position would couple recovery to transient Ink layout state.
- Menu stack/submenu state. The goal is conversation recovery, not full terminal snapshotting.
- Provider subprocess tree cleanup beyond existing provider hang caps. Relaunching the UI process does not need to separately kill provider subprocesses if they are children of the exiting parent, but implementation should verify provider child lifecycle during testing.

### User-Facing Recovery Notice

After auto-reopen, print one concise line before the resume transcript, for example:

`[recovered] restarted after the terminal UI stopped responding; reopened this conversation.`

Keep it as committed transcript output, not a modal, so it appears in scrollback and does not require user interaction.

## New Persistence

Add a small marker file under the app state root, not under the per-project ledger directory.

Recommended path:

- `defaultStateLayout().paths.activeConversationFile`
- Concrete legacy-compatible location: `<stateRoot>/active-conversation.json`

If the implementation does not extend `AppStateLayout.paths` in v1, use `join(defaultStateLayout().stateRoot, 'active-conversation.json')` through a small infra helper. Do not use ad hoc `os.homedir()` calls.

### Marker Shape

```json
{
  "version": 1,
  "conversationId": "abc123",
  "workspaceRoot": "C:\\Users\\Josh\\Desktop\\Github\\Repositories\\myshell-tools-phase6-design",
  "enteredAt": "2026-07-06T14:03:12.000Z",
  "updatedAt": "2026-07-06T14:07:44.000Z",
  "pid": 12345,
  "argv": ["--optional-current-args"],
  "reason": "chat-active"
}
```

Fields:

- `version`: marker schema version, initially `1`.
- `conversationId`: required string id.
- `workspaceRoot`: nullable string copied from `ConversationMeta.workspaceRoot ?? ctx.cwd`; used for validation and future UX, not as an authority to rebind the conversation.
- `enteredAt`: ISO timestamp when `runChatLoop` entered the conversation.
- `updatedAt`: ISO timestamp refreshed on conversation entry and optionally on each turn start/end.
- `pid`: process id that wrote the marker.
- `argv`: optional current `process.argv.slice(2)` snapshot for diagnostics only; relaunch still uses current relaunch args.
- `reason`: initially `chat-active`; future values can distinguish manual resume, auto-recovered, etc.

Write atomically with `atomicWrite` and mode `0o600` where supported, after ensuring the state root directory exists.

### When To Write

- Write when `runChatLoop` successfully enters a conversation, before printing the resume transcript.
- Refresh `updatedAt` at turn start and turn completion. This is best-effort and should never block a turn.
- Write for newly-created conversations immediately before entering their chat loop.
- On recovery trigger, write again with the current reason so the relaunched process sees the freshest marker.

### When To Clear

- Clear when `runChatLoop` exits to the menu through `/back`, `back`, or EOF.
- Clear when the user quits the app from the menu.
- Clear when the conversation is deleted.
- Do not clear before watchdog relaunch. The marker is the handoff contract.

If clearing fails, continue. A stale marker is handled by validation on startup.

### Startup Consumption

Add startup consumption in `startMenu` after Ink mount and before the main menu loop renders:

1. Read the marker.
2. Validate schema.
3. Validate that the conversation id exists in `ctx.store.list()`.
4. Validate relaunch attempt guards.
5. If valid and the process is interactive, auth gate succeeds, and the user has not explicitly disabled recovery, call `runChatLoop` for that conversation.
6. After successful auto-entry, keep the marker active while in chat.
7. If validation fails, clear the marker and render the normal menu.

Do not use the marker for non-interactive one-shot commands.

## Relaunch Loop Prevention

Add a separate attempt file under state root:

- `defaultStateLayout().paths.relaunchRecoveryFile`
- Concrete legacy-compatible location: `<stateRoot>/relaunch-recovery.json`

Suggested shape:

```json
{
  "version": 1,
  "attempts": [
    {
      "at": "2026-07-06T14:07:44.000Z",
      "pid": 12345,
      "conversationId": "abc123",
      "reason": "watchdog-unresponsive"
    }
  ]
}
```

Guard:

- Allow at most 2 watchdog-triggered relaunches in 10 minutes for the same `conversationId`.
- Allow at most 3 watchdog-triggered relaunches in 30 minutes globally.
- Ignore attempts older than 30 minutes when rewriting the file.
- After the guard trips, do not relaunch. Disable the watchdog for the current process, restore cooked terminal mode, close readers, and print a clear message:

`[error] interface recovery was attempted repeatedly and is disabled for now; start myshell-tools again manually.`

Use `atomicWrite` for the attempt file. If writing the attempt file fails, fail closed for auto-relaunch: do not relaunch, because a broken guard can create an uncontrolled loop.

Also pass a one-shot environment variable to the relaunched child:

- `MYSHELL_RECOVERY_RELAUNCH=1`
- `MYSHELL_RECOVERY_REASON=watchdog-unresponsive`
- `MYSHELL_RECOVERY_CONVERSATION_ID=<id>`

These env vars are diagnostic hints and can help startup show the recovered notice. The durable marker remains authoritative.

Startup arming rule:

- The watchdog does not arm until 15 seconds after launch.
- If `MYSHELL_RECOVERY_RELAUNCH=1`, do not arm until after the conversation has rendered at least one successful UI commit and 15 seconds have elapsed.

This prevents immediate recovery loops during startup or while the recovered transcript is being rendered.

## Scope Boundary For Implementation

Expected file-level changes:

- `src/infra/state-layout.ts`: add `activeConversationFile` and `relaunchRecoveryFile` paths under `AppStateLayout.paths`.
- `src/infra/state-dir.ts`: keep compatibility behavior; optionally add or document helper compatibility only if the codebase still has callers that need the old resolver.
- New `src/infra/active-conversation.ts`: read/write/clear active conversation marker with schema validation, atomic writes, directory creation, and fail-soft read semantics.
- New `src/infra/relaunch-recovery.ts`: read/prune/record recovery attempts and enforce the relaunch-loop guard.
- `src/interface/ui/mount.tsx`: add watchdog heartbeat state, event-loop sampler, watchdog lifecycle, and an `onUnresponsive` mount option. Update output sink and turn driver to record UI progress. Stop the watchdog on unmount.
- `src/interface/ui/App.tsx`: minimal change only if needed to route fatal render errors into the same recovery callback shape. Keep local TTY cleanup in `onBoundaryError`.
- `src/interface/menu.ts`: factor the update relaunch handoff into a reusable helper; write/clear active conversation marker around `runChatLoop`; consume marker on startup; route watchdog recovery through `ctx.relaunch`; enforce recovery guards; pass watchdog options into `mountInk`.
- `src/cli.ts`: likely no process-spawn change. It may only need to preserve or scrub recovery env vars when constructing `relaunchEnv`, depending on how `startMenu` owns that environment.
- Tests in a future implementation should focus on infra marker validation, guard behavior, and injected relaunch callbacks. This document intentionally does not run or add tests.

## Open Questions And Risks

- Should auto-reopen bypass goal review? The conservative design keeps existing manual resume gates. That may add friction after a recovery but avoids silently entering a conversation with stale auth or goal state.
- Should render-error recovery be enabled in v1, or should v1 limit relaunch to watchdog unresponsive events? The plumbing can support both, but render exceptions may indicate deterministic bugs that relaunch will repeat.
- Does `relaunchFn` waiting for the child process cause any undesirable parent lifetime behavior for watchdog recovery? It is proven for self-update, but watchdog recovery may happen more often and should be observed under real terminals.
- Can provider subprocesses survive parent teardown on every supported platform? Provider hang caps use process groups for provider calls, but watchdog relaunch is a UI-level recovery and should not assume provider process-tree cleanup without validation.
- How should unsent input be handled later? Preserving composer text is user-friendly, but it needs an explicit privacy and freshness policy before being written to disk.
- Should the marker be per workspace or global? The design uses a global app-state marker because the process has only one active conversation. If users run multiple `myshell-tools` terminals concurrently, they can race on this marker. A future version may need a per-terminal instance id.
- How much telemetry or debug logging is acceptable? The design can work without telemetry, but diagnosing false positives will be easier if guarded debug logs record sampler delay, stale-window reason, and guard decisions.

## Recommended V1 Decision

Build an Ink-only watchdog in `mount.tsx` using event-loop delay sampling plus UI-progress heartbeats. Trigger a direct menu-owned relaunch callback, not a React throw. Persist only the active conversation id and enough metadata to validate and diagnose the handoff. On restart, auto-enter the conversation through the same `runChatLoop` path manual resume uses, relying on `renderResumeTranscript` for orientation. Protect the feature with strict relaunch-attempt guards and disable it rather than looping when recovery itself appears unstable.
