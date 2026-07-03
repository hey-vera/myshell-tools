# Model Routing — dated capability notes

_Last verified: 2026-07-03. This doc holds VOLATILE, dated model facts so they never live in always-loaded memory or bloat `CLAUDE.md`. Re-verify before relying on any specific model: `opencode models </dev/null`, plus a smoke run for important work. Review this doc monthly._

## Roles (class-based routing)

| Role | Model class | Default | When |
| --- | --- | --- | --- |
| Always-on orchestrator (brain) | Sonnet-class | Sonnet 5 (else Sonnet 4.6) | Dispatch, gating, verification, git, receipt synthesis, bounded control-plane edits |
| Frontier planner / auditor | frontier | `codex exec -m gpt-5.5 -c model_reasoning_effort=high` | Architecture, audits, root cause, policy, multi-source research, durable plans |
| Worker (execution) | opencode-go | cheapest capable, verified | Bounded implementation, tests, mechanical edits behind a reviewed objective |
| Escalation specialist | Opus 4.8 | — | Only when a `CLAUDE.md` Opus trigger fires; never the control plane |

## Pricing (Anthropic, per MTok, verified 2026-07-03)

- **Opus 4.8** — $5 input / $25 output. Defaults to high effort. Reserve for escalation.
- **Sonnet 5** — $3 input / $15 output. Faster; covers a wider cost-performance range than Sonnet 4.6 and matches Opus 4.8 on some tasks at higher effort. Preferred cheap brain where available.
- Sources: [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview), [Introducing Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8).

## opencode-go worker catalog snapshot (verify before use — DO NOT trust as durable)

Listed by `opencode models </dev/null` on 2026-07-03:
`deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, `glm-5.2`, `kimi-k2.6`, `kimi-k2.7-code`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m2.7`, `minimax-m3`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`.

- Cheap mechanical worker: `deepseek-v4-flash` (or current cheapest capable, smoke-verified).
- Stronger bounded implementation: `deepseek-v4-pro`, `glm-5.2` (or current strongest, smoke-verified).
- Existence in the catalog ≠ funded access. Confirm with a smoke run.

## Why a Sonnet-class brain (research basis, 2026-07-03)

- **Orchestrator-worker is a proven production pattern with context isolation.** Anthropic's research system (Opus lead + Sonnet subagents) beat single-Opus by 90.2%; multi-agent burns ~15× chat tokens, so artifact/receipt handoff (not raw context) is mandatory. [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system).
- **Don't over-split.** Premature specialization is itself cost + reliability loss; start with one agent, split only for genuinely distinct instructions/tools. [OpenAI Agents guide](https://developers.openai.com/api/docs/guides/agents/orchestration).
- **Supervisor topologies flatten token growth but risk translation loss** — mitigate with receipts, citations, line refs. [LangChain benchmarks](https://www.langchain.com/blog/benchmarking-multi-agent-architectures).
- **Cheap-router/expensive-worker works only with a competent, rule-governed router.** [RouteLLM](https://www.lmsys.org/blog/2024-07-01-routellm/) · [RouterEval](https://aclanthology.org/2025.findings-emnlp.208.pdf).
- **Two routing failure modes to guard against:** *routing collapse* (over-escalation to the expensive model) and *under-escalation* (cheap model keeps hard work, returns confident-but-wrong). Fix = a fixed escalation trigger list + verification, not free judgment. [Routing Collapse](https://arxiv.org/html/2602.03478v1) · [Cluster, Route, Escalate](https://arxiv.org/html/2606.27457v1).
