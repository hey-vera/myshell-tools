# Subscription-Native Repo Editing v1

Status: planning artifact. This is the execution gameplan for taking myshell-tools from its current state to a subscription-native, one-chat repo editing tool that can beat command-first agents without inheriting their UX.

## North star

myshell-tools is the subscription-native AI work harness for developers:

> One natural chat over the provider CLIs you already pay for. It selects context, edits repos safely, verifies work, preserves durable state, and gives honest receipts without making the user micromanage files, modes, providers, or slash commands.

The goal is not to clone Aider. Aider teaches the reliable primitives: repo map, precise edits, git safety, lint/test repair, undo, and benchmark discipline. myshell-tools should absorb those primitives behind Auto Smart and make the normal interface natural language.

## Non-negotiable corrections

### No fake quota

No provider inspected by myshell-tools currently exposes a reliable “remaining subscription quota,” weekly/monthly usage, percent remaining, reset time, or universal Retry-After through the subscription CLI path.

Therefore myshell-tools must not claim:

- “you have X% quota left”
- “Claude has Y messages remaining”
- “weekly usage is Z”
- “reset is at T”

The honest subscription-native signals are:

- provider installed/authenticated status
- plan label when the provider CLI/local auth exposes one
- tokens reported by the provider CLI when available
- cache read/write tokens when available
- local session/turn consumption totals
- rate-limit/quota failures detected after the fact
- cooldown/backoff state caused by real failures
- provider/model success history from local receipts
- whether headroom is unknown

Any routing or receipt surface must say “headroom unknown” unless a provider actually exposes a concrete field and a fixture proves its shape.

### Subscription-native, not API-native

Claude, Codex, and Grok should be driven through their OAuth/subscription CLIs. OpenCode Go is the exception because its subscription access is API-key-shaped through OpenCode.

Do not drift into raw provider APIs just to get more control unless the user explicitly chooses an API path. The default product promise is:

> Use the subscriptions and CLIs I already have.

### Natural language first

Slash commands may remain as compatibility/power-user escape hatches, but no core repo-editing workflow may require them.

The user says:

- “fix the failing auth test”
- “undo that”
- “show me what changed”
- “commit this”
- “don’t touch the UI”
- “use Claude to plan and Codex to edit”
- “try a second opinion”
- “run the relevant tests”

myshell-tools maps that into safe operations.

## Current-state anchors

Existing foundations worth preserving:

- Provider login delegates to vendor CLIs and generally does not store raw secrets.
- Provider detection is provider-level and already includes Claude, Codex, Grok, and OpenCode.
- OpenCode has a distinct pool concept for Go vs free/Zen paths.
- Cooldown/backoff exists from observed rate-limit failures.
- Session token consumption/load balancing exists as a local pressure proxy.
- Semantic Preflight V1 and CompletionResultV1 are now default-on entrypoint surfaces.
- Goals, scheduler, work-state, verification, evidence receipts, and route/governor layers exist.
- Native sessions exist but are still experimental/opt-in and need validation before promotion.

Existing gaps:

- No account-level identity for multiple accounts of the same provider.
- No true subscription quota/headroom API.
- Repo editing is not yet the first-class product loop.
- Undo/commit/diff intent handling is not yet a natural-language repo-editing contract.
- Repo map exists as substrate but is not yet an Aider-grade editing context product surface.
- Verification receipts still need a subscription-native framing: tokens/commands/evidence, not fake dollars.

## Target product behavior

### Default user flow

The user runs:

```text
myshell-tools
> fix the failing auth tests
```

Auto Smart should:

1. Detect current repo and dirty state.
2. Infer task kind: repo edit, likely test repair.
3. Build a small repo map and context packet.
4. Select relevant files and tests.
5. Explain only the useful receipt-level context: “I’m inspecting auth tests + auth provider adapter.”
6. Choose provider(s) from authenticated subscription CLIs.
7. Plan/edit/verify with role split when the risk warrants it.
8. Apply patches safely.
9. Run relevant checks.
10. Repair failures within bounded loops.
11. End with CompletionResultV1: changed files, checks run, result, undo checkpoint, residual risk, headroom unknown/pressure signals.

No slash command required.

### Pro steering

Pro devs should steer in natural language:

- “small patch only”
- “no new dependencies”
- “use the existing parser”
- “don’t run full test suite, just unit tests”
- “split into two commits”
- “show me the diff before applying”
- “make it production-grade”

These become constraints in the TurnPlan / repo-edit plan, not one-off prompt vibes.

## Architecture

### Layer 1: Repo Edit Intent

Semantic preflight should classify:

- ask/explain
- plan-only
- repo-edit
- verify-only
- undo/revert
- diff/status
- commit/release
- provider steering

The result becomes a typed intent, not a command parser. Examples:

- “undo that” -> `repo.intent = undo_last_ai_change`
- “what changed?” -> `repo.intent = summarize_diff`
- “commit this” -> `repo.intent = commit_current_ai_change`
- “fix failing tests” -> `repo.intent = edit_and_verify`

### Layer 2: Repo Map and Context Packet

Build an editing-grade context packet:

- repo root and git state
- package/tooling detection
- candidate files
- candidate tests
- symbols/exports/imports
- related files
- recent touched files
- user constraints
- project conventions/memory
- files explicitly excluded by user

This packet should be small and explainable. The model should not receive a giant raw repo dump.

### Layer 3: Safe Change Session

Before edits:

- detect dirty files
- distinguish user dirty files from prior AI changes when possible
- create an AI checkpoint record
- refuse ambiguous destructive edits unless user confirms

During edits:

- require a machine-parseable patch/edit format
- apply deterministically
- reject ambiguous or partial application
- preserve line endings where practical
- record file hashes before/after

After edits:

- produce diff summary
- run selected checks
- attach verification evidence
- make undo possible

### Layer 4: Auto Smart Role Split

Auto Smart decides the internal role plan:

- Simple local edit: one editor call.
- Multi-file or risky edit: planner -> editor -> verifier.
- Security/data-loss risk: planner -> editor -> independent reviewer -> verifier.
- Failing checks: bounded repair loop.
- Provider disagreement: synthesize, do not blindly average.

Role split is invisible unless the user asks or the receipt needs to explain it.

### Layer 5: Subscription Provider Selection

Provider selection uses real subscription-native signals:

- authenticated providers
- provider capabilities/model list when exposed
- local plan label when exposed
- local success history
- token/session consumption pressure
- active cooldowns from real failures
- task type and risk
- user steering

It must not use fake remaining quota.

Receipts should say things like:

```text
Provider: Codex via CLI
Reason: repo-edit path, authenticated, no cooldown, lower local session pressure than Claude
Headroom: unknown
```

### Layer 6: CompletionResultV1 as the terminal truth

Every repo-edit terminal result should attach:

- accepted intent
- files inspected
- files changed
- commands run
- verification result
- undo checkpoint
- provider(s) used
- pressure/cooldown signals
- unverified assumptions
- next safe action

## Phased implementation plan

### Phase A: Audit and spec closure

Goal: remove ambiguity before coding.

Deliverables:

- This document becomes the controlling plan.
- Add an implementation checklist with links to exact files/functions.
- Mark fake-quota claims in README/docs for correction.
- Decide which existing command surfaces stay as escape hatches but are not central.

Acceptance:

- No planned feature depends on remaining-quota APIs.
- The repo-edit loop has typed states and failure behavior.

### Phase B: Natural-language repo intents

Goal: “undo that,” “show diff,” “commit this,” and “run tests” become native chat intents.

Implementation shape:

- Extend semantic preflight / ask-vs-act to classify repo operation intents.
- Add pure parsers/tests for common natural language phrasings.
- Wire menu/run paths to route these intents to existing git/status/test helpers or new pure seams.

Acceptance:

- Unit tests cover at least 40 phrasings across undo, diff, commit, verify, edit, and constraints.
- Existing slash commands remain optional.

### Phase C: Safe AI checkpoint and undo

Goal: Aider-grade trust without command-first UX.

Implementation shape:

- Add an AI change checkpoint store under myshell state.
- Record before/after file hashes and git diff metadata for AI-applied changes.
- Implement “undo last AI change” safely.
- If user dirty changes overlap, ask before reverting.

Acceptance:

- “undo that” reverts only the last AI change in tests.
- User dirty changes are preserved or the operation refuses with a clear explanation.

### Phase D: Editing-grade repo map/context packet

Goal: repo edits receive the right context automatically.

Implementation shape:

- Promote/extend existing repo-map functions into a `RepoEditContextPacket`.
- Include candidate files/tests/symbols/imports/tooling and exclusion constraints.
- Keep packet bounded and receipt-friendly.

Acceptance:

- Given fixture repos, context selection finds relevant files/tests without manual `/add`.
- Packet size is capped.
- Receipt explains selected files.

### Phase E: Deterministic patch application contract

Goal: model output becomes safe local changes, not prose plus hope.

Implementation shape:

- Define one preferred edit format for repo-edit mode.
- Add parser/validator.
- Apply through deterministic filesystem operations.
- Reject malformed/ambiguous edits with repair prompt or fallback.

Acceptance:

- Tests cover create/update/delete/rename, partial mismatch, overlapping edits, CRLF/LF, and dirty-file conflicts.
- Malformed edits never silently mutate files.

### Phase F: Verify and repair loop

Goal: “done” means checked, or honestly unverified.

Implementation shape:

- Detect likely commands from package/tooling.
- Run minimal relevant checks first.
- Repair failures within bounded attempts.
- Escalate to broader checks only when warranted.

Acceptance:

- Node/Rust/Python fixture repos run expected checks.
- Failed checks feed repair with compact diagnostics.
- Final receipt distinguishes verified, partially verified, and unverified.

### Phase G: Subscription-native provider routing receipts

Goal: users trust provider choice without fake quota.

Implementation shape:

- Add provider-choice receipt line.
- Show tokens consumed when available.
- Show active cooldowns.
- Show “headroom unknown” explicitly.
- Do not present API-equivalent dollars in default completion receipts.

Acceptance:

- Golden receipts do not claim remaining quota.
- Cooldown/session pressure routing changes are visible but not noisy.

### Phase H: Native session validation/promotion

Goal: reduce context replay and make one-chat continuity real through provider CLIs.

Implementation shape:

- Validate Claude/Codex/Grok/OpenCode native session behavior where available.
- Keep quarantine/fallback for stale/poisoned sessions.
- Promote only providers with passing live/gated evidence.

Acceptance:

- Same-provider follow-up turns use native continuity where supported.
- Fallback to history replay is automatic and honest.
- No provider is promoted based on assumed CLI behavior.

### Phase I: Benchmark and dogfood harness

Goal: earn “better than Aider” claims with evidence.

Implementation shape:

- Add small local repo-edit benchmark fixtures.
- Track patch apply success, checks passed, calls used, time, and repair attempts.
- Later add optional public benchmark adapters.

Acceptance:

- `npm test` covers the repo-edit primitives.
- A dogfood script can run several end-to-end fixture edits without publishing claims.

## Execution model

Planning should stay with the lead model / primary architect until this document is stable. OpenCode workers should be used for bounded implementation slices after the plan is coherent.

Good OpenCode worker tasks:

- “Implement Phase B pure intent parser tests only.”
- “Audit files touched by repo-map and propose exact insertion points.”
- “Implement checkpoint store pure functions with tests.”
- “Build fixture repo for Node verification tests.”

Bad OpenCode worker tasks:

- “Design the whole product.”
- “Turn on everything.”
- “Make it like Aider.”
- “Use provider quotas.”

Each worker task must include:

- exact phase
- files in scope
- forbidden changes
- acceptance tests
- no broad rewrites
- no fake quota claims

## First implementation recommendation

Start with Phase B + C, not repo-map.

Why:

- Natural-language undo/diff/commit/status is the highest-trust visible upgrade.
- It proves “no slash commands required.”
- It forces safe checkpoint semantics before broader editing automation.
- It reduces risk before model-generated patch machinery lands.

Then do D/E/F as the full repo-editing engine.

## Definition of done for v1

myshell-tools v1 subscription-native repo editing is done when:

- A fresh user can install and sign into provider CLIs without API keys except OpenCode Go.
- User can say “fix this failing test” and get a safe edit/verify/repair loop.
- User can say “undo that” and only the AI change reverts.
- User can say “what changed?” and get a precise diff summary.
- User can say “commit this” and get a clean commit.
- Provider choice works through subscription CLIs and says headroom unknown unless proven.
- No slash command is required for the core workflow.
- CompletionResultV1 contains enough evidence to audit what happened.
- Full tests, build, lint, knip, package smoke pass.

