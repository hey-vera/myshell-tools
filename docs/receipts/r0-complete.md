# R0 complete — green baseline and deterministic harness

Date: 2026-07-14  
Baseline tip at close: `main@e52e1cd`  
Authority: `CLAUDEPLAN.md` (unchanged; remains active)  
Status docs: `docs/ROADMAP-STATUS.md` advanced to R1 as next active slice

## Scope of this receipt

Documentation-only closeout. No `src/`, `test/`, or package version change. Summarizes merged R-1 + R0 evidence against CLAUDEPLAN Done criteria and records honest deferrals.

## R-1 (prerequisite) — Done

| Claim | Evidence |
| --- | --- |
| One active plan + compact roadmap; no source-of-truth conflict | PR `#177`; receipt `docs/receipts/r-minus-1-authority-reconciliation.md` |

## R0 Done criteria (CLAUDEPLAN) vs evidence

CLAUDEPLAN R0 asked for: lint/knip fixed; suite segmentation/durations/hangs addressed; one cross-platform `quality` command (typecheck, lint, knip, build, unit, architecture, UI, contract, deterministic integration); `prepublishOnly` on that gate; fake versioned provider CLIs covering JSON/JSONL, stderr, exit codes, auth, catalog drift, timeout, cancel, partial output, tool events, session IDs without live quota; Node `>=20` aligned with CI on 20/22/24 (or engine raise); live canaries optional; deterministic contracts every PR.

| Area | Status | PR / receipt evidence |
| --- | --- | --- |
| Deterministic `quality` + `prepublishOnly` | **Met** | `#178` — `docs/receipts/r0-quality-command.md` |
| Fake Codex / OpenCode + fixture/timeout matrix slices | **Met** (core adapter paths) | `#179`–`#184` — `r0-fake-codex-adapter.md`, `r0-fake-opencode-json.md`, `r0-fake-timeout-contract.md`, `r0-provider-fixture-matrix.md`, related |
| Fake Claude harness through built adapter | **Met** | `#186` — `r0-fake-claude-adapter.md` |
| Fake Grok harness through built adapter | **Met** | `#187` — `r0-fake-grok-adapter.md` |
| Node 20/22/24 CI matrix (engines alignment) | **Met** | `#185` — `r0-node20-ci.md`; tip `ci.yml` `node: [20, 22, 24]` |
| UI in required CI | **Met** | `#188` — `r0-ci-ui-tests.md`; flake harden `#189` on tip `e52e1cd` |
| Lint/knip baseline green | **Met** as part of quality/CI merge train | Via `#178`+ subsequent green mains |
| Live-account canaries optional | **Held** | Native/live e2e remain opt-in; deterministic fakes on PR |

### Four-provider fake harness (summary)

Main carries deterministic fake CLIs exercised through built adapters for:

1. **Codex**
2. **OpenCode**
3. **Claude**
4. **Grok**

These cover the R0 intent of PR-safe adapter contracts without live quota. Scenario depth varies by provider; see per-provider receipts.

## Honest deferrals / out of R0

These were in the R0 wish-list wording or adjacent product space but are **not** claimed complete by this closeout:

1. **Catalog-drift as a first-class scenario** — only **partial** coverage via protocol/error fixtures; not a dedicated product-level catalog-drift journey with inventory generation semantics (that work lands with R1+ inventory truth).
2. **Suite duration segmentation** — `npm run quality` remains a **full sequential** gate. Explicit long-suite segmentation, duration budgets, and hang/open-handle accounting as a separate ops claim are not closed.
3. **Packed-tarball / installed golden journey** — **R9**, not R0. Quality green is not packed-artifact proof.

## What “R0 done” means (and does not)

**Means:** deterministic local/CI baseline is real enough to build R1 on: quality command, multi-Node CI, UI required, four-provider fake harness, authority docs settled.

**Does not mean:** multi-account isolation, atomic lane inventory, same-chat hot adaptation, credential/state security, lifecycle/stall recovery, two-dial product proof, support matrix publication, or registry install journeys. Those remain R1–R9.

## Active next

**R1 — Runtime lane inventory and adapter contract** (then R2 same-chat adaptation), per `CLAUDEPLAN.md`.

## Rollback

This closeout is docs-only. Revert the roadmap/receipt commit to restore prior status wording; runtime remains whatever `main` already shipped via `#177`–`#189`.
