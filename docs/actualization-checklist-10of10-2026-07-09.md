# myshell-tools 10/10 Actualization Checklist

**Status:** ACTIVE → living checklist. Orchestrator + Grok agents execute until done.  
**Date opened:** 2026-07-09  
**Owner vision:** one chat to rule them all → subscription-native elite partner CLI (Claude / Codex / Grok / OpenCode). OpenCode Go API key is the only intentional key exception. Not an API-key product.

**Operating mode (user-authorized 2026-07-09):**
- Grok / xAI agents implement (not Claude.md opencode/codex orchestrator rules).
- Work on feature branches → PR → **full green CI** → merge to `main`.
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

1. **See truth** → Effort Mode, accounts, goals, and status never lie.
2. **Never get stuck** → every surface has visible escape/nav; legend teaches keys.
3. **Chat as the product** → natural language drives plan, code, research, goals, parallel work.
4. **Feel modern** → spacing, legend, responsive TUI (Claude Code / Warp / lazygit class).
5. **Stay reliable** → lag self-heals; resume reopens conversation; partner engages parked goals.
6. **Subscription-native** → Accounts inventory is truth; ambient CLI detect is not a home-screen story.

**Measurable done:** user can run a single Replit/local session and complete: change effort (box updates), open chat, see clear legend, cycle mode with Shift+Tab, open/close control panel without stuck state, type a message without eternal `"Thinking…"`, see one goals surface + bottom recap, resume with partner addressing inactive goals, kill is not required for lag recovery.

---

## Locked product decisions (2026-07-09)

| Topic | Decision |
|-------|----------|
| Effort scopes | **Two dials:** global default for new convs (`m` on home); **per-conversation** via Shift+Tab in chat. Shift+Tab does **not** change global default. |
| Effort home UI | Effort box is **live** (reflects real config). No redundant `"Effort Mode: X"` confirmation line after select (or flash then disappear into the box). |
| Mode list keys | Display order is Budget=1 → Auto=5; **keys must match** (`ALL_LEVELS` order). |
| Auto-detected block | **Remove** from mode switcher UI. Auto defaults from **Accounts** (myshell-managed), not ambient host detection marketing. |
| Spacing | 1 blank line before/after major home sections (Effort, Recent, Session Manager, controls). |
| Chat legend | Clustered, not edge-padded: e.g. `→ menu · →Tab mode · → panel · Esc interrupt`. |
| Goals chrome | **One** high-quality board; remove redundant strip OR merge into board. **Recap docks at bottom** (replacing lesser board position). |
| Resume partner | Open with short status + ask resume/drop/adjust for parked goals (not silent museum). |
| Thinking | State machine: prep phases honest (`Resuming` / `Routing` / →); **Thinking** only when model is composing; then `Responding` / tool verbs. No eternal Thinking on submit. |
| Control panel | Always escapable; Tab sections discoverable; never a black hole. |
| Tab complete | Claude Code–class **ghost text** in chatbox (Tab accept). Slash/path Tab already exists; ghost is the gap. |
| Forge mastery | Auto-adapt **GitHub / GitLab / other / local-only** — never GitHub-only muscle memory. |
| Mouse | Keyboard perfect first; mouse click on menu rows / tabs / legend as P1 polish. |
| Primary env | Replit + local Windows both matter; lag watchdog is product, not user's problem. |

---

## Checklist → progress tracking

Legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[-]` cut with reason

### Wave 0 → Foundation / git hygiene
- [x] Reconcile local `main` with `origin/main` (diverged 8 ahead / 4 behind as of open)
- [x] Land this checklist on a branch and keep it updated every merge
- [x] Baseline: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` green on base

### Wave 1 → P0 Trust & feel (home + effort)
- [x] **P0.1** Dynamic Effort Mode box (header/footer reflect real mode + short description)
- [x] **P0.2** Fix mode key mapping `[1]→[5]` to match `ALL_LEVELS` (Budget→Auto)
- [x] **P0.3** Remove `Auto detected:` block from mode switcher
- [x] **P0.4** Drop/replace redundant confirmation line after mode change
- [x] **P0.5** Home section spacing (Recent + Session Manager rhythm)
- [x] **P0.6** Update unit tests locked to old Auto-only mockup / inverted keys
- [ ] Acceptance: pick Budget → home shows Budget; no Auto-detected dump; sections breathe

### Wave 2 → P0 Chat navigation & partner chrome
- [x] **P0.7** Redesign `BottomLegend` (clustered keys; control panel not exiled right)
- [x] **P0.8** Shift+Tab cycles **conversation** Effort Mode; show current mode in legend or input chrome
- [x] **P0.9** Empty-buffer `→` opens control panel; `→` back to menu (focus model documented + tested)
- [x] **P0.10** Control panel: visible nav footer; Esc always closes; Tab/Shift+Tab sections; no stuck input
- [x] **P0.11** Move crammed `ESC to exit` into modern legend/footer patterns on home
- [ ] Acceptance: new user can discover mode + panel without reading source

### Wave 3 → P0 Thinking + goals + resume partner
- [x] **P0.12** Thinking state machine (no optimistic eternal Thinking on submit)
- [x] **P0.13** Single goals surface (keep best board quality; kill redundant mini-board) — #126
- [x] **P0.14** Recap at bottom (replace lesser board position) — #126
- [x] **P0.15** Goal board quality: state, progress, next action hint; not dual clutter — #126
- [x] **P0.16** Resume partnering: first orientation addresses parked/inactive goals — #127
- [ ] Acceptance: type message → progressive honest status → response; resume talks about goals

### Wave 4 → P1 Reliability & subscription truth
- [x] **P1.1** Lag watchdog + relaunch + reopen conversation (finish/harden `phase6` work onto main) — #135
- [x] **P1.2** Accounts-only source of truth for Auto defaults / plan posture — #134
- [x] **P1.3** Mouse MVP: panel tabs + legend clicks (#138). Menu-row mouse not required for this bar.
- [x] **P1.4** Control panel content honesty — real capacity/cooldown/session tokens via `capacity/sync`, explicit `unknown` for quota remaining/reset/allowance (Phase 4C; no fake %)
- [ ] Acceptance: stale UI recovers without manual kill; Auto doesn't invent host plans — **code complete; human smoke pending** (Replit/local)

### Wave 5 → P1/P2 Elite partner depth (from handoff + vision)
- [x] **P2.1** Checkpoint creation around real AI edits — post-success turn captures dirty-tree checkpoint (`captureAiEditCheckpoint` + menu wire)
- [x] **P2.2** Safe undo execution behind conflict gate + oversight/commandGate (`applyUndoActions`; preview-only when confirm seam absent)
- [x] **P2.3** NL test/verify + commit gates complete and honest (verify_only + commit behind commandGate/oversight)
- [ ] **P2.4** Shared deps builder CLI→menu (reduce dual-product drift)
- [x] **P2.5** Partner continuity: completion-truth chrome from real CompletionResultV1 (verified vs unverified · settle honesty); recap/orientation merge when present — #TBD (thin; no full r7 durable log rewrite)
- [x] **P2.6** Parallel goal stewardship that acts: post-turn board refresh + multi-goal stewardship act line (propose concrete next; never auto-mutate) + rewatch enrich — #TBD
- [x] **P2.7** Ghost text local-first landed (P0.17–P0.18 + #132 goalHints wire); optional model ghost remains **P1.5**
- [ ] Acceptance: chat-only repo ops feel safe and useful; partner anticipates next step — **code complete for P2.1–2.3; human smoke pending**


### Wave 5b — Tab ghost-complete + forge-adaptive mastery (USER LOCK 2026-07-09)

**1) Tab to complete (Claude Code–class ghost text)** — NOT the same as slash/path Tab.

Today: menu-completion.ts does **local** Tab for /commands, args, paths, @mentions only. Plain prose is intentionally a no-op. Vision docs already named ghost text; product bar is now **promoted**.

Target UX (chatbox):
- While typing (or on empty prompt), dim **ghost suggestion** appears inline after the caret text
- **Tab** accepts the ghost into the buffer; Esc / any other key dismisses or extends
- Layers (order of honesty / cost):
  1. Local-first: history prefix, slash trie, paths, recent cache, goal-aware empty-prompt next action (zero model)
  2. Optional budgeted model ghost (tiny, debounced, fail-soft, disableable) — never blocks typing
- Must work with Shift+Tab mode cycle without fighting (Tab = complete; Shift+Tab = mode)

- [x] **P0.17** Ghost text local-first in Ink InputBox (history + slash + path + empty-prompt goal hint) — #129 + #132
- [x] **P0.18** Tab accepts / Esc dismisses; debounce; never corrupt mid-sentence unless user accepts — #129
- [ ] **P1.5** Optional model ghost fallback (budgeted, settings toggle, subscription-native)
- [ ] Acceptance: feels like Claude Code terminal complete — Tab is muscle memory, not a slash-only power feature

**2) Auto-adaptive forge + local mastery** — one partner, four environments.

myshell-tools must be elite in:
1. **GitHub** (gh, PRs, issues, checks, branches, reviews)
2. **GitLab** (glab or API/CLI where available: MRs, pipelines, issues)
3. **Other forges** (Bitbucket/Gitea/Codeberg/self-host — detect remote; degrade gracefully with honest limits)
4. **Local-only** (no remote / offline / pure file work — still status/diff/edit/test/undo without forge theater)

Auto-adapt means: detect repo remotes + available CLIs (gh/glab/git), adapt language (PR vs MR), adapt commands and partner behavior, never pretend GitHub when remote is GitLab.

- [x] **P0.19** Workspace context detector: git root, remotes, host class (github|gitlab|other|none), available tools (gh/glab) — #130
- [x] **P0.20** Partner NL fluency per context (PR/MR/pipeline language; local-only honesty) — #130 (vocabulary + ENVIRONMENT merge; full workflow depth = P1.6–1.8)
- [~] **P1.6** GitHub workflow depth: **status** (#137 `gh pr status`) + **create** (#149 `gh pr create --fill`, gated). Checks/review still open.
- [~] **P1.7** GitLab workflow depth: **thin MR list** (`glab mr list` when GitLab+glab; honest PATH/host fallback). Pipeline/create depth still open.
- [ ] **P1.8** Other forge + pure local paths: no false gh; local file/git mastery remains first-class (detector + honest degrade partially covered by #130 + status handlers)
- [ ] Acceptance: open a GitHub repo, GitLab repo, random remote, and a non-git folder — partner *knows* which world it is in — **code complete for detect + thin status; human smoke pending**

### Wave 6 → Modern polish & ship
- [ ] **S.1** Visual polish pass (semantic color, density, modern shell menu research applied)
- [x] **S.2** Checklist smoke script (`npm run smoke:checklist`) — Effort/legend/panel/Library markers; fail-soft without TTY. Full PTY remains `smoke:pty*`.
- [x] **S.3** README honest daily-use status updated (3.165.0 multi-goal chat; not API-key product)
- [~] **S.4** Full CI green on main (ubuntu/macos/windows) — tip **3.166.0** green at absorb open
- [x] **S.5** Version bump + CHANGELOG — **3.166.0** cut (#141); prior **3.165.0** (#139)
- [ ] **S.6** `npm publish` ready (user confirms publish)
- [ ] Acceptance: Josh can `npm i -g myshell-tools@latest` and love the daily drive — **human publish + Replit smoke pending**

### Wave 7 → Partner principles absorb (Fable-class; not loop clone)
Spec: `docs/partner-principles-absorb-2026-07-09.md`

- [x] **W7.1** Built-in partner laws (prompt): done=check, anti-goldplate, anti-overplan, grounded claims — #143
- [x] **W7.2** Turn routing receipts: provider · model · effort · account? · why (actual run) — #145
- [x] **W7.3** Account weight UX honesty: within-provider seat balance; proof routing uses weights — #144
- [x] **W7.4** Done=check binding: doneCondition + goal/terminal settle cannot skip verify on claimed done — #147
- [x] **W7.5** Goal rewatch+: first-turn model context inject for standing goals (resume print kept) — #146
- [ ] Acceptance: one chat shows *who/why*, never greeds max effort silently, never settles done without check, re-engages parked goals — **code complete; human smoke pending**

---

## PR Plan (DAG for Grok execute-plan / parallel workers)

### PR 1: Live Effort Mode + correct keys + drop Auto-detected
- **Description:** Make Effort Mode box dynamic from config; fix `runModeSelect` key map to `ALL_LEVELS`; remove `renderAutoDetected` from mode UI; remove/replace redundant confirmation line; update tests (`menu-render`, `menu-flow`).
- **Files/components affected:** `src/interface/menu-render.ts`, `src/interface/menu-new-conversation.ts`, `src/interface/menu-settings.ts`, `src/interface/menu-auto-mode.ts` (optional keep helper), `test/unit/menu-render.test.ts`, `test/unit/menu-flow.test.ts`
- **Dependencies:** None
- **Acceptance:** Budget selection updates home box; keys 1→5 match labels; no Auto-detected block
- **Status:** landed (#120)

### PR 2: Home spacing + footer legend modernization
- **Description:** Section spacing around Recent / Session Manager; home ESC into cleaner footer; no vertical jumble.
- **Files/components affected:** `src/interface/menu-render.ts`, `src/interface/menu-new-conversation.ts`, nav-footer helpers, related tests
- **Dependencies:** PR 1 preferred (same files → can merge into PR 1 if safer as single home UX PR)
- **Acceptance:** Visual separation matches modern TUI density
- **Status:** landed with home UX wave (#119–#120)

### PR 3: Chat legend + Shift+Tab conversation mode + panel keys
- **Description:** Redesign `BottomLegend`; implement Shift+Tab per-conversation mode cycle; empty-buffer arrow navigation; surface mode in chrome.
- **Files/components affected:** `src/interface/ui/BottomLegend.tsx`, `src/interface/ui/InputBox.tsx`, `src/interface/ui/App.tsx`, `src/interface/menu.ts` (mode cycle persist), tests under `test/ui/`, `test/unit/`
- **Dependencies:** None (parallel with PR 1 if file conflict avoided carefully)
- **Acceptance:** Legend teaches mode + panel; Shift+Tab changes conversation mode only
- **Status:** landed (#119, #124, #123)

### PR 4: Control panel unstick + discoverability
- **Description:** Always-visible panel chrome footer; guaranteed Esc close; focus model; prevent input black hole; cluster help text.
- **Files/components affected:** `src/interface/ui/ControlPanel.tsx`, `src/interface/ui/App.tsx`, `src/interface/ui/control-panel-model.ts`, tests
- **Dependencies:** PR 3 (shared App/input focus)
- **Acceptance:** Open → Tab sections → Esc back to chat always works
- **Status:** landed (#123)

### PR 5: Thinking state machine
- **Description:** Replace optimistic eternal Thinking; progressive honest labels; Thinking only for model response composition.
- **Files/components affected:** `src/interface/menu.ts` (`inkBeginTurn`), `src/interface/ui/reduce.ts`, `src/interface/ui/state.ts`, `src/interface/ui/StatusBlock.tsx`, `src/interface/render.ts`, tests
- **Dependencies:** None (parallel with PR 1→2)
- **Acceptance:** Submit never shows 16s silent Thinking with no phase change
- **Status:** landed (#122)

### PR 6: Single goals board + bottom recap + resume partnering
- **Description:** One goals surface; recap at bottom; resume message engages parked goals; board quality pass.
- **Files/components affected:** `src/interface/ui/App.tsx`, `StatusBlock.tsx`, `GoalQuickStrip.tsx`, recap path in `menu.ts`, goal board projection, tests
- **Dependencies:** PR 5 preferred (status layout)
- **Acceptance:** No dual mini-boards; recap bottom; partner mentions inactive goals on resume
- **Status:** landed (#126, #127)

### PR 7: Lag watchdog harden + merge
- **Description:** Bring `phase6-lag-watchdog-build` quality onto current main; recovery message; reopen conversation; no relaunch loops.
- **Files/components affected:** `src/interface/ui/mount.tsx`, `menu.ts`, watchdog modules, `docs/design-lag-watchdog-relaunch.md`, tests
- **Dependencies:** None (parallel early)
- **Acceptance:** Simulated stall recovers or honest relaunch; conversation reopens
- **Status:** landed (#135)

### PR 8: Accounts-truth Auto + pressure honesty
- **Description:** Auto defaults from Accounts inventory; remove ambient detect from user-facing Auto story; keep doctor/internal detect if needed.
- **Files/components affected:** `menu-auto-mode.ts`, subscriptions, settings, tests
- **Dependencies:** PR 1
- **Acceptance:** 0 accounts → no fake Pro observed marketing on mode screen
- **Status:** landed (#134)

### PR 9: Mouse support (optional wave)
- **Description:** Clickable rows/tabs/legend after keyboard solid.
- **Files/components affected:** Ink components, menu key path
- **Dependencies:** PR 3, PR 4
- **Acceptance:** Click Account / mode / panel works in capable terminals
- **Status:** landed (#138) — panel tabs + legend MVP; menu-row mouse not required

### PR 10: Partner depth spine (handoff remainder)
- **Description:** Audit origin merge for checkpoint/undo/test gates; finish any gaps; NL partner quality.
- **Files/components affected:** repo-chat, checkpoints, menu wiring
- **Dependencies:** Wave 0 reconcile
- **Acceptance:** status/diff/undo/tests/commit behaviors match handoff honesty rules
- **Status:** P2.1–2.3 landed on complete-checklist-wave (checkpoint capture + undo apply + verify/commit gates)

### PR 11: Ship polish + version bump
- **Description:** README, CHANGELOG, smoke, version bump for publish.
- **Files/components affected:** `package.json`, `CHANGELOG.md`, `README.md`, smoke scripts
- **Dependencies:** PR 1→10 as applicable
- **Acceptance:** Ready for `npm publish` after user confirm
- **Status:** S.5 done (3.165.0 #139); S.2 checklist smoke + S.3 README honesty on this wave; S.6 user publish

---

## Parallelism matrix

| Safe parallel | Notes |
|---------------|-------|
| PR1+PR5+PR7 | Different primary concerns |
| PR3 alone or after PR1 | Shared chat UI → careful |
| PR6 after PR5 | Layout coupling |
| PR8 after PR1 | Mode/Auto story |
| PR2 fold into PR1 | Same home render file → prefer combine |

---

## Anti-patterns (never)

- Hardcoded Effort `"Auto (smart)"` after mode is dynamic.
- Claiming quota % without provider signal.
- Eternal Thinking spinner as fake life.
- Dual goals boards that say the same dead state twice.
- Ambient `"Pro observed"` when Accounts is empty.
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
| 2026-07-09 | **User lock:** Tab-to-complete ghost text (Claude Code class) + auto-adaptive GitHub/GitLab/other/local mastery added as Wave 5b (P0.17–P1.8). |
| 2026-07-09 | **#118** green+merged (checklist+3.164.0). **#119** legend green+merged. **#120** Effort Mode green+merged after knip fix. Closed broken #110-117. |
| 2026-07-09 | **#121** checklist progress. **#122** thinking phases. **#123** control panel. **#124** Shift+Tab mode. **#125** Wave 5b docs lock. |
| 2026-07-09 | **#126** single goals board + bottom recap (P0.13–15). **#127** resume partner goals (P0.16). **#128** project board. **#129** local ghost Tab (P0.17–18). **#130** forge detector (P0.19–20). **#131** board docs refresh. |
| 2026-07-09 | **#132** goalHints → empty-prompt ghost. **#133** product truth (not Claude Projects). **#134** Accounts-only Auto (P1.2). **#135** lag watchdog harden (P1.1). Main tip `98e6d35`. |
| 2026-07-09 | Docs sync: project board + checklist checkboxes through #135; mojibake fixed. |
| 2026-07-09 | **#137** gh PR status NL. **#138** mouse MVP (panel tabs + legend). **#139** release 3.165.0. |
| 2026-07-09 | **complete-checklist-wave:** honesty audit (P1.3/1.4/S.5 done; P1.6 status partial; P2.1–2.3 wired; P1.7 thin glab; S.2 smoke; S.3 README). Acceptances remain human Replit smoke. |

---

## Orchestrator notes

- Re-read this file at session start; update checkboxes as PRs land.
- Prefer small reviewable PRs with tests over mega-diffs.
- When in doubt: user trust > feature count.
- End state: Josh daily-drives myshell-tools and does not want to open anything else for multi-subscription agent work.
