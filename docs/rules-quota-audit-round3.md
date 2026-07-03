# Rules + Quota Audit Round 3

Date: 2026-07-03

Role: third-round frontier auditor with online research.

Inputs read:

- `docs/rules-quota-audit-round1.md`
- `docs/rules-quota-audit-round2.md`
- `CLAUDE.md`

Question audited: whether the always-on orchestrator should remain Claude Opus 4.8, move to a cheaper Sonnet-class model, or use a hybrid cheap-orchestrator / expensive-specialist topology; whether the orchestrator's own grounding reads should be delegatable to cheap readers; and whether Round 2's lean `CLAUDE.md` needs changes.

## Executive Verdict

Use a hybrid: the always-on orchestrator should be the cheapest capable Sonnet-class model, not Opus 4.8. In the exact options the user named, that means Sonnet 4.6 as brain with explicit Opus 4.8 escalation triggers. With current public Anthropic docs, Sonnet 5 now appears to supersede Sonnet 4.6 as the better cheap-brain candidate if it is available locally: Anthropic prices Sonnet 5 at $3/MTok input and $15/MTok output versus Opus 4.8 at $5/$25, and describes Sonnet 5 as covering a wider cost-performance range than Sonnet 4.6 and matching Opus 4.8 on some tasks at higher effort. If this project is constrained to Sonnet 4.6, the hybrid recommendation still holds, but the trigger list should be stricter.

Do not run Opus as the permanent control plane. Opus should be a summoned specialist for hard judgment, not the model that pays premium rates to run `rg`, read files, route workers, or absorb receipt chatter.

Also allow cheap grounding-reader delegates, but only when the avoided read is meaningfully larger than the dispatch overhead and the reader returns a conclusion with citations or file/line refs. For small reads, the extra round trip costs more than it saves and adds another place for lossy summarization.

## Research Findings

### 1. Orchestrator-worker is a real production pattern, but it must preserve context isolation

Anthropic describes its Research system as an orchestrator-worker architecture: a lead agent creates specialized subagents, each with its own context, then synthesizes their outputs. Its internal eval found a Claude Opus 4 lead plus Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on a research benchmark. The same article says token usage explained much of the gain, but also warns that agents use about 4x chat tokens and multi-agent systems about 15x chat tokens, so economics matter. Anthropic explicitly recommends artifact handoff: subagents write work to a filesystem and pass lightweight references back to avoid conversation-history bloat and the "game of telephone." Source: [Anthropic, "How we built our multi-agent research system"](https://www.anthropic.com/engineering/multi-agent-research-system).

This supports Round 2's receipt-first discipline. It also supports the user's crux: the lead should not personally ingest every raw search/tool result if a cheaper bounded reader can turn that into a small cited conclusion.

### 2. Splitting too early is itself a cost and reliability bug

OpenAI's Agents SDK docs distinguish handoffs from "agents as tools." For manager-style workflows, specialists should be bounded capabilities while the manager owns the final answer. The docs also say to keep specialist descriptions short/concrete, split only when different instructions/tools/policy are truly needed, and "start with one agent whenever you can" because premature splitting creates more prompts, traces, and approval surfaces. Source: [OpenAI, "Orchestration and handoffs"](https://developers.openai.com/api/docs/guides/agents/orchestration).

This is the core limit on cheap-reader delegation. Delegating a 100-line read to a subagent is not cost control; it is coordination overhead plus summarization risk.

### 3. Supervisor architectures reduce context load, but add translation errors and extra tokens

LangChain benchmarked single-agent, swarm, and supervisor architectures on a Tau-bench variant. They found single-agent performance drops as irrelevant tools/instructions grow, while supervisor and swarm token usage remains flatter. But the supervisor used more tokens than swarm and suffered "translation" mistakes because the worker cannot answer the user directly and the supervisor mediates. Source: [LangChain, "Benchmarking Multi-Agent Architectures"](https://www.langchain.com/blog/benchmarking-multi-agent-architectures).

Implication: a cheap orchestrator can win on context isolation, but it must not paraphrase away critical specialist findings. Receipts, citations, and line refs are mandatory. For high-stakes synthesis, the stronger model should inspect the receipt or challenge the conclusion.

### 4. Cheap-router / expensive-worker routing has empirical support, but only when the router is competent and evaluated

RouteLLM frames routing as choosing between strong/high-cost and weak/low-cost models, using preference data to learn when the strong model will outperform the weak one. The project reports large cost reductions while retaining most strong-model quality on benchmark tasks. Source: [LMSYS RouteLLM blog](https://www.lmsys.org/blog/2024-07-01-routellm/) and [RouteLLM paper](https://arxiv.org/abs/2406.18665).

RouterEval's 2025 EMNLP paper found that routing can even exceed the best single model when the router is sufficiently capable and has a broad candidate pool, but existing routers often lag and show selection bias. Source: [RouterEval, ACL Anthology PDF](https://aclanthology.org/2025.findings-emnlp.208.pdf).

The strongest takeaway is not "weak routers are always safe." It is "routing works when the router has a good decision rule, training/eval signal, and fallback path."

### 5. Routing can backfire in both directions: over-escalation and under-escalation

Recent routing literature identifies "routing collapse": routers can degenerate toward the strongest and most expensive model even when cheaper models suffice, undermining cost savings. The paper attributes this to small ranking margins and objective-decision mismatch. Source: [When Routing Collapses, arXiv 2026](https://arxiv.org/html/2602.03478v1).

The opposite failure is under-escalation: cheap models keep hard work and return plausible but wrong answers. Cascaded routing research addresses this by adding quality estimation that escalates low-quality outputs to stronger models. A 2026 "Cluster, Route, Escalate" paper reports retaining 97% of the strongest model's accuracy on TeleQnA and coming within about 1 percentage point on AIME with a two-stage route-then-escalate design. Source: [Cluster, Route, Escalate, arXiv 2026](https://arxiv.org/html/2606.27457v1).

Adversarial work also shows cascades introduce attack surfaces: lightweight front-end models and internal routing decisions can be manipulated, disrupting both performance and cost advantages. Source: [When Efficiency Backfires, arXiv 2026](https://arxiv.org/html/2605.17288v1).

Conclusion: a cheap orchestrator must be rule-governed and audited. It should not be trusted to freely decide every Opus escalation without fixed triggers and user gates.

### 6. Current model facts strengthen the anti-Opus-brain case

Anthropic's current model overview says Opus 4.8 is for complex agentic coding and enterprise work and lists it at $5/MTok input and $25/MTok output; Sonnet 5 is $3/$15 and faster. The same docs note Opus 4.8 defaults to high effort. Source: [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview). Anthropic's Opus 4.8 launch page says Opus is sharper and more reliable for complex agentic tasks, but it also identifies ongoing work to bring Opus-like capabilities at lower cost. Source: [Anthropic, "Introducing Claude Opus 4.8"](https://www.anthropic.com/news/claude-opus-4-8).

This means Opus is credible as an escalation model, not as a default router for cheap file reads.

## Decision: Orchestrator Tier

Recommendation: hybrid cheap brain with hard Opus escalation triggers.

Default orchestrator:

- Use a Sonnet-class model as the always-on brain. If the environment supports Sonnet 5, prefer Sonnet 5 over Sonnet 4.6 because current Anthropic docs show better cost-performance. If the environment only offers the user's stated choices, use Sonnet 4.6.
- Keep the orchestrator narrow: dispatch, gating, verification, git, receipt synthesis, bounded control-plane edits.
- Use gpt-5.5/codex for frontier planning/audit by default when the work is already recognized as a plan/audit/research task.
- Use opencode-go for bounded execution.
- Use Opus 4.8 only for defined escalation events.

### Option failure modes

Sonnet-4.6-as-brain only:

- Under-escalation: the cheaper brain may fail to notice a task needs Opus-level judgment.
- Misrouting: it may send hard reasoning to execution workers or treat a policy/design decision as a routine dispatch.
- Cheap-summary trust: it may accept a weak reader's conclusion without enough line refs.
- Mitigation: fixed trigger list, receipt-first handoffs, verifier checks, and explicit "uncertainty means escalate or ask" rule.

Opus-4.8-as-brain only:

- Premium token burn on low-value routing, file reads, command tails, and status synthesis.
- Context bloat: even a strong model degrades when it accumulates raw logs, file contents, and agent chatter.
- Rate-limit and opportunity cost: quota is consumed before the truly hard reasoning arrives.
- False confidence: Opus is better at judgment, but not immune to context contamination or stale assumptions.

Hybrid cheap brain + Opus triggers:

- Best cost-quality tradeoff for this repo.
- Failure modes are trigger drift, vague "maybe hard" escalations, and lossy handoff.
- Mitigation: escalation list below, return-size caps, and a rule that Opus must receive the minimum governing receipts/docs needed for the decision, not the entire chat.

## Opus Escalation Trigger List

The Sonnet-class orchestrator may ask for or invoke Opus 4.8 only when at least one trigger is true and the gate states the exact decision Opus will change:

1. Security, privacy, credential, destructive filesystem, release, merge authorization, or externally visible default behavior risk.
2. Conflicting governance sources where choosing wrong changes authorization, quota policy, memory policy, or merge behavior.
3. Cross-module architecture where the cheap planner's wrong abstraction would cause broad rework.
4. A specialist returns `NEEDS_GATE` or `BLOCKED` because the blocker is conceptual, not missing information.
5. Two competent frontier/worker passes disagree on a material conclusion.
6. Verification fails twice after bounded fixes and the remaining issue is not mechanical.
7. The task requires subtle adversarial review, legal/financial/security-like judgment, or high-stakes policy interpretation.
8. The user explicitly requests Opus or asks for a maximum-quality Opus challenge.
9. The cheap orchestrator cannot state a crisp dispatch contract after bounded grounding; uncertainty is about reasoning, not just missing files.

Opus must not be used for:

- Routine file discovery, line extraction, `rg`, `git status`, test execution, or formatting.
- Reading docs merely to summarize them.
- Execution work that has a bounded patch objective.
- "Diversity" by default. Diversity is a reason to choose a challenge pass only when one of the triggers above is true.

## Grounding Delegation Rule

Allow the orchestrator to delegate its own grounding reads to a cheap reader when all are true:

- The orchestrator only needs a routing conclusion, not full prose or exact wording.
- The content to inspect exceeds the main-thread reading budget or would add more than roughly 1,500 lines / 15k tokens of raw context.
- The cheap reader can return a short answer with file/line refs or source URLs.
- The reader's task is extractive: "Which files matter?", "Does this doc authorize X?", "What changed since round 2?", "Find the exact conflict."
- The return is capped: `Status`, `Receipts/Refs`, `Conclusion <=120 words`, `Uncertainty <=1 sentence`.

Do not delegate grounding when:

- The orchestrator can read the material within Round 2's normal named-artifact and exploratory caps.
- The orchestrator must edit or quote exact rule text and therefore needs to inspect wording directly.
- The cheap reader would need broad judgment rather than extraction.
- The cost of another model call is likely larger than the avoided context, such as one or two short files.
- The reader cannot cite line refs/URLs. Uncited summaries are not grounding.

Practical threshold: for this repo, cheap grounding delegation is worth it for large audit docs, long logs, generated receipts, or multi-source online research. It is not worth it for `CLAUDE.md`, a short receipt, or a 3-file/600-line exploratory read.

## Re-Challenge of Round 2 Lean `CLAUDE.md`

Round 2 remains directionally right. The lean rewrite should not be replaced with a long model-routing manual. The orchestrator-tier decision changes only three areas:

1. Add an explicit always-on orchestrator tier rule.
2. Replace loose Opus approval language with the trigger list above.
3. Add the cheap grounding-reader rule.

It also removes the implication that the main Claude Code conversation is necessarily Opus. The root rule should describe role and tier, not assume the default model is the strongest one.

## DELTA Edits to Round-2 Lean `CLAUDE.md`

Apply these deltas to the Round-2 consolidated proposal only; do not expand the whole root file.

### Delta 1: Add to `## Orchestrator Role`

Add after the first paragraph:

```md
Run the always-on orchestrator on the cheapest capable Sonnet-class model available. Use Sonnet 5 if available; if this project is constrained to Sonnet 4.6 versus Opus 4.8, use Sonnet 4.6 as the default brain. Opus is not the control plane for routine routing, file reads, shell commands, receipt synthesis, or status updates.
```

### Delta 2: Replace the Opus bullet in `## Frontier, Workers, and Opus`

Replace:

```md
- Claude Agent/Opus is an expensive-path exception. Use it only with current-turn user approval unless the user explicitly requested it. The gate must say why cheaper routes are insufficient, expected input docs, max return size, and what decision the pass will change.
```

With:

```md
- Claude Opus is an escalation specialist, not the always-on brain. Use it only when a named trigger applies: security/privacy/credential/destructive/release/default-behavior risk; conflicting governance that affects authorization or policy; cross-module architecture with broad rework risk; conceptual `BLOCKED`/`NEEDS_GATE`; material disagreement between competent passes; two failed bounded fixes with a non-mechanical remaining issue; subtle adversarial/legal/financial/security-like judgment; explicit user request; or the Sonnet orchestrator cannot state a crisp dispatch contract after bounded grounding. The gate must say the trigger, cheaper routes tried or rejected, expected input docs, max return size, and what decision Opus will change.
```

### Delta 3: Add `## Grounding Delegation`

Add this section after `## Main-Thread Budget`:

```md
## Grounding Delegation

The orchestrator may delegate its own grounding reads to a cheap reader when the needed inspection exceeds the main-thread reading budget or roughly 1,500 lines / 15k tokens, and the orchestrator only needs a routing conclusion. The reader must return: Status, Receipts/Refs, Conclusion <=120 words, and Uncertainty <=1 sentence.

Use this for large audit docs, long logs, generated receipts, or multi-source research. Do not use it for short files, exact rule wording the orchestrator must edit or quote, broad judgment, or any uncited summary. If the reader cannot provide file/line refs or source URLs, it is not grounding.
```

### Delta 4: Tighten the model-routing root policy

In `## Model Routing`, change:

```md
Root policy is class-based: frontier for planning/audit/root-cause/policy; opencode-go for bounded execution; Claude/Opus only behind current-turn approval unless explicitly requested.
```

To:

```md
Root policy is class-based: Sonnet-class for the always-on orchestrator; frontier for planning/audit/root-cause/policy; opencode-go for bounded execution; Opus only behind the escalation trigger list unless explicitly requested.
```

## Final Recommendation

Adopt Round 2's lean root rewrite with the four deltas above. Do not keep the current `CLAUDE.md` language that makes Opus a normal "challenging/diversity" option or says "design before doing" always means an adversarial round. That phrasing recreates the Opus quota leak.

The project should treat orchestration as a routing/control-plane workload. That is exactly the workload where cheaper models plus hard escalation gates are supposed to win. Opus should be preserved for the few decisions where better judgment changes the outcome.
