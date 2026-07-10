# myshell-tools — Active project board (orchestrator)

Last updated: 2026-07-10 (release **3.168.0** — forge depth, model ghost, polish, shared deps; main includes #153–#160)

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
| #149 | **P1.6** thin GitHub PR create (`gh pr create --fill`, gated) |
| #150 | Docs: note PR create on P1.6 partial progress |
| #152 | **P1.6** thin GitHub PR checks (`gh pr checks`, gated NL) |
| #153 | **P1.7** thin GitLab MR create (`glab mr create`, gated) |
| #154 | **P1.5** optional budgeted model ghost (default off) |
| #155 | **P1.7** thin GitLab CI status (`glab ci status`, gated NL) |
| #156 | **P1.6** thin GitHub PR review view (`gh pr view --comments`) |
| #157 | **P2.5–2.6** continuity + goal stewardship act slice |
| #158 | **P2.4** shared orchestrate deps builder slice 1 |
| #159 | **P1.8** honest other-forge / local-only degrade |
| #160 | **S.1** visual polish (density + semantic color) |

Package version **3.168.0** (this cut: #153–#160; Wave 7 was in **3.167.0**).

## Checklist honesty (2026-07-10)

| Item | Status | Notes |
|------|--------|-------|
| Wave 0–4 code | **done** | Human acceptance smokes still open |
| P2.1–2.3, P2.7 | **done** | Checkpoint/undo/verify; local ghost |
| P1.5 model ghost | **done** | optional budgeted ghost #154 (default off) |
| P1.6 GitHub depth | **partial** | status + create + checks + review view; richer workflows still open |
| P1.7 GitLab depth | **partial** | list + create #153 + CI status #155 |
| P1.8 other/local | **done** | honest degrade + forge identity #159 |
| P2.4 shared deps | **partial** | slice 1 #158 |
| P2.5–2.6 | **partial** | continuity + stewardship act slice #157 |
| Wave 7 absorb | **code done** | #142–#147 in 3.167.0; human smoke pending |
| S.1 visual polish | **done** | #160 |
| S.5 Version | **3.168.0** | cut includes #153–#160 |
| S.6 npm publish | **open** | npm `@latest` still older — user only |
| Acceptance smokes | **open** | Replit/local — code complete ≠ accepted |

## Open / in flight
(none — #153–#160 merged; this release cut)

## Next (priority)
1. **User smoke** post-**3.168.0** (prior 3.167.0 smoke + MR create, model ghost toggle, GitLab CI, PR review view, continuity chrome, other/local honesty, visual polish)
2. **`npm publish`** (user) for **3.168.0**
3. **P1.6** remaining richer GitHub PR workflows
4. **P1.7** remaining GitLab depth polish
5. **P2.4** further shared deps builder slices (tight contract)
6. **P2.5–2.6** deeper continuity / stewardship act

## Operating rules
- Branch from origin/main only
- Isolation worktree for parallel agents
- Pause agents before force-push base
- Merge only full green CI
- Checklist: docs/actualization-checklist-10of10-2026-07-09.md
