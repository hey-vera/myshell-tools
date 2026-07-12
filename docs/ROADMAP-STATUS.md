# ROADMAP-STATUS

Compact current-state record. The user-designated implementation authority is `CLAUDEPLAN.md`.

_Updated 2026-07-12. Baseline: `main@864806f`; active documentation slice: `actualize/claudeplan-r1`._

## Product truth

myshell-tools is a local, subscription-aware terminal partner that delegates through supported official provider CLIs. It owns provider-neutral conversation/work state, context curation, lane selection, orchestration, verification, and truthful recovery. It does not resell subscriptions, broker consumer OAuth tokens, or guarantee entitlement to models a provider CLI/account does not expose.

## Current evidence

- GitHub `main@864806f` is green.
- The previous `feature/two-dial-orchestration-profile` branch remains preserved at `97ade64` with 13 unmerged commits.
- The clean successor branch starts from `main` and carries the revised `CLAUDEPLAN.md`.
- Typecheck and build passed during the audit.
- The previous feature branch was not release-ready: lint had two unused imports, Knip had one unused export, no PR/branch CI existed, UI was omitted from required CI, and package proof was dry-run/Ubuntu-only.

## Active sequence

1. R-1: reconcile documentation authority and freeze truth.
2. R0: green baseline and deterministic provider harness.
3. R1-R2: atomic execution-lane inventory and safe same-chat adaptation.
4. R3-R4: safe account selection, provider-owned credentials, and state security.
5. R5-R7: context/quota/acceptance contract, unified lifecycle, durable truth, and stall recovery.
6. R8: prove or narrow the two-dial product claims.
7. R9: generated support matrix and real packed-artifact golden journeys.
8. Merge clean/green slices, verify `main`, make a separate bump PR, and stop for the user's manual npm publication.

## Non-negotiable gate

A helper, planner, mock-only test, receipt, or default-off flag is not shipped capability. Each headline behavior must trace through the installed entry point, production dependency composition, selected provider/account/model lane, durable state, and truthful UI/result.

Older roadmap, audit, plan, and receipt documents are historical evidence only unless `CLAUDEPLAN.md` explicitly adopts them.
