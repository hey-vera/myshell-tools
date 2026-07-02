# P0 Component Characterization Fixtures

These fixtures ground the P0-06b deterministic in-process characterization suite.
Each case exercises a real subsystem through its public API and records exactly what
it observes — known-bad behavior is recorded, not fixed.

## Case IDs

### `manage-early-key`
Mounts the real `App` component and starts `runManage` with a deferred
`ConversationStore.list`. Injects one `p` keypress before resolving the deferred
list, then records the current editor remainder and action state. Characterizes
the known-bad early-submenu-key-in-editor behavior.

### `surface-replace-1000`
Uses a real `InkStore` with the P0-06a observer. Dispatches 1000
`chrome/replace` actions and verifies zero committed delta (replace affects
`state.chrome`, not `state.committed[]`).

### `legacy-buffer-mm`
Sends one `Buffer.from('mm')` to a fake `KeyInputStream` and records the
one-chunk delivery. Characterizes the known-bad behavior where a multi-key
buffer arrives as one chunk and is discarded by `readSingleKey`.

### `ctrl-c-contexts`
Drives real `readMenuKey`, `confirmViaKey`, bridge pending-read teardown
(resolving a pending `readKey` with Ctrl-C), and documents an injected chat
SIGINT fixture. Each sub-result is recorded in the `observation` field.

### `login-child-handoff`
Uses `createLoginRunner` with a deferred child spawn and suspend/resume spies.
Asserts that listeners are balanced (no leaks) and suspend/resume counts match.

### `dirty-worktree-verify`
Creates a temporary git repository, makes it dirty BEFORE calling
`createNodeVerifyPort().captureDiff`, and records whether the pre-existing
diff is attributed. Known-bad: the diff is attributed rather than normalized.

### `auto-stage-success`
Drives `createAutoStageEngine(...).resolveAutoStage()` with a confident 3-todo
adaptive plan. Records exactly one parked goal creation and zero execution
callbacks (syncBoard is display, not execution — the P0-01 parked-only
invariant is preserved).

## Invariants

- Fixed fake clock; no wall-clock fields in this suite
- No provider/network calls
- Each case runs once per invocation
- Known-bad observations are recorded, not turned into passes
- The suite harness status is `'failed'` only when a case is absent, throws,
  leaks listeners/temp files, violates its declared fixture, or produces
  schema-invalid output
