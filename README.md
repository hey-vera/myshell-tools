# myshell-tools

**Hierarchical, multi-provider AI orchestration for your shell — over the CLIs you already use.**

`myshell-tools` routes each task to the *cheapest* model likely to succeed, runs it on your real codebase, optionally has a **different vendor** review the result, and shows you exactly what it did and how many real tokens it used — with **no fabricated data, ever**.

> **Status: `3.2.0` — honest, tested, and real.** Claude, Codex, and opencode (experimental) all work, provider auth is detected for real, and the header always shows whether you're on the latest version (`(latest)` or `→ x.y.z available`).

---

## Quickstart — zero install

```bash
npx myshell-tools
```

That's it.  `npx` fetches the package, runs the interactive setup, and:

1. **Detects** which provider CLIs (Claude Code / Codex) are already installed.
2. **Offers to install** any missing ones — one keypress (`Enter` to install, `n` to skip).  It never installs anything silently; consent is always required.
3. **Offers to sign you in** to providers that are installed but not yet authenticated.
4. Drops you into the control-panel menu, ready to use.

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
- **Efficiency modes** — three policy presets control the cost/quality trade-off:
  - `cost-saver` — routes to the cheapest capable model for each tier; only runs the cross-vendor review pass on *critical*-risk tasks (not every IC call). An optional `maxCostUsd` cap halts further escalation/review once spend reaches the limit.
  - `balanced` — the default; routes intelligently and reviews high-risk work.
  - `quality-first` — always reviews IC output for high/critical tasks, regardless of cost.
- **Cross‑vendor adversarial review** — a *different vendor* checks the first model's output (Codex reviewing Claude, or vice‑versa). Different families, different blind spots. Review gating depends on mode; see Efficiency modes above.
- **Multi-turn context continuity** — follow-up messages carry real context. Prior conversation turns are compacted into a bounded history block (~6 k chars, most recent 12 turns) and replayed to the model, so it actually knows what was said earlier. Confidence envelopes are stripped before replay to save tokens.
- **Native session continuity** *(experimental, opt-in, default off)* — when enabled, a conversation that stays on Claude reuses Claude's *native* session (`--session-id`/`--resume`) instead of replaying that history block, for better fidelity and less re-sent context. Falls back to history replay automatically when a turn routes to a different provider. Because the live behavior depends on your CLI, it ships off with a gated verification test — `MYSHELL_NATIVE_SESSION_E2E=1 npm run test:integration` — and you enable it (Settings → Native sessions) only after it passes on your setup.
- **Container / SSH sign-in** — `myshell-tools login` auto-detects headless and cloud-IDE environments (Replit, Codespaces, Gitpod, SSH sessions) and switches to a no-localhost sign-in flow automatically. Force either flow with `--code` or `--browser`. For Claude, the tool prompts you to paste the `sk-ant-oat…` OAuth token printed by `claude setup-token`, stores it locally (mode 0600), and injects it at startup — no manual env-var wiring needed. For Codex, a device-code flow is used.
- **opencode provider (experimental)** — auto-detected; works instantly with free hosted models (no keys). `[o]` is always visible in the Auth section: it installs `opencode-ai` (with consent) if missing, then runs `opencode auth login`. Route to it explicitly or let the policy fall back to it automatically.
- **Routing prefers advertised models** — detection passes each provider's actual model list to `route()`, which picks the cheapest model the CLI *actually has*, not just the cheapest in the pricing table. Falls back gracefully if the advertised list doesn't match any pricing entry.
- **Subscription, not metering** — it drives the **Claude Code**, **Codex**, and **opencode** CLIs you already use. No API keys, no per‑token bill for the free path.
- **Honest by construction** — every number on screen traces to a real measurement. A suite of *architecture tests* makes fabricated/mock output literally unmergeable.

---

## Requirements

- **Node.js ≥ 20** for the compiled CLI (`dist/`). **Node ≥ 22** is required to run the test suite (see Development below).
- At least one provider CLI.  `npx myshell-tools` will **offer to install** them for you on first run — or you can install manually:
  - **Claude Code** — `npm install -g @anthropic-ai/claude-code`, then sign in when prompted. In containers or over SSH, run `myshell-tools login claude --code`: complete the link shown, then paste the `sk-ant-oat…` OAuth token when the tool prompts you. The token is stored in `~/.myshell-tools/credentials.json` (mode 0600) and injected automatically at startup — do **not** set it as `ANTHROPIC_API_KEY`.
  - **Codex** — `npm install -g @openai/codex`. In containers or over SSH, run `myshell-tools login codex --code` for a device-code flow (no localhost callback needed).
  - **opencode** *(experimental, optional)* — auto-detected when the `opencode` CLI is installed. Works immediately with free hosted models (no keys). `[o]` is **always available** in the control-panel Auth section: if opencode is not yet installed, selecting it asks for consent and runs `npm install -g opencode-ai`, then runs `opencode auth login` to add a premium provider or subscription — myshell-tools never handles the credentials. Appears in the control-panel header and raw-session picker only when installed.

You need **one** to start; install **both** claude and codex to unlock cross‑vendor review.

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

The globally-installed CLI includes the **update notifier**: it checks the npm registry once per 24 hours (cached, non-blocking) and shows a banner in the control panel when a newer version is available:

```
▲ Update available: 2.9.0 → 3.0.0  (press u)
```

Press `u` to install the update in-place (`npm install -g myshell-tools@latest`). No relaunch is forced — restart the CLI when you're ready.

You can also enable **auto-update** so the CLI updates and relaunches itself silently at startup.  Auto-update is **on by default** — the first-run prompt asks `Keep myshell-tools up to date automatically? (Y/n)` and defaults to yes.

To opt out:
- During first-run setup: answer `n` to the `Keep myshell-tools up to date automatically? (Y/n)` prompt.
- In the control panel: `[s] Settings → [3] Auto-update: on → off`.
- Or set `"autoUpdate": false` in `~/.myshell-tools/config.json`.
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
  (none)          Open the interactive control panel (default)
  run <task...>   Run a one-shot task and exit
  repl            Plain line REPL (no menu)
  login [prov]    Sign in to a provider (claude or codex) via its own OAuth
  cost            Show real spend + the cost-routing counterfactual

Options:
  -h, --help      Show help
  -v, --version   Print version
```

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

### Health — automatic, no command needed

The control panel checks its own environment on every launch (Node version, whether the state directory is writable, pricing freshness) and shows a short, actionable warning **only when something is actually wrong**. When everything is fine, it stays quiet — you never run a "doctor" command.

If you want the full report explicitly (handy for support threads or CI), it's still there as a hidden, scriptable command — `status`, `check`, or `doctor`:

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
Estimated cost  — API-equivalent, not your subscription bill
If billed as API: ~$0.0125 (provider-reported where available, else estimated from list prices)
```

The **efficiency ratio is honest under a subscription** (it compares flagship tokens you avoided, not dollars you were charged). The dollar line is explicitly labeled an *API-equivalent estimate* — not your actual bill — because you pay a flat subscription, not per token.

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
- Every run is recorded to an append‑only **session log** and **cost ledger** under `.myshell-tools/`.

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
```

---

## License

MIT — see [LICENSE](LICENSE).
