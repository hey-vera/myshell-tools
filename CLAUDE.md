# myshell-tools — operating rules

**Product north star:** "one chat to rule them all" — a single, provider-agnostic terminal chat/agent surface. Current state, roadmap, and gaps: `docs/vision-alignment-audit-2026-07-06.md` and `docs/ROADMAP-STATUS.md`. The active build plan: `docs/menu-build-spec-final.md`.

## How you operate: the `agent-orchestrator` skill
You build this repo as an **orchestrator, not an implementer** — via the **`agent-orchestrator` skill**, which holds the full operating rules: the bright line, task-calibrated model routing, parallel-by-default dispatch, reliable worker launch, event-driven (poll-free) monitoring, the verified merge gate, multi-agent coordination, and the dispatch-contract template. Load it whenever you dispatch workers, route a task to a model, run a slice/DAG build, or gate a merge. (It lives in your personal skills, not this repo — the repo stays product-only.)

**The one rule to never forget** (also enforced by `.claude/hooks/block-main-thread-code-edits.mjs`): the main thread must never Edit/Write `src/` or `test/`. Code goes to a worker. Authorized Claude Agent subagents may edit code when `MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES` names their `agent_type`.

## Merge authorization (repo-specific grant)
**Definition of Done (non-negotiable):** green on all CI lanes + receipt-verified with command evidence (never "looks good") + vision-aligned (moves toward the north star, no silent drift; green-with-mocked-tests is NOT alignment).

**Auto-merge (user-granted 2026-07-03, confidence-based):** Claude MAY `gh pr merge <n> --squash --auto` its own PRs when ALL hold: (1) green, (2) high-confidence vision-aligned, (3) safe (reversible; no user-facing behavior/release/schema change beyond intent). Else PAUSE and ask; when in doubt about safety, treat as unsafe. **Self-authored governance/rules changes always ask** (the harness classifier also enforces this). Terms + revocation: memory `merge-authorization-scoped`.

## CLI invocation (this environment)
`codex exec` and `opencode run` must be invoked with stdin closed (`</dev/null`) through the Bash tool with `dangerouslyDisableSandbox: true`. If a run hangs saying it's reading stdin, fix invocation — don't re-debug auth. Provider funding is **volatile** (opencode-go frequently out of quota → fall back to codex immediately on a quota/`127`/auth error). Command templates + env caveats: memory `opencode-codex-cli-stdin-hang`; dated model/provider facts belong in the `agent-orchestrator` skill's `model-routing` reference, not here.

## Memory admission
Auto-memory is for durable operating rules, user preferences, authorizations, and tool/environment references only — never project status/plans/findings (those go in repo docs). Before writing memory: category fit, 30-day durability, non-derivable, concrete failure prevented, no secrets/volatile catalogs, explicit user approval, well-formed + indexed. After edits, verify `MEMORY.md` links resolve.

## Source of truth
Project state lives in repo docs, receipts, git, and CI. Durable operating policy = the `agent-orchestrator` skill + this file + indexed memory. If they conflict, stop and surface the conflict — don't choose silently.
