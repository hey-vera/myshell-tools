# Codebase Awareness — Design (5.6)

**Status:** research + design only. No `src/` or `test/` changes are proposed here;
this doc specifies *what* to build, *where* it slots into the existing prompt seam,
and *why* the subscription-auth constraint dictates the approach.

**One-line goal:** when a user in a project says *"make the socials page real"*, the
assistant should already **know it is in repo X**, what the structure is, where the
likely entry points are — and **investigate** rather than interrogate. It should be
able to say *"I'm in `acme-web` (a Next.js app); I see `app/socials/page.tsx` — is
that the page you mean?"* instead of asking four abstract clarifying questions.

**Owner surface (where it lands):**
- `src/core/prompt-context.ts` — `assembleContextBlocks` (the ONE prompt seam, MF1).
  An `environment` block slots into the canonical order here.
- `src/interface/menu.ts` — `buildDeps` (`menu.ts:3469`) + a new per-turn/per-session
  resolver that mirrors `resolveTurnMemory` (`menu.ts:3605+`), threading the rendered
  block through `OrchestrateDeps` exactly like `memoryContext`.
- `src/core/types.ts` — one additive `OrchestrateDeps.environmentContext?: string`
  field (mirrors `memoryContext?`, `types.ts:352`).
- New pure core: `src/core/repo-map.ts` (ranking + rendering), and a thin impure
  reader `src/infra/repo-scan.ts` (fs/git → raw facts). Mirrors the
  `intent.ts` (pure) / `intent-extractor.ts` (impure composer) split.

---

## 0. The motivating failure (live-found)

A user running myshell in a Replit container said **"make the socials page real"**.
The chat asked abstract clarifying questions instead of being aware of its
environment. Root cause: **the model starts each turn context-blind about the repo.**
It does not know it is in a project, what the project *is*, or which files exist. So a
vague-but-locally-obvious request ("the socials page") reads as genuinely
under-specified, and the partner posture (APE) — correctly trying not to barrel in —
falls back to interviewing.

Two distinct fixes are needed and this doc designs both:
1. **Feed the model an upfront, deterministic ENVIRONMENT / REPO-MAP block** so it
   starts informed (this doc, §1–§5).
2. **Bias the posture toward investigate-first** when a repo map is present (this
   doc, §1.3 — composes with the partner-posture nudge in `prompt-context.ts:82`).

---

## 1. What "codebase awareness" should MEAN for myshell — minimally

### 1.1 The crucial asymmetry vs Cursor

Cursor is a **passive** editor: the model it calls has **no tools of its own** to read
the disk, so Cursor must do all retrieval up front (embeddings + similarity search,
RAG) and stuff snippets into the prompt. ([How Cody understands your codebase](https://sourcegraph.com/blog/how-cody-understands-your-codebase))

myshell is fundamentally different: it **wraps agentic models** (Claude Code, Codex)
that **already have their own `Glob`/`Grep`/`Read` tools within a turn.** Anthropic
built RAG into early Claude Code, benchmarked it against agentic search, and **agentic
search won — "by a lot"**; Claude Code ships with *no* vector index.
([Claude Code Doesn't Index Your Codebase](https://vadim.blog/claude-code-no-indexing),
[Why coding agents still use grep](https://yage.ai/share/why-coding-agents-still-use-grep-en-20260327.html))

**Implication:** myshell does **not** need to *retrieve* code for the model — the model
retrieves its own. What myshell must supply is the thing the model *cannot* cheaply
discover from inside one turn without burning a pile of tool calls: a **cheap,
deterministic orientation map** — "here is where you are, here is the shape of the
project, here are the likely entry points" — so the model's *own* search starts
**smart** instead of blind. Awareness for myshell = **orientation, not retrieval.**

### 1.2 The minimal ENVIRONMENT block (the deliverable)

A small, deterministic block assembled per session (cached) and injected via
`assembleContextBlocks`. Concretely, in priority order:

```
ENVIRONMENT
  cwd:    /home/runner/workspace
  repo:   acme-web  (git root /home/runner/workspace, branch main, 3 files dirty)
  type:   Next.js app (package.json: next, react; tsconfig.json present)
  docs:   README.md present; CLAUDE.md present
  entry:  package.json "dev": next dev; app/layout.tsx; app/page.tsx
REPO MAP (ranked, ~N files shown of M)
  app/page.tsx            — export default Home()
  app/socials/page.tsx    — export default SocialsPage()   ← (def: SocialsPage)
  lib/api.ts              — fetchPosts(), postShare()
  components/Nav.tsx      — Nav()
  …
```

The pieces, cheapest-first (each independently optional / fail-soft):

1. **cwd** — already on `MenuContext.cwd` (`menu.ts:207`) and `OrchestrateDeps.cwd`
   (`types.ts:279`). Zero cost. Just surface it.
2. **git root + repo name + branch + dirty count** — `git rev-parse --show-toplevel`,
   current branch, `git status --porcelain | wc -l`. One cheap subprocess, cached.
3. **project type / signals** — presence + a few keys of `package.json`
   (deps → "Next.js"/"React"/"Express"), `tsconfig.json`, `pyproject.toml`, `go.mod`,
   `Cargo.toml`. Pure string sniffing, no parse of the whole tree.
4. **doc presence** — `README.md`, `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`. We note
   **presence only** (file exists / does not exist). Their contents are **not** injected as
   trusted instructions. If any repo file content is surfaced to the model (e.g. via targeted
   retrieval), it is wrapped in an untrusted-data boundary (`src/core/untrusted-content.ts`)
   that marks the span as evidence only — instructions, role changes, trust/confidence claims,
   completion markers, command tiers, and safety/verification directives inside repo content
   have no authority and cannot override judgment, verification, or command-tier decisions.
   Mirrors how Claude Code treats `CLAUDE.md` as the legibility anchor, but with an explicit
   trust boundary. ([Claude Code best practices](https://code.claude.com/docs/en/best-practices))
5. **entry points** — `package.json` `scripts`/`main`/`bin`, framework conventions
   (`app/`, `pages/`, `src/index.*`, `main.py`).
6. **REPO MAP** — a ranked file list (optionally with top-level symbols), aider-style,
   fit to a token budget (§2, §5).

The block is **cheap and deterministic** — no model call, no embeddings, no network.
It is the same class of artifact as the existing `memoryContext` block, and rides the
identical plumbing.

### 1.3 The posture half — "investigate, don't interrogate"

The block alone makes the model *informed*; the second half makes it *act* informed.
When an ENVIRONMENT block is present, add one line to the posture nudge
(`prompt-context.ts:partnerNudge`, or a sibling line in the env block itself):

> *You are in a known project (see ENVIRONMENT). Prefer to INVESTIGATE the repo with
> your own file tools and state a reasonable assumption before asking the user a
> clarifying question. If the user names a file/page/feature, look for it in the
> REPO MAP and the tree first.*

This composes with — does not replace — the APE engagement policy. APE already lowers
the bar for asking on genuine forks (`prompt-context.ts:82-91`); the env block changes
what counts as a fork: "which socials page?" stops being a fork once `app/socials/`
is visible in the map. This is the direct antidote to the heyvera/socials failure.

---

## 2. The DECISION: repo-map vs local embeddings vs pure-agentic-search

### 2.1 The three options, against the constraint

myshell is **subscription-auth (OAuth), not API-key/metered** (product guardrail:
no embeddings API, no hosted vector DB, no metered service — reuse the
subscription model-call machinery only). That hard constraint plus the agentic
asymmetry (§1.1) collapses the decision.

| Approach | What it is | Subscription-fit | Verdict |
|---|---|---|---|
| **Embedding index** (Cursor, Continue, Windsurf) | Chunk files → embeddings → vector DB → similarity search → inject snippets. Cursor uses a Merkle tree of file hashes, re-syncs every ~10 min, stores embeddings in a remote vector DB (Turbopuffer). ([How Cursor indexes codebases fast](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast), [Securely indexing large codebases](https://cursor.com/blog/secure-codebase-indexing)) | **Bad fit.** Needs an embedding model (API/metered) or a heavyweight local model (Continue suggests `nomic-embed-text` via Ollama — a multi-GB dependency we won't ship). Even Sourcegraph Cody is **abandoning embeddings** for native search. ([Continue embeddings](https://docs.continue.dev/customize/model-roles/embeddings), [Cody remote repository context](https://sourcegraph.com/blog/how-cody-provides-remote-repository-context)) | ✗ Reject |
| **Repo map** (aider, Continue's repo-map provider) | Tree-sitter (or cheap heuristics) → list of files + top-level symbols, ranked by a dependency graph (PageRank), fit to a token budget. **No embeddings, no GPU, no API.** ([aider repomap](https://aider.chat/docs/repomap.html), [Continue repo-map provider](https://docs.continue.dev/customize/deep-dives/custom-providers)) | **Best fit.** Deterministic, local, cheap, zero metered services. | ✓ **Recommend** |
| **Pure agentic search** (Claude Code today) | Give the model `Glob`/`Grep`/`Read` and let it explore on demand; no upfront artifact. ([Claude Code no-indexing](https://vadim.blog/claude-code-no-indexing)) | **Already happening** inside the wrapped model. | ✓ Keep — *compose with*, don't replace |

### 2.2 Recommendation: **repo map, composed with the model's own agentic search**

Build a **deterministic repo map** (aider's no-embedding approach) and inject it as
the ENVIRONMENT block. **Do NOT** build an embedding index. **Do NOT** try to replace
the model's own grep/read — instead **feed it a map so it searches smarter.** The map
is orientation; the model's tools are retrieval. They are complementary:

- The map tells the model *the socials page is `app/socials/page.tsx`* → the model
  `Read`s exactly that file instead of `Grep`-ing blindly (fewer tool calls, faster,
  cheaper-in-wall-clock — a real subscription-friendly efficiency win).
- The map is **bounded and deterministic** → it always fits the budget and never
  hangs; the agentic tools handle the unbounded long tail on demand.

This is the only option that honors the constraint *and* exploits the asymmetry: we
get Cursor-grade "the assistant just knows the project" from a **cheap deterministic
map**, not a vector index.

### 2.3 Ranking: start heuristic, leave a seam for tree-sitter PageRank

aider's edge is **PageRank over a tree-sitter symbol graph**: a function called by 20
others is more valuable context than a private helper called once; files are ranked,
then included until the token budget is exhausted (default `--map-tokens` 1k).
([aider repomap blog](https://aider.chat/2023/10/22/repomap.html))

We **do not need tree-sitter on day one** (it's a real dependency + per-language
grammars). A strong **deterministic heuristic ranking** captures 80% of the value with
zero deps:

- **git signal:** recently-changed + dirty files rank up (they're what the user is
  working on); `git ls-files` for tracked-only.
- **entry-point signal:** files named by `package.json` scripts/main/bin, framework
  conventions (`app/`, `pages/`, `src/index.*`, `main.*`), config roots.
- **fan-in proxy (cheap):** count import references by `grep`-ing `from '...'` /
  `require('...')` / `import` targets — a poor-man's reference graph without a full
  parser. Files imported by many others rank up (the PageRank intuition, approximated).
- **shallow-depth + size sanity:** prefer top-of-tree, source dirs; demote
  generated/vendored.
- **ignore hygiene:** honor `.gitignore`; always skip `node_modules`, `.git`, `dist`,
  `build`, lockfiles, dotdirs (same hygiene the tab-completion design adopts, §6.5).

Keep the ranker a **pure function** (`rankRepoFiles(facts) → ranked[]`) so tree-sitter
PageRank can be slotted behind the same seam later (Phase 2 of this feature, §6)
without touching plumbing — exactly how `intent.ts` keeps the model pass behind a port.

### 2.4 Symbols: optional, budget-permitting

The richest map includes **top-level symbols/signatures per file** (aider, Continue's
repo-map provider both do this). Without tree-sitter we can extract a cheap subset via
regex (`export function|class|const X =`, `def `, `func `) — good enough for an
orientation line. Symbols are the **first thing dropped** when the budget is tight
(§5): a ranked *path* list is the floor; symbols are gravy.

---

## 3. @-mention codebase context — extend, do not duplicate, tab-completion-5.5

`docs/tab-completion-5.5.md` already designs `@file`/path **completion** at the chat
prompt (§3(c)(d), `classifyCompletion` → `mention`/`path` kinds). Its **open question
#1** is explicitly: *"@-mention — completion only, or injection too?"* **This doc
answers that question** and extends the design; it does **not** re-spec the completer.

### 3.1 The split: completion (tab doc) → resolution/injection (this doc)

- **`@file` / `@folder`** — Tab completion is owned by tab-completion-5.5. **Injection**
  (this doc): on submit, a pure `resolveMentions(line, cwd)` scans the final line for
  `@`-tokens that resolve to real paths under the repo root, and attaches a small,
  capped **MENTIONS block** (path + a head of the file, or a folder listing) to the
  ENVIRONMENT block. This makes `@`-mentions *load-bearing*, matching Claude Code,
  where `@path/to/file` references a file into the turn.
  ([Referencing files in Claude Code](https://stevekinney.com/courses/ai-development/referencing-files-in-claude-code))
  - Caveat (subscription-honest): when the wrapped model **already** has `Read`, we can
    inject just the **resolved path** ("user means `@app/socials/page.tsx`") and let the
    model read it — cheaper than slurping contents. Inject contents only for small files
    or when the provider has no file tools (e.g. a thin opencode model). Decision is a
    one-liner per provider capability; default = inject path + short head.

- **`@codebase`** — a special mention that triggers the **cheap repo map**, NOT a
  search and NOT an embedding query. `@codebase` = "render the full(er) repo map into
  this turn" (raise the map's token budget for this turn). This is the
  subscription-friendly reinterpretation of Cursor's embedding-backed `@codebase`
  ([Cursor @-symbols](https://datalakehousehub.com/blog/2026-03-context-management-cursor/)):
  same UX affordance, deterministic-map implementation, no vector DB.

- **`@web` / `@docs`** — **out of scope** for 5.6 (note only). `@web` would need the
  WebSearch surface; `@docs` would need doc indexing. Flag as future; don't build.

### 3.2 Why this is the right seam
`resolveMentions` is pure (string + injected `readdir`/`stat`/`readFile`), table-tested,
and feeds the **same ENVIRONMENT block**. The completer (tab doc) and the resolver
(this doc) share the same `@`-token grammar — define it **once** and import it both
places to avoid drift (a lesson `CHAT_SLASH_COMMANDS` drift already taught us).

---

## 4. cwd-vs-referenced-project awareness (the heyvera failure)

A subtle, high-value behavior: detect when the user **names a project or path that is
NOT in the current workspace**, and surface it instead of silently working in the wrong
place. Example: user in `acme-web` says *"fix the login in heyvera"* but there is no
`heyvera/` under cwd.

### 4.1 Detection (pure, deterministic)
A pure `detectReferencedProject(line, repoFacts)` that:
- extracts candidate project/path tokens from the line (proper-noun-ish words, quoted
  names, slash-paths, `@`-mentions), then
- checks each against the repo facts: is it a top-level dir? a file in the map? the
  repo name itself? a sibling dir of the git root?
- returns `{ token, status: 'in-repo' | 'sibling' | 'unknown' }[]`.

### 4.2 Surfacing (composes with posture, not a hard block)
When a referenced token is **unknown** to the workspace, add ONE honest line to the
ENVIRONMENT block:

> *Note: the user mentioned "heyvera", which is not in this workspace (`cwd` is
> `acme-web`). If they meant a different project, confirm the path before acting.*

This turns a silent wrong-directory disaster into a single grounded clarifying
question — the *one* place asking is correct. It is the inverse of §1.3: investigate
when the thing exists, ask when it provably doesn't. Both are driven by the same
deterministic repo facts.

---

## 5. Token budget + caching + staleness

### 5.1 Budget — coordinate with the existing cap
`assembleContextBlocks` already enforces a hard `CONTEXT_BLOCK_CHAR_CAP = 6000`
backstop over ALL blocks (`prompt-context.ts:75`), and `whole-tool-finish-5.5.md §3`
owns the per-turn capability/token budget + the quota-shed ladder. The repo map must
**fit inside that budget and be sheddable**, exactly like the memory and intent blocks.

- **Map token budget:** default the **map** to a small share (aider defaults to ~1k
  tokens; we should pick a char-equivalent, e.g. ~1.5–2k chars, leaving the other ~4k
  for memory/intent/engagement). The map **producer caps itself first** (accumulate
  ranked files until the budget is hit — aider's exact strategy), and the
  `assembleContextBlocks` cap is the backstop.
- **`@codebase` raises the budget** for that one turn (more files / add symbols).
- **Shed rung:** add the env block to the `decideShed` ladder
  (`whole-tool-finish-5.5.md §3.2`, surfaced as `currentShedPlan()` in `menu.ts:3486`).
  Under heavy pressure: drop symbols first, then narrow to cwd+git+type+entry only
  (the orientation floor is tiny), so the env block never crowds out the core answer.

### 5.2 Caching — session-scoped, mtime/Merkle-invalidated
A full scan + rank on **every turn** would be wasteful. Cache like the field-tested
approaches:

- **Compute once per chat session, reuse per turn.** Resolve the *static* facts
  (cwd, git root, repo name, type, doc presence, base map) **once** when the chat loop
  starts — the same place `memoryProjectKey` is resolved once per session
  (`menu.ts:3648`). Refresh the **cheap dynamic bits** (branch, dirty count, the
  `@codebase`/mention deltas) per turn.
- **Invalidate by mtime** (aider caches tree-sitter tags in SQLite keyed by file path
  with **mtime-based invalidation** — re-parse only changed files;
  [aider repo map system](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system)).
  myshell's lighter version: a cheap **directory-mtime / git-status digest**; if it's
  unchanged since the cached scan, reuse the map verbatim. Cursor's analogue is the
  **Merkle tree of file hashes** that lets it re-sync only changed branches every ~10
  min ([Cursor Merkle indexing](https://undercodetesting.com/how-cursor-ide-uses-merkle-trees-for-efficient-code-indexing/)) —
  we want the *idea* (hash/mtime digest → skip unchanged work), not the remote vector DB.
- **Where to cache:** an in-memory session cache is enough for v1 (no persistence
  needed). If we later persist, it goes under the existing state dir resolved by
  `defaultStateHome()` (`state-dir.ts:55`) — which correctly anchors to the **workspace
  on Replit** (where `~` is ephemeral, `state-dir.ts:30`) so the cache survives restarts
  in exactly the container the motivating user hit.

### 5.3 Staleness
The map is an **orientation hint, not ground truth** — the model's own tools see the
live disk. So mild staleness is harmless (worst case: the model `Read`s a file the map
mislabeled and self-corrects). The dirty-count + branch are refreshed per turn so the
"3 files dirty" line stays honest. No background watcher, no 10-minute timer (Cursor
needs one because its index is the only retrieval path; ours isn't).

---

## 6. Integration, phased plan, files, tests, risks

### 6.1 How it composes with the 5.5 build (slots after, coexists with posture)
The 5.5 master spine ends with the partner-posture + memory + intent stack already
flowing through `assembleContextBlocks`. Codebase awareness is **purely additive** to
that seam — it adds one more optional block in the canonical order:

```
MEMORY → ENVIRONMENT(+REPO MAP +MENTIONS) → INTENT → ENGAGEMENT → (partner posture)
```

(ENVIRONMENT goes early — it's the orientation the later intent/engagement reasoning
should already see.) It threads through `buildDeps` (`menu.ts:3469`) and a new
`resolveEnvironmentContext` resolver that **mirrors `resolveTurnMemory` exactly**
(`menu.ts:3605+`): fail-soft to `''`, no model call, capped, gated by a kill-switch
(`config.codebaseAwareness !== false`). One additive `OrchestrateDeps.environmentContext?`
field (`types.ts`), rendered in `assembleContextBlocks`. **Zero changes** to the
executors, the routing, the post-turn flow, or the keypress/raw-mode layer.

### 6.2 Phased plan
- **Phase E1 — ENVIRONMENT block (orientation only, no map).** cwd + git
  root/name/branch/dirty + project type + doc presence + entry points. New
  `src/infra/repo-scan.ts` (impure reader) + pure `renderEnvironmentBlock`; wire
  `environmentContext` through `buildDeps` + `assembleContextBlocks` + types. The
  posture line (§1.3). **This alone fixes most of the socials failure** and is small.
- **Phase E2 — REPO MAP (heuristic ranking).** `src/core/repo-map.ts`
  (`rankRepoFiles` pure + `renderRepoMap` pure), the cheap import-fan-in proxy,
  git-recency signal, token-budget accumulation, ignore hygiene, session cache +
  mtime/digest invalidation (§5.2).
- **Phase E3 — referenced-project detection (§4).** `detectReferencedProject` pure +
  the one-line surfacing.
- **Phase E4 — @-mention resolution/injection (§3).** `resolveMentions` pure +
  capped MENTIONS block; share the `@`-grammar with the tab completer; answers
  tab-completion-5.5 open-Q #1. `@codebase` → raise the map budget for the turn.
- **Phase E5 (optional, later) — tree-sitter PageRank ranker** behind the existing
  `rankRepoFiles` seam, only if heuristic ranking proves insufficient. Adds a dep;
  gate behind evidence.

E1 is the high-value floor; E2 is the bulk of the "Cursor-grade awareness" feel; E3/E4
are sharp, cheap wins; E5 is deferred.

### 6.3 File list
- New: `src/infra/repo-scan.ts` (impure: fs/git → `RepoFacts`), `src/core/repo-map.ts`
  (pure: rank + render), `test/unit/repo-map.test.ts`, `test/unit/repo-scan.test.ts`
  (or an injected-fs variant).
- Edit: `src/core/prompt-context.ts` (render ENVIRONMENT in `assembleContextBlocks` +
  optional posture line), `src/core/types.ts` (`environmentContext?`),
  `src/interface/menu.ts` (`resolveEnvironmentContext`, thread through `buildDeps`,
  resolve static facts once per session near `memoryProjectKey`),
  `src/infra/config.ts` (`codebaseAwareness?: boolean` kill-switch, additive),
  `src/core/capability-budget.ts` / shed table (add the env rung).
- Reconcile (no edit needed here): `docs/tab-completion-5.5.md` (@-grammar shared).

### 6.4 Test strategy (pure seams, no real fs/TTY)
Everything load-bearing is pure or dependency-injected, matching the existing
`prompt-context`/`intent` table-test style:
- **`rankRepoFiles`** — table: git-dirty files rank up; entry points rank up;
  high-fan-in files rank up; deterministic ordering; ignore-list excluded. Fixed
  `RepoFacts` input, no fs.
- **`renderRepoMap` / `renderEnvironmentBlock`** — fits the char budget; drops symbols
  before paths under pressure; stable formatting; empty/absent facts → `''`.
- **`detectReferencedProject`** — `"fix heyvera"` with no `heyvera/` → `unknown`;
  in-repo path → `in-repo`; sibling dir → `sibling`.
- **`resolveMentions`** — injected `readdir`/`readFile`; `@app/socials/page.tsx`
  resolves + caps the head; non-path `@foo` ignored; never throws.
- **`assembleContextBlocks`** — env block appears in the canonical position; absent →
  byte-identical to today (the existing seam invariant holds).
- **`repo-scan`** — small integration test over a temp git dir OR an injected exec/fs
  seam; assert fail-soft (`git` missing → facts still produced from fs alone).
- **Regression:** kill-switch off → no env block; the 6000-char backstop still caps.

### 6.5 Risks
- **Stale/wrong map misleads the model.** Mitigation: the map is explicitly an
  *orientation hint*; the model's own tools see live disk and self-correct; refresh
  dynamic bits per turn; keep symbols cheap-and-clearly-approximate.
- **Budget crowd-out.** A big repo's map could eat the context. Mitigation: producer
  self-caps (aider strategy), small default share, shed rung, the 6000 backstop.
- **Scan cost on huge monorepos.** Mitigation: `git ls-files` (tracked-only) bounds
  the set; cap files scanned; ignore hygiene; session cache + mtime digest so it's
  paid ~once. Never block the turn — fail-soft to "no map".
- **Replit/non-git dirs.** `git` may be absent or the dir not a repo. Mitigation:
  every git fact is optional; fall back to a plain fs tree rooted at cwd (the Replit
  workspace is exactly cwd per `state-dir.ts`).
- **Heuristic ranking is weaker than PageRank.** Accepted for v1; E5 seam exists if
  evidence demands it.
- **@-mention content injection cost (subscription-honest).** Slurping big files would
  bloat the turn. Mitigation: inject **path + short head** (or just the path when the
  provider has `Read`), cap size, never the whole file by default.
- **Drift between the @-completer and the @-resolver.** Mitigation: one shared
  `@`-token grammar imported by both.

### 6.6 Open questions for the user
1. **Symbols on day one, or paths-only?** Cheap regex symbol extraction (no
   tree-sitter) gives a richer map but is approximate. Ship E2 with symbols, or
   paths-only first and add symbols later?
2. **`@codebase` semantics:** confirm it should mean "inject the (bigger) deterministic
   repo map," NOT a search/embedding query — i.e. we are *reinterpreting* Cursor's
   `@codebase` as a map, not replicating its RAG.
3. **`@file` injection depth:** inject just the *resolved path* (cheapest; rely on the
   model's `Read`), a *short head*, or *full contents* for small files? Default
   proposed = path + short head; confirm.
4. **Map root = cwd or git root?** On Replit they coincide; elsewhere a monorepo
   subdir differs. Propose: git root when present, else cwd. (Same open-Q the tab doc
   raised for path completion — answer once, consistently.)
5. **Ranking aggression / scan caps:** what's the max files to scan/show, and do we
   ever cross `.gitignore` (e.g. to surface an untracked file the user just created)?
6. **Tree-sitter (E5):** is taking a tree-sitter dependency acceptable *if* heuristic
   ranking proves too weak, or is "no new heavy deps" a hard line?
7. **Land timing:** E1 (orientation block) is small and fixes the headline failure —
   ship it *with* the partner-posture fix, then E2–E4 as a fast follow?

---

## 7. Sources

Cursor / embedding indexing: [How Cursor indexes codebases fast](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast),
[Securely indexing large codebases (Cursor blog)](https://cursor.com/blog/secure-codebase-indexing),
[Cursor Merkle-tree indexing](https://undercodetesting.com/how-cursor-ide-uses-merkle-trees-for-efficient-code-indexing/),
[Cursor context management & @-symbols](https://datalakehousehub.com/blog/2026-03-context-management-cursor/).
Aider repo map (the no-embedding approach): [Repository map (docs)](https://aider.chat/docs/repomap.html),
[Building a better repo map with tree-sitter](https://aider.chat/2023/10/22/repomap.html),
[Repository Mapping System (DeepWiki)](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system).
Claude Code (agentic, no index): [Claude Code doesn't index your codebase](https://vadim.blog/claude-code-no-indexing),
[Claude Code best practices](https://code.claude.com/docs/en/best-practices),
[Why coding agents still use grep](https://yage.ai/share/why-coding-agents-still-use-grep-en-20260327.html).
Peers: [Continue.dev embeddings & repo-map provider](https://docs.continue.dev/customize/model-roles/embeddings),
[Continue context providers](https://docs.continue.dev/customize/deep-dives/custom-providers),
[Sourcegraph Cody leaving embeddings for native search](https://sourcegraph.com/blog/how-cody-provides-remote-repository-context),
[Copilot workspace context](https://code.visualstudio.com/docs/agents/reference/workspace-context),
[Windsurf remote indexing (Riptide)](https://docs.windsurf.com/context-awareness/remote-indexing).
