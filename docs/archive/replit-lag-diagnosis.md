# Replit terminal lag diagnosis and fix plan

## Scope

This pass inspected the Ink/React terminal UI path only. No `.ts` or `.tsx`
source or tests were edited. The symptom is time-based degradation: an open
Replit shell running the TUI becomes progressively sluggish until the shell is
killed and restarted.

The code already contains several performance fixes: menu redraws use an
ephemeral `chrome` frame instead of appending on every no-op keypress, the live
stream buffer is capped, fast spinner ticks are localized, and most timers and
listeners have cleanup. The remaining likely cause is therefore not a single
obvious never-cleared `setInterval`; it is rising render and state-management
cost as session transcript/menu history grows, amplified by Replit's slower
terminal renderer.

## Ranked findings

### 1. Highest likelihood: every reducer push re-renders through an append-only transcript

Evidence:

- `src/interface/ui/mount.tsx:93-101` creates a single persistent store and calls
  `bridge.pushState(state)` after every reducer dispatch.
- `src/interface/ui/App.tsx:546-566` maps the entire
  `uiState.committed` array to `{line,key}` items during render before handing it
  to `<Static>`.
- `src/interface/ui/reduce.ts:39-42` appends by cloning the entire committed
  array: `committed: [...state.committed, ...lines]`.
- `src/interface/ui/state.ts:237-254` documents `committed` as an append-only
  transcript that grows for the whole session.
- `src/interface/ui/run-stream.ts:151-156` schedules stream flushes at about
  40ms; each flush can dispatch to the store and therefore push a new snapshot.

Why this matches the symptom:

`<Static>` prevents old transcript lines from being repainted to the terminal,
but `AppBody` still pays React-side work on every state push. While a turn is
streaming, many dispatches change `uiState.stream` while `uiState.committed` is
unchanged. Those renders still execute the full `uiState.committed.map(...)`.
As the session gets longer, the fixed cost of each stream tick, spinner-adjacent
state update, board sync, menu repaint, or final line commit rises.

This is the most likely dominant cause because it is both time-based and on the
hot render path.

Minimal surgical fix:

Before:

```tsx
const committed: Array<{ readonly line: TranscriptLine; readonly key: number }> =
  uiState.committed.map((line, index) => ({ line, key: index }));

<Static items={committed}>
  {(item) => <CommittedLine key={item.key} line={item.line} color={color} />}
</Static>
```

After:

```tsx
const CommittedTranscript = React.memo(function CommittedTranscript({
  lines,
  color,
}: {
  readonly lines: readonly TranscriptLine[];
  readonly color: boolean;
}): React.ReactElement {
  const items = React.useMemo(
    () => lines.map((line, index) => ({ line, key: index })),
    [lines],
  );
  return (
    <Static items={items}>
      {(item) => <CommittedLine key={item.key} line={item.line} color={color} />}
    </Static>
  );
});
```

Then render:

```tsx
<CommittedTranscript lines={uiState.committed} color={color} />
```

This keeps the existing reducer contract but avoids remapping the transcript on
stream-only updates where the committed array reference has not changed. If this
does not move enough latency, the next step is a larger split: keep committed
transcript appends on a separate append/delta channel and keep high-frequency
live state in a small object.

### 2. High likelihood during interactive use: menu actions repeatedly promote full menu frames into permanent transcript

Evidence:

- `src/interface/menu.ts:6741-6755` paints the menu by calling
  `out.beginFrame?.()`, rendering the full main screen, writing `> `, then
  `out.endFrame?.()`.
- `src/interface/menu.ts:6814-6818` correctly avoids growth for Enter/no-op
  redraws.
- `src/interface/menu.ts:6821-6825` promotes the just-shown full menu frame into
  permanent transcript on every real action key.
- `src/interface/ui/mount.tsx:160-165` implements `promoteFrame()` as
  `chrome/promote`.
- `src/interface/ui/reduce.ts:228-233` appends all current `chrome` lines to
  `committed`.

Why this matches the symptom:

The no-op keypress path is fixed, but each actual menu action still appends a
whole menu screen, roughly dozens of lines, into the append-only transcript.
Over a long session with many menu visits, settings flows, conversation
switches, login retries, or auth prompts, the transcript can grow much faster
than the actual chat content. Finding 1 then makes every subsequent live render
more expensive.

Minimal surgical fix:

Before:

```ts
out.promoteFrame?.();
inMainMenu = false;
```

After, option A: clear instead of promote for high-frequency or chat handoff
paths:

```ts
out.clearFrame?.(); // new OutputSink method dispatching chrome/clear
inMainMenu = false;
```

After, option B: promote a compact breadcrumb instead of the full frame:

```ts
out.clearFrame?.();
out.write(`\n> ${key}\n`);
inMainMenu = false;
```

Option A is the smallest performance fix but changes scrollback parity. Option B
preserves an audit trail without permanently appending an entire menu frame.

### 3. Medium likelihood: unbounded input history grows for the entire process

Evidence:

- `src/interface/ui/InputBox.tsx:313-315` stores submitted-line history in React
  state.
- `src/interface/ui/InputBox.tsx:381-384` appends every non-blank submitted line
  with `setHistory((h) => ... [...h, submitted])`.
- `src/interface/ui/InputBox.tsx:331-335` reattaches the imperative API every
  render because the effect has no dependency list. Cleanup prevents a listener
  leak, but it is still unnecessary effect churn.

Why this matters:

History is not mapped on every normal render, so this is unlikely to be the main
lag source. It is still a true time-based memory growth path in the same
component that receives every keystroke. Long sessions with many submitted
turns keep all prior inputs forever.

Minimal surgical fix:

Before:

```ts
setHistory((h) => (h[h.length - 1] === submitted ? h : [...h, submitted]));
```

After:

```ts
const HISTORY_CAP = 500;
setHistory((h) => {
  if (h[h.length - 1] === submitted) return h;
  return [...h, submitted].slice(-HISTORY_CAP);
});
```

Also change the attach effect to depend on the current line:

```ts
useEffect(() => {
  bridge.attach({ currentLine: () => value });
  return () => bridge.attach(null);
}, [bridge, value]);
```

The dependency does not reduce every keystroke attach churn by itself because
`value` changes on keystrokes. A better minimal follow-up is to attach once and
read from `valueRef.current`.

### 4. Medium-low likelihood: uncancelled short timeout in Ink line-reader resume

Evidence:

- `src/interface/ui/mount.tsx:327-334` starts a 250ms `setTimeout` in
  `createInkLineReader.resume()` and does not retain the handle.
- `src/interface/ui/mount.tsx:353-359` closes the reader but cannot clear that
  timeout.
- The legacy readline path has the same pattern at
  `src/interface/menu-readline.ts:200-208`.

Why this matters:

This is a real cleanup gap, but the timeout is short and only created on
suspend/resume handoff, not every render. It is unlikely to explain multi-hour
sluggishness alone. It can still create stale post-close callbacks, transient
timer buildup during repeated login/install handoffs, and confusing soak-test
noise.

Minimal surgical fix:

Before:

```ts
setTimeout(() => {
  if (suppressGeneration === generation) {
    suppressEmptyUntil = 0;
    buffered.length = 0;
  }
}, 250).unref?.();
```

After:

```ts
let suppressTimer: ReturnType<typeof setTimeout> | null = null;

function clearSuppressTimer(): void {
  if (suppressTimer !== null) clearTimeout(suppressTimer);
  suppressTimer = null;
}

clearSuppressTimer();
suppressTimer = setTimeout(() => {
  suppressTimer = null;
  if (suppressGeneration === generation) {
    suppressEmptyUntil = 0;
    buffered.length = 0;
  }
}, 250);
suppressTimer.unref?.();
```

Call `clearSuppressTimer()` in `close()` and when a submitted line invalidates
the generation.

### 5. Medium-low likelihood: concurrent async menu repaints can overlap in one frame

Evidence:

- `src/interface/menu.ts:6757-6762` calls `void paintMenu()` from
  `repaintIfActive()` without serialization.
- `src/interface/menu.ts:6779-6781` schedules async environment refresh repaint.
- `src/interface/menu.ts:6795-6798` schedules three first-load async fills that
  each repaint.
- `src/interface/ui/mount.tsx:141-158` makes `beginFrame()` re-entrant: a second
  `beginFrame()` while a frame is open keeps the existing frame buffer, and
  `endFrame()` dispatches the accumulated lines.

Why this matters:

If two `paintMenu()` calls overlap, especially in a slow Replit terminal or slow
filesystem/container, the second frame can write into the first frame's buffer
before the first `endFrame()` closes it. This is not an unbounded leak because
`chrome/replace` replaces state, but it can create oversized transient frames,
extra dispatches, and inconsistent menu repaint timing. Replit makes this more
visible because async fills and terminal writes are slower.

Minimal surgical fix:

Before:

```ts
const repaintIfActive = (): void => {
  if (!liveRegion || !started || !inMainMenu) return;
  void paintMenu();
};
```

After:

```ts
let paintChain = Promise.resolve();
let menuGeneration = 0;

const enqueuePaintMenu = (): void => {
  const generation = menuGeneration;
  paintChain = paintChain.then(async () => {
    if (!liveRegion || !started || !inMainMenu || generation !== menuGeneration) return;
    await paintMenu();
  });
};
```

Increment `menuGeneration` when leaving the menu for a sub-flow. This keeps
repaints ordered and drops stale late paints.

### 6. Lower likelihood but real cost: full ledger reads on menu/goal hot paths

Evidence:

- `src/interface/menu.ts:6719-6722` computes spend by reading the full ledger.
- `src/interface/menu.ts:6767-6769` rereads the full ledger when `spendDirty`.
- `src/interface/menu.ts:4948-4956` reads and summarizes the full ledger at goal
  start and on every goal iteration to calculate live progress tokens.
- The comments at `src/interface/menu.ts:6675-6684` already identify the ledger
  as unbounded and move it off first paint, but not off all later hot paths.

Why this matters:

This is not an idle render leak, and it does not run every keystroke. It can,
however, produce progressive sluggishness after long use because ledger size
grows over time. Replit filesystem reads and JSON parsing are also visibly
slower than local SSD reads.

Minimal surgical fix:

Before:

```ts
spend = summarizeSpend(await readLedger(ctx.cwd).catch(() => []), ctx.clock.isoNow());
```

After:

```ts
spend = await spendCache.refreshIfDirty(ctx.cwd, ctx.clock.isoNow());
```

Implement `spendCache` as an incremental summary keyed by ledger file size and
mtime. Keep the exact full read as a fallback when the file shrinks or metadata
is unavailable.

## Timers and listeners that look healthy

These were checked and should not be ranked as primary leaks:

- `src/interface/ui/App.tsx:456-465` registers `stdout.on('resize', onResize)`
  and removes it with `stdout.off('resize', onResize)`.
- `src/interface/ui/StatusBlock.tsx:550-560` starts the fast spinner interval
  only while `turnActive` and clears it in effect cleanup.
- `src/interface/ui/StatusBlock.tsx:695-716` starts the 1Hz elapsed timer only
  while `turnActive` and clears it in effect cleanup.
- `src/interface/ui/run-stream.ts:151-156` returns a cancellation function for
  the 40ms flush timeout, and `src/interface/ui/run-stream.ts:440-451` drains and
  cancels pending work in `finally`.
- `src/interface/menu.ts:1645-1712` adds `process.on('SIGINT', ...)` around the
  chat loop and removes it in `finally`.
- `src/interface/menu-readline.ts:351-403` removes temporary raw-key listeners
  in `restore()`. This path is still delicate because it snapshots and restores
  prior listeners, but it is not the Ink menu path and did not show an obvious
  accumulating listener.

## Why Replit shows it worse

Replit adds several amplifiers:

- Its terminal is a browser-backed terminal over a container connection, so every
  extra redraw, cursor movement, and line write costs more than a native terminal.
- Container CPU and filesystem performance are usually lower and noisier, so
  full ledger reads, JSON parsing, and React reconciliation have more visible
  latency.
- Slow rendering makes async repaint overlap more likely: the menu's async fills
  and environment refreshes have a wider window to collide.
- If the terminal transport buffers output under load, small React-side costs can
  become user-visible input latency.

## Verification plan

Add temporary diagnostics behind an env flag such as `MYSHELL_UI_DIAG=1`, then
remove or keep them test-gated after the fix.

Counters to sample every 10s:

- `uiState.committed.length`, `uiState.chrome.length`,
  `uiState.stream.buffer.length`, `uiState.stream.proseFull.length`.
- `AppBody` render count and elapsed time spent building committed `<Static>`
  items.
- Number of reducer dispatches per second by action type.
- `process.listenerCount('SIGINT')`, `process.stdout.listenerCount('resize')`,
  and stdin listener counts for `data`, `keypress`, `readable`, `end`, `close`,
  `error`.
- `process.memoryUsage().heapUsed`.
- Count of active suppress timers in `createInkLineReader`.
- Menu `paintMenu()` start/end count, max concurrent paints, and frame line count.

Soak scenarios:

1. Start Replit TUI, leave it idle on the main menu for 30 minutes. Expected
   before and after: no growth except environment refresh counters; listener
   counts remain flat.
2. Press Enter/no-op on the main menu 1,000 times. Expected: `committed.length`
   does not grow; `chrome.length` remains bounded to one menu frame.
3. Visit sub-flows and return to menu 200 times. Expected before finding 2:
   `committed.length` grows by full menu-frame size per action. Expected after:
   growth is zero or one compact breadcrumb per action.
4. Stream a long answer or replay a synthetic event stream for 30 minutes.
   Expected before finding 1: render time per stream dispatch rises with
   `committed.length`. Expected after: stream-only dispatch render time is mostly
   flat because committed item mapping is memoized.
5. Run repeated login/install suspend/resume handoffs. Expected after finding 4:
   active suppress timer count never exceeds one and is zero after close.

Acceptance checks:

- No `MaxListenersExceededWarning` during the soak.
- Listener counts remain flat after repeated chat/menu cycles.
- `committed.length` growth matches intentional transcript content only.
- p95 key-to-frame latency in Replit stays flat between minute 1 and minute 30.
- Heap use reaches a plateau for idle/no-op menu soaks.

## Recommended fix order

1. Memoize or component-isolate the committed transcript mapping in
   `App.tsx:546-566`. This is the smallest change with the best chance of
   flattening render cost.
2. Stop promoting full menu frames on every real action key at
   `menu.ts:6821-6825`; clear the frame or commit a compact breadcrumb.
3. Serialize async menu repaints at `menu.ts:6757-6798` so Replit cannot overlap
   frame writes.
4. Cap `InputBox` history and attach the imperative API once via refs.
5. Retain and clear the 250ms resume timeout in both Ink and legacy line readers.
6. Replace full ledger rereads on hot paths with an incremental spend cache.
