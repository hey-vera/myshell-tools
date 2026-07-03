# Rules + Memory 10/10 Improvement Plan

Date: 2026-07-03

Scope: proposal only. This document audits the current `CLAUDE.md` and Claude auto-memory index at `C:/Users/Josh/.claude/projects/C--Users-Josh-Desktop-Github-Repositories-myshell-tools/memory/`. It does not modify operating rules or memory files.

## Executive Take

The current setup already has the right core philosophy: the main Claude thread is an orchestrator, frontier models plan and audit, opencode-go workers execute, memory is for durable standing rules only, and repo docs are the source of truth for state. The biggest gap is not philosophy. It is governance precision: the rules are currently too absolute in places, the quota policy lacks concrete stop/spawn thresholds, memory write rules do not have a formal schema or review cadence, and the new anti-drift reference-cloning rule exists as a memory file but is not linked from `MEMORY.md`.

The target 10/10 state is a small, explicit, enforceable root rule file plus a small memory index of durable invariants. Anything long, historical, procedural, or stateful should live in repo docs and be referenced on demand.

## Current Governance Found

### CLAUDE.md

The root operating file defines four major policies:

1. Orchestrator discipline: the main Claude Code conversation should not do deep subsystem reads, implementation, planning docs, or audits inline. It may dispatch agents, edit rules and memory, run verification, perform git ops, and do quick spot-checks of roughly two files.
2. Frontier/worker split: codex GPT-5.5 is the frontier audit/planning model; opencode-go models are workers; Claude Agent subagents are last resort and require explicit user permission.
3. Design-before-doing: high-value plans should use adversarial design rounds and output full work to repo docs.
4. CLI invocation: `codex exec` and `opencode run` must close stdin with `</dev/null`; codex sandbox modes are documented as broken in the Linux container; on Windows use Bash/git-bash style invocation to preserve stdin closure.

Strengths:

- Short enough to be always-loaded.
- Concrete commands and known failure modes are included.
- Role separation is clear.

Risks:

- The "never inline" language is too broad unless paired with quota gates and task-size thresholds. It can cause expensive delegation for small bounded work.
- "Design before doing" is broad enough to trigger frontier/adversarial rounds for tasks that should be handled with a fast user-visible loop.
- CLI/provider details in root rules are operationally useful but partly duplicated with memory, increasing drift risk.
- No explicit rule says to clone a user-provided reference artifact's skeleton and only apply explicit diffs, even though this is now captured in a standalone memory file.

### MEMORY.md Index

The index says memory is for standing rules and durable environment/tool references only. It links:

- `memory-hygiene.md`
- `operating-protocol.md`
- `planning-discipline-and-voice.md`
- `orchestrator-delegate-never-self.md`
- `opencode-provider-access.md`
- `opencode-codex-cli-stdin-hang.md`
- `merge-authorization-dedrift.md`

Strengths:

- Clear distinction between memory and repo docs.
- Existing memory already warns that stale status memories caused real drift.
- Good role discipline and model-routing references.

Risks:

- `anti-drift-clone-reference.md` exists but is not linked in `MEMORY.md`, so the index is incomplete.
- Memory files carry historical narrative and incident detail. That is useful for human understanding, but it increases always-loaded token cost and can blur the line between durable rule and historical explanation.
- `opencode-provider-access.md` includes specific model catalogs and credential/key-location notes. Provider catalogs are temporally unstable, and key-location details are sensitive operational data. The durable part is "use opencode-go for worker agents and do not hardcode provider preferences into product runtime."
- Memory lacks a mandatory schema for `last_verified`, `scope`, `source`, `expiry/review`, and `supersedes`, so stale-memory review is manual and error-prone.

## Research Summary

Sources used:

- Anthropic Claude Code memory docs: https://code.claude.com/docs/en/memory
- AGENTS.md open format: https://agents.md/
- Cursor rules docs: https://cursor.com/docs/rules
- Anthropic multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Microsoft guidance on single-agent vs multi-agent systems: https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ai-agents/single-agent-multiple-agents
- OpenAI prompt caching docs: https://developers.openai.com/api/docs/guides/prompt-caching
- Anthropic prompt caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Prompt caching evaluation for long-horizon agents: https://arxiv.org/html/2601.06007v2
- Agent memory survey through early 2026: https://arxiv.org/html/2603.07670v1
- Mem0 memory staleness/decay guide: https://mem0.ai/blog/memory-decay-for-long-running-agents-how-recency-aware-ranking-fixes-retrieval-staleness
- Addy Osmani on specs for AI agents: https://addyosmani.com/blog/good-spec/
- Augment spec-driven workflow guide: https://www.augmentcode.com/guides/ai-spec-driven-development-workflows
- Augment single-agent vs multi-agent guide: https://www.augmentcode.com/guides/single-agent-vs-multi-agent-ai

Findings:

- Instruction files are context, not enforcement. Anthropic explicitly says CLAUDE.md and auto-memory are loaded every session but are not hard configuration; blocking actions require hooks. The docs recommend concise, specific, structured instructions, a target under 200 lines per CLAUDE.md, and periodic conflict review.
- AGENTS.md exists because agents need a predictable, dedicated place for build, test, and convention guidance separate from human README content. This supports keeping root rules crisp and agent-focused.
- Cursor and Claude-style rule systems both reward scoping: always-on rules should be minimal, while domain or path-specific rules should load only when relevant. Broad always-apply rules increase context cost and lower adherence.
- Memory best practice in current literature is a write-manage-read loop with filtering, contradiction handling, latency/cost budgets, and privacy governance. Staleness is a major failure mode; recency can help, but contradiction resolution still needs explicit application-level policy.
- Multi-agent systems are not free quality. Anthropic reports strong results for breadth-first research but also much higher token use, and notes coding tasks often have fewer truly parallel subtasks. Microsoft likewise recommends starting single-agent unless multi-agent criteria are actually met.
- Prompt caching makes stable prefixes economically valuable. OpenAI and Anthropic both document cost/latency benefits for repeated prompt prefixes, and 2026 research found 41-80 percent cost reductions in long-horizon agentic tasks when caching is structured well. This argues for stable rule prefixes, session resume, and avoiding needless cold-start replanning.
- Spec-driven work reduces drift by making a reviewed artifact the coordination surface. The spec/plan should become the source of truth, and implementation should be evaluated against it rather than re-inferring intent from chat history.

## Prioritized Changes

### P0. Add the anti-drift reference-cloning rule to always-loaded governance

Proposed `CLAUDE.md` addition, near "Design before doing":

> **ANTI-DRIFT: reference artifact rule.** When the user gives a reference design/artifact, clone its skeleton faithfully and apply only explicit diffs; never re-innovate structure each round. First extract the reference's block-by-block skeleton, treat that as the anchor, and make each iteration equal to `anchor + newest explicit user diffs`. If visual convergence is the task, show the user the result after at most one internal critique round before starting another redesign round.

Proposed `MEMORY.md` index addition:

> - [Anti-drift clone reference](anti-drift-clone-reference.md) - HARD RULE: when the user gives a reference design/artifact, clone its skeleton faithfully and apply only explicit diffs; never re-innovate structure each round

Rationale: the memory file already exists and captures a fresh failure mode from 2026-07-03, but the index omits it. The root `CLAUDE.md` should include a one-paragraph always-on version because this is a broad operating invariant, not a domain-specific preference.

Failure prevented: repeated redesign rounds drifting away from the user's anchor artifact, especially in UI/menu work where "improve" can accidentally become "invent again."

Rollout: low risk. This is already written in memory; the change only makes it discoverable and always visible.

### P0. Replace absolute delegation with quota-aware delegation thresholds

Proposed `CLAUDE.md` replacement for the first "NEVER do inline" bullet:

> **Delegate by cost and risk, not reflex.** The main thread must not absorb deep context or implementation. Delegate when a task requires reading more than 2-3 files, understanding a subsystem, writing/refining a plan or audit doc, doing online research beyond a quick fact check, implementing code in `src/` or `test/`, or running an independent verification pass. Inline is allowed for bounded orchestration work: dispatch prompts, command verification, git operations, small rule/doc edits requested by the user, and spot checks of 1-2 files needed to write a good delegate prompt.

Proposed `CLAUDE.md` quota section:

> **Quota efficiency.**
> - Spawn a frontier agent only for high-stakes planning, architecture, audits, cross-cutting changes, or research that needs multiple sources.
> - Do not spawn for a single-file explanation, a command lookup, a small documentation edit, or a visual/reference-design microdiff where the user needs to steer the next pixel-level change.
> - Use one frontier draft plus one adversarial challenge for high-stakes plans. After two internal design rounds, show the user the plan or the concrete tradeoff unless the second round found a blocking contradiction.
> - Resume an existing codex session for follow-up critique, plan revision, or implementation-question continuity when the prior session's assumptions are still valid and the repo state can be refreshed in the prompt.
> - Cold-start a new session when the topic changes, the prior session has stale assumptions, the repo moved significantly, or the old session exceeded its rollover limit.
> - Workers execute already-specified slices only. They do not invent architecture, rewrite scope, or replace frontier planning when codex quota is exhausted.

Rationale: current rules successfully prevent main-context bloat, but they lack concrete thresholds. Research supports multi-agent orchestration when subtasks are independent and context exceeds one agent, but warns about coordination and token overhead. Anthropic's multi-agent post also explicitly says coding tasks often have fewer parallel subtasks than research.

Failure prevented: wasting frontier quota on small tasks, spinning redundant agents, waiting for adversarial rounds on UI micro-adjustments, or promoting worker models into planning roles during quota pressure.

Rollout: medium risk. It changes the operating feel from "always delegate" to "delegate by threshold." User judgment needed because the user's current preference strongly favors an orchestrator-only main thread.

### P0. Formalize memory writes as an always-enforced schema and review gate

Proposed new memory rule, either as a replacement section in `memory-hygiene.md` or a new indexed memory:

> **Memory write gate - always enforced.** Before creating or updating memory, answer all five checks in the memory edit prompt or do not write it:
> 1. Is this a durable rule, durable preference, durable environment/tool reference, or explicit user instruction to remember?
> 2. Will this still be true or useful in 30 days without reading current repo state?
> 3. Is there an existing memory that should be updated instead of creating a new one?
> 4. Does it exclude project status, plans, findings, transient bugs, volatile model catalogs, credentials, secrets, and "what I just did"?
> 5. Did `MEMORY.md` get updated if and only if a new memory file was created?

Proposed required memory file format:

> ---
> name: short-kebab-name
> description: "One sentence: imperative rule or durable reference."
> metadata:
>   node_type: memory
>   type: feedback|reference
>   scope: repo|tool|user-preference
>   last_verified: YYYY-MM-DD
>   review_after: YYYY-MM-DD|none
>   supersedes: old-memory-name|none
> ---
>
> ## Rule
> One concise durable rule.
>
> ## Apply When
> Concrete triggers.
>
> ## Do Not Apply When
> Concrete exclusions.
>
> ## Verification
> How to verify this is still true before relying on it.

Rationale: current memory hygiene is strong but informal. Anthropic says auto-memory is context, not enforcement, and memory research emphasizes write filtering, contradiction handling, and privacy governance. A schema gives future agents something easy to audit.

Failure prevented: duplicate memories, stale provider/model facts, status memories, credentials in memory, and drift caused by unreviewed historical assumptions.

Rollout: low risk for new memories; medium risk for retrofitting old memories because summarizing incident-heavy memories may lose useful context unless reviewed by the user.

### P1. Split root `CLAUDE.md` into "non-negotiables" plus pointers

Proposed structure:

> # myshell-tools operating rules
>
> ## Non-negotiables
> - Main thread is the orchestrator; delegate deep reads, planning/audits, implementation, and independent verification by the thresholds below.
> - Frontier plans/audits use codex GPT-5.5. Workers use opencode-go and execute already-approved plans.
> - Claude Agent subagents require explicit user permission.
> - Memory is durable rules/references only. Repo docs are the source of truth for state.
> - Anti-drift: when a user provides a reference artifact, clone the skeleton and apply only explicit diffs.
>
> ## Delegation + Quota
> [quota section from P0]
>
> ## CLI Invocation
> [short stdin-closure rule plus pointer to memory `opencode-codex-cli-stdin-hang`]
>
> ## Source Of Truth
> - Current execution state lives in repo docs such as `docs/ROADMAP-STATUS.md`, `docs/HANDOFF.md`, and plan docs.
> - Durable operating policy lives in this file plus indexed memory.
> - If this file and memory conflict, stop and ask which rule to keep before proceeding.

Rationale: Claude Code docs recommend concise, structured files and periodic conflict review. Root rules should fit in one scan and avoid duplicating detailed reference material from memory.

Failure prevented: startup context bloat, arbitrary conflict resolution, outdated CLI/provider duplication, and reduced adherence from dense instructions.

Rollout: medium risk. Requires deciding which CLI details remain in root versus memory.

### P1. Add a source-of-truth and diff-application rule

Proposed `CLAUDE.md` addition:

> **Single source of truth.** At the start of each non-trivial task, name the governing artifact: user prompt, reference artifact, accepted plan doc, issue, PR, or status doc. Execution must apply diffs against that artifact instead of re-synthesizing the whole solution from chat memory. If the governing artifact is missing or contradictory, ask or create a short repo doc before implementation.

Proposed plan-doc rule:

> Every plan doc must include: governing artifact, explicit non-goals, required receipts, stop conditions, rollback/quarantine path, and what would count as drift.

Rationale: spec-driven work turns the plan/spec into coordination infrastructure and makes reviewers check conformance instead of reconstructing intent. This aligns with the repo's existing receipt-backed operating protocol.

Failure prevented: agents re-planning from stale chat context, patching against a remembered goal instead of the latest accepted artifact, and endless refinement without stop criteria.

Rollout: low risk.

### P1. Add design-round stop conditions

Proposed `CLAUDE.md` addition:

> **Design-round limits.** For high-stakes architecture: run one frontier draft and one adversarial challenge, then synthesize and show the user unless the challenge uncovered a concrete blocker. For UI/reference matching: do one implementation or mockup pass, one critique pass, then show the user. Do not run a third internal design round without a written reason: new hard constraint, failed verification, or user-requested deeper research.

Rationale: the existing setup values adversarial planning, but without a stop rule it can become expensive and slow. Anthropic's multi-agent guidance says explicit effort-scaling rules prevented overinvestment in simple queries.

Failure prevented: hidden over-planning, quota burn, and late user feedback after several internal rounds drift in the wrong direction.

Rollout: low risk.

### P2. Trim or quarantine unstable provider/model details from memory

Proposed edit to `opencode-provider-access.md`:

> Keep in always-loaded memory:
> - `opencode-go` is the dev worker provider for this repo.
> - Product runtime must remain provider-agnostic.
> - Zen is not a free fallback unless the user confirms funding.
> - Verify the model catalog with `opencode models` before relying on a specific model list.
>
> Move out of always-loaded memory:
> - Full model catalog snapshots.
> - Credential/key backup paths.
> - Historical key-paste notes.

Rationale: model catalogs and funding state are unstable. Credential locations should not be repeatedly injected as background context unless absolutely required for safe operation.

Failure prevented: stale routing decisions, accidental leakage of sensitive operational details, and agents assuming a model catalog that has changed.

Rollout: needs user judgment. The current memory is operationally convenient, but always-loading credential path details is a security and drift tradeoff.

### P2. Add periodic rules/memory review

Proposed `CLAUDE.md` or memory hygiene addition:

> **Rules/memory review cadence.** Once per milestone or whenever a rule conflict is observed, audit `CLAUDE.md`, `MEMORY.md`, and indexed memory for duplicates, stale provider facts, missing index entries, and rules that belong in repo docs. Produce a proposal doc first; do not edit rules/memory unless the user approves.

Rationale: Anthropic docs recommend periodic review for outdated or conflicting instructions. The current memory set is small enough for this to be cheap.

Failure prevented: silent rule rot and index drift.

Rollout: low risk.

## Quota-Efficiency Rules

### Delegate vs Inline

Delegate to frontier when any trigger is true:

- More than 2-3 files must be read to understand the problem.
- The work is an audit, architecture plan, design plan, root-cause investigation, or multi-source research.
- The decision could cause rework across multiple modules.
- The user asked for "10/10", "adversarial", "audit", "research", "plan", or "what should we do."
- The output should be a durable repo doc.

Delegate to worker when all are true:

- A reviewed plan or explicit patch objective exists.
- The task is implementation, tests, or mechanical edits in `src/` or `test/`.
- The worker can complete in an isolated slice with verification commands.

Do inline when all are true:

- The task is bounded to command execution, git ops, verification, dispatching, summarizing, or a small doc/rule proposal edit.
- No production code or test file edit is needed.
- The context read is 1-2 files or less.
- The answer will not benefit from an independent frontier pass.

Do not spawn when:

- The user needs immediate visual steering on a reference UI diff.
- The task is a single command result or small explanation.
- You already have an active frontier session with valid context that can be resumed.
- The next useful action is verification, not more planning.
- The plan's only uncertainty is user preference.

### Resume vs Cold Start

Resume a frontier session when:

- Same goal, same governing artifact, and the follow-up is critique/revision/continuity.
- The repo state can be refreshed with a short preface.
- The prior session contains expensive context that would be wasteful to reload.

Cold-start when:

- The task changed materially.
- The previous session's assumptions are known stale.
- The old context accumulated obsolete plans or conflicting instructions.
- The prior session exceeded the project's rollover policy or cannot be resumed reliably.

### Adversarial Design Rounds

Default:

- High-stakes architecture or operating-policy change: one draft frontier round plus one challenge round.
- Normal implementation plan: one frontier plan, no challenge unless the plan is ambiguous or high blast-radius.
- UI/reference matching: one pass plus one critique, then user review.
- After two internal rounds, show the user unless a concrete blocker remains.

Stop iterating when:

- The plan has a named governing artifact, explicit non-goals, receipts, rollback, and drift checks.
- Remaining questions are preference choices, not technical blockers.
- Verification evidence is sufficient for the current slice.
- Another round would re-synthesize instead of applying diffs.

## Memory-Creation Rules

Always capture:

- Repeated user corrections that imply a durable rule.
- Explicit "remember this" instructions, after filtering for durability and safety.
- Stable tool invocation facts that repeatedly prevent failure.
- Durable provider/access distinctions that affect orchestration.
- Merge/authorization policies with scope, date, and exact limits.
- Anti-drift rules learned from a recurring failure mode.

Never capture:

- Project status, current bugs, audit findings, plan contents, progress, or "what I just did."
- Secrets, API keys, raw credential paths unless the user explicitly approves a security tradeoff.
- Volatile provider model catalogs without a review date.
- Facts that can be read from repo docs, git, PRs, CI, or package files.
- One-off preferences that were not repeated or explicitly marked durable.
- Long incident narratives in always-loaded memory.

Required format:

- YAML frontmatter with `name`, `description`, `type`, `scope`, `last_verified`, `review_after`, and `supersedes`.
- A one-paragraph rule.
- `Apply When`, `Do Not Apply When`, and `Verification` sections.
- Link from `MEMORY.md` for every new memory file.
- Prefer updating an existing memory over creating a near-duplicate.

Enforcement note:

Because Claude memory is context rather than hard configuration, "always enforced" means the agent must treat this as a mandatory pre-write gate. If the Claude Code environment supports hooks for memory writes, enforce the gate there too.

## Remove Or Trim From Current CLAUDE.md

Do not remove the orchestrator/frontier/worker policy. Trim or move only duplicated operational detail.

Proposed trims:

1. Replace repeated "NEVER inline" language with the threshold-based delegation rule. Keep the bright-line ban on main-thread production code/test edits.
2. Shorten the codex/opencode invocation section in `CLAUDE.md` to the invariant: close stdin with `</dev/null`, use Bash/git-bash style invocation, and see the indexed memory for the full gotcha log.
3. Move Linux bwrap incident detail out of root `CLAUDE.md` and leave only "codex sandbox modes are broken in the Linux cloud container as of 2026-06-30; see memory for verification log." Root rules should not carry the whole incident.
4. Make adversarial planning conditional: required for high-stakes architecture and audits, not for every design iteration or small proposal.
5. Add conflict handling: if `CLAUDE.md`, `MEMORY.md`, and repo docs disagree, stop and ask which source wins.

## Safe Rollout

Low-risk changes:

- Link `anti-drift-clone-reference.md` from `MEMORY.md`.
- Add the one-paragraph anti-drift rule to `CLAUDE.md`.
- Add source-of-truth/diff-application rule.
- Add design-round stop conditions.
- Add "proposal doc first" review cadence.
- Add memory schema for new memories only.

Needs user judgment:

- Replacing absolute delegation language with threshold-based delegation.
- Trimming CLI incident details from root `CLAUDE.md`.
- Removing credential/key-location details from memory.
- Retrofitting old memory files into the stricter schema.
- Deciding whether model catalogs belong in memory at all or in a repo-maintained provider reference doc.

Suggested rollout order:

1. Apply low-risk anti-drift and index fixes.
2. Add quota/delegation thresholds without deleting the old bright-line code-edit ban.
3. Add memory schema for future writes.
4. Review provider-access memory with the user because it touches security and operational convenience.
5. Do a second pass to trim root `CLAUDE.md` after one week of use.

## Top Five Proposed Changes

1. Add the anti-drift reference-artifact rule to `CLAUDE.md` and link `anti-drift-clone-reference.md` from `MEMORY.md`.
2. Replace blanket "never inline" language with explicit delegate-vs-inline and resume-vs-cold thresholds while preserving the production-code edit ban.
3. Add a mandatory memory write schema and pre-write gate with `last_verified`, `review_after`, exclusions, and index-update rules.
4. Make adversarial design rounds quota-aware: one draft plus one challenge for high-stakes work, then show the user unless a blocker remains.
5. Trim unstable or sensitive provider/model/credential details out of always-loaded memory and move them to on-demand repo docs or verification commands.
