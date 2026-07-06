# Brutal Reality Audit: myshell-tools 3.14-3.24

Scope: `CHANGELOG.md` 3.14 through 3.24, plus the 5.5/5.6/5.7 docs, checked against the implementation. This audit treats changelog summaries and quality stamps as claims, not evidence.

## 1. HIGH - OpenCode capability refresh is real, but cross-provider hard routing does not actually use OpenCode's dynamic capabilities

**Claim:** 3.23 says OpenCode verbose refresh now populates real context/vision/tool-call/variant facts, and cross-provider routing enforces vision/large-context hard requirements across providers. `CHANGELOG.md:40-68`

**What is true:** The refresh plumbing exists. The production port runs `opencode models --verbose` and returns stdout fail-soft. `src/infra/model-capability-port.ts:55-92` The refresh layer merges that OpenCode verbose output into the registry. `src/core/model-capability-refresh.ts:226-240` OpenCode can also receive `--variant` once it has already been selected. `src/providers/opencode.ts:90-110`

**What is not true:** The cross-provider pre-pass cannot see arbitrary real OpenCode model IDs from that dynamic registry. The hard-requirement path calls `knownSatisfies`, which builds candidates through `candidateModelsFor`. `src/core/route.ts:314-387` For OpenCode, `candidateModelsFor` explicitly says real IDs are not in the pricing table, returns the placeholder set, and "we never re-rank arbitrary opencode ids." `src/core/route.ts:203-213`

**Verdict:** Misleading. OpenCode self-awareness and within-provider selection improved, but the big cross-provider promise is only partly live. A vision or large-context turn can still fail to prefer OpenCode based on the very dynamic facts 3.23 claims were made routable.

## 2. HIGH - Web search is an adapter flag, not a routing capability

**Claim:** 3.23 says provider capability utilization now invokes native Codex web search and routes by capability fit. `CHANGELOG.md:40-68`

**What is true:** The engagement planner can mark a turn as `WEB_RESEARCH`. `src/core/orchestrate.ts:518-525` Sequential requests carry `webSearch`. `src/core/orchestrate.ts:1146-1165` Codex maps that to `tools.web_search=true` when supported. `src/providers/codex.ts:92-131`

**What is not true:** Search need does not trigger cross-provider routing to Codex. The route pre-pass explicitly says search is not detected from task signals. `src/core/route.ts:297-298` The provider port also documents that Claude and OpenCode ignore `webSearch`. `src/providers/port.ts:65-74` Default provider order remains Claude-first for all normal tiers. `src/infra/config.ts:190-194`

**Verdict:** Overclaimed. Search is real if the already-selected provider is Codex. It is not a reliable "needs current info, therefore route to Codex search" behavior.

## 3. HIGH - Image vision is live in the happy path, but not tool-wide

**Claim:** 3.23 says image attachments flip `needsVision`, trigger hard routing to vision-capable models, and are forwarded through Codex/OpenCode. `CHANGELOG.md:54-68`

**What is true:** Chat menu and one-shot run resolve image attachments. `src/interface/menu.ts:4898-4906` `src/cli.ts:499-507` Sequential orchestration marks `needsVision` from attachments. `src/core/orchestrate.ts:796-852` Sequential provider requests include attachments. `src/core/orchestrate.ts:1146-1165` Codex and OpenCode map those attachments to CLI flags. `src/providers/codex.ts:116-125` `src/providers/opencode.ts:99-108`

**What is not true:** This is not uniform across the product. REPL passes raw lines to `runTask` without per-turn attachment resolution. `src/interface/repl.ts:96-105` Hedge routing does not pass `capabilityContext`, and hedge provider requests omit attachments and web search. `src/core/hedge.ts:210-221` `src/core/hedge.ts:282-303` Panel routing also omits `capabilityContext`, attachments, and web search. `src/core/ensemble.ts:390-400` `src/core/ensemble.ts:437-449` Review requests omit attachments and web search as well. `src/core/orchestrate.ts:1664-1671`

**Verdict:** Real but narrower than advertised. Vision works in sequential chat/run. It is latent or dropped in REPL, hedge, panel, and review paths.

## 4. HIGH - TurnDirective enforcement is partial; much of "adaptive-partner-v2" remains prompt/control text

**Claim:** 3.19 says TurnDirective moved from advisory prompt text to enforced runtime behavior. 3.22 says adaptive-partner-v2 is complete, with each stage real-run-verified. `CHANGELOG.md:154-180` `CHANGELOG.md:69-98`

**What is true:** Terminal questions can short-circuit before provider execution. `src/core/orchestrate.ts:686-711` Generic open-menu output is quarantined from history. `src/core/orchestrate.ts:773-781` Generic/grounded validators can trigger one repair retry. `src/core/orchestrate.ts:1290-1326`

**What is not true:** The directive system is not a broad enforced control plane. `requiredBeforeAnswer` only has a live `vision_triage` implementation; `orient_repo`, `investigate_context`, `web_research`, and `plan_first` are reserved and explicitly not built. `src/core/turn-directive.ts:77-96` Vision triage itself is deterministic lexicon/classification logic, not model investigation. `src/core/vision-triage.ts:201-222` Its output is rendered as prompt instructions. `src/core/vision-triage.ts:374-388` The grounded validator is final-text checking, not independent factual verification. `src/core/turn-directive.ts:410-435` `src/core/turn-directive.ts:447-490`

**Verdict:** The old failure was partly fixed, but the changelog oversells it. Some behaviors are enforced, some are shallow post-hoc checks, and some are still advisory blocks.

## 5. HIGH - Learned outcomes exist, but are off by default and mostly dormant for normal users

**Claim:** 3.21 says learned outcomes are used for routing, with lower-flake and cheaper-provider preference from real history. `CHANGELOG.md:99-130`

**What is true:** There is code to learn provider/model ordering from the local ledger. `src/core/routing-memory.ts:137-159` `src/core/routing-memory.ts:331-363` Menu and one-shot can feed learned provider/model order into routing. `src/interface/menu.ts:3746-3778` `src/cli.ts:383-440`

**What is not true:** The layer is inactive unless `learnRouting === true`. `src/interface/menu.ts:3746-3778` `src/cli.ts:383-440` The default config does not enable it. `src/infra/config.ts:190-194` The config docs call it off by default. `src/infra/config.ts:101-111` Even when enabled, provider learning requires enough history across at least two providers. `src/core/routing-memory.ts:137-159` Model learning needs at least five runs per model candidate. `src/core/routing-memory.ts:291-294` In scoring, learned model order is only a small bounded bump. `src/core/route.ts:514-526`

**Verdict:** Real code, weak default reality. For a fresh or default install, the "learned outcomes layer" is effectively not participating.

## 6. MEDIUM - Capability registry is used in sequential routing, but not across all execution paths

**Claim:** 3.21 and 3.23 describe a capability registry that drives self-awareness and capability-fit routing. `CHANGELOG.md:99-130` `CHANGELOG.md:40-68`

**What is true:** Chat refreshes the registry once per session. `src/interface/menu.ts:3533-3583` One-shot run builds a registry and capability summary. `src/cli.ts:470-497` Sequential orchestration passes `capabilityContext` into route selection. `src/core/orchestrate.ts:1040-1048`

**What is not true:** The registry is not consistently used by alternate executors. Panel candidate routing omits `capabilityContext`. `src/core/ensemble.ts:390-400` Panel synthesis routing omits it too. `src/core/ensemble.ts:739-751` Hedge routing omits it. `src/core/hedge.ts:210-221` The self-awareness text can describe known capabilities, but the same renderer admits provider-native features are not invoked from that context block. `src/core/tool-state.ts:333-360` `src/core/tool-state.ts:386-387`

**Verdict:** Not fake, but incomplete. Sequential routing benefits; panel/hedge paths remain behind the claim.

## 7. MEDIUM - Discovery-driven escalation is regex over the model's own output, not independent discovery

**Claim:** 3.22 frames discovery escalation and review as adaptive behavior verified in real runs. `CHANGELOG.md:69-98`

**What is true:** Final output can trigger discovery signals, manager escalation, or review. `src/core/orchestrate.ts:1219-1225` `src/core/orchestrate.ts:1539-1558` `src/core/orchestrate.ts:1922-1956`

**What is not true:** Discovery is not an independent pass. The module says it is pure and derives signals from provider output plus assessment. `src/core/discovery.ts:1-18` The extraction logic is pattern matching over text such as ambiguity, blockers, missing context, and low confidence. `src/core/discovery.ts:249-328` The AP2 design doc also says discovery does not need a second model call. `docs/adaptive-partner-v2-5.6.md:409-450`

**Verdict:** Useful heuristic, not real discovery. It trusts the same answer stream it is supposed to supervise.

## 8. MEDIUM - Work-state awareness is prompt memory, not runtime enforcement

**Claim:** 3.22 says the tool now knows what just happened and starts the next step instead of narrating stale plans. `CHANGELOG.md:69-98`

**What is true:** Work-state is derived from persisted trace and rendered into prompt context. `src/core/work-state.ts:117-139` `src/core/work-state.ts:215-242` Chat builds and passes that context into each turn. `src/interface/menu.ts:4457-4464` `src/interface/menu.ts:4516-4519`

**What is not true:** It is not a runtime state machine that verifies actual completion. The type definition still says `workTrace` is not consumed by runtime routing/review/goal-loop decisions. `src/core/types.ts:137-140` `verifiedDone` is inferred from roadmap/review/goal-complete trace events, not from independently rechecking the filesystem or command results. `src/core/work-state.ts:155-176`

**Verdict:** Honest prompt context, overstated as behavior. The model may act better because it sees state, but the orchestrator is not enforcing "next step" execution.

## 9. MEDIUM - "Real-run verified" is not reproducible from the repo evidence

**Claim:** 3.19, 3.21, 3.22, and 3.23 repeatedly say major behaviors were verified by real provider runs. `CHANGELOG.md:176-180` `CHANGELOG.md:126-130` `CHANGELOG.md:94-97` `CHANGELOG.md:40-68`

**What is true:** There may have been manual runs. The repository does include integration tests and provider-facing adapters.

**What is not true:** The checked-in verification base is mostly unit/fake/gated. Default `npm test` runs unit and architecture tests. `package.json:13-24` Native-session integration is skipped unless `MYSHELL_NATIVE_SESSION_E2E=1` and warns that it consumes real provider quota. `test/integration/native-session.test.ts:12-17` `test/integration/native-session.test.ts:30` Menu CLI integration is explicitly quota-free and makes no real provider calls. `test/integration/menu-cli.test.ts:19-20` Capability refresh tests use a fake port, not real Codex/OpenCode state. `test/unit/model-capability-refresh.test.ts:4-15` The image attachment tests use injected fake filesystem checks. `test/unit/attachments.test.ts:2-4`

**Verdict:** Weak evidence. "Verified" may be true as maintainer diary language, but it is not a reproducible guarantee in the codebase.

## 10. LOW - Parallel routing is real for panel, but `/goal` parallel-agent claims are future work

**Claim:** The 5.7 parallel-agent goal docs discuss multiple agents running in parallel. `docs/parallel-agent-goals-5.7.md:1-38`

**What is true:** Panel mode can start multiple candidates concurrently. `src/core/ensemble.ts:565-589`

**What is not true:** The actual `/goal` loop is still sequential. The 5.7 doc admits current `/goal` runs one provider turn at a time and that panel is not the same as parallel goals. `docs/parallel-agent-goals-5.7.md:28-38` `docs/parallel-agent-goals-5.7.md:48-53` The menu goal loop calls one task per iteration. `src/interface/menu.ts:4677-4744` Goal progress only displays parallel models when `parallelModels >= 2`. `src/core/goal.ts:98-167`

**Verdict:** The docs are mostly honest here. Anyone reading "parallel routing" as parallel goal agents is reading roadmap, not shipped product.

## 11. LOW - The "10/10" and high-score stamps are self-review marketing, not audit-grade evidence

**Claim:** 3.14 leans on "world-class chat", gated 9.5/10, 9.7/10, and broad whole-tool quality language. `CHANGELOG.md:282-318`

**What is true:** There are design docs and self-gate notes around whole-tool finish and final gate quality. `docs/whole-tool-finish-5.5.md:1-8`

**What is not true:** The final gate doc explicitly says the build is **not** 10/10 and gives only an 8.4 conditional go. `docs/final-gate-5.5.md:8-12` It also says it is not approved as a stamped 10/10 and calls out panel-prompt context bypass as the biggest risk. `docs/final-gate-5.5.md:401-404` `docs/final-gate-5.5.md:431-438`

**Verdict:** Treat the score language as marketing. The internal evidence contradicts any clean 10/10 interpretation.

## Bottom line

Roughly half of the claimed capability is real in the main sequential chat/run path: pre-provider terminal asks, Codex search when Codex is selected, image attachment forwarding for Codex/OpenCode, capability summaries, capability-fit routing, effort flags, and some post-hoc validation all exist. The overstatement is in scope and enforcement. OpenCode dynamic capabilities do not fully drive cross-provider hard routing, search does not route to Codex, image/search/capability context is dropped by REPL/panel/hedge/review paths, learned outcomes are off by default, and several "adaptive partner" claims are prompt blocks or regex validators rather than enforced runtime behavior. The shipped tool is materially better than pure prompt text, but the changelog sells a more universal, verified, self-aware system than the code actually delivers.
