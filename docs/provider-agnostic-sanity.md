I could not write `docs/provider-agnostic-sanity.md` because this session is read-only and approval is disabled. Here is the exact markdown content.

```markdown
# Provider-Agnostic Sanity Check

## Verdict

**Partly / no for the invariant as stated.** Proven from code: single-provider routing generally survives for `opencode`, `claude`, `codex`, and `grok` because `route()` filters through authenticated/available providers and all four providers have pricing rows for all tiers. But the product is not vendor-neutral today: default and preset routing encode `opencode` first for worker and `claude` first for IC/manager, several side paths preserve fixed provider ordering, Grok is incomplete in capacity ordering, and some capability/web-search/model-effort logic is provider-specific or stale.

## Confirmed Drift

**Yes.** The worker-tier `opencode`-first change is vendor-hardcoded drift.

- `src/core/policy.ts:45-46` explicitly says worker prefers OpenCode Go to preserve Anthropic quota and reflects the owner’s policy.
- `src/core/policy.ts:50` sets default worker order to `['opencode', 'claude', 'codex', 'grok']`.
- `src/core/policy.ts:394` repeats this in `cost-saver`.
- `src/core/policy.ts:423` repeats this in `quality-first`.

That is not a neutral product policy. It is a maintainer-environment preference leaking into product routing.

## Vendor Coupling / Single-Provider Assumptions

| Location | What it assumes | Degrades / breaks | Severity |
|---|---|---:|---:|
| `src/core/policy.ts:45-52` | Worker is `opencode`-first because of OpenCode Go / Anthropic quota; IC/manager are `claude`-first. | Multi-provider users where another authenticated provider is cheaper/faster/better. | High |
| `src/core/policy.ts:393-397`, `src/core/policy.ts:422-426` | Presets repeat the same vendor order. | One-shot `run` / REPL inherit static vendor bias. | High |
| `src/core/route.ts:294-297`, `src/core/route.ts:463-470` | Learned order overrides policy if present; otherwise static order decides among authenticated providers. | Cold-start routing is vendor-biased. | High |
| `src/core/capacity-allocator.ts:21` | Canonical provider order is `['claude', 'codex', 'opencode']`; `grok` is omitted. | Grok mixed-provider ordering and tie handling. | Medium |
| `src/core/capacity-allocator.ts:97-120`, `src/core/capacity-allocator.ts:328-329` | Tie-break / baseline order is vendor-list based; unknown providers get index `-1`. | Non-canonical providers can sort oddly; Grok handling is incomplete. | Medium |
| `src/core/model-capabilities.ts:287` | `opencode` has no declared capability rows. | OpenCode Go / Zen cannot be ranked for vision/search/context capability even if the selected model can do it. | Medium |
| `src/core/route.ts:200-203` | `opencode` needs special model selection. | Adapter-specific handling is defensible, but combined with empty capabilities it weakens neutral capability routing. | Medium |
| `src/core/understanding-generator.ts:90-91` | Only `codex` honors web search. | Claude/Grok-only or Claude/Grok-preferred users lose web-search grounding in this path despite other code supporting it. | Medium |
| `src/core/orchestrate.ts:623-628`, `src/core/orchestrate.ts:749-754` | Fallback event provider label is `'claude'`. | No-provider or pre-route receipt/telemetry can falsely label Claude. Mostly labeling, not execution. | Low/Medium |
| `src/core/ensemble.ts:147-155` | Panel candidates and synthesizer are the first authenticated providers. | Multi-provider panel composition depends on fixed auth order, not cost/capability/learning. | Medium |
| `src/core/escalate.ts:52-57` | Reviewer is first different provider from the supplied order. | Multi-provider review choice inherits fixed ordering. | Low/Medium |
| `src/core/goal-plan-generator.ts:139` | Uses `reasoningEffort: 'max'` unconditionally. | Potential provider/model mismatch, especially Codex/OpenCode/Grok models that do not support that effort value. | High |
| `src/providers/detect.ts:671`, `src/providers/codex.ts:92-93` | Codex available models are hardcoded and always passed with `-m`. | Codex-only users can fail if those model IDs are stale or unavailable. This is a code-proven risk, not a confirmed runtime failure. | Medium/High |
| `src/providers/detect.ts:925-935` | Grok auth is true for exit code 0 unless output contains “not authenticated”. | Possible false-positive auth if CLI output changes. | Low/Medium |
| `src/infra/pricing.ts:143-151`, `src/infra/pricing.ts:152-213` | OpenCode/Grok pricing uses sentinel/placeholder zero-cost semantics; comment still says OpenCode is last. | Any “cheapest” policy based only on this table will be distorted. | Medium |
| `src/providers/port.ts:26` | No separate `zen` provider exists; Zen is represented under `opencode`. | Fine if intentional. If product treats Zen as independently selectable, current type model cannot express it. | Framing issue |

## Single-Provider Survival Check

- **`{opencode only}`:** Route should work for every tier. `route()` special-cases OpenCode model selection and falls back to placeholder `opencode`; `src/providers/opencode.ts:90-94` omits `-m` for non-slash placeholders, letting the CLI choose a default. Capability ranking is weak because OpenCode has no capability registry rows.

- **`{claude only}`:** Route should work for every tier. Claude has pricing rows for worker/IC/manager, and policy includes Claude in every tier. Cross-provider panel/review features degrade or skip, which is expected.

- **`{codex only}`:** Route should work structurally, but Codex model IDs are hardcoded in detection at `src/providers/detect.ts:671` and passed directly by `src/providers/codex.ts:92-93`. If those IDs are stale for the user’s Codex CLI, execution can fail.

- **`{grok only}`:** Route should work structurally because Grok is present in policy and pricing for all tiers. Risks: Grok is omitted from capacity allocator canonical order, model IDs may drift, and auth parsing can false-positive.

- **`{zen only}`:** Works only if “Zen” means an OpenCode auth credential. Detection counts OpenCode auth entries of type `oauth` or `api`, including Zen API credentials. There is no independent `zen` provider ID.

`route()` itself returns nothing only when `available.length === 0` and then throws at `src/core/route.ts:166-170`. Normal orchestration guards this with no-provider checks.

## Recommendation

The proposed worker fix is directionally correct but incomplete if implemented as “use `pricing.ts` cheapest provider.” Current pricing is not a reliable marginal-cost signal for subscriptions, quota, OpenCode Go, Zen, or Grok. It contains placeholders and zero-cost sentinel values.

Recommended worker-tier approach:

1. Filter to authenticated + available providers.
2. Apply hard capability requirements first: vision, large context, search/tool support, model availability.
3. Rank by learned success/latency when enough observations exist.
4. Rank remaining providers by estimated marginal cost/quota pressure, not vendor name.
5. Use a neutral stable tie-break only after those signals, such as user config or alphabetical provider ID.

Needed additions/fixes:

- Add `grok` to the capacity allocator canonical order.
- Add capability metadata for OpenCode/Zen models or parse it from detected model metadata.
- Separate list-price, subscription-included usage, unknown cost, and quota pressure; do not treat `$0` placeholder rows as universal cheapest.
- Make web-search support capability-driven everywhere, not Codex-only.
- Gate `reasoningEffort: 'max'` by provider/model capability.
- Consider passing learned/dynamic order into one-shot `run`, REPL, intent, recap, and generator paths consistently.

For IC/manager: `claude`-first is also a vendor bias. It is only defensible as a documented cold-start capability prior if backed by capability data and used after auth/capability constraints. For a strict provider-agnostic product invariant, IC/manager should move to the same capability/cost/learned ranking model rather than static Claude-first ordering.

## Framing Issues

The requirement lists OpenCode Zen alongside providers, but the code models Zen as an OpenCode credential, not as a separate provider. That is acceptable only if product UX/documentation also treats Zen as “OpenCode-backed.”

Also, “cheapest” is underspecified for subscriptions. The scarce resource is not always dollars; it can be quota, latency, reliability, context fit, or failure rate. A vendor-neutral router needs an explicit cost/quota/capability model, not a provider-name order.
```