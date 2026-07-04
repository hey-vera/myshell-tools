# myshell-tools — Session Handoff / Gameplan

_Last updated: 2026-07-03 (evening). This doc lets a fresh session continue without re-reading a long chat. Read it, then continue from "NEXT: Slice 1."_

## START HERE (you are the orchestrator, Sonnet 5)
- **Read first, in order:** `CLAUDE.md` (operating rules — how you work), this file (state + what's next), `docs/menu-build-spec-final.md` (the 12-slice build plan you're executing).
- **Your role:** orchestrator only. You dispatch, gate, and report — you do NOT implement. Frontier planning/audit → `codex -m gpt-5.5`; execution → `opencode-go` workers; Opus 4.8 only on the escalation triggers in CLAUDE.md. Bright line: never Edit/Write `src/` or `test/` yourself.
- **Definition of Done (enforced):** every PR must be green on all 8 CI lanes (now branch-protected on main), receipt-verified, and vision-aligned. You may auto-merge your own in-spec, all-green PRs (memory `merge-authorization-scoped`); behavior/release/schema changes ask the user.
- **The goal (north star):** "one chat to rule them all" — myshell-tools as a single, provider-agnostic terminal chat/agent surface. The active build makes the home menu + per-conversation workspaces real (see below).

## Shipped state (done, do not redo)
- **Published: `myshell-tools@3.162.0` is LIVE on npm** (`latest`). Main is green across all 8 CI lanes and now **branch-protected** (all lanes required before merge).
- **Operating rules hardened + installed (2026-07-03, #74/#76):** lean quota/bloat-gated `CLAUDE.md` (Sonnet-class orchestrator; Opus as escalation specialist; grounding-delegation; receipt-first returns; anti-drift; auto-parallel; 7-check memory gate; scoped auto-merge). Audit trail: `docs/rules-quota-audit-round1..3.md`. Dated model facts: `docs/model-routing.md`.
- **Menu build — Slice 0 DONE (#75 + lint hotfix #77):** `sectionBox()` + `titleBox()` rounded-box primitives in `src/ui/tui.ts` (+ tests). These are the building blocks for the home skeleton.
- Merged prior cycle: #68 BYPRODUCT_FALLBACK, #69 AUTO_SMART, #70 planning-depth flake fix, #71 env-aware rules, #72 PLANNING_DEPTH, #73 release 3.162.0.
- De-drift flags still **gated (need live validation, DO NOT promote blind):** SEMANTIC_PREFLIGHT_V1, SUBSCRIPTIONS, GOAL_STEWARD. Plus remove-dead flags behind SEMANTIC_PREFLIGHT, and MYSHELL_BASIC last.

## NEXT: Slice 1 — Home Render Skeleton
Execute `docs/menu-build-spec-final.md` → "Slice 1 - Home Render Skeleton, No Workspace Claims" via an opencode-go worker. It renders the locked layout (Effort Mode top box via `sectionBox`, one `Recent (...)` list, centered `Session Manager` `titleBox`, flat controls, `Choice: ▌`, `ESC to exit`) and updates the golden/PTY tests. Higher blast radius (render-string assertions) — gate on full CI-green before merge. Then continue slices in the spec's recommended order (2 → 3 → 4 → 5 → 6 → 7 → 9 → 8 → 10 → 11).

## Active initiative: Home-menu redesign + workspace-per-conversation + chat UX
Design docs (canonical): `docs/menu-home-redesign-audit.md`, `docs/menu-workspace-design-v3.md`. This handoff supersedes any conflicting mockups in those docs — the **locked layout is below**.

### LOCKED design decisions
1. **Home layout = a faithful clone of the data-tools/replit-tools skeleton.** Do NOT re-innovate structure. The skeleton, in order:
   1. **Top box, two sections** divided by `├─`. Section 1 explains **Effort Mode** (renamed from "mode"): `Effort Mode: <current>` + a one-line explanation. Section 2: `m = switch modes   Auto recommended`.
   2. **Recent (`<workspace>`):** ONE list (no "Recent in X" + "Other workspaces" split). Each row: `[n]  age  location  title  engine · effort`.
   3. **Small centered title box:** `Session Manager` (text centered INSIDE the box, box sized to text — not full-width, not bulky).
   4. **Flat controls list:** `[c] Continue last` (+ `└─ engine · title · age` sub-line), `[1-9] Open numbered above`, `[n] New`, `[e] Library`, `[a] Accounts`, `[q] Quit`.
   5. **`Choice: ▌`** prompt, then a dim footer.
   Reference ASCII (the target — match this flow exactly):
   ```
   ┌────────────────────────────────────────────────┐
   │ Effort Mode:  Auto (smart)                     │
   │ Picks the right effort each turn from task,     │
   │ risk, and provider headroom.                    │
   ├────────────────────────────────────────────────┤
   │ m = switch modes            Auto recommended    │
   └────────────────────────────────────────────────┘

   Recent (myshell-tools):
   [1] 12m  Menu workspace design        codex · auto
   [2] 3h   Fix auth refresh tests       claude · max
   [3] 40h  replit-tools · Port session  claude · auto

   ┌───────────────────────────┐
   │      Session Manager      │
   └───────────────────────────┘

   [c] Continue last
       └─ codex · Menu workspace design · 12m
   [1-9] Open numbered above
   [n] New conversation
   [e] Library / all conversations
   [a] Accounts
   [q] Quit

   Choice: ▌
   ESC to exit
   ```
2. **Box style: rounded `┌─┐`** across menu/session surfaces.
3. **Navigation model (product-wide):** `ESC` = exit myshell-tools to the shell; `←` (left-arrow) = back, a REAL back button that pops exactly one level from any depth (menu stack). **Root menu has NO back — only `ESC to exit`.** Drop Ctrl+C x2/x3 from UI copy.
4. **`!` shell passthrough:** inside a conversation, input whose first char is `!` (e.g. `!npm publish`) runs in the shell, not as chat. Print output inline; do not persist to the conversation log initially.
5. **Self-healing doctor / health:** DELETE the user-facing Doctor/Health surface. Startup self-heals silently (migrations, dedupe, gitignore, pricing cache, hook repair). The migration "conflict" the user saw is already handled correctly by `src/infra/state-migration.ts` (keeps active files, archives old) — stop routing it through `evaluateHealth()`, rename status to `complete-with-archive`, so it never shows. Surface a single calm inline line ONLY for a genuinely unavoidable user decision (state dir unwritable, or no provider signed in when starting). Keep a hidden `--fix` entry point for CI/support only.

### Workspace-per-conversation feature (build it all, ship together)
- Each conversation is bound to a **workspaceRoot** (git root inside a repo, else exact cwd), captured at creation, defaulted to the shell cwd.
- **New-conversation flow:** `[1] Current` (centered, shows the resolved absolute path; Enter = same as 1) / `[2] Pick…` opens a **fuzzy workspace picker** (fzf-style ranked list: current git root → workspaces from prior conversations → parent dirs; `Filter: ▌`; number to select). Back tucked bottom-left. No tree navigator in v1.
- Home Recent list is workspace-aware (location column; current workspace sorts first).
- **HONEST SCOPE (from codebase grounding):** metadata tagging + grouped recents ≈ 2–4h; polished picker ≈ 1–2 days; **fully correct folder-per-conversation EXECUTION is multi-day** because `ctx.cwd` must thread through repo-map, preflight, orchestrate deps, attachments, ledger, command-audit, evidence, verification, memory, and goals. Do NOT ship the workspace UI without the execution actually being scoped — that would be a lie. All-or-nothing.

### Chat-surface ideas (SEPARATE workstream; design after menu; Ink-path dependent)
1. **Jump-to-bottom:** on scroll-up, show a `↓ for bottom` hint; down-arrow jumps to latest. Only works in the **Ink full-screen TUI** path, not plain stdout streaming — confirm which path chat uses by default first.
2. **Response folding:** keep freshest ~3 responses expanded; older ones collapse to a 1-line title (start with first-line + `(N lines · HH:MM)`; AI titles later) + timestamp; expandable. Keyboard-primary (select `j/k`, `Enter` expand); mouse as a bonus where the terminal supports it. Ink-path only. This is a real multi-day feature (transcript folding/virtualization).

## Meta workstream: CLAUDE.md rules + memory governance to 10/10 — ✅ DONE (2026-07-03, #74/#76)
_Completed: 3-round research-backed adversarial audit → lean gated CLAUDE.md installed; memory trimmed/governed; scoped auto-merge + quality gate live; branch protection on. Details below are historical context only — do not redo. Switch the orchestrator to Sonnet 5 (`/model`) to realize the quota savings._

User wants the operating rules + auto-memory tuned for: quota efficiency, planning/execution efficiency, always-enforced memory-creation rules, and an anti-drift rule. Treat rule changes as SENSITIVE (they affect all future sessions) — research + propose, get user buy-in before rewriting. Research already done → `docs/rules-memory-10of10-plan.md` (top-5 changes incl. anti-drift rule, delegate-vs-inline + resume-vs-cold quota thresholds, mandatory memory schema/pre-write gate, capped adversarial rounds, trimming volatile provider/model/credential detail from always-loaded memory).

### Already DONE this session (memory governance)
- **Removed** the two memories written this session (`anti-drift-clone-reference`, `merge-authorization-dedrift`) and reverted their `MEMORY.md` index lines — the user objected (rightly) that they were written unilaterally. Re-add only what passes the governed rules, with explicit approval.
- **Installed a NON-BYPASSABLE memory-write gate:** `~/.claude/hooks/memory-write-gate.mjs` (Node; inspects only `tool_input.file_path`, normalizes slashes, matches the sanitized memory dir) wired via a `PreToolUse` Write|Edit hook in `~/.claude/settings.json` returning `permissionDecision:"ask"`. Verified by pipe-tests. **Activation:** user must open `/hooks` once or restart for it to load. Effect: any write to the memory dir now forces an explicit approval prompt.

### Anti-drift rule to add to CLAUDE.md (root cause of this session's menu churn)
When the user provides a reference design/artifact, CLONE its skeleton faithfully and apply ONLY the user's explicit diffs; never re-synthesize/re-innovate structure each round. Anchor to one reference, diff against it.

### Draft memory-admission ruleset (USER-APPROVED to live in CLAUDE.md + enforced by the hook)
A candidate memory must pass ALL: (1) Category fit — a standing rule or durable ref (user/feedback/project/reference); status/findings/plans/"current state" are REJECTED → go in repo. (2) Durability — still true+useful in a month. (3) Non-derivable — not already in code/git/CLAUDE.md/docs. (4) Concrete benefit — names HOW it helps a future session (workflow/quality/anti-drift/quota). (5) Not sensitive — no secrets/credentials/volatile model catalogs. (6) Explicitly sanctioned — user approved THIS memory (hook enforces). (7) Well-formed — frontmatter + [[links]] + a one-line MEMORY.md index entry.

### Auto parallel-orchestration rule (USER REQUESTED — add to CLAUDE.md)
The user should NOT have to explicitly ask for parallel workers — it must be AUTOMATIC when safe, choosing the safest path.
- **Default to parallelism when tasks are independent + safe.** "Safe" = independent subtasks, no shared-file write conflicts, reversible, non-outward-facing. Serialize only when there's a real dependency or shared-state/write conflict.
- **Fallback ordering (quota-guarded):** prefer **opencode-go parallel workers** (cheapest capable) for execution. If opencode is UNAVAILABLE, **PAUSE and ask the user** before spending gpt-5.5 (frontier) or Claude `Agent` worker quota — never silently escalate to the expensive path. (Ties to the existing rate-limit-trap warning.)
- **Model-capability reference (needs online research + memory):** build a durable reference of the actual models and WHEN/HOW to use each — opencode-go workers (cheap: deepseek-v4-flash, glm-5.1; stronger reasoners: deepseek-v4-pro, glm-5.2), frontier gpt-5.5, Claude Opus — with capability tiers and recommended effort/reasoning levels per task type. Enrich (do not duplicate) the existing `opencode-provider-access` memory. Research the models' real capabilities so the choice of model+effort is grounded, not guessed.

### NEXT SESSION (do this): adversarially harden + install the rules
1. Run a MULTI-ROUND adversarial design (one frontier drafts, another challenges, with the research doc) on: the memory-admission ruleset above, the quota/delegation thresholds, the anti-drift rule, AND the auto parallel-orchestration rule + model-capability reference (above).
2. Propose the final CLAUDE.md edits + the memory-schema to the USER for approval BEFORE writing them (user chose: rules live in CLAUDE.md AND the hook). Apply low-risk items first; hold sensitive ones (per the research doc's rollout order).
3. Only after approval, add the anti-drift + memory-admission + auto-parallel rules to CLAUDE.md, add the model-capability reference to memory (via the now-gated approval flow), and re-add any removed memory that passes the gate.

## Process notes / environment (durable)
- Orchestrator delegates: frontier (codex gpt-5.5) plans/designs/audits; opencode-go workers execute; orchestrator only gates + git. Design mockups belong in frontier docs, not re-invented inline (except fast visual convergence loops with the user).
- **No standing self-merge authorization is active** (the `merge-authorization-dedrift` memory was removed; this line previously asserted it in error). Ask before self-merging any PR until the user re-grants it via a governed authorization memory or current-turn approval. See `CLAUDE.md` §Source of Truth.
- codex & opencode CLIs work natively on this Windows box (`AppData\Roaming\npm`). Invoke via the Bash tool with `</dev/null` + `dangerouslyDisableSandbox:true`. `codex exec resume` needs options BEFORE the session id and rejects `-C`.
- Build phasing for the initiative: **build it all, ship together** (one larger release, likely 3.163.0). Nothing ships until the workspace execution threading is correct.

## Immediate next steps for the continuing session
1. Confirm the LOCKED home layout above with the user if any doubt; otherwise proceed.
2. Frontier: write the FINAL consolidated design+build spec anchored to the locked skeleton (home + new-conversation + picker + workspace threading + doctor removal + `!` passthrough), superseding v1–v5 drift. One ordered, per-file plan with blast radius.
3. Then opencode-go workers execute in reviewable slices; orchestrator gates each as a CI-green PR.
4. In parallel (safe): the rules/memory research → plan doc, for user review.
5. After menu ships + user live-validates: the chat-surface workstream, then the 3 gated flags in a supervised session.
