# BRUTAL VISION AUDIT: myshell-tools — 2026-07-05

**Auditor**: Frontier planner/auditor (gpt-5.5 high reasoning style)  
**Scope**: Full shipped reality vs. governing USER VISION ("one chat to rule them all" — npm tool, insane quota efficiency, Auto/smart DEFAULT truly elite out-of-box, "just chat", perfect orchestration/anti-bloat/anti-drift, professional scale ANY size, plug-and-play auth → chat, polished friction-free UX, goals visibility/scoping per chat).  
**Method**: Fast parallel grounding (grep, targeted reads ≤ key files, lists, prior audits, code evidence, live docs). + web research on competitors/benchmarks/routing/context (cited). Receipts-focused; no implementation.  
**Governing refs** (anti-drift): Claude.md, USER VISION skeleton, docs/model-routing.md, orchestrator-protocol.md, ROADMAP-STATUS.md, vision-alignment-5.6.md, rules-quota-*-round*.md, brutal-1/2/3, DE-DRIFT-AUDIT.md, perfect-orchestrator-audit.md, agent-orchestration-audit.md, quota-efficiency-audit.md, GOLDEN-PLAN.md, r7 contracts, GOLDEN receipts, CHANGELOG, README, src/ (esp. menu.ts, orchestrate.ts, auto-brain.ts, route.ts, goal-*, history.ts, verify.ts), interface/ui/*, providers/*, config.  
**Date context**: 2026-07-05 (opencode/codex quota volatile/out per model-routing). Current branch context noted in recent workspace/menu/threads slices.

**Brutally honest north star test**: Does the shipped product (or its active paths) EARN "Auto is default" by delivering elite pro results with minimal quota burn, coherence, and "just chat" experience? Or are vision elements aspirational/docs-only/partial/gated?

---

## Executive Summary

**Status**: Significant infrastructure progress (honest verify 4-states, history compaction, auto-brain rung fusion, conversation/workspace scaffolding, real provider detect/login, recent promotions of auto-smart/planning-depth, some default-on intelligence via experimental-default composition). CI green. But **core vision gaps are structural and material**.

- **Auto/smart DEFAULT does NOT yet "earn" its spot**. Recent (3.162) promotions made "Auto" a smart governor default (vs fixed preset), and experimental-default flips several layers on. But rung fusion, intent, classify, and governor are accreted; many high-value behaviors (panel, hedge, learned routing, native sessions, full goal stewardship, semantic preflight full binding) remain EXPERIMENTAL or DARK/default-off. "Truly smart out-of-box perfect performance" is aspirational.
- **"One chat to rule them all" is partial**. Monster central file (menu.ts ~5.6k+ LOC per prior + growth), accreted orchestrate.ts (~2k LOC), overlapping ask/plan/intent/engagement/directive layers. Durable r7 contracts (8 items including goal stewardship capstone) are **authored/merged but "NO implementation code yet" and explicitly DARK/default-off**. Not yet the coherent binding authority.
- **Quota efficiency**: Routing table + auto-brain + receipts exist and are honest. But learned (outcome) routing default-off; capability hard-requirements partial (esp. opencode); cross-vendor review/panel gated; volatile funding (opencode/codex exhausted same day per model-routing 2026-07-05) not abstracted away for users. Aider benches show 4x+ better token use on similar tasks.
- **Orchestration/coherence/anti-drift/anti-bloat**: History ~6k/12-turn compaction real. Work-state, intent, evidence receipts, verify honest in sequential path. But native sessions exp, r7 durable context/intent/ completion/ exactly-once **not implemented**, many paths drop capability/attachments, discovery is regex on own output. "Perfect orchestration" is protocol/docs, not fully shipped control plane.
- **Just chat + goals + scoping**: Conversations-first home (recent + per-conv mode), GoalQuickStrip for active goals visibility, workspace/recent/cwd threading design present. But goals often "clutter removed" to inside conv; steward audit surfaces but no full ownership/DAG per contracts; scoping partial.
- **UX/polish/plug-and-play**: Real detect (claude/codex/opencode), consent install/login flows, Ink TUI modern-ish, home/settings polished in recent redesign. Friction remains (first-turn latency from refreshes/recap/intent, opencode key prompts break "no API key" guardrail, menus in one file). Not "all menus polished, fully friction-free".
- **Professional scale**: Goals, decompose, scheduler (parallel default-on per some docs), planning depth promoted, long-horizon intent/goal paths. But parallel subgoals, full verification catching semantic issues, durable multi-goal DAG **not live**. Long-horizon still risks context rot/drift.
- **Claims vs code**: README/CHANGELOG/docs overpromise (cross-vendor always, native default-ish language, "insane efficiency", "perfect performance"). Brutal prior audits (1-3) + DE-DRIFT + vision-alignment documented the gaps; many persist or only partially addressed. "Get it right the first time" undermined by volatility and partials.
- **Risks high**: Complexity (centralized menu/orchestrate, 50+ env flags historically, accretion), provider sandbox/auth/volatile quota (explicit), Windows quirks (evidence, PTY, paths), doc bloat vs shipped, self-orchestrator meta (Claude.md rules vs product). SWE-bench ~76-95% but 8-20%+ semantic wrong/harness; Terminal-Bench <65% frontier on hard realistic; context rot real across models.

**Verdict**: Vision is the right north star and many organs (verify, auto-brain, goals scaffolding, routing honesty) are credible starts. But **shipped reality does not yet deliver "elite pro, Auto earns default, one coherent chat, insane efficiency"**. Much is infrastructure + gated experiments + aspirational docs. Prior self-audits were accurate; drift mitigation (DE-DRIFT, contracts) recognized the problem but implementation lag means vision remains largely future. **Not merge-ready for "default Auto pro experience" without major binding work**.

**Confidence**: High on code/docs evidence; research-backed on competitive gaps.

---

## Vision vs Reality (High-Level Table)

| Vision Pillar (governing) | Shipped Reality (receipts) | Gap |
|---------------------------|----------------------------|-----|
| npm tool, "one chat to rule them all", fully functional | CLI `myshell` / npx entry, Ink TUI control panel (conversations-first redesign 3.160), chat loop, providers (claude/codex/opencode/grok) | Partial: one surface exists but accreted (menu.ts monster + orchestrate layers). "Just chat" UX present but friction (latency, gated features). |
| Insane quota efficiency, intelligent convos minimal burn | Honest routing (route.ts, policy), auto-brain rung fusion (predict-and-commit, no self-conf), receipts/ledger, history compaction (~6k/12), some default-on intelligence | Major: learned routing default-off; panel/hedge quota multipliers gated but advertised as "no extra $"; Aider 4.2x more efficient in benches [web:2]; volatile funding not user-hidden. First-time-right not proven elite. |
| Auto (smart) mode is DEFAULT, truly smart, out-of-box plug-and-play perfect | resolveAutoMode + auto-brain (fuseRung) wired; recent 3.162 promoted auto-smart/planning to unconditional; experimental-default makes governor/verify/etc on by default composition | Partial earn: "smart" exists (rung from classify+byproduct+taste); but many smart behaviors gated (panel only hard-turns if enabled, native opt-in). Does not yet "deliver elite pro results" reliably first-pass. Not plug-and-play perfect. |
| Get it right first time, intelligent min quota, perfect orchestration/anti-bloat/anti-drift | Orchestrator protocol (docs), work-contract, evidence-sink, verify 4-state (unverified default, only green tests = passing), intent, history, some r7 contracts authored | Major gaps: r7 (durable context 11, exactly-once 10, completion 17, goal steward 13, intent continuity 18, ask-vs-act 19, etc.) = "NO implementation code yet", all DARK/default-off per ROADMAP-STATUS. Native sessions exp. Overlapping layers (engagement/turn-directive/vision-triage/intent). |
| Experience "just chat"; see active goals easily per chat; chat scoped to repo/folder | Conversations home (recent 7), per-conv mode, GoalQuickStrip.tsx (glyph/title/progress/state/agents), workspace-picker, cwd threading, goal board | Partial: goals visible in conv + strip; scoping design exists (workspace/recent/cwd). But home "goals no longer clutter", steward is audit-only (no full DAG ownership), not seamless "see active goals easily". |
| All menus polished, fully friction-free, modern | Ink/React TUI, recent home/settings redesign (conversations-first, simplified), provider status honest | Medium: polished direction but monster menu.ts (deps+chat+auth+render), key drop fixes recent, first-turn blocking calls (refresh+recap+intent+classifier). Not "all friction-free". |
| Plug-and-play: run → auth providers (detect/install/signin consent) → start chatting | npx first-run: detect (real spawn --version + auth status), consent install (claude/codex/opencode), login flows (incl container --code), drops to home | Real and functional for happy path. BUT opencode explicitly pushes API keys (brutal-3 guardrail FAIL: "no API keys"), some latency. Grok partial. |
| Professionally plan/actualize ANY size; long-horizon goals, parallel subgoals (default on), planning depth, verification catches semantic | Goals (draft, plan, objective, steward, scheduler, decompose, parallel per some claims), planning-depth promoted, verify honest sequential, semantic preflight (8k) gated | Major: parallel goals "default on" claims conflict with contracts ("all DARK"); full DAG/steward/evidence binding not implemented; verification strong on tests but semantic issues (per SWE research) not caught by harness alone. Long-horizon = context rot risk. |
| Competitive edge vs fragmented Claude/GPT shells | Positions as multi-provider router + subscription harness | Competitive reality: Aider git-native + token leader (4.2x vs Claude Code); Claude Code strong harness/leaderboard but context rot common complaint; Terminal-Bench <65% frontier; SWE-bench inflated by 6-20% semantic/harness wrongs. Routing hard (under/over-escalation). |
| Honest claims vs code (README/CHANGELOG/docs) | Some honest (receipts, verify states, volatility notes in model-routing) | Overclaims persist: "cross-vendor review", "native continuity", "smart parallel", "perfect", "insane efficiency" language vs gated/partial/exp code + prior brutal audits. |

---

## Deep Dives by Pillar

### 1. Current shipped reality vs. vision
- **Strengths**: Real multi-provider (detect spawns real CLIs, auth status real), chat loop + runTask orchestration, honest evidence/verify (src/core/verify.ts: "unverified | reviewed | passing | failing"; only green tests = passing), recent UI polish (conversations-first), auto-brain (src/core/auto-brain.ts: fuseRung pure predict-and-commit from byproduct/classify/memory), history compaction (src/core/history.ts: 6k/12), workspace/recent/cwd, goals scaffolding everywhere.
- **Gaps preventing "earn default"**: Auto is "smart" on paper (menu-auto-mode.ts resolveAutoMode + intensity/governor) but core smarts (panel for cross-vendor on hard, learned from ledger, native for fidelity, full semantic binding) opt-in or contract-not-impl. "Perfect performance" contradicted by Terminal-Bench <65%, SWE semantic ~20% wrong. Plug-and-play works but opencode key prompts + first-turn latency (capability refresh 10s timeout, recap, intent extract) break frictionless.
- Evidence: ROADMAP-STATUS: "All contracts DARK... NO implementation code yet". Prior brutal-1: multiple HIGH overclaims on capability routing, vision, directives.

### 2. Architecture & implementation quality
- **Red flags confirmed**: menu.ts (prior audit 5,682 LOC; still central owner of chat loop, deps assembly, auth, render, goal wiring, workspace — src/interface/menu.ts:4316+ for buildDeps etc.). orchestrate.ts ~2k LOC accretion (classify, route, intent, engagement, TurnDirective, work-state, panel/hedge branch, flagship, discovery, validators — see brutal-2).
- Central files: orchestrate.ts imports routing + many; menu wires everything. work-state.ts, goal-*.ts, route.ts, auto-brain.ts are focused but integrated via flags/contracts that are dark.
- Quality: Many pure modules (good, arch guards), honest receipts. But overlapping mechanisms (engagement/turn-directive/vision-triage/intent — brutal-2 calls "redundant and risky"). r7 contracts define the binding spine but unimplemented.
- Partial wins: history compaction, verify port abstraction, capability port.
- Evidence: brutal-2: "turn pipeline is no longer one pipeline; it is an accreting control stack". "orchestrate.ts and menu.ts have crossed the maintainability cliff".

### 3. Auto mode / smart defaults
- Exists: menu-auto-mode.ts resolveAutoMode (strongest provider kind wins), auto-brain.ts (Layer A fuseRung pure: byproduct route hint + classify floor + memory bias ±1; predict-and-commit on hard; Layer B objective escalation only). Wired to intensity/governor. 3.162 promoted auto-smart unconditional.
- experimental-default.ts: composition root makes governor/verify/judgment/taste/tribunal default-on (explicit opt-in still honored; basic/rollback off).
- But: panel/hedge/learned/native/g oal-steward etc. config default false or exp. Auto-brain "default-on via experimental..." per its header but many rungs/effects gated upstream. Not "truly smart... perfect performance" — relies on classify accuracy, byproduct quality; no learned calibration yet for normal users.
- "Rung fusion, intensity": real in auto-brain + capacity-allocator. But does not deliver "elite pro" consistently (research: even frontier agents fail planning/uncertainty).
- Evidence: config.ts: "EXPERIMENTAL (default off)" for native/panel/hedge/learned. ROADMAP: Item 8k (semantic) gated. auto-brain: "Default-on in production via experimentalEnabledByDefault".

### 4. Quota efficiency & routing
- **Good**: model-routing.md (detailed, dated, volatile notes explicit: "opencode-go funding VOLATILE... out of quota 2026-07-05", "codex hit usage limit", "smoke-verify before relying"; task→model table, effort matrix, Sonnet orchestrator, rework principle). auto-brain receipts. Honest ledger/evidence (no fabricated). router + classify + capability pre-pass in sequential.
- **Reality**: Learned routing (routing-memory.ts) requires ≥3 runs/2 providers, config default off, small bump. Capability hard-requirements partial for opencode (route.ts notes "real IDs not in pricing", placeholders). Panel/hedge multiply calls (quota/latency real despite "$0"). Cross-vendor review only on high/crit if enabled. First-time-right not measured beyond unit/eval; no live calibration.
- Funding volatility: docs note it; product does not gracefully abstract for user ("one chat" still hits walls).
- Competitive: Aider uses 4.2x fewer tokens than Claude Code on same tasks (Claude Code 479k avg vs Aider 105k) [web:2]. Claude Code 5.5x better than Cursor in some [web:1, web:3].
- Evidence: model-routing.md:1-100 (roles, notes 2026-07-05, table, opencode catalog). brutal-1: "cross-provider hard routing does not actually use OpenCode's dynamic capabilities". quota-efficiency-audit referenced in governing.

### 5. Orchestration/coherence/anti-bloat/anti-drift
- **Partial**: Durable context contracts (r7-item11 etc.) authored. history.ts compaction real (DEFAULT_MAX_CHARS 6000, 12 turns; planHistoryCompaction). work-state, intent continuity design, turn-directive, evidence-receipt, verify. Orchestrator protocol (docs/orchestrator-protocol.md) strong (dispatch contracts, event-driven, worktrees, never wait, verification before merge).
- **Gaps**: r7 items 10/11/13/17/18/19 "NO implementation code yet" + DARK (ROADMAP-STATUS). Native sessions (provider native resume) exp/default-off. Many paths omit attachments/web/capability (hedge, panel, review, REPL). Discovery = regex on model output (not independent). Overlapping "ask/act" layers. Anti-drift via contracts/DE-DRIFT but lag in impl.
- Context rot real industry problem (Chroma research: every model degrades with length; effective << claimed; "deletion not capacity") [web:0-9]; 6k compaction helps but long-horizon pro work exposes it.
- Evidence: DE-DRIFT-AUDIT: 56 actionable MYSHELL_* flags, many still off/PROMOTE pending. perfect-orchestrator-audit: "halfway right... too soft"; "LLM classifies; code supervises". vision-alignment-5.6: "right CONTROL SPINE, insufficient for 'elite pro'".

### 6. "Just chat" + goals visibility + scoping
- **Present**: Home = conversations (recent up to 7, per-conv mode/message count, provider status). GoalQuickStrip (active goals inline: glyph/title/progress/state/agents). workspace.ts, cwd threading, repo-identity, goal board (MYSHELL_BOARD promoted-ish). `/goal`, auto-stage, steward audit on open.
- **Gaps**: Home redesign "goals no longer clutter (surface inside conv)". Steward (r7-13) audit-only; full lifecycle/DAG/evidence ownership not impl (contract: "stale... not owned"). Scoping (workspace/recent/cwd) designed but not pervasive binding. Active goals "easy to see" via strip but not always prominent/polished in every view.
- Evidence: src/interface/ui/GoalQuickStrip.tsx (compact rows). menu.ts heavy goal imports/wiring. ROADMAP: Item 13 capstone DARK.

### 7. UX/menus/polish/friction
- **Direction good**: Ink TUI (App, Stream, StatusBlock, ControlPanel), recent redesign (3.160: conversations-first, simplified settings, per-conv modes). Provider auth in control panel. Decision prompts, post-turn. "Just chat" via readline/ink.
- **Friction**: menu.ts centralizes too much (buildDeps closure for everything). First-turn: capability refresh (opencode --verbose 10s), recap generator, intent extract, smart classifier (5-20s). Key drops fixed recently. Opencode setup tells user to paste API key (guardrail violation per brutal-3). Not all paths polished (REPL weaker).
- Plug-and-play: Strong for claude/codex (detect + consent + signin). Opencode always available but key path breaks "subscription-OAuth-only".
- Evidence: brutal-3: "OpenCode breaks the subscription-OAuth-only guardrail". config + menu-auto-mode for flows. README claims "zero install... drops you into home".

### 8. Professional scale
- **Organs**: goal-manager/steward/scheduler/decompose/plan/objective/todo (parallel claims), long-horizon via goals + autonomy, planning depth promoted, verify + evidence + trust receipts, semantic preflight (8k).
- **Gaps**: Parallel subgoals "default on" per docs/claims but contracts say DARK + no impl for full DAG. Verification catches test results honestly but not semantic (industry: 28% suspicious patches incorrect on SWE; 19%+ solved semantically wrong). No strong oracle for "polished, scoped, self-reviewed" delivery. Long-horizon exposed to rot/drift.
- Evidence: r7-item13 contract: narrow outcome, "does not build multi-goal autonomy before..." upstreams. Terminal-Bench: planning under uncertainty key failure; <65% [web:11].

### 9. Prior self-audits incorporation
- Brutal-1: HIGH issues on capability routing (opencode partial), web search not cross-provider, vision narrow, directives partial, learned dormant, discovery regex. Persist or only incrementally addressed.
- Brutal-2: Accretion, monster files (menu/orchestrate), overlapping mechanisms, routing layers. Confirmed.
- Brutal-3: Guardrail fail (opencode keys), latency > "one extra call", quota burners easy (effort/panel/hedge), spend uncertainty. Recent redesign helped UX but latency/guardrail issues live.
- DE-DRIFT: 56 flags; many PROMOTE pending (goal-steward, native, panel etc.); contracts recognize.
- vision-alignment-5.6, perfect-orchestrator, agent-orchestration, quota-efficiency: spine right but insufficient; model brain + code supervisor needed; routing/parallel risks. ROADMAP: contracts merged but DARK; 8k gated.
- Consistent pattern: honest self-audit trail, slow translation to shipped defaults/impl.

### 10. Competitive landscape (research-backed)
- **Aider**: Git-native, BYOK any model, strong token efficiency (4.2x fewer than Claude Code on identical tasks; 105k vs 479k avg) [web:2]. Real diffs, less context bloat via repo map.
- **Claude Code**: Strong harness, leaderboard presence, 5.5x token efficient vs Cursor in some tests (33k vs 188k) [web:1,web:3,web:5]. But context rot/degradation widely reported in long sessions ("gets dumber", "forgotten earlier", effective context 60-70% claimed) [web:0-9]. Subscription metering.
- **Codex CLI / Cursor / Continue / Cline / Roo**: Cursor IDE strong autocomplete; CLI agents vary. Terminal-Bench favors planning under uncertainty — frontier max ~63% (Codex+GPT-5.2) [web:11,web:13]. Many unsolved.
- **SWE-bench**: Top 76-95% (Claude Opus high, Gemini etc.) [web:15,web:19]. But reality: 7.8-11%+ "plausible" patches incorrect; 19.78% solved semantically wrong/harness hacks; context overflow 35%+ of strong model failures; graders flawed [web:16-18, web:21].
- **Routing research**: Hard (routing collapse over-escalation; under-escalation confident-wrong). Needs data for learned; context is poison [model-routing cites RouteLLM, Cluster-Route-Escalate]. Learned routing efficacy requires history; default-off here matches caution.
- **Implication**: Vision's "insane quota + one chat" competes in a space where simpler (Aider) wins efficiency, and even leaders suffer drift/semantic gaps on long-horizon. myshell's multi-sub + receipts honest differentiator, but not yet "earn default" superior.

Citations inline via web: ids from searches.

### 11. Honesty/claims vs code
- **README/CHANGELOG strong claims**: "insane quota efficiency", "truly smart", "perfect orchestration", "native session continuity (experimental, opt-in, default off)" vs code, "smart parallel goals (default on)", "cross-vendor adversarial review", "keeps going until done", "real advisor".
- **Code**: Matches some (honest verify, receipts, compaction, routing table). Diverges on defaults/gates (see config.ts explicit "EXPERIMENTAL (default off)" for panel/hedge/native/learned; r7 DARK; opencode key handling). Capability/vision/search routing narrower than claims (brutal-1).
- **Docs vs shipped**: Many plans/audits (GOLDEN, master, vision-align) describe future state. "Status: 3.2.0 honest..." in README; version in pkg 3.162. Prior audits repeatedly flag overpromising.
- Quote conflict: ROADMAP "ALL AUTHORED + MERGED" contracts vs "NO implementation code yet" + "DARK/default-off". README touts features that are config-gated.

### 12. Risks & Blockers
- **Complexity**: Monster files + accretion = high maintenance, regression risk (brutal-2). 50+ historical flags (DE-DRIFT).
- **Provider volatility**: Explicit in model-routing (2026-07-05 out of quota, hangs, codex sandbox blocks git/test). User "one chat" will hit walls; no seamless fallback hiding.
- **Windows quirks**: Evidence paths, PTY render (advisory gates), spawn EPERM in sandboxes, hardcoded paths (fixed some but surface).
- **Doc bloat vs polish**: Dozens of .md plans/contracts/audits; shipped UX still has friction.
- **Self-orchestrator meta**: Claude.md rules (no main-thread src edits, budget) vs product; hook enforcement gaps noted.
- **Default behavior risk**: Flipping more (8k, steward) without full binding/verification risks "confident but wrong" or quota surprises.
- **Semantic gaps**: Verify/tests honest but pro work needs more (industry data).
- **Blockers to vision**: r7 spine unimplemented (dependency order 17→11→...→13); learned routing dormant; full anti-drift contracts not live; Auto not proven "elite" first-pass.
- **Quota funding**: opencode/codex same-day exhaustion means real users see degraded experience.

---

## Research Backing (Key Facts, Cited)

- Token efficiency: Aider 4.2x fewer than Claude Code [web:2]; Claude Code 5.5x vs Cursor on task [web:1,3,5].
- Context rot: Every model degrades with length; effective context 60-70% claimed; deletion > stuffing [web:0,3,5,7,8]. Chroma study on 18 models; Google MRCR 77%→26% at 1M.
- SWE-bench: High 76-95% but 7.8%+ plausible wrong, 19-28% semantic/harness issues, graders flawed, context overflow major failure [web:16-18,21].
- Terminal-Bench 2.0: Frontier <65% (max ~63% Codex+GPT); 89 hard realistic CLI tasks; planning under uncertainty + error recovery key gaps [web:11-14].
- Routing: Two failure modes (collapse/over, under/confident-wrong); learned needs data [model-routing refs].
- Agent reality: Even top agents struggle long-horizon professional work beyond benchmarks.

---

## Specific Code/Doc Evidence (File:Line Receipts)

- menu.ts monster + central deps: src/interface/menu.ts (prior ~5682 LOC; buildDeps 4316+, chat loop 664+, goal wiring heavy).
- orchestrate accretion: src/core/orchestrate.ts (30+ imports; panel 854, hedge 881, review 1552, discovery 1934).
- Auto brain: src/core/auto-brain.ts:331 (fuseRung), 49 (default via experimental), 248 (Layer B objective only).
- Routing limits: src/core/route.ts:203 (opencode "we never re-rank arbitrary"), 297 (search "not detected").
- Config gates: src/infra/config.ts:67 (nativeSessions exp default off), 70 (panel exp off), 90 (hedge), 120+ (learned); 414 (some wired true but comments note intent).
- experimental default: src/interface/ui/experimental-default.ts:100 (default TRUE absent opt-out/rollback).
- Verify honest: src/core/verify.ts:39 (4 states), 162 (passing only green), 168 (unverified default).
- History: src/core/history.ts:30 (6k/12), 40 (planCompaction).
- Goal strip: src/interface/ui/GoalQuickStrip.tsx:1 (compact active goals).
- r7 DARK: docs/ROADMAP-STATUS.md:25 ("All contracts are DARK/default-off... NO implementation code yet").
- Goal contract: docs/r7-item13-goal-stewardship-contract.md:29 ("default remains off"), 40 (does not build autonomy pre-upstreams).
- Vision spine: docs/vision-alignment-5.6.md:20 ("right skeleton... not sufficient for elite pro").
- Opencode key: src/commands/login.ts:27 (tells create/paste API key); providers/detect.ts:153 (accepts api type).
- Volatility: docs/model-routing.md:10 ("opencode-go... out of quota 2026-07-05", "codex... usage limit", "hangs", "smoke-verify").
- Brutal prior: docs/audit/brutal-1-reality.md:1 (HIGH capability overclaims), brutal-2:1 (accretion), brutal-3:10 (guardrail FAIL).
- DE-DRIFT flags: docs/DE-DRIFT-AUDIT.md:20 (56 flags; goal-steward/MANAGER/NATIVE etc. PROMOTE pending).
- Competitive benches: see web searches above.

---

## Risks & Blockers (Prioritized)

1. **Unimplemented binding spine (r7 10/11/13/17/18/19)**: Blocks "perfect orchestration", durable anti-drift, goal ownership, exactly-once. Contracts exist but code doesn't.
2. **Auto does not yet earn default**: Smart rung exists but gated smarts + unproven first-pass-elite vs benchmarks mean users get "balanced" or surprises, not "plug-and-play perfect".
3. **Quota volatility + gated efficiency levers**: Learned/panel off; funding notes in docs but not hidden in UX. Real risk of degraded "one chat".
4. **Complexity/maintainability**: Central files + layers = future drift/regressions. Windows/provider quirks compound.
5. **Overclaims erode trust**: README/CHANGELOG vs partial code + brutal self-audits. Guardrail (opencode keys) violation.
6. **Semantic/professional gaps**: Tests honest but long-horizon pro work needs more than current verify + context limits.
7. **Context rot exposure**: Compaction helps; industry data shows it's fundamental; long goals will hit it.
8. **Self-governance vs product**: Claude.md strictness admirable but product must deliver for users.

---

## Recommendations (Prioritized, No Fixes Implemented)

**P0 (Vision blockers — surface + gate)**:
- Make r7 implementation the explicit next milestone (start with 17 completion + 11 durable context per dependency order). Do not flip more defaults until binding lands.
- Audit + promote (or clearly document) what "Auto default" actually delivers today vs gated. Earn it with measurable first-pass data.
- Fix opencode auth path to respect "no API keys" guardrail or remove the claim.

**P1 (Efficiency + defaults)**:
- Enable learned routing default (with history threshold) or remove the claim.
- Measure + surface real quota impact of panel/hedge (even if $0); default conservative.
- Strengthen capability routing for opencode dynamic models.

**P2 (Coherence/UX)**:
- Split menu.ts (chat-deps, settings, input). Reduce orchestrate accretion (one TurnPlan authority).
- Make active goals visibility consistent + prominent across views ("see easily per chat").
- Harden first-turn latency budget; background more (recap, refresh).
- Full anti-drift: implement key r7 contracts before claiming "perfect".

**P3 (Scale + polish)**:
- Verify semantic oracles beyond tests for pro delivery.
- Competitive bake-off receipts (Aider token comparison, Terminal-Bench style tasks).
- Continue DE-DRIFT promotions; kill remaining dark scaffolds.
- Windows + provider volatility hardening (graceful degradation, better user signals).

**General**: Treat USER VISION as reference skeleton + explicit diffs only. Update claims in README/CHANGELOG/docs to match shipped (or mark clearly "roadmap"). Use receipts for all future "done". Re-audit after any default flip or r7 land.

**Receipts for this audit**: Full report written to `docs/audit/brutal-vision-audit-2026-07-05.md`. Grounding from parallel reads/greps of Claude.md, model-routing.md, ROADMAP-STATUS.md, vision-alignment-5.6.md, brutal-1/2/3, DE-DRIFT, perfect-orchestrator, config.ts, auto-brain.ts, verify.ts, history.ts, GoalQuickStrip.tsx, menu.ts (patterns), orchestrate (patterns), r7-item13, CHANGELOG, README, providers/detect.ts, src/interface/ui/experimental-default.ts, web searches (Aider/Claude/Cursor/SWE/Terminal/context).

---

**End of audit artifact.** (No code changes; audit only. Conflicts with vision surfaced directly.)
