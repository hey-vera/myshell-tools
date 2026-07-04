# Model Routing — dated capability notes

_Last verified: 2026-07-04. This doc holds VOLATILE, dated model facts so they never live in always-loaded memory or bloat `CLAUDE.md`. Re-verify before relying on any specific model: `opencode models </dev/null`, plus a smoke run for important work. Review this doc monthly._

## Roles (class-based routing)

| Role | Model class | Default | When |
| --- | --- | --- | --- |
| Always-on orchestrator (brain) | Sonnet-class | Sonnet 5 (else Sonnet 4.6) | Dispatch, gating, verification, git, receipt synthesis, bounded control-plane edits |
| Frontier planner / auditor | frontier | `codex exec -m gpt-5.5 -c model_reasoning_effort=high` | Architecture, audits, root cause, policy, multi-source research, durable plans |
| Worker (execution) — primary | opencode-go | `opencode run -m opencode-go/<model>` | Cheapest capable funded worker for bounded implementation/tests/mechanical edits |
| Worker fallback — gpt side | codex | `codex exec -m gpt-5.4` (heavier), `gpt-5.4-mini` (cheap/mechanical) | Use after opencode-go unavailability/retry exhaustion or poor task fit; ChatGPT billing |
| Worker fallback — claude side | Claude `Agent` | sonnet-class Agent subagent | Same, on Anthropic billing; useful when CLI worker path fails or separate quota is needed |
| Escalation specialist | Opus 4.8 | — | Only when a `CLAUDE.md` Opus trigger fires; never the control plane |

### Worker routing notes (2026-07-04)
- **opencode-go is FUNDED and WORKING** — live smoke run returned `GO_OK`, confirmed 2026-07-04. Earlier 2026-07-03 offline-status notes are stale.
- **Primary path:** use opencode-go first for bounded worker execution because it is the cheapest capable funded provider. Pick the cheapest capable opencode-go model for the slice; use stronger opencode-go models only when task complexity requires it.
- **Retry before fallback:** retry transient opencode-go failures with capped exponential backoff and jitter: attempt 1 immediately, attempt 2 after ~10-20s, attempt 3 after ~30-60s. Stop retrying on auth/quota/provider-disabled errors, deterministic command errors, or repeated identical failure.
- **Fallback:** use codex `gpt-5.4-mini` for cheap/mechanical work, codex `gpt-5.4` for heavier bounded work, and Claude sonnet-class `Agent` workers when CLI paths are unavailable, permissions/subagent integration helps, or quota balancing is needed. `codex exec -m <model>` runs on ChatGPT billing, independent of opencode balance.
- Claude `Agent` workers may edit `src/`/`test/` (they are separate subagents, not the orchestrator main thread — the bright line applies only to the main thread).

## Task → model routing table (task-calibrated, not provider-class-only)

Pick the **cheapest candidate that clears the task's first-time-right bar after pricing rework** (see `docs/orchestrator-protocol.md` for the objective function + quality bars). Do NOT default to `glm-5.2` for everything — it's a strong long-horizon coder, wasteful on mechanical work.

| Task | First route | Escalate when |
| --- | --- | --- |
| Mechanical edits, formatting, receipt summaries | `opencode-go/deepseek-v4-flash` (low/no effort); fallback codex `gpt-5.4-mini` | fails verification once · touches unexpected files · needs semantic judgment |
| Large read-only scan / extraction | `deepseek-v4-flash` / `mimo-v2.5` / `minimax-m3` / `qwen3.7-plus` (by live cost/context) | needs architecture judgment or conflicting evidence |
| Narrow implementation, strong tests | `deepseek-v4-flash` if coupling ≤2 & tests strong; else `deepseek-v4-pro` / `kimi-k2.7-code` | one failed attempt · weak tests · cross-module contract |
| Coding-heavy bounded implementation | `kimi-k2.7-code` / `deepseek-v4-pro` / `glm-5.2` (by registry + prior pass rate) | shared defaults/schema/release behavior · broad UI state |
| Long-context agentic refactor | `glm-5.2` / `qwen3.7-max` / `mimo-v2.5-pro` / codex `gpt-5.4` high | if expected rework exceeds the stronger-model delta, pick `gpt-5.4` first |
| UI/test-loop where harness integration matters | Claude sonnet-class `Agent` high | if Anthropic quota is pressured, use codex `gpt-5.4` high |
| Architecture / audit / root-cause / policy | codex `gpt-5.5` high (planner/auditor, NOT worker) | Opus only on named safety/default/release/conflict triggers |
| Security / privacy / destructive / default / release | strong implementer **+ independent** `gpt-5.5` or Opus reviewer | never a cheap open worker alone |

**Rework > cost-delta principle:** if a cheap worker is likely to fail and retry, the stronger model that succeeds once is *cheaper in total quota*. Price the rework, not just the per-call cost.

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
