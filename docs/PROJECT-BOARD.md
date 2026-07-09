# myshell-tools — Active project board (orchestrator)

Last updated: 2026-07-09 (session, post-landing)

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

Main tip: see `git log origin/main -1`.

## Open / in flight
(none critical at last update — verify with `gh pr list`)

## Next queue (priority)
1. Wire live goalHints into ghost empty-prompt (App → InputBox) if not fully wired
2. P1.5 optional model ghost (budgeted, toggle)
3. P1.6–1.8 GitHub/GitLab workflow depth (`gh`/`glab`)
4. P1.1 lag watchdog harden
5. P1.2 accounts-only Auto truth
6. P1.3 mouse support
7. Checklist accuracy pass + version bump + npm publish when user ready

## Operating rules
- Branch from origin/main only
- Isolation worktree for parallel agents
- Pause agents before force-push base
- Merge only full green CI
- Checklist: docs/actualization-checklist-10of10-2026-07-09.md
