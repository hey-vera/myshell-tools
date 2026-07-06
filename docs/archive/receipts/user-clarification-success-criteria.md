# User Clarification — Post-Plan Success Criteria (2026-07-05)

**Governing addition to the approved plan.**

After full actualization of the plan:

- The tool must be **plug and play ready**: `npx myshell-tools` (or global) → provider detection/auth with consent → drop into chat. No extra steps, no config required to get the efficiencies.
- **All modes use the more efficient Aider-style mechanisms** (if wise). 
  - "Aider" here means the proven efficiency techniques: high-quality deterministic repo map for context orientation (instead of blind or bloated context) + (in later phases) precise, git-native patch/apply for edits.
  - These efficiencies must be **default shared infrastructure**, not a separate mode or provider choice.
  - They must benefit **every** turn: Auto (the smart default), Efficient, Balanced, Max.
- **Cross-provider robustness is non-negotiable**:
  - Solo provider (any single one) works flawlessly.
  - Any combination of providers works perfectly extremely well.
  - Panel, review, tribunal, hedge, learned routing, native sessions (when enabled), parallel goals — all must continue to function without regression.
  - The Aider-style improvements (better map, later precise edits) must not introduce provider-specific assumptions or break when only 1 provider is available.

**Implications for execution (binding):**
- Phase 1 repo-map upgrades (symbols + seam) go into the single shared `assembleContextBlocks` path (already used by sequential, panel candidates, synthesizer, hedge, etc.). This automatically gives efficiency gains to solo + multi.
- Phase 3+ patch/apply layer must be provider-agnostic (consume tool events where available from any provider, fall back to post-capture diff + host-controlled git apply).
- Default routing/auto-brain/governor must prefer/use the efficient path with no extra user action.
- All new code + tests must explicitly cover solo-provider paths and multi-provider paths.
- Plug-and-play: no new required deps or opt-in flags for the core efficiency (tree-sitter remains optional seam; basic heuristic map is always on).

This clarification takes precedence for "done" definition on the vision-alignment and "Auto earns default" goals.

Receipts for every slice must note how the change preserves or improves solo + multi behavior.

**References**: approved plan.md, brutal-vision-audit-2026-07-05.md, codebase-awareness-5.6.md (E1 shared orientation), prompt-context.ts (the one seam), ensemble.ts (panel usage).
