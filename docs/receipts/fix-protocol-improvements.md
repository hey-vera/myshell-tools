# Receipt: protocol improvements

Date: 2026-07-05

## Edits applied

- `CLAUDE.md` - added `Multi-Agent Coordination` with the VERIFIED gate, no self-merge of core-vision or `src/` changes without an independent-verification receipt, required scan for unexpected agent branches/PRs/commits before building on `main`, and branch-ownership rules.
- `CLAUDE.md` - updated `Worker Dispatch and Liveness` to add task-scaled hang thresholds, wrapper-death verification rules, and extend-once then stop-and-salvage guidance with resume-from-diff preference.
- `CLAUDE.md` - updated `Model Routing` to make latency a first-class factor in the routing objective and point to the detailed protocol docs.
- `docs/orchestrator-protocol.md` - updated `Objective function` so latency is first-class, with the `perfect-first-time -> minimize (total quota incl. rework + latency penalty) -> remaining tie-breaks` ordering and the menu-build / Claude Agent guidance for long-context or agentic slices.
- `docs/orchestrator-protocol.md` - updated `Monitoring` so status-events are mandatory in every worker dispatch, the orchestrator reads `.orchestrator/events.jsonl` on wake, wrapper-death is not treated as worker death without verification, and a `RECEIPT_WRITTEN` status or pushed commit outranks the wrapper notification.
- `docs/orchestrator-protocol.md` - updated hang handling so thresholds scale with expected runtime, extension happens at most once, and flat workers are salvaged from diff instead of repeatedly extended or restarted.
- `docs/model-routing.md` - updated the routing objective and task-routing guidance so latency is first-class and faster workers that clear the quality bar are preferred over slower "cheaper" workers; added explicit guidance to prefer a faster model or Claude Agent over `glm-5.2` for long-context or agentic slices when appropriate.

## Scope check

- No edits to `src/`
- No edits to `test/`
- No edits to `.claude/hooks`
- No git commit performed
