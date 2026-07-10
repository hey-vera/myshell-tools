# Control plane + goal manager completion (2026-07-10)

**Status:** ACTIVE → implement → green CI → merge → **3.169.0** cut for external npm smoke  
**Base:** origin/main @ 3.168.0 (`f035f38`)  
**North star:** one chat multi-goal manager; control plane always live; goals are owned not theater.

## Product contracts (locked from owner + code audit)

### Keys & leave
| Input | Behavior |
|-------|----------|
| **Esc (chat idle)** | Leave chat → **home menu**. Goals keep running. |
| **Esc (home)** | Exit process to shell (existing home Esc). |
| **Esc (mid-turn)** | Cancel **this foreground turn only** (abort `currentAc`). Stay in chat. **Do not** abort background goals. **Do not** force `control.exit` (fix Slice 4 “ESC exits app mid-chat”). |
| **NL pause** | Primary way to pause/stop goals: “pause this”, “pause all while I research”. Smart: park + abort worker; ask if ambiguous. |
| **Bare ←/→ with empty buffer** | Menu / panel (keep). |
| **With non-empty draft** | Bare ←/→ = **cursor**. Nav via **Ctrl+G** (panel, always) + **Alt+←** home/menu + **Alt+→** panel (or Ctrl+← if Alt hard on Windows—prefer Ctrl+G + Alt when available). |
| **`/back` `/exit` mid-turn** | **Preemptive**: abort foreground turn, run control command; never FIFO-queue forever. |

### Liveness
| Rule | Behavior |
|------|----------|
| Pulse | Status line from **real** last event (Preparing / Routing-tier / Thinking / tool verb / Responding). |
| Stall | If no CoreEvent for **≥12s** after turn active: show `stalled · last <label> · Ns` (honest). Do not invent work. |
| Orchestrate | Already called on model path; hang-cap remains provider backstop. |

### Goals
| Rule | Behavior |
|------|----------|
| Integrity | `running` ⇔ mapped live AbortController **or** reconcile to parked/failed with notice. |
| Spawn fail | Never silent empty catch leaving `running`. |
| Pause | Park store **and** abort AC. Pause-all supported. |
| Steward | Keep propose lines; add **startup reconcile zombies** + post-turn integrity check. Full Item-13 DAG out of scope. |

### Draft & mode
| Rule | Behavior |
|------|----------|
| Draft | Persist composer draft per conversation (debounce write); restore on re-enter chat. Survive `/back`, process restart if store on disk. |
| Mode mid-turn | Shift+Tab updates next-turn mode; chrome may show `next turn` honesty. No hot-swap in-flight provider call. |

## PR DAG

```
[PR1 nav+draft chords] ──┐
[PR2 pulse stall] ────────┼──► green → merge → main
[PR3 menu control+goals] ─┘
         │
         ▼
[PR4 release 3.169.0]
```

### PR1 — Nav with draft + always-hot panel + legend
- **Files:** `InputBox.tsx`, `App.tsx`, `BottomLegend.tsx`, tests ui/*
- **Esc wiring:** idle Esc may call leave-chat bridge (if exposed); mid-turn still onEscape→interrupt (menu owns semantics in PR3)
- **Non-objectives:** menu.ts mega rewrite

### PR2 — Turn pulse + stall chrome
- **Files:** `reduce.ts`, `state.ts`, `StatusBlock.tsx`, `core-event` if needed, tests
- **Non-objectives:** auto-abort on stall (display only)

### PR3 — Esc leave semantics + preemptive control + goal AC integrity + NL pause-all
- **Files:** `menu.ts` (primary), `menu-post-turn.ts` if needed, `meta-decision` if pause-all, `BottomLegend`/`StatusBlock` copy if not in PR1, goal-store usage
- **chatEscHandler:** mid-turn = interrupt turn only (`interruptedByEsc`, abort currentAc); **remove** sticky `control.exit` from Esc mid-chat. Idle leave via `/back` or Alt+← or dedicated leave.
- **Capture:** `/back` `/exit` preempt
- **backgroundGoalControllers: Map<goalId, AC>**
- **Non-objectives:** full scheduler rewrite

### PR4 — version 3.169.0
- After 1–3 on main

## Definition of Done
- CI green all OS/node on each PR
- Independent: typecheck, lint, knip, full unit when practical
- Vision: multi-goal manager; no Esc kill-all; no empty-buffer trap; no zombie running without heal
- User can `npm publish` 3.169.0 for external testing

## Improved ideas (beyond original ask)
1. **Control allowlist** — only `/back` `/exit` `/menu` preempt; prose still queues.
2. **Leave chat ≠ kill goals** — home shows live goal count.
3. **Stall frees control** — after stall UI, ensure capture still accepts preempt (hang-cap may still run).
4. **Zombie reconcile on chat enter** — not only post-turn.
5. **Pause with reason** stored on goal for rewatch (“waiting on user research”).
