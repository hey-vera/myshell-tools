# Multi-chat parallel orchestration architecture (2026-07-10)

**Status:** ACTIVE — implement in slices  
**Base:** main @ **3.169.0**  
**Owner vision:** Real multi-tasking: multiple conversations, each with parallel goals, chat stays responsive; Esc leaves process without wiping state; reopen next day same drive.

---

## Direct answer: do we need a daemon?

| Capability | Needs out-of-process runtime? |
|------------|-------------------------------|
| Multiple goals in **one** open chat | **No** — in-process workers (exists, needs reliability) |
| Switch to **another conversation** while first chat’s goals keep running | **No if same process** — stop aborting goals on leave-chat |
| **Exit myshell entirely** (Esc → PowerShell) and goals **keep calling models** overnight | **Yes** — something must outlive the TUI process |
| Reopen next day: same chat, goals, draft, history | **No daemon** — durable store + resume (required either way) |

**Recommendation (modern, not a heavy always-on “daemon brand”):**

```
┌─────────────────────────────────────────────────────────┐
│  myshell TUI (control plane) — Esc kills THIS process   │
│  chat A / chat B / home — pure attach + drive            │
└───────────────────────┬─────────────────────────────────┘
                        │ job queue + events (disk/jsonl)
┌───────────────────────▼─────────────────────────────────┐
│  myshell-worker (detached supervisor, optional lifecycle) │
│  - spawns/claims goal jobs per conversationId             │
│  - survives TUI exit                                      │
│  - idle-exit after N min with no jobs (not always-on)     │
└─────────────────────────────────────────────────────────┘
                        │
              durable stores (already partly exist)
              conversations · goals · drafts · checkpoints · events
```

- **Not** a classic 24/7 system service unless we choose later.  
- **Yes** a **detached worker process** (or short-lived supervisor) when any goal is `running` and user leaves/exits.  
- Industry pattern: durable checkpoints + resume (Claude-class session resume) for state; detached/async workers for compute-after-exit.[[web:0]][[web:2]][[web:9]]

**Phase order:**  
1. **In-process multi-chat** (leave chat ≠ kill goals; home shows live chats; chat responsive).  
2. **Durable state on Esc** (draft, goals, transcript always).  
3. **Detached workers** so Esc doesn’t stop compute.  
4. **Polish:** keys b/c/Esc, smart status, Grok-like message ↑/↓.

---

## Product locks (this vision)

### Multi-chat
- Conversation A (project/workspace) can run goals G1…Gn in parallel.  
- User may **b**ack to home, open conversation B, run more goals — **A’s goals keep working**.  
- Home shows **live** conversations: goal counts, last pulse, “working / idle”.  
- Chat is primary control: start, pause, replan, dismiss via NL.

### Keys (replace arrow-nav system)
| Key | Behavior |
|-----|----------|
| **Esc** | Exit myshell → default terminal. Persist all state. Do **not** delete drafts/goals. Live work continues only if workers detached (Phase 3); else state survives and resume continues. |
| **b** | Hierarchical **back** → main menu. Does **not** kill goals. |
| **c** | Control panel. |
| **Shift+Tab** | Conversation Effort mode. |
| **Shift+Enter / Alt+Enter** | Newline. |
| **← / →** | Composer **cursor only** (no nav). |
| **↑ / ↓** | Select prior **user messages** → Enter inserts into box → Enter sends (Grok Build shell style). |

### Experience
- Chat replies **while** goals run (control plane ≠ blocked by goal work).  
- Smart status from real events (never eternal dumb Thinking).  
- Dead hang impossible: hang-cap + honest fail + free UI.  
- Helpful non-redundant tools stay (panel, board, accounts).

### Current code gap (3.169.0)
- `runChatLoop` finally **aborts all `backgroundGoals`** on leave — breaks multi-chat.  
- Goals are in-process only.  
- Esc mid-turn still cancel-turn oriented (needs exit + persist).  
- No global supervisor / multi-conversation worker registry.

---

## Implementation DAG

```
[PR-A] Durable leave: draft persist + Esc exit process + b/c keys + ↑ message history
[PR-B] Leave-chat does NOT abort goals; process-scoped goal registry by conversationId
        (in-process multi-chat while TUI alive)
[PR-C] Smart status pulse v2 (event verbs + goal title; no eternal Thinking)
[PR-D] Detached goal worker + job file + reattach on open
[PR-E] Home multi-conversation live status + auto-resume last
[PR-F] Release cut
```

**Parallel-safe:** A ∥ C (UI keys vs pulse); B after or careful with A on menu.  
**Serial:** D needs B’s registry semantics; E needs B+D for honest “live” counts after exit.

### PR-A — Keys + durable draft + Esc process exit
- Esc → `process.exit` after flush draft/goals/conversation (any surface).  
- **b** back stack; **c** panel; remove ←/→ nav; ↑/↓ message select.  
- Alt+Enter / Shift+Enter newline (Alt may exist).  
- Files: InputBox, App, BottomLegend, menu leave/exit paths, conversation draft store.

### PR-B — In-process multi-chat goal survival
- **Remove** abort-all-background-goals on leave-chat `finally`.  
- Global (process) `Map<conversationId, Map<goalId, WorkerHandle>>`.  
- Enter chat B while A goals run; chat loop independent.  
- NL pause still aborts that conversation’s ACs only.

### PR-C — Smart status v2
- Pulse labels from CoreEvents + active goal title.  
- Never show bare Thinking > N s without advancing label or hang-cap fail.  
- Files: reduce, StatusBlock, mount.

### PR-D — Detached workers (the “daemon-lite”)
- On goal start (or on Esc with running goals): ensure `myshell-worker` detached process with job queue under state home.  
- Worker claims jobs, runs goal loop, writes events/status to disk.  
- TUI polls/reads status; does not own AC for detached jobs.  
- Worker exits when queue empty (idle TTL).  
- Windows: `detached: true`, unref; Unix: same + ignore SIGHUP where needed.

### PR-E — Home multi-chat surface
- Recent list shows live goal counts / “working”.  
- Open conversation reattaches to worker status.  
- Create new chat without stopping others.

### PR-F — Version bump when green

---

## Definition of Done (vision bar)

1. Chat A: start 2 goals via chat → both work; chat still answers.  
2. **b** home → open chat B → start goals; A still working (same process).  
3. Esc → PowerShell; state on disk; reopen → same chats/goals/draft.  
4. With PR-D: work continued across Esc (or honest “paused at exit, resume?” if worker not yet on).  
5. Keys: Esc / b / c / Shift+Tab / Shift+Enter / ↑ message history.  
6. No dead Thinking; smart status.  
7. CI green; GH clean (squash, no junk branches left unmerged).  
8. Publish cut after owner smoke.

---

## Non-goals (this wave)
- Cloud multi-device sync  
- Full r7 Item-13 DAG theater  
- Always-on Windows service install by default  

---

## Operating
- Branch from `origin/main` only; isolation worktrees; green CI auto-merge.  
- Orchestrator does not Edit/Write `src/`/`test/`.  
- Keep PR titles user-facing; close/stack carefully.
