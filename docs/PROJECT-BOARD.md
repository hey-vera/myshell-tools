# myshell-tools — Active project board (orchestrator)

Last updated: 2026-07-10 (release **3.167.0** — Wave 7 absorb + thin forge create)

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
| #118–#141 | Actualization waves 0–6 core (see history) → **3.166.0** |
| #142 | Partner principles absorb plan (Wave 7 spec) |
| #143 | **W7.1** Built-in partner laws (prompt) |
| #144 | **W7.3** Account weight UX honesty + routing proof |
| #145 | **W7.2** Turn routing receipts |
| #146 | **W7.5** Goal rewatch+ (first-turn context) |
| #147 | **W7.4** Done=check binding |
| #148 | Docs: Wave 7 absorb complete on board/checklist |
| #149 | Thin GitHub PR create via NL when `gh` available |

Main tip includes #149. Package version **3.167.0**.

## Checklist honesty (2026-07-10)

| Item | Status | Notes |
|------|--------|-------|
| Wave 0–4 code | **done** | Human acceptance smokes still open |
| P2.1–2.3, P2.7 | **done** | Checkpoint/undo/verify; local ghost |
| P1.6 GitHub depth | **partial** | status NL #137; thin create #149; review still open |
| P1.7 GitLab depth | **partial** | thin `glab mr list` #140 |
| Wave 7 absorb | **code done** | #142–#147; human smoke pending |
| S.5 Version | **3.167.0** | cut includes Wave 7 + #149 |
| S.6 npm publish | **open** | npm `@latest` still older — user only |
| Acceptance smokes | **open** | Replit/local — code complete ≠ accepted |

## Open / in flight
(none — release cut pending merge)

## Next (priority)
1. **User smoke** post-**3.167.0** (Effort, Shift+Tab, legend/panel, goals+recap, resume rewatch, routing receipt line, Tab ghost, forge/`gh` PR status+create / `glab` MR list, undo, Accounts weight copy, partner laws behavior, lag recovery)
2. **`npm publish`** (user) for **3.167.0**
3. **P1.6** remaining GitHub depth: review / richer PR workflows
4. **P1.7–1.8** GitLab pipelines / other-forge honesty polish
5. **P1.5** optional budgeted model ghost (toggle; fail-soft)
6. **P2.4** shared deps builder CLI→menu (only with tight contract — large seam)
7. **S.1** visual polish

## Operating rules
- Branch from origin/main only
- Isolation worktree for parallel agents
- Pause agents before force-push base
- Merge only full green CI
- Checklist: docs/actualization-checklist-10of10-2026-07-09.md
