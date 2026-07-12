# myshell-tools Release-Actualization Plan

> Audited 2026-07-12 on `feature/two-dial-orchestration-profile` at `97ade64` against `main` at `864806f`. This replaces the stale capability plan and is Terra's implementation handoff. The user explicitly designated this plan as the next implementation authority; R-1 must reconcile the contradictory repo pointers before code work.

## Verdict

The direction is broadly right, but the branch is not ready to merge, bump, or publish.

The product is a lightweight, local, subscription-aware terminal orchestrator. It delegates to supported official coding-agent CLIs, preserves provider-owned authentication, and gives the user one coherent chat, routing layer, durable work state, and verification story.

It is not an API gateway, OAuth-token broker, universal model protocol, team-scale code-intelligence platform, or provider-subscription reseller. Keep those concerns out of this release.

The branch has real progress—two-dial budgeting, durable control-plane events, detached execution, visible workers, and evidence-gated completion—but several headline features are isolated seams or incomplete integrations. Finish and prove the user journey; do not add another architecture layer.

## Product Truth

“One chat to rule them all” means:

- one local chat for requests, progress, blockers, cancellation, resume, and verified results;
- provider-neutral intent/work state, not fake provider equivalence;
- capability-aware routing across supported authenticated subscriptions;
- official CLIs and provider-owned credential stores whenever possible;
- honest degradation when a plan, CLI version, quota, OS, org policy, or capability is unsupported;
- no silent cross-provider retry after a possibly side-effecting turn;
- a published support matrix, not a universal-compatibility promise.

### Native model intelligence, not a homemade reasoning engine

Myshell must exploit each model's best native reasoning and agent capabilities. GPT-5.6, future GPT releases, Claude, and other providers will improve faster than a generic reasoning abstraction in this repo.

Myshell owns the surrounding control loop: capability/model selection, native effort controls where officially exposed, task topology, context/provenance, tools/sandbox/permissions, quota/concurrency, durable state, stall recovery, evidence, verification, and handoff.

It must not claim to reproduce or normalize vendors' internal reasoning. Route by live capabilities and measured outcomes, pass through native controls, and keep provider-specific adapters versioned.

### Operational meaning of “flawless”

For every supported matrix entry: deterministic install/startup, correct auth/health detection, no credential leakage, correct routing or actionable refusal, bounded retries, process-tree cancellation, durable resume without duplicated effects, acceptance-linked verification, and a working packed npm artifact on Windows/macOS/Linux. Outside the matrix, flawless means safe, diagnosable failure.

### Elite-partner orchestration contract

Myshell is the lead partner, context curator, and final integrator—not a round-robin model dispatcher. It chooses the smallest high-confidence workflow that clears the task's quality bar, then escalates reasoning, model strength, context, parallelism, review, and verification only when evidence says they improve the result.

Optimize the whole workflow, not isolated calls: task decomposition, dependency order, model/effort fit, context selection, native-session reuse, cache value, tool authority, risk, quota pressure, latency, review independence, acceptance evidence, and stop conditions. A one-million-token window is capacity, not permission to dump the repository. Each call gets the minimum sufficient, provenance-rich context; large context is used when cross-cutting dependency evidence justifies it. Measure quality, rework, latency, calls, reported usage, cache use, and context utilization so routing improves from outcomes instead of provider mythology.

Routine turns should normally use one capable lane and zero auxiliary model calls. Planning, panels, hedges, and cross-provider review must earn their quota by task complexity, uncertainty, or risk. The strongest available model is not automatically the best worker; use it where judgment has the highest marginal value and use cheaper/faster eligible lanes for bounded work. One coordinator owns coherence and the final answer.

### Clarified adaptive-provider contract

The routing atom is an **eligible execution lane**, not a provider followed later by an account:

```text
lane = provider + account/profile + auth kind + isolated home + CLI version
     + model + capabilities + policy + health + quota/cooldown + inventory generation
```

Myshell automatically discovers eligible models exposed by supported authenticated CLIs and may adopt them on a later safe turn without a myshell release, restart, or new visible conversation. A release-day model is not guaranteed until the installed official CLI, the specific account, region/workspace policy, and subscription entitlement expose it.

Newly discovered models enter `candidate/unknown`, not instant flagship status. Official durable aliases may track the provider's current family. Other unknown models get objective metadata plus a non-mutating compatibility canary and measured provisional rank before manager/high-risk admission. Never rank a model from its name or version number.

Inventory is versioned per lane and rebuilt at startup, explicit refresh, login/logout/account changes, CLI-version/catalog changes, stale turn boundaries, and once after a pre-side-effect model/auth mismatch. A turn freezes one immutable routing snapshot. Never swap an in-flight model or silently retry a possibly side-effecting call.

The visible myshell conversation is canonical. A native provider session is only an execution cache. On a compatible consecutive provider/account/model lineage, resume it. On A→B→A, account/model incompatibility, or uncertain native state, create a structured continuity bridge containing the objective, constraints, accepted decisions, open loops/questions, changed files and hashes, test/evidence state, and last safe checkpoint. The user stays in the same myshell conversation even when the underlying provider session changes.

## Audited Baseline

The feature branch is 13 commits and roughly 2,904 added lines beyond `main`.

Real production wiring:

- separate effort/speed types and budgets in `src/core/orchestration-profile.ts`;
- persisted Speed and control-panel Effort/Speed rows;
- Speed feeding multi-goal scheduling in `src/interface/menu.ts`;
- durable event log/replay in `src/core/control-plane.ts` and `src/infra/control-plane-store.ts`;
- detached lifecycle/heartbeat/wait events in `src/commands/worker.ts`;
- real provider invocation plus verification in `src/commands/detached-goal-execution.ts`;
- evidence-required todo/goal completion in `src/core/durable-goal-runner.ts`.

Incomplete or misleading:

- `planShardability` and `planWorkerTopology` have no production callers; tests prove planners, not adaptive fan-out.
- Effort remains legacy `mode`; Speed is the only new first-class config field.
- Speed changes concurrent goals, not per-goal topology, worker count, speculation, or early termination.
- Detached execution is a smaller second loop around `runTask`, not foreground parity.
- Provider/model routing occurs before account selection, while model inventory is provider-global. Different accounts with different entitlements can therefore be mispaired.
- Mid-chat refresh is a five-minute background model-only refresh. It does not refresh auth, plan, CLI version, or per-account entitlement, and it defines no safe migration contract.
- New unknown Codex/Claude/Grok model IDs are worker-floor only, so discovery exists but intelligent promotion does not.
- The strong meta path in `src/interface/menu.ts` hard-codes dated Claude, Codex, and OpenCode models and bypasses the live registry.
- Default-on native sessions can lose intervening context on A→B→A because portable history is suppressed when A is resumed.
- Claude/Grok native effort remains default-off, so the Effort dial's provider-native claim is not generally true.
- Missing providers become bare `parked`, not `waiting_on_auth`.
- Broad tests after each todo do not prove todo acceptance; no-test work can park incorrectly.
- Heartbeats are UI facts, not renewable leases; PID liveness is insufficient.
- Full unit/architecture tests exceeded the audit's 124-second window, so green is unproven.
- `npm run lint` fails on two unused imports in `src/commands/worker.ts`.
- `npm run knip` fails on unused `rungTupleFromEffort`.
- Typecheck and build pass.
- `prepublishOnly` runs no tests.
- GitHub `main` is green at `864806f`, but this 13-commit feature branch has no PR and therefore no branch CI evidence.
- Required CI omits UI tests; package check is Ubuntu-only `npm pack --dry-run`; declared Node 20 support is not exercised.

## Terra Loop Failure and Required Invariant

The prior run repeatedly emitted “continuing” and “still active” without a useful work turn. Durable goals prevented false completion, but the system produced status theater until marking itself blocked.

Required progress invariant:

- A useful continuation adds a tool/event receipt, artifact/diff, test evidence, decision, new blocker evidence, or measurable state transition.
- Reworded heartbeat text is never progress.
- Track `lastMeaningfulProgressAt`, progress fingerprint, continuation count, and repeated blocker fingerprint.
- After a bounded no-progress window, recover: inspect/cancel a hung child, restore a checkpoint, reduce the slice, or switch an eligible provider/model.
- Never switch after an uncertain side effect without idempotency or user direction.
- If recovery cannot create useful work, enter one typed `blocked`/`waiting_*` state with exact reason/next action and stop auto-continuing.
- UI heartbeat must not generate chat spam.

Test identical continuations, hung-alive worker, silent tool, provider timeout, quota wait, uncertain mutation, checkpoint resume, and successful recovery.

## Provider and Security P0s

1. Account routing ignores persisted `auth-failed`.
2. When all accounts cool down, routing chooses one anyway; it must wait, block, or choose a compatible healthy lane.
3. Grok auth false-positives on exit zero plus empty/changed output; require a positive versioned signature or probe.
4. OpenCode account detection is incomplete; `unknown` must not be silently routable.
5. Legacy `~/.myshell-tools/credentials.json` can own a long-lived Claude token. Stop capture, confirm official CLI auth, then migrate/remove safely.
6. Token clearing must preserve `0600`, remove metadata, and use credible Windows keychain/ACL protection.
7. Grok prompt temp files need stdin or restrictive creation, `finally` cleanup, and stale-file scavenging.
8. Subscription JSON needs schema validation, managed-home containment, migration, and corruption quarantine.
9. Concurrent subscription updates need a lock or generation/CAS.
10. Provider children inherit excessive secrets. Use a minimal env allowlist with explicit compatibility mode and redaction.
11. Separate installed, credential-present, authenticated, healthy, degraded, and policy-eligible. Route validated eligible lanes only.

## Provider Policy

- **Codex:** official `codex` with ChatGPT subscription sign-in for this product scope. The CLI supports API-key login, but myshell must identify it as usage-billed and refuse/require explicit future opt-in rather than silently violating the subscription-only promise. Never copy credentials; preserve sandbox/approvals.
- **Claude Code:** official `claude` for Pro/Max. Never send consumer OAuth through OpenCode or a homemade endpoint.
- **OpenCode:** the explicit SK exception for OpenCode-owned Go/Zen or other deliberately supported key-backed pools. Independently allowlist and contract-test each upstream adapter; ecosystem support is not vendor authorization. Do not route Claude consumer OAuth through OpenCode.
- **Gemini:** consumer Gemini CLI Google login for Individuals/AI Pro/AI Ultra ended 2026-06-18. Support only a current provable official enterprise/replacement flow.
- **GitHub Copilot CLI:** worthwhile later through official OAuth/device flow, OS credential store, and org-policy checks.
- **Grok/SuperGrok:** official subscription OAuth only for this scope; distinguish API-key billing and do not select it silently. Retain only with a positive versioned auth signature and safe prompt handling.

Sources:

- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/developer-commands?surface=cli
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/model-config
- https://docs.x.ai/build/overview
- https://docs.x.ai/build/cli/reference
- https://opencode.ai/docs/providers/
- https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli

## Scope Freeze

Do not add org indexing, multi-tenant identity/billing, 200-developer scheduling, shared API vault/proxy, provider resale, unbounded fan-out, a second router, another persistence architecture, or indefinite new dark flags.

## Terra Execution Protocol

For every small slice:

1. Name user-visible behavior and exact production call path.
2. Add a failing production-path test, not only a pure helper test.
3. Implement the smallest coherent change.
4. Run focused and affected suites.
5. Record failure semantics, rollback, and receipts.
6. Commit only when green.
7. Never count types, planners, or mocked seams as shipped capability.

If work stops producing evidence, invoke the progress invariant. Do not narrate continuation.

## Release-Critical Slices

### R-1 — Reconcile authority and freeze truth

- Update the repo's active-plan pointer: `CLAUDE.md` still names `docs/menu-build-spec-final.md`, conflicting with this user-designated handoff.
- Mark stale roadmap/handoff/release claims as superseded or update them; `RELEASE.md` and `ROADMAP-STATUS.md` are not current.
- Repair or archive malformed/missing-spec references, including the preamble in `docs/vendor-neutral-routing-spec.md` and references to missing `docs/model-capability-registry-5.6.md`.
- Record the exact baseline, supported product/auth scope, rollout/rollback policy, and no-publish boundary.

Done: one unambiguous current-state document and one active build plan; no source-of-truth conflict remains.

### R0 — Green baseline and deterministic harness

- Fix lint/knip.
- Segment long suites, record durations, and fix hangs/open handles instead of blindly raising timeouts.
- Add one cross-platform `quality` command covering typecheck, lint, knip, build, unit, architecture, UI, contract, and deterministic integration.
- Make `prepublishOnly` use the deterministic release gate.
- Add fake versioned provider CLIs that exercise JSON/JSONL, stderr, exit codes, auth, catalog drift, timeout, cancel, partial output, tool events, and session IDs without live quota.
- Align the declared Node `>=20` engine with CI coverage on Node 20/22/24, or deliberately raise the engine.
- Keep live-account canaries optional/nightly; deterministic contracts run each PR.

Done: every deterministic lane passes locally/CI with no unexplained handle, including UI and adapter contracts.

### R1 — Runtime lane inventory and adapter contract

- Replace provider-global routing facts with versioned per-profile lane inventory. Route provider/account/model atomically; never choose a model and attach an account afterward.
- Model profile identity as provider, account alias/id, auth kind, isolated home, binary path/version, and policy scope. Managed-account failure must not fall through to ambient/global credentials unless an explicit compatibility policy allows it.
- Verify isolation and concurrent use per provider, CLI version, and OS. Claude documents `CLAUDE_CONFIG_DIR` for multiple accounts; Codex `CODEX_HOME`, Grok `GROK_HOME`, and OpenCode XDG homes still require compatibility proof. If a provider cannot safely isolate multiple accounts, publish a one-account limit instead of simulating support.
- Represent capability/auth/health as `supported`, `unsupported`, `unknown`, or `temporarily_unavailable`, with source, freshness, and inventory generation.
- Discovery strategy: Claude documented durable aliases plus observed/probed facts; Codex stable cache plus optional version-gated `codex debug models` (experimental) and CLI default fallback; OpenCode `models --verbose`; Grok `models`. Never scrape interactive UI.
- Remove every dated model-selection bypass, especially `pickStrongMeta`; all core, planning, meta, review, hedge, detached, and fallback calls consume the same lane snapshot.
- Add progressive admission for new models: discover → quarantine/worker-floor → non-mutating canary/objective metadata → provisional measured rank → normal eligibility. Demote/invalidate on model-not-found or schema drift.
- Keep stable JSON/JSONL subprocess adapters as the production floor. Experimental app-server/ACP transports may be optional accelerators with conformance fallback, never the only path.

Done: isolated-account-only auth works; every advertised multi-account configuration is proven against the official CLI; two accounts with different entitlements cannot be crossed; a synthetic future model becomes safely eligible without a code release; no production path contains a dated model preference.

### R2 — Same-chat hot adaptation and coherence

- Freeze one lane snapshot per dispatched turn; adopt catalog/account/auth changes only at safe turn/checkpoint boundaries.
- Refresh on startup, explicit action, account mutation, login/logout, CLI/catalog generation change, stale pre-route check, and safe pre-side-effect mismatch. Five-minute background refresh is only a fallback.
- Make the provider-neutral conversation/event log authoritative. Persist per-lane native-session lineage and the inventory generation used for each turn.
- Resume native sessions only for proven compatible consecutive lineage. A→B→A, account changes, removed models, or incompatible model switches require a structured continuity bridge/replay.
- Record a concise transition receipt without making model churn noisy. Do not switch during a tool call or retry uncertain mutations.
- Test provider/model added, revoked, removed, upgraded, or policy-disabled mid-chat; A→B→A; same-provider model switch; restart during transition; stale cache; and failed probe.

Done: a newly exposed eligible model can be used on the next safe turn in the same visible conversation, and intervening decisions/work are never lost.

### R3 — Safe account selection

- Eligibility includes enabled, expiry, health, cooldown, policy, capability, model entitlement, and inventory generation.
- Exclude `auth-failed`; make `unknown` degraded/non-routable by default.
- Replace cooldown bypass with typed `waiting_on_quota`, bounded Retry-After, or compatible healthy fallback. Never rotate accounts merely to evade provider limits or terms.
- Validate/schema-check state; quarantine corruption; use a file lock or generation/CAS for updates.
- Prohibit provider-global ambient fallback when managed accounts exist unless explicitly configured.
- Table-test none, singletons, all six pairs, all four triples, all four, multiple accounts with mismatched entitlements, and expired/revoked/rate-limited/missing/corrupt cases.

Done: no unhealthy/cooling account is silently chosen; every no-route is actionable; concurrent writes are lossless.

### R4 — Provider-owned credentials and state safety

- Stop Claude token capture and implement cautious legacy migration only after proving official CLI auth works; never delete the only working credential.
- Preserve permissions and prove concrete Windows keychain/ACL and POSIX behavior.
- Use minimal adapter-specific child environments with an explicit warned compatibility escape hatch; prevent stray API-key variables from silently changing subscription billing/auth mode.
- Require a positive versioned Grok auth signature. Use stdin where supported or exclusive restrictive prompt-file creation, top-level `finally` cleanup, and startup stale-file scavenging.
- Test redaction across errors, logs, receipts, argv, env, state, migrations, and crashes.

Done: clean install stores no OAuth token; selected auth kind is truthful; migration never deletes the only working credential; crashes leave no plaintext prompt artifact.

### R5 — Acceptance, retry, quota, and coherence contract

- Define one global turn/session call budget enforced before every provider call—core, preflight, planning, meta, hedge, review, retry, and detached work. Reserve the core answer.
- Track calls, attempts, latency, reported usage, cache use, context size/utilization, and estimates separately. Never present inferred subscription headroom as exact quota.
- Build a context compiler that selects task-relevant instructions, repo-map slices, decisions, open loops, diffs, evidence, and summaries under an explicit budget. Prefer native cache/session reuse; expand toward large windows only when dependency coverage or failed retrieval proves value.
- Add a representative routing/context eval corpus spanning trivial chat, bounded edits, debugging, cross-cutting changes, research, long-horizon goals, and high-risk work. Compare quality, rework, latency, context, and calls against simpler baselines; use offline shadow/regret analysis rather than spending extra calls on every live turn.
- Learn only from locally retained, redacted outcome receipts with bounded decay and an inspect/reset control. Provider name is never a quality fact; measured task-specific outcomes are.
- Retry only failures proven pre-execution or idempotent. Timeout, cancellation, partial tool output, or uncertain side effects become `unknown_outcome/reconciliation_required`, not silent cross-provider failover.
- Bind every todo to acceptance criteria and an evidence strategy: targeted tests, type/lint/build, file/content/diff assertions, receipts, or manual confirmation.
- Preserve one coordinator/final writer, provider-result provenance, compact worker summaries, context budget, and compaction invariants.

Done: high-frequency ordinary chat uses no unnecessary model call; every extra call has budget/provenance; large-context use has a recorded reason; unrelated green tests cannot settle work; uncertain mutations never auto-retry.

### R6 — Unified foreground/detached lifecycle

- Compose one lifecycle and dependency builder, not two products.
- Add typed waits for auth, quota, user, manual work, policy, unsupported capability, and reconciliation.
- Add renewable fenced leases: ID/owner/acquired/expires/generation; do not trust PID alone.
- Journal idempotency keys, side-effect boundaries, checkpoints, questions, and exact resume target. Promise at-most-once only where fencing proves it; otherwise report uncertain outcome honestly.
- Define process-tree cancellation on all OSes.
- Make the durable scheduler handle large task counts through bounded concurrency, dependency/resource locks, fairness, backpressure, and lazy/JIT decomposition. Never equate “any number of tasks” with unbounded fan-out or loading every task into every prompt.

Done: restart tests cover boundaries; hung/PID-reuse recovers; no-provider is `waiting_on_auth`; foreground/detached conformance holds.

### R7 — Durable truth and stall recovery

- Drive foreground/detached board state from one versioned control-plane snapshot; prove append, compaction, recovery, migration, retention, and redaction.
- Show only truthful provider/account/model/action/wait/usage and inventory generation.
- Implement the progress invariant without heartbeat chat spam.
- Test identical continuations, hung-alive worker, silent tool, provider timeout, quota wait, uncertain mutation, checkpoint resume, and successful recovery.

Done: restart preserves truth; stalled/waiting/blocked/failed/unknown-outcome differ; Terra-style loops recover or stop once.

### R8 — Finish or narrow two-dial claims

Prefer explicit persisted `effort` with legacy migration. If risky, label legacy mode honestly and defer the full claim.

- Prove panel changes affect foreground and detached turns.
- Effort controls lane/model selection, provider-native reasoning where versioned adapter contracts prove support, and verification. Graduate Claude/Grok effort or narrow the claim.
- Speed controls documented concurrency, clamped by dependencies, quota, provider capacity, and workspace safety.
- Topology/fan-out stays after lifecycle, verification, budgets, and stall safety. Prefer bounded isolated workers, deterministic join/cancel, dependency-aware worktrees, and early termination. Otherwise ship Speed honestly as multi-goal concurrency only.

Done: both dials alter documented production behavior on every supported adapter; no dark or planner-only claim remains.

### R9 — Matrix and packed-artifact proof

Check in OS/Node/provider-CLI versions, auth modes, plan/org constraints, capabilities, supported combinations, and exclusions. Generate the support matrix as test data, not prose.

Test no provider; every singleton, pair, triple, and all four; multiple accounts with mismatched models; expired/revoked/unknown/all-cooling; CLI missing/outdated/output drift; model/account appears or disappears mid-chat; A→B→A; timeout/cancel/crash/PID reuse; corrupt/concurrent state; and Windows/macOS/Linux on Node 20/22/24.

Build a real tarball, install it into an empty project on every OS, and exercise both bin names, first run, no-provider refusal, auth handoff, one-shot, interactive, background, resume, cancel, model transition, and project integrity. A dry-run file list is insufficient.

Done: the packed artifact completes the golden journey; README links the generated matrix; unsupported paths fail actionably; every headline behavior traces through production composition with no mocked-only or dark-flag substitute.

## Post-Release P1

Only after R-1–R9 and a real installed smoke: official Copilot adapter, experimental long-lived transports, better quota estimates, local-first completions, opt-in tracing/evals, and a public adapter contract kit.

## Release Train

### Actualization invariant

A slice is actualized only when its named user behavior is reachable through the real installed entry point and production dependency composition. Types, pure helpers, mock-only tests, planner output, receipts, or a default-off flag do not count by themselves. For each slice, record the entry point → composition → lane/adapter → durable state → UI/result call path; failure and rollback semantics; migration compatibility; focused tests; affected suites; and packed-artifact evidence where applicable. Delete or explicitly defer replaced paths so two competing implementations do not drift.

Terra must work in bounded PR-sized chunks, reassess after each slice, and stop on a real invariant conflict or uncertain external side effect. Reworded status is not progress. The plan is complete only when every release-critical `Done` clause is backed by command/CI evidence or the corresponding product claim has been deliberately narrowed in code and docs.

1. Execute R-1, then each numbered slice as a sequence of small focused PRs on a clean feature/successor branch. Never attempt the entire plan as one unreviewed run.
2. Run full local quality and packed-artifact smoke.
3. Push; wait for every branch CI lane green.
4. Review `main...branch` for security, truth, scope, generated files, and version drift.
5. Merge only clean/green; wait for `main` CI green.
6. Make a separate semver decision and bump commit/PR.
7. Re-run package gate/packed smoke; wait for release CI green.
8. Stop. The user publishes npm manually.
9. Install from registry in a clean real project, run the journey, record results, retain rollback/deprecation instructions.

No agent publishes, rotates credentials, changes provider accounts, or widens support claims without explicit authorization.

## Definition of Done

A new user installs the packed/registry package, authenticates through any supported official subscription combination, opens one chat in a supported project, requests meaningful work, sees truthful progress, survives restart, answers a blocker, avoids continuation loops, cancels safely, receives acceptance-linked verification, and understands degraded states—without myshell owning provider secrets or corrupting the project.

The partner selects an evidence-backed sequence of models, effort, tools, context, review, and verification; uses large context only when it adds value; adapts to newly exposed eligible models at a safe boundary without a new visible conversation; and never crosses account entitlement, policy, quota, or continuity boundaries silently.

Until proven across the matrix, call it beta, not flawless. The honest release claim is automatic discovery and safe same-chat adoption of models that supported official CLIs expose to the selected account—not universal day-zero access to every future model.
