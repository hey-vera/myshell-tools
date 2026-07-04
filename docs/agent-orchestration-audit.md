# Agent Orchestration Audit

Date: 2026-07-04

Scope: `CLAUDE.md` and `docs/model-routing.md` rules for dispatching opencode-go, codex CLI, and Claude `Agent` workers from the Sonnet-class Claude Code orchestrator.

## Executive Findings

1. The observed lost codex worker was a launch bug, not an argument against all background work. The wrapper exited while the real worker was detached with `&`, so the harness could only observe the wrapper. The fix is: foreground when the orchestrator needs the result now; background only through the harness/supervisor so the tracked process is the actual worker.
2. A 20-minute blind check-in is too passive. Use event-driven completion notifications plus a short stall watchdog based on output freshness and process activity.
3. The provider priority was stale. opencode-go is funded and working as of 2026-07-04 (`GO_OK` smoke); it should be the primary bounded worker, with retry before fallback.
4. The best fit for this CLI setup is a supervisor/worker pattern with structured dispatch contracts and receipt handoffs, not free-form autonomous swarms.

## A. Foreground vs Background Workers

Foreground is right when the orchestrator cannot make the next decision without the result, the worker is short, permission prompts are likely, or failure must be immediately visible. Claude Code's current subagent docs say Claude runs a subagent in the foreground when it needs the result before continuing, while background subagents still surface permission prompts in the main session ([Claude Code subagents](https://code.claude.com/docs/en/sub-agents)).

Background is right for independent, long-running, checkpointable work where the orchestrator can keep doing useful work. Claude Code background Bash commands return a background task ID, write output to a file, and support tracking/retrieval ([Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)). Claude Code's SDK emits `TaskNotificationMessage` when a background task completes, fails, or is stopped, including `run_in_background` Bash commands, Monitor watches, and background subagents ([Claude Code Python SDK](https://code.claude.com/docs/en/agent-sdk/python)); TypeScript SDK result messages identify background completion follow-ups with `origin: { kind: "task-notification" }` ([Claude Code TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript)). Agent View is designed to show what is running, needs input, and is done ([Claude Code Agent View](https://code.claude.com/docs/en/agent-view)).

Failure mode: nested detachment breaks observability. In Bash, `&` makes a command asynchronous in a subshell/job-control model ([bash man page](https://www.man7.org/linux/man-pages/man1/bash.1.html)). In Node-style process supervision, the parent gets a child process handle and receives lifecycle events/callbacks when that child exits; if that child is only a shell wrapper that backgrounds another process and exits, the parent has observed the wrong process ([Node child_process docs](https://nodejs.org/api/child_process.html)). That is the direct root cause of the observed "wrapper exited, real worker kept running, no completion notification" bug.

Reliable launch pattern:

```text
GOOD foreground:
  Run the actual worker command as the foreground shell command.
  Close stdin with </dev/null.
  Let stdout/stderr stream through the harness.

GOOD background:
  Start the actual opencode/codex command as the harness background task.
  Keep stdout/stderr attached to the harness output file.
  Record task_id, start time, max wall-clock, allowed files, verification command, and receipt path.

BAD:
  bash -lc "opencode run ... </dev/null &"
  bash -lc "codex exec ... </dev/null &"
  nohup/disown/Start-Process wrapper that exits before the worker exits
```

## B. Monitoring Cadence

Modern practice is event-driven first, streaming second, watchdog third. Claude Code provides task notifications for background completion/failure/stopped states, and background Bash output is recoverable by task ID/output file. OpenAI's Agents SDK streaming docs require consuming stream events until the iterator finishes; the run is not complete until the stream ends, and higher-level events report tool calls, handoffs, and messages ([OpenAI Agents SDK streaming](https://openai.github.io/openai-agents-python/streaming/)). LangGraph exposes stream modes for state updates, token messages, custom progress, task start/finish events, checkpoints, and debug events ([LangGraph streaming](https://docs.langchain.com/oss/python/langgraph/streaming)).

Replacement for "20-minute blind check-in":

- Completion: rely on harness `TaskNotificationMessage` / task notification.
- Progress: stream output where foreground; for background, read/tail the harness output file only when the watchdog fires or when the task notification arrives.
- Stall watchdog: first liveness check at 60-90 seconds, then every 2-3 minutes while active.
- Hung threshold: no new output for 5-10 minutes plus near-flat CPU/process activity, or wall-clock budget exceeded.
- Response: stop through the harness/supervisor, inspect output and diff, then resume-from-diff or retry. Do not use raw kill commands that could hit the orchestrator itself.

## C. Provider Priority, Retry, and Fallback

Provider state changed: opencode-go is funded and working as of 2026-07-04 (`GO_OK` smoke). The 2026-07-03 "UNFUNDED" claim is stale and was removed from the routing docs.

Retry basis: transient cloud/API faults are expected and should be handled with retries where appropriate; Microsoft defines retry as the standard pattern for transient faults ([Azure Retry pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/retry)). OpenAI recommends random exponential backoff for rate limits and stopping after a maximum retry count ([OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits)). Azure's reliability guide recommends exponential backoff with jitter for background operations and keeping total retry time within the end-to-end requirement ([Azure transient fault guidance](https://learn.microsoft.com/en-us/azure/well-architected/design-guides/handle-transient-faults)).

State machine:

```text
READY
  -> OPENCODE_ATTEMPT_1

OPENCODE_ATTEMPT_N
  success -> VERIFY_AND_RECEIPT
  transient failure -> wait jittered backoff, retry if N < 3
  auth/quota/provider-disabled/model-missing -> FALLBACK_CODEX_OR_AGENT
  deterministic command/prompt/scope error -> FIX_DISPATCH_ONCE_OR_BLOCK
  hang/budget exceeded -> STOP_VIA_HARNESS -> INSPECT_DIFF -> RETRY_OR_RESUME

Backoff for opencode-go transients:
  attempt 1: immediate
  attempt 2: ~10-20s
  attempt 3: ~30-60s
  cap: 3 total attempts unless user explicitly authorizes more

FALLBACK_CODEX_OR_AGENT
  mechanical/cheap -> codex gpt-5.4-mini
  heavier bounded logic -> codex gpt-5.4
  CLI unavailable, permissions/subagent integration helpful, or quota balancing needed -> Claude sonnet Agent
  frontier audit/planning only -> codex gpt-5.5 high reasoning, not worker execution
  Opus -> only CLAUDE.md escalation triggers
```

Fallback is not a substitute for retrying a cheap funded provider. It is used only after real unavailability, retry exhaustion, quota/auth failure, deterministic provider mismatch, or task-fit failure.

## D. Multi-Agent Orchestration and Communication

Adopt a supervisor/worker topology. OpenAI's orchestration guide distinguishes handoffs, where a specialist takes over, from "agents as tools", where a manager remains responsible; for this repo, manager-style control is the right default because the Claude Code orchestrator owns git, verification, receipts, and final synthesis ([OpenAI orchestration guide](https://developers.openai.com/api/docs/guides/agents/orchestration)). OpenAI's Python SDK also frames orchestration as either LLM-decided flow or code-determined flow, with mixed patterns possible ([OpenAI Agents SDK orchestration](https://openai.github.io/openai-agents-python/multi_agent/)).

Use structured handoffs: objective, allowed files, forbidden files, verification command, wall-clock budget, output/receipt path, and return schema. OpenAI Agents define agents with instructions, tools, handoffs, guardrails, and structured outputs ([OpenAI Agents SDK agents](https://openai.github.io/openai-agents-python/agents/)); tracing captures LLM generations, tool calls, handoffs, guardrails, and custom events for debugging ([OpenAI Agents SDK tracing](https://github.com/openai/openai-agents-python/blob/main/docs/tracing.md)).

Do not oversplit coding work. Anthropic reports multi-agent systems excel on breadth-first, parallel research and outperformed single-agent Opus on an internal research eval, but that pattern is most natural where independent directions can be pursued in parallel ([Anthropic multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). LangChain's 2025 analysis warns that read-heavy multi-agent systems are easier than write-heavy ones because parallel writes create context-transfer and merge conflicts; it recommends durable execution, debugging, observability, and evaluation ([LangChain multi-agent guidance](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems)). LangChain's benchmark describes supervisor architecture as a single supervisor delegating to subagents and receiving control back, and notes supervisor/swarm token behavior stays flatter under added distractor domains than a single agent ([LangChain architecture benchmark](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)).

Recommendation for this CLI setup:

- Keep Claude Code as supervisor/orchestrator.
- Use opencode-go/codex/Claude Agent workers as bounded tools, not autonomous co-planners.
- Pass structured dispatch contracts and require receipt-first returns.
- Stream or event-notify all long runs; write receipts to repo files.
- Parallelize only independent file/conflict domains.
- Serialize when workers share schemas, defaults, fixtures, UX flow, or combined verification is the first meaningful test.

## Recommended Worker Dispatch Protocol

1. Classify task.
   - Foreground: dependent result, short task, likely permission prompt, immediate failure sensitivity.
   - Background: independent, long-running, checkpointable, with explicit receipt path and wall-clock budget.
2. Build dispatch contract.
   - Include objective, model/provider, allowed files, forbidden files, verification command, max wall-clock, output/receipt path, return schema, and `BLOCKED` conditions.
3. Choose provider.
   - Primary: opencode-go.
   - Retry opencode-go transients up to 3 attempts with jittered backoff.
   - Fallback to codex mini/full or Claude Agent only under the state machine above.
4. Launch reliably.
   - No nested `&`, `nohup`, `disown`, `Start-Process`, or wrapper detaches.
   - The harness background task must be the actual worker process.
   - Close stdin with `</dev/null`.
   - Preserve stdout/stderr in the harness stream/output file.
5. Monitor.
   - Completion notification is authoritative for done/failed/stopped.
   - Watchdog at 60-90s, then every 2-3 minutes.
   - Hung if 5-10 minutes of no output plus flat CPU/process activity or budget exceeded.
6. Recover.
   - Stop via harness/supervisor.
   - Inspect diff and output.
   - Resume from partial diff or retry the same provider before fallback when the failure was transient.
7. Verify.
   - Run the requested verification command.
   - Require receipt-first worker return.
   - Orchestrator independently checks diff/test evidence before merge/reporting.

## Exact Edits Applied

### `CLAUDE.md`

- Replaced the worker execution bullet that said to balance codex/Claude workers and use "opencode-go only if funded" with a rule that funded opencode-go is primary, with bounded retries and codex/Claude only as fallback.
- Replaced the contradictory `Worker Liveness (never wait blind)` section with `Worker Dispatch and Liveness`, including:
  - foreground/background decision rule,
  - ban on nested `&`, `nohup`, `disown`, `Start-Process`, and short-lived wrappers,
  - reliable background launch pattern,
  - event-driven completion plus 60-90s then 2-3 minute watchdog cadence,
  - no 20-minute blind check-ins,
  - stall/budget recovery via harness stop, diff inspection, and resume/retry.
- Replaced the stale model-routing bullets:
  - removed "`opencode-go is UNFUNDED ... confirmed 2026-07-03`",
  - added "`opencode-go is FUNDED and WORKING ... confirmed 2026-07-04`",
  - made opencode-go the primary bounded worker with retry/fallback rules.

### `docs/model-routing.md`

- Changed `_Last verified_` from 2026-07-03 to 2026-07-04.
- Added a primary worker row for `opencode run -m opencode-go/<model>`.
- Reclassified codex and Claude Agent workers as fallbacks.
- Replaced the 2026-07-03 `opencode-go is UNFUNDED` note with 2026-07-04 `FUNDED and WORKING` and the retry/fallback policy.
- Added the opencode-go `GO_OK` smoke result to empirical smoke tests.
- Rewrote the smoke-test interpretation so opencode-go is primary and codex/Claude are fallbacks.
- Changed the opencode-go catalog heading from "UNFUNDED as of 2026-07-03" to "funded as of 2026-07-04".
- Kept the warning that catalog existence is not permanent funded access and important work should re-confirm after provider/auth/quota errors.

## Source Index

- Claude Code background Bash commands: https://code.claude.com/docs/en/interactive-mode
- Claude Code task notifications, Python SDK: https://code.claude.com/docs/en/agent-sdk/python
- Claude Code task-notification origin, TypeScript SDK: https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Code Agent View: https://code.claude.com/docs/en/agent-view
- Claude Code subagents foreground/background behavior: https://code.claude.com/docs/en/sub-agents
- Node child process lifecycle: https://nodejs.org/api/child_process.html
- Bash asynchronous commands/job control: https://www.man7.org/linux/man-pages/man1/bash.1.html
- OpenAI Agents orchestration: https://developers.openai.com/api/docs/guides/agents/orchestration
- OpenAI Agents SDK orchestration: https://openai.github.io/openai-agents-python/multi_agent/
- OpenAI Agents SDK streaming: https://openai.github.io/openai-agents-python/streaming/
- OpenAI Agents SDK agents: https://openai.github.io/openai-agents-python/agents/
- OpenAI Agents SDK tracing: https://github.com/openai/openai-agents-python/blob/main/docs/tracing.md
- OpenAI rate-limit retry guidance: https://developers.openai.com/api/docs/guides/rate-limits
- Azure Retry pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/retry
- Azure transient fault guidance: https://learn.microsoft.com/en-us/azure/well-architected/design-guides/handle-transient-faults
- LangGraph streaming: https://docs.langchain.com/oss/python/langgraph/streaming
- Anthropic multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- LangChain multi-agent architecture benchmark: https://www.langchain.com/blog/benchmarking-multi-agent-architectures
- LangChain when to build multi-agent systems: https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems
