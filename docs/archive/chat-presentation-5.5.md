# Chat Presentation & "Feel" Layer — design 5.5

Scope: design and investigation only. **No `src/` or `test/` changes are made by this
document.** It specifies the *presentation chrome* a user sees in the interactive chat —
turn markers, the live working status line (single-model and multi-agent), streaming
cadence, completion lines, and markdown styling. It deliberately does **not** touch input
mechanics (ESC / Ctrl+C / typed-ahead queue — those are owned by
[docs/chat-ux-audit-5.5.md](./chat-ux-audit-5.5.md) and the 3.12.x stdin work) and does
**not** change model behavior, routing, or policy.

The goal, in the user's words: Claude/GPT terminal chats have a little "●" marker on
responses, a live "waiting on N agents to finish" status, and an overall polished
"chatting feel." We want that feel — truthfully sourced from real orchestrate events.

---

## 1. What the best terminal AI chats actually do (research)

Patterns worth copying, with sources:

- **Claude Code** renders its whole UI as a React/Ink application (not raw escape codes),
  which is why it can keep a live, structured transcript: each tool call appears as it
  happens, file changes show as colored diffs, and a task checklist renders/updates in
  real time. It uses a **leading bullet/dot per turn-segment**, a **spinner with a verb +
  live elapsed counter** while thinking, and an **"esc to interrupt"** hint; the status
  line runs locally (no tokens) and hides during prompts/autocomplete. Tool/result and
  todo rendering use distinct glyphs for completed / in-progress / pending state.
  ([Claude Code Internals: Terminal UI](https://kotrotsos.medium.com/claude-code-internals-part-11-terminal-ui-542fe17db016),
  [How Claude Code Works](https://medium.com/@sujaypawar/how-claude-code-actually-works-1f6d4f1eea82),
  [statusline docs](https://code.claude.com/docs/en/statusline),
  [Todo tracking docs](https://docs.claude.com/en/docs/agent-sdk/todo-tracking))

- **OpenAI Codex CLI** runs an interactive TUI with a **footer status line** showing
  `model-with-reasoning`, **`context-remaining`**, and `current-dir`; animations (welcome
  shimmer + **spinner**, on by default) signal life. For multi-step work it uses an
  **`update_plan`** list where **exactly one step is `in_progress`** at any time, and for
  background/sub-agent work it surfaces **each task's command + up to three recent output
  lines** so progress is legible at a glance.
  ([Codex CLI](https://developers.openai.com/codex/cli),
  [Codex features](https://developers.openai.com/codex/cli/features),
  [Codex config reference](https://developers.openai.com/codex/config-reference))

- **Charm / Bubble Tea / Lip Gloss / Glamour** (Go) and **Ink** (React-for-CLI) are the
  idiomatic toolkits: spinners, status bars, and especially **Glamour** for
  stylesheet-driven **markdown rendering with syntax highlighting, tables, and links → ANSI**.
  The Ink chat pattern (assistant-ui) renders markdown to ANSI for a polished chat feel.
  We are not adopting these frameworks (we stream plain bytes to a sink), but we copy their
  *idioms*: a small, consistent glyph + color vocabulary and lightweight markdown styling.
  ([Charm](https://charm.land/), [Ink](https://github.com/vadimdemedes/ink),
  [assistant-ui for Ink](https://www.assistant-ui.com/ink))

- **clig.dev** gives the guardrails we must honor:
  - *"Use symbols and emoji where it makes things clearer … Pictures can be better than words."*
  - *"Use color with intention … Don't overuse it."*
  - Disable color when **stdout is not a TTY**, **`NO_COLOR` is set**, **`TERM=dumb`**, or
    `--no-color`.
  - *"If stdout is not an interactive terminal, don't display any animations"* (no
    "Christmas tree" progress bars in pipes/CI).
  - *"Show progress if something takes a long time … a good spinner can make a program
    appear faster."*
  - For parallel work: *"Do stuff in parallel where you can, but be thoughtful … reporting
    progress for parallel processes is ten times harder,"* and **always print the logs on
    error** rather than hiding them behind the indicator.
  ([clig.dev](https://clig.dev/))

**Net takeaways for us:** (1) one dot/bullet marker per assistant turn with color = state;
(2) a single live status line with verb + step count + elapsed + a soft token readout;
(3) for concurrency, announce *all* participants up front, then collapse to one
"waiting on N" line that ticks down as each finishes; (4) lightweight markdown only;
(5) degrade hard to plain, animation-free text off-TTY / `NO_COLOR`.

---

## 2. How the real code renders today (grounding)

The renderer is event-driven: `renderStream()` consumes `AsyncIterable<CoreEvent>` from
`orchestrate()` and writes to an `OutputSink` ([render.ts#L363](../src/interface/render.ts#L363)).
The sink carries `color` and `isTty` flags ([render.ts#L36-L40](../src/interface/render.ts#L36)),
both decided in `cli.ts` from `process.stdout.isTTY` and `NO_COLOR`
([cli.ts#L191-L192](../src/cli.ts#L191)). All ANSI lives in `ui/theme.ts`, every helper
gated on a `color` boolean ([theme.ts#L17-L65](../src/ui/theme.ts#L17)) — this is exactly
the NO_COLOR/non-TTY seam clig.dev wants, already in place.

Current presentation facts:

- **No per-turn marker.** Assistant prose is streamed raw via `prose.push()` with no
  leading glyph ([render.ts#L508](../src/interface/render.ts#L508)). There is no user-echo
  marker either. This is the biggest gap vs. the "●" feel.
- **Status line.** During work a braille spinner animates with a label built by
  `spinnerLabel()`: `"Thinking… N steps · ↓ ~T tokens"` ([render.ts#L416-L423](../src/interface/render.ts#L416)),
  and the spinner appends a live `· Ns` elapsed counter
  ([spinner.ts#L63-L69](../src/ui/spinner.ts#L63)). Frames are
  `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']` at 80ms
  ([spinner.ts#L20-L21](../src/ui/spinner.ts#L20)). Spinner is **TTY-only**: off-TTY it
  prints the label once, statically ([spinner.ts#L92-L94](../src/ui/spinner.ts#L92)) — good.
- **Spinner lifecycle.** Starts at `tier-start` ([render.ts#L483-L486](../src/interface/render.ts#L483)),
  stops when the first answer `text` delta arrives ([render.ts#L492-L493](../src/interface/render.ts#L492)),
  counts a step per `tool` event ([render.ts#L519](../src/interface/render.ts#L519)), and
  is revived via `ensureAlive()`/`resume()` so a post-answer tool phase isn't a dead line
  ([render.ts#L435-L445](../src/interface/render.ts#L435)).
- **No interrupt hint** is printed by the renderer today (it is owned by the chat loop).
- **Completion line.** Normal mode prints `✓ done (N tokens)` dim
  ([render.ts#L657](../src/interface/render.ts#L657)); verbose prints a full
  `Success — tier:… tokens:… attempts:… session:…` line
  ([render.ts#L648-L655](../src/interface/render.ts#L648)); quiet prints nothing.
  Cancel → `■ Cancelled` ([render.ts#L610](../src/interface/render.ts#L610)); failure →
  red `Failed — …` ([render.ts#L625-L631](../src/interface/render.ts#L625)). The only
  status glyphs used today are `✓`/`✗` (verbose tier-done, [render.ts#L556](../src/interface/render.ts#L556)),
  `▶` (verbose tier-start, [render.ts#L472](../src/interface/render.ts#L472)), `↑`/`⇄`
  (escalate/failover, [render.ts#L571](../src/interface/render.ts#L571),
  [#L581](../src/interface/render.ts#L581)).

**The multi-agent truth source (this is the key finding).** When a panel runs, `runPanel`
emits, in order: one `notice(info)` naming composition —
`"Panel: claude, codex → synthesized by claude"` ([ensemble.ts#L449-L453](../src/core/ensemble.ts#L449));
then a **`tier-start` for EVERY candidate up front, before the concurrent `await`**
([ensemble.ts#L469-L476](../src/core/ensemble.ts#L469)) — explicitly so the UI knows all
panelists are running; then after `Promise.all` ([ensemble.ts#L479](../src/core/ensemble.ts#L479))
a **`tier-done` per candidate** with real measured metrics; then a `tier-start`/stream/
`tier-done` for the synthesizer; then `final`. Hedging (`runHedged`) is different: it
**buffers** a background attempt's `provider-event`s and only `yield*`s the **winner's**
events ([hedge.ts#L160-L182](../src/core/hedge.ts#L160), [#L277](../src/core/hedge.ts#L277)),
emitting human `notice` lines like *"primary slow — starting speculative flagship"*
([hedge.ts#L358-L366](../src/core/hedge.ts#L358)).

So today the renderer treats every `tier-start` identically and just restarts/relabels the
one spinner — **the N up-front panel `tier-start`s are not surfaced as "N agents running."**
That is the missing "waiting on N agents" feel, and the events to build it already exist.

`renderStream` is tested by driving scripted `CoreEvent[]` through a fake non-color,
non-TTY `OutputSink` that captures `write()` calls into a buffer
([render.test.ts#L20-L35](../test/unit/render.test.ts#L20)). The spinner has its own unit
test ([spinner.test.ts](../test/unit/spinner.test.ts)). This proves the design is
unit-testable at the formatting seam.

---

## 3. Glyph + color system

A small, fixed vocabulary. Every glyph has a **plain-mode fallback** (no color) and the
whole layer respects `out.color` / `out.isTty` exactly as the existing theme helpers do.

| Element | Glyph (TTY+color) | Color / weight | NO_COLOR (TTY, no color) | Non-TTY / pipe |
|---|---|---|---|---|
| **Assistant turn marker** | `●` | cyan when streaming; **green** on success final; **red** on failed final; **yellow** on a turn that ends asking the user (`questions`); **dim** on cancel | `●` (no color) | `●` once, then prose (or omit entirely under `MYSHELL_PLAIN`) |
| **User echo** (chat history view only) | `›` | dim | `›` | `›` |
| **Sub-step / tool activity** | `·` (in the status line `N steps`) | dim | same | counted only |
| **Success** | `✓` | green | `✓` | `✓` |
| **Failure** | `✗` | red | `✗` | `✗` |
| **Cancelled** | `■` | dim | `■` | `■` |
| **Escalate / failover** (verbose) | `↑` / `⇄` | yellow | same | same |
| **Spinner frames** | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | cyan | braille, no color | not shown (static label) |

Notes:
- The **assistant `●`** is the headline change. It is printed **once per assistant turn**,
  immediately before the first prose delta, and is **recolored at the terminal event** to
  reflect outcome. Because we cannot retro-color bytes already flushed in a stream, the dot
  is printed at the moment the marker color is known: cyan at first delta (streaming), and
  the *completion line* (Section 6) carries the final-state colored dot. (Alternative
  considered: hold the whole turn and re-emit — rejected; it would break streaming
  cadence. See open question Q3.)
- `●` is U+25CF (BLACK CIRCLE), the same glyph Claude Code uses; it renders in virtually
  all terminal fonts. We do **not** use emoji (`✅`/`🔧`) — they are width-unstable across
  terminals and clash with the existing monochrome braille spinner; clig.dev endorses
  symbols but consistency matters more here.
- New theme color: none required for the dot states — reuse `cyan/green/red/yellow/dim`
  already in `theme.ts`. Only a new composite helper `turnMarker(state, color)` is added.

---

## 4. The status line during work

### 4.1 Single model (default path)

Keep the current shape, add a leading dot so the working line visually rhymes with the
answer. Format:

```
⠋ ● Thinking… 12 steps · ↓ ~1.2k tokens · 8s
```

- `⠋` animated braille (spinner.ts, unchanged frames).
- `●` cyan, signaling "this is the assistant working" — same marker that will head the
  answer, so the eye tracks one object from "working" → "answer."
- Label from `spinnerLabel()`; the `· Ns` suffix from the spinner. Verbose keeps the
  `Thinking (ic claude/claude-sonnet-4-6)…` form ([render.ts#L482](../src/interface/render.ts#L482)).

Cadence: spinner ticks at 80ms (life), label only changes on real `tool`/`reasoning`
events (no fake progress). This is already honest and stays.

### 4.2 Multi-agent (panel) — "waiting on N agents to finish"

This is sourced entirely from real events (Section 2). New renderer state: a
`Map<ProviderId, 'running'|'done'>` of panelists, populated from the **up-front**
`tier-start`s and flipped on each `tier-done`, plus a flag set by the
`notice("Panel: …")` line so the renderer knows it is in panel mode (rather than parsing
the notice text, the cleaner option is a new `phase` discriminator — see Section 7 / Q4).

Status line while candidates run (single animated line, replaces the per-tier spinner):

```
⠹ ● Waiting on 2 models · claude ✓ · codex …    · 6s
```

- `Waiting on N models` where **N = running count**, ticking down as `tier-done`s arrive.
- A compact per-model strip: `claude ✓` (done, green) `· codex …` (running, dim). This is
  the clig.dev "report parallel progress, but compactly" pattern and Codex's
  "show each task's status" idea, scaled to one line.
- When all candidates are done and the **synthesizer** `tier-start` arrives, the line
  switches to: `⠼ ● Synthesizing N answers… · 9s`.

The composition `notice(info)` ([ensemble.ts#L452](../src/core/ensemble.ts#L452)) is
shown **once** as a dim header in normal mode too (today it's verbose-gated via the generic
`notice` path) so the user sees *who* is on the panel:

```
  ⋮ Panel: claude, codex → synthesized by claude
```

Then only the synthesizer's prose streams under the `●` (candidate prose is intentionally
not streamed — [ensemble.ts#L399](../src/core/ensemble.ts#L399) — so we never interleave
two answers).

### 4.3 Hedge

Hedging only ever surfaces the **winner's** stream ([hedge.ts](../src/core/hedge.ts)), so
visually it is a *single-model* turn. We do **not** invent a "2 agents racing" line —
that would imply two visible answers. We **do** surface the existing human `notice` lines
("primary slow — starting speculative flagship", [hedge.ts#L363](../src/core/hedge.ts#L363))
as a dim status update in normal mode so the brief extra wait is explained:

```
  ⋮ primary slow — starting speculative flagship
```

### 4.4 Interrupt hint

The renderer does not own interruption (the chat loop does — [chat-ux-audit-5.5.md](./chat-ux-audit-5.5.md)).
This spec only fixes the **wording and placement** so the two layers agree. When a turn is
running in **menu chat** on a TTY, the hint is shown once, dim, right under the status line
and cleared with it:

```
  esc to interrupt · ctrl-c twice for menu
```

This matches the audit's model: ESC interrupts the turn and stays at the prompt; a rapid
double Ctrl+C returns to menu ([chat-ux-audit-5.5.md#L19](./chat-ux-audit-5.5.md) →
[menu.ts#L2400-L2425](../src/interface/menu.ts#L2400)). In the **plain REPL** (no ESC
listener) the hint is `ctrl-c to interrupt`. Off-TTY: no hint. Because the hint depends on
which loop is driving, it is passed to `renderStream` as an optional
`interruptHint?: string` rather than hardcoded (Section 7).

---

## 5. Streaming cadence & markdown

- **Cadence stays as-is**: prose flushes as deltas arrive through `EnvelopeFilter`
  ([render.ts#L253-L294](../src/interface/render.ts#L253)), which already holds back only a
  trailing control-envelope fragment. Do **not** add artificial buffering/typewriter delay —
  real streaming *is* the polished feel, and the filter guarantees no JSON envelope leaks.
- **Lightweight markdown only** (opt-in, default on for TTY+color, off otherwise). A pure
  post-tokenizer would fight the streaming model, so we apply **inline, line-safe styling
  only**, on flushed text, no reflow:
  - `**bold**` / `__bold__` → bold; `` `code` `` → dim or a subtle inverse; headings
    (`#`/`##` at line start) → bold; bullet markers (`- `, `* `) normalized to `•`.
  - Fenced code blocks (```` ``` ````): pass through verbatim, only dim the fence lines —
    **no syntax highlighting** (out of scope; would need Glamour-class machinery).
  This is a single pure function `styleInlineMarkdown(text, color): string` applied where
  `prose` is written, gated on `color`. Off-TTY / NO_COLOR → identity (raw markdown
  characters preserved, which is correct for pipes). See Q1 for how far to take this.

---

## 6. Completion / summary line

Recolor the existing lines with the turn dot so the transcript reads as discrete turns.

| Mode | Outcome | Line |
|---|---|---|
| normal | success | `● ✓ done · 1.2k tokens · 8s` (dot green, dim metrics) |
| normal | failure | `● ✗ Failed · timeout · attempts 3` (dot red) + the actionable error from `formatErrorMessage` ([render.ts#L621](../src/interface/render.ts#L621)) |
| normal | cancel | `● ■ Cancelled` (dim) |
| normal | asks user | *(no completion line — selector follows, [render.ts#L642](../src/interface/render.ts#L642))*; dot recolored yellow |
| verbose | success | full `Success — tier:… N tokens, attempts:…, session:…` ([render.ts#L648](../src/interface/render.ts#L648)) prefixed `●` |
| quiet | any | nothing (unchanged) |

Add **elapsed** (`· Ns`) to the normal success line — it's already measured by the spinner
and is the single most "alive"-feeling metric. Tokens stay (real, measured,
`runningTokens` [render.ts#L551](../src/interface/render.ts#L551)); dollars stay verbose/
on-demand only (subscription tool — [types.ts#L424](../src/core/types.ts#L424)). Context-
remaining (the Codex footer idea) is **not** added — we don't have a reliable token-budget
signal for subscription CLIs (open question Q5).

---

## 7. Exact code changes (functions touched)

All changes are in two files; the event model and orchestrate are **not** touched.

**`src/ui/theme.ts`** — add one pure helper:
- `turnMarker(state: 'streaming'|'success'|'fail'|'cancel'|'ask', color: boolean): string`
  returning `●` in the mapped color (cyan/green/red/dim/yellow), `●` plain when `!color`.
  Reuses existing primitives.
- (optional, Q1) `styleInlineMarkdown(text: string, color: boolean): string` pure function.

**`src/interface/render.ts`** — `renderStream` signature gains an optional
`interruptHint?: string` (defaulted, backward compatible like `verbosity`
[render.ts#L366](../src/interface/render.ts#L366)). New cases/edits:
- **Assistant dot:** in the `provider-event` `text` branch, before the first
  `prose.push(delta)` of a turn, write `turnMarker('streaming')` + space
  ([render.ts#L492-L508](../src/interface/render.ts#L492)). One-time per turn via a
  `proseStarted` check (the flag already exists, [render.ts#L404](../src/interface/render.ts#L404)).
- **`spinnerLabel()`** ([render.ts#L416](../src/interface/render.ts#L416)): prefix the
  returned label with the dot + handle the panel/synth variants (4.1/4.2). Stays pure-ish
  (string only).
- **Panel state:** add `panelMode: boolean`, `panelists: Map<ProviderId, 'running'|'done'>`.
  Populate from `tier-start` when in panel mode; flip on `tier-done`
  ([render.ts#L469](../src/interface/render.ts#L469), [#L540](../src/interface/render.ts#L540)).
  Drive the "Waiting on N models" label.
- **Panel-mode signal:** preferred — add a new discriminated CoreEvent
  `{ type: 'phase'; phase: 'panel'|'synthesis'|'sequential'; participants?: ProviderId[] }`
  emitted by `runPanel`/orchestrate, so the renderer never parses notice text. **This is the
  one change that reaches into core** and is gated behind Q4; the conservative fallback is
  to detect panel mode from the existing `notice("Panel: …")` string + counting up-front
  `tier-start`s before the first `tier-done`. (Recommend the explicit event.)
- **Composition header:** print the panel `notice(info)` dimmed in normal mode (today
  verbose-only, [render.ts#L594](../src/interface/render.ts#L594)) — scope this to the
  panel-composition notice only, leave other info notices verbose-gated.
- **Interrupt hint:** when `out.isTty` and `interruptHint` is set, write it dim once after
  the spinner starts; clear with `stopSpinner()`.
- **Completion lines:** prefix the normal/verbose success/fail/cancel lines with
  `turnMarker(state)` and append `· Ns` elapsed to the normal success line
  ([render.ts#L601-L659](../src/interface/render.ts#L601)). The spinner already tracks
  elapsed; expose it via a getter on the `Spinner` interface (`elapsed(): number`) — small
  additive change to `spinner.ts`.
- **Markdown (Q1):** wrap `prose.push(styleInlineMarkdown(delta, c))` — but only if we
  accept styling streamed deltas; safer is to style at flush in `EnvelopeFilter`. Defaulted
  off until Q1 is answered.

**`src/ui/spinner.ts`** — additive only: expose `elapsed(): number` (derived from existing
`tickCount`/`TICKS_PER_SECOND`, [spinner.ts#L59-L61](../src/ui/spinner.ts#L59)) so the
completion line can show elapsed without the renderer re-deriving it. No frame/timing change.

**Callers:** `cli.ts` / menu chat / repl pass the appropriate `interruptHint`
(`"esc to interrupt · ctrl-c twice for menu"` from menu chat; `"ctrl-c to interrupt"` from
repl; omit off-TTY). Pure plumbing, no behavior change.

Coexistence: none of this touches the `EnvelopeFilter`/JSON-envelope logic, the stdin/raw-
mode handling, the ESC/queue design, or any core orchestration. It is strictly additive
chrome on the existing event stream.

---

## 8. Before / after mockups

### Single-model turn

**Before**
```
⠋ Thinking… 6 steps · 4s
The directory contains three TypeScript files and a config.
✓ done (820 tokens)
```

**After**
```
⠋ ● Thinking… 6 steps · ↓ ~210 tokens · 4s
  esc to interrupt · ctrl-c twice for menu
● The directory contains three TypeScript files and a config.
● ✓ done · 820 tokens · 4s
```
(working line and answer share the cyan `●`; completion dot turns green.)

### Multi-agent panel turn

**Before** (panel composition + all candidate spinners collapse into a single relabeled line; the user can't tell two models ran)
```
⠙ Thinking… 0 steps · 7s
Both approaches are viable, but the second scales better because…
✓ done (3.1k tokens)
```

**After**
```
  ⋮ Panel: claude, codex → synthesized by claude
⠹ ● Waiting on 2 models · claude … · codex …            · 3s
⠼ ● Waiting on 1 model · claude ✓ · codex …             · 6s
⠴ ● Synthesizing 2 answers…                              · 9s
● Both approaches are viable, but the second scales better because…
● ✓ done · 3.1k tokens · 11s
```

### Off-TTY / NO_COLOR (piped)
```
● The directory contains three TypeScript files and a config.
● done · 820 tokens
```
(no spinner animation, no color, dot kept as a plain structural marker; under
`MYSHELL_PLAIN` the dot can be dropped entirely — Q2.)

---

## 9. Test strategy

The formatting seam is already unit-tested by driving scripted `CoreEvent[]` through a
fake non-color/non-TTY sink ([render.test.ts#L20-L35](../test/unit/render.test.ts#L20)).
New tests (same harness, `test/unit/render.test.ts` + `test/unit/spinner.test.ts`):

1. **Turn marker present** — single-model success stream: assert the flushed buffer starts
   a turn with `●` and the completion line contains `✓ done`.
2. **Panel "Waiting on N"** — feed the exact panel sequence (composition notice + 2 up-front
   `tier-start`s + 2 `tier-done`s + synth tier + final): assert the label text transitions
   `Waiting on 2 models` → `Waiting on 1 model` → `Synthesizing 2 answers`. (Labels are
   asserted via a pure `spinnerLabel()`/`panelLabel()` export, not animation timing.)
3. **NO_COLOR / non-TTY** — `color:false,isTty:false` sink: assert **no ANSI bytes**, no
   spinner frames, dot present (or absent under plain flag).
4. **Interrupt hint** — passed hint appears once under the status line on a TTY sink, never
   off-TTY.
5. **Honesty** — keep existing assertions that every metric comes from event data; assert
   the new elapsed value is sourced from `spinner.elapsed()`, not fabricated.
6. **`turnMarker` / `styleInlineMarkdown`** — pure-function table tests (state→glyph/color;
   markdown→styled, identity when `!color`).

Make `spinnerLabel`, the new `panelLabel`, `turnMarker`, and `styleInlineMarkdown` exported
pure functions so they are testable without animation (mirrors how the spinner derives
elapsed deterministically from tick count, [spinner.ts#L59](../src/ui/spinner.ts#L59)).

---

## 10. Implementation plan (file list, ordered)

1. `src/ui/theme.ts` — add `turnMarker()` (+ optional `styleInlineMarkdown()`), pure.
2. `src/ui/spinner.ts` — add `elapsed(): number` getter to `Spinner`. Additive.
3. `src/interface/render.ts` —
   a. assistant `●` before first prose delta;
   b. dot + elapsed on completion/fail/cancel lines;
   c. `spinnerLabel()` dot prefix;
   d. panel state map + `panelLabel()` + show composition notice in normal mode;
   e. `interruptHint?` param + dim print under the status line.
4. (Q4) `src/core/types.ts` + `runPanel`/orchestrate — add `phase` CoreEvent **only if**
   we choose the explicit signal over notice-string detection.
5. Callers (`cli.ts`, menu chat, repl) pass `interruptHint`.
6. Tests per Section 9.

Sequence the visible win first: steps 1–3a–3c deliver the `●` feel and richer status with
zero core changes; the panel "Waiting on N" (3d, optionally 4) and markdown (Q1) follow.

---

## 11. Risks & open questions for the user

- **Q1 — Markdown depth.** None / inline-only (bold, code, headings, bullets) / full
  Glamour-style with fenced syntax highlighting? Recommendation: **inline-only, TTY+color
  only**. Full highlighting is a large dependency and fights streaming.
- **Q2 — Dot off-TTY.** Keep `●` as a structural marker in pipes (helps `grep`/readability)
  or drop it for clean machine output? Recommendation: keep it; add `MYSHELL_PLAIN` to drop.
- **Q3 — Recoloring the streamed dot.** We can't retro-color the at-stream cyan dot to
  green/red. Options: (a) cyan-while-streaming + a separately-colored dot on the completion
  line (recommended, what's specced); (b) hold the whole turn and emit one final-colored dot
  (kills streaming — rejected). Confirm (a) is acceptable.
- **Q4 — Panel signal.** Add an explicit `phase` CoreEvent (clean, tiny core change) vs.
  detect panel mode from the existing `notice("Panel: …")` string + counting up-front
  `tier-start`s (zero core change, slightly brittle). Recommendation: the explicit event.
- **Q5 — Context-remaining.** Codex shows `context-remaining`; we have no reliable
  token-budget signal for subscription CLIs. Leave out, or estimate-and-mark with `~`?
  Recommendation: leave out (Honesty Contract).
- **Q6 — Animation default.** Spinner is already TTY-gated. Want a global `--no-anim` /
  `MYSHELL_NO_ANIM` to force the static label even on a TTY (slow terminals, screen
  readers)? Recommendation: yes, cheap to add.
- **Risk — width/emoji.** Sticking to `●`/`✓`/`✗`/`■`/braille (all single-cell, no emoji)
  avoids width drift; if a user's font lacks `●` it degrades to a visible box but never
  corrupts layout.
- **Risk — line clobbering.** The status line uses `\r…\x1b[K`; the new dot/hint lines must
  be cleared by `stopSpinner()` before prose, exactly as the spinner does today
  ([spinner.ts#L132-L135](../src/ui/spinner.ts#L132)) — covered by reusing that path.

---

### Sources

- [Claude Code Internals, Part 11: Terminal UI](https://kotrotsos.medium.com/claude-code-internals-part-11-terminal-ui-542fe17db016)
- [How Claude Code Actually Works](https://medium.com/@sujaypawar/how-claude-code-actually-works-1f6d4f1eea82)
- [Claude Code statusline docs](https://code.claude.com/docs/en/statusline)
- [Claude Code Todo/Task tracking docs](https://docs.claude.com/en/docs/agent-sdk/todo-tracking)
- [OpenAI Codex CLI](https://developers.openai.com/codex/cli) · [features](https://developers.openai.com/codex/cli/features) · [config reference](https://developers.openai.com/codex/config-reference)
- [Charm](https://charm.land/) · [Ink](https://github.com/vadimdemedes/ink) · [assistant-ui for Ink](https://www.assistant-ui.com/ink)
- [clig.dev — Command Line Interface Guidelines](https://clig.dev/)
