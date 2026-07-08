# Grok handoff: myshell-tools actualization and Cortex bridge planning

You are taking over myshell-tools after a cleanup/actualization pass. Do not start from first principles; continue from the current repo state and respect the direction below.

## Product framing

myshell-tools is the public, subscription-native "one chat to rule them all" CLI tool. It should feel like a real user tool, not a developer toy. The ideal user experience is ordinary chat: users say "what changed?", "undo that", "run the tests", "fix this", "use another model", "don't touch tests", etc., and the tool handles the right repo/model workflow under the hood.

Cortex is separate: think of Cortex as the API-key/harness/orchestrator big brother of myshell-tools. Do not collapse these two products. myshell-tools should stay subscription/OAuth CLI-first. Cortex/bridging/API-land spec work should come later and should be based on what myshell-tools actually implements, not speculative abstraction.

Kern-like capabilities are already being actualized inside myshell-tools: repo intent, checkpoints, evidence/provenance, context hygiene, pressure honesty, and safe natural-language control. Do not write a new abstract Kern spec for myshell-tools unless the implementation reveals a concrete gap. If you write any spec now, it should be a practical bridge/API-land spec for myshell-tools -> Cortex, after implementation reality is audited.

## Current important commits on main

Recent local commits, not necessarily pushed:

- `7d54eb5 feat(interface): wire safe repo chat intents`
- `098a514 feat(interface): handle safe repo chat intents`
- `126546a feat(infra): persist ai checkpoints and repo ops`
- `b58daf6 feat(core): add repo intent and pressure foundations`
- `76bfb7e docs: plan subscription native repo editing`
- `778253e 3.163.1`
- `7fe723b feat(core): default on kern preflight and completion spine` is `origin/main`

At handoff time, `main` was clean and ahead of `origin/main` by 6 commits.

## Verification already run

The latest cleanup pass ran:

- focused repo/Kern tests: passing
- architecture guard + focused tests: `1390 passed`
- full standard suite: `npm test` -> `8532 passed`, `14 skipped`
- typecheck: `npm run typecheck` -> passing
- lint: `npm run lint` -> 0 errors, 3 existing warnings in `test/integration/p0-pty-benchmark.test.ts`
- `git diff --check` -> clean before commit

Note: PowerShell command output in this environment often prints the interactive myshell-tools menu and a libuv assertion after command output. Treat that as noisy terminal state unless the command exit code or test output shows a real failure.

## What is implemented now

### Core repo intent

`src/core/repo-intent.ts` classifies natural-language repo operations without slash commands:

- `status`
- `summarize_diff`
- `verify_only`
- `undo_last_ai_change`
- `commit_current_ai_change`
- `edit_and_verify`
- `plan_only`
- `provider_steering`
- `none`

It also extracts constraints like no new deps, small patch, exclude tests/UI, show diff before applying, do not commit, provider steering, and test scope.

### AI checkpoints

`src/core/ai-checkpoint.ts` has pure checkpoint build/undo planning:

- created/modified/deleted file tracking
- before/after fingerprints
- conflict refusal when current files differ from the checkpoint after-state
- no filesystem writes from core

`src/infra/ai-checkpoint-store.ts` persists checkpoints under project-scoped state.

### Repo ops

`src/infra/repo-ops.ts` provides non-mutating local repo operations:

- git status summary
- git diff stat/preview
- detected test command

It intentionally does not apply patches, commit, delete, or write files.

### Safe repo chat handler

`src/interface/repo-chat-handler.ts` handles natural chat inputs safely:

- "status" / "where are we?" -> local status response
- "what changed?" / "show diff" -> local diff response
- "run tests" / "verify" -> detects test command but does not run it
- "undo that" -> checkpoint-aware undo preview only; no writes
- "commit this" -> detects intent but refuses because commit is mutating
- edit/build requests return `null` and fall through to the normal orchestrator

`src/interface/menu.ts` now wires the safe handler into live chat before the expensive model/orchestrator path. This is intentionally non-mutating.

### Subscription pressure honesty

`src/core/subscription-pressure.ts` models pressure signals/provenance without fake quota. It must never claim exact remaining subscription quota unless a future official provider field exists. It is reachable via `src/core/capability-budget.ts` exports.

## Non-negotiable design rules

1. No API drift for myshell-tools. Subscription OAuth CLIs are the default/recommended path. OpenCode Go API-key access is the explicit exception, not the product center of gravity.
2. Do not invent quota numbers. Subscription tools usually do not expose exact remaining weekly/monthly quota. Use observed pressure, cooldowns, local transcripts, external monitor estimates, and receipts with provenance.
3. Do not add slash commands for core repo behavior unless absolutely necessary. Native chat behavior is the product advantage.
4. Do not make destructive/mutating operations implicit. Undo execution, test running, commits, and patch application need appropriate gates/checkpoints/receipts.
5. Preserve architecture boundaries:
   - core = pure, no fs/path/crypto/child_process/Date.now/Math.random side effects
   - infra = local IO/process adapters
   - interface = chat/menu wiring and user-facing output
6. Do not fake AI control over latent reasoning. Externalize state, evidence, constraints, plans, receipts, and checkpoints; do not claim to control a model's hidden chain of thought.
7. Avoid tech debt. Small tested slices. Keep diffs reviewable. Run tests.

## Remaining actualization work

### 1. Checkpoint creation around actual AI edits

The checkpoint store exists, but AI-authored file edits still need to be captured automatically around the real edit/apply path.

Implement so that when myshell-tools applies AI-authored changes, it records:

- checkpoint id
- createdAt
- repoRoot
- user intent
- touched files
- beforeText/afterText or enough safe evidence
- file kind: created/modified/deleted

Do not record secrets unnecessarily. Keep it project-scoped. Do not overwrite user-owned changes.

### 2. Safe undo execution

Currently undo is preview-only. Add actual undo execution behind the checkpoint conflict gate.

Expected behavior:

- User says "undo that".
- Tool finds latest AI checkpoint.
- Tool compares current files against checkpoint after-state.
- If any file diverged, refuse and explain conflicts.
- If safe, either apply automatically only when oversight/autonomy settings allow, or ask confirmation depending on existing oversight policy.
- Write/delete only the checkpoint-planned actions.
- Emit a receipt.

Do not use `git reset --hard` or broad destructive commands.

### 3. Test execution gate

Currently "run tests" detects the command but does not run it. Wire this into the existing verify/test-command machinery safely.

Expected behavior:

- Natural request: "run tests", "verify this", "make sure it's green".
- Detect relevant test command.
- Use existing oversight/config rules to decide ask-confirm vs run.
- Never run arbitrary shell from model text without command gate/review.
- Emit a concise receipt with command, exit status, and summary.

### 4. Commit flow gate

Currently "commit this" refuses because it is mutating. Add a safe commit flow only after verify/checkpoint behavior is reliable.

Expected behavior:

- Summarize current AI-authored/user-visible changes.
- Ensure no accidental unrelated files are included.
- Ask confirmation unless existing oversight explicitly allows.
- Commit with a generated but reviewable message.
- Never silently commit secrets or unrelated work.

### 5. Live user smoke tests

After the next actualization slice, run myshell-tools like a real user:

- start menu
- new conversation
- ask "status"
- ask "what changed?"
- ask "run tests"
- ask "undo that" before any checkpoint exists
- perform a tiny AI edit
- verify checkpoint creation
- ask "what changed?"
- ask "undo that"
- verify safe preview/execution behavior
- verify no unwanted commands/commits happen

### 6. Provider/subscription pressure adapters

Optional, only if available and honest:

- local Claude transcript consumption estimates
- claude-monitor/cmonitor if installed
- OpenTelemetry/custom hook JSON if user configured it
- provider cooldown/rate-limit observations

Important: all of these are estimates or observed pressure unless official exact quota exists. Receipt language must say that.

### 7. Cortex bridge/API-land planning

Only after myshell-tools behavior is real and audited, write a practical bridge/spec for Cortex.

Frame it as:

- myshell-tools = subscription-native local CLI user tool
- Cortex = API-key/harness/orchestrator big brother
- shared concepts: ContextPacket, StateDelta, evidence/provenance, checkpoints, repo intent, pressure signals, receipts
- different ownership: myshell-tools owns local subscription UX; Cortex owns API orchestration/execution harness
- bridge should be based on implemented myshell-tools seams, not speculative Kern language

## Before touching code

Run:

- `git status --short --branch`
- inspect recent commits
- inspect the files listed above
- run focused tests if you change anything near repo intent/checkpoints/repo ops/menu

## Quality bar

The end state should feel better than Aider not because it copies Aider commands, but because it makes repo work conversational and safe by default. The user should not need to learn a command grammar for common actions. The tool should understand normal developer language, preserve context, make safe plans, show receipts, use subscription providers honestly, and avoid context chaos.
