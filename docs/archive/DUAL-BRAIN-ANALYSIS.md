# Dual-Brain → myshell-tools: feature analysis & extraction plan

Studied the dual-brain repo (the predecessor's "fancy UX") to make myshell-tools stronger,
more coherent, and more polished. dual-brain was built **on top of** replit-tools/data-tools
(it imported their sessions). **myshell-tools is standalone**, so anything we adopt we build
ourselves — and better, because dual-brain's own ROADMAP admits parts are fake (*"Health/token
stats always zero," "some model names may be fictional"*). **Our differentiator stays: real
data, honestly.** We take dual-brain's UX and intent; we keep our Honesty Contract.

---

## The north star (dual-brain's VISION, adopted)

myshell-tools is a **session/conversation manager first**, a router second, an admin tool never.
The design rules we adopt:

1. **Sessions first** — the main screen *is* the recent-conversation list. Resume work, not inspect health.
2. **One screen** — a single `mainScreen`; settings/manage/auth are letter-keys you navigate back from. No wizard mazes in normal use.
3. **Box everything** — all status uses the boxed/`separator`/`menu` visual language (our `ui/tui.ts`, ported from dual-brain).
4. **10-second setup** — first run auto-detects providers + plan and offers a single-Enter fast path. Customization is behind `[c]`.
5. **Provider invisible** — user says "new conversation"; we pick the provider/tier. Plan labels shown for budget awareness, not to force a choice.
6. **Subscription auth, never API keys** — `claude auth login` / `codex login`; we never store credentials. (Already true.)

---

## Feature map

Legend: ✅ have · 🟡 partial · ⬜ missing · 🚫 skip (not for a standalone/honest tool)

| Area | dual-brain | myshell-tools | Action |
|---|---|---|---|
| **Routing pipeline** | detect → decide → dispatch | classify → route → orchestrate | ✅ keep ours (cleaner, tested) |
| **Cross-vendor review** | dual-brain-review (2-round) | escalation + cross-vendor review loop | ✅ have |
| **Cost ledger** | cost-logger, receipt | real ledger + CLI-reported cost | ✅ have (and **real**, not zero) |
| **Cost counterfactual** | cost-report | `cost` apples-to-apples | ✅ have |
| **Persistent conversations** | session.ts (import + overlay) | file conversation store (wave 1) | 🟡 have store; need the UX |
| **Sessions-first main screen** | mainScreen | bare REPL prompt | ⬜ **P0 — build the menu** |
| **10-sec setup / welcome** | welcomeScreen, setup-wizard | `login` cmd only | ⬜ **P0 — onboarding** |
| **Conversation pin/rename/category** | enrichSessions | store has rename/remove | 🟡 add pin + category + smart auto-title |
| **Recent list w/ relative time** | enrichSessions.slice(0,7) | — | ⬜ **P0** (part of main screen) |
| **Real auth status** | detectAuth | optimistic-on-install | 🟡 **P1** — use `claude auth status` (verified to exist) |
| **Plan/subscription labels** | detectPlans, PLAN_LABELS | — | 🟡 **P1** — plan labels for budget awareness (honest: only if detectable) |
| **Modes (cost-saver/balanced/quality-first)** | settingsScreen | single DEFAULT_POLICY | ⬜ **P1** — 3 policy presets, switchable |
| **Budget awareness / caps** | budget-balancer | ledger only | ⬜ **P2** — soft budget + "you've spent $X today" |
| **Provider health (hot/healthy/degraded)** | health.ts | — | ⬜ **P2** — derive from ledger success/latency |
| **install --global / set-as-default** | `dual-brain install` | — | 🟡 **P1** — config flag + a shell-alias helper |
| **Quality gate (auto-review on code change)** | quality-gate | manual review path | ⬜ **P2** — opt-in |
| **Wave orchestrator (parallel agents)** | wave-orchestrator | single tier + escalation | ⬜ **P3** — later, if benchmarked to help |
| **HEAD state machine (intent/confidence/drift)** | head.ts, cognitive-loop | classify+assess | 🟡 **P3** — incremental, only if it earns it |
| **MCP server** | 4 JSON-RPC tools | — | ⬜ **P3** — exposes myshell-tools to other agents |
| **Replit/data-tools session import** | importReplitSessions | — | 🚫 skip (we're standalone) |
| **Claude Code hooks/plugin** | many hooks | — | 🚫 skip (different distribution model) |
| **Fake/zero stats, fictional models** | admitted in ROADMAP | real pricing + CLI cost | 🚫 **never** — our honesty edge |

---

## Prioritized build plan

**P0 — the experience you actually asked for (build now):**
1. **Sessions-first `mainScreen` menu** (`interface/menu.ts`) using `ui/tui.ts`: boxed header (🧠 + version + provider status lines w/ emoji), `separator('Recent Conversations')`, recent list (store, ≤7, relative time + title + category), sectioned `menu` (Conversations: continue/new/resume[1-9]/manage · Auth: login claude/codex · Settings · Quit).
2. **First-run welcome / 10-sec setup**: auto-detect providers, boxed status, `[Enter] Save & go` (mark onboarded), `[c] customize`, offer `login` if unauthed, ask "set myshell-tools as your default? y/n".
3. **Chat loop per conversation**: continue/new/resume → stream `run` output, persist to the conversation; `/help`, `/exit` back to menu.
4. Wire `myshell-tools` (no args) → `mainScreen`. Keep `run`/`repl`/`doctor`/`cost`/`login` as direct subcommands.

**P1 — coherence & polish:**
- Real auth status via `claude auth status` (+ codex), shown with ✅/⚠️/🔴 in the header.
- Honest plan labels where detectable (budget awareness), else omit — never invent.
- Conversation **pin / category / rename / delete** in the manage screen; smart auto-title from first message (store already auto-titles).
- **Modes**: `cost-saver | balanced | quality-first` → three `Policy` presets, switchable in Settings, persisted in config.
- **Set-as-default**: config flag + an optional shell-alias snippet the user can opt into.

**P2 — depth:**
- Budget awareness: daily/total spend surfaced on the main screen; soft cap warning (from the real ledger).
- Provider health derived from real ledger (success rate, latency) → ●/⚠ chips.
- Opt-in quality gate (auto cross-vendor review when a run edits code).

**P3 — reach (only if it earns its place):**
- Wave orchestrator (parallel agents) — gated behind a benchmark showing it wins.
- MCP server exposing myshell-tools to other agents.
- Richer "brain" (intent/confidence/drift) — incremental, measured.

---

## Guardrails carried over
- Everything new still passes the **architecture/honesty guards** (no fabricated data; `ui`/`interface`/`commands` scanned). dual-brain's fake stats would fail our guards — that's the point.
- **Box/separator/menu** primitives (`ui/tui.ts`) are the single visual language; don't hand-roll status output.
- **Subscription auth only.** No API keys, no credential storage.
- **Standalone.** No replit-tools/data-tools dependency; we own the session store.
