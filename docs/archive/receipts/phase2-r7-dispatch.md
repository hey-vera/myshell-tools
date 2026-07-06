# Phase 2 Dispatch Receipt (r7-17 + r7-11 + map binding)

**Date**: 2026-07-05
**Base**: docs/model-routing-session-lessons @ 06d0e0b
**From**: frontier planner output (contract 019f3482-9e69-...)

**Dispatched (parallel, independent roots):**
1. phase2-r711-durable-substrate (general-purpose worker 019f3484-fb5a-7363-9d25-33cd37cdd127)
   - Pure domain + map snapshot substrate (RankedRepoFile + symbols as durable orientation).
   - Allowed: types, history (shim), orchestrate (≤15 LOC hooks), new durable-context.ts + test.
   - Verif: type/lint + targeted vitest + solo/panel smoke + cross-provider matrix.
   - Emphasis: E1 parity, map symbols in snapshots, solo==panel, no provider assumptions.

2. phase2-r717-completion-map-binding (general-purpose worker 019f3484-fb5d-7b71-ac27-60baef8719e2)
   - CompletionResultV1 core + bind to durable (completion.result event + map snapshot at settlement).
   - Allowed: types, history, verify (minimal), orchestrate (small attach), accept-stage (minimal), durable-context (additive), targeted tests.
   - Verif: same + CompletionTerminal vs evidence+map matrix, 4-provider switch, flag-off parity.

**Governing invariants (user clarification + plan + contracts):**
- Plug & play unchanged (dark flags; no entry flow impact).
- All modes use efficient shared map (Phase 1 richer orientation now durable via snapshots/reconstruction).
- Perfect with solo or any combo: explicit solo/panel/4-provider matrix in every smoke; shared seams only.
- Anti-drift: smallest diffs on allowed; use existing environmentContext / assemble / Ranked shape; flag-off byte-identical.
- Receipts must cover: map symbols carried, cross-provider equivalence, forbidden untouched.

**Protocol followed:**
- Contracts from frontier (restated in worker prompts).
- Worktrees per spec.
- Events + full receipts expected.
- Orchestrator will poll, review diffs/stat/verif tails, gate (no merge without evidence + vision check), then integrate.

**Next (orchestrator loop):** Poll workers (get output), independent gate (run verif in real tree), update combined phase receipt + ROADMAP, prepare 11b/17 follow-ons or integration worktree if clean.

All per approved plan + user clarification for "one chat to rule them all" (efficient default context, durable anti-drift, robust any-provider).
