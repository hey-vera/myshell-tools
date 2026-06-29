# UX Bugs Diagnosis: v3.159.0

Scope: diagnosis and fix plan only. No source or test changes.

## Bug 1: chat answer is shown, then the turn is marked Failed

### Root cause

There are two real paths that can produce the owner's symptom. The dominant worker/opencode path is a same-attempt terminal-error path, not an accept-stage append followed by a later verifier failure.

1. The opencode adapter streams text and usage before it has a terminal success event.
   - `src/providers/opencode-parse.ts:193-201` accumulates assistant text and emits live `text` deltas.
   - `src/providers/opencode-parse.ts:230-255` accumulates step token usage and emits `usage`.
   - `src/providers/opencode-parse.ts:273-333` can only emit `done` from `finalize()`, because opencode has no terminal done line.

2. `src/providers/opencode.ts` gives process/JSONL errors precedence over that accumulated answer.
   - An inline opencode JSONL error is yielded and the stdout loop is broken at `src/providers/opencode.ts:220-227`; because `emittedTerminal` is set, `finalize()` is skipped at `src/providers/opencode.ts:267-273`.
   - If stdout ends after text/usage but the process exits nonzero, `src/providers/opencode.ts:255-264` emits `error` and sets `emittedTerminal`; again `finalize()` is skipped at `src/providers/opencode.ts:267-273`.
   - Result: the user can see a complete-looking streamed answer, but the provider run never yields `done`.

3. `work-call` treats any provider error event as attempt failure even if prose was already streamed.
   - `src/core/work-call.ts:243-259` forwards provider events and records `errored` on an `error` event.
   - `src/core/work-call.ts:1477-1498` turns the provider outcome into `finalText` plus `errored`.
   - `src/core/work-call.ts:1507` defines attempt success as `errored == null`.
   - `src/core/work-call.ts:1544-1559` records the ledger entry with that failure status but with the real usage tokens.
   - `src/core/work-call.ts:1593-1603` emits `tier-done` with the real input/output token counts and `success:false`.
   - `src/core/work-call.ts:1605-1619` only creates `acceptedRun` when `success` is true, so this path does not persist the assistant answer through `appendAcceptedAssistant`.
   - If no failover/escalation rescues the turn, `src/core/work-call.ts:2515-2525` emits a terminal `final` with `success:false`.

4. The UI then flushes the streamed prose and prints Failed from the same attempt.
   - The Ink reducer commits buffered prose at tier boundary regardless of tier success at `src/interface/ui/reduce.ts:547-553`, then marks the active goal failed at `src/interface/ui/reduce.ts:563-568`.
   - The terminal final branch prints `Failed - tier: ..., tokens, attempts, session` whenever `action.success` is false at `src/interface/ui/reduce.ts:686-721`.
   - The legacy renderer has the same basic ordering: prose is flushed before the final line at `src/interface/render.ts:908-910`, and non-success without `blocked` prints Failed at `src/interface/render.ts:1018-1036`.

That explains the "0 tokens before routing fix, 113.6k tokens now" clue: the provider did run and emitted usage, but the adapter/core classified the attempt as failed after or instead of finalizing the accumulated opencode answer.

### Context bloat finding

The 113.6k token figure is not caused by raw whole-history replay alone, but the current prompt can still be heavy enough to push worker/opencode into context-pressure failure:

- Prior history is capped by `src/core/history.ts:23-25` to 6,000 chars and 12 turns by default.
- History compaction drops old turns and truncates an overlong single turn at `src/core/history.ts:161-193`.
- Extra context blocks are separately capped at 6,000 chars by `src/core/prompt-context.ts:176` and assembled/truncated at `src/core/prompt-context.ts:396-448`.
- `src/core/orchestrate.ts:1665-1670` calculates context block raw length and reduces history via `planHistoryCompaction`.
- `src/core/orchestrate.ts:1717-1722` estimates input tokens from task, history, and initial context, but there is no provider-specific hard cap or preflight refusal here.
- `src/core/work-call.ts:1309-1347` sends the built prompt to the provider, and `src/core/work-call.ts:1420-1445` passes it straight through the provider request.

So this is bounded, not "entire conversation unbounded every turn." The missing piece is a provider/model-specific token cap before opencode-go. A large task plus context blocks plus tool/model internal usage can still produce a 113.6k-token failed attempt, and the opencode adapter then makes post-output/nonzero exits terminal even when the user saw substantial text.

### Separate cosmetic mislabel path

There is also a real Ink-only mislabel for accepted usable answers:

- `src/core/accept-stage.ts:217-245` appends an accepted best-effort assistant answer at `src/core/accept-stage.ts:222`, then returns `success:false` with `blocked` when `blockedStateV1` is on.
- `src/interface/ui/blocked-state-flag.ts:12-23` makes blocked state default on unless explicitly opted out.
- The interactive menu passes `blockedStateV1` into orchestration at `src/interface/menu.ts:2755-2757`.
- The legacy renderer handles this distinctly as `Blocked` at `src/interface/render.ts:983-997`.
- The Ink event adapter drops `blocked` entirely at `src/interface/ui/core-event.ts:155-169`.
- The Ink reducer has no blocked branch and prints `Failed` for every `success:false` final at `src/interface/ui/reduce.ts:686-721`.

This cosmetic path is how a genuinely accepted, persisted best-effort answer can be mislabeled as Failed in Ink. It is separate from the opencode post-output error path above, where the answer was streamed but not accepted/persisted.

### Minimal fix plan

1. Fix opencode terminal precedence.
   - In `src/providers/opencode.ts:234-273`, do not let a post-output nonzero process exit suppress a substantive parser finalization.
   - Minimal shape: after stdout drains, call a parser method that can distinguish "has accumulated answer/usage" from "no output." If it has substantive accumulated text, yield `done` and treat stderr/nonzero as diagnostic metadata or a warning, not a terminal provider error. Keep timeout/cancel terminal at `src/providers/opencode.ts:237-254`.
   - For inline JSONL `error` after text at `src/providers/opencode.ts:220-227`, either defer terminal classification until after checking accumulated text, or classify it as terminal only when no substantive text has accumulated. Context-limit errors with no complete answer remain real failures.

2. Harden core finalization against `done` followed by `error`.
   - `src/core/work-call.ts:246-259` currently allows a later provider error to coexist with a prior `done`.
   - Once a provider has emitted `done` with non-empty text and usage, `streamProvider` should not allow a later adapter/process error to flip that same attempt to `errored`, unless the adapter marks it as a cancellation/timeout or an explicit incomplete-output error.

3. Add provider cap/truncation before opencode-go.
   - Use the existing estimated input at `src/core/orchestrate.ts:1717-1722` plus model capability data to decide whether worker/opencode-go can fit the turn.
   - If not, either shed lower-value context before `src/core/work-call.ts:1309-1347` or route to a larger-context provider/tier before `src/core/work-call.ts:1420-1445`.

4. Fix Ink blocked/best-effort rendering.
   - Thread `blocked` through `src/interface/ui/core-event.ts:155-169`.
   - Add a blocked branch before the generic failure branch in `src/interface/ui/reduce.ts:686-721`, matching `src/interface/render.ts:983-997`.
   - Keep `receipt.verdict === 'unverified'` as a non-failure signal. Unverified accepted output should render as success/best-effort, not Failed.

### How to tell genuine failure from mislabel

- Genuine failure: provider emitted no accepted `done`, `acceptedRun` was never set at `src/core/work-call.ts:1605-1619`, and the terminal final comes from `src/core/work-call.ts:2515-2525` or one of the explicit timeout/auth/review failure finals. The streamed text may be partial/transient.
- Cosmetic mislabel: the final carries `blocked` or should carry best-effort accepted output. In that case `src/core/accept-stage.ts:222` already persisted the assistant answer, and the UI should render Blocked or Best-effort/Unverified, not Failed.

## Bug 2: pervasive input/menu lag and repeated keypresses

### Dominant root cause

The menu key reader is only armed after awaited repaint/refresh work. In Replit's browser PTY, keys pressed during those awaited windows are not consumed by the menu resolver, so they feel dropped.

Evidence:

- `src/interface/menu.ts:6918-6942` does several awaited operations before `readMenuKey` is called: dirty spend refresh, dirty list refresh, optional environment refresh, then `await paintMenu()`.
- `src/interface/menu.ts:6921-6924` can reread and summarize the full ledger before any key reader is armed.
- `src/interface/menu.ts:6926-6930` can reread conversation and parked-goal lists before any key reader is armed.
- `src/interface/menu.ts:6895-6909` paints the whole menu frame, and the loop awaits that paint at `src/interface/menu.ts:6940-6942` before arming input at `src/interface/menu.ts:6956-6962`.
- The Ink bridge only creates a pending one-key resolver when `readKey()` is called at `src/interface/ui/App.tsx:191-200`.
- InputBox routes a key to the menu only while `readPending()` is true at `src/interface/ui/InputBox.tsx:405-412`.
- If no read is pending, printable input falls through into the editor buffer at `src/interface/ui/InputBox.tsx:604-624`. During the main menu the composer is hidden, so that consumed key looks like it did nothing.

This is why the symptom is "have to press keys multiple times" rather than "the repaint is slow." The first key can arrive while the menu is rendering or refreshing and is consumed outside the one-key resolver; a later key lands after `src/interface/menu.ts:6961` has armed `readMenuKey`.

### Ranked contributors

1. Input is armed too late after awaited menu work.
   - Primary lines: `src/interface/menu.ts:6918-6962`, `src/interface/ui/App.tsx:191-200`, `src/interface/ui/InputBox.tsx:405-412`, `src/interface/ui/InputBox.tsx:604-624`.
   - This is a real dropped-key class because the key can be consumed while no `_keyResolver` exists.

2. Full ledger/list reads still block the next key after returning from flows.
   - Chat/subflows mark refresh flags at `src/interface/menu.ts:7000-7001`, `src/interface/menu.ts:7015-7016`, `src/interface/menu.ts:7033-7034`, `src/interface/menu.ts:7044-7045`, and `src/interface/menu.ts:7051-7052`.
   - The next menu loop services those flags synchronously at `src/interface/menu.ts:6921-6930` before arming `readMenuKey`.
   - The full ledger read is specifically `src/interface/menu.ts:6872-6876` and `src/interface/menu.ts:6921-6924`.

3. Async menu repaints can overlap and fight the frame buffer.
   - `src/interface/menu.ts:6911-6916` calls `void paintMenu()` with no serialization.
   - First-load async fills schedule three independent repaints at `src/interface/menu.ts:6949-6952`.
   - Environment refresh can trigger another repaint at `src/interface/menu.ts:6932-6935`.
   - `src/interface/ui/mount.tsx:141-158` allows re-entrant `beginFrame()` by keeping the existing frame buffer, so overlapping paints can inflate or misorder transient frames.

4. Full menu-frame promotion still grows committed transcript on real action keys.
   - `src/interface/menu.ts:6975-6979` promotes the whole menu frame on every real action.
   - `src/interface/ui/mount.tsx:160-165` dispatches `chrome/promote`.
   - `src/interface/ui/reduce.ts:228-233` appends the frame into `committed`.
   - `src/interface/ui/App.tsx:386-395` memoizes the committed transcript mapping, which reconciles the 3.156.0 fix: render mapping churn is reduced, but the committed transcript still grows by full menu frames.

5. Listener churn is lower priority now.
   - `src/interface/ui/InputBox.tsx:399-412` keeps a stable input subscriber and routes menu reads through the same handler.
   - `src/interface/ui/InputBox.tsx:629-632` passes a stable callback to `useInput`.
   - `src/interface/ui/InputBox.tsx:634-646` eagerly rearms raw mode after suspend/resume.
   - This means the current bug is less likely from repeated listener removal/re-add and more likely from unarmed resolver windows and main-thread/I/O blocking.

### Minimal fix plan

1. Arm menu input before awaited paint or I/O.
   - In `src/interface/menu.ts:6918-6962`, create the pending Ink key read before `await paintMenu()` and before dirty refreshes, then interpret/echo the key after the frame is visible.
   - Better: add a small menu-key FIFO to the Ink bridge. If the main menu is active and no `_keyResolver` exists, queue one printable key instead of letting `InputBox` mutate its hidden editor. Then `readKey()` at `src/interface/ui/App.tsx:191-200` drains that FIFO before waiting.
   - Do not globally capture hidden input during auth/settings/readLine prompts; gate this by an explicit "main menu capture active" flag, not merely `visible === false`.

2. Move dirty refreshes off the key path.
   - Replace the awaited `readLedger` and list reloads at `src/interface/menu.ts:6921-6930` with stale-while-revalidate cached data plus repaint when done.
   - Keep first paint behavior from `src/interface/menu.ts:6829-6838`, but apply it to every return-to-menu refresh, not only startup.

3. Serialize and debounce menu repaints.
   - Replace `void paintMenu()` at `src/interface/menu.ts:6913-6916` with a single queued repaint. Drop stale generations when `inMainMenu` flips false at `src/interface/menu.ts:6980-6982`.
   - Coalesce first-load fill repaints from `src/interface/menu.ts:6949-6952` into one microtask/timer repaint.

4. Stop promoting full menu frames.
   - At `src/interface/menu.ts:6975-6979`, clear the live frame or commit a one-line breadcrumb instead of promoting the entire frame.
   - This complements the 3.156.0 memoization at `src/interface/ui/App.tsx:386-395`; it reduces future committed transcript growth rather than only making that growth cheaper to render.

5. Replace full ledger rereads with an incremental spend cache.
   - The hot reads are `src/interface/menu.ts:6872-6876`, `src/interface/menu.ts:6921-6924`, and goal progress reads at `src/interface/menu.ts:5094-5098`.
   - Cache by ledger file size/mtime or append offset, and update in the background.

### Replit-specific conclusion

Replit makes this worse because output and filesystem awaits are slow enough that users naturally type during the unarmed window. The browser PTY then delivers the key to Ink while no menu resolver is pending; InputBox consumes it as hidden editor input. The right fix is not another render-only optimization. It is to make input capture non-blocking: arm or buffer input first, repaint later, and keep disk/ledger reads off the keystroke path.
