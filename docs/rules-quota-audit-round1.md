# Rules + Quota Audit Round 1

Date: 2026-07-03

Scope: adversarial round-1 audit of the current operating rules, memory admission rules, quota/delegation thresholds, anti-drift rule, auto parallel orchestration rule, model-capability reference, and the highest-priority issue: Claude/Opus quota burn and orchestrator context bloat.

Inputs read:

- `CLAUDE.md`
- `docs/HANDOFF.md`
- `docs/rules-memory-10of10-plan.md`
- `docs/operating-protocol-10of10.md`
- Memory index: `C:/Users/Josh/.claude/projects/C--Users-Josh-Desktop-Github-Repositories-myshell-tools/memory/MEMORY.md`
- Indexed memory files that exist: `memory-hygiene.md`, `operating-protocol.md`, `planning-discipline-and-voice.md`, `orchestrator-delegate-never-self.md`, `opencode-provider-access.md`, `opencode-codex-cli-stdin-hang.md`
- Current local model list from `opencode models </dev/null`

Critical input failure: `MEMORY.md` links `merge-authorization-dedrift.md`, but that file does not exist. The index is asserting an always-loaded rule that cannot be inspected. That is not harmless. It is governance drift.

## Executive Verdict

The current rule system is philosophically right but operationally leaky. It says "orchestrator only" while leaving enough ambiguity for Claude/Opus to burn expensive tokens in four ways:

1. Main-thread "spot checks" can silently become subsystem reads.
2. Agents can return verbose reports that dump their context back into the orchestrator.
3. "Adversarial planning" can become default Opus use instead of a gated exception.
4. Model and provider facts are treated as stable memory even though they are volatile and partly sensitive.

The biggest problem is not missing reminders. The biggest problem is that the rules lack hard budgets: max files, max lines, max returned words, max internal rounds, when Opus is forbidden, and what exact one-line agent statuses are allowed.

The operating-protocol doc already contains many of the right anti-bloat primitives. `CLAUDE.md` fails to import them into the always-read rules. Until it does, future agents can obey the letter of the rules while bloating the main context anyway.

## Target 0: Orchestrator Claude/Opus Quota Burn + Context Bloat

### Brutal Findings

#### OQ-1. "Quick spot-check" is gameable.

Current `CLAUDE.md` allows a quick "2 files" spot-check. Current memory says a "`<=~2-file spot-check`" is OK. That still leaks because:

- Two large files can be 3,000-6,000 lines.
- Two files plus `rg` plus a plan doc plus memory can easily exceed 15k-25k tokens before any agent is spawned.
- The phrase "to ground a dispatch" is subjective. A weak agent can claim every extra read is needed to make the prompt better.

Concrete failure mode: Claude reads `CLAUDE.md`, `HANDOFF.md`, `rules-memory-10of10-plan.md`, all memory files, one protocol doc, then starts "spot-checking" code. That is no longer orchestration; it is an inline audit. This very task intentionally required a large read, proving that explicit user exceptions need their own handling.

Hardening: use both file count and line/token ceilings, and require delegation after either threshold.

#### OQ-2. "Agents return short summary + doc path" is too vague.

"Short" has no enforcement value. Agents will return 600-2,000 words because that feels responsible. Four workers returning "short" reports at 1,200 words each inject roughly 6k-8k tokens into the orchestrator before the user sees anything. A frontier challenge returning a full narrative can inject 5k-10k tokens.

Concrete failure mode: one frontier draft, one Opus challenge, two workers, and one verifier each return "summaries" of 500-1,500 words. The orchestrator absorbs 5k-15k avoidable tokens even though every agent also wrote repo docs.

Hardening: agent stdout must use fixed status lines or <=120-word summaries unless explicitly requested.

#### OQ-3. Opus is simultaneously "last resort" and "default adversarial challenger."

Contradiction:

- `CLAUDE.md`: Claude `Agent` subagents are "last resort only, and only with the user's explicit permission."
- Memory `orchestrator-delegate-never-self.md`: design phase equals "one frontier model drafts, another (Claude Opus agent) challenges it with online research."
- `CLAUDE.md`: "Planning/design/audit => a FRONTIER agent (gpt-5.5 via codex, or a Claude Opus agent when challenging/diversity is wanted)."

This is a quota trap. "Diversity is wanted" can be invoked for nearly any high-stakes task. The rule appears strict, but the loophole is wide enough to drive Opus through by default.

Concrete failure mode: every policy/design task gets gpt-5.5 plus Opus because "adversarial" implies model diversity. If each round reads 20k-40k prompt tokens and emits 3k-8k output tokens, two unnecessary Opus rounds can burn the equivalent of an entire useful coding session's context budget without touching code.

Hardening: Opus must be a human-gated escalation with named trigger, budget, and return cap. The default adversarial challenger should be gpt-5.5 resume/cold session or another non-Claude frontier route only if available and approved by cost policy.

#### OQ-4. "Design before doing" has no stop condition in `CLAUDE.md`.

The plan doc proposes a two-round cap, but `CLAUDE.md` does not enforce it. Without a stop rule, "one more challenge" is always defensible.

Concrete failure mode: draft -> challenge -> synthesis -> second challenge -> model capability research -> rewritten plan -> user finally sees it after the internal team has spent 30k-100k tokens and possibly drifted from the user's actual preference.

Hardening: one draft plus one challenge for high-stakes work; after that, show the user unless a concrete blocker exists.

#### OQ-5. The root rules allow direct rule/memory/doc edits while banning inline plan/audit docs.

The current split says:

- Never inline: "writing/refining a plan or design doc, doing the audit/research."
- Orchestrator may do directly: "edit rules/memory/CLAUDE.md."

This is a contradiction for exactly this workstream. A rules audit doc is both an audit/design doc and a rules/doc edit. Future agents can rationalize either path.

Hardening: distinguish "control-plane mechanical edits" from "control-plane analysis." The orchestrator may apply already-approved text. It may not author high-stakes policy analysis inline unless the user explicitly assigns the main thread to do it.

#### OQ-6. Memory is always-loaded but not budgeted.

The memory files contain useful incident detail, but several are narrative-heavy:

- `operating-protocol.md` summarizes a whole adversarial review.
- `orchestrator-delegate-never-self.md` includes two full incident narratives.
- `opencode-provider-access.md` includes CLI auth paths, key backup location, model catalog snapshots, and funding notes.

Concrete failure mode: every future session pays for dated incident history and volatile provider facts even when the task is a one-line verification command.

Hardening: keep incident details in repo docs; memory should retain only the imperative rule, triggers, exclusions, and verification command.

#### OQ-7. The local model catalog has already drifted from memory.

`opencode-provider-access.md` lists Go models including `qwen3.7-max` and `qwen3.7-plus`, and says Zen-only models fail due insufficient balance. Current `opencode models` includes a broader catalog, including `opencode-go/qwen3.6-plus`, `opencode/gpt-5.5`, and multiple Claude Opus variants. The existence of models is not the same as funded access, but the catalog is visibly moving.

Concrete failure mode: a future agent picks a stale model from memory, or assumes a listed model is suitable/funded without checking `opencode models` and a smoke call.

Hardening: memory may name provider classes and verification commands, not a supposedly durable full capability table.

### Anti-Opus-Bloat Mechanisms

These are the minimum mechanisms that should become root rules:

- Main-thread read cap: no more than 2 files and no more than 400 total lines for dispatch grounding, excluding explicitly requested rules/memory audits.
- Main-thread output cap while orchestrating: no agent result pasted into Claude over 120 words unless it is a human gate or failure excerpt.
- Agent stdout contract: one of `DOC`, `READY`, `BLOCKED`, `REJECTED`, `GATE`, `MERGED`, with path(s). No raw logs.
- Frontier round cap: one draft plus one adversarial challenge for high-stakes policy/architecture; no third round without a written blocker.
- Opus gate: Claude Opus/Agent use requires explicit user approval in the current turn, with reason, expected cost class, max input docs, and max return size.
- Worker cap: workers return changed files, commands, and receipt path only. Full explanation goes to repo doc.
- Research cap: if online research is required, the agent writes source notes to a repo doc and returns only conclusions + path.
- Memory cap: new memory must be <=250 words after frontmatter unless the user explicitly approves a longer durable reference.

## Target 1: Memory-Admission 7-Point Ruleset

### Brutal Findings

#### M1. "Category fit" is underspecified for authorization rules.

The proposed category rule allows standing rules and durable references. But merge authorization, hook policy, quota authority, and model funding status are hybrid policy/state. The missing `merge-authorization-dedrift.md` proves the danger: the index claims a durable authorization rule, but the source file was removed. Does authorization still exist? The repo handoff says yes. Memory says yes by broken link. The file says nothing because it is gone.

Failure mode: future sessions self-merge based on a handoff line or broken index without inspecting exact scope.

Hardening: authorization memories need stricter fields: `authority`, `scope`, `expires_or_review_after`, `revocation_source`, and `exact_allowed_actions`.

#### M2. "Durable for a month" is too weak for provider/model/funding facts.

Model catalogs, subscription funding, and credential locations can change in minutes. A month-long durability test is unacceptable for these. They need "verify at use" behavior, not "remember and trust."

Failure mode: "Zen unfunded" or "Go has model X" becomes stale and causes either failed runs or silent expensive runs.

Hardening: provider memory should store the verification command and default policy, not a full model list as truth.

#### M3. "Non-derivable" conflicts with memory that duplicates repo docs.

`operating-protocol.md` says read `docs/operating-protocol-10of10.md` and then restates many of its rules. This is partly useful, but it violates the non-derivable test if applied strictly.

Failure mode: duplicate versions drift. A future edit to the repo protocol does not update memory, and the always-loaded summary wins by recency or salience.

Hardening: memory may contain a compact pointer plus the hard invariant, not detailed restatement.

#### M4. "Concrete benefit" must include failure mode, not just benefit.

A memory that says "helps future sessions use models correctly" is too easy. It should name the exact future mistake it prevents.

Failure mode: broad memories accumulate because every note can claim a benefit.

Hardening: require "prevents this failure" in one sentence.

#### M5. "Not sensitive" is currently violated.

`opencode-provider-access.md` contains auth file paths, raw key backup path, and notes that a key was pasted in chat. It does not include the key itself, but it repeatedly injects credential-location detail into every session.

Failure mode: unnecessary exposure surface and future agents treating credential paths as normal context to copy into prompts/docs.

Hardening: move credential path details to a local secure runbook or keep only "auth exists; verify with `opencode auth list` or a smoke run."

#### M6. "Explicitly sanctioned" must distinguish write approval from standing authorization.

The hook asks before memory writes. That does not mean the memory content itself has been policy-approved. A user may approve a file edit because it is proposed, not because every downstream behavior is authorized.

Failure mode: a memory write gate becomes laundering for a broad policy change.

Hardening: memory frontmatter should include `approved_by_user: YYYY-MM-DD` and `approval_scope`.

#### M7. "Well-formed" is too shallow.

Frontmatter + links + index entry does not handle contradictions, expiry, supersession, or missing files.

Failure mode: the current broken index would pass the old "well-formed" test at creation time and then rot.

Hardening: require an index integrity check after memory changes and periodic review.

### Proposed Final CLAUDE.md Text: Memory Admission

Replace any loose memory-write guidance with this exact block:

```md
## Memory Admission Gate

Memory is for durable operating rules and durable tool/environment references only. Project status, plans, findings, current bugs, audit results, progress, and "what I just did" go in repo docs, never memory.

Before creating or updating memory, the candidate must pass all seven checks:

1. Category fit: standing rule, durable user preference, durable authorization, or durable tool/environment reference. Status/plans/findings are rejected.
2. Durability: expected to remain useful for at least 30 days. Provider catalogs, funding state, and credentials are "verify at use," not durable facts.
3. Non-derivable: not already available from code, git, package files, CLAUDE.md, or repo docs. If a repo doc is source of truth, memory may only hold a compact pointer plus the invariant.
4. Concrete failure prevented: the memory names the exact future mistake it prevents.
5. Safety: no secrets, raw credential paths, pasted-key history, volatile model catalogs, or sensitive operational detail unless the user explicitly approves that security tradeoff.
6. Explicit sanction: the user approved this memory content and scope, not merely the act of editing a file.
7. Well-formed and indexed: required frontmatter, Apply When, Do Not Apply When, Verification, and exactly one `MEMORY.md` index entry for each memory file.

Authorization memories also require: authority, scope, allowed actions, forbidden actions, approval date, review_after, and revocation source.

After any memory edit, verify `MEMORY.md` links resolve. A broken memory index is a rules failure.
```

### Proposed Memory File Schema

```md
---
name: short-kebab-name
description: "One sentence: the durable rule/reference and the failure it prevents."
metadata:
  node_type: memory
  type: feedback|reference|authorization
  scope: repo|tool|user-preference|authorization
  approved_by_user: YYYY-MM-DD
  approval_scope: "Exact scope approved."
  last_verified: YYYY-MM-DD
  review_after: YYYY-MM-DD|none
  supersedes: old-memory-name|none
---

## Rule

One concise durable rule or reference.

## Apply When

Concrete triggers.

## Do Not Apply When

Concrete exclusions.

## Verification

How to verify this is still true before relying on it.
```

## Target 2: Quota/Delegation Thresholds

### Brutal Findings

#### Q1. The current delegate-vs-inline rule is both too strict and too loose.

Too strict: it says never inline audits/plans/research, but allows direct edits to rules/memory/CLAUDE.md. That makes routine policy edits ambiguous.

Too loose: it allows "quick spot-checks" without line caps and allows rule edits without distinguishing applying approved text from authoring new governance.

Failure mode: Claude either over-delegates tiny tasks and wastes frontier quota, or self-authors high-stakes policy under the "edit rules" exception.

#### Q2. "Use codex quota until it runs out" is bad budget policy.

The memory says use codex quota until it runs out and wait for reset. That is a role-separation policy masquerading as quota policy. Good quota policy is not "spend until empty"; it is "spend when the task value exceeds the cost."

Failure mode: low-value plan refinements consume scarce frontier budget, then a real architectural blocker has to wait.

#### Q3. Resume-vs-cold lacks a hard rollover limit.

The plan says resume when prior assumptions are valid and cold-start when stale. That is subjective. Long-lived frontier sessions become second orchestrators with stale assumptions.

Failure mode: resuming a gpt-5.5 session preserves old context that predates the newest `HANDOFF.md` or rule changes; the model argues from stale state.

Hardening: resume only for same governing artifact and after repo-state refresh; force cold start after a set number of major turns, state changes, or if the governing artifact changed.

#### Q4. Workers are not prevented from returning plans.

Rules say workers execute, but the stdout/output contract does not ban "I found a better approach..." essays.

Failure mode: opencode-go worker becomes a cheap planner by returning design arguments. The orchestrator absorbs them and accidentally lets worker architecture drive the project.

Hardening: worker output format must reject new scope and route design concerns to `BLOCKED`.

### Proposed Final CLAUDE.md Text: Orchestrator Discipline + Quota

Replace the current `## ORCHESTRATOR DISCIPLINE` section with this exact text:

```md
## ORCHESTRATOR DISCIPLINE (read first)

The main Claude Code conversation is an orchestrator, not a worker, planner, researcher, or reviewer. Its job is to launch the right role, keep the control plane small, surface human gates, run mechanical verification/git commands, and report receipts.

### Main-thread hard caps

- Dispatch grounding cap: read at most 2 files AND at most 400 total lines before delegating. `rg`/file lists are allowed to find the right target, but reading more content crosses the line.
- Main-thread output cap: do not paste agent logs, raw diffs, full plans, full research notes, or long command output into chat. Put depth in repo docs and return paths.
- Main-thread edit cap: direct edits are allowed only for control-plane docs/rules/hooks when the user explicitly requested this main thread to do that edit, or when applying already-approved text. Production code and tests are never edited in the main thread.

### Delegate vs inline

Delegate to a frontier planner/auditor when any trigger is true:
- More than 2 files or 400 lines must be read.
- The task is an audit, architecture plan, root-cause investigation, policy design, or multi-source research.
- The output should be a durable plan/findings doc.
- The decision can cause cross-module rework, cost, security, default behavior, release, or protocol risk.

Delegate to opencode-go workers when all are true:
- A reviewed plan, contract, or explicit patch objective exists.
- The work is implementation, tests, or mechanical edits.
- The slice can be isolated by allowed files/modules and verified by commands.

Do inline only for:
- Dispatch prompts, status routing, user gate questions, git ops, verification commands, concise summaries, and bounded control-plane edits.
- Spot checks within the hard caps above.
- Single-command answers or small explanations that do not need repo-wide context.

Never inline:
- Editing `src/` or `test/`.
- Reading a subsystem to understand it.
- Writing high-stakes plan/audit/research docs unless the user explicitly assigns the main thread to do that work.
- Reviewing an implementation by absorbing the full diff/log into Claude instead of requiring receipts.

### Agent return-size contract

Agents must write full output to repo docs/receipts and return only one of these forms:

- `DOC <topic> path=<path> summary=<120 words max>`
- `READY <slice> head=<sha> receipts=<paths>`
- `BLOCKED <slice/topic> reason=<one sentence> details=<path>`
- `REJECTED <slice> reason=<one sentence> receipt=<path>`
- `GATE <topic> decision=<one sentence> context=<path>`
- `MERGED <slice> merge=<sha/pr> receipts=<paths>`

If an agent needs more than 120 words in chat, it must write a doc and return the path.

### Frontier and Opus quota

- Default frontier planner/auditor: `codex exec -m gpt-5.5 -c model_reasoning_effort=high`.
- Use frontier quota only for high-stakes planning, architecture, audits, root cause, policy, or research. Do not spend it on small command answers, tiny doc edits, or preference-only UI tweaks.
- High-stakes default: one frontier draft plus one adversarial challenge, then synthesize and show the user unless the challenge found a concrete blocker.
- No third internal planning/challenge round without a written blocker: new hard constraint, failed verification, source conflict, or user-requested deeper research.
- Claude Opus / Claude Agent subagents are expensive-path exceptions. Use them only with explicit user approval in the current turn, after stating: why gpt-5.5/opencode-go is insufficient, expected input docs, max return size, and what decision the Opus pass will change.

### Resume vs cold start

Resume an existing frontier session only when the same goal, same governing artifact, and same branch/worktree still apply. The resume prompt must include a compact repo-state refresh and the changed facts since the prior turn.

Cold-start a new frontier session when the governing artifact changed, repo state moved materially, prior assumptions are stale, the old session accumulated conflicting plans, or the follow-up is a different decision.

Workers never become planners because frontier quota is low. If planning is blocked by quota, mark `BLOCKED: planner-quota` and ask/wait.
```

## Target 3: Anti-Drift Rule

### Brutal Findings

#### D1. The rule is correct but not operational enough.

"Clone the skeleton" is strong language, but a future agent can still claim it cloned the skeleton without showing the extracted skeleton.

Failure mode: agent uses the reference as inspiration, keeps two superficial elements, and invents a new structure. This is exactly the menu churn failure.

Hardening: require an explicit skeleton extraction before proposing changes.

#### D2. "Apply only explicit diffs" needs a conflict rule.

User diffs can be incomplete, contradictory, or impossible within the reference skeleton. The rule needs a stop condition.

Failure mode: agent silently fills gaps with invention, then claims the missing details were implied.

Hardening: if the diff is incomplete, ask or mark assumptions; do not redesign.

#### D3. The anti-drift memory is absent from the index.

`docs/HANDOFF.md` says the anti-drift memory was removed after user objection and should be re-added only if approved. `docs/rules-memory-10of10-plan.md` says it exists but is not linked. The actual memory directory does not contain it. The governance docs disagree.

Failure mode: future sessions argue from a nonexistent memory file.

Hardening: put the rule in `CLAUDE.md` first; add memory only through the approval gate later.

### Proposed Final CLAUDE.md Text: Anti-Drift

Add this exact block near the top:

```md
## Anti-Drift: Reference Artifact Rule

When the user provides a reference design, artifact, workflow, layout, API shape, or example output, treat it as the governing artifact. Clone its skeleton faithfully and apply only the user's explicit diffs.

Required process:
1. Extract the reference skeleton: ordered sections, hierarchy, labels, controls, data columns, states, and interaction flow.
2. Name the explicit user diffs.
3. Implement or specify `reference skeleton + explicit diffs`.
4. Do not re-synthesize, modernize, embellish, split, merge, or "improve" structure unless the user explicitly asks.

If the requested diff conflicts with the reference, stop and ask or write the conflict in the plan. Missing detail is not permission to invent a new structure.
```

## Target 4: Auto Parallel-Orchestration + Model-Capability Reference

### Brutal Findings

#### P1. "Default to parallelism" is dangerous without conflict domains.

The proposed rule says parallelism is safe when tasks are independent and have no shared-file conflicts. That is not enough. Two tasks can edit different files and still collide through shared state, CLI behavior, config schema, tests, migrations, or UI copy.

Failure mode: one worker changes state shape while another changes UI assumptions. Both pass local tests; integration breaks.

Hardening: require conflict domains, not just file paths.

#### P2. "Automatic when safe" can become "parallel by default to look efficient."

Parallelism has overhead: dispatch prompts, receipts, merge coordination, conflict resolution, and verification. For small tasks, parallel workers waste tokens and increase failure surfaces.

Failure mode: a two-file doc cleanup spawns three workers, each returns context, and Claude spends more reading summaries than doing the work.

Hardening: parallel only when at least two slices each exceed inline/worker threshold and have distinct conflict domains.

#### P3. The fallback rule is under-gated.

"If opencode is unavailable, pause and ask before spending gpt-5.5 or Claude Agent worker quota" is good. It needs one more clause: do not convert execution into planning because workers are down.

Failure mode: opencode unavailable -> Claude asks to use gpt-5.5 as worker -> frontier writes code or creates a new plan instead of executing a bounded patch.

Hardening: expensive fallback needs task role, max spend, and whether it will edit code.

#### P4. "Model capability reference" risks becoming stale pseudo-science.

The local `opencode models` list is a catalog, not a benchmark. It does not prove reasoning quality, coding reliability, context size, price, or funding. Provider marketing pages would not be durable enough either.

Failure mode: memory says "model X is strongest" long after the catalog or model behavior changed.

Hardening: store a routing policy and verification method, not a permanent ranking. If rankings are needed, keep them in a repo doc with `last_verified`, smoke tests, and review date.

### Current Local Model Catalog Snapshot

Verified with `opencode models </dev/null` on 2026-07-03. Relevant Go worker models currently listed:

- `opencode-go/deepseek-v4-flash`
- `opencode-go/deepseek-v4-pro`
- `opencode-go/glm-5.1`
- `opencode-go/glm-5.2`
- `opencode-go/kimi-k2.6`
- `opencode-go/kimi-k2.7-code`
- `opencode-go/mimo-v2.5`
- `opencode-go/mimo-v2.5-pro`
- `opencode-go/minimax-m2.7`
- `opencode-go/minimax-m3`
- `opencode-go/qwen3.6-plus`
- `opencode-go/qwen3.7-max`
- `opencode-go/qwen3.7-plus`

This should not be copied into always-loaded memory as durable truth. The durable memory should say to verify with `opencode models` and a smoke run.

### Proposed Final CLAUDE.md Text: Auto Parallel Orchestration

Add this exact block:

```md
## Auto Parallel Orchestration

Use parallel workers automatically only when parallelism is actually safe and cheaper than serial coordination.

Parallelize when all are true:
- There are at least two independent execution slices.
- Each slice has a written objective, allowed files/modules, verification command, and conflict domain.
- The slices do not share files, state schemas, migrations, CLI commands, provider routing, persistence, UI flow, tests that mutate the same fixtures, or release/default behavior.
- Failure in one slice will not invalidate the other slice's assumptions.
- The merge order and integration check are explicit.

Serialize when any are true:
- Shared files or shared conflict domain.
- One slice defines an API/schema/state shape another consumes.
- User-visible UX flow may drift if split.
- Verification requires the combined result.
- The task is small enough that worker dispatch overhead exceeds the work.

Default worker path: `opencode-go` models. Use cheap capable workers for mechanical edits and stronger Go reasoners for complex implementation inside an already-specified contract.

If opencode is unavailable, pause and ask before spending gpt-5.5 or Claude/Opus quota on execution. The gate must state the role, expected cost class, whether code will be edited, and the return-size cap. Never promote workers into planners or Claude into implementer because the preferred delegate is down.
```

### Proposed Final CLAUDE.md Text: Model Routing Reference

Add this exact block:

```md
## Model Routing

Do not trust stale model catalogs from memory. Before choosing a specific opencode model for a non-trivial run, verify availability with `opencode models </dev/null`.

Routing policy:
- Frontier planning/audit/root-cause/policy: codex gpt-5.5 high reasoning by default.
- Adversarial challenge: another frontier pass by default; Claude Opus only with explicit current-turn user approval.
- Worker execution: opencode-go.
- Cheap mechanical worker default: `opencode-go/deepseek-v4-flash` or the current cheapest capable Go model verified by smoke run.
- Stronger worker for complex bounded implementation: `opencode-go/deepseek-v4-pro`, `opencode-go/glm-5.2`, or the current strongest Go worker verified by smoke run.

Model capability notes belong in a dated repo doc or receipt, not always-loaded memory, unless they are framed as "verify at use."
```

## Proposed Final CLAUDE.md Patch Set

This is the consolidated text I would install after round-2 approval. It intentionally removes ambiguity and imports the receipt/status caps from the operating protocol.

```md
# myshell-tools -- operating rules

## ORCHESTRATOR DISCIPLINE (read first)

The main Claude Code conversation is an orchestrator, not a worker, planner, researcher, or reviewer. Its job is to launch the right role, keep the control plane small, surface human gates, run mechanical verification/git commands, and report receipts.

### Main-thread hard caps

- Dispatch grounding cap: read at most 2 files AND at most 400 total lines before delegating. `rg`/file lists are allowed to find the right target, but reading more content crosses the line.
- Main-thread output cap: do not paste agent logs, raw diffs, full plans, full research notes, or long command output into chat. Put depth in repo docs and return paths.
- Main-thread edit cap: direct edits are allowed only for control-plane docs/rules/hooks when the user explicitly requested this main thread to do that edit, or when applying already-approved text. Production code and tests are never edited in the main thread.

### Delegate vs inline

Delegate to a frontier planner/auditor when any trigger is true:
- More than 2 files or 400 lines must be read.
- The task is an audit, architecture plan, root-cause investigation, policy design, or multi-source research.
- The output should be a durable plan/findings doc.
- The decision can cause cross-module rework, cost, security, default behavior, release, or protocol risk.

Delegate to opencode-go workers when all are true:
- A reviewed plan, contract, or explicit patch objective exists.
- The work is implementation, tests, or mechanical edits.
- The slice can be isolated by allowed files/modules and verified by commands.

Do inline only for:
- Dispatch prompts, status routing, user gate questions, git ops, verification commands, concise summaries, and bounded control-plane edits.
- Spot checks within the hard caps above.
- Single-command answers or small explanations that do not need repo-wide context.

Never inline:
- Editing `src/` or `test/`.
- Reading a subsystem to understand it.
- Writing high-stakes plan/audit/research docs unless the user explicitly assigns the main thread to do that work.
- Reviewing an implementation by absorbing the full diff/log into Claude instead of requiring receipts.

### Agent return-size contract

Agents must write full output to repo docs/receipts and return only one of these forms:

- `DOC <topic> path=<path> summary=<120 words max>`
- `READY <slice> head=<sha> receipts=<paths>`
- `BLOCKED <slice/topic> reason=<one sentence> details=<path>`
- `REJECTED <slice> reason=<one sentence> receipt=<path>`
- `GATE <topic> decision=<one sentence> context=<path>`
- `MERGED <slice> merge=<sha/pr> receipts=<paths>`

If an agent needs more than 120 words in chat, it must write a doc and return the path.

### Frontier and Opus quota

- Default frontier planner/auditor: `codex exec -m gpt-5.5 -c model_reasoning_effort=high`.
- Use frontier quota only for high-stakes planning, architecture, audits, root cause, policy, or research. Do not spend it on small command answers, tiny doc edits, or preference-only UI tweaks.
- High-stakes default: one frontier draft plus one adversarial challenge, then synthesize and show the user unless the challenge found a concrete blocker.
- No third internal planning/challenge round without a written blocker: new hard constraint, failed verification, source conflict, or user-requested deeper research.
- Claude Opus / Claude Agent subagents are expensive-path exceptions. Use them only with explicit user approval in the current turn, after stating: why gpt-5.5/opencode-go is insufficient, expected input docs, max return size, and what decision the Opus pass will change.

### Resume vs cold start

Resume an existing frontier session only when the same goal, same governing artifact, and same branch/worktree still apply. The resume prompt must include a compact repo-state refresh and the changed facts since the prior turn.

Cold-start a new frontier session when the governing artifact changed, repo state moved materially, prior assumptions are stale, the old session accumulated conflicting plans, or the follow-up is a different decision.

Workers never become planners because frontier quota is low. If planning is blocked by quota, mark `BLOCKED: planner-quota` and ask/wait.

## Anti-Drift: Reference Artifact Rule

When the user provides a reference design, artifact, workflow, layout, API shape, or example output, treat it as the governing artifact. Clone its skeleton faithfully and apply only the user's explicit diffs.

Required process:
1. Extract the reference skeleton: ordered sections, hierarchy, labels, controls, data columns, states, and interaction flow.
2. Name the explicit user diffs.
3. Implement or specify `reference skeleton + explicit diffs`.
4. Do not re-synthesize, modernize, embellish, split, merge, or "improve" structure unless the user explicitly asks.

If the requested diff conflicts with the reference, stop and ask or write the conflict in the plan. Missing detail is not permission to invent a new structure.

## Auto Parallel Orchestration

Use parallel workers automatically only when parallelism is actually safe and cheaper than serial coordination.

Parallelize when all are true:
- There are at least two independent execution slices.
- Each slice has a written objective, allowed files/modules, verification command, and conflict domain.
- The slices do not share files, state schemas, migrations, CLI commands, provider routing, persistence, UI flow, tests that mutate the same fixtures, or release/default behavior.
- Failure in one slice will not invalidate the other slice's assumptions.
- The merge order and integration check are explicit.

Serialize when any are true:
- Shared files or shared conflict domain.
- One slice defines an API/schema/state shape another consumes.
- User-visible UX flow may drift if split.
- Verification requires the combined result.
- The task is small enough that worker dispatch overhead exceeds the work.

Default worker path: `opencode-go` models. Use cheap capable workers for mechanical edits and stronger Go reasoners for complex implementation inside an already-specified contract.

If opencode is unavailable, pause and ask before spending gpt-5.5 or Claude/Opus quota on execution. The gate must state the role, expected cost class, whether code will be edited, and the return-size cap. Never promote workers into planners or Claude into implementer because the preferred delegate is down.

## Model Routing

Do not trust stale model catalogs from memory. Before choosing a specific opencode model for a non-trivial run, verify availability with `opencode models </dev/null`.

Routing policy:
- Frontier planning/audit/root-cause/policy: codex gpt-5.5 high reasoning by default.
- Adversarial challenge: another frontier pass by default; Claude Opus only with explicit current-turn user approval.
- Worker execution: opencode-go.
- Cheap mechanical worker default: `opencode-go/deepseek-v4-flash` or the current cheapest capable Go model verified by smoke run.
- Stronger worker for complex bounded implementation: `opencode-go/deepseek-v4-pro`, `opencode-go/glm-5.2`, or the current strongest Go worker verified by smoke run.

Model capability notes belong in a dated repo doc or receipt, not always-loaded memory, unless they are framed as "verify at use."

## Memory Admission Gate

Memory is for durable operating rules and durable tool/environment references only. Project status, plans, findings, current bugs, audit results, progress, and "what I just did" go in repo docs, never memory.

Before creating or updating memory, the candidate must pass all seven checks:

1. Category fit: standing rule, durable user preference, durable authorization, or durable tool/environment reference. Status/plans/findings are rejected.
2. Durability: expected to remain useful for at least 30 days. Provider catalogs, funding state, and credentials are "verify at use," not durable facts.
3. Non-derivable: not already available from code, git, package files, CLAUDE.md, or repo docs. If a repo doc is source of truth, memory may only hold a compact pointer plus the invariant.
4. Concrete failure prevented: the memory names the exact future mistake it prevents.
5. Safety: no secrets, raw credential paths, pasted-key history, volatile model catalogs, or sensitive operational detail unless the user explicitly approves that security tradeoff.
6. Explicit sanction: the user approved this memory content and scope, not merely the act of editing a file.
7. Well-formed and indexed: required frontmatter, Apply When, Do Not Apply When, Verification, and exactly one `MEMORY.md` index entry for each memory file.

Authorization memories also require: authority, scope, allowed actions, forbidden actions, approval date, review_after, and revocation source.

After any memory edit, verify `MEMORY.md` links resolve. A broken memory index is a rules failure.

## CLI Invocation

`codex exec` and `opencode run` must be invoked with stdin closed (`</dev/null`) through Bash/git-bash style execution. If a run hangs after saying it is reading stdin, stop and fix invocation; do not re-debug auth.

Use the detailed indexed memory `opencode-codex-cli-stdin-hang` for the current command templates and environment-specific caveats.

## Source Of Truth

- Current project state lives in repo docs, receipts, git, and CI.
- Durable operating policy lives in this file plus indexed memory.
- If `CLAUDE.md`, memory, handoff docs, and repo docs conflict, stop and surface the conflict instead of choosing silently.
```

## Required Memory Cleanup Proposed

Do not do these silently. They need user approval because they change always-loaded governance.

1. Fix `MEMORY.md` broken link to `merge-authorization-dedrift.md`.
   - Either restore the memory with authorization schema, or remove the index line and keep the rule only in repo docs until approved.
2. Trim `opencode-provider-access.md`.
   - Remove raw key backup path and pasted-key history from always-loaded memory.
   - Replace full catalog with "verify with `opencode models` and smoke run."
3. Trim `orchestrator-delegate-never-self.md`.
   - Keep bright line, role separation, rate-limit trap.
   - Move incident narratives to repo docs or reduce to one sentence.
4. Trim `operating-protocol.md`.
   - Keep pointer to `docs/operating-protocol-10of10.md` and non-negotiables.
   - Avoid duplicating long details from the source doc.
5. Add anti-drift memory only after approval.
   - Better: put anti-drift in `CLAUDE.md` first and memory second only if needed.

## Round-2 Challenge Questions

These need a second adversarial pass before final installation:

1. Should the main thread ever be allowed to author high-stakes rules docs when the user explicitly asks "you are the auditor," or should it always spawn a frontier session despite the user addressing Claude directly?
2. Is the 2-file/400-line cap too strict for real dispatch prompts, or strict enough to prevent slow bleed?
3. Should Opus be entirely banned unless the user names it, or is "explicit approval after gate prompt" enough?
4. What is the exact return cap: 80 words, 120 words, or fixed status line only?
5. Should memory max length be hard-capped at 250 words after frontmatter, with longer references forced into repo docs?
6. Should model capability notes live in `docs/model-routing.md` with a monthly review date instead of memory?
7. What is the canonical source for merge authorization now that the indexed memory file is missing?
8. Should `CLAUDE.md` retain command templates, or only point to memory to reduce root context?
9. Should "Claude may run verification" include full test output capture, or only command exit status plus tail-on-failure?
10. Should auto-parallelism require a written mini-contract for every worker, even for small docs/test tasks?

## Final Recommendation

Install the Opus/context-bloat caps first. They are the root control-plane fix. Then install anti-drift. Then install memory admission. Then install auto-parallelism. Do not install a model "capability table" into memory; install a verification-based routing rule and keep any dated rankings in repo docs.

The current rules are close enough to be dangerous: they sound strict, so future agents will think they are safe, but the expensive paths remain full of loopholes. The hardened version must be numeric, gated, and hostile to verbose agent returns.
