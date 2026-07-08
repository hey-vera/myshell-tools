# myshell-tools

**Hierarchical, multi-provider AI orchestration for your shell — over the CLIs you already use.**

`myshell-tools` routes each task to the *cheapest* model likely to succeed, runs it on your real codebase, optionally has a **different vendor** review the result, and shows you exactly what it did and how many real tokens it used — with **no fabricated data, ever**.

> **Status: `3.163.1` — honest, tested, and real.** Claude, Codex, Grok, and opencode (experimental) all work, provider auth is detected for real, and the header always shows whether you're on the latest version (`(latest)` or `→ x.y.z available`).

---

## Current daily use status (honest snapshot)

**What works today for everyday use ("one chat to rule them all")**:
- Interactive control panel + natural language chat over your real repos (workspace-bound conversations; NL requests like "fix the failing test" or "refactor X" run via the cheapest suitable provider CLI you have signed in).
- NL repo operations land via the chat: edits, git-aware work, verification on accept, goal decomposition, multi-turn continuity. (Active polish on menu + per-workspace execution per `docs/menu-build-spec-final.md`; full durable NL repo editing continues to land in slices.)
- Automatic routing + effort modes (Efficient/Balanced/Max or Auto), learned preferences, parallel goals (default on), honest token accounting + receipts.
- Provider support: full for Claude, Codex, Grok; opencode experimental but usable. Cross-vendor review/panel on hard turns (governed). Login, install, cost, eval available.
- Cross-platform (Node 20+): works on Linux/macOS/Windows, containers, SSH, Replit etc. (some PTY/Ink features graceful-fallback).
- Self-healing health on launch; no fabricated data ever (arch tests + contract tests enforce).

**Gaps / not yet daily-driver for everything** (see `docs/ROADMAP-STATUS.md`, `docs/vision-alignment-audit-2026-07-06.md`):
- Some advanced contracts (e.g. full intent continuity, certain completion bindings) are merged but dark/default-off pending rollout gates + eval.
- Native parallel panel / heavy concurrency is governed (quota-aware), not always-on.
- Menu/workspace UI is in active build (see menu spec); current panel is functional.
- No PTY-dependent features in CI/headless; use non-interactive paths (`run`, `doctor`, etc.).

Use daily via global install + chat for real work on your codebases. Always run with at least one authenticated provider CLI. For feedback or issues use the hidden-but-supported `myshell-tools doctor`.

---

## Quickstart — zero install

```bash
npx myshell-tools
```

That's it.  `npx` fetches the package, runs the interactive setup, and:

1. **Detects** which provider CLIs (Claude Code, Codex, Grok, opencode) are already installed.
2. **Offers to install** any missing ones — one keypress (`Enter` to install, `n` to skip).  It never installs anything silently; consent is always required.
3. **Offers to sign you in** to providers that are installed but not yet authenticated.
4. Drops you into the home menu, ready to use.

On subsequent runs `npx myshell-tools` goes straight to the menu (setup only runs once).

### Install once (optional)

If you prefer a permanent global install:

```bash
npm install -g myshell-tools
myshell-tools
```

---

## Why it exists

Using one frontier model for everything is wasteful (renaming a variable doesn't need Opus) and single‑model output has blind spots. `myshell-tools` addresses both, honestly:

- **Cost‑aware routing** — trivial work goes to the cheap tier (Haiku / GPT‑5 mini), real implementation to the mid tier, hard calls to the flagship. The efficiency shows up as a billing‑agnostic ratio (how many flagship tokens you avoided), not a dollar figure — because you're on a subscription, not metered API billing.
- **One quality knob — `Efficient · Balanced · Max`** — sets *how readily routing reaches the strongest (Opus / GPT‑5.5‑class) model*. Because you're on a flat‑rate subscription, the scarce resource is rate‑limit headroom, not dollars — so flagship access is an **adaptive per‑turn decision**, not a fixed price ceiling. (We are preference-aware via observed taste/ledger + real plan tiers rather than fabricating quota estimates.) `Efficient` never auto‑opens the flagship; **`Balanced` earns a single flagship pass on a turn that proves it needs one** (high/critical risk, low confidence, or a reviewer escalation); `Max` opens it whenever a turn asks. **The default auto-detects from your subscription** (a Max plan auto-selects `Max`; smaller plans default to `Balanced`) — no configuration, no interrogation. Change the Effort Mode on the home screen (`m`), in-chat (`/mode`), or in Settings; it's one global knob, changeable anywhere.
  - `Efficient` — stays on the lighter models, escalating among them only when a turn needs it; reviews cross-vendor on *critical*-risk tasks only. Won't auto-open the flagship.
  - `Balanced` — earns one pass at the strongest model on a turn that proves it needs it (high-risk / low-confidence / reviewer escalation); otherwise stays mid-tier. Vetoed on an observed free plan.
  - `Max` — opens and reaches for the strongest model and reviews high/critical work; best answers, slower, never capped.
- **Keeps going until it's done** — ask for something big and the chat just does it; if a job is too large for a single turn, it offers to *keep working autonomously, step by step, until it's done* — you say "yes", no command to learn (or start it explicitly with `/goal <text>`). Bounded by a turn ceiling and Esc, and it survives per-turn timeouts so a multi-file build actually completes across turns.
- **A real advisor, not an order-taker** — for a decision (language, library, design) it forms an opinion and recommends a clear winner, surfaces a strong option you may not have considered, and asks only the one or two questions that actually change the answer.
- **Cross‑vendor adversarial review** — a *different vendor* checks the first model's output (Codex reviewing Claude, or vice‑versa). Different families, different blind spots. Review gating depends on Effort Mode; see the quality knob above.
- **Multi-turn context continuity** — follow-up messages carry real context. Prior conversation turns are compacted into a bounded history block (~6 k chars, most recent 12 turns) and replayed to the model, so it actually knows what was said earlier. Confidence envelopes are stripped before replay to save tokens.
- **Native session continuity** *(default on; opt-out via config or env)* — when active for a conversation on the same provider, reuses that provider's *native* session (Claude conversation id; Codex captured thread) instead of replaying the full history block. Improves fidelity and reduces re-sent tokens. Falls back cleanly to history replay. (Promoted from experimental; governed for safety.)
- **Parallel Subscription Panel** *(governed, not static default-on)* — on hard (high/critical-risk) turns (when ≥2 signed-in providers), runs concurrent panel of providers + cross-vendor synthesis. Subscription-first (no $ cost, only quota/latency). Still opt-in/governed via Auto/Effort; does not fire on every turn. See Settings for related controls.
- **Smart parallel goals** (default on, opt-out with `MYSHELL_SCHEDULER=0`) — `/goal` (and auto-goals) decomposes plans into independent sub-goals that run concurrently (bounded by providers + pressure; sequential plans stay 1 goal for honesty). DAG deps respected, per-goal progress/ledgers visible, ESC fans out. Subscription-first: no extra cost beyond your plan's quota. First-touch explainer on first use. See `docs/parallel-agent-goals-5.7.md`.
- **Learned Routing (Local Outcome Learner)** *(default on)* — learns from **your own ledger** which provider tends to finish your work best per tier (ranked by observed success rate, tie-broken by latency) and prefers it. It's observed-only — it uses only recorded success + duration, never plan/quota/token inference. Requires history (≥3 runs per provider + ≥2 qualifying per tier) before reordering; otherwise no-op. Safe reorder only. Toggle via Settings if desired.

- **Pure planning (/plan) + persistent plan viz + learned taste (default on)** — `/plan <text>` is a first-class pure-planning pass (full judgeGoal parity: proposal with vision/approach/rationale/deps, diff-stub, heads-up, PLAN.md write, park for /goals, taste record). Plans are preference-aware (taste ledger injected into planner prompts). Approach/rationale always visible on the board (StatusBlock + layout budget). `/taste` or `/prefs` shows your observed playbook + bias. Toggle in Settings [t]. No fake quotas.
- **Container / SSH sign-in** — `myshell-tools login` auto-detects headless and cloud-IDE environments (Replit, Codespaces, Gitpod, SSH sessions) and switches to a no-localhost sign-in flow automatically. Force either flow with `--code` or `--browser`. For Claude it runs `claude auth login` (claude saves its own credential — nothing for us to store); if the browser shows a localhost / "can't be reached" error after you click Authorize, copy the **full URL from the address bar** (it contains the sign-in code) and paste it back when claude asks. For Codex, a device-code flow is used.
- **opencode provider (experimental)** — auto-detected; works instantly with free hosted models (no keys). As a subscription/free provider it **uses whatever model you've configured in opencode** (a free opencode-zen model, or a premium one you've added — e.g. **Kimi K2**); myshell-tools doesn't pin a model for it, so "just use whatever opencode has" works out of the box. `[o]` is always visible in the Auth section: it installs `opencode-ai` (with consent) if missing, then runs `opencode auth login`. Route to it explicitly or let the policy fall back to it automatically.
- **Routing prefers advertised models** — detection passes each provider's actual model list to `route()`, which picks the cheapest model the CLI *actually has*, not just the cheapest in the pricing table. Falls back gracefully if the advertised list doesn't match any pricing entry.
- **Subscription, not metering** — it drives the **Claude Code**, **Codex**, and **opencode** CLIs you already use. No API keys, no per‑token bill for the free path.
- **Honest by construction** — every number on screen traces to a real measurement. A suite of *architecture tests* makes fabricated/mock output literally unmergeable.

---

## Requirements

- **Node.js ≥ 20** for the compiled CLI (`dist/`). **Node ≥ 22** is required to run the test suite (see Development below).
- At least one provider CLI.  `npx myshell-tools` will **offer to install** them for you on first run — or you can install manually:
  - **Claude Code** — `npm install -g @anthropic-ai/claude-code`, then sign in when prompted. In containers or over SSH, run `myshell-tools login claude --code`: it runs `claude auth login` and shows a sign-in link; if the page errors on a localhost redirect after you authorize, copy the full address-bar URL (it carries the code) and paste it back when claude asks. Claude persists its own credential — myshell-tools stores nothing.
  - **Codex** — `npm install -g @openai/codex`. In containers or over SSH, run `myshell-tools login codex --code` for a device-code flow (no localhost callback needed).
  - **Grok** — `npm install -g @xai-official/grok`, then sign in (supports OAuth and device-code for containers/SSH).
  - **opencode** *(experimental, optional)* — auto-detected when the `opencode` CLI is installed. Works immediately with free hosted models (no keys). `[o]` is **always available** in the control-panel Auth section: if opencode is not yet installed, selecting it asks for consent and runs `npm install -g opencode-ai`, then runs `opencode auth login` to add a premium provider or subscription — myshell-tools never handles the credentials. Appears in the control-panel header and raw-session picker only when installed.

You need **one** to start; install **claude + codex** (or + grok) to unlock cross‑vendor review. Grok and opencode are first-class too.

---

## Install options

| Method | Command | Notes |
|--------|---------|-------|
| Zero-install (one-time) | `npx myshell-tools` | Fetches and runs; first-run setup included |
| Global install (recommended for regular use) | `npm install -g myshell-tools` then `myshell-tools` | Fastest; gets the update notifier |
| From source | See below | For development |

### `npx` vs. `npm install -g` — which to choose?

`npx myshell-tools` is convenient for a one-off run but **caches the downloaded version** — subsequent invocations reuse the cache and **will not pick up new releases** automatically. The tool detects when it's running under npx and, if a newer version exists, tells you exactly that instead of pretending to self-update (a global install run from an npx process is ignored by the next `npx` invocation). If you're stuck on an old version via npx, clear the cache (`rm -rf ~/.npm/_npx`) or — better — install globally:

For day-to-day use, a global install is recommended:

```bash
npm install -g myshell-tools
myshell-tools
```

**Post-`npm install -g` detection / onboarding notes:**
- Run `myshell-tools` (or `myshell-tools doctor --fix`) immediately to trigger provider detection + first-run prompts (auth, auto-update consent, optional shell integration).
- Provider detection is best-effort and re-runs on demand; it probes real CLIs (`claude --version`, `codex --version`, `grok --version`, `opencode --version`) rather than just PATH presence. If a fresh global provider install is not yet in PATH for the current shell, open a new terminal or run `hash -r` (bash) / rehash.
- For automatic menu on new shells: run `myshell-tools install` (writes guarded startup hook to your rc; safe + idempotent; `uninstall` to remove). This is separate from the npm package install.
- On Windows / containers / Replit: use `myshell-tools login <prov> --code` for headless flows; detection still works but browser OAuth may need manual URL copy-paste.
- Hardening tip: if detection seems stale after install, `myshell-tools doctor --fix` forces refresh + repair.

The globally-installed CLI includes the **update notifier**: it checks the npm registry once per 24 hours (cached, non-blocking) and shows a banner in the control panel when a newer version is available:

```
▲ Update available: 2.9.0 → 3.0.0  (press u)
```

Press `u` to install the update in-place (`npm install -g myshell-tools@latest`). No relaunch is forced — restart the CLI when you're ready.

You can also enable **auto-update** so the CLI updates and relaunches itself silently at startup.  Auto-update is **on by default** — the first-run prompt asks `Keep myshell-tools up to date automatically? (Y/n)` and defaults to yes.

To opt out:
- During first-run setup: answer `n` to the `Keep myshell-tools up to date automatically? (Y/n)` prompt.
- In the control panel: `[s] Settings → [3] Auto-update: on → off`.
- Or set `"autoUpdate": false` in your `config.json` (in the platform config dir: `~/.myshell-tools/` or `$XDG_CONFIG_HOME/myshell-tools/` on Linux/macOS, `%APPDATA%\myshell-tools\` on Windows, or the workspace `.myshell-tools/` on Replit/Codespaces/Gitpod).
- Or set `MYSHELL_NO_UPDATE=1` in your environment to disable auto-update permanently without changing config.

To update manually at any time:

```bash
npm install -g myshell-tools@latest
```

### From source

```bash
git clone <this-repo>
cd myshell-tools
npm install
npm run build
node dist/cli.js --help
# optional: make `myshell-tools` available globally
npm link
```

---

## Usage

```text
myshell-tools [command] [options]

Commands:
  (none)            Open the interactive control panel (default)
  run <task...>     Run a one-shot task and exit
  repl              Start the plain line REPL (no menu)
  rollback [off]    Disable or restore verify, judgment, and trust
  login [provider]  Sign in to a provider (claude, codex, opencode, or grok) via its own OAuth. --code for no-localhost (containers/SSH)
  cost              Show real spend from the ledger with a per-model breakdown
  eval              Run the frozen answer-quality ruler (opt-in, cost-stated)
  install           Write guarded startup hook to rc so new shells auto-launch menu
  uninstall         Remove the startup hook

(Note: doctor/status/check work as hidden scriptable aliases for health report; not shown in main --help.)

Options:
  -h, --help     Show this help message
  -v, --version  Print version number
```

## Home menu and workspaces

The default entry screen is the home menu: an **Effort Mode** box at the top, one
workspace-aware **Recent** list in the middle, and a compact **Session Manager**
action list at the bottom. `m` changes the default effort mode, `n` starts a new
conversation, `e` opens the full conversation library, and `Esc` exits from the
root menu.

Each conversation is now bound to a workspace root. On **New conversation**, press
`Enter` to use the current repo root / cwd, or choose the workspace picker to bind
the conversation somewhere else. When you resume that conversation later, normal
chat turns and `!<command>` shell passthrough both run from the saved workspace
root, and the Recent list shows cross-workspace conversations with their location
inline.

### A real run

These are **actual, unedited** outputs (your costs/timings will differ):

```text
$ myshell-tools run "what is 2 plus 2"
▶ WORKER (claude/claude-haiku-4-5) attempt 1
2 plus 2 equals 4.
✓ tier done — confidence: 100%, 312 tokens, duration: 5648ms
Success — tier: worker, 312 tokens, attempts: 1, session: 0dbfe2e3-…
```

The confidence (`100%`) is **parsed from the model's own structured reply**, not invented. The token count is the **CLI's own reported usage** — real and measured. Because myshell-tools drives your *subscription* CLIs (not metered API keys), the hot path shows tokens, not dollars; a per-task dollar figure wouldn't map to flat subscription billing. If you want a rough API-equivalent cost estimate, it lives in `myshell-tools cost`.

### Health — automatic, no command needed (discover via `doctor`)

The control panel checks its own environment on every launch (Node version, whether the state directory is writable, pricing freshness) and shows a short, actionable warning **only when something is actually wrong**. When everything is fine, it stays quiet.

`doctor` / `status` / `check` are intentionally not listed in `--help` (self-healing is preferred; see menu spec), but remain fully supported as scriptable commands for support, CI, and explicit checks. Use directly:

```text
$ myshell-tools doctor
# or: myshell-tools status
# or: myshell-tools check
```

They also support `--fix` for interactive repair (installs, sign-ins, token refresh).

Example output:
```text
$ myshell-tools status
myshell-tools — environment health
Platform: linux
Node:     v22.19.0
...
Providers
  ✓ claude — installed, version: 2.1.157 (Claude Code)
    auth: signed in (pro)
  ✓ codex — installed, version: codex-cli 0.135.0
    auth: signed in
Ready — at least one provider is available.
```

**Tip for onboarding / post-install:** run `myshell-tools doctor` (or with `--fix`) right after `npm install -g` or first `npx` to verify detection and auth.

### Usage & efficiency (`cost`)

This is a *subscription* tool, so the everyday UI shows **real, measured tokens** — never per-task dollars, which wouldn't map to flat subscription billing. The on-demand `cost` view leads with tokens and a **billing-agnostic routing-efficiency ratio**, then offers a clearly-captioned API-equivalent dollar estimate for anyone who wants the magnitude:

```text
$ myshell-tools cost
myshell-tools — usage & efficiency
Tasks run:   3
Tokens used: 12.4k (real, measured)
Per-model usage
  claude-haiku-4-5: 2 tasks, 4.1k tokens
  claude-sonnet-4-6: 1 task, 8.3k tokens
Routing efficiency
Routing picked cheaper-tier models where it could — ~6.3× less than sending every task to the flagship (claude-opus-4-7).
Estimated cost  — API-equivalent (list price), not your subscription bill
Routed: ~$0.0020   ·   always-flagship: ~$0.0126
```

The **efficiency ratio is honest under a subscription** (it compares flagship tokens you avoided, not dollars you were charged). The dollar figures are explicitly labeled an *API-equivalent estimate* — not your actual bill — and both use the **same basis** (list price × tokens), so "routed vs always-flagship" is apples-to-apples and internally consistent.

---

## How it works

```
classify ─▶ route(cheapest tier) ─▶ run ─▶ assess
                                      │
       high-risk IC work ────────────┘──▶ cross-vendor review (other vendor)
                                              approve → accept
                                              revise  → retry with feedback
                                              escalate→ manager tier
       low confidence / failure ─────────▶ escalate to a higher tier
```

- **Tiers** map to stable model *aliases* (`haiku`/`sonnet`/`opus`, or the Codex tiers), so when a vendor ships a newer model the alias resolves to it automatically — no myshell-tools update needed.
- **Cost** prefers the provider CLI's own reported figure (Claude does this); otherwise it estimates from real token counts and a dated, staleness‑warned price seed.
- Every run is recorded to an append‑only **session log** and **cost ledger** under the project's `.myshell-tools/`. App‑level state (config, conversations, goals, credentials) lives in the platform's standard dir (see above) and is migrated forward automatically on first launch.

---

## Safety, verification, and rollback

### Stable defaults (v9 Phase 7)

Three quality guards are **default-on** in interactive chat:

| Feature | Default | Opt-out |
|---------|---------|---------|
| **Judgment** — risk-aware brain loop, confidence-derived routing | on | `MYSHELL_JUDGMENT=0` or `MYSHELL_BASIC=1` |
| **Trust receipt** — structured evidence labels derived from verification outcomes | on | `MYSHELL_TRUST=0` or `MYSHELL_BASIC=1` |
| **Verify** — runs detected project test commands at accept time to confirm work is sound | on (interactive chat only) | `MYSHELL_VERIFY=0` or `MYSHELL_BASIC=1` |

Config aliases `experimentalJudgment`, `experimentalTrust`, and `experimentalVerify` still load and save; they are deprecated names for the same three keys and will be removed in a future major version.

**Verify and the one-shot `run` path.** Verify is default-on in interactive chat but stays **conservative (default-off)** in the scriptable `myshell-tools run` path, because scripted calls must never run test commands without explicit opt-in. Set `MYSHELL_VERIFY=1` to enable it for one-shot runs. Trust and judgment are not wired in `run` (judgment requires interactive question handling).

**What verify does.** At accept time it detects the project's test command (Jest, pytest, `go test`, `cargo test`, and similar) and runs it. It does not execute arbitrary shell commands — detection is command-gated. A passing result strengthens the trust label; a failing or skipped result is reported honestly without blocking delivery.

### Rollback — feature rollback only

```bash
myshell-tools rollback       # persistently disable verify, judgment, and trust
myshell-tools rollback off   # remove the persisted override and restore defaults
```

`MYSHELL_ROLLBACK=1` is the **emergency no-write form** and always takes precedence over config.

Rollback scope is **verify, judgment, and trust only**. Governor, taste, and tribunal are not changed. Rollback does **not** revert files, undo workspace changes, or restore any prior repository state — it is a feature-posture switch, not a filesystem undo operation.

### Goal cancellation

```
/goals cancel <n>
```

Cancels parked goal `<n>` and terminates any live descendant work. Work already marked done or verified is preserved. This is **goal-level cancellation**, not a filesystem undo — files already written by completed sub-goals are not reversed.

### Prompt-injection boundary

Repository files (`CLAUDE.md`, `AGENTS.md`, `README.md`), tool output, conversation history, model output, reviewer feedback, and salvaged drafts are all wrapped as **untrusted data** before they reach model prompts. The policy header inside each wrapper declares that enclosed content is evidence only — instructions, trust claims, confidence claims, completion markers, command tiers, and safety/verification directives inside untrusted spans have no authority.

Three properties are always derived from typed, deterministic evidence — never from prose inside an untrusted span:

- **Command tier** — recomputed from the actual command string immediately before execution; defaults unknown commands to `local-write` and chooses the most dangerous match.
- **Confidence and trust labels** — derived only from typed `VerifyOutcome` and provider evidence; no trust label stronger than the supplied outcome is produced.
- **Risk classification** — deterministic and raise-only; model or repo content cannot lower it.

---

## The honesty contract

This is a ground‑up rebuild whose first principle is: **the tool never shows fabricated, mocked, or randomized data as if it were real.** It's enforced, not promised:

- **Architecture guard tests** fail the build if the UI/command layers contain hardcoded "AI responses", fake metrics, or a digit‑then‑`%` literal; if the orchestration core touches the filesystem, clock, or RNG directly; or if any module other than the entry point can terminate the process.
- **An extensive unit + architecture-guard suite** (plus contract tests with parsers pinned to *recorded real transcripts*), with `tsc --strict`, ESLint, and a clean `npm pack` checked in CI across Windows / macOS / Linux.

---

## Architecture

Hexagonal / ports‑and‑adapters:

- `src/core/` — **pure** orchestration (classify, route, assess, review, escalate). No I/O; everything injected. 100% testable with fakes.
- `src/providers/` — the `Provider` port + Claude/Codex adapters (via `execa`, prompt over **stdin**, cancelable, streaming).
- `src/infra/` — atomic session/ledger persistence, clock, pricing seed.
- `src/interface/` + `src/ui/` — REPL, one‑shot runner, streaming renderer, theme.
- `src/commands/` — `doctor`, `cost`.

**One runtime dependency** (`execa`, for correct cross‑platform process handling — including Windows process‑tree cancellation). Everything else is the Node standard library.

---

## Development

**Node ≥ 22 is required to run the test suite.** `npm test` uses
`node --experimental-strip-types` (native TypeScript stripping, available from
Node 22+). The compiled runtime (`dist/`) supports Node ≥ 20, so
`package.json` `engines` is left at `>=20`.

```bash
npm run typecheck      # tsc --strict, 0 errors
npm run lint           # ESLint (typescript-eslint strict)
npm test               # unit + architecture tests (requires Node ≥ 22)
npm run test:contract  # parser contract tests vs recorded transcripts
npm run build          # tsc → dist/
npm run smoke:launch   # simple cross-platform (no PTY) launch smoke: --version + --help (use for quick post-install / CI verification)
```

---

## License

MIT — see [LICENSE](LICENSE).
