# Model Routing — dated capability notes

_Last verified: 2026-07-04. This doc holds VOLATILE, dated model facts so they never live in always-loaded memory or bloat `CLAUDE.md`. Re-verify before relying on any specific model: `opencode models </dev/null`, plus a smoke run for important work. Review this doc monthly._

## Roles (class-based routing)

Latency is a first-class factor, not a tie-break. Prefer the FASTEST worker that clears the quality bar � a model finishing in minutes beats a cheaper one taking 30-45 min; wall-clock is a real cost, and the menu build took ~18h largely due to slow `glm-5.2` workers. Objective: perfect-first-time (no overkill) -> minimize (total quota incl. rework + a latency penalty) -> remaining tie-breaks.

| Role | Model class | Default | When |
| --- | --- | --- | --- |
| Always-on orchestrator (brain) | Sonnet-class | Sonnet 5 (else Sonnet 4.6) | Dispatch, gating, verification, git, receipt synthesis, bounded control-plane edits |
| Frontier planner / auditor | frontier | `codex exec -m gpt-5.5 -c model_reasoning_effort=high` | Architecture, audits, root cause, policy, multi-source research, durable plans |
| Worker (execution) � primary | opencode-go | `opencode run -m opencode-go/<model>` | Cheapest capable funded worker for bounded implementation/tests/mechanical edits |
| Worker fallback � gpt side | codex | `codex exec -m gpt-5.4` (heavier), `gpt-5.4-mini` (cheap/mechanical) | Use after opencode-go unavailability/retry exhaustion or poor task fit; ChatGPT billing |
| Worker fallback � claude side | Claude `Agent` | sonnet-class Agent subagent | Same, on Anthropic billing; useful when CLI worker path fails or separate quota is needed |
| Escalation specialist | Opus 4.8 | � | Only when a `CLAUDE.md` Opus trigger fires; never the control plane |
### Worker routing notes (updated 2026-07-05)
- **opencode-go funding is VOLATILE** — funded 2026-07-04 (`GO_OK` smoke), then **out of quota 2026-07-05** (dispatch failed with exit `127` after the banner). Do not assume availability; smoke-verify (`opencode run -m opencode-go/deepseek-v4-flash "GO_OK" </dev/null`) before relying on it. **Later same day: it also silently HANGS instead of failing fast** — a re-smoke sat at 0 output for 4+ min while spawning multiple stacked `opencode.exe` processes (up to 5 concurrent, one at 598MB RSS) that had to be `taskkill`'d. Treat any opencode-go call with no output after ~2 min as hung, not slow — kill it, don't wait longer.
- **codex (ChatGPT billing) ALSO hit its usage limit on 2026-07-05**, mid-session, across both `gpt-5.4-mini` and `gpt-5.4` — error: `You've hit your usage limit ... try again at Jul 7th, 2026`. One in-flight `gpt-5.4` dispatch produced a genuinely incomplete diff (imports/scaffolding written, wiring not finished) with no commit/push before stalling (0 output growth, 0% CPU for 10+ min) — treat a codex worker that goes silent after this date as quota-exhausted, not transiently stuck; stop it and resume-from-diff rather than waiting. It also recovered mid-session (a later smoke call succeeded) — quota resets aren't always exactly on the stated retry time, so re-smoke before assuming it's still down.
- **`opencode auth list` shows TWO separate credential entries — `opencode` (Zen) and `opencode-go`** — both can independently hang/exhaust. On 2026-07-05, the `opencode-go` key in `auth.json` was exhausted (hangs on its startup banner, no output, no error) while Zen returned "Insufficient balance" (Zen has no funding at all — do not use it as a fallback). The user supplied a second `opencode-go` API key with quota remaining, swapped into `~/.local/share/opencode/auth.json`'s `opencode-go.key` — confirmed working via smoke test. **If opencode-go hangs again, ask the user whether a fresh/alternate key is available before concluding it's fully exhausted** — this account rotates keys, it isn't a single fixed credential. Never write the actual key value into docs/memory/git; keys are local-machine-only, ask the user directly if a swap is needed. **`auth.json` has only one slot per provider name** — swapping in a second key overwrites the first in that file (back it up first, e.g. `cp auth.json auth.json.bak-$(date +%s)`, so both key values survive on disk and can be swapped back).
- **codex's own sandbox reliably blocks `git add`/`commit`/`push` (`index.lock: Permission denied`) and often blocks real `npm test`/child-process spawns (`spawn EPERM`) even when it can run `typecheck`/`lint` cleanly** — this happened on essentially every codex dispatch this session. Never trust a codex worker's self-reported test/commit status; always re-run the real verification commands yourself in the actual worktree (outside its sandbox) before pushing, and expect to do the `git add`/commit/push yourself.
- **A repo hook (`.claude/hooks/block-main-thread-code-edits.mjs`) denies ALL Edit/Write calls under `src/`/`test/` regardless of caller** — it can't distinguish the orchestrator main thread (correctly restricted) from an authorized Claude `Agent` subagent (which CLAUDE.md explicitly permits to edit those paths). Known gap, not yet fixed. The one legitimate workaround observed working this session: route the actual edit through `opencode run`/`codex exec` (the hook's own documented escape hatch, since those CLIs run outside the tool path it intercepts) rather than trying to get the Agent subagent itself to bypass the hook — an Agent asked to do so correctly refused, since no agent message can authorize routing around a configured permission control; only the actual hook/config being fixed, or the real user's explicit approval, can.
- **Independent gate verification is not optional — it caught real bugs a self-report missed, repeatedly, this session**: Slice 5's implementer missed two High-severity command-gate bugs (no audit record on the fallback path, unenforced `forbidBackground`) that only surfaced under a dedicated adversarial security review; Slice 8's implementer broke two pre-existing tests that only surfaced under a full independent test run (its own sandbox-blocked run never got that far); Slice 11's implementer's own sandboxed gate run falsely reported failure on `test`/`test:ui`/`test:integration` (real cause: a Windows-only `spawn EPERM` in the sandbox, not the code) while missing a real Windows-only `knip` failure entirely (a check the orchestrator hadn't run either, the first time) — both only surfaced by actually running every CI-equivalent gate command locally, not by reading a receipt.
- **`opencode-go` hung processes can survive their tracked wrapper being killed by the harness** — check `tasklist`/file-mtimes, not just the notification, before concluding a worker is dead; conversely, a harness "killed" notification does not guarantee the underlying process actually stopped.
- **Path:** opencode-go is cheapest *when funded* — try it for bounded work, but treat codex `gpt-5.4-mini` (mechanical) / `gpt-5.4` (heavier) as the **reliable practical default** given how often opencode is exhausted. On a quota / `127` / auth error, switch to codex **immediately**; do NOT retry opencode. **With both opencode-go and codex exhausted simultaneously (as of 2026-07-05), fall back to Claude sonnet-class `Agent` workers** (separate Anthropic billing) — model param can be tuned down (e.g. `haiku`) for mechanical fixes with a strong test oracle.
- **Retry only TRANSIENT failures** (network blips) with capped backoff (immediate → ~10-20s → ~30-60s). A quota / auth / `127` / provider-disabled error is NOT transient — fall back to codex at once.
- **Fallback:** use codex `gpt-5.4-mini` for cheap/mechanical work, codex `gpt-5.4` for heavier bounded work, and Claude sonnet-class `Agent` workers when CLI paths are unavailable, permissions/subagent integration helps, or quota balancing is needed. `codex exec -m <model>` runs on ChatGPT billing, independent of opencode balance.
- Claude `Agent` workers may edit `src/`/`test/` (they are separate subagents, not the orchestrator main thread — the bright line applies only to the main thread).

## Task ? model routing table (task-calibrated, not provider-class-only)

Pick the **fastest candidate that clears the task's first-time-right bar after pricing rework and latency together** (see `docs/orchestrator-protocol.md` for the objective function + quality bars). Do NOT default to `glm-5.2` for everything � it's a strong long-horizon coder, but often wasteful when a faster worker clears the same bar.

| Task | First route | Escalate when |
| --- | --- | --- |
| Mechanical edits, formatting, receipt summaries | `opencode-go/deepseek-v4-flash` (low/no effort); fallback codex `gpt-5.4-mini` | fails verification once � touches unexpected files � needs semantic judgment |
| Large read-only scan / extraction | `deepseek-v4-flash` / `mimo-v2.5` / `minimax-m3` / `qwen3.7-plus` (by live cost/context) | needs architecture judgment or conflicting evidence |
| Narrow implementation, strong tests | `deepseek-v4-flash` if coupling =2 & tests strong; else `deepseek-v4-pro` / `kimi-k2.7-code` | one failed attempt � weak tests � cross-module contract |
| Coding-heavy bounded implementation | `kimi-k2.7-code` / `deepseek-v4-pro` / `glm-5.2` (by registry + prior pass rate) | shared defaults/schema/release behavior � broad UI state |
| Long-context agentic refactor | `qwen3.7-max` / `mimo-v2.5-pro` / codex `gpt-5.4` high / fastest strong fit | prefer a faster model or Claude Agent over `glm-5.2` when it clears the same bar; if expected rework exceeds the stronger-model delta, pick `gpt-5.4` first |
| UI/test-loop where harness integration matters | Claude sonnet-class `Agent` high | if Anthropic quota is pressured, use codex `gpt-5.4` high |
| Architecture / audit / root-cause / policy | codex `gpt-5.5` high (planner/auditor, NOT worker) | Opus only on named safety/default/release/conflict triggers |
| Security / privacy / destructive / default / release | strong implementer **+ independent** `gpt-5.5` or Opus reviewer | never a cheap open worker alone |

**Rework + latency > sticker-price principle:** if a cheap worker is likely to fail and retry, or simply take far longer, the stronger/faster model that succeeds once is cheaper in real total cost. Price the rework and the wall-clock, not just the per-call cost.
## Pricing (Anthropic, per MTok, verified 2026-07-03)

- **Opus 4.8** — $5 input / $25 output. Defaults to high effort. Reserve for escalation.
- **Sonnet 5** — $3 input / $15 output. Faster; covers a wider cost-performance range than Sonnet 4.6 and matches Opus 4.8 on some tasks at higher effort. Preferred cheap brain where available.
- Sources: [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview), [Introducing Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8).

## Claude model + effort-tier matrix (authoritative — from the built-in `claude-api` reference, verified 2026-07-03)

The orchestrator picks both a **model** and an **effort level**. Effort is the primary intelligence↔latency↔cost dial.

| Model | ID | Context / max out | $/MTok in·out | Effort levels | Best for |
| --- | --- | --- | --- | --- | --- |
| **Opus 4.8** | `claude-opus-4-8` | 1M / 128K | $5 · $25 | low/medium/high/**xhigh**/max | Escalation only: hardest reasoning, long-horizon agentic, subtle judgment |
| **Sonnet 5** | `claude-sonnet-5` | 1M / 128K | $3 · $15 ($2·$10 intro→2026-08-31) | low/medium/high/**xhigh**/max | The orchestrator brain; near-Opus coding/agentic at Sonnet cost |
| **Sonnet 4.6** | `claude-sonnet-4-6` | 1M / 128K | $3 · $15 | low/medium/high/max (**no xhigh**) | Fallback brain if Sonnet 5 unavailable |
| **Haiku 4.5** | `claude-haiku-4-5` | 200K / 64K | $1 · $5 | **none** (effort/max error) | Fast/cheap simple tasks; not for effort-sensitive work |

**Effort levels (what each buys):**
- `low` — subagents, simple/scoped tasks, latency-sensitive; strict scoping (risk of under-thinking on hard tasks).
- `medium` — balanced cost/quality; Sonnet 5 @medium ≈ Sonnet 4.6 @high.
- `high` — **default**; the floor for most intelligence-sensitive work.
- `xhigh` — best for coding/agentic (Opus 4.8, Sonnet 5 only); Claude Code's default.
- `max` — correctness over cost; can overthink — reserve for the hardest, latency-insensitive cases.

Routing implication: the orchestrator runs on **Sonnet 5 at medium/high**; escalates to **Opus 4.8 at high/xhigh** only when a `CLAUDE.md` trigger fires. Don't reflexively pick `xhigh`/`max` — higher effort up front often *reduces* total tokens on agentic work, but on routine work it burns for no gain.

## Empirical smoke tests (2026-07-03 — do NOT re-run routinely; smoke-tests cost real quota)

One identical bounded coding task (a `slugify` function + assertions), run once per funded worker:

| Worker | Result | First-try | Tokens | Quota |
| --- | --- | --- | ---: | --- |
| opencode-go | ✅ `GO_OK` smoke | yes | not recorded | opencode-go |
| codex `gpt-5.4` | ✅ correct | yes | ~11.0k | ChatGPT |
| codex `gpt-5.4-mini` | ✅ correct | yes | ~11.0k | ChatGPT |
| sonnet-class `Agent` (Sonnet 5) | ✅ correct | yes (1 attempt) | ~26.7k | Anthropic |

Read: opencode-go is currently funded and should be the primary bounded worker. The codex and Claude workers remain viable fallbacks. `gpt-5.4-mini` matched `gpt-5.4` on a mechanical task → default mini for mechanical codex fallback, reserve full 5.4 for heavier logic. Sonnet Agent costs more tokens but on a *separate* quota — the reason to keep it as a fallback. (Small smoke tasks do not prove harder-slice quality — **profile via research + this doc, not by burning smoke-test quota every time**. Smoke only as a rare pre-flight for a genuinely unknown worker before a big task.)

## Fuller capability profiles + routing guide

Frontier research pass (gpt-5.5, online, 2026-07-03) with per-model profiles (gpt-5.4/5.5, opencode-go roster) and a task-type→model decision guide: **`docs/model-capability-research.md`**. Treat its non-Claude figures as dated/verify-at-use; the Claude matrix above is authoritative.

## opencode-go worker catalog snapshot (funded as of 2026-07-04)

Listed by `opencode models </dev/null` on 2026-07-03:
`deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, `glm-5.2`, `kimi-k2.6`, `kimi-k2.7-code`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m2.7`, `minimax-m3`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`.

- Cheap mechanical worker: `deepseek-v4-flash` (or current cheapest capable, smoke-verified).
- Stronger bounded implementation: `deepseek-v4-pro`, `glm-5.2` (or current strongest, smoke-verified).
- Existence in the catalog ≠ funded access forever. It is funded as of 2026-07-04; re-confirm with a smoke run before important work or after provider/auth/quota errors.

## Why a Sonnet-class brain (research basis, 2026-07-03)

- **Orchestrator-worker is a proven production pattern with context isolation.** Anthropic's research system (Opus lead + Sonnet subagents) beat single-Opus by 90.2%; multi-agent burns ~15× chat tokens, so artifact/receipt handoff (not raw context) is mandatory. [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system).
- **Don't over-split.** Premature specialization is itself cost + reliability loss; start with one agent, split only for genuinely distinct instructions/tools. [OpenAI Agents guide](https://developers.openai.com/api/docs/guides/agents/orchestration).
- **Supervisor topologies flatten token growth but risk translation loss** — mitigate with receipts, citations, line refs. [LangChain benchmarks](https://www.langchain.com/blog/benchmarking-multi-agent-architectures).
- **Cheap-router/expensive-worker works only with a competent, rule-governed router.** [RouteLLM](https://www.lmsys.org/blog/2024-07-01-routellm/) · [RouterEval](https://aclanthology.org/2025.findings-emnlp.208.pdf).
- **Two routing failure modes to guard against:** *routing collapse* (over-escalation to the expensive model) and *under-escalation* (cheap model keeps hard work, returns confident-but-wrong). Fix = a fixed escalation trigger list + verification, not free judgment. [Routing Collapse](https://arxiv.org/html/2602.03478v1) · [Cluster, Route, Escalate](https://arxiv.org/html/2606.27457v1).




