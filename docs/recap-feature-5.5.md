# Conversation Recap — design 5.5

Status: **DESIGN ONLY**. This document specifies whether and how `myshell-tools` should
implement a conversation **recap** — the "※ recap:"-style orientation line the user saw in
Claude Code / ChatGPT. It does **not** modify `src/` or `test/`. It coexists with, and
cross-references (without duplicating):

- the glyph/turn-marker system in [docs/chat-presentation-5.5.md](./chat-presentation-5.5.md)
  (the `●` turn marker, `⋮` notice, status line — a recap must NOT collide with these);
- the durable user-memory subsystem in [docs/memory-architecture-5.5.md](./memory-architecture-5.5.md)
  (recap is conversation-scoped, memory is cross-session — §6 keeps them distinct);
- the partner posture in [docs/partner-and-memory-design-5.5.md](./partner-and-memory-design-5.5.md)
  (a partner that "remembers where we were" — recap is the cheapest expression of that);
- the input/stdin mechanics owned by [docs/chat-ux-audit-5.5.md](./chat-ux-audit-5.5.md) and
  the 3.12.x raw-mode work (recap is print-only output; it touches no stdin).

---

## 1. What "recap" actually is (research)

### 1.1 Claude Code's session recap

Claude Code shipped an **automatic session recap** in `v2.1.108`–`v2.1.114` (Week 17, April
2026). The behavior, pinned from the (sparse) official surface plus community write-ups:

- **What it is:** when you return to the terminal after being away, Claude Code prints a
  **single orientation line** summarizing where you left off — e.g. (quoted verbatim from a
  community write-up):
  > `⏺ Recap: you were migrating the auth/ module to JWT. Edited 4 files; expiration tests still missing.`
- **Glyph:** community sources render it with `⏺` (U+23FA, the "record" button) — the same
  family as Claude Code's `●` turn dot. The user reported seeing a `※` marker; that is a
  *presentation choice we are free to design* (§5), not a literal Claude Code string. The
  semantically important fact is: **a recap gets its OWN distinct marker**, separate from the
  per-turn answer marker.
- **Auto-trigger conditions (all must hold):** terminal unfocused for **≥3 minutes** since
  the last completed turn; session has **≥3 turns** of history; and **never twice in a row**
  (after you have seen one recap, the next waits for fresh activity).
- **Manual command:** `/recap` invokes it on demand (e.g. before a commit or a mid-session
  audit). This command is real but, as of the research date, **undocumented** — see
  [issue #48084](https://github.com/anthropics/claude-code/issues/48084) and
  [#48863](https://github.com/anthropics/claude-code/issues/48863).
- **Controls:** toggle under `/config` → "Session recap"; env var
  `CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0` to force-disable; **skipped in non-interactive mode**.
- **Cost:** runs **in the background reusing the prompt cache**, so it is cheap.
  ([Session recap write-up](https://wmedia.es/en/tips/claude-code-session-recap-resume-context))

### 1.2 Recap vs. compaction — the load-bearing distinction

These are **two different artifacts** that are easy to conflate:

| | **Compaction summary** | **Recap** |
|---|---|---|
| Audience | the **model** (internal) | the **user** (orientation) |
| Trigger | context window fills up | returning after idle / `/recap` / resume |
| Purpose | keep going without losing the thread | tell the human "here's where we were" |
| Form | a `<summary>` block injected as context | one short human line on screen |
| Lifecycle | replaces prior turns in the live context | additive; changes nothing in context |

In Claude Code, `/compact` collapses the running history into a `<summary>` block and **drops
the prior messages** from the active window so the session can continue
([compaction explainer](https://okhlopkov.com/claude-code-compaction-explained/),
[/compact mechanics](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management)).
The recap is a **separate, user-facing** surface introduced later; it does not alter context.
They can *share generation machinery* (both summarize history) but they are surfaced
differently and serve different consumers.

### 1.3 ChatGPT / other-tool equivalents

ChatGPT has the adjacent-but-distinct surfaces, useful as contrast:

- **"Memory updated"** toast — a notice that a **durable, cross-conversation** fact was saved
  ([Memory and new controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/)).
  This is our **memory** subsystem, NOT recap.
- **Resume formatting / thread continuation** — picking a thread back up across devices, with
  a clean view of where work stands
  ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)). This
  is the closest ChatGPT analogue to recap-on-resume.
- The community pattern of asking ChatGPT to *"summarize this thread preserving decisions,
  names, and direction"* before starting a fresh chat
  ([restart-chats guide](https://www.companionlink.com/blog/2026/01/how-to-restart-chatgpt-chats-and-transfer-your-work-efficiently/))
  is exactly a hand-rolled recap.

### 1.4 What a good recap/summary contains (published guidance)

Anthropic's own [session-memory-compaction cookbook](https://platform.claude.com/cookbook/misc-session-memory-compaction)
prescribes a structured summary. Its six sections, condensed for a one-to-three-line recap:

1. **User intent** — the original ask and how it evolved (quote key requirements).
2. **Completed work** — what was created/modified/deleted, with exact identifiers.
3. **Errors & corrections** — failed approaches (don't retry) + user corrections (verbatim).
4. **Active work** — what was in progress when we stopped, with the precise leave-off point.
5. **Pending tasks** — requested-but-not-started items.
6. **Key references** — IDs, paths, values, constraints discovered.

Preservation hierarchy when space is tight: **user corrections > errors > active work >
completed work**. For a *user-facing recap* (vs. a model-facing compaction summary) the
practical distillation is: **goal → state → next step**, with a file/decision detail when one
exists. That is what we design in §5.

---

## 2. What myshell does today (grounding)

### 2.1 myshell replays full history; it does NOT compact context

This is the decisive finding for "is recap a nicety or a necessity?":

- Every turn rebuilds context by **replaying** prior turns. `orchestrate()` computes
  `historyContext = compactHistory(deps.history)` once per run
  (`src/core/orchestrate.ts:326-328`) and injects it into the prompt
  (`src/core/orchestrate.ts:525`, via `buildPrompt(..., historyContext)` at
  `src/core/prompt.ts:281-301`, rendered as a `CONVERSATION SO FAR` block at
  `src/core/prompt.ts:291-292`).
- `compactHistory()` (`src/core/history.ts:111-163`) is **not** model summarization — it is a
  pure, deterministic **truncation**: take the last `maxTurns` (12) entries, strip control
  envelopes, and drop the oldest until under `maxChars` (6000)
  (`src/core/history.ts:23-24`, `:124-145`). When a single turn is still too long it is
  hard-truncated with ` …[truncated]` (`src/core/history.ts:147-157`).
- The **experimental** native-session path (`src/core/native-session.ts`, opt-in
  `config.nativeSessions`) can instead reuse Claude's `--session-id`/`--resume` so the
  provider holds context server-side and we skip the replay (`src/core/native-session.ts:1-95`).
  But the default, provider-portable path is history-replay.

**Consequence:** myshell has **no compaction summary at all** — neither model-facing nor
user-facing. When a conversation grows past the truncation window, the **oldest turns are
silently dropped** with no summary to carry their substance forward. So a recap here is
*both* a UX nicety **and** the seed of a future context-management improvement (a real
summarize-old-turns compaction could reuse the same generator — §7, Phase 3 / Q4).

### 2.2 The one place "recap" already appears — and why it's weak

On resume, `runConversation` prints a "recap" that is **just the raw last message**, sliced to
80 chars (`src/interface/menu.ts:2341-2349`):

```ts
// Print a short recap of the conversation (last entry) if history exists
const history = await ctx.store.load(convId);
if (history.length > 0) {
  const last = history[history.length - 1];
  if (last !== undefined) {
    out.write(`\n  Resuming — last message (${last.role}): ${last.content.slice(0, 80)}…\n\n`);
  }
}
```

This is brittle orientation: if the last message was a clarifying question, a tool dump, or a
half-sentence, the "recap" is noise. It does not summarize the *work*, only echoes the *tail*.
**This is the exact line a real recap should replace.**

The numbered cross-tool resume path prints a similar tail-echo
(`src/interface/menu.ts:2079`, "Resuming … (N messages)").

### 2.3 Where a recap would render, store, and hook

- **Render:** `src/interface/render.ts` owns the glyph vocabulary. Notices clear the live
  indicator then print (`src/interface/render.ts:587-588`); colors come from `src/ui/theme.ts`
  (`dim/cyan/yellow/…`, `theme.ts:17-62`). A recap line is a print-only notice — it slots in
  beside the `⋮` notice and the `●` turn marker without touching the event model.
- **Store:** `ConversationMeta` (`src/infra/conversation-store.ts:16-26`) has `id/title/
  createdAt/updatedAt/messageCount/pinned/category` — **no summary/recap field today**. The
  store already does transparent forward-migration of new optional fields
  (`normaliseMeta`, `src/infra/conversations.ts:64-75`), so adding `recap` is a clean,
  backward-compatible extension. Per-conversation history is the append-only `<id>.jsonl`
  (`src/infra/conversations.ts:6-9`), loadable via `store.load(id)` (`:276-287`).
- **Generate:** orchestrate already runs models and has provider access; a recap is "one
  cheap model pass over `store.load(id)`," reusing the worker-tier path.
- **Recent list:** the menu's "Recent" list (`src/interface/menu.ts:3060-3072`) shows
  `renderConversationList(metas)` — today **titles only** (the first user message,
  `deriveTitle`, `src/infra/conversations.ts:125-149`). A stored recap could give each row a
  second dim line of *actual state* instead of just the opening words (§5.3).

---

## 3. What recap should MEAN in myshell

A **recap** is a short, model-written, **conversation-scoped** orientation note that answers
*"where were we?"* It is tied to our vision-first partner posture
([partner-and-memory-design-5.5.md](./partner-and-memory-design-5.5.md) Goal 1: "understand
the user's intent, vision … reflect the big picture briefly"): a partner that remembers does
not make you re-read your own transcript to re-enter the work.

Three properties define it:

1. **Distilled, not echoed.** It summarizes the *arc of the work* (goal → state → next step),
   never just the last message. It replaces `menu.ts:2341-2349`.
2. **Conversation-scoped and disposable.** It belongs to one conversation, is regenerated as
   the conversation grows, and is discarded when the conversation is deleted. It is **not** a
   durable fact (contrast §6).
3. **Honest and cheap.** Generated from real history by a cheap model, cached, and shown only
   on meaningful beats — never fabricated, never decoration.

It deliberately **borrows the Anthropic structure** (§1.4) but renders the *user-facing*
distillation: **goal · current state · next step**, plus one concrete anchor (a file, a
decision, a blocker) when present.

---

## 4. THE DECISION

**Recommendation: YES — implement recap, in two forms, phased.**

| Form | Decision | Why |
|---|---|---|
| **(a) Recap on RESUME** | **Implement first (Phase 1).** | Highest value, lowest risk. It *replaces an existing weak line* (`menu.ts:2341-2349`), so it is a strict upgrade, not new surface. This is the moment of maximum disorientation ("what was this conversation about?"). |
| **(b) Manual `/recap`** | **Implement (Phase 2).** | Cheap once the generator exists; matches Claude Code's `/recap`; lets the user re-orient mid-conversation or before handing work off. Joins the existing slash set (`/goal /mode /help /back`, `menu.ts:2362`). |
| **(c) Auto-recap when long / before "compaction"** | **Defer (Phase 3), opt-in, OFF by default.** | We don't compact today (§2.1), so there is no compaction beat to hang it on yet. An "approaching the replay window" auto-recap is useful but risks chattiness; gate it behind a config flag and the partner-posture preference. It becomes compelling only alongside a real summarize-old-turns compaction (Q4). |

**Why not "no":** the resume line already exists and is bad; replacing it is near-free value.
**Why not "all-in auto":** myshell's honesty/anti-chatter posture (don't relabel every turn,
`menu.ts:2352-2355`) means an unbidden recap on every long turn would feel noisy. Earn the
auto behavior behind a flag.

---

## 5. Where the recap comes from, and how it's stored

### 5.1 Generation

- **Source:** the conversation's own history, `store.load(id)` (`conversations.ts:276-287`),
  fed through the existing `compactHistory()` truncation (`history.ts:111`) to bound input
  size, then summarized by a **cheap worker-tier model pass** (reuse the worker path /
  cheapest authenticated provider; recap quality does not need a flagship).
- **Prompt:** a small dedicated recap system prompt asking for the §1.4 distillation in
  **1–3 lines, ≤240 chars**, format `goal · state · next`, plus one concrete anchor if present;
  no envelope, no markdown chrome. This is a *new pure prompt builder* (`buildRecapPrompt`),
  sibling to `buildPrompt` (`prompt.ts:281`), so it is unit-testable without I/O.
- **Incremental + cached (the cost lever):** store the recap text **and** the
  `messageCount` it was generated at. Regenerate **only** when `messageCount` has advanced by
  ≥ N turns (e.g. 3) since `recapAt`, mirroring Claude Code's "not twice in a row / ≥3 turns"
  economy (§1.1). On resume, if the cache is fresh, show it **with zero model cost**; only
  regenerate in the background when stale. This is the analogue of Claude Code "reusing the
  prompt cache."

### 5.2 Storage — extend the conversation store

Add three optional fields to `ConversationMeta` (`conversation-store.ts:16-26`); they migrate
in transparently via `normaliseMeta` (`conversations.ts:64-75`), exactly as `pinned`/
`category` did:

```ts
readonly recap?: string | null;        // the last generated recap text
readonly recapAt?: string | null;      // ISO time it was generated
readonly recapMessageCount?: number;   // messageCount at generation (staleness check)
```

A new store method `setRecap(id, recap, atMessageCount)` writes them under the existing index
lock (same shape as `setCategory`, `conversations.ts:424-446`). The recap rides in the
**index** (cheap to read for the Recent list), not in the per-message JSONL.

### 5.3 Presentation — a SEMANTIC marker, not decoration

Per the user's principle ("markers are semantic, used on certain beats, not decoration") and
the glyph budget in [chat-presentation-5.5.md §3](./chat-presentation-5.5.md): the recap is a
**distinct beat** and earns its **own glyph**, reserved for *orientation* and used **nowhere
else**. `●` is already the assistant turn marker and `⋮` is a notice — a recap is neither.

**Chosen glyph: `※` (U+203B, reference mark).** Single-cell, renders widely, visually
"aside/see-also" — the right semantics for "before we continue, here's where we were." It
matches what the user observed and does not collide with `●`/`⋮`/`✓`/`✗`/`■`/`↑`/`⇄`. (Claude
Code uses `⏺`; we are designing the *meaning*, and `※` reads more as a margin-note than a
record button.)

On resume, **replacing** `menu.ts:2341-2349`:

```
※ recap  Migrating auth/ to JWT — 4 files edited, expiration tests still missing.
         Next: write the token-expiry tests.
```

- Glyph `※` dim-cyan (orientation), the word `recap` dim, the body in normal weight.
- **One beat only:** shown once on entry, never per turn (consistent with the single quiet
  orientation line at `menu.ts:2352-2364`).
- **Off-TTY / NO_COLOR:** plain `※ recap  …`, no color (reuse the `out.color` gating in
  `render.ts`/`theme.ts:17-62`). Under a future `MYSHELL_PLAIN`, drop the glyph, keep the text.
- **Recent list (Phase 2+):** give each conversation row an optional **second dim line** = its
  stored recap (truncated), so the list shows *state*, not just the opening words derived by
  `deriveTitle` (`conversations.ts:125`). Empty/legacy conversations simply show the title as
  today.
- **Empty/short conversations:** < 3 turns → **no recap** (nothing to distill; fall back to
  the title), matching Claude Code's ≥3-turn floor.

### 5.4 Where the code touches (no event-model changes)

- `src/infra/conversation-store.ts` — extend `ConversationMeta`; add `setRecap` to the port.
- `src/infra/conversations.ts` — `normaliseMeta` carries the new fields; implement `setRecap`
  (clone of `setCategory`, `:424-446`).
- `src/core/recap.ts` *(new, pure)* — `buildRecapPrompt(history)` + `isRecapStale(meta, now)`
  + `formatRecapLine(text, color)`. Pure, no I/O — same purity contract as `history.ts:1-13`.
- `src/interface/menu.ts` — replace the tail-echo at `:2341-2349` with: read cached recap from
  meta → if fresh, print via `formatRecapLine`; if stale and ≥3 turns, generate (background,
  best-effort) and `setRecap`. Add the `/recap` command beside `/goal` (`:2362`). Add the
  optional second list line in `renderConversationList` (`:3064`).
- `src/interface/render.ts` / `src/ui/theme.ts` — a `recapMarker()`/`formatRecapLine` helper
  for the `※` styling, mirroring the planned `turnMarker()` in chat-presentation-5.5.md §7.

---

## 6. Interaction with MEMORY (keep them distinct)

Recap and the durable user-memory subsystem ([memory-architecture-5.5.md](./memory-architecture-5.5.md))
are **complementary, not overlapping**:

| | **Recap** (this doc) | **Memory** (memory-architecture-5.5) |
|---|---|---|
| Scope | one conversation | cross-session, cross-project, durable |
| Lifetime | regenerated, dies with the conversation | persists; updated/superseded/expired |
| Gate | none — it's a view of existing history | strict WRITE GATE; refuses most candidates |
| Content | "where were we in *this* thread" | confirmed durable facts about the user |
| Failure mode | a stale line (cosmetic) | **drift** — the memory doc's #1 enemy |

**Boundaries to honor:**

- A recap is a **read-only projection of conversation history** — it never writes durable
  memory. The memory WRITE GATE (`memory-architecture-5.5.md §0.1`) stays the only path to
  durable facts. A recap mentioning "user prefers vitest" does **not** save that; only the
  `/remember` / `remember_user` gate does.
- They **render with different markers and different language**: recap = `※ recap` (orientation,
  conversational state); a memory save/notice is its own surface (`/memory`, the "what I'll
  remember" confirmation in the memory doc). Never blur them into one toast — that is exactly
  the ChatGPT "memory updated" vs. "thread resume" distinction (§1.3).
- They **complement** at resume: memory injects durable preferences into the prompt
  (`prompt.ts:281-301` injection slot), while recap orients the *human* about this thread.
  One feeds the model; the other feeds the user.

---

## 7. Test strategy (pure seams) & phased plan

### 7.1 Tests — at the pure seams, no live models

The design is structured so the load-bearing logic is **pure** and unit-testable, exactly like
`history.test`/`render.test` drive scripted data through fakes (chat-presentation-5.5.md §9):

1. **`buildRecapPrompt(history)`** — table tests: empty/short history → no/empty prompt;
   includes the §1.4 fields; respects the char budget. Pure, deterministic.
2. **`isRecapStale(meta, threshold)`** — fresh vs. stale by `messageCount - recapMessageCount`;
   `< 3 turns` → never recap; missing `recapAt` → stale. Pure.
3. **`formatRecapLine(text, color)`** — `※ recap …` with color; identity-plain when `!color`;
   truncation. Pure (mirrors `turnMarker` tests).
4. **Store round-trip** — `setRecap` then `list()`/`load` returns the fields;
   `normaliseMeta` forward-migrates a legacy index entry that lacks them (extend
   `conversations` tests).
5. **Resume rendering** — drive the menu resume path with an injected store whose meta has a
   cached recap → assert the `※ recap` line is printed and the old tail-echo is **gone**;
   with a stale meta → assert a (faked) generation + `setRecap` is invoked.
6. **Generation is best-effort** — a thrown/failed recap model call must **not** break resume
   (fall back to title / no line), asserted with a failing fake generator.

No test calls a real provider; the model pass is injected behind the same dependency seam
`orchestrate`/menu already use for the store and clock.

### 7.2 Phased implementation

- **Phase 1 — recap on resume (replace the tail-echo).**
  `src/core/recap.ts` (pure) → store fields + `setRecap` → wire into `menu.ts:2341-2349` with
  cache+staleness → tests 1–6. Self-contained, strictly upgrades existing behavior. Coexists
  with chat-presentation-5.5.md (shares the `theme.ts` glyph helper) and the 3.12.x stdin work
  (print-only; touches no raw-mode/ESC path).
- **Phase 2 — `/recap` command + richer Recent list.**
  Add the `/recap` slash beside `/goal` (`menu.ts:2362`); add the optional second dim line in
  `renderConversationList` (`menu.ts:3064`). Reuses Phase-1 generator and cache.
- **Phase 3 — auto-recap + the compaction bridge (opt-in, OFF by default).**
  A config flag (`autoRecap`, alongside `autoGoal` in `config.ts`) + a partner-posture link.
  When a conversation crosses the replay window (`compactHistory` is about to start dropping
  oldest turns, `history.ts:124-145`), generate a recap *both* to show the user *and* — the
  real prize — to **feed dropped-turn substance back into context** as a genuine
  summarize-and-continue compaction (turning §2.1's silent-drop into a real summary). This is
  where recap and compaction finally share one generator. Gated behind Q4.

---

## 8. Risks & open questions for the user

- **Q1 — Glyph.** Use `※` (matches what you saw; reads as "margin note") or `⏺` (literal
  Claude-Code parity) or reuse a duller `⋮` notice? **Recommend `※`**, reserved exclusively
  for orientation so it stays semantic.
- **Q2 — Cost vs. freshness.** Recap costs a cheap model pass. Regenerate every **N=3** new
  turns and cache (recommended), or only on explicit `/recap` (cheapest, but the resume line
  can be stale)? **Recommend cached, N=3, background-refresh on resume.**
- **Q3 — Which model.** Cheapest authenticated worker-tier provider (recommended — recap
  doesn't need a flagship), or always the active conversation's provider for voice
  consistency? Trade cost vs. tone.
- **Q4 — Recap → real compaction.** Should Phase 3 actually **feed the recap back into
  context** to replace dropped oldest turns (fixing the silent-drop in §2.1), making recap a
  context-management mechanism and not just UX? This is the highest-value but highest-risk
  step (it changes what the model sees). **Recommend yes, but as a separate opt-in after
  Phases 1–2 prove the generator.**
- **Q5 — Auto-recap chattiness.** Even gated, an auto-recap mid-conversation risks the noise
  the codebase deliberately avoids (`menu.ts:2352-2355`). Keep it **OFF by default** and tie
  it to the partner-posture preference? (Recommend yes.)
- **Q6 — Recent-list density.** Adding a second recap line per row makes the list richer but
  taller (the list caps at ~7, `menu.ts` header docs). One line + recap, or keep titles and
  only show recap on hover/resume? **Recommend the second line, dim and truncated, only when a
  recap exists.**
- **Risk — staleness honesty.** A cached recap can lag reality by up to N turns. Mitigation:
  the staleness check (§5.1) + background refresh; never present a recap as "current state"
  beyond "where we were."
- **Risk — generation failure.** Must be best-effort (test 6): a failed recap falls back to the
  title, never blocks resume — same posture as the best-effort session mirror
  (`session-mirror.ts:11-18`).

---

### Sources

- Claude Code session recap behavior / `/recap` / triggers / env var:
  [wmedia.es session-recap write-up](https://wmedia.es/en/tips/claude-code-session-recap-resume-context),
  [issue #48084 (recap docs gap)](https://github.com/anthropics/claude-code/issues/48084),
  [issue #48863 (recap opt-out/telemetry)](https://github.com/anthropics/claude-code/issues/48863),
  [Manage sessions docs](https://code.claude.com/docs/en/sessions)
- Compaction vs. summary mechanics:
  [/compact mechanics](https://www.mindstudio.ai/blog/claude-code-compact-command-context-management),
  [compaction explained](https://okhlopkov.com/claude-code-compaction-explained/),
  [why Claude compacts](https://unmarkdown.com/blog/claude-compacting-explained),
  [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- What a good summary contains:
  [Anthropic session-memory-compaction cookbook](https://platform.claude.com/cookbook/misc-session-memory-compaction)
- ChatGPT equivalents (memory vs. thread resume):
  [Memory and new controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/),
  [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes),
  [restart-chats / hand-rolled recap](https://www.companionlink.com/blog/2026/01/how-to-restart-chatgpt-chats-and-transfer-your-work-efficiently/)
