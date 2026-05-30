# myshell-tools

**Hierarchical, multi-provider AI orchestration for your shell — over the CLIs you already use.**

`myshell-tools` routes each task to the *cheapest* model likely to succeed, runs it on your real codebase, optionally has a **different vendor** review the result, and shows you exactly what it did and what it truly cost — with **no fabricated data, ever**.

> **Status: `2.1.0` — honest, tested, and real.** Both the Claude and Codex paths work, and provider auth is detected for real. Install with `npm i -g myshell-tools`, or from source (below).

---

## Why it exists

Using one frontier model for everything is wasteful (renaming a variable doesn't need Opus) and single‑model output has blind spots. `myshell-tools` addresses both, honestly:

- **Cost‑aware routing** — trivial work goes to the cheap tier (Haiku / GPT‑5 mini), real implementation to the mid tier, hard calls to the flagship. You see the savings as a real number.
- **Cross‑vendor adversarial review** — for high‑risk work, a *different vendor* checks the first model's output (Codex reviewing Claude, or vice‑versa). Different families, different blind spots.
- **Subscription, not metering** — it drives the **Claude Code** and **Codex** CLIs you already pay for. No API keys, no per‑token bill.
- **Honest by construction** — every number on screen traces to a real measurement. A suite of *architecture tests* makes fabricated/mock output literally unmergeable.

---

## Requirements

- **Node.js ≥ 20** (the CLI itself; tests require Node ≥ 22).
- At least one provider CLI, installed and authenticated:
  - **Claude Code** — `npm install -g @anthropic-ai/claude-code` then `claude` (sign in).
  - **Codex** — `npm install -g @openai/codex` then `codex login`.

You need **one** to start; install **both** to unlock cross‑vendor review.

---

## Install (from source, during alpha)

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
- **513 unit/architecture tests + 42 contract tests** (parsers pinned to *recorded real transcripts*), with `tsc --strict`, ESLint, and a clean `npm pack` checked in CI across Windows / macOS / Linux.

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

```bash
npm run typecheck   # tsc --strict, 0 errors
npm run lint        # ESLint (typescript-eslint strict)
npm test            # unit + architecture tests
npm run test:contract  # parser contract tests vs recorded transcripts
npm run build       # → dist/
```

---

## Status & roadmap

Honest snapshot of `2.0.0-alpha.0`:

| Area | State |
| --- | --- |
| Core routing + escalation + cross‑vendor review loop | ✅ implemented & unit‑proven |
| Claude adapter | ✅ live, validated end‑to‑end on real models |
| Codex adapter | ✅ built; auto‑activates once `codex` is installed + authed |
| `doctor` / `cost` / REPL / streaming UI | ✅ |
| Live cross‑vendor demonstration | ⏳ pending Codex auth |
| Cross‑OS CI run | ⏳ pending a public remote |
| npm publish | ⏳ alpha |

---

## License

MIT — see [LICENSE](LICENSE).
