# myshell-tools 10/10 Actualization Checklist

**Status:** ACTIVE GÇö living checklist. Orchestrator + Grok agents execute until done.  
**Date opened:** 2026-07-09  
**Owner vision:** one chat to rule them all GÇö subscription-native elite partner CLI (Claude / Codex / Grok / OpenCode). OpenCode Go API key is the only intentional key exception. Not an API-key product.

**Operating mode (user-authorized 2026-07-09):**
- Grok / xAI agents implement (not Claude.md opencode/codex orchestrator rules).
- Work on feature branches GåÆ PR GåÆ **full green CI** GåÆ merge to `main`.
- Version bump + `npm publish` only after the checklist is done and green.
- Parallelize independent PRs; serialize only when file ownership overlaps.
- Online research + adversarial self-check before claiming done.
- No self-limiting: if something can be better and stays vision-aligned, do it.

**Related prior docs (do not re-litigate; implement):**
- `docs/vision-alignment-audit-2026-07-06.md`
- `docs/menu-build-spec-final.md`, `docs/PANEL-NAV-SPEC.md`, `docs/PHASE4-CONTROL-PANEL-SPEC.md`
- `docs/design-lag-watchdog-relaunch.md` (+ `phase6-lag-watchdog-build` work)
- `docs/grok-handoff-myshell-tools-actualization.md` (repo-chat / checkpoint spine)

---

## Product north star (acceptance bar)

A developer or vibe coder can open `myshell-tools` and:

1. **See truth** GÇö Effort Mode, accounts, goals, and status never lie.
2. **Never get stuck** GÇö every surface has visible escape/nav; legend teaches keys.
3. **Chat as the product** GÇö natural language drives plan, code, research, goals, parallel work.
4. **Feel modern** GÇö spacing, legend, responsive TUI (Claude Code / Warp / lazygit class).
5. **Stay reliable** GÇö lag self-heals; resume reopens conversation; partner engages parked goals.
6. **Subscription-native** GÇö Accounts inventory is truth; ambient CLI detect is not a home-screen story.

**Measurable done:** user can run a single Replit/local session and complete: change effort (box updates), open chat, see clear legend, cycle mode with Shift+Tab, open/close control panel without stuck state, type a message without eternal GÇ£ThinkingGÇªGÇ¥, see one goals surface + bottom recap, resume with partner addressing inactive goals, kill is not required for lag recovery.

---

## Locked product decisions (2026-07-09)

| Topic | Decision |
|-------|----------|
| Effort scopes | **Two dials:** global default for new convs (`m` on home); **per-conversation** via Shift+Tab in chat. Shift+Tab does **not** change global default. |
| Effort home UI | Effort box is **live** (reflects real config). No redundant GÇ£Effort Mode: XGÇ¥ confirmation line after select (or flash then disappear into the box). |
| Mode list keys | Display order is Budget=1 GÇª Auto=5; **keys must match** (`ALL_LEVELS` order). |
| Auto-detected block | **Remove** from mode switcher UI. Auto defaults from **Accounts** (myshell-managed), not ambient host detection marketing. |
| Spacing | 1 blank line before/after major home sections (Effort, Recent, Session Manager, controls). |
| Chat legend | Clustered, not edge-padded: e.g. `GåÉ menu -+ GçºTab mode -+ GåÆ panel -+ Esc interrupt`. |
| Goals chrome | **One** high-quality board; remove redundant strip OR merge into board. **Recap docks at bottom** (replacing lesser board position). |
| Resume partner | Open with short status + ask resume/drop/adjust for parked goals (not silent museum). |
| Thinking | State machine: prep phases honest (`Resuming` / `Routing` / GÇª); **Thinking** only when model is composing; then `Responding` / tool verbs. No eternal Thinking on submit. |
| Control panel | Always escapable; Tab sections discoverable; never a black hole. |
| Mouse | Keyboard perfect first; mouse click on menu rows / tabs / legend as P1 polish. |
| Primary env | Replit + local Windows both matter; lag watchdog is product, not GÇ£userGÇÖs problem.GÇ¥ |

---

## Checklist GÇö progress tracking

Legend: `[ ]` pending -+ `[~]` in progress -+ `[x]` done -+ `[-]` cut with reason

### Wave 0 GÇö Foundation / git hygiene
- [ ] Reconcile local `main` with `origin/main` (diverged 8 ahead / 4 behind as of open)
- [ ] Land this checklist on a branch and keep it updated every merge
- [ ] Baseline: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` green on base

### Wave 1 GÇö P0 Trust & feel (home + effort)  **GåÉ START**
- [ ] **P0.1** Dynamic Effort Mode box (header/footer reflect real mode + short description)
- [ ] **P0.2** Fix mode key mapping `[1]GÇô[5]` to match `ALL_LEVELS` (BudgetGÇªAuto)
- [ ] **P0.3** Remove `Auto detected:` block from mode switcher
- [ ] **P0.4** Drop/replace redundant confirmation line after mode change
- [ ] **P0.5** Home section spacing (Recent + Session Manager rhythm)
- [ ] **P0.6** Update unit tests locked to old Auto-only mockup / inverted keys
- [ ] Acceptance: pick Budget GåÆ home shows Budget; no Auto-detected dump; sections breathe

### Wave 2 GÇö P0 Chat navigation & partner chrome
- [ ] **P0.7** Redesign `BottomLegend` (clustered keys; control panel not exiled right)
- [ ] **P0.8** Shift+Tab cycles **conversation** Effort Mode; show current mode in legend or input chrome
- [ ] **P0.9** Empty-buffer `GåÆ` opens control panel; `GåÉ` back to menu (focus model documented + tested)
- [ ] **P0.10** Control panel: visible nav footer; Esc always closes; Tab/Shift+Tab sections; no stuck input
- [ ] **P0.11** Move crammed `ESC to exit` into modern legend/footer patterns on home
- [ ] Acceptance: new user can discover mode + panel without reading source

### Wave 3 GÇö P0 Thinking + goals + resume partner
- [ ] **P0.12** Thinking state machine (no optimistic eternal Thinking on submit)
- [ ] **P0.13** Single goals surface (keep best board quality; kill redundant mini-board)
- [ ] **P0.14** Recap at bottom (replace lesser board position)
- [ ] **P0.15** Goal board quality: state, progress, next action hint; not dual clutter
- [ ] **P0.16** Resume partnering: first orientation addresses parked/inactive goals
- [ ] Acceptance: type message GåÆ progressive honest status GåÆ response; resume talks about goals

### Wave 4 GÇö P1 Reliability & subscription truth
- [ ] **P1.1** Lag watchdog + relaunch + reopen conversation (finish/harden `phase6` work onto main)
- [ ] **P1.2** Accounts-only source of truth for Auto defaults / plan posture
- [ ] **P1.3** Mouse: clickable menu choices, panel tabs, legend hits (Ink)
- [ ] **P1.4** Control panel content honesty (real observed quota/cooldown or `unknown`; interactive settings that work)
- [ ] Acceptance: stale UI recovers without manual kill; Auto doesnGÇÖt invent host plans

### Wave 5 GÇö P1/P2 Elite partner depth (from handoff + vision)
- [ ] **P2.1** Checkpoint creation around real AI edits (if not fully landed after origin merge)
- [ ] **P2.2** Safe undo execution behind conflict gate (if not fully landed)
- [ ] **P2.3** NL test/verify + commit gates complete and honest
- [ ] **P2.4** Shared deps builder CLIGåömenu (reduce dual-product drift)
- [ ] **P2.5** Partner continuity: durable context / completion truth promoted only when real
- [ ] **P2.6** Parallel goal stewardship that acts (not just lists)
- [ ] **P2.7** Ghost text / local completions (history, paths, slash) if time
- [ ] Acceptance: chat-only repo ops feel safe and useful; partner anticipates next step

### Wave 6 GÇö Modern polish & ship
- [ ] **S.1** Visual polish pass (semantic color, density, modern shell menu research applied)
- [ ] **S.2** Manual smoke script / PTY smoke for Effort + legend + panel + thinking
- [ ] **S.3** README honest daily-use status updated
- [ ] **S.4** Full CI green on main (ubuntu/macos/windows)
- [ ] **S.5** Version bump (semver minor if UX ship; patch if fix-only) + CHANGELOG
- [ ] **S.6** `npm publish` ready (user confirms publish)
- [ ] Acceptance: Josh can `npm i -g myshell-tools@latest` and love the daily drive

---

## PR Plan (DAG for Grok execute-plan / parallel workers)

### PR 1: Live Effort Mode + correct keys + drop Auto-detected
- **Description:** Make Effort Mode box dynamic from config; fix `runModeSelect` key map to `ALL_LEVELS`; remove `renderAutoDetected` from mode UI; remove/replace redundant confirmation line; update tests (`menu-render`, `menu-flow`).
- **Files/components affected:** `src/interface/menu-render.ts`, `src/interface/menu-new-conversation.ts`, `src/interface/menu-settings.ts`, `src/interface/menu-auto-mode.ts` (optional keep helper), `test/unit/menu-render.test.ts`, `test/unit/menu-flow.test.ts`
- **Dependencies:** None
- **Acceptance:** Budget selection updates home box; keys 1GÇô5 match labels; no Auto-detected block

### PR 2: Home spacing + footer legend modernization
- **Description:** Section spacing around Recent / Session Manager; home ESC into cleaner footer; no vertical jumble.
- **Files/components affected:** `src/interface/menu-render.ts`, `src/interface/menu-new-conversation.ts`, nav-footer helpers, related tests
- **Dependencies:** PR 1 preferred (same files GÇö can merge into PR 1 if safer as single home UX PR)
- **Acceptance:** Visual separation matches modern TUI density

### PR 3: Chat legend + Shift+Tab conversation mode + panel keys
- **Description:** Redesign `BottomLegend`; implement Shift+Tab per-conversation mode cycle; empty-buffer arrow navigation; surface mode in chrome.
- **Files/components affected:** `src/interface/ui/BottomLegend.tsx`, `src/interface/ui/InputBox.tsx`, `src/interface/ui/App.tsx`, `src/interface/menu.ts` (mode cycle persist), tests under `test/ui/`, `test/unit/`
- **Dependencies:** None (parallel with PR 1 if file conflict avoided carefully)
- **Acceptance:** Legend teaches mode + panel; Shift+Tab changes conversation mode only

### PR 4: Control panel unstick + discoverability
- **Description:** Always-visible panel chrome footer; guaranteed Esc close; focus model; prevent input black hole; cluster help text.
- **Files/components affected:** `src/interface/ui/ControlPanel.tsx`, `src/interface/ui/App.tsx`, `src/interface/ui/control-panel-model.ts`, tests
- **Dependencies:** PR 3 (shared App/input focus)
- **Acceptance:** Open GåÆ Tab sections GåÆ Esc back to chat always works

### PR 5: Thinking state machine
- **Description:** Replace optimistic eternal Thinking; progressive honest labels; Thinking only for model response composition.
- **Files/components affected:** `src/interface/menu.ts` (`inkBeginTurn`), `src/interface/ui/reduce.ts`, `src/interface/ui/state.ts`, `src/interface/ui/StatusBlock.tsx`, `src/interface/render.ts`, tests
- **Dependencies:** None (parallel with PR 1GÇô2)
- **Acceptance:** Submit never shows 16s silent Thinking with no phase change

### PR 6: Single goals board + bottom recap + resume partnering
- **Description:** One goals surface; recap at bottom; resume message engages parked goals; board quality pass.
- **Files/components affected:** `src/interface/ui/App.tsx`, `StatusBlock.tsx`, `GoalQuickStrip.tsx`, recap path in `menu.ts`, goal board projection, tests
- **Dependencies:** PR 5 preferred (status layout)
- **Acceptance:** No dual mini-boards; recap bottom; partner mentions inactive goals on resume

### PR 7: Lag watchdog harden + merge
- **Description:** Bring `phase6-lag-watchdog-build` quality onto current main; recovery message; reopen conversation; no relaunch loops.
- **Files/components affected:** `src/interface/ui/mount.tsx`, `menu.ts`, watchdog modules, `docs/design-lag-watchdog-relaunch.md`, tests
- **Dependencies:** None (parallel early)
- **Acceptance:** Simulated stall recovers or honest relaunch; conversation reopens

### PR 8: Accounts-truth Auto + pressure honesty
- **Description:** Auto defaults from Accounts inventory; remove ambient detect from user-facing Auto story; keep doctor/internal detect if needed.
- **Files/components affected:** `menu-auto-mode.ts`, subscriptions, settings, tests
- **Dependencies:** PR 1
- **Acceptance:** 0 accounts GçÆ no fake Pro observed marketing on mode screen

### PR 9: Mouse support (optional wave)
- **Description:** Clickable rows/tabs/legend after keyboard solid.
- **Files/components affected:** Ink components, menu key path
- **Dependencies:** PR 3, PR 4
- **Acceptance:** Click Account / mode / panel works in capable terminals

### PR 10: Partner depth spine (handoff remainder)
- **Description:** Audit origin merge for checkpoint/undo/test gates; finish any gaps; NL partner quality.
- **Files/components affected:** repo-chat, checkpoints, menu wiring
- **Dependencies:** Wave 0 reconcile
- **Acceptance:** status/diff/undo/tests/commit behaviors match handoff honesty rules

### PR 11: Ship polish + version bump
- **Description:** README, CHANGELOG, smoke, version bump for publish.
- **Files/components affected:** `package.json`, `CHANGELOG.md`, `README.md`, smoke scripts
- **Dependencies:** PR 1GÇô10 as applicable
- **Acceptance:** Ready for `npm publish` after user confirm

---

## Parallelism matrix

| Safe parallel | Notes |
|---------------|-------|
| PR1+PR5+PR7 | Different primary concerns |
| PR3 alone or after PR1 | Shared chat UI GÇö careful |
| PR6 after PR5 | Layout coupling |
| PR8 after PR1 | Mode/Auto story |
| PR2 fold into PR1 | Same home render file GÇö prefer combine |

---

## Anti-patterns (never)

- Hardcoded Effort GÇ£Auto (smart)GÇ¥ after mode is dynamic.
- Claiming quota % without provider signal.
- Eternal Thinking spinner as fake life.
- Dual goals boards that say the same dead state twice.
- Ambient GÇ£Pro observedGÇ¥ when Accounts is empty.
- Merging red CI.
- Silent scope creep into Cortex/API-key product identity.
- Force-push to `main`.

---

## Session log

| Date | Event |
|------|--------|
| 2026-07-09 | Checklist authored from user UX audit + code autopsy + modern TUI research. Execution authorized with Grok agents; branch/PR/green/publish path. |
| 2026-07-09 | **Hygiene pause:** local/main had diverged (8 ahead / 4 behind origin). Merged into foundation. Opened **PR #118**. |
| 2026-07-09 | **PR cleanup:** Merged #90. Closed broken/superseded #110,#111,#112,#114,#116,#117. Rebuilt foundation as clean tip on origin/main (checklist + version only). |

---

## Orchestrator notes

- Re-read this file at session start; update checkboxes as PRs land.
- Prefer small reviewable PRs with tests over mega-diffs.
- When in doubt: user trust > feature count.
- End state: Josh daily-drives myshell-tools and does not want to open anything else for multi-subscription agent work.
