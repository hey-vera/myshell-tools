# Smart Tab Completion — Design (5.5)

**Status:** design/research only. No `src/` or `test/` changes proposed here; this
doc specifies what to build and where it slots in the master phase order.

**Owner surface:** `src/interface/menu.ts` (chat prompt + `completeSlash`),
`src/interface/repl.ts` (the legacy REPL completer wiring).

**One-line goal:** make Tab at the chat prompt genuinely *smart* — like Claude
Code's shell — completing slash commands **and their arguments**, **file/path**
tokens, and **`@`-file mentions**, with **fuzzy/substring** matching, while
keeping today's deliberate "do nothing sensible on plain prose" behavior so Tab
never corrupts a sentence. No model call: completion stays instant, local,
deterministic.

---

## 1. What myshell has today (verified, file:line)

- **Slash-only completer.** `completeSlash` is a pure readline `completer`
  (`src/interface/menu.ts:514`). It only fires when the line starts with `/`
  (`menu.ts:518`), filters the command set by `startsWith` (`menu.ts:519`), and
  returns `[hits, line]` per the Node contract (`menu.ts:522`). On non-slash
  prose it returns `[[], line]` — a deliberate no-op so plain text is never
  mangled (documented at `menu.ts:503-509`).

- **The advertised command set is stale.** `CHAT_SLASH_COMMANDS`
  (`menu.ts:500`) is only `['/help', '/back', '/exit']`, but the actual chat
  dispatch in `runOneChatInput` handles **`/exit`, `/back`** (`menu.ts:3044`),
  **`/help`** (`menu.ts:3048`), **`/style`** (`menu.ts:3062`), **`/mode`**
  (`menu.ts:3074`), and **`/goal <text>`** (`menu.ts:3384`). So Tab today won't
  even offer `/style`, `/mode`, or `/goal`. Fixing the candidate set is the
  cheapest first win and is a prerequisite for argument completion.

- **Wiring.** The chat prompt's readline is created once for the whole menu
  lifecycle with `completer: (line) => completeSlash(line)` (`menu.ts:3746`),
  then driven through the event-driven `LineReader` queue (`createLineReader`,
  `menu.ts:984`; built at `menu.ts:3748`). The legacy REPL wires the same
  completer with its own command set (`repl.ts:46`, set at `repl.ts:22`).

- **Completer is dormant off-TTY.** Both interfaces pass `terminal: out.isTty`
  (`menu.ts:3743`, `repl.ts:45`); readline only invokes the completer when
  `terminal` is true, so piped/test input never triggers completion. Good —
  the design must preserve this.

- **3.12.x raw-mode / single-keypress / suspend-resume constraints.** The chat
  prompt coexists with a hand-rolled keypress layer:
  - Mid-turn ESC interrupt + typed-ahead capture run on a *separate* keypress
    listener (`attachChatTurnKeyListener`, single `keypress` listener, scoped
    detach — `menu.ts:1305-1374`), and a `/dev/tty`-backed single-key reader
    (`menu.ts:1193`, `readSingleKey` ~`menu.ts:1217`).
  - `LineReader.suspend()/resume()` (`menu.ts:1053-1109`) hand the raw TTY to an
    inherited-stdio child (e.g. `claude auth login`) and re-arm it afterward;
    the comments warn explicitly against adding a *second* stdin reader or
    calling `stdin.read()` to "drain" (`menu.ts:1070-1074`).
  - **Implication for this design:** completion must live **entirely inside the
    readline `completer` callback** (which readline owns — it does not add a
    competing `data`/`keypress` consumer). We must NOT introduce a new
    keypress listener, a second `/dev/tty` reader, or any raw-mode toggling for
    completion. That keeps single-keypress, ESC-interrupt, and suspend/resume
    untouched.

- **Existing tests** (`test/unit/menu-flow.test.ts:5525-5562`) lock the current
  contract: bare `/` lists all commands, prefix filtering, prose is a no-op,
  unknown slash → no hits, custom command set, never throws. The new design must
  keep all of these green (extend, don't break).

---

## 2. How Node's `completer` actually behaves (research-grounded)

Concrete capabilities and limits that shape the design:

- **Two signatures.** Sync `(line) => [hits, substr]` or async
  `(line, cb) => cb(null, [hits, substr])`; the completer may also return a
  `Promise`. The async form lets us touch the filesystem (`fs.readdir`) without
  blocking the event loop.
  ([Node readline docs](https://nodejs.org/api/readline.html))

- **`[completions, substring]` contract.** `completions` is the candidate list;
  `substring` is the portion of input the candidates are matched against, and is
  the slice readline **replaces** when it applies a completion. Returning a
  `substring` that is the *trailing token* (not the whole line) is exactly how
  you do per-token / filename completion without rewriting the whole line.
  ([Node docs](https://nodejs.org/api/readline.html),
  [millermedeiros mirror](https://millermedeiros.github.io/mdoc/examples/node_api/doc/readline.html))

- **Two-stage Tab UX is built in.** First Tab inserts the **longest common
  prefix** of the candidates; suggestions are only *listed* after a **second**
  consecutive Tab. We get the "extend-then-list" behavior for free as long as
  candidates share a real prefix.
  ([nodejs/node#7754](https://github.com/nodejs/node/pull/7754),
  [commit 1a9e247](https://github.com/nodejs/node/commit/1a9e247c79))

- **The completer can rewrite existing input.** Node explicitly supports a
  completer that *changes* the already-typed token (e.g. casing fixes), via the
  returned `substring`. This is the seam we use for fuzzy/substring matching:
  when no candidate shares a literal prefix, we can still return the matched
  token as the `substring` and a single best candidate to swap in.
  ([commit 20cc8ec](https://github.com/nodejs/node/commit/20cc8ec2af),
  [commit 6c87b59](https://github.com/nodejs/node/commit/6c87b591d9))

- **Documented limits.** The docs do **not** specify whether the completer
  receives the whole line or only up-to-cursor, and they document no
  fuzzy/substring support — readline's own match is prefix-only via whatever you
  filter. So **all** smarts (substring, fuzzy, path expansion, `@`-mentions) are
  *our* job inside the callback; readline only does common-prefix insertion +
  listing on top of the candidate list we return.
  ([Node docs](https://nodejs.org/api/readline.html))

### How other AI CLIs / tools do it

- **Claude Code (interactive prompt).** Tab completes **`@`-file mentions** —
  type `@` then Tab and it inserts repo file/dir paths without typing the full
  path; `@path/to/file.js` references a file. Slash commands and custom-command
  arguments are first-class. This is the north star for myshell's chat prompt.
  ([Steve Kinney — referencing files](https://stevekinney.com/courses/ai-development/referencing-files-in-claude-code),
  [Claude Code CLI ref](https://code.claude.com/docs/en/cli-reference))

- **Claude Code (shell flags/subcommands).** A separate, *out-of-process*
  concern: users want bash/zsh completion scripts for `--flags`/subcommands
  (open feature request), typically generated via `tabtab`/Commander. This is
  **out of scope** for the chat prompt — noted only so we don't conflate the
  two. ([anthropics/claude-code#40503](https://github.com/anthropics/claude-code/issues/40503),
  [cc-completion](https://github.com/hmmf022/cc-completion),
  [claude-bash-completion](https://github.com/cldotdev/claude-bash-completion))

- **fzf / node-fzf.** Fuzzy finding ranks approximate matches by score rather
  than exact/prefix match; node-fzf offers fuzzy + exact modes. We borrow the
  *ranking* idea (substring/subsequence with a simple score) but **not** the
  full-screen interactive UI — that would require taking over the TTY and
  fighting the 3.12.x raw-mode layer.
  ([fzf](https://github.com/junegunn/fzf),
  [node-fzf](https://www.npmjs.com/package/node-fzf))

- **fs primitives for path completion.** `fs.readdir`/`fsPromises.readdir`
  lists a dir; tilde (`~`) expansion is **not** built in and must be done
  manually; paths resolve against `process.cwd()`. Straightforward to build
  from core — **no new dependency required**.
  ([Node fs docs](https://nodejs.org/api/fs.html),
  [nodejs/node#684 tilde](https://github.com/nodejs/node/issues/684))

---

## 3. What "smart Tab" should concretely do

A single dispatcher inspects the line (up to the cursor) and the **trailing
token**, then routes to one of four behaviors. On no confident match it returns
`[[], line]` — the safe no-op.

**(a) Slash command name.** Line is `/` + a single word, no space yet
(`/st<Tab>` → `/style`). Match the *real* command set
(`/help /back /exit /mode /style /goal`) by prefix, then substring as a
fallback. Bare `/` lists all. (Preserves and extends today's behavior.)

**(b) Slash command ARGUMENTS.** Line is a known command + space + partial arg.
Each command supplies its own candidate set:
- `/mode ` → `Efficient | Balanced | Max` (from `runModeSelect`, `menu.ts:1755`).
- `/style ` → `Direct | Balanced | Collaborative` (from `runStyleSelect`,
  `menu.ts:1886`; labels at `menu.ts:3053`).
- `/goal ` → **no completion** (free-text objective). Explicitly opt-out so we
  never mangle a goal sentence.
- `/help`, `/back`, `/exit` → no args.
The arg-candidate map is a small, pure table keyed by command. This is why the
feature **slots alongside Phase 5** (command surface) — arg completion needs the
canonical command set as its source of truth (§7).

**(c) FILE/PATH completion.** Fires when the trailing token *looks like a path*:
starts with `./`, `../`, `/`, `~/`, or contains a `/`. Expand `~`, resolve the
dir portion against `cwd`, `readdir` it, filter the basename by prefix (then
substring), append `/` to directory hits. Return the **basename fragment** as
the `substring` so readline replaces only the trailing path segment. Async
completer signature so the `readdir` never blocks the loop.

**(d) `@`-file MENTIONS.** Trailing token starts with `@` (Claude-Code-style).
Strip the `@`, run the same path engine rooted at `cwd` (repo-relative), return
candidates **including** the `@` prefix so the mention stays well-formed. This
is the most valuable "smart" affordance for an AI chat prompt — it lets the user
point at a file without typing the path.

**(e) Fuzzy / substring matching.** Across (a)–(d): try `startsWith` first
(so readline's common-prefix insertion works cleanly), and only fall back to
substring/subsequence ranking when prefix yields nothing. When a fuzzy fallback
produces a **single** strong candidate, return it with the matched token as
`substring` so readline swaps it in (using the "completer can rewrite input"
capability). When fuzzy produces several, list them (don't auto-insert) to avoid
surprising edits.

**(f) Plain prose → no-op (unchanged, load-bearing).** If the line is free-form
text with no slash, no path-shaped token, and no `@`, return `[[], line]`. This
is the deliberate current behavior and the single most important safety
property — Tab must never corrupt a sentence. Path/`@` detection must be
conservative (require a clear path signal) so an ordinary word like "don't" or
an email-ish token isn't treated as a path.

---

## 4. Integration approach (pure, testable, coexisting)

### 4.1 Shape: one impure async completer over many pure functions

Keep every decision in **pure functions** (string/array in, candidate list out);
isolate the only impurity (`fs.readdir`, `cwd`, `~` resolution) behind an
injected seam so tests stay hermetic. Proposed pure seams (all exported from
`menu.ts`, mirroring how `completeSlash` is exported today for `repl.ts` reuse):

```
classifyCompletion(line): 
   { kind: 'slash-name' | 'slash-arg' | 'path' | 'mention' | 'none',
     command?: string, token: string, prefixLen: number }
       // prefixLen = where the trailing token starts → drives the `substring`

completeSlash(line, commands?)            // EXISTING — keep, extend command set
completeSlashArg(command, argToken, argMap)   // pure; argMap keyed by command
fuzzyRank(token, candidates): string[]    // startsWith first, then substring/subseq
expandPathToken(token): { dir, base, displayPrefix }   // pure ~/cwd math, NO fs
matchPathEntries(base, entries): string[]  // pure: filter+sort a readdir result
```

The single async completer composes them:

```
async function completeChat(line, deps = { readdir, cwd }) {
  const c = classifyCompletion(line);
  switch (c.kind) {
    case 'none':       return [[], line];
    case 'slash-name': return completeSlash(line, CHAT_SLASH_COMMANDS);
    case 'slash-arg':  return wrap(completeSlashArg(c.command, c.token, ARG_MAP), c.token);
    case 'path':
    case 'mention': {
      const { dir, base, displayPrefix } = expandPathToken(c.token);
      const entries = await deps.readdir(dir).catch(() => []);
      const hits = matchPathEntries(base, entries).map(h => displayPrefix + h);
      return [hits, c.token];   // substring = trailing token only
    }
  }
}
```

- `completeChat` is the only function that touches `fs`; everything it calls is
  pure and table-testable. `deps` injection (default real `fs.promises.readdir`
  + `process.cwd`) keeps unit tests filesystem-free.
- The returned `substring` is always the **trailing token** (or whole line for
  the slash-name case, matching today), so readline replaces only that token.

### 4.2 Wiring — minimal, async, coexists with 3.12.x and Phase 0

- Replace `completer: (line) => completeSlash(line)` at `menu.ts:3746` with the
  **async** completer: `completer: (line, cb) => { completeChat(line).then(r =>
  cb(null, r), () => cb(null, [[], line])); }`. Async is required for `readdir`;
  the catch guarantees it degrades to the safe no-op and **never throws** (the
  existing invariant).
- **No change to the LineReader, keypress, suspend/resume, or `/dev/tty`
  paths.** Completion lives inside readline's own callback. Readline does not
  spawn a competing stdin consumer for completion, so single-keypress, the
  mid-turn ESC listener (`attachChatTurnKeyListener`), and child-handoff
  suspend/resume are all untouched. This is the central reason the feature is
  low-risk against 3.12.x.
- **Phase 0 (`runOneChatInput`) coexistence:** completion is purely an *input
  editing* concern that finishes **before** a line is ever submitted. It has no
  interaction with the post-turn slot (`decidePostTurn`, MF3), typed-ahead
  capture, or turn dispatch — those only see the final submitted line. So it
  rides on top of Phase 0 with zero coupling.
- **REPL (`repl.ts:46`):** optionally upgrade to the same async completer for
  consistency, or leave as slash-only. Low priority — the chat prompt is the
  product surface. Recommend: share `completeChat` but pass the REPL's own
  command set, so both prompts stay in sync via one engine.

### 4.3 Scope discipline (subscription-honest)

- **No model call. Ever.** Completion is instant, local, deterministic —
  `readdir` + pure string math only. This matches the tool's subscription-auth
  posture: Tab spends no tokens.
- **No new heavy dependency.** Path completion uses core `fs`/`path`; fuzzy
  ranking is ~30 lines of subsequence scoring. Avoid `fzf`/`node-fzf`/`inquirer`
  autocomplete — they want to own the screen and would collide with the
  raw-mode layer.
- **Bounded work.** `readdir` one directory per Tab (the dir of the trailing
  token), cap candidate lists (e.g. 50) so a huge directory can't flood the
  terminal or stall.

---

## 5. Test strategy

All seams are pure or dependency-injected, so coverage is table-tests with **no
real TTY and no real filesystem** — same style as the existing
`completeSlash` block (`test/unit/menu-flow.test.ts:5525`).

- **`classifyCompletion`** — table: `/st` → slash-name; `/mode E` → slash-arg
  (command=`/mode`, token=`E`); `./src/i` → path; `@src/i` → mention;
  `refactor the auth module` → none; `don't` / `a/b` edge cases asserting prose
  stays `none` unless a real path signal is present. Assert `prefixLen` so the
  returned `substring` covers exactly the trailing token.
- **`completeSlash`** — keep all existing assertions; add: `/mo` → `/mode`,
  `/g` → `/goal`, `/s` → `/style`, and bare `/` lists the **full** updated set.
- **`completeSlashArg`** — `/mode E` → `['Efficient']`; `/style D` →
  `['Direct']`; `/goal anything` → `[]` (free text, no completion); unknown
  command → `[]`.
- **`fuzzyRank`** — prefix beats substring beats subsequence; ordering is
  deterministic; empty token returns all; no-match returns `[]`.
- **`expandPathToken` / `matchPathEntries`** — pure: `~/x` expands home;
  `../a/b` keeps the dir prefix; basename filtering; directory entries sort
  before files and get a trailing `/`. Driven with a fixed `entries` array,
  no fs.
- **`completeChat`** — inject a fake `readdir` returning a fixed listing; assert
  the `[hits, substring]` shape, `@`-prefix preserved in mention hits, the
  trailing-token `substring`, and that a rejected `readdir` yields `[[], line]`
  (never throws).
- **Regression guard:** one test asserting the off-TTY path is untouched (the
  completer is simply not invoked when `terminal:false`) and that prose is a
  strict no-op (the load-bearing safety test).

No new TTY/integration tests are needed because the completer adds no stdin
consumer — the 3.12.x keypress/suspend tests already cover that layer and remain
valid.

---

## 6. Risks

- **Prose false-positives (highest).** Over-eager path/`@` detection could turn
  Tab into a sentence-mangler. Mitigation: conservative classifier (require
  `./ ../ / ~/` or an embedded `/`, or a leading `@`); default to `none`; the
  prose no-op test is a hard gate.
- **`substring` mismatch corrupts the line.** If the returned `substring` isn't
  exactly the trailing token readline expects, it can replace the wrong span.
  Mitigation: derive `substring` from `classifyCompletion.prefixLen`; cover with
  table tests on real-ish lines.
- **Async completer + readline edge cases.** Some Node versions historically had
  REPL tab-completion crashes ([PR #43543](https://github.com/nodejs/node/pull/43543)).
  Mitigation: wrap in try/catch → no-op; verify on the project's Node 22 baseline.
- **Large/slow directories.** A `readdir` on a huge dir could stall or flood.
  Mitigation: cap results, and (optional) ignore dot-dirs like `node_modules`
  unless explicitly typed.
- **Stale command set drift.** `CHAT_SLASH_COMMANDS` already drifted from the
  real dispatch. Mitigation: make the dispatch and the completer read **one**
  exported command/arg table; add a test asserting every advertised command is
  handled and vice-versa.
- **Cursor-mid-line behavior undocumented.** Node doesn't specify whole-line vs
  up-to-cursor. Mitigation: design assumes "complete the trailing token of the
  line"; if a user Tabs mid-line we accept best-effort and lean on the no-op
  fallback. Worth a quick empirical check on Node 22.

---

## 7. Phased plan + where it slots in the master order

The master spine is `0 → 2 → 3 → 4 → {5, 6+APE} → 7 → 8 → 9`
(`docs/MASTER-PLAN-5.5.md:252`), with Phase 5 = "memory commands + model-proposed
memory" (`MASTER-PLAN-5.5.md:333`) — the phase that touches the chat **command
surface**. Argument completion needs that canonical command set as its source of
truth, so smart-Tab is best landed **alongside / just after Phase 5**, once the
final command list (incl. any `/memory`, `/recap`) is settled — avoiding a
second drift of `CHAT_SLASH_COMMANDS`.

**Sub-phase T1 — command-set truth + slash-name (tiny, can land with Phase 5).**
Update `CHAT_SLASH_COMMANDS` to the real set, add the test asserting
dispatch↔completer parity. Files: `src/interface/menu.ts`,
`test/unit/menu-flow.test.ts`. Low risk, immediate win.

**Sub-phase T2 — slash-argument completion.** Add `completeSlashArg` + the pure
`ARG_MAP` (`/mode`, `/style`), `classifyCompletion`. Files:
`src/interface/menu.ts`, tests. Depends on T1's command set.

**Sub-phase T3 — path + `@`-mention engine (async completer).** Add
`expandPathToken`, `matchPathEntries`, `fuzzyRank`, `completeChat` (async, fs
seam), and swap the chat-prompt completer wiring at `menu.ts:3746` to the async
form. Optionally upgrade `repl.ts:46`. Files: `src/interface/menu.ts`,
(`src/interface/repl.ts`), tests. This is the bulk of the value.

**Sub-phase T4 — fuzzy fallback polish.** Tune ranking + the single-candidate
rewrite path; dir-ignore list; result caps. Files: `src/interface/menu.ts`,
tests.

**Files touched (total):** `src/interface/menu.ts` (primary),
`src/interface/repl.ts` (optional), `test/unit/menu-flow.test.ts`. No new files,
no new deps, no core/orchestration changes.

**Coexistence guarantees:** rides on Phase 0's `runOneChatInput` (input-only,
pre-submit; no post-turn coupling), adds **zero** stdin consumers, and leaves the
3.12.x raw-mode / single-keypress / suspend-resume / `/dev/tty` paths
**untouched** (§4.2).

---

## 8. Open questions for the user

1. **`@`-mention semantics — completion only, or injection too?** Should Tab on
   `@path` *also* later make myshell read/attach that file's contents into the
   turn (Claude-Code-style), or is this purely a typing aid for now? The
   completer is the same either way, but injection is a separate, larger feature
   — confirm scope.
2. **Path-completion root: `cwd` or the repo/conversation root?** Claude Code is
   repo-rooted. myshell can target a workspace/conversation root if one exists —
   which root do we complete against?
3. **How aggressive should fuzzy be?** Prefix-only (safest, most predictable) vs
   substring vs full subsequence fuzzy (most powerful, most surprising). Pick the
   default; we can keep it conservative for slash and looser for paths.
4. **Should the legacy `repl.ts` prompt get the same smart Tab,** or stay
   slash-only? (It's a secondary surface.)
5. **Directory hygiene:** ignore `node_modules`/dotfiles by default, or complete
   everything the user can see? And what result cap feels right (e.g. 50)?
6. **Land timing:** bundle smart-Tab *into* Phase 5 (command surface is being
   touched anyway, avoids a second `CHAT_SLASH_COMMANDS` drift), or ship T1 with
   Phase 5 and T2–T4 as a fast follow?
