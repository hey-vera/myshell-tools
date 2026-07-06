# Phase 1 Receipt: Aider-style Repo Map Foundation (symbols + render seam)

**Date**: 2026-07-05
**Plan reference**: approved plan.md (Phase 1)

**Objective achieved**:
- Upgrade the shared deterministic repo map (Aider-inspired) with top-level symbols for richer orientation.
- Explicit `RepoFileRanker` seam for future tree-sitter.
- Render now emits compact "path — sym1, sym2, ..." when symbols present (accumulate-to-cap, drops syms before paths under pressure).
- buildEnvironmentContext now extracts symbols on scanned files and passes full Ranked objects.
- All additive; E1 paths-only behavior 100% preserved.

**Why this matters for user vision/clarification**:
- The repo map is the primary "more efficient Aider" mechanism for context (avoids bloat, better project awareness, fewer wasted tokens, smarter investigation).
- Because it is injected via the single `assembleContextBlocks` seam (first block) used by **every** prompt builder:
  - Solo/sequential turns
  - Panel candidates + synthesizer
  - Hedge, review, tribunal, etc.
- ...it is **automatically the default for Auto + all modes + any provider combination (or solo)**.
- No extra config, no mode-specific code, no provider assumptions → plug-and-play + "all modes use the more efficient" + "works perfectly with any combo/solo".
- Directly attacks quota efficiency and anti-context-bloat (core of the vision).

**Deliverables**:
- src/core/repo-map.ts: extractTopLevelSymbols, updated signals/rank (carry symbols), seam type, render upgrade for symbols, build wiring.
- test/unit/repo-map.test.ts: tests for symbols extraction, rank carry, render with/without syms, cap behavior, token checks.
- Minimal notes in cli/orchestrate/prompt-context (1-line).
- Receipts: slice-*-symbols.md, slice-*-render-seam.md (with this combined).

**Verification evidence** (worker + orchestrator):
- tsx render+cap + symbol smoke scripts: PASS (RENDER_HAS_SYM, CAP_OK, etc.).
- Typecheck: clean for changed scope.
- E1 parity: paths-only inputs produce identical output.
- Scope: git diff limited to allowed + minimal comments; no forbidden files.
- Events logged in .orchestrator/events.jsonl.

**Cross-provider / mode robustness**:
- No changes to provider adapters or routing.
- Shared context only → solo and multi (panel etc.) get identical improved map.
- Future phases will explicitly add solo vs multi test coverage.

**Next per plan**: Gate (review diff + this receipt), then Phase 2 (r7-17 completion + r7-11 durable context, interleaving the map as durable orientation substrate).

This Phase 1 delivers the foundation for "insane quota efficiency" and "intelligent conversations with minimal quota burn" via better shared context, default for everything.

**Full Phase 1 Gate (both workers complete):**
- Symbols worker (019f347a-4a4f-7ae0-9ee6-35b9cc9f1d59): extractTopLevelSymbols + interfaces + carry in rankRepoFiles + pure tests. Only touched allowed (repo-map + test). E1 parity preserved. Verification via tsx oracles + type/test commands. 
- Render-seam worker (019f347a-4a52-7be1-9a46-766308359d6c): RepoFileRanker seam, renderEnvironmentBlock now emits "path — sym1, sym2..." (≤4), buildEnvironmentContext extracts + passes Ranked[], minimal notes in cli/orchestrate/prompt. Tests/asserts added.
- Gate review: diffs minimal/scoped per contracts. Shared seam means the Aider-efficient map (richer orientation) is now **default** for every provider call (solo or any combo), every mode (Auto + others), with no user action. Plug-and-play unchanged. Cross-provider robustness: context is pre-provider, identical benefit.
- All per user clarification + plan. Phase 1 complete. Receipts cover verif, parity, vision impact.
