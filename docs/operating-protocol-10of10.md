# Operating Protocol 10/10

## Brutal Verdict

The current failure is not "Claude needs better reminders." The failure is an unbounded control loop with vague authority boundaries, weak receipts, and no durable state machine. A bloated orchestrator will eventually rationalize breaking policy. A stop hook with an impossible product-level goal will keep injecting noise until it becomes part of the failure. Workers that hang or produce weak output make this worse, but they are not the root cause.

The root control-plane problem is this:

- Planning, execution, verification, merge, status, and handoff are not represented as hard states with explicit owners.
- "Green" is underspecified and can mean "some command ran," "an agent claimed it ran," or "the correct contract is satisfied."
- The north-star product vision exists as large prose, not as a compact invariant set that every slice must prove it preserves.
- Recovery is treated as ad hoc. Dark slices reduce blast radius, but they do not replace rollback, quarantine, or repair.

The definitive protocol is therefore not "let Codex do everything" and not "make Claude remember more." It is a ledgered, contract-first, verifier-gated state machine where Claude launches and surfaces gates only, Codex owns planning and technical judgment, workers edit only against signed slice contracts, and merge is allowed only after a small receipt proves code, tests, integration impact, provenance, and north-star alignment.

## Verdict on the Eight Ideas

| # | Verdict | Why |
|---|---|---|
| 1 | Fix, not keep | Codex owning the full lifecycle solves Claude bloat but creates a single-agent commit-and-merge hazard. With no required CI checks and weak tests, "green" can be hallucinated, partial, irrelevant, or product-wrong. Codex may also merge worker garbage that passes shallow checks, resolve conflicts incorrectly, or drift from the contract while optimizing for local closure. Codex may prepare a merge packet, but direct merge to main requires an independent verifier receipt and a deterministic merge gate. |
| 2 | Keep with hard limits | Warm Codex sessions preserve Item context and reduce repeated setup. They also accumulate stale assumptions and can become a second bloated orchestrator. Use one warm session per Item only while it maintains a compact Item ledger and refreshes from repo state before every slice. Force rollover after a fixed merge count, major conflict, failed verification, or context drift warning. |
| 3 | Fix, not keep | A second agent's one-line verdict is better than self-grading but still easy to game. If the verifier reads only the author's summary, it rubber-stamps. If it runs no commands, it is theatre. If it has no adversarial checklist, it misses contract drift. The verifier must receive the slice contract, diff, receipts, and run commands independently. Its output may be one line to Claude, but its receipt must be written to the repo. |
| 4 | Keep | Repo-backed status is correct. Claude should tail a compact state file instead of narrating from memory. The risk is making the status file another essay. It must be append-light, schema-like, and capped: current Item, current slice, state, owner, receipt links, next action, blockers. Archive detail elsewhere. |
| 5 | Keep | Heavy context skills for simple config changes are self-inflicted bloat. The fix is a dispatch classification rule: trivial control-plane edits can be direct; product planning goes to Codex; product code goes to workers. "Simple" must be narrowly defined, or Claude will use it to justify coding. |
| 6 | Fix, not keep | Milestone-scoped goals are necessary. A whole-product "10/10" stop hook is structurally unsatisfiable and poisons every turn. But tiny milestones can cause local-optimum drift. Every milestone must link to a compact north-star invariant set and include an explicit "does not regress these invariants" check. The stop hook should enforce the current handoff-able milestone, not repeat the whole vision. |
| 7 | Keep | Mechanical handoff is mandatory. Without it, context bloat is inevitable. The handoff must be generated from receipts, not from the agent's memory, and it must include enough state for a fresh session to continue without re-reading the whole repo. |
| 8 | Keep with explicit gates | Claude as Bash launcher and human-gate surfacer is the right security boundary. But Claude must not become an informal reviewer. Human gates must be enumerated: paid/expensive runs, default-on flips, force-push/rewrite, release, destructive cleanup, deleting state, merging after red verifier, changing protocol or hooks, and any non-dark user-visible behavior. |

## Stress Tests

### Stress Test for #1: Codex Self-Merging to Main

Codex self-merging is attractive because it compresses Claude's context to one line. It fails because context compression is not the same as control correctness.

Failure modes:

- Worker writes code that satisfies the local test shape but violates the product contract.
- Codex verifies the wrong command set, omits an affected area, or mistakes "no failing tests were run" for "green."
- Codex reports "green" from memory after a command failed, timed out, or was run before the final edit.
- The PR is logically stale: another Item changed nearby code, and the slice still passes isolated tests while corrupting cross-Item behavior.
- The slice is dark but still changes shared types, routing, config parsing, persistence, or telemetry in a way that affects default behavior.
- The worker edits extra files outside the contract; weak tests pass because they do not cover the unintended path.
- Merge conflicts are resolved mechanically and silently drop one side of the intended behavior.
- The north-star gets eroded by "small" tactical choices: more flags, more hidden modes, inconsistent UX copy, incompatible state models.
- No required CI means the merge act itself has no external brake.

Corrected rule:

Codex may own plan, worker dispatch, repair loops, local verification, PR preparation, and merge packet creation. Codex may not be the only authority that declares a slice mergeable. A merge requires:

1. A written slice contract.
2. A diff summary with changed files.
3. A command receipt with exact commands and outcomes.
4. An independent verifier receipt based on the contract and diff.
5. A merge gate check against branch freshness, conflicts, dark-default policy, and protected human gates.

If those are present and no human gate is triggered, the launch process may merge with a one-line report to Claude. The important part is not that Claude reads the details; it is that the details exist, are independently generated, and are addressable after the fact.

### Stress Test for #3: Who Watches the Watcher

A second agent can be gamed if its input is polluted. If it reads only "the author says this passes," it will likely agree. If it is weaker than the author and has no tools, it becomes a confidence amplifier. If it is asked for a one-line verdict only, it has no accountability.

The verifier must be treated as a separate role with a narrower contract:

- It must read the slice contract, the actual git diff, and the author's receipt.
- It must run the required verification commands itself, or explicitly mark commands not run.
- It must perform an adversarial contract check: "What behavior could this diff break that the tests do not cover?"
- It must write a compact receipt to `docs/receipts/`.
- Its one-line verdict to Claude is only a pointer to that receipt.

The watcher is watched by mechanical checks:

- Verifier receipts must include the git commit or tree hash inspected.
- Verifier receipts must list exact command strings and exit results.
- Merge is blocked if the verifier inspected a different tree than the merge candidate.
- A later broken slice triggers repair against the verifier receipt; repeated bad verifier receipts disqualify that verifier/model for high-risk slices.

This still is not perfect. It is an evidence trail, not mathematical proof. But it prevents the worst failure: invisible trust in an agent sentence.

### Stress Test for #6: Milestone Goals vs North-Star Drift

Scoping the stop hook to a handoff-able milestone fixes the immediate bloat loop. It also creates a new risk: every session completes a small, locally coherent goal while the product slowly diverges from the 10/10 vision.

The fix is to split the north-star into two artifacts:

- A stable compact constitution: non-negotiable product invariants, no more than one screen.
- A mutable roadmap ledger: current Items, slice contracts, receipts, and status.

The stop hook should enforce only the active milestone. The milestone must include a mandatory invariant check against the constitution. If a slice cannot satisfy both the milestone and the constitution, the correct result is not local completion; it is `BLOCKED: contract conflicts with invariant <id>`.

Do not inject the whole product vision every turn. Inject only:

```text
Active milestone: <id>. Done when: <mechanical acceptance>.
Required invariant check: <constitution ids>.
On completion: write receipt + handoff, then stop.
```

## Blind Spots Missing from the Golden Ideas

### 1. Silent Contract Drift

The most dangerous failure is not a red test. It is a slice that passes tests while subtly changing what the product means. Examples: a "temporary" flag becomes another permanent mode; a router picks a cheaper model but violates capability intent; an evidence receipt reports confidence instead of proof; a UX flow technically works but breaks the user's mental model.

Control:

- Every slice gets a contract with explicit non-goals and invariant IDs.
- The verifier checks the diff against the contract, not just commands.
- Any discovered drift creates a repair slice or a contract amendment. Amendments require Codex planner approval and a human gate if they alter north-star semantics.

### 2. Quota Exhaustion Mid-Slice

Codex quota exhaustion is not exceptional; it is part of the operating environment. If it happens after workers edit files but before verification or merge, the system can be left in an ambiguous state.

Control:

- Slices have durable states: `planned`, `worker-running`, `worker-returned`, `author-verifying`, `verifier-running`, `ready-to-merge`, `merged`, `blocked`, `quarantined`.
- Codex must write state before dispatching a worker and after every transition.
- If Codex quota expires, Claude does not plan around it. Claude marks the slice `blocked: planner-quota` and stops or asks the human whether to wait.
- Workers may not continue inventing next steps without Codex.
- Half-edited work stays on a branch/worktree; main is untouched until receipts are complete.

### 3. Worker Output That Passes Tests But Is Wrong

Unreliable workers can produce plausible code that matches test names while missing real behavior. They can also hang, partially edit, or change unrelated files.

Control:

- Worker prompt must include contract, allowed files, forbidden files, required tests, and output format.
- Worker output is untrusted until Codex inspects the diff.
- A worker timeout over two minutes is a failed attempt, not a reason to wait indefinitely.
- After two failed worker attempts on the same slice, Codex either narrows the contract or marks `blocked: worker-unreliable`; it must not silently self-implement unless the protocol explicitly allows Codex to switch from planner to author for that slice and then requires stronger independent verification.

### 4. Loss of the 10/10 Vision Across Handoffs

Large vision docs do not preserve vision in practice because agents stop reading them. The north-star must be reduced to a small invariant set that is actually used.

Control:

- Create and maintain a compact `docs/NORTH-STAR-INVARIANTS.md`.
- Each invariant has an ID, one-sentence rule, and examples of violations.
- Every slice contract lists relevant invariant IDs.
- Every handoff lists only changed invariant implications, not the whole vision.

### 5. No Rollback or Repair Protocol

Dark slices are reversible only if the reversal path is known and tested. "Default-off" does not protect against shared code, migrations, build failures, test fixture contamination, or type-level API drift.

Control:

- Every merge receipt includes a rollback command or revert strategy.
- Broken merged slices are marked `quarantined` in status.
- Quarantine means no dependent slice may merge until repair or revert.
- Repair must be a new slice with its own contract and receipt.
- If a dark flag touches persistence, config, shared routing, or public types, rollback must include compatibility notes.

### 6. No Cross-Item Integration Testing

Slice-level checks miss emergent failures. Parallel Items can each be correct and collectively broken.

Control:

- Each Item has an integration checkpoint after a small number of merges or before default flips.
- Required commands at checkpoint: `npm run typecheck`, `npm run lint`, `npm run test`, plus targeted `test:contract`, `test:integration`, `test:ui`, or PTY smoke when affected.
- Integration checkpoints are authored by Codex and independently verified.
- Default-on flips are forbidden without an integration checkpoint receipt.

### 7. No Provenance of What Agents Actually Did

Without provenance, later debugging becomes archaeology. "Worker did it" is not enough.

Control:

- Each slice gets a receipt directory or file containing: planner session ID, worker model/session IDs if available, verifier model/session ID if available, branch, base commit, head commit, commands, touched files, and verdict.
- Claude receives one line, but the repo stores the evidence.
- Agent raw logs can be large; store links or summarized hashes when needed, not full dumps in the status file.

### 8. Merge Conflicts Across Parallel Items

Parallelism without an integration owner creates hidden coupling. Conflict resolution is design work when contracts overlap.

Control:

- A slice contract declares touched modules and "conflict domains."
- Two slices in the same conflict domain may not merge concurrently.
- A stale branch must rebase or merge main and rerun verification before final merge.
- Non-trivial conflict resolution triggers Codex replanning and verifier review.

### 9. Weak Definition of Human Gates

If human gates are implicit, agents will route around them under pressure.

Control:

Human approval is required for:

- Paid or unusually expensive runs.
- Default-on flips or user-visible behavior changes not hidden behind a flag.
- Force-push, history rewrite, deleting branches with unmerged work, deleting state, or destructive cleanup.
- Merge after failed verifier or missing receipt.
- Protocol changes, hook changes, or permission broadening.
- Release publishing.
- Any change that weakens tests, disables checks, or lowers acceptance criteria.

### 10. Stop-Hook Injection as a Denial-of-Service Against the Orchestrator

The stop hook must not be a sermon. It should be a small state transition guard.

Control:

- Hook text must be bounded and milestone-specific.
- Hook must fire only when the current state is incomplete and actionable.
- Hook must not ask for a whole product goal.
- Hook must not cause status narration; it should request exactly one next mechanical action.

## Definitive Operating Protocol

### Operating Principle

Claude is the launcher and gate surfacer. Codex is the planner and technical judge. Workers are patch generators. Verifiers are adversarial auditors. Git and repo receipts are the source of truth.

No role is allowed to prove its own work by assertion. No session is allowed to carry project truth in chat memory. No merge is allowed without a receipt tied to a specific tree.

### Role Contracts

#### Claude Orchestrator

One-line contract:

```text
Launch the approved role command, update/tail protocol state, surface human gates, and never edit product code.
```

Allowed:

- Invoke Codex and OpenCode with closed stdin.
- Edit control-plane docs, hooks, and status files when explicitly part of protocol operation.
- Run git commands and verification commands when the protocol requires launch-level checks.
- Report one-line status and human decisions.

Forbidden:

- Editing `src/` or `test/`.
- Inline planning for product slices.
- Inline code review beyond checking that required receipts exist.
- Re-explaining project state from memory.
- Continuing work when Codex planning is quota-blocked.

#### Codex Planner/Author

One-line contract:

```text
Convert the north-star and roadmap into one slice contract, manage worker attempts, inspect diffs, run author verification, and produce a merge packet or a blocker.
```

Allowed:

- Read enough repo context to design the slice.
- Dispatch opencode workers.
- Repair by narrowing scope and redispatching.
- In exceptional cases, implement directly only if the slice state records `author-mode: codex` and triggers stronger verification.
- Prepare PR and merge packet.

Required outputs:

- Slice contract.
- Author receipt.
- Merge packet or blocker.
- Status update.

#### OpenCode Worker

One-line contract:

```text
Make only the requested code/test edits inside the slice contract and return changed files plus commands run.
```

Allowed:

- Edit files permitted by the contract.
- Add or update tests required by the contract.
- Run targeted checks.

Forbidden:

- Planning new scope.
- Changing flags/defaults without explicit contract.
- Editing control-plane protocol docs unless the slice is a protocol slice.
- Broad refactors not listed in the contract.

Failure handling:

- Timeout over two minutes: failed attempt.
- `database is locked`: failed attempt; retry once after a short delay only if Codex decides.
- No actionable output: failed attempt.
- Unrelated file edits: reject attempt unless Codex amends contract and verifier checks it.

#### Independent Verifier

One-line contract:

```text
Given the slice contract, diff, and author receipt, independently verify commands and contract alignment for the exact tree proposed for merge.
```

Required:

- Inspect actual diff.
- Run required commands or mark not run.
- Check dark-default and reversibility.
- Check relevant north-star invariants.
- Write verifier receipt.
- Return one line: `VERIFIED <slice> <tree> <receipt>` or `REJECTED <slice> <reason> <receipt>`.

#### Human

One-line contract:

```text
Decide only explicit gates that change cost, risk, defaults, history, release state, or protocol authority.
```

The human should not be asked to adjudicate routine green slices. The protocol should reduce human intervention to real authority decisions.

## Required Repo Artifacts

### `docs/NORTH-STAR-INVARIANTS.md`

Purpose: one-screen constitution that prevents local milestone drift.

Required shape:

```md
# North-Star Invariants

| ID | Rule | Violations |
|----|------|------------|
| NS-1 | The main chat path must answer the user before autonomous staging work can obscure it. | Goal machinery suppresses direct answers; post-turn work changes visible response ordering. |
| NS-2 | Verification must report evidence, not confidence. | Receipts say "verified" without command evidence. |
```

Rules:

- Keep it compact.
- Amendments require Codex planner approval.
- Semantic amendments require human gate.

### `docs/ROADMAP-STATUS.md`

Purpose: compact current state. Claude tails this; Claude does not reconstruct state from chat.

Required shape:

```md
# Roadmap Status

updated: 2026-07-02T00:00:00-04:00
active-item: R7-Item5
active-slice: 05c
state: verifier-running
owner: verifier
branch: slice/r7-item5-05c
base: <sha>
head: <sha>
contract: docs/contracts/r7-item5-05c.md
author-receipt: docs/receipts/r7-item5-05c-author.md
verifier-receipt: pending
next-action: wait for verifier or mark blocked on timeout
blocker: none
```

Rules:

- Current state only. Do not paste full logs.
- Completed slices move to `docs/receipts/` and optionally an archive table.
- Claude may read or tail this file. It should not read the full master plan unless a gate requires it.

### `docs/contracts/<slice>.md`

Purpose: the worker and verifier contract.

Required sections:

- Slice ID.
- Parent Item.
- Objective.
- In-scope files/modules.
- Out-of-scope files/modules.
- Relevant north-star invariant IDs.
- Dark-default/reversibility rule.
- Acceptance commands.
- Targeted behavior assertions.
- Conflict domain.
- Human gates triggered, if any.

### `docs/receipts/<slice>-author.md`

Purpose: Codex author's evidence.

Required sections:

- Planner session ID.
- Worker attempts and outcomes.
- Branch/base/head.
- Changed files.
- Commands run with exit status.
- Contract mapping: each acceptance item -> evidence.
- Known risks and untested areas.
- Rollback strategy.
- Merge recommendation: yes/no.

### `docs/receipts/<slice>-verifier.md`

Purpose: independent verifier evidence.

Required sections:

- Verifier identity/model/session.
- Tree inspected.
- Inputs read.
- Diff risk review.
- Commands run with exit status.
- Contract verdict.
- Invariant verdict.
- Dark/reversibility verdict.
- Final verdict: `VERIFIED`, `REJECTED`, or `INCONCLUSIVE`.

### `docs/handoffs/<timestamp>-<item>.md`

Purpose: fresh-context restart packet.

Required sections:

- Current Item and slice.
- Last merged slice and receipt links.
- Current branch/worktree state.
- Open blockers.
- Next exact command Claude should launch.
- Relevant invariant IDs only.
- Do not include full historical narration.

## Slice State Machine

Allowed states:

- `planned`: Codex wrote contract; no worker running.
- `worker-running`: worker launched.
- `worker-returned`: worker produced output.
- `author-verifying`: Codex inspecting diff and running checks.
- `author-repairing`: Codex rejected worker output and is narrowing/redispatching.
- `verifier-running`: independent verification launched.
- `ready-to-merge`: verifier passed and no human gate is pending.
- `human-gate`: human decision required.
- `merged`: squash merge complete and receipt recorded.
- `blocked`: cannot proceed without Codex quota, human decision, missing dependency, or repeated worker failure.
- `quarantined`: merged or candidate slice later found unsafe; dependent merges blocked.

Invalid transitions:

- `worker-running` -> `merged`
- `author-verifying` -> `merged`
- `blocked` -> `merged`
- `human-gate` -> `merged` without human approval recorded
- Any state -> `merged` without verifier receipt
- Any stale branch -> `merged` without refreshing from main and rerunning verification

## Standard Slice Lifecycle

### 0. Refresh State

Claude reads only:

- `docs/ROADMAP-STATUS.md`
- latest handoff if present
- user instruction for the current turn

If state says `blocked: planner-quota`, Claude does not invent a workaround. It reports the blocker or waits for Codex availability.

### 1. Codex Plans the Slice

Claude launches Codex with closed stdin. Codex reads the relevant Item docs and repo context, then writes `docs/contracts/<slice>.md`.

Codex must make the slice small enough that:

- It has one primary behavior change.
- It can be dark by default.
- It has clear affected modules.
- It can be verified by commands available in this repo.
- It can be reverted independently.

Codex updates `docs/ROADMAP-STATUS.md` to `planned`.

### 2. Codex Dispatches Worker

Codex prompts the worker with:

- Contract path and full contract content.
- Allowed files/modules.
- Forbidden scope.
- Required output format.
- Timeout expectation.
- Exact command list to run if feasible.

Codex updates state to `worker-running`.

### 3. Worker Executes

Worker edits code/tests. Worker returns changed files and commands run.

If worker hangs over two minutes or returns known failure text, Codex marks the attempt failed. After two failed attempts:

- Narrow the slice and retry, or
- Switch to Codex author mode with stronger verification, or
- Mark `blocked: worker-unreliable`.

Claude does not fill the gap.

### 4. Codex Author Verification

Codex inspects the actual diff, not the worker summary. Codex runs at minimum:

```bash
npm run typecheck
npm run lint
npm run test
```

Codex adds targeted commands when relevant:

```bash
npm run test:contract
npm run test:integration
npm run test:ui
npm run smoke:pty
npm run smoke:pty:ink
npm run smoke:pty:handoff
```

Codex writes `docs/receipts/<slice>-author.md`.

If any command fails, Codex repairs or blocks. "Best effort" is not mergeable.

### 5. Independent Verification

Claude or Codex launches a verifier. The verifier receives only:

- Contract path.
- Author receipt path.
- Branch and exact head SHA.
- Required verifier instructions.

The verifier writes `docs/receipts/<slice>-verifier.md`.

The verifier can return one line to Claude, but the line is not the evidence. The receipt is the evidence.

### 6. Merge Gate

A slice is mergeable only if all are true:

- Branch is based on current main or has been refreshed from main.
- Author receipt exists and says merge recommendation yes.
- Verifier receipt exists and says `VERIFIED`.
- Verifier inspected the same head SHA that will merge.
- Required commands passed after final diff.
- Slice is dark by default or has explicit human approval.
- Rollback strategy is recorded.
- No conflicting active slice owns the same conflict domain.
- No human gate is pending.

If true, merge may proceed. If no required CI checks exist, local receipts are mandatory, not optional.

### 7. Post-Merge

After squash merge:

- Update `docs/ROADMAP-STATUS.md` to `merged`.
- Record merge commit and PR number if any.
- Append a compact archive row.
- Delete or close the branch only after merge commit is recorded.
- If merge count threshold is reached, write handoff and stop.

Claude receives:

```text
<slice> merged #<PR> green: <author receipt>, <verifier receipt>
```

or:

```text
BLOCKED <slice>: <reason> <status path>
```

## Verification Policy

### What "Green" Means

`green` means all of the following:

- Exact required commands passed after the final edit.
- The verifier independently inspected the merge candidate tree.
- Contract acceptance items have evidence.
- Relevant north-star invariants were checked.
- Dark-default/reversibility is satisfied.
- Rollback strategy exists.
- No human gate is pending.

Anything less is not green. It is `partial`, `inconclusive`, `blocked`, or `rejected`.

### Trustworthy One-Line Verdicts

One-line verdicts are allowed only when they include a pointer:

```text
VERIFIED r7-item5-05c head=<sha> receipt=docs/receipts/r7-item5-05c-verifier.md
```

Forbidden:

```text
Looks good.
Tests pass.
Implemented successfully.
Green.
```

Those are claims, not receipts.

### Anti-Gaming Verifier Rules

The verifier must not rely on the author's prose alone. It must inspect:

- `git diff main...HEAD` or equivalent.
- Contract file.
- Author receipt.
- Relevant tests.
- Relevant invariant IDs.

The verifier must reject if:

- It cannot identify the tree inspected.
- Commands were not run and no acceptable reason is recorded.
- The diff includes unexplained out-of-scope files.
- The author receipt says a command passed but the verifier observes failure.
- The slice weakens tests or acceptance criteria without a human-approved contract change.

## Quota Exhaustion Protocol

Codex quota exhaustion is a normal state, not an emergency.

If Codex is unavailable before planning:

- State: `blocked`.
- Blocker: `planner-quota`.
- Claude reports: `BLOCKED: planner quota; waiting is required because opencode cannot plan and Claude may not plan without permission.`

If Codex expires after worker edits but before author verification:

- Leave work on branch/worktree.
- Update state if possible; otherwise Claude records `blocked: planner-quota-mid-slice` in `docs/ROADMAP-STATUS.md`.
- Do not run worker again.
- Do not ask Claude to inspect and finish.
- Resume Codex later with branch, contract, and status path.

If Codex expires after author receipt but before verifier:

- Claude may launch verifier if the author receipt and contract are complete.
- If verifier rejects, wait for Codex. Claude does not repair.

If Codex expires after verifier pass but before merge:

- Claude may perform mechanical merge gate checks only if the protocol says all artifacts are complete.
- Any ambiguity blocks until Codex resumes.

## Worker Unreliability Protocol

Worker failure classes:

- `timeout`
- `database-locked`
- `empty-output`
- `out-of-scope-edit`
- `red-tests`
- `contract-miss`

Rules:

- One retry is allowed for transient `database-locked`.
- Two total failed attempts require a decision: narrow, switch author mode, or block.
- A worker that edits out-of-scope files is not trusted on that slice unless Codex can explain why the contract was wrong.
- Codex author mode is allowed only when recorded and followed by stricter verifier requirements: full diff audit, full command set, and explicit invariant check.

## Context-Bloat Controls

### Claude Context Budget

Claude should hold only:

- Current user instruction.
- Current status file.
- Latest one-line agent result.
- Human gate question if any.

Claude should not hold:

- Full plan docs.
- Full diffs.
- Raw worker logs.
- Full command output unless reporting a failure.
- Repeated status summaries.

### Status Compression

Every agent returns to Claude one of:

```text
MERGED <slice> <merge> green receipts=<paths>
READY <slice> head=<sha> receipts=<paths>
BLOCKED <slice> reason=<reason> status=<path>
REJECTED <slice> reason=<reason> receipt=<path>
GATE <slice> decision=<question> context=<path>
```

Claude must not ask for more prose unless a human gate requires it.

### Stop-Hook Scope

The stop hook should be rewritten from "finish the whole product at 10/10" to:

```text
Active milestone: <id>.
Done when: <artifact/receipt exists and state is one of merged|blocked|handoff-written>.
If not done: perform the single next action in docs/ROADMAP-STATUS.md.
Do not summarize project history.
```

It must not inject the full vision. It must not ask Claude to explain status. It must stop when a handoff is written.

## Handoff Protocol

Trigger handoff when any condition is true:

- Three successful merges in one Claude session.
- One rejected verifier after a complex slice.
- One merge conflict requiring replanning.
- Claude context is visibly drifting.
- Codex warm Item session exceeds the Item threshold.
- Human asks to pause.
- Active milestone completes.

Handoff generation:

- Generated from status and receipts, not from chat memory.
- Written to `docs/handoffs/<timestamp>-<item>.md`.
- Includes next command and exact blocker if blocked.
- Claude final response points to the handoff and stops.

Fresh session resume:

- Read `docs/ROADMAP-STATUS.md`.
- Read latest handoff.
- Launch the next command.
- Do not re-read historical plan docs unless Codex needs them.

## North-Star Preservation

The north-star cannot live in a stop hook. It must live in a compact constitution and in slice-level invariant checks.

Required practice:

- Each Item references relevant invariant IDs.
- Each slice contract references relevant invariant IDs.
- Each verifier receipt includes invariant verdicts.
- Each handoff lists only invariant changes or risks.
- A default-on flip requires a mini north-star review: "Does enabling this make the product more coherent, simpler, and closer to the target user experience, or did we only accumulate dark machinery?"

If the protocol produces many locally green slices but the default product remains incoherent, the integration checkpoint must block further slice work and require Codex replanning.

## Rollback and Quarantine

### Rollback Required in Every Receipt

Every author receipt must answer:

- What is the revert command?
- Is there state or config compatibility risk?
- Does the dark flag fully disable the behavior?
- What tests prove the off path still works?

### Quarantine

Use quarantine when:

- A merged slice breaks main.
- A dark slice affects default behavior.
- A verifier receipt is found false.
- Cross-Item integration fails after a merge.

Quarantine effects:

- Mark state `quarantined`.
- Block dependent slices.
- Create repair or revert contract.
- Do not proceed with adjacent work until quarantine is cleared.

### Repair

Repair is a new slice, not an informal patch. It needs:

- Contract.
- Author receipt.
- Verifier receipt.
- Merge gate.

Emergency revert may be performed with human approval if main is broken.

## Cross-Item Integration

Run an integration checkpoint:

- After every three merges on an Item.
- Before any default-on flip.
- Before release.
- After any conflict-heavy merge.
- After quarantine repair.

Checkpoint commands:

```bash
npm run typecheck
npm run lint
npm run test
npm run test:contract
npm run test:integration
```

Add UI or PTY smoke commands when affected:

```bash
npm run test:ui
npm run smoke:pty
npm run smoke:pty:ink
npm run smoke:pty:handoff
```

Checkpoint output:

```text
INTEGRATION VERIFIED <item> receipt=<path>
```

or:

```text
INTEGRATION BLOCKED <item> reason=<reason> receipt=<path>
```

## Human Gates

Claude surfaces these and only these unless Codex explicitly requests a product decision:

- Paid/expensive run.
- Default-on flip.
- Non-dark user-visible behavior.
- Force-push or history rewrite.
- Destructive cleanup, deleting state, or deleting unmerged branches.
- Merge with missing/failed/inconclusive verifier receipt.
- Protocol or hook change that changes authority boundaries.
- Weakening tests, deleting acceptance checks, or lowering done criteria.
- Release/publish.
- Semantic north-star amendment.

Human gate prompt format:

```text
GATE <slice>: <decision needed>. Options: <A/B>. Recommendation: <Codex recommendation>. Context: <path>.
```

Claude must not bury the decision inside a long status recap.

## Merge Authority

Because there are no required CI checks, local protocol checks are the effective protection. Therefore:

- No direct-to-main merge without receipts.
- No merge after verifier rejection without human approval.
- No merge if branch stale unless refreshed and reverified.
- No merge if status file and receipt disagree.
- No merge if dark-default is missing and no human approval exists.

Codex may execute the merge command only inside this gate. Claude may launch the merge command only if the state is `ready-to-merge` and receipts are complete. Either way, the merge is mechanical, not judgment-based.

## Failure Outcomes

Use deterministic outcomes:

- `MERGED`: slice is in main and receipts exist.
- `READY`: receipts pass, merge gate pending only mechanical action.
- `GATE`: human decision required.
- `BLOCKED`: cannot proceed without unavailable resource or decision.
- `REJECTED`: verifier found a fixable issue; Codex must repair.
- `QUARANTINED`: merged or candidate work is unsafe; dependent work stops.

Never use:

- `done` without receipt.
- `green` without command evidence.
- `probably`.
- `seems`.
- `best effort` as mergeable.

## Minimal Command Templates

Codex plan launch:

```bash
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C <repo> -m gpt-5.5 -c model_reasoning_effort=high "<prompt>" </dev/null
```

Codex resume:

```bash
codex exec resume <session-id> "<prompt>" </dev/null
```

Worker launch:

```bash
opencode run -m opencode-go/deepseek-v4-pro "<prompt>" </dev/null
```

Baseline verification:

```bash
npm run typecheck
npm run lint
npm run test
```

The closed stdin rule is non-negotiable.

## The Protocol in One Sentence

Run myshell-tools development as a receipt-backed state machine: Claude launches and gates, Codex plans and judges, workers patch, independent verifiers prove exact-tree contract compliance, main receives only dark reversible slices with rollback receipts, and every few merges the session writes a mechanical handoff and stops.

