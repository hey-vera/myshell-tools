# Chat UX Audit 5.5: Input/Output Mechanics

Scope: design and investigation only. This plan covers the interactive chat's mechanical input/output behavior for ESC interruption, typed-ahead queueing, structured question rendering, and raw output detail rendering. It intentionally does not change persona, decision policy, or when the model should ask questions.

## Current Stdin Topology

The default chat surface is `runChatLoop` in `src/interface/menu.ts` ([2321](../src/interface/menu.ts#L2321)). `startMenu` creates one `readline.Interface`, wraps it in `createLineReader`, and injects `readLine = () => reader.nextLine()` into menu/chat flows ([3162](../src/interface/menu.ts#L3162), [3170](../src/interface/menu.ts#L3170), [3173](../src/interface/menu.ts#L3173)).

`createLineReader` attaches one permanent `rl.on('line')` listener and buffers lines when no caller is awaiting them ([857](../src/interface/menu.ts#L857), [869](../src/interface/menu.ts#L869), [880](../src/interface/menu.ts#L880)). It also owns the 3.12.x stdin handoff fix: `suspend()` pauses readline, switches a TTY out of raw mode, clears already-buffered lines, and pauses stdin without draining it ([912](../src/interface/menu.ts#L912), [921](../src/interface/menu.ts#L921), [926](../src/interface/menu.ts#L926), [934](../src/interface/menu.ts#L934)); `resume()` clears child leftovers, suppresses one immediate blank line, cycles raw mode off/on to re-prime the TTY, then resumes stdin/readline ([940](../src/interface/menu.ts#L940), [949](../src/interface/menu.ts#L949), [950](../src/interface/menu.ts#L950), [965](../src/interface/menu.ts#L965), [973](../src/interface/menu.ts#L973), [979](../src/interface/menu.ts#L979)).

The menu's single-key prompts use a separate raw-key path. `readSingleKey` temporarily removes existing `data`/`keypress` listeners, sets raw mode, reads one byte, restores raw mode and listeners, and falls back to line input when needed ([1061](../src/interface/menu.ts#L1061), [1065](../src/interface/menu.ts#L1065), [1100](../src/interface/menu.ts#L1100), [1103](../src/interface/menu.ts#L1103), [1095](../src/interface/menu.ts#L1095)). `rawKeyInputs` first tries `process.stdin`, then `/dev/tty` on Unix for the menu picker fallback ([1024](../src/interface/menu.ts#L1024), [1036](../src/interface/menu.ts#L1036)).

The plain REPL is different and simpler: it pauses readline while `runTask()` runs ([87](../src/interface/repl.ts#L87)), aborts an in-flight `AbortController` on Ctrl+C ([52](../src/interface/repl.ts#L52), [56](../src/interface/repl.ts#L56)), then resumes and prompts after the task settles ([93](../src/interface/repl.ts#L93), [95](../src/interface/repl.ts#L95)). There is no ESC listener and no queue.

## ESC Interrupt

Current behavior:

- In menu chat, Ctrl+C is the only mid-turn interrupt. `runChatLoop` stores the active turn controller in `currentAc` ([2387](../src/interface/menu.ts#L2387)); the process `SIGINT` handler aborts it on a single press, returns to menu on a rapid double press, and exits on a rapid triple press ([2400](../src/interface/menu.ts#L2400), [2405](../src/interface/menu.ts#L2405), [2407](../src/interface/menu.ts#L2407), [2413](../src/interface/menu.ts#L2413), [2425](../src/interface/menu.ts#L2425)).
- The spinner/render layer has no input hook. It only renders the stream from `orchestrate()` through `renderStream()` ([363](../src/interface/render.ts#L363)); the live "Thinking..." indicator is driven by stream events and `createSpinner` ([391](../src/interface/render.ts#L391), [414](../src/interface/render.ts#L414), [469](../src/interface/render.ts#L469)).
- ESC is ignored unless readline interprets it as part of line editing. No code path maps `\x1b` to `AbortController.abort()`.

Root cause:

- The chat loop has a SIGINT control plane, but no non-SIGINT key control plane during a running turn.
- Existing raw-key helpers are prompt-scoped and destructive by design: `readSingleKey` removes other listeners while it waits ([1100](../src/interface/menu.ts#L1100)). Reusing it during streaming would collide with the always-on line reader and could reintroduce the stdin listener races fixed in 3.12.x.

Proposed semantics:

- ESC means: interrupt the current model turn and stay at the chat prompt.
- ESC does not count toward the Ctrl+C window and never returns to the menu.
- If no model turn is running, ESC is a no-op or clears the current readline edit buffer using readline's native behavior; do not print an interrupt message at idle.
- Ctrl+C behavior remains unchanged: single press cancels the task, double press returns to menu, triple press exits.

Precise edits:

- Add a small exported pure helper in `src/interface/menu.ts`, near `interpretInterrupt`: `interpretChatKey(raw: string, taskRunning: boolean): 'interrupt-task' | 'ignore'`. It returns `interrupt-task` only for exactly `'\x1b'` while `taskRunning` is true. It must ignore arrow-key escape sequences such as `'\x1b[A'`.
- Add a narrow runtime helper in `src/interface/menu.ts`: `attachChatTurnKeyListener(out, stdin, onEscape): () => void`.
  - Use only `process.stdin` by default. Do not use the `/dev/tty` fallback for this mid-turn listener; `/dev/tty` is for isolated menu key reads when stdin cannot do raw keypresses, and a second active reader during chat would violate the single-owner rule.
  - Require `out.isTty`, `stdin.isTTY === true`, and `typeof stdin.setRawMode === 'function'`; otherwise return a no-op detach function. Non-TTY integration tests can still cover interruption via direct helper tests and Ctrl+C.
  - Do not call `removeAllListeners`. Add one `keypress` or `data` listener and remove only that listener on detach.
  - Prefer `readline.emitKeypressEvents(stdin)` plus `stdin.on('keypress', handler)`, because readline terminal mode already cooperates with keypress events. If implementation uses `data`, it must not consume or decode full lines; it may only detect the single ESC byte and ignore all printable input so line buffering remains readline-owned.
  - Record `wasRaw = stdin.isRaw === true`. If raw mode is not already enabled, set raw mode true for the running turn and restore it on detach. In normal terminal readline mode it will usually already be raw, so this should be a no-op.
  - On ESC, call `currentAc?.abort()`, set a new `interruptedByEsc = true`, set `currentAc = null`, and write a short status line after stopping/settling: `Interrupted.`
- Wire the listener around every `runTask()` call in `runChatLoop`: normal turns ([2864](../src/interface/menu.ts#L2864)), auth retry turns ([2902](../src/interface/menu.ts#L2902)), structured-question answer turns ([2697](../src/interface/menu.ts#L2697)), and goal-loop turns ([2776](../src/interface/menu.ts#L2776)). Use `try/finally` so detach always runs after the task promise settles.
- Do not change `renderStream` cancellation rendering initially. It already prints a calm cancelled line when a final event has `canceled` ([608](../src/interface/render.ts#L608), [610](../src/interface/render.ts#L610)). If the provider abort path returns no final, `runTask` may return `{ code: 1 }`; the chat loop should still print the ESC-specific status once per ESC.

Coexistence with 3.12.x stdin fixes:

- The new listener must be scoped only to a model turn and must not call `suspend()` or `resume()`. `suspendStdin` remains exclusively for inherited-stdio children such as login and raw provider sessions ([2168](../src/interface/menu.ts#L2168), [3184](../src/interface/menu.ts#L3184)).
- It must not remove readline's listeners, unlike `readSingleKey`; that destructive pattern is safe only for one isolated key prompt.
- It must not call `stdin.read()` or drain bytes. The login regression tests explicitly protect against pending-read races ([1753](../test/unit/menu-flow.test.ts#L1753)).
- It must restore only raw mode state it changed. If readline already had raw mode enabled, leave ownership with readline.

Tests:

- Unit-test `interpretChatKey` in `test/unit/ctrl-c-model.test.ts` or `test/unit/menu.test.ts`: ESC while running interrupts; ESC while idle ignores; arrow sequences ignore; Ctrl+C bytes are ignored by this helper.
- Unit-test `attachChatTurnKeyListener` with the fake key stream pattern already used for `readSingleKey` ([1422](../test/unit/menu-flow.test.ts#L1422)): it attaches/removes only its own listener, toggles raw mode only when needed, calls the callback on ESC, ignores printable text, and does not call `removeAllListeners`.
- Add one integration-style chat test with an injected slow provider and fake stdin: start a turn, emit ESC, assert the provider signal aborts and the loop returns to `❯` rather than menu. This test can avoid a real TTY by testing the abort callback wiring separately from raw-mode key capture.

## Message Queueing

Current behavior:

- In menu chat, `runChatLoop` awaits `readLine()` only at the prompt ([2497](../src/interface/menu.ts#L2497), [2502](../src/interface/menu.ts#L2502)), then awaits `runTask()` synchronously ([2864](../src/interface/menu.ts#L2864), [2866](../src/interface/menu.ts#L2866)). There is no explicit mid-turn queue object, no queue hint, and no policy for what happens to typed-ahead lines.
- Because `createLineReader` remains active while the menu chat task runs, full lines submitted during a task can be buffered incidentally by the `rl.on('line')` listener ([869](../src/interface/menu.ts#L869), [884](../src/interface/menu.ts#L884)). This is not reliable product behavior: the chat loop cannot distinguish a deliberate queued next turn from a line intended for a later structured question, auth prompt, or mode prompt.
- In the plain REPL, queueing is impossible by construction because `rl.pause()` is called before `runTask()` and `rl.resume()` only after it settles ([87](../src/interface/repl.ts#L87), [95](../src/interface/repl.ts#L95)).

Root cause:

- The line reader has a generic buffer but no state label: prompt input, queued chat turn, question answer, and child-process leftovers all share the same FIFO.
- The chat loop has no drain/peek API and no metadata for lines captured while `currentAc` was non-null.

Proposed semantics:

- While a model turn is running, the user may type full lines and press Enter. Each non-empty submitted line is appended to a chat-turn queue.
- Show a lightweight hint when a line is queued, for example `queued: <preview>` or `(queued 2 messages)`. The hint should be dim and must not redraw the spinner permanently; prefer printing on its own line after stopping/updating the spinner, or expose a spinner side-channel only if the spinner supports it cleanly.
- When the current turn settles successfully or fails normally, queued lines are run automatically as the next chat turns in FIFO order without re-rendering an empty prompt between them.
- Slash commands typed during a turn are queued as chat prompt inputs and interpreted when dequeued. This keeps behavior predictable: `/back` typed ahead exits after the current turn settles; `/goal ...` starts after the current turn settles.
- Queue on ESC interrupt: discard queued lines by default. ESC means "stop this turn"; sending already typed follow-up work after an interrupted/partial answer is surprising and may act on incomplete context. Print `(discarded N queued message[s])` when applicable. This is the safest default for an external, general-purpose end-user tool.
- Queue on Ctrl+C cancel: use the same discard policy for a single Ctrl+C task cancel. Double Ctrl+C/triple Ctrl+C also discard, then return to menu/exit.
- Queue on a structured question: if the model returns `final.questions`, do not feed queued chat lines into the question selector. Preserve queued lines only after the question flow completes if they were typed before the question appeared? Recommended: discard them with a clear `(discarded N queued message[s]; answer the question first)` notice, because they were typed without seeing the structured choices and could be misread as numbered answers.

Precise edits:

- Extend the `LineReader` interface in `src/interface/menu.ts` with a non-breaking capability object rather than changing `readLine` everywhere:
  - `beginCapture(onLine: (line: string) => void): () => void`
  - `drainBuffered(): string[]`
  - `clearBuffered(): void`
- Implement this inside `createLineReader`:
  - Add `capture: ((line: string) => void) | null`.
  - In `rl.on('line')`, after suppression handling and trimming, if `capture !== null`, call it and do not push to `buffered` or resolve waiters. This prevents mid-turn lines from leaking into question/auth/menu prompts.
  - `beginCapture` must be exclusive and idempotent for the current owner. If called while another capture is active, throw in tests or return a no-op only after documenting; recommended is throw, because concurrent capture would be a real bug.
  - `drainBuffered` and `clearBuffered` are needed to clean incidental stale buffered lines before entering question selectors or child handoffs.
- In `runChatLoop`, add a `queuedTurns: string[]` FIFO and a helper `runOneChatInput(line: string, source: 'prompt' | 'queue')`.
  - The existing body from effective mode through question handling ([2546](../src/interface/menu.ts#L2546) to [2975](../src/interface/menu.ts#L2975)) should move into this helper so the prompt loop and queue loop share command handling.
  - Before each `runTask()`, call `const stopCapture = lineReader?.beginCapture(...)` only when the real `LineReader` exists. For injected `readLine` tests, add a test-only optional queue source only if necessary; do not complicate production.
  - The capture callback trims lines using the same existing `createLineReader` behavior ([870](../src/interface/menu.ts#L870)); ignore blank lines; push non-empty lines to `queuedTurns`; write the queued hint.
  - In `finally`, call `stopCapture()`.
  - After a normal turn settles and after question handling is complete, process `while (queuedTurns.length > 0 && !shouldMenu && !shouldExit)` by shifting the next line and calling `runOneChatInput(next, 'queue')`.
- On ESC/Ctrl+C cancel paths, call `discardQueued('interrupt')` before returning to prompt/menu.
- Before any flow that suspends stdin for inherited stdio, call `lineReader.clearBuffered()` through `suspend()` as it already does ([926](../src/interface/menu.ts#L926)); do not add a second handoff owner.

Coexistence with 3.12.x stdin fixes:

- Queue capture belongs inside `createLineReader`, the same component that already owns line buffering and suspend/resume. That keeps one line-mode owner and avoids a second `stdin.on('data')` consumer.
- The ESC raw listener observes only ESC; printable queued text remains owned by readline line events. This avoids raw-mode manual line parsing and avoids the double-Enter/double-submit class of bugs.
- `suspend()` must clear both `buffered` and any chat capture state or refuse to suspend while capture is active. Recommended: `runTask` capture has already stopped before auth/login prompts; for defensive safety, `suspend()` should clear `buffered` and leave `capture` null only if no task is running. Do not silently steal active capture during a model turn.

Tests:

- Unit-test `createLineReader.beginCapture`: captured lines go to the callback, not `nextLine()`; after detach, lines again satisfy `nextLine()`; blank suppression after `resume()` still drops only the immediate blank and does not call capture.
- Unit-test discard policy as a pure helper: `decideQueueAfterTurn({ interrupted: true, questionPending: false, count: 2 })` returns discard; normal settle returns drain; question pending returns discard-with-notice.
- Integration-test menu chat with a fake provider that delays: submit first line, emit two more `line` events while the provider is pending, settle provider, assert the two queued tasks run in order.
- Integration-test queued slash command: queue `/back` during a turn, settle, assert chat returns to menu after the turn.
- Manual TTY test on Node 22: while `Thinking...` is visible, type two lines; verify hints display, current answer completes, queued turns run in order, no duplicate Enter, and no prompt dead-pause.

## Structured Question Rendering

Current behavior:

- `orchestrate()` detects a trailing `ask_user` block after a successful provider run, appends the assistant message, yields a successful `final` carrying `questions`, and returns without escalation/review ([638](../src/core/orchestrate.ts#L638), [645](../src/core/orchestrate.ts#L645), [651](../src/core/orchestrate.ts#L651), [652](../src/core/orchestrate.ts#L652), [660](../src/core/orchestrate.ts#L660)).
- `parseQuestions` is pure and validates one to four questions, each with two to four options ([120](../src/core/questions.ts#L120), [142](../src/core/questions.ts#L142), [148](../src/core/questions.ts#L148)). `formatAnswers` deterministically builds the next-turn text (`Answers: ...`) from selected answers ([192](../src/core/questions.ts#L192), [201](../src/core/questions.ts#L201)).
- `renderStream` strips the raw trailing `ask_user` block from display and suppresses the normal success/done line when `final.questions` exists ([636](../src/interface/render.ts#L636), [642](../src/interface/render.ts#L642)). Existing render tests cover split ask_user block stripping and no completion line ([1010](../test/unit/render.test.ts#L1010), [1019](../test/unit/render.test.ts#L1019), [1040](../test/unit/render.test.ts#L1040)).
- `runQuestionSelector` already prints each question prompt, numbered options, optional "type your own", reads a line, parses it via `interpretQuestionAnswer`, and returns `formatAnswers(...)` ([2267](../src/interface/menu.ts#L2267), [2274](../src/interface/menu.ts#L2274), [2276](../src/interface/menu.ts#L2276), [2282](../src/interface/menu.ts#L2282), [2292](../src/interface/menu.ts#L2292), [2294](../src/interface/menu.ts#L2294), [2317](../src/interface/menu.ts#L2317)).
- `runStructuredQuestionFlow` invokes the selector, resubmits the answer as the next turn, and caps consecutive question turns at three ([2675](../src/interface/menu.ts#L2675), [2680](../src/interface/menu.ts#L2680), [2686](../src/interface/menu.ts#L2686), [2697](../src/interface/menu.ts#L2697), [2713](../src/interface/menu.ts#L2713)).

Root cause of remaining defect:

- The rendering path exists, but it is embedded and fragile: queued prompt lines can be consumed as question answers because the same `readLine` FIFO is used for both chat input and selector input.
- `runQuestionSelector` is not exported, so integration tests have to drive the entire menu loop to prove the mechanical prompt appears.
- There is no explicit pre-question buffer clearing or queue policy, so a line typed while the model was still streaming can answer a question the user had not seen.

Proposed semantics:

- The canonical post-turn ordering is owned by the single exported `decidePostTurn({ hasQuestions, hasMemoryProposal, queuedCount, interrupted }) → ordered actions` helper specified in **`docs/MASTER-PLAN-5.5.md` (MF3)**: *settle → discard queued typeahead → (if questions) question flow → (else if memoryProposal) memory-approval selector → drain queue*. This chat-ux layer OWNS its implementation; memory-approval and question-flow both route through it so a queued line can never answer an unseen selector.
- Given `final.questions`, the chat loop must stop normal queued-turn processing and present a real interactive numbered selector with an input slot.
- Question answers are not chat-turn queue entries. They come only from user input after the question UI has been rendered.
- Any chat-turn queue captured during the preceding model turn is discarded before rendering the question selector, with a short notice, to avoid accidental answer injection.
- ESC during an answer-turn `runTask()` interrupts that answer turn and returns to the chat prompt; it does not reopen the previous selector automatically.

Precise edits:

- Export `runQuestionSelector` from `src/interface/menu.ts` or move it to a small `src/interface/questions-ui.ts` module. Moving it reduces future conflicts in `menu.ts`, but exporting is the smaller change.
- Before `runStructuredQuestionFlow(result.final)` ([2967](../src/interface/menu.ts#L2967)), call the queue discard helper if `result.final?.questions !== undefined`.
- Inside `runStructuredQuestionFlow`, use the queue/ESC-aware `runOneTask` helper for answer turns so answer resubmits get the same interruption and rendering behavior as normal turns.
- Keep `isKeepGoingOffer` interception before the generic selector ([2950](../src/interface/menu.ts#L2950)); that is a product decision already present. This audit does not change it.

Coexistence with 3.12.x stdin fixes:

- The selector must continue to use `readLine`, not `readSingleKey`, so it stays line-mode and testable. Do not add raw-mode multiple-choice input for numbers; raw single-key mode is already used only for menu/confirm prompts.
- Before selector input, make sure turn capture is detached. The selector should see only fresh lines entered after its prompt text is written.
- Do not suspend stdin around the selector; no inherited child owns the terminal.

Tests:

- Keep existing pure tests for `interpretQuestionAnswer` ([714](../test/unit/menu.test.ts#L714)) and `formatAnswers` in `test/unit/questions.test.ts`.
- Add a direct unit test for exported `runQuestionSelector`: renders options, accepts single-select, accepts multi-select, accepts free text, retries invalid input, returns null when skipped.
- Add a menu integration test where fake `orchestrate` returns `final.questions`; assert the output includes the prompt/options and the next provider call receives `Answers: id = value`.
- Add a regression test: queue a line during the model turn, then have the model return `final.questions`; assert the queued line is discarded and not used as the selector answer.

## Verbosity Rendering

Current behavior:

- `Verbosity` is a render-layer type: `'quiet' | 'normal' | 'verbose'` ([43](../src/interface/render.ts#L43)).
- `runTask` passes the selected verbosity to `renderStream` ([41](../src/interface/run.ts#L41), [46](../src/interface/run.ts#L46), [49](../src/interface/run.ts#L49)). `runChatLoop` passes `mutableCtx.config.verbosity ?? 'normal'` for normal, retry, question-answer, and goal turns ([2704](../src/interface/menu.ts#L2704), [2783](../src/interface/menu.ts#L2783), [2866](../src/interface/menu.ts#L2866), [2904](../src/interface/menu.ts#L2904)).
- Normal/quiet modes hide tool and reasoning text but keep the live indicator alive ([522](../src/interface/render.ts#L522), [527](../src/interface/render.ts#L527), [515](../src/interface/render.ts#L515)). Verbose mode prints tool lines, reasoning, tier telemetry, escalation, failover, and success metadata ([470](../src/interface/render.ts#L470), [510](../src/interface/render.ts#L510), [523](../src/interface/render.ts#L523), [553](../src/interface/render.ts#L553), [567](../src/interface/render.ts#L567), [577](../src/interface/render.ts#L577), [648](../src/interface/render.ts#L648)).
- Quiet mode still shows prose and actionable errors, but hides completion/cancel chrome ([608](../src/interface/render.ts#L608), [609](../src/interface/render.ts#L609), [615](../src/interface/render.ts#L615), [624](../src/interface/render.ts#L624), [646](../src/interface/render.ts#L646), [656](../src/interface/render.ts#L656)).
- Tests already verify verbosity gating ([850](../test/unit/render.test.ts#L850), [895](../test/unit/render.test.ts#L895), [907](../test/unit/render.test.ts#L907), [918](../test/unit/render.test.ts#L918)).

Root cause / boundary:

- The raw output detail knob is already a renderer concern. The needed work is to keep new queue/ESC/question notices obeying the same render-detail expectations without using verbosity as a persona or answer-length control.

Proposed rendering rules for new mechanics:

- ESC/Ctrl+C interrupt notices are operational, not model verbosity. Show them in `normal` and `verbose`; in `quiet`, show only the minimal prompt transition unless hiding it would leave the UI ambiguous. Recommended: `Interrupted.` in all modes because it explains why the stream stopped.
- Queue hints are UI chrome. Show in `normal` and `verbose`; suppress in `quiet` except for discard notices that prevent data-loss confusion.
- Structured question UI is required user interaction, not verbosity chrome. Always render it in every verbosity mode.
- Do not change prompt/persona instructions or answer-length policy here.

Precise edits:

- Keep `renderStream` unchanged unless the implementation needs a public `stopSpinnerForExternalNotice()` seam. Prefer not to couple queue hints to `renderStream`; queue hints live in `runChatLoop`.
- Add small helper functions in `menu.ts`, e.g. `renderQueuedHint(out, verbosity, queueLength, preview)` and `renderDiscardedQueue(out, verbosity, count, reason)`, pure enough to snapshot by sink output.
- Include current output detail in `/help` only if existing UX already exposes it elsewhere; do not make a new persona explanation.

Tests:

- Unit-test queue/interrupt notice rendering across `quiet`, `normal`, and `verbose`.
- Preserve `renderStream` verbosity tests unchanged unless a new seam is added.
- Manual test with TTY spinner: queue hint must not leave broken spinner control characters or overwrite model prose.

## Implementation Sequencing

1. Add pure decision helpers and tests only:
   - Touches: `src/interface/menu.ts`, `test/unit/menu.test.ts` or `test/unit/ctrl-c-model.test.ts`.
   - Add `interpretChatKey`, queue-after-turn decision helper, and notice rendering helpers.

2. Extend `createLineReader` with explicit capture:
   - Touches: `src/interface/menu.ts`, `test/unit/menu-flow.test.ts`.
   - Add `beginCapture`, `drainBuffered`, `clearBuffered`; preserve existing suspend/resume tests exactly and add capture-specific tests.

3. Add scoped ESC listener:
   - Touches: `src/interface/menu.ts`, `test/unit/menu-flow.test.ts`.
   - Implement `attachChatTurnKeyListener` without `removeAllListeners`, `/dev/tty`, `stdin.read()`, or suspend/resume calls.

4. Refactor `runChatLoop` into reusable turn helpers:
   - Touches: `src/interface/menu.ts`, likely `test/unit/menu-flow.test.ts`.
   - Extract `runOneChatInput`, `runOneTaskWithInputHooks`, queue drain/discard helpers. Keep behavior-preserving first, then enable queue/ESC.

5. Harden structured-question mechanics:
   - Touches: `src/interface/menu.ts` or new `src/interface/questions-ui.ts`, `test/unit/menu.test.ts`, `test/unit/menu-flow.test.ts`.
   - Export or move `runQuestionSelector`; discard queued chat lines before selector; add direct selector tests.

6. Rendering polish and manual TTY pass:
   - Touches: `src/interface/menu.ts`, possibly `src/interface/render.ts` only if a spinner seam is unavoidable.
   - Verify Node 22 with `PATH="/nix/store/51gywl5jn4nna7al9waj142pw4vfhy0k-nodejs-22.19.0/bin:$PATH"`.

## Risk

- Replit/web shells may report `out.isTty` differently from `stdin.isTTY`, or may not support stable raw mode. ESC must degrade to "unsupported" without breaking normal line input.
- Adding a raw listener during readline terminal mode can duplicate or steal bytes if implemented with `data` parsing. Keep printable input in readline and observe only ESC.
- Spinner output and queued hints can visually collide. The first implementation should accept a simple dim line over clever in-place updates.
- Queueing slash commands can surprise users if `/back` typed mid-turn exits immediately after the answer. This is still predictable FIFO behavior; document it in `/help` only if testing shows confusion.
- Structured questions plus queueing are the highest-risk interaction: never allow pre-question queued lines to answer unseen choices.
- The existing 3.12.x handoff relies on a single suspend owner and no `stdin.read()` drain. Any helper that touches stdin must be audited against the suspend/resume tests before merge.

## Summary

Implement ESC as a scoped, non-SIGINT turn interrupt; implement queueing inside the existing `createLineReader` rather than with a second line parser; discard queued lines on interrupts and before structured questions; keep question selectors line-based and always rendered; and treat verbosity only as render chrome, not model behavior. The safest split is pure helpers first, line-reader capture second, ESC third, chat-loop queue drain fourth, and structured-question hardening last.
