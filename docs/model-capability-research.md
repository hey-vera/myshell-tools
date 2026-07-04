# Model Capability Research

Date: 2026-07-04
last_verified: 2026-07-04 online research plus local CLI discovery (`codex --version`, `opencode --version`, `opencode models --verbose`). Re-verify before routing expensive or long-running work.

Purpose: grounded routing reference for `myshell-tools` so the orchestrator can pick a worker model by task type, quota bucket, and funding state. This is a volatile operational doc, not durable memory.

## Executive Read

Current constraint: `opencode-go` is research-only for this user because the subscription is unfunded. Do not route production workers to it until a smoke run confirms funded access. The active worker pool is therefore:

- Codex on ChatGPT billing: `gpt-5.4` for heavier bounded work, `gpt-5.4-mini` for cheap/mechanical work.
- Claude sonnet-class `Agent` workers on Anthropic billing: use Sonnet 5 if available, otherwise Sonnet 4.6.
- Frontier planning/audit remains Codex `gpt-5.5` with high reasoning when the task actually needs frontier judgment.
- Opus 4.8 is an escalation specialist, not a routine worker.

## Evidence Rules And Uncertainty

- Public prices are API-equivalent per MTok when the provider publishes them. ChatGPT/Codex and Claude Code subscription billing do not map cleanly to per-task dollars, so the orchestrator should treat public API costs as relative economics, not the user's direct bill.
- OpenAI and Anthropic facts below are from primary docs/launch posts. Open-model facts are a mix of first-party vendor pages, public hosting pages, and the local `opencode models --verbose` catalog. Local opencode costs are what this CLI advertised on 2026-07-04; they can differ from direct vendor APIs.
- "Coding reliability" is a routing prior, not a guarantee. Verification commands and diff inspection remain mandatory.
- "Reasoning tier" is local to this document: `S` frontier/escalation, `A` near-frontier or top open worker, `B` strong bounded worker, `C` cheap/mechanical worker.

## OpenAI / Codex Models

OpenAI's Codex model page recommends `gpt-5.5` for complex coding, computer use, knowledge work, and research; it calls `gpt-5.4` a flagship frontier model for professional work; and it recommends `gpt-5.4-mini` for faster, lower-cost lighter coding tasks or subagents. The OpenAI API model list gives context, pricing, latency labels, and supported reasoning levels for these models. Sources: [Codex models](https://developers.openai.com/codex/models), [OpenAI models](https://developers.openai.com/api/docs/models), [GPT-5.5 guide](https://developers.openai.com/api/docs/guides/latest-model), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Introducing GPT-5.5](https://openai.com/index/introducing-gpt-5-5/).

| Model | Reasoning tier | Coding reliability | Context window | Relative speed | Approx public cost / MTok | Best-fit task type | Uncertainty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-5.5` | S | Very high for complex coding, audits, long-horizon tool work | API: 1,050,000 tokens, 128k max output; Codex subscription launch post says 400k context in Codex | Fast for frontier, but more quota-expensive; Fast mode in Codex is 1.5x faster for 2.5x cost | API standard $5 input / $30 output; priority pricing page lists $12.50 / $75 | Frontier planner/auditor, ambiguous root cause, architecture, multi-source research, high-stakes refactor planning | Codex subscription limits can differ from API; actual ChatGPT credit burn is not public dollars |
| `gpt-5.4` | A/S | High; strong default for professional coding and agentic workflows | API: 1,050,000 tokens, 128k output; local Codex cache historically exposed 272k default and larger max configuration | Fast; cheaper than 5.5, slower/costlier than mini | API standard $2.50 input / $15 output; priority $5 / $30 | Heavier bounded implementation, multi-file worker execution, render/test slices when frontier not needed | Codex CLI context may be plan/config constrained despite API limit |
| `gpt-5.4-mini` | B | Medium-high for scoped edits; weaker on ambiguous cross-module decisions | API: 400,000 tokens, 128k output | Faster | API standard $0.75 input / $4.50 output; priority $1.50 / $9 | Mechanical rename/format, narrow bug fix, cheap subagent, structured extraction | Good model, but do not let it own planning or broad refactors without a stronger reviewer |

## Anthropic / Claude Models

Anthropic's model overview lists Opus 4.8, Sonnet 5, and Haiku 4.5 specs; pricing docs list Sonnet 4.6 and long-context pricing. Sonnet 5's launch post says it improves over Sonnet 4.6 and can match Opus 4.8 capability on some tasks at higher effort. Sources: [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Introducing Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5), [Choosing a Claude model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Claude extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [Claude Code model config](https://code.claude.com/docs/en/model-config).

| Model | Reasoning tier | Coding reliability | Context window | Relative speed | Approx public cost / MTok | Best-fit task type | Uncertainty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Opus 4.8 | S | Very high; best Claude escalation for complex agentic coding and enterprise work | 1M input, 128k output | Moderate; fast mode research preview up to 2.5x output speed | $5 input / $25 output; fast mode $10 / $50 | Escalation after named triggers: security, destructive/default/release risk, repeated worker failure, difficult audit disagreement | Use sparingly; not the always-on brain |
| Claude Sonnet 5 | A/S | High; strong default sonnet-class agent | 1M input, 128k output | Fast | Intro $2 / $10 through 2026-08-31; then $3 / $15 | Always-on orchestrator where available, sonnet-class Agent worker, render/test-heavy implementation | Tokenizer differs from Sonnet 4.6; same text can produce about 30% more tokens per Anthropic pricing note |
| Claude Sonnet 4.6 | A | High and mature; slightly lower ceiling than Sonnet 5 | 1M input; docs/pricing say 1M standard, local opencode advertised 64k output while platform docs list 128k output support for Sonnet 4.6 in some surfaces | Fast-to-moderate | $3 input / $15 output | Fallback sonnet-class brain/worker when Sonnet 5 unavailable; bounded implementation and reviews | Output limit varies by surface; verify CLI model metadata |
| Claude Haiku 4.5 | C/B | Medium for coding; good for simple, cheap work | 200k input, 64k output | Fastest Claude | $1 input / $5 output | Cheap classification, mechanical extraction, low-risk subagent, quick reader | Do not use for broad refactors or subtle audits |

## opencode-go Research Roster

Funding state: `opencode-go` is currently unfunded for this user. Treat every row below as research-only until `opencode run -m opencode-go/<model> ...` succeeds without an insufficient-balance error.

Local discovery source: `opencode models --verbose` on 2026-07-04 listed the requested `opencode-go/*` models and advertised context, output, cost, modalities, and variants. Public source anchors include [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), [DeepSeek V4 release](https://api-docs.deepseek.com/news/news260424), [DeepSeek V4 Hugging Face model card](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro), [Kimi K2.7 Code pricing/specs](https://platform.kimi.ai/docs/pricing/chat-k27-code), [Kimi K2.6 specs](https://platform.kimi.ai/docs/pricing/chat-k26), [Qwen API platform](https://qwen.ai/apiplatform), [Qwen3.7 Max on OpenRouter](https://openrouter.ai/qwen/qwen3.7-max), [Qwen3.7 Plus on OpenRouter](https://openrouter.ai/qwen/qwen3.7-plus), [MiniMax model docs](https://platform.minimax.io/docs/guides/models-intro), [MiniMax M3 on OpenRouter](https://openrouter.ai/minimax/minimax-m3), [MiniMax M2.7 on OpenRouter](https://openrouter.ai/minimax/minimax-m2.7), [Xiaomi MiMo-V2.5-Pro release](https://mimo.xiaomi.com/mimo-v2-5-pro/), [Xiaomi MiMo pricing](https://mimo.mi.com/docs/price/pay-as-you-go), [MiMo-V2.5 on OpenRouter](https://openrouter.ai/xiaomi/mimo-v2.5), [MiMo-V2.5-Pro on DeepInfra](https://deepinfra.com/XiaomiMiMo/MiMo-V2.5-Pro/api).

| Model | Reasoning tier | Coding reliability | Context window | Relative speed | Approx cost / MTok | Best-fit task type | Uncertainty |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `opencode-go/deepseek-v4-pro` | A | High for open-model reasoning/coding; Pro beats Flash on hardest knowledge/agentic tasks | 1M; 384k output in local catalog | Moderate | Local opencode-go $1.74 input / $3.48 output; DeepSeek direct page shows lower direct API headline $0.435 / $0.87 | Strong open worker for complex bounded implementation, long-context audit, reasoning-heavy bug fix | Provider price differs materially; smoke required |
| `opencode-go/deepseek-v4-flash` | B | Medium-high; close to Pro for simple agent tasks per DeepSeek release notes | 1M; 384k output | Fast | Local opencode-go and DeepSeek direct $0.14 input / $0.28 output | Cheap mechanical/bounded worker, large-context scan, simple implementation | Less reliable than Pro on hard knowledge and complex workflows |
| `opencode-go/glm-5.2` | A | High for open coding and long-horizon agentic tasks | 1M; 131k output | Moderate/slower than flash models | Local opencode-go $1.40 / $4.40; public host pages show similar | Web/UI generation, long refactor worker, coding-heavy open-model challenge pass | First-party page was not fully scrapeable; rely on local catalog plus public host listings |
| `opencode-go/glm-5.1` | B | Medium-high, older GLM worker | 202,752; 32k output | Moderate | Local opencode-go $1.40 / $4.40; public host pricing varies | Fallback GLM worker, bounded coding where 1M context is not needed | Superseded by GLM-5.2 for most hard work |
| `opencode-go/kimi-k2.7-code` | A | High for coding-specific long-horizon tasks | 262,144; local output 262,144; Kimi docs say 256k context | Moderate; high-speed variant exists publicly, not necessarily this opencode id | Local opencode-go $0.95 / $4.00; OpenRouter page showed $0.74 / $3.50 | Coding-focused implementation, agentic task decomposition, large patch follow-through | Price and speed variant are provider-specific |
| `opencode-go/kimi-k2.6` | B/A | High for general coding/tool use, below K2.7 Code for code-specific work | 262,144; 65k output | Moderate | Local opencode-go $0.95 / $4.00; third-party providers vary | General open worker, multimodal/code tasks, long-context but not 1M | Public official page exposes specs more clearly than full price table |
| `opencode-go/qwen3.7-max` | A | High for agent-centric coding/productivity, strongest Qwen row | 1M; 65k output | Moderate-to-fast depending provider | Local opencode-go $2.50 / $7.50; OpenRouter public discounted listing $1.25 / $3.75 | Hard open-model worker, long-horizon agentic coding, cross-check against Codex/Claude | OpenRouter discount may be temporary; opencode-go cost is higher |
| `opencode-go/qwen3.7-plus` | B/A | Medium-high; cost-effective Qwen worker | 1M; 65k output | Faster/cheaper than Max | Local opencode-go $0.40 / $1.60, higher tier beyond 256k; OpenRouter $0.32 / $1.28 | Cheap long-context worker, multimodal bounded implementation, scan-and-edit | Long-context tiering changes effective price |
| `opencode-go/minimax-m3` | B/A | Medium-high; positioned as frontier multimodal coding model | 1M; local opencode-go 131k output | Fast for long context per MiniMax/OpenRouter positioning | Local opencode-go $0.30 / $1.20 under 512k, $0.60 / $2.40 over 512k | Cheap broad worker, long-context multimodal coding, tool-use tasks | Local non-go catalog showed only 512k context for `opencode/minimax-m3`; go catalog showed 1M |
| `opencode-go/minimax-m2.7` | B | Medium; older cheap agentic coding model | 204,800; 131k output | Fast/cheap | Local opencode-go $0.30 / $1.20 | Mechanical and bounded implementation when cheap throughput matters | Superseded by M3 for 1M/multimodal work |
| `opencode-go/mimo-v2.5-pro` | A | High open-weight agent/coding prior; Xiaomi positions it near Opus 4.6 in demanding agentic workloads | 1,048,576; 128k output | Moderate; regular Pro is not the ultra-speed variant | Local opencode-go $1.74 / $3.48; Xiaomi direct page shows $0.435 / $0.87; DeepInfra $1.00 / $3.00 | Strong open worker for long-horizon agentic coding and complex refactors | Major provider price variance; direct Xiaomi pricing is much lower than opencode-go |
| `opencode-go/mimo-v2.5` | B | Medium-high for cheap multimodal/context work | 1M; 128k output | Fast/cheap | Local opencode-go and Xiaomi direct $0.14 / $0.28; OpenRouter listing around $0.105 / $0.28 | Cheap long-context multimodal scan, bounded implementation, simple agent tasks | Lower ceiling than Pro; verify modality support in selected provider |

## Routing Decision Guide

Given the current funding constraint, do not choose `opencode-go` in production routing. Balance Codex ChatGPT billing and Anthropic billing by alternating equivalent worker tasks and by moving to the other provider when one side shows rate-limit or quality degradation.

| myshell-tools task type | Recommended model + effort now | Alternate for quota balance | Why | Verification gate |
| --- | --- | --- | --- | --- |
| Mechanical rename/format | `gpt-5.4-mini`, low reasoning | Sonnet-class Agent, low/medium if Codex headroom is constrained | Lowest adequate cost; bounded, deterministic edits | `npm run lint` or narrower formatter/test plus `git diff --check` |
| Bounded implementation | Alternate `gpt-5.4` medium/high and Sonnet-class Agent medium/high by conflict domain | `gpt-5.4-mini` only for small isolated code paths | Strong enough for local code edits without spending frontier planning quota | Targeted test first, then relevant suite slice |
| Render+test-heavy slice | Sonnet-class Agent high for UI/test-loop execution; alternate `gpt-5.4` high | Use `gpt-5.4-mini` only for fixture/mechanical follow-ups | Sonnet agents are good at tool loops; `gpt-5.4` balances quota and is strong on code | Browser/render smoke when applicable, unit/integration test, screenshot or log receipt |
| Multi-file refactor | `gpt-5.4` high for bounded execution after an explicit contract | Sonnet-class Agent high for independent slices; escalate planning to `gpt-5.5` high if scope is not bounded | Multi-file edits need stronger context discipline; do not let mini own architecture | Full affected suite, typecheck, line-referenced diff review |
| Planning/audit/root cause | `gpt-5.5` high reasoning | Opus 4.8 only if a named escalation trigger fires | Needs frontier judgment, not just edit speed | Written plan/audit with citations or file-line refs; no production edits unless separately dispatched |

If `opencode-go` becomes funded later, use it as an extra worker pool, not as the orchestrator:

- Cheap mechanical/open worker: `deepseek-v4-flash`, `mimo-v2.5`, `minimax-m2.7`.
- Cheap long-context worker: `minimax-m3`, `qwen3.7-plus`, `mimo-v2.5`.
- Strong open worker: `deepseek-v4-pro`, `kimi-k2.7-code`, `glm-5.2`, `qwen3.7-max`, `mimo-v2.5-pro`.
- Still avoid using open workers as final authority for security, release defaults, or policy unless a frontier/Opus reviewer validates the result.

## Freshness Plan

Re-verify cadence:

- Monthly for this document.
- Immediately after any `codex`, `claude`, or `opencode` CLI upgrade.
- Before any task expected to consume more than 30 minutes of worker wall time.
- Before routing to `opencode-go` after any funding, auth, or provider-plan change.
- Whenever a model id disappears, a smoke test reports a different model, or a provider returns insufficient balance/rate-limit errors.

Discovery commands:

```powershell
codex --version
codex exec --help
codex login status
$null | codex exec -m gpt-5.4-mini -c model_reasoning_effort=low --sandbox read-only --skip-git-repo-check "Reply exactly: OK"

claude --version
claude auth status
claude --help
$null | claude -p --model sonnet --output-format stream-json --verbose "Reply exactly: OK"

opencode --version
opencode providers list
opencode models --verbose
$null | opencode run -m opencode-go/deepseek-v4-flash --format json "Reply exactly: OK"
```

Bash equivalents for stdin-closed smoke runs:

```bash
codex exec -m gpt-5.4-mini -c model_reasoning_effort=low --sandbox read-only --skip-git-repo-check "Reply exactly: OK" </dev/null
claude -p --model sonnet --output-format stream-json --verbose "Reply exactly: OK" </dev/null
opencode run -m opencode-go/deepseek-v4-flash --format json "Reply exactly: OK" </dev/null
```

Smoke-test method:

1. Run the one-line `OK` prompt for each candidate model. Record model id, success/failure, latency, and any quota/funding error.
2. Run one read-only repo prompt: "Inspect `package.json` and report the test command only." This confirms file access and tool behavior without mutation.
3. For write-capable workers, run a throwaway temp-worktree edit: create/change a disposable file, then delete the worktree. Never test write access in the main tree.
4. Mark a model routable only when all required surfaces pass: auth, model selection, stdin handling, sandbox/permission behavior, JSON/stream parsing, and receipt capture.
5. For `opencode-go`, funded access requires a paid model smoke run. Catalog existence alone is insufficient.

Refresh checklist for this file:

- Update `last_verified`.
- Update public price/context rows from primary provider docs first.
- Re-run local CLI discovery and note any divergence from public docs.
- Re-run the smoke tests for the models that routing will actually use.
- Keep unfunded providers in research-only state until a smoke test proves otherwise.
