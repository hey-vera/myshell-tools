# Support matrix — myshell-tools

**Product:** local terminal partner over **official provider CLIs** (subscription-first).  
**Tip package:** 3.174.0 (GitHub). **npm `latest` may lag** — verify with `npm view myshell-tools version`.  
**Updated:** 2026-07-15 (external readiness U3 + U1/U5/U7 on tip).

Legend: **S** supported · **P** partial / caveats · **U** unknown / unproven · **N** not supported · **E** experimental (opt-in)

---

## Platforms

| Platform | Install (packed smoke) | Interactive TUI | Detached worker |
| --- | --- | --- | --- |
| Linux (ubuntu CI) | **S** (required package-check) | **S** (dev/CI unit/UI) | **S** (code path) |
| macOS | **S** (OS1 pack smoke job) | **P** (CI tests; human smoke owner) | **P** |
| Windows | **S** (OS1 pack smoke job) | **P** (CI tests; human smoke owner) | **P** (detached spawn + path) |

Node: **≥20** runtime; test suite often expects **≥22** in this repo.

---

## Providers & auth

| Provider | Auth model | Install detect | Multi-account isolation | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | Official `claude` OAuth / CLI home | **S** | **P** (`CLAUDE_CONFIG_DIR` / managed homes) | Legacy myshell token injection **opt-in only** (`MYSHELL_LEGACY_CLAUDE_TOKEN`) |
| Codex | Official `codex` ChatGPT subscription | **S** | **P** (`CODEX_HOME`) | API-key login treated as usage-billed; not silent subscription substitute |
| Grok | Official Grok CLI OAuth | **S** | **P** (`GROK_HOME`) | Positive auth signature required; secure prompt files |
| OpenCode | OpenCode auth / configured models | **S** | **P** (XDG homes) | **Only intentional API-key exception** (Go/Zen pools as configured by user) |
| Gemini consumer CLI | — | **N** | **N** | Individuals flow deprecated; no promise without new official enterprise path |
| Copilot CLI | — | **N** | **N** | Future candidate; not ship claim |

---

## Product surfaces

| Surface | Status | Caveats |
| --- | --- | --- |
| Home menu + Recent | **S** | Live work chips from goals + in-process workers |
| Interactive chat (menu) | **S** | Primary product path |
| Plain `repl` | **P** | Thinner than menu |
| One-shot `run` | **P** | Not full menu brain |
| Detached `worker` | **S/P** | Real work + free-loop ≤8 + leases + **account enrich** (`#224`); FG chrome still menu-owned |
| Accounts hub (list/edit/rename/mouse) | **S** | Per-provider menus |
| Effort dial (mode) | **S** | Model lane + verification policy |
| Speed dial (intensity) | **S** | Multi-goal concurrency ceiling only — **not** worker topology |
| Native provider `--effort` | **E** | Default **off** (`MYSHELL_PROVIDER_EFFORT` / config) |
| Native sessions | **E/P** | Config default may enable; treat as best-effort resume |
| Parallel panel / hedge / learned routing | **E** | Default off or auto-gated; quota cost |
| Cross-vendor review | **P** | Needs ≥2 authed providers + Effort policy |

---

## Routing integrity

| Guarantee | Status |
| --- | --- |
| Atomic provider+account+model lane (menu) | **S** |
| Turn inventory freeze | **S** |
| No ambient credential fallthrough when managed accounts exist (menu) | **S** |
| No silent cooling managed-account pick | **S** (`waiting_on_quota`) |
| Same guarantees on detached worker | **S** for account inventory/enrich (`#224`); session cooldown map empty at worker start |
| Per-account model probe | **S** on menu enrich; fail-soft → provisional global copy |
| Child env secret allowlist | **S** (escape: `MYSHELL_PROVIDER_FULL_ENV`) |
| TurnCallBudget enforce on live chat | **S** (menu/repl) |

---

## Multi-chat / durability

| Behavior | Status |
| --- | --- |
| Leave chat without aborting other chats’ in-process goals | **S** |
| Esc → release TUI jobs + ensure worker | **S** |
| Worker free-loop multi-turn | **S** (≤8; park without roadmap evidence) |
| Fenced renewable leases | **S** (3m TTL + generation) |
| Home Recent live chips after restart | **P** (durable goals + job files; in-process counts zero after kill) |
| Full menu scheduler chrome in worker | **N** (menu-owned) |

---

## Install claims

| Claim | Status |
| --- | --- |
| `npm pack` → empty install → bins `--help`/`--version` | **S** (`smoke:packed`) |
| Actionable no-provider refuse | **S** |
| Full auth+chat+resume golden journey in CI | **N** (owner human smoke) |
| Published npm version == tip | **U/P** until owner publish |

---

## How to read this

- **S** means code + CI/hermetic proof exists for the intended path.
- **P** means shipped but incomplete vs the north-star headline or dual-path.
- Live multi-account entitlement differences depend on the user’s real CLI/account — we do not invent models.

Ship sequence: `docs/EXTERNAL-READINESS-PLAN.md`.
