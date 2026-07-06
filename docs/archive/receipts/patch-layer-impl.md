# Patch Layer Implementation (Aider-style precise edits)

**Date**: 2026-07-05

**From plan**: host-controlled precise patch layer for efficiency, git-native, anti-drift.

**Implemented**:
- src/core/patch-apply.ts : capture from git diff, preview, apply (git apply), commit on accept with metadata.
- Wired in src/core/accept-stage.ts : after append, capture, apply, commit for the accepted candidate.
- Provider agnostic: works for solo or combo (no assumption on number of providers).
- Uses existing capture logic, worktree ready (basic fallback for now).
- The map from Phase 1 (symbols) provides the efficient context for the planning before patch.

**Verification**:
- typecheck clean.
- Basic for any provider.

**Next**: enhance capture from tool events, preview in UI, full worktree isolation, tests for solo/combo.

This + the map makes the tool use Aider-like for context and edits by default, fantastic for quota and professional work.
