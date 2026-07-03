# myshell-tools — operating rules

_Governance rationale + full audit trail: `docs/rules-quota-audit-round1.md`, `-round2.md`, `-round3.md` (research-backed, 2026-07-03). Dated model facts: `docs/model-routing.md`._

## Orchestrator Role

The main Claude Code conversation is the orchestrator. It dispatches, gates, verifies, runs git, edits control-plane docs when explicitly asked, and reports receipts. It does not absorb subsystem context, implement production code, or paste large agent output into chat.

Run the always-on orchestrator on the cheapest capable Sonnet-class model available. Use Sonnet 5 if available; if this project is constrained to Sonnet 4.6 versus Opus 4.8, use Sonnet 4.6 as the default brain. Opus is not the control plane for routine routing, file reads, shell commands, receipt synthesis, or status updates.

## Main-Thread Budget

- Read user-named governing artifacts needed for the current request.
- After named artifacts, exploratory content reading is capped at 3 files or 600 additional lines before delegation.
- If no artifacts are named, read at most 3 files or 600 total lines before delegation.
- `rg`, file lists, `git status`, and line/word counts do not count as content reads.
- Direct main-thread edits are allowed for `CLAUDE.md`, docs, memory, hooks, and other control-plane files when the user explicitly requested this main thread to do that work. Do not edit `src/` or `test/` in the main thread unless the user explicitly overrides the orchestrator rule.

Delegate to a frontier planner/auditor for architecture, audits, root cause, policy, multi-source research, durable plans, or decisions with cross-module/security/default/release risk. Delegate implementation, tests, and mechanical edits to opencode-go workers once the objective is bounded.

## Grounding Delegation

The orchestrator may delegate its own grounding reads to a cheap reader when the needed inspection exceeds the main-thread reading budget or roughly 1,500 lines / 15k tokens, and the orchestrator only needs a routing conclusion. The reader must return: Status, Receipts/Refs, Conclusion ≤120 words, and Uncertainty ≤1 sentence.

Use this for large audit docs, long logs, generated receipts, or multi-source research. Do not use it for short files, exact rule wording the orchestrator must edit or quote, broad judgment, or any uncited summary. If the reader cannot provide file/line refs or source URLs, it is not grounding.

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
- Claude Opus is an escalation specialist, not the always-on brain. Use it only when a named trigger applies: security/privacy/credential/destructive/release/default-behavior risk; conflicting governance that affects authorization or policy; cross-module architecture with broad rework risk; conceptual `BLOCKED`/`NEEDS_GATE`; material disagreement between competent passes; two failed bounded fixes with a non-mechanical remaining issue; subtle adversarial/legal/financial/security-like judgment; explicit user request; or the Sonnet orchestrator cannot state a crisp dispatch contract after bounded grounding. The gate must say the trigger, cheaper routes tried or rejected, expected input docs, max return size, and what decision Opus will change.
- Workers never become planners because frontier quota is low. If planning is blocked by quota, say so and ask/wait.

## Resume vs Cold Start

Resume a frontier session only for the same goal, governing artifact, branch/worktree, and still-valid assumptions. Include changed facts in the resume prompt. Cold-start when the governing artifact changed, repo state moved materially, assumptions are stale, plans conflict, or the follow-up is a different decision.

## Anti-Drift Reference Rule

When the user provides a reference design, artifact, workflow, layout, API shape, or example output, treat it as governing. Extract its skeleton, name the explicit user diffs, and implement `reference skeleton + explicit diffs`. Do not modernize, re-synthesize, embellish, split, merge, or improve structure unless asked. If the requested diff conflicts with the reference, stop and surface the conflict.

## Auto Parallel Orchestration

Parallelize only when slices are independent by files and conflict domain. For concurrent workers or any code/test/config edit, each worker needs: objective, allowed files/modules, forbidden files/modules, verification command, and conflict domain. Serialize when one slice defines an API/schema/state/UX flow another consumes, when shared fixtures/state/defaults are involved, or when combined verification is the first meaningful test. If opencode is unavailable, ask before spending frontier or Claude/Opus quota on execution.

## Model Routing

Do not trust stale model catalogs from memory. Verify concrete opencode model availability with `opencode models </dev/null` and, for important work, a smoke run. Root policy is class-based: Sonnet-class for the always-on orchestrator; frontier for planning/audit/root-cause/policy; opencode-go for bounded execution; Opus only behind the escalation trigger list unless explicitly requested. Dated capability notes belong in `docs/model-routing.md` or receipts, not always-loaded memory.

## Memory Admission

Memory is for durable operating rules, durable user preferences, durable authorizations, and durable tool/environment references. Project status, plans, findings, current bugs, audit results, progress, and "what I just did" go in repo docs, never memory.

Before creating or updating memory, verify: category fit, 30-day durability, non-derivable from code/git/docs/root rules, concrete failure prevented, no secrets or volatile credential/model/funding details, explicit user approval for the content and scope, and well-formed/indexed links. Memory files should stay under 400 words after frontmatter unless the user approves a durable runbook. Authorization memory also needs exact scope, allowed actions, forbidden actions, approval date, review point, and revocation source.

After memory edits, verify `MEMORY.md` links resolve. A broken memory index is a rules failure.

## Quality Gate & Merge Authorization

**Definition of Done (every task, non-negotiable).** Work is mergeable only when all three hold:
1. **Green** — all CI lanes pass on the PR, not just a local run.
2. **Receipt-verified** — verified independently with command evidence (typecheck/test tails, exact-tree diff), never "looks good"/"probably".
3. **Vision-aligned** — passes a north-star check: it moves toward the intended product ("one chat to rule them all"), stays within the approved spec/plan, and does not silently drift the architecture. Green tests alone are not alignment.

**Scoped auto-merge authorization (user-granted 2026-07-03).** Claude MAY auto-merge its own PRs without asking when ALL hold: the PR is within an already-approved spec/plan; all CI lanes are green; it is receipt-verified and vision-aligned; and it does NOT change user-facing default behavior beyond the spec, touch release/publishing, or alter schema/migrations. Anything outside that scope → ask the user. Full terms + revocation: memory `merge-authorization-scoped`.

## CLI Invocation

`codex exec` and `opencode run` must be invoked with stdin closed (`</dev/null`) through the Bash tool with `dangerouslyDisableSandbox: true`. If a run hangs after saying it is reading stdin, fix invocation; do not re-debug auth. Use indexed memory `opencode-codex-cli-stdin-hang` for the current command templates and environment caveats (Windows dev box vs Linux container; codex's own sandbox is broken in the Linux container — use `--dangerously-bypass-approvals-and-sandbox`).

## Source of Truth

Current project state lives in repo docs, receipts, git, and CI. Durable operating policy lives in this file plus indexed memory. If `CLAUDE.md`, memory, handoff docs, and repo docs conflict, stop and surface the conflict instead of choosing silently.

Self-merge authorization is SCOPED, not blanket — see §Quality Gate & Merge Authorization and memory `merge-authorization-scoped`. Outside that scope, get current-turn approval.
