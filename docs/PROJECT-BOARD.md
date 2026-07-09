# myshell-tools — Active project board (orchestrator)

Last updated: 2026-07-09 (tip **3.165.0** cut)

## North star
One subscription-native chat to rule them all. Elite partner. Not API-key product.
Tab ghost-complete + auto-adaptive GitHub/GitLab/other/local mastery are locked requirements.


## Product truth (owner-corrected 2026-07-09) — do NOT drift

myshell-tools is **not** Claude Projects and must not become a "create project / paste brief / drop PDFs" product.

**What we are:**
- One chat that rules long-term development: plans, code, goals, research, parallel work — **built through conversation**, not pre-loaded brand kits.
- **Minimal effort, high output**: the partner digests context from the live workspace, chat history, goals, taste, memory, forge — user does not re-brief every morning.
- **Multi-concern by design**: many goals/tasks in parallel is a core superpower, not a smell. Isolation of concerns is *internal orchestration* (goal DAG, board, routing), not "one Claude Project per topic."

**What we steal from Claude Projects articles (principles only):**
- Standing preferences that persist (taste/rules/memory) without retyping
- Dense signal over junk context (curate what we inject; do not dump)
- Layered prefs (global vs workspace vs conversation) when they reduce friction

**What we reject:**
- Manual project-admin as the product (upload 20 files, write ROLE/NEVER templates to start)
- One-concern-per-workspace as a user-facing rule
- Bridging gaps by cloning web-chat product surfaces that fight the terminal agent vision

**Bar for any upgrade:** Does this make one-chat multi-goal daily drive better with *less* user effort? If not, cut.


## On main (this session — all green merges)
| PR | Summary |
|----|---------|
| #118 | Checklist + 3.164.0 |
| #119 | Clustered chat legend |
| #120 | Live Effort Mode + correct keys |
| #121 | Checklist progress P0.1–0.7 |
| #122 | Preparing → Thinking → Responding |
| #123 | Control panel nav / escape |
| #124 | Shift+Tab conversation Effort Mode |
| #125 | Wave 5b docs lock (Tab + forge) |
| #126 | Single goals board + recap dock |
| #127 | Resume partner goal orientation |
| #128 | Project board (v1) |
| #129 | Local-first ghost text + Tab accept |
| #130 | Forge context detector (GH/GL/local) |
| #131 | Docs: refresh board after #126–#130 |
| #132 | Wire board goalHints → empty-prompt ghost |
| #133 | Product truth: multi-goal one-chat, not Claude Projects |
| #134 | Accounts-only Auto truth (no ambient Pro theater) |
| #135 | Lag/stale UI watchdog relaunch harden |
| #136 | Docs: board + checklist sync after #132–#135 |
| #137 | GitHub PR status via NL when `gh` available |
| #138 | Optional mouse clicks (panel tabs + legend) |
| — | **3.165.0** release cut (this branch) |

Main tip at cut base: `034742f` (`#138` on `origin/main`). Release branch bumps package + changelog to **3.165.0**.

## Open / in flight
(none)

## Next (priority)
1. **User smoke** the 3.165.0 build (Effort box, Shift+Tab, legend/panel, goals+recap, resume, Tab ghost, forge/`gh` PR status, Accounts Auto, lag recovery, optional mouse)
2. **`npm publish`** (user does this — not agents)
3. **P1.5** optional budgeted model ghost (toggle; fail-soft; never blocks typing)
4. **P1.6–1.8** GitHub/GitLab/other workflow depth (`gh`/`glab` / honest degrade)
5. **P1.4** control panel content honesty (real quota/cooldown or `unknown`)
6. P2 partner-depth audit (checkpoints/undo/NL gates landed earlier — verify honesty vs checklist)

## Operating rules
- Branch from origin/main only
- Isolation worktree for parallel agents
- Pause agents before force-push base
- Merge only full green CI
- Checklist: docs/actualization-checklist-10of10-2026-07-09.md
