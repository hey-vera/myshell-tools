# myshell-tools

**Hierarchical, multi-provider AI orchestration for your shell — over the CLIs you already use.**

`myshell-tools` routes each task to the *cheapest* model likely to succeed, runs it on your real codebase, optionally has a **different vendor** review the result, and shows you exactly what it did and what it truly cost — with **no fabricated data, ever**.

> **Status: `2.7.1` — honest, tested, and real.** Claude, Codex, and opencode (experimental) all work, and provider auth is detected for real.

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

- **Cost‑aware routing** — trivial work goes to the cheap tier (Haiku / GPT‑5 mini), real implementation to the mid tier, hard calls to the flagship. You see the savings as a real number.
- **Efficiency modes** — three policy presets control the cost/quality trade-off:
  - `cost-saver` — routes to the cheapest capable model for each tier; only runs the cross-vendor review pass on *critical*-risk tasks (not every IC call). An optional `maxCostUsd` cap halts further escalation/review once spend reaches the limit.
  - `balanced` — the default; routes intelligently and reviews high-risk work.
  - `quality-first` — always reviews IC output for high/critical tasks, regardless of cost.
- **Cross‑vendor adversarial review** — a *different vendor* checks the first model's output (Codex reviewing Claude, or vice‑versa). Different families, different blind spots. Review gating depends on mode; see Efficiency modes above.
- **Multi-turn context continuity** — follow-up messages carry real context. Prior conversation turns are compacted into a bounded history block (~6 k chars, most recent 12 turns) and replayed to the model, so it actually knows what was said earlier. Confidence envelopes are stripped before replay to save tokens.
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
| Zero-install (recommended) | `npx myshell-tools` | Fetches, runs, and offers to set up providers on first run |
| Global install | `npm install -g myshell-tools` then `myshell-tools` | Faster on subsequent runs |
| From source | See below | For development |

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
  doctor          Check providers, auth, environment
  cost            Show real spend + the cost-routing counterfactual

Options:
  -h, --help      Show help
  -v, --version   Print version
```

### A real run

These are **actual, unedited** outputs (your costs/timings will differ):

```text
$ myshell-tools run "what is 2 plus 2"
Classified: worker tier, low risk — tier: worker keyword 'what is'; risk: defaulting to low
▶ WORKER (claude/claude-haiku-4-5) attempt 1
2 plus 2 equals 4.
✓ tier done — confidence: 100%, cost: $0.0124, duration: 5648ms
Success — tier: worker, cost: $0.0124, attempts: 1, session: 0dbfe2e3-…
```

The confidence (`100%`) is **parsed from the model's own structured reply**, not invented. The cost is the **CLI's own reported figure**, not an estimate.

### Health check

```text
$ myshell-tools doctor
Providers
  ✓ claude — installed, version: 2.1.157 (Claude Code)
    auth: signed in (pro)
  ✓ codex — installed, version: codex-cli 0.135.0
    auth: signed in
Ready — at least one provider is available.
```

### Cost & the routing counterfactual

```text
$ myshell-tools cost
Billed total: $0.0125 (as billed, incl. caching/discounts)
Total calls: 1
Per-model breakdown
  claude-haiku-4-5: 1 call, $0.0125
Counterfactual — list price, token-for-token
  Routed (models used): $0.0010
  Always-flagship:      $0.0063
  Routing saved you money: always-flagship would cost 6.3x more …
```

The counterfactual is **apples‑to‑apples** (both routed and flagship priced the same way), and the *billed* total is shown separately and labeled — no mixing of cache‑adjusted and list prices.

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
- **1000+ unit/architecture tests + 42 contract tests** (parsers pinned to *recorded real transcripts*), with `tsc --strict`, ESLint, and a clean `npm pack` checked in CI across Windows / macOS / Linux.

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

## Status & roadmap

Honest snapshot of `2.0.0-alpha.0`:

| Area | State |
| --- | --- |
| Core routing + escalation + cross‑vendor review loop | ✅ implemented & unit‑proven |
| Claude adapter | ✅ live, validated end‑to‑end on real models |
| Codex adapter | ✅ built; auto‑activates once `codex` is installed + authed |
| opencode adapter (experimental) | ✅ auto-detected; free models work without keys |
| Routing prefers advertised models (never routes to unavailable model) | ✅ |
| `doctor` / `cost` / REPL / streaming UI | ✅ |
| Live cross‑vendor demonstration | ⏳ pending Codex auth |
| Cross‑OS CI run | ⏳ pending a public remote |
| npm publish | ⏳ alpha |

---

## License

MIT — see [LICENSE](LICENSE).
