# myshell-tools Kern Spec

**Status:** Canonical core specification (2026-07-06). Supersedes conflicting or outdated sections in older plans.  
**North Star:** "One chat to rule them all" — a single, provider-agnostic terminal chat/agent surface with elite-pro reliability, durable context, goal stewardship, and workspace-aware execution.  
**Scope:** The *Kern* (core runtime engine) of myshell-tools: the TUI/menu system, execution/orchestration loop, state & persistence layer, provider integration, reliability mechanisms, and the contracts that govern behavior.  
**Related (do not duplicate):**  
- `docs/menu-build-spec-final.md` — locked UI skeleton + slice plan (home menu, workspaces, effort mode).  
- `docs/ROADMAP-STATUS.md` + r7-item*-contract.md files — the 8 behavioral contracts (dark/default-off).  
- `docs/vision-alignment-audit-2026-07-06.md` — current drift and hardening requirements.  
- `docs/operating-protocol-10of10.md` + `CLAUDE.md` — dev process and agent roles.  
- `docs/design-lag-watchdog-relaunch.md` — reliability addition to the UI kern (just landed).  

## 1. Kern Definition & Invariants

The Kern is the minimal, reliable heart that makes every turn feel like a conscious senior partner:

- **Provider-agnostic chat surface** (claude, codex, grok, opencode, etc.).
- **Durable, reconstructible context** (not amnesia; workspace + history + taste + receipts).
- **Intent → plan → execution → verification → completion** with exactly-once and ask-vs-act judgment.
- **Multi-goal stewardship** with correction DAGs.
- **Resilient interactive UI** (Ink TUI with automatic recovery on lag/staleness).
- **Workspace fidelity**: conversations and execution are bound to a real workspaceRoot (git root or cwd), never lie about cwd.

**Hard invariants** (every slice and contract must preserve these or explicitly call them out):
- No user-facing behavior or help text advertises dark/unimplemented capability.
- Execution always respects the declared workspace (after CWD threading lands).
- ESC always exits the app from root; left-arrow is precise one-level back.
- All state mutations are receipted and reconstructible.
- Dark flags stay dark until hardened + user-gated + vision-audit approved.
- PTY/CI render and readiness are advisory only for the benchmark harness; real product paths must be deterministic.

## 2. Kern Architecture Layers

### 2.1 UI / Menu Kern (Ink surface)
Locked layout and behavior defined in `docs/menu-build-spec-final.md`.

Core pieces:
- `sectionBox()` + `titleBox()` rounded primitives (Slice 0, done).
- Effort Mode box (top, always visible; "Auto (smart)" is the smart default).
- Single Recent list (workspace-labelled only after honest cwd threading).
- Small centered `Session Manager` title box.
- Flat controls + `Choice: ▌` prompt.
- Workspace picker (fuzzy, current + recent + parents).
- Full navigation stack: ESC = exit from root; ← = pop one level.
- `!cmd` shell passthrough inside conversations (non-model).
- Doctor/Health removal from user surface (self-heal only).

**Current status (post-cleanup):** 
- Primitives (`sectionBox`, `titleBox`) landed (`src/ui/tui.ts`).
- Watchdog/relaunch infrastructure partially landed (heartbeat/sampler in `mount.tsx`, relaunch in `cli.ts`, `active-conversation` marker + state-layout support, usage in `menu.ts`).
- Home render skeleton (Slice 1 locked): `src/interface/menu-render.ts` implements the core locked structure (Effort Mode sectionBox, single Recent list, centered `Session Manager` titleBox, `Choice: ▌`, `ESC to exit`). Full controls, state-dependent variants, and integration with remaining slices are in progress per `menu-build-spec-final.md`.

### 2.2 Execution & Orchestration Kern
- `runChatLoop` / `orchestrate` (core/ orchestrate.ts and interface/menu.ts).
- Preflight (semantic, evidence, risk, budget).
- TurnPlan (authoritative, r7-item5).
- Intent continuity / correction DAG (r7-18).
- Ask-vs-act judgment (r7-19).
- Goal stewardship DAG (r7-13).
- Exactly-once + resume (r7-10).
- Provider registry + async startup (r7-12).

All contracts are currently **dark/default-off**. They are fully authored with eval gates, rollback plans, and receipts but have **no production implementation** yet.

### 2.3 State, Persistence & Context Kern
- Conversation store + meta (workspaceRoot, mode, intensity, recap, etc.).
- Durable context (r7-11) + CompletionResultV1 scaffolding (partial from prior work; see vision audit for hardening list).
- Taste ledger, memory, evidence sink/receipts.
- State layout + migration (archive conflicts must not alarm users).
- Active-conversation marker + relaunch handoff (new from phase6 watchdog).

**Key rule:** workspaceRoot is explicit and preserved. Legacy entries without it are treated as "global/unknown".

**Aider-style foundations internalized here:** The efficient deterministic repo map (symbols + ranking + budget accumulation, see `src/core/repo-map.ts`) and related orientation/context assembly are native Kern responsibilities. These evolved from historical "Aider-style" techniques but are now first-class, provider-agnostic capabilities owned by the Kern (no external Aider process required). Patch/apply layers (when hardened) follow the same pattern.

**Vendor-agnostic Kern (core invariant):** The Kern must work seamlessly with every vendor, whether accessed via OAuth/CLI subscription flows (e.g. claude, codex, grok using their native login) **or** API key (sk-) based access. opencode is special: both its subscription and API options are accessed via the opencode sk- API key. All other primary providers use their CLI OAuth for subscriptions. The Kern (provider registry, adapters, preflight, orchestrate, context, routing, watchdog) is fully provider-agnostic at the surface — it must support both auth models without assumptions. Detection, account selection, and execution adapt per vendor. Confirmed via src/providers/* and detect.ts. No hard requirement for "subscription-only" or "no sk-".

### 2.4 Reliability Kern (Watchdog + Relaunch)
See `docs/design-lag-watchdog-relaunch.md` (landed in merge b587030).

- Detects stale/unresponsive Ink UI while in conversation.
- Uses existing `ctx.relaunch` (re-exec with inherited stdio + argv).
- Persists `active-conversation` marker (under state-layout) so post-relaunch the exact conversation is reopened.
- Clean TTY teardown, no double-priming.
- Ink-only for v1 (legacy path has no persistent render loop to watch).

This is a core part of making the interactive Kern feel solid.

### 2.5 Provider & Routing Kern
- Multi-provider adapters (neutral by default).
- Model capability registry.
- Cost/ledger, call-budget, hedge/panel.
- Vendor-neutral routing + semantic preflight (dark flags).

## 3. Locked Decisions (Non-Negotiable)

From menu-build-spec-final + contracts + recent merges:
- Rounded boxes, exact home layout order, Effort Mode naming and copy.
- Workspace execution fidelity before any workspace-labelled UI ships.
- ESC/← navigation semantics.
- `!` passthrough.
- Doctor hidden from normal users.
- All 8 r7 contracts remain dark until full hardening + gates.
- Watchdog re-uses proven relaunch path; does not invent new spawn logic.
- PTY benchmark flakes are advisory (real product gates stay hard).

## 4. Current State (2026-07-06, main @ fff6042)

- Repo clean: single primary checkout after consolidation. Phase 6 watchdog + kern spec landed.
- "Aider" in the product: purely historical inspiration (see archive receipts and `repo-map.ts` comments). No `aider` binary or external tool integration exists at runtime. The Kern is the native evolution/replacement.

- Repo cleaned: only primary `myshell-tools/` checkout remains. All phase/safety/historical WIP branches pushed for preservation.
- Recent landing: Phase 6 lag-watchdog-build (recovery timing, active-conversation marker, relaunch + resume, new tests + design doc).
- Menu build: Slice 0 primitives shipped. Higher slices pending per the ordered plan (cwd threading is the critical dependency before exposing workspace UI).
- Contracts: All 8 authored + merged as docs. **Zero implementation code** in the Kern yet. All default-off + gated.
- Vision alignment: Several areas previously overstated (esp. durable completion in #99). Hardening list exists in the audit.
- CI: Green on main (per prior status; watchdog additions include new unit tests that passed post-fix).
- Operating model: Follows the strict protocol (orchestrator dispatches, independent verification, receipt-backed merges).

## 5. Implementation Roadmap (Kern-Focused)

Follow the dependency order in `menu-build-spec-final.md` for the UI portion of the kern.

Priority for the deeper Kern (contracts):
1. Item 17 (verification→completion) + 20
2. Item 11 (durable context)
3. Item 12 (provider registry + latency)
4. Item 10 (exactly-once)
5. Item 13 (goal stewardship)
6. Then 8k default-on (gated)
7. Items 18/19

Cross-cutting:
- Wire the new watchdog marker into conversation activation flows.
- Ensure every new slice updates the relevant golden/PTY/render tests and does not regress the locked mockups.
- Maintain bright line: orchestrator (this session or Claude) never hand-edits `src/` or `test/`.

## 6. Verification & Quality Bar

For any change touching the Kern:
- Full local gate: `typecheck && lint && knip && npm test && npm run test:contract && npm run build`.
- Golden render assertions for home skeleton (Effort Mode, Session Manager, Choice, ESC, no health/doctor).
- PTY smoke for the locked home flow.
- Workspace fidelity test (execution cwd == declared workspaceRoot).
- Watchdog: stale UI triggers clean relaunch + correct conversation resume.
- Contract slices: independent verifier receipt + north-star invariant check.
- Vision alignment: does not re-introduce theater (help text, dead code paths advertised as live, synthetic-only snapshots, etc.).

Definition of Done for a slice: green CI on all lanes + receipt-verified commands + matches locked spec + does not regress invariants.

## 7. Open Gaps & Hardening (from 2026-07-06 Audit)

See `docs/vision-alignment-audit-2026-07-06.md` for the full list. Top Kern-relevant items:
- CompletionResultV1 flag resolver + real wiring (not theater).
- Real durable event append + reconstruction from store (not synthetic).
- Patch-apply safety and no silent failures on already-applied edits.
- Help text and user-facing claims must match reality.
- Remove any remaining `%TMPF%` or root junk.
- CWD threading must be correct before any workspace UI claims.

## 8. How to Use This Spec

- New work on the menu/home/workspace surface → follow `menu-build-spec-final.md` slices exactly + update this doc if the kern model changes.
- New contract implementation → reference the specific r7-item contract + this spec for integration points (UI, state, watchdog, routing).
- Reliability or relaunch work → extend the watchdog design and keep the marker under state-layout.
- Any change: run the independent gate, produce command receipts, confirm vision invariants.

**This document is the living truth for the Kern.** Update it on every significant landing or contract evolution. Do not let prose in archive/ or older plans drift the implementation.

---

*Generated as part of post-consolidation handoff. Repo is now single-clean `myshell-tools/` on main with all historical work preserved on remote branches.*