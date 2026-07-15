# External readiness plan — ship myshell-tools for real users

**Status:** ACTIVE — **code slices U0–U8/U10 landed on tip `3.174.0`**; remaining = **owner U12 human smoke + U13 publish**.  
**Started:** 2026-07-15  
**Baseline tip:** package **3.174.0** (PRs `#224`–`#226` + this release). npm `latest` may still lag until owner publish.  
**North star:** one chat to rule them all — vibe chat + flawless orchestration of the user’s authed provider accounts.

## Honest definition of “done” (external users)

“Fully ready for external users” means **all of the following**, not green CI alone:

| # | Bar | Owner |
|---|-----|--------|
| D1 | A stranger can install the **published** package (`npx` / `npm i -g`) and get **this tip’s** behavior (version match). | Owner publish |
| D2 | First-run path: detect CLIs, consent install/login prompts, land on home — no crash, no silent credential theft. | Code + human smoke |
| D3 | Single-provider chat works end-to-end (send, stream, durable draft/resume, honest errors). | Code + human smoke |
| D4 | Multi-account routing (when managed accounts exist): atomic lane, no ambient fallthrough, no silent cooling pick, probe used on **menu and detached** paths. | Code + tests + human smoke |
| D5 | Multi-chat: leave chat without killing other chats’ work; Esc → worker handoff; home Recent truthful; reopen honest (running/parked/orphan). | Code + hermetic smoke + human smoke |
| D6 | Effort + Speed dials match real behavior (no fantasy topology; native `--effort` either on or honestly experimental). | Code + copy |
| D7 | Packed install smoke green on win/mac/linux CI; actionable no-provider path. | Already largely true |
| D8 | Public docs (README + support matrix) match shipped behavior; no “current daily drive” lie vs npm. | Docs |
| D9 | Owner human smoke matrix signed off once; then publish. | Owner |

**Out of “must ship now” (post-ship polish, not blockers for 1.0-external):** full FG free-loop chrome parity with menu scheduler UI; full multi-OS interactive golden matrix in CI with live paid accounts; unlimited free-loop overnight autonomy without roadmap evidence.

---

## Checklist (execute top → bottom; parallel where noted)

### Phase 0 — Freeze truth (orchestrator)

- [x] **U0.1** This plan is the active external-ship sequence; ROADMAP points here.
- [x] **U0.2** Mark stale `actualization-wave-complete.md` residuals as historical vs tip.
- [x] **U0.3** README status line: tip version + honest “npm may lag until owner publish.”

### Phase 1 — One brain (critical path)

- [x] **U1** Detached/`worker` `productionDeps` use the same account enrich path as menu (`#224`).
  - receipt: `docs/receipts/u1-detached-account-parity.md`
- [ ] **U1b** (optional) CLI `run` path shares same enrich seam if still thinner than menu.

### Phase 2 — Honesty surfaces

- [x] **U2** README polish: dials, worker limits, publish lag.
- [x] **U3** `docs/SUPPORT-MATRIX.md`.
- [x] **U4** Native `--effort` stays **opt-in**; README/support matrix say so (default ship choice).

### Phase 3 — Prove journeys (hermetic first)

- [x] **U5** `npm run smoke:multichat` — 18 hermetic checks (`#225`).
  - receipt: `docs/receipts/u5-multichat-handoff-smoke.md`
- [x] **U6** Pack smoke remains real install-only; no fake golden-journey claim (documented in support matrix + receipts).

### Phase 4 — UX finish (bounded polish)

- [x] **U7** Accounts list status honesty (`formatAccountListStatus`; OpenCode fix) (`#226`).
- [x] **U8** Home Recent chip reopen honesty + regression test (`#226`).
- [ ] **U9** Optional: remaining dark surfaces copy audit (non-blocking for publish).

### Phase 5 — Release gate

- [x] **U10** Version bump **3.174.0** (this release).
- [x] **U11** Local `typecheck` + `smoke:packed` + `smoke:multichat` green on tip (full `quality` via CI on PR).
- [ ] **U12** Owner human smoke matrix (see below) — **required before recommend-to-friend**.
- [ ] **U13** Owner `npm publish` — agents never publish.
- [ ] **U14** Post-publish: verify `npm view myshell-tools version` matches tip; tag/release notes.

---

## Owner human smoke matrix (U12)

Run after green CI on the publish candidate. Real CLIs; no agent secrets.

| # | Scenario | Pass criteria |
|---|----------|----------------|
| H1 | `npx`/`npm i -g` candidate (or `npm link` pre-publish) | Starts, version correct |
| H2 | Fresh setup / detect | Offers install/login only with consent |
| H3 | One provider chat | Answer streams; draft survives leave/reopen |
| H4 | Second conversation | First chat goals keep working in-process |
| H5 | Esc with active goal | Worker claims; reopen shows work not silently lost |
| H6 | Two managed accounts (if you have them) | Route uses intended account; cooling account not silently picked |
| H7 | Effort + Speed change | Persist per conversation; Speed only affects multi-goal concurrency |
| H8 | No providers | Actionable refuse, exit non-zero |
| H9 | Accounts hub | List nav, rename, glance status sane |

---

## DAG / parallelization

```
U0 (docs) ─────────────────────────────┐
                                       ├─► U2, U3, U4 (docs honesty) ──► U10–U14
U1 (detached account parity) ──────────┤
                                       ├─► U5 (multichat smoke)
U7/U8 (UX polish) after U1 if free ────┘
```

**Serial blockers:** U13 after U1 + U11 + U12.  
**Independent now:** U0 docs, U1 code, U3 matrix draft, U5 design.

---

## Slice contracts (default)

Every code slice:

1. Name user-visible behavior + production call path.
2. Failing production-path test first.
3. Smallest coherent change.
4. Focused + affected tests green.
5. Receipt with command evidence.
6. No default-behavior surprise without calling it out.
7. No `npm publish`.

---

## Active queue (this session)

1. Land **U0** docs freeze.
2. Dispatch **U1** detached account parity (highest code leverage).
3. Dispatch **U3** support matrix + **U2** README honesty in parallel if capacity.
4. Gate merge U1 → plan U5 smoke.
5. Pause for owner **U12/U13** when code+docs gate is green.

---

## Non-goals this wave

- Second agent runtime / homemade reasoning engine.
- Subscription resale / OAuth brokerage.
- Merging abandoned two-dial feature branch wholesale.
- Live paid multi-OS CI matrix (human smoke covers; CI stays hermetic).
}
