# Real-Chat Gap Analysis — what's between myshell and a chat that *feels real* (design 5.6)

**Status: DESIGN / RESEARCH ONLY.** This document changes no `src/` or `test/`. It is the
companion to the conversation-continuity work already underway (the "resume doesn't feel like
it loaded the context" fix) and answers the user's question — *"anything else we should
research so it's actually a real chat?"*

It is grounded in myshell's real code (cited `file:line`) and reconciled against the existing
5.5/5.6 design docs so we **identify gaps, not duplicate** what's already designed:

- [recap-feature-5.5.md](./recap-feature-5.5.md) — the `※` one-line orientation on resume.
- [chat-presentation-5.5.md](./chat-presentation-5.5.md) — turn marker `●`, status line, streaming.
- [tab-completion-5.5.md](./tab-completion-5.5.md) — Tab → slash + `@`-file + path completion.
- [memory-architecture-5.5.md](./memory-architecture-5.5.md) — durable cross-session user memory.
- [chat-ux-audit-5.5.md](./chat-ux-audit-5.5.md) — ESC/Ctrl+C/typed-ahead stdin mechanics.

**The hard constraint, restated:** myshell is **subscription-auth**, not API-key. No metered
services, no embeddings/vector DB, and **no token-budget / context-window-remaining readout**
(the subscription CLIs don't expose a per-call token meter we could honestly show). Every
design below honors this — where a "feel real" feature normally leans on a token meter
(e.g. Codex's `context-remaining` footer), we substitute an honest, locally-measurable signal
or omit it rather than fabricate.

---

## 0. The one-paragraph diagnosis

myshell already has the *hard* parts of a real chat: truthful streaming with a `●` marker and
a live status line, ESC-to-interrupt, typed-ahead queueing, a persistent multi-conversation
store, durable memory, and a `※` recap on resume. What it's missing is the **continuity and
message-level surface** that makes a chat feel like a *place you return to* rather than a
fresh prompt that happens to remember things: you can't **see the transcript** you're resuming
into, you can't **edit/redo a turn**, you can't **copy or export** an answer, the resume
**picker is thin**, titles are **truncations not summaries**, and **input is single-line with
no cross-session history**. These are exactly the gaps the best tools have closed.

---

## 1. RANKED gaps (highest "makes it feel real" impact first)

Each gap: **(a)** what's missing in myshell · **(b)** how the best tools do it (cited) ·
**(c)** a subscription-friendly design sketch + where it hooks · **(d)** effort/impact.

---

### Gap 1 — Resume shows a one-line recap, but **never reprints the transcript** ★★★★★

**(a) What's missing.** On resume, `runChatLoop` prints exactly one `※` recap line and one
dim orientation line (`menu.ts:3043-3073`), then drops you at a bare caret. The full history
*is* loaded into model context every turn (`ctx.store.load(convId)`, `menu.ts:3465`), but the
**human never sees the prior messages** — there is no loop that renders the stored
`SessionEntry[]` to screen. So resuming "doesn't show/feel like it loaded the context" — the
exact gap the user hit. The store has everything needed: `load(id)` returns the full
oldest-first message log (`conversation-store.ts:45`).

**(b) How the best tools do it.** This is a *known, actively-complained-about regret* in
Claude Code: resuming no longer reprints prior messages even though it used to, and users
file it as a bug ([claude-code #8937](https://github.com/anthropics/claude-code/issues/8937));
the TUI's alternate-screen buffer also truncates scrollback to ~250 lines
([#40253](https://github.com/anthropics/claude-code/issues/40253),
[#28077](https://github.com/anthropics/claude-code/issues/28077)). ChatGPT and Claude.ai, by
contrast, *render the whole prior thread* the instant you open a conversation — that visible
backlog is most of why a web chat "feels real." **This is myshell's single biggest
opportunity to be visibly better than the terminal incumbents**, because our store already
holds the clean message log and we don't fight an alt-screen buffer.

**(c) Design sketch — "replay on resume."** On entering `runChatLoop`, before the recap line,
render a **bounded, styled transcript tail**:
- Load `await ctx.store.load(convId)`; take the last *N* turns (default ~6 message pairs;
  configurable). Render each through the same prose/markdown styler used live
  (`render.ts` inline-markdown path) with the same `●`/user glyphs, dimmed slightly so it
  reads as "history, not new output."
- Above it, a single dim rule: `── earlier in this conversation (12 messages) ──` and, when
  truncated, `… 8 earlier messages — /transcript to see all`. This is honest about what's on
  screen vs. on disk.
- Keep the existing `※` recap line *below* the replayed tail as the "where we left off"
  capstone — recap and transcript are complementary (recap = orientation, transcript =
  receipts), so this doesn't duplicate [recap-feature-5.5.md], it completes it.
- Add a `/transcript` slash command (and Tab entry) that prints the **entire** history on
  demand for long threads, since we *can* scroll the normal terminal buffer (no alt-screen).

**Where it hooks.** A new `renderTranscriptTail(entries, opts)` in `render.ts` (pure-ish,
sink-driven), called from `runChatLoop` right where the recap block is today
(`menu.ts:3043`). New `/transcript` case alongside `/recap` (`menu.ts:3399`).

**(d) Effort: M. Impact: ★★★★★.** All data already exists; the work is a styled render loop +
a truncation rule + one command. This is the literal fix for the reported gap and the highest
felt-realness win.

---

### Gap 2 — No **message-level redo**: can't edit a prior turn, retry the last answer, or fork ★★★★★

**(a) What's missing.** Once a turn lands, it's frozen. There's no "that wasn't quite right,
try again," no "let me rephrase my last message," no branch. The only escape is to type a new
message or `/back`. ESC interrupts a *running* turn (`interpretChatKey`, `menu.ts:881`) but
there is no post-hoc redo. The store is append-only (`conversation-store.ts:50`) with no
delete-last / truncate-from operation.

**(b) How the best tools do it.** This is the defining "feel real" interaction of 2026 chats:
- **Codex CLI:** *"Tap Esc twice while the composer is empty to edit your previous user
  message. Continue pressing Esc to walk further back… then hit Enter to fork from that
  point."* ([Codex features](https://developers.openai.com/codex/cli/features),
  [#5030](https://github.com/openai/codex/issues/5030)).
- **Claude Code:** Esc-Esc to edit a previous prompt
  ([kentgigger](https://kentgigger.com/posts/claude-code-escape-escape-shortcut)); GitHub
  Copilot CLI tracking the same ([copilot-cli #100](https://github.com/github/copilot-cli/issues/100)).
- **aider:** `/undo` reverts the last exchange; "scroll back through previously sent messages
  with Ctrl-Up" to re-send/edit ([aider commands](https://aider.chat/docs/usage/commands.html)).
- **opencode:** "Undo… removes the most recent user message, all subsequent responses, and any
  file changes" ([opencode TUI](https://opencode.ai/docs/tui/)).
- **ChatGPT / Claude.ai:** editing a prior user message **forks a branch** you can toggle
  between ([smithstephen](https://www.smithstephen.com/p/conversation-branching-the-ai-feature)).

**(c) Design sketch — start with the 80%, defer true branching.** Two cheap commands cover
most of the value without a branching data model:
- **`/retry`** (a.k.a. `/redo`/`/again`): re-run the *last user turn* and replace the last
  assistant answer. Implementation: the store needs a `truncateAfter(id, messageIndex)` /
  `popLastAssistant(id)` op; pop the last assistant entry (and its tool entries), then feed
  the preceding user message back through `runTaskWithInputHooks` exactly as a normal turn.
- **`/edit`**: reprint the last user message into the input buffer for editing (or, off a
  capable TTY, the **Esc-Esc** gesture), then on submit `truncateAfter` that point and re-run.
  Because myshell isn't an alt-screen Ink app, the simplest honest version is `/edit` echoes
  the prior text and you retype; an Esc-Esc keystroke path can layer on later via the existing
  mid-turn key listener (`attachChatTurnKeyListener`, near `menu.ts:1351`).
- **Branching is the stretch goal.** Don't build a tree yet (Claude.ai itself still has no
  native branching — [claudekit](https://claudekit.app/blog/claude-vs-chatgpt-missing-features)).
  A "fork into a new conversation from here" that copies history up to point N into a fresh
  `store.create()` conversation gives 90% of branch value with zero new data model.

**Where it hooks.** New `ConversationStore.truncateAfter(id, n)` in
`conversation-store.ts` + `conversations.ts` (append-only store gains one rewrite path,
atomic via the existing `atomic.ts`). New `/retry` and `/edit` cases in the slash dispatch
(`menu.ts:3369+`); add both to `CHAT_SLASH_COMMANDS` (`menu.ts:522`).

**(d) Effort: M-L (store mutation is the real cost). Impact: ★★★★★.** `/retry` alone is the
single most-requested "real chat" verb and is a small slice; ship it first.

**(e) v9 Phase 7 status — partial.** Two related, narrower capabilities shipped in Phase 7:

- **Feature rollback** (`myshell-tools rollback` / `MYSHELL_ROLLBACK=1`) — disables verify,
  judgment, and trust; restores the pre-v9 feature posture. This is a **feature-posture
  switch**, not an undo of workspace file changes. Scope: verify/judgment/trust only.
- **Goal cancellation** (`/goals cancel <n>`) — terminates a parked goal and its live
  descendants, preserving already-completed or verified sub-work. This is **goal-level
  cancellation**, not a filesystem undo.

**Arbitrary workspace undo (reverting file edits made by model turns) remains OUT OF SCOPE.**
It requires a separate transaction/snapshot design covering git/worktree snapshots,
dirty-tree ownership, non-git workspaces, external commands, and provider-native edits.
Calling either feature above "workspace undo" would be misleading. The `/undo`-style
full-revert seen in aider and opencode is a distinct, unbuilt capability that needs its own
design phase.

---

### Gap 3 — Can't **copy a response** or **export the conversation** ★★★★☆

**(a) What's missing.** There is no way to grab the last answer or save a thread. `/memory
export` exists for durable facts (`menu.ts:3923` region) but **conversations** have no export
and no copy. A user who got a great answer has to mouse-select it out of the scrollback.

**(b) How the best tools do it.** Export/share is table-stakes:
- **Claude Code:** `/export` copies the conversation to clipboard or writes a readable text
  file ([kentgigger](https://kentgigger.com/posts/claude-code-conversation-history)).
- **Gemini CLI:** `/chat share file.md|file.json` writes the conversation out
  ([Gemini CLI commands](https://geminicli.com/docs/reference/commands/)).
- **opencode:** "export the current conversation to Markdown and open it in your editor," plus
  a share-link that's copied to clipboard ([opencode TUI](https://opencode.ai/docs/tui/)).

**(c) Design sketch — local-only, no share service.** Honor the subscription constraint by
doing **export-to-file and copy-to-clipboard only** — no hosted share link (that'd be a metered
service and a privacy surprise).
- **`/export [file.md]`**: render `store.load(convId)` to Markdown (`## You` / `## Assistant`
  sections, fenced tool output) and write it; default path `./myshell-<title-slug>.md`. Reuse
  the same renderer as `/memory export`.
- **`/copy`**: copy the **last assistant message** to the clipboard. Clipboard is the one bit
  of OS I/O to add — shell out to `pbcopy`/`wl-copy`/`xclip`/`clip.exe` by platform, best-effort,
  and **fall back to printing the text in a clean copy-friendly block** when no clipboard tool
  exists (common on headless Replit — be honest: "no clipboard here; select the text above").

**Where it hooks.** `/export` and `/copy` cases in the dispatch; a small
`infra/clipboard.ts` (platform shell-out, fail-soft) and a `conversationToMarkdown(entries)`
formatter (pure, testable). Add both to `CHAT_SLASH_COMMANDS`.

**(d) Effort: S-M. Impact: ★★★★☆.** Export is pure + cheap; clipboard is a small, well-bounded
platform shim. High trust payoff ("my work isn't trapped in here").

---

### Gap 4 — The **resume picker is thin**; conversation list lacks the at-a-glance cues ★★★★☆

**(a) What's missing.** The list shows `[N] 📌 2h ago  <title>  [category]` plus an optional
dim recap line (`renderConversationList`, `menu.ts:783-803`) — already good. But selecting a
conversation drops you straight in; there's no richer **picker** with per-conversation
**message count**, and `messageCount` is in the meta (`conversation-store.ts:21`) yet not
shown. There's also no "continue last conversation" one-keypress (the resume entry exists at
`menu.ts:4561-4567` but isn't surfaced as a first-class "↵ resume where you left off").

**(b) How the best tools do it.** Claude Code's `/resume` picker shows **session summaries,
message counts, git branch, and timestamps** in an interactive list
([kentgigger](https://kentgigger.com/posts/claude-code-conversation-history)); `--continue`
jumps straight back into the most recent. The richness of that picker is what makes "switching
between conversations" feel like switching between *places*.

**(c) Design sketch.** Cheap upgrades to the existing list, no new store:
- Append a dim ` · N msgs` to each row from `m.messageCount` (already stored).
- Show the current repo/cwd context next to the row when it differs (we already have repo-map
  awareness from [codebase-awareness-5.6.md]); helps the "which project was this?" question
  without git-branch coupling.
- Make `n`→Enter (or a dedicated key) "**resume the top conversation**" so returning users get
  a one-keypress continue, matching `claude --continue`.

**Where it hooks.** Extend `renderConversationList` (`menu.ts:783`) to include the count; the
list already slices to 7 and sorts pinned-first. Resume-top wiring near `menu.ts:4561`.

**(d) Effort: S. Impact: ★★★★☆.** Pure presentation over data we already have.

---

### Gap 5 — Titles are **truncations, not summaries**; no auto-naming ★★★☆☆

**(a) What's missing.** New conversations are created untitled (`store.create('')`,
`menu.ts:4552`) and the title is then `deriveTitle(firstUserMessage)` — the first few words of
the opening message (`conversations.ts:157,344-355`). So a thread that opens "hey can you look
at this" is forever titled *"hey can you look at this,"* even after it becomes a JWT migration.

**(b) How the best tools do it.** ChatGPT/Claude.ai **auto-generate a semantic title** from
the conversation (then let you rename) — the title reflects the *topic*, not the first
keystrokes ([nexasphere](https://nexasphere.io/blog/organize-ai-conversations-chatgpt-claude-gemini-2026)).
Claude Code is itself missing rename and good titles and users file it
([claude-code #11956](https://github.com/anthropics/claude-code/issues/11956)) — so doing this
*well* is a differentiator.

**(c) Design sketch — reuse the recap generator, no new model machinery.** The
[recap-feature-5.5.md] worker-tier generator already summarizes a thread cheaply
(`makeRecapGenerator`, `menu.ts:2939`). Piggyback on it: when a recap is (re)generated and the
title is still the auto-derived stub, also emit a **3-5 word topic title** and `store.rename`
it (only if the user hasn't manually renamed — same guard as `deriveTitle` already uses at
`conversations.ts:348-355`). Gate it behind the same staleness/eligibility checks so it's one
cheap pass, fail-soft, no extra model call beyond the recap we already make. Subscription-safe:
it rides the existing recap touch.

**Where it hooks.** `resolveRecap` (`menu.ts:2979`) returns text today; extend the generator
output to optionally include a title and call `store.rename` when the title is still a stub.

**(d) Effort: M. Impact: ★★★☆☆.** Nice, compounding polish; lower urgency than 1-3.

---

### Gap 6 — **Input is single-line**; no multi-line compose, no cross-session history ★★★☆☆

**(a) What's missing.**
- **Multi-line:** the chat reads one `readline` line per turn (`createLineReader` over a single
  `node:readline` interface, `menu.ts:4354`). Pasting a multi-line block or composing a
  paragraph with intentional newlines isn't supported — Enter always submits.
- **History recall:** `terminal: out.isTty` gives Node readline's built-in up-arrow history,
  but only **within the current process** and capped at the default size — it is **not
  persisted across sessions**, so returning users can't up-arrow to last week's prompt.

**(b) How the best tools do it.**
- **Multi-line (terminal-agnostic):** Claude Code uses **`Ctrl+J`** or **`\`-then-Enter**
  (backslash continuation) for a newline-without-submit — explicitly because Shift+Enter sends
  the same bytes as Enter in most terminals
  ([Claude Code multiline](https://www.developersdigest.tech/guides/multiline-input),
  [why Shift+Enter doesn't work](https://dev.to/richardbray/why-shiftenter-doesnt-work-in-claude-code-and-how-to-fix-it-10f7)).
  aider offers `/editor` (or Ctrl-X Ctrl-E) to compose in `$EDITOR`; opencode opens `$EDITOR`
  too ([aider](https://aider.chat/docs/usage/commands.html), [opencode](https://opencode.ai/docs/tui/)).
- **History:** aider has **persistent** message history with Up-arrow and **Ctrl-R reverse
  search** ([aider tips](https://aider.chat/docs/usage/tips.html)).

**(c) Design sketch.**
- **Multi-line:** adopt the two universal, no-terminal-config methods: a **trailing `\` then
  Enter continues** the line, and **`Ctrl+J` inserts a newline**. Backslash-continuation is
  pure line-buffer logic in the `LineReader` (accumulate until a line that doesn't end in `\`);
  Ctrl+J needs a small raw-mode insert. Also add **`/editor`** to compose the next message in
  `$EDITOR` (trivial: spawn editor on a temp file, read it back) — this is the safest path on
  constrained terminals and reuses the suspend/resume stdin machinery already built for auth
  hand-off (`LineReader.suspend/resume`, `menu.ts:1097-1168`).
- **History:** persist the per-conversation user-prompt history to the store / a small history
  file and seed `readline.history` on entry so Up-arrow recalls across sessions. Bounded
  (last ~100), local-only.

**Where it hooks.** Backslash/Ctrl+J in `createLineReader` (`menu.ts:1044` line handler).
`/editor` as a new dispatch case + a tiny `infra/editor.ts`. History seeding where the
readline interface is built (`menu.ts:4354`).

**(d) Effort: M (multi-line raw-mode is fiddly). Impact: ★★★☆☆.** `/editor` + backslash is the
cheap, robust 80%; full Ctrl+J/persistent-history is polish.

---

### Gap 7 — No **"what's in context right now"** visibility (honoring the no-token-meter rule) ★★★☆☆

**(a) What's missing.** A user can't see what the model is actually working from this turn:
which memory facts are loaded, whether the recap/transcript is in play, how many prior turns
are being sent. Memory injection happens (`resolveMemoryContextDetailed`, `menu.ts` import at
:31) and `/memory loaded` exists for durable facts, but there's no single "context right now"
view for the *conversation*.

**(b) How the best tools do it.** Codex CLI shows **`context-remaining`** in its footer and
`model-with-reasoning` ([Codex CLI](https://developers.openai.com/codex/cli),
[presentation doc §1](./chat-presentation-5.5.md)). Claude Code shows a context/usage gauge.
**We deliberately cannot copy the token gauge** — subscription auth gives no honest token
budget, and fabricating one violates the project's no-fabricated-data rule.

**(c) Design sketch — honest, count-based, not token-based.** A `/context` command (and a
*very* compact optional status hint) that reports only what we can measure truthfully:
- memory facts currently injected (count + the `/memory loaded` detail),
- whether a recap and how many transcript turns are being sent this turn,
- active mode + provider + cwd/repo.

No percentages, no "X tokens left." Frame it as *"here's what I'm working from,"* which is the
**trust** payoff of a context meter without the dishonest number. This reconciles with — and
extends to the conversation — the durable-memory `/memory loaded` surface.

**Where it hooks.** New `/context` case composing existing signals: memory-injection detail,
the transcript-tail count from Gap 1, `modeLabel`, env. Pure assembly, no model call.

**(d) Effort: S. Impact: ★★★☆☆.** Cheap trust win; pairs naturally with Gap 1.

---

### Gap 8 — **Autosave is implicit; no "you won't lose this" signal**, no crash-safety affordance ★★☆☆☆

**(a) What's missing.** Conversations *are* persisted append-only and atomically
(`conversation-store.ts` + `atomic.ts`), which is genuinely solid — but the **user is never
told**, and a turn interrupted mid-stream may leave the partial answer unpersisted (orchestrate
persists on settle). There's no "draft" preservation if you type a long message and Ctrl+C.

**(b) How the best tools do it.** ChatGPT/Claude.ai autosave invisibly *and* it's trusted
because the thread is always there on return. Gemini CLI adds **explicit** `/chat save <tag>`
checkpoints for named restore points
([Gemini CLI](https://geminicli.com/docs/reference/commands/)). aider commits file changes so
work is recoverable.

**(c) Design sketch.** Mostly a *confidence* gap, not a mechanism gap:
- A one-time first-touch line ("conversations autosave — you can `/back` anytime and resume")
  via the existing first-touch system (`showFirstTouch`, `menu.ts:3030`).
- Optional `/checkpoint <tag>` that snapshots/labels the current point (rename-with-tag over
  the existing store) for Gemini-style named restore — low priority.
- Preserve a half-typed message across a single Ctrl+C so a long compose isn't lost (buffer the
  current input line, re-seed it on the next prompt).

**(d) Effort: S. Impact: ★★☆☆☆.** The machinery is already there; this is signage + a small
draft-preservation nicety.

---

### Gap 9 — "Thinking" visibility is a spinner, not **reasoning** ★★☆☆☆

**(a) What's missing.** The status line shows a verb + elapsed + streamed-token estimate
(`spinnerLabel`, `render.ts:505`) — good and honest. But there's no surfaced *reasoning*
("thinking…" content) the way newer chats show a collapsible thought stream.

**(b) How the best tools do it.** Codex surfaces reasoning summaries; Claude Code shows tool
calls and a todo checklist live ([presentation doc §1](./chat-presentation-5.5.md)). This is
already largely covered by [chat-presentation-5.5.md]; flagged only for completeness.

**(c) Design sketch.** If/when the wrapped provider emits reasoning deltas, render them dim
under a `⋮ thinking` line, collapsed by default. **Do not fabricate** reasoning when the
provider doesn't emit it. Defer until a provider reliably gives us the stream.

**(d) Effort: M (provider-dependent). Impact: ★★☆☆☆.** Lowest urgency; partly already designed.

---

## 2. Reconciliation — what already exists (do NOT rebuild)

| Capability | Status in myshell | Source |
|---|---|---|
| Streaming + `●` turn marker + live status line | **Built** | `render.ts`, [chat-presentation-5.5.md] |
| ESC to interrupt a running turn | **Built** | `interpretChatKey` `menu.ts:881` |
| Typed-ahead queue during a turn | **Built** | `createLineReader` `menu.ts:1044` |
| `※` one-line recap on resume + `/recap` | **Built** | `resolveRecap` `menu.ts:2979`, [recap-feature-5.5.md] |
| Multi-conversation persistent store (pin/category/rename/delete) | **Built** | `conversation-store.ts`, `menu.ts:2462-2520` |
| Durable cross-session user memory + `/memory` | **Built** | [memory-architecture-5.5.md] |
| Tab completion (slash + `@`-file + path) | **Designed** | [tab-completion-5.5.md] |
| Within-session up-arrow history | **Partial** (not persisted) | `terminal:` `menu.ts:4357` — see Gap 6 |
| Auto-title from first message | **Partial** (truncation, not summary) | `deriveTitle` `conversations.ts:157` — see Gap 5 |

The **new** surface this doc adds: **transcript replay (1)**, **message-level redo (2)**,
**copy/export (3)**, richer **resume picker (4)**, semantic **auto-naming (5)**, **multi-line +
persistent history (6)**, **/context (7)**, and **autosave signage (8)**.

---

## 3. If you do only 3 things

1. **Replay the transcript tail on resume (+ `/transcript`)** — Gap 1. Directly fixes the
   reported "doesn't feel like it loaded context" gap, beats Claude Code's own resume, and uses
   data the store already holds. **Start here.**
2. **`/retry` (then `/edit`)** — Gap 2. The defining "real chat" verb. `/retry` is a small slice
   on top of one new `truncateAfter` store op and pays off on every imperfect answer.
3. **`/copy` + `/export`** — Gap 3. Cheap, high-trust, removes the "my work is trapped in the
   scrollback" feeling. Mostly pure code + a small fail-soft clipboard shim.

(Honorable mention, do it alongside #1 because it's nearly free: add ` · N msgs` to the
conversation list — Gap 4.)

---

## 4. Top open questions for the user

1. **Transcript tail depth:** how many prior turns should resume reprint by default (6? 10?),
   and should very long threads auto-collapse to recap-only with `/transcript` to expand?
   (Trade-off: orientation vs. wall-of-text.)
2. **Store mutability:** are you OK making the append-only conversation store support
   `truncateAfter` (needed for `/retry`/`/edit`)? It's the one architectural change here. If
   you'd rather keep the log immutable, we fall back to **fork-into-new-conversation** for redo,
   which is safer but less seamless.
3. **Clipboard on Replit/headless:** `/copy` can't reach a real clipboard on a headless host —
   is "print a clean copy-friendly block + copy when a local clipboard exists" acceptable, or
   should `/copy` be desktop-only?
4. **Branching ambition:** ship the lightweight `/retry` + `/edit` + fork-to-new now, or invest
   in a true branch tree (toggle between versions inline) later? (Note: Claude.ai itself still
   lacks native branching — lightweight is defensible.)
5. **Multi-line default:** lead with `/editor` (`$EDITOR`, robust everywhere) or with inline
   `\`-continuation / `Ctrl+J` (slicker but terminal-dependent)? Recommend `/editor` first.
6. **`/context` framing:** confirm the no-token-budget stance — show *counts* ("3 memory facts,
   6 turns, mode: build") and never a fabricated token/percentage gauge?

---

## Sources

- Claude Code resume / scrollback: [#8937 resume doesn't display previous messages](https://github.com/anthropics/claude-code/issues/8937),
  [#40253 history truncated ~250 lines](https://github.com/anthropics/claude-code/issues/40253),
  [#28077 allow scrolling full history](https://github.com/anthropics/claude-code/issues/28077),
  [resume/search/manage conversations](https://kentgigger.com/posts/claude-code-conversation-history),
  [Claude Code sessions docs](https://code.claude.com/docs/en/sessions),
  [claude-history tool](https://github.com/raine/claude-history).
- Message-level edit / retry / fork: [Codex CLI features](https://developers.openai.com/codex/cli/features),
  [Codex CLI](https://developers.openai.com/codex/cli),
  [Codex #5030 backtrack](https://github.com/openai/codex/issues/5030),
  [Codex #11626 /rewind](https://github.com/openai/codex/issues/11626),
  [Claude Code Esc-Esc](https://kentgigger.com/posts/claude-code-escape-escape-shortcut),
  [Copilot CLI #100](https://github.com/github/copilot-cli/issues/100),
  [aider in-chat commands](https://aider.chat/docs/usage/commands.html),
  [opencode TUI](https://opencode.ai/docs/tui/),
  [conversation branching](https://www.smithstephen.com/p/conversation-branching-the-ai-feature),
  [Claude vs ChatGPT missing features](https://claudekit.app/blog/claude-vs-chatgpt-missing-features),
  [claude-code #32631 branching spec](https://github.com/anthropics/claude-code/issues/32631).
- Export / copy / share: [Gemini CLI commands](https://geminicli.com/docs/reference/commands/),
  [opencode TUI](https://opencode.ai/docs/tui/),
  [Claude Code /export](https://kentgigger.com/posts/claude-code-conversation-history).
- Titles / auto-naming: [organize AI conversations 2026](https://nexasphere.io/blog/organize-ai-conversations-chatgpt-claude-gemini-2026),
  [claude-code #11956 rename titles](https://github.com/anthropics/claude-code/issues/11956).
- Multi-line input / history: [Claude Code multiline](https://www.developersdigest.tech/guides/multiline-input),
  [why Shift+Enter doesn't work](https://dev.to/richardbray/why-shiftenter-doesnt-work-in-claude-code-and-how-to-fix-it-10f7),
  [Claude Code terminal config](https://code.claude.com/docs/en/terminal-config),
  [aider tips (history, Ctrl-R)](https://aider.chat/docs/usage/tips.html).
- Status / context visibility: [Codex CLI](https://developers.openai.com/codex/cli),
  [Codex config reference](https://developers.openai.com/codex/config-reference).
