# Rules + Quota Audit Round 2

Date: 2026-07-03

Role: independent adversarial challenge of `docs/rules-quota-audit-round1.md`.

Inputs read:

- `docs/rules-quota-audit-round1.md`
- `CLAUDE.md`
- `docs/HANDOFF.md`
- Memory directory listing and `MEMORY.md` index for the merge-authorization governance check

## Executive Verdict

Round 1 identifies the right disease: Claude-as-orchestrator rules are leaky, Opus is too easy to invoke, agent returns can bloat the main context, and memory governance needs a real admission gate.

But round 1 overcorrects. It proposes an always-loaded `CLAUDE.md` that is too long, too schema-heavy, and too brittle for normal Claude Code flow. Its hardest numeric cap, "2 files and 400 lines," is already falsified by this very assignment: the user explicitly required reading three governing docs, and round 1 alone is 677 lines. A rule that must be violated for the audit task is not a good root rule.

Round 2 recommendation: keep the hard boundaries, shrink the root file, change the caps to distinguish explicit user-named inputs from exploratory reading, replace rigid status-line-only returns with receipt-first concise returns, and move detailed schemas/model notes out of always-loaded context.

## Token-Cost Evidence

Measured locally with `chars / 4` as a rough token estimate:

| Artifact | Lines | Words | Chars | Est. tokens |
| --- | ---: | ---: | ---: | ---: |
| Current `CLAUDE.md` | 36 | 649 | 4,459 | 1,115 |
| Round-1 consolidated `CLAUDE.md` proposal | 141 | 1,412 | 9,601 | 2,401 |
| `docs/HANDOFF.md` | 100 | 1,627 | 12,422 | 3,106 |
| `docs/rules-quota-audit-round1.md` | 677 | 6,034 | 41,786 | 10,447 |

Round 1 would add about 1.3k tokens to every session before any memory is loaded. That is not ruinous by itself, but it is the wrong direction for a quota-control rewrite. The root file should be closer to 1.3k-1.6k tokens, not 2.4k, and should point to detailed runbooks instead of embedding them.

## Where Round 1 Is Wrong

### 1. The 2-file / 400-line cap is too strict as written

The cap is good as an exploratory-reading budget, but bad as an absolute dispatch budget.

Evidence:

- This user request explicitly required reading 3 docs.
- The required round-1 doc is 677 lines by itself.
- Current `CLAUDE.md` + `docs/HANDOFF.md` are 136 lines together; adding one non-trivial design/audit doc commonly exceeds 400 lines.

Decision: change to:

- Explicit user-named governing inputs may be read even if they exceed the cap.
- After those named inputs, exploratory reading is capped at 3 files or 600 additional lines before delegating.
- For ordinary non-audit tasks with no named docs, the cap is 3 files or 600 lines total.

This still blocks subsystem absorption, but does not force fake delegation when the user hands Claude the exact artifacts to audit.

### 2. The 120-word return cap is directionally right but too brittle

120 words is workable for a finished worker receipt, but too tight for a frontier audit summary with competing options, risks, and a gate decision. If the cap is too tight, agents will either violate it or hide important context in a doc the orchestrator never reads.

Decision: use 180 words max for `summary`, plus required path(s). For routine worker receipts, prefer 80 words. The enforceable rule is "no raw logs/diffs/full docs in chat," not a magic 120-word number.

### 3. The rigid `DOC` / `READY` / `BLOCKED` contract is over-specified

Claude Code agents need normal tool-use flow internally. A rigid status vocabulary is only reasonable for the final return, and even there it should not require every answer to fit one tokenized grammar.

Decision: keep final-return structure, but make it a receipt format, not a protocol parser:

```md
Agent final returns must be concise and receipt-first:

Status: DONE | BLOCKED | NEEDS_GATE | REJECTED
Receipts: <paths, commit/PR, commands>
Summary: <180 words max>
Next: <one sentence, if action is needed>

Full findings, logs, diffs, and research notes go in repo docs/receipts, not chat.
```

This captures the benefit without making normal agent output unnatural.

### 4. Round 1 makes `CLAUDE.md` a policy manual

The proposed root file includes:

- long delegate-vs-inline doctrine
- full status-line grammar
- frontier/Opus quota text
- resume-vs-cold text
- anti-drift workflow
- auto-parallel workflow
- model routing details
- memory admission schema
- CLI invocation pointer
- source-of-truth rules

Many of these belong in root, but not at full size. Root should hold invariants and gates; runbooks and schemas belong in docs or memory references.

Decision: install a lean root rule set with numeric gates, and move details to:

- `docs/model-routing.md` for dated model notes
- memory hygiene/runbook for memory schema
- CLI stdin-hang memory for command templates
- repo receipts for worker return details

### 5. "One frontier draft plus one adversarial challenge" is too expensive as a default

Round 1 tries to prevent weak plans by requiring adversarial rounds. That becomes a quota leak if every high-stakes task gets two frontier passes.

Decision: one frontier planner by default for high-stakes planning/audit. Add adversarial challenge only when one of these is true:

- irreversible or security-sensitive decision
- cross-module architecture/default behavior
- user explicitly asks for adversarial review
- first pass identifies material uncertainty
- prior drift/rework incident directly applies

### 6. The Opus gate is right, but "Claude Agent subagents" should not be mixed with Opus

Round 1 uses "Claude Opus / Claude Agent subagents" as if they are the same cost class. They are not always identical operationally. The real rule is: expensive Claude subagents, especially Opus, require current-turn approval unless the user directly asked to use them.

Decision: keep current-turn approval for Opus and for any Claude subagent used as planner/auditor/worker when cheaper delegates are available.

### 7. Memory schema details should not live in full in `CLAUDE.md`

The seven checks belong in root. The proposed authorization-memory schema does not. It is too detailed for every session and will drift if the hook/schema evolves.

Decision: root gets the gate and a short authorization-memory rule. The full schema belongs in the memory-hygiene doc or a repo governance doc.

### 8. Auto-parallelism is too contract-heavy for tiny tasks

Round 1 requires a written objective, allowed files/modules, verification command, conflict domain, merge order, and integration check for every parallel worker. That is right for implementation slices; it is overhead for tiny docs/test edits.

Decision: require a mini-contract only when a worker will edit code/tests/config or when two workers run concurrently. For a tiny single docs worker, a one-line objective plus allowed files is enough.

### 9. Model routing should not name "strongest" workers in root

Round 1 says `deepseek-v4-pro` / `glm-5.2` are stronger workers. That may be true today, but model catalogs and quality drift. Root should name the verification command and provider classes, not maintain a capability ranking.

Decision: root may list default route classes, not a durable benchmark. Dated model choices go to `docs/model-routing.md` or receipts.

### 10. Merge authorization is not currently active durable memory

Round 1 said `MEMORY.md` links `merge-authorization-dedrift.md`. Verified on 2026-07-03: current `MEMORY.md` does not contain that link, and the file does not exist. `docs/HANDOFF.md` still says "memory: `merge-authorization-dedrift`," but the same handoff also says that memory was removed after user objection and should be re-added only with approval.

Decision: the canonical durable source is: no active indexed memory authorization exists. The stale handoff line is not enough to self-merge. Until the user explicitly re-approves a governed authorization memory or current-turn merge permission, Claude must ask before self-merging.

## Keep As-Is From Round 1

Keep these proposals conceptually as written:

- Main Claude Code conversation is an orchestrator, not an implementer.
- Opus is an expensive-path exception requiring current-turn user approval.
- Agents write full output to repo docs/receipts and return paths, not pasted logs.
- Memory rejects project status, findings, current bugs, progress, and "what I just did."
- Provider/model facts must be verified at use, not trusted from stale memory.
- Anti-drift rule: reference artifacts govern; clone skeleton plus explicit diffs.
- If `CLAUDE.md`, memory, handoff, and repo docs conflict, stop and surface the conflict.
- CLI stdin-hang rule should remain as a pointer to the detailed memory/runbook.

## Change These Proposals

### Change: Main-thread read cap

Replace round 1's cap with:

```md
Main-thread reading budget:
- Read user-named governing artifacts needed for the current request, even if they exceed the normal cap.
- After named artifacts, exploratory content reading is capped at 3 files or 600 additional lines before delegation.
- If no artifacts are named, read at most 3 files or 600 total lines before delegation.
- `rg`, file lists, `git status`, and line/word counts do not count as content reads.
- Exceed the cap only for single-command factual checks or when the user explicitly assigns the main thread to perform the audit/rewrite.
```

### Change: Agent final-return contract

Replace rigid `DOC/READY/BLOCKED/...` grammar with:

```md
Agent final returns must be concise and receipt-first:

Status: DONE | BLOCKED | NEEDS_GATE | REJECTED
Receipts: <paths, commit/PR, commands>
Summary: <180 words max; 80 preferred for routine worker receipts>
Next: <one sentence, if action is needed>

Full findings, logs, diffs, and research notes go in repo docs/receipts, not chat.
```

### Change: Frontier rounds

Replace "one draft plus one challenge by default" with:

```md
Use one frontier planner/auditor for high-stakes planning, architecture, root cause, policy, or research. Add an adversarial frontier challenge only for irreversible/security-sensitive decisions, cross-module architecture/default behavior, explicit user request, material uncertainty, or a directly relevant prior drift/rework incident. No third internal round without a concrete blocker or user approval.
```

### Change: Auto-parallel contract

Replace round 1's all-task mini-contract with:

```md
Parallelize only when slices are independent by files and conflict domain. For concurrent workers or any code/test/config edit, each worker needs: objective, allowed files/modules, forbidden files/modules, verification command, and conflict domain. For a tiny single docs-only worker, a one-line objective plus allowed files is enough. Serialize when one slice defines an API/schema/state/UX flow another consumes, or when combined verification is the first meaningful test.
```

### Change: Memory max length

Replace the proposed 250-word cap with:

```md
Memory files should stay under 400 words after frontmatter. Longer material belongs in repo docs with the memory holding only the invariant, trigger, and pointer. Exceed 400 words only with explicit user approval for a durable runbook.
```

### Change: Model routing

Replace durable model-ranking text with:

```md
Model routing is class-based, not a stale ranking. Use frontier models for planning/audit/root-cause/policy, opencode-go for bounded execution, and Claude/Opus only behind current-turn approval unless the user explicitly requested it. Verify concrete model availability with `opencode models </dev/null` and, for important work, a smoke run. Dated capability notes belong in `docs/model-routing.md` or receipts, not always-loaded memory.
```

## Drop As Over-Engineering

Drop these from the always-loaded root file:

- Full authorization-memory schema fields (`authority`, `scope`, `review_after`, etc.). Keep the requirement, not the schema.
- Full model capability table or "strongest worker" ranking.
- Rigid one-token status vocabulary as the only allowed final form.
- Mandatory adversarial frontier challenge for every high-stakes task.
- Detailed CLI command templates in root. Keep the stdin-hang invariant and pointer.
- Detailed memory file schema in root. Keep the seven-gate admission rule and pointer.
- Full merge-order/integration-check contract for tiny docs-only tasks.

## Round-2 Challenge Questions: Decisions

1. Main thread authoring high-stakes rules docs: allowed only when the user explicitly assigns the main thread as auditor/writer or names the exact governing artifacts. Otherwise delegate. This task qualifies.
2. 2-file/400-line cap: too strict as absolute policy. Use named-artifact exception plus 3 files / 600 exploratory lines.
3. Opus: not entirely banned unless named. Explicit current-turn approval after a gate prompt is enough.
4. Return cap: 180 words max summary, 80 preferred for routine workers, plus receipt paths. Not fixed status line only.
5. Memory max length: 400 words after frontmatter by default; longer requires explicit approval and should usually become a repo doc.
6. Model capability notes: yes, keep dated notes in `docs/model-routing.md` with review dates; memory/root only say verify at use.
7. Merge authorization source: no active indexed durable memory exists. Handoff reference is stale/conflicted. Ask before self-merge until a governed authorization memory or current-turn approval exists.
8. Command templates in `CLAUDE.md`: no full templates. Keep only stdin-closed invariant and pointer to memory/runbook.
9. Verification output: Claude may run verification and report command, exit code, and concise tail-on-failure. Full output goes to a receipt file only when needed.
10. Auto-parallel mini-contract: required for concurrent workers and code/test/config edits; not required for tiny single docs-only edits.

## Merge Authorization Governance Resolution

Observed state:

- `C:\Users\Josh\.claude\projects\C--Users-Josh-Desktop-Github-Repositories-myshell-tools\memory\MEMORY.md` does not link `merge-authorization-dedrift.md`.
- `merge-authorization-dedrift.md` does not exist.
- `docs/HANDOFF.md` contains two conflicting statements: it says the memory was removed after user objection, and later says standing authorization exists via that memory.

Decision:

- The durable authorization is not active.
- The handoff line is stale/conflicted and cannot authorize self-merge.
- Next cleanup should replace it with: "No standing self-merge authorization is active unless an indexed authorization memory exists or the user grants current-turn approval."
- If the user wants standing self-merge authority restored, create a governed authorization memory through the memory-admission gate with exact scope and revocation source.

## Final Consolidated `CLAUDE.md` Proposal

This is intentionally shorter than round 1's proposal. Estimated size: about 5.8k-6.4k chars, 1.45k-1.6k tokens depending on encoding. That is about +350 to +500 tokens over the current root file, and about 800-950 tokens smaller than round 1's consolidated proposal.

```md
# myshell-tools -- operating rules

## Orchestrator Role

The main Claude Code conversation is the orchestrator. It dispatches, gates, verifies, runs git, edits control-plane docs when explicitly asked, and reports receipts. It does not absorb subsystem context, implement production code, or paste large agent output into chat.

## Main-Thread Budget

- Read user-named governing artifacts needed for the current request.
- After named artifacts, exploratory content reading is capped at 3 files or 600 additional lines before delegation.
- If no artifacts are named, read at most 3 files or 600 total lines before delegation.
- `rg`, file lists, `git status`, and line/word counts do not count as content reads.
- Direct main-thread edits are allowed for `CLAUDE.md`, docs, memory, hooks, and other control-plane files when the user explicitly requested this main thread to do that work. Do not edit `src/` or `test/` in the main thread unless the user explicitly overrides the orchestrator rule.

Delegate to a frontier planner/auditor for architecture, audits, root cause, policy, multi-source research, durable plans, or decisions with cross-module/security/default/release risk. Delegate implementation, tests, and mechanical edits to opencode-go workers once the objective is bounded.

## Agent Returns

Agents write full findings, logs, diffs, and research notes to repo docs/receipts. Their final chat return must be concise and receipt-first:

Status: DONE | BLOCKED | NEEDS_GATE | REJECTED
Receipts: <paths, commit/PR, commands>
Summary: <180 words max; 80 preferred for routine worker receipts>
Next: <one sentence if action is needed>

## Frontier, Workers, and Opus

- Frontier planning/audit/root-cause/policy/research: use codex gpt-5.5 high reasoning by default.
- Worker execution: use opencode-go by default.
- Use one frontier planner/auditor for high-stakes work. Add an adversarial frontier challenge only for irreversible/security-sensitive decisions, cross-module architecture/default behavior, explicit user request, material uncertainty, or a directly relevant prior drift/rework incident.
- No third internal planning/challenge round without a concrete blocker or user approval.
- Claude Agent/Opus is an expensive-path exception. Use it only with current-turn user approval unless the user explicitly requested it. The gate must say why cheaper routes are insufficient, expected input docs, max return size, and what decision the pass will change.
- Workers never become planners because frontier quota is low. If planning is blocked by quota, say so and ask/wait.

## Resume vs Cold Start

Resume a frontier session only for the same goal, governing artifact, branch/worktree, and still-valid assumptions. Include changed facts in the resume prompt. Cold-start when the governing artifact changed, repo state moved materially, assumptions are stale, plans conflict, or the follow-up is a different decision.

## Anti-Drift Reference Rule

When the user provides a reference design, artifact, workflow, layout, API shape, or example output, treat it as governing. Extract its skeleton, name the explicit user diffs, and implement `reference skeleton + explicit diffs`. Do not modernize, re-synthesize, embellish, split, merge, or improve structure unless asked. If the requested diff conflicts with the reference, stop and surface the conflict.

## Auto Parallel Orchestration

Parallelize only when slices are independent by files and conflict domain. For concurrent workers or any code/test/config edit, each worker needs: objective, allowed files/modules, forbidden files/modules, verification command, and conflict domain. Serialize when one slice defines an API/schema/state/UX flow another consumes, when shared fixtures/state/defaults are involved, or when combined verification is the first meaningful test. If opencode is unavailable, ask before spending frontier or Claude/Opus quota on execution.

## Model Routing

Do not trust stale model catalogs from memory. Verify concrete opencode model availability with `opencode models </dev/null` and, for important work, a smoke run. Root policy is class-based: frontier for planning/audit/root-cause/policy; opencode-go for bounded execution; Claude/Opus only behind current-turn approval unless explicitly requested. Dated capability notes belong in `docs/model-routing.md` or receipts, not always-loaded memory.

## Memory Admission

Memory is for durable operating rules, durable user preferences, durable authorizations, and durable tool/environment references. Project status, plans, findings, current bugs, audit results, progress, and "what I just did" go in repo docs, never memory.

Before creating or updating memory, verify: category fit, 30-day durability, non-derivable from code/git/docs/root rules, concrete failure prevented, no secrets or volatile credential/model/funding details, explicit user approval for the content and scope, and well-formed/indexed links. Memory files should stay under 400 words after frontmatter unless the user approves a durable runbook. Authorization memory also needs exact scope, allowed actions, forbidden actions, approval date, review point, and revocation source.

After memory edits, verify `MEMORY.md` links resolve. A broken memory index is a rules failure.

## CLI Invocation

`codex exec` and `opencode run` must be invoked with stdin closed (`</dev/null`) through Bash/git-bash style execution. If a run hangs after saying it is reading stdin, fix invocation; do not re-debug auth. Use indexed memory `opencode-codex-cli-stdin-hang` for current command templates and environment caveats.

## Source of Truth

Current project state lives in repo docs, receipts, git, and CI. Durable operating policy lives in this file plus indexed memory. If `CLAUDE.md`, memory, handoff docs, and repo docs conflict, stop and surface the conflict instead of choosing silently.
```

## Final Recommendation

Install the lean consolidated `CLAUDE.md` text, not round 1's full rewrite. Then create or update supporting docs:

- `docs/model-routing.md` for dated capability notes and review dates.
- A memory-governance/runbook doc for full schema details.
- A handoff cleanup patch removing the stale merge-authorization memory reference.

Do not restore standing self-merge authorization without explicit user approval through the governed memory path.
