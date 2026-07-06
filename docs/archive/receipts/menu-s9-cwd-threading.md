# Slice 9 — CWD Threading Through Chat Execution receipt

**Date:** 2026-07-05
**Branch:** `slice-9-cwd-threading`
**Spec:** `docs/menu-build-spec-final.md` §"Slice 9 - CWD Threading Through Chat Execution"

## Summary

`runChatLoop` now derives `activeCwd = convMeta?.workspaceRoot ?? ctx.cwd` and
threads it through every conversation-scoped operation. Legacy conversations
without a `workspaceRoot` fall back to the launch `ctx.cwd` byte-identically.
App/global operations (menu nav, account menus, provider capability refresh)
stay on `ctx.cwd`. No helper was redesigned — every helper already took `cwd`
as an explicit parameter (Slices 5/7 and earlier); this slice is purely
call-site threading + one surgical `ctx` override handed to the auto-stage
engine.

## Files changed (exact set)

- `src/interface/menu.ts` — `activeCwd` definition + 32 conversation-scoped
  `ctx.cwd` → `activeCwd` call-site conversions inside `runChatLoop` (lines
  652–~6441), plus one `ctx: { ...ctx, cwd: activeCwd }` override on the
  `createAutoStageEngine` deps bundle (see Judgment calls). The only
  `ctx.cwd` left untouched *inside* `runChatLoop` is `createCapabilityRefreshPort`
  (provider-level capability/model-cache refresh — APP/GLOBAL, KEEP per spec).
  All other surviving `ctx.cwd` references are in `startMenu`/account menus
  (≥ line 6684) — app/global, KEEP.
- `test/unit/menu-flow.test.ts` — new `describe('Slice 9 — CWD threading…')`
  block with 5 tests (see Test coverage).

**Nothing outside the verified-necessary set was touched.** `src/interface/preflight-deps.ts`,
`src/core/types.ts`, `src/infra/{ledger,command-audit,evidence-sink,evidence-store,verify-port}.ts`,
and `src/interface/shell-passthrough.ts` were inspected and confirmed to already
accept `cwd` as an explicit parameter — no signature change was needed, so they
were NOT edited (the spec's "call sites only" carve-out). `src/interface/auto-stage.ts`
is outside the allowed file set and was NOT edited; its leak was fixed from
within `menu.ts` (see Judgment calls).

## Verification (real tails)

```
$ npm run typecheck
> tsc --noEmit
(no output — exit 0)
```

```
$ npm run lint
> eslint src test

C:\…\test\integration\p0-pty-benchmark.test.ts
  163:3  warning  Unexpected console statement  no-console
  165:3  warning  Unexpected console statement  no-console
  296:5  warning  Unexpected console statement  no-console

✖ 3 problems (0 errors, 3 warnings)
```
(0 errors. The 3 `no-console` warnings are pre-existing in `p0-pty-benchmark.test.ts`,
called out as known-fine in the task brief; this slice introduced none.)

```
$ npm test
> vitest run test/unit test/arch

 Test Files  258 passed | 1 skipped (259)
      Tests  8304 passed | 14 skipped (8318)
   Duration  141.07s
```
(Baseline before this slice on the same worktree: 8299 passed / 14 skipped — the
+5 are the new Slice 9 tests. Zero regressions.)

## Call sites threaded with `activeCwd` (completeness audit)

All 32 conversions are inside `runChatLoop` (line numbers are pre-edit anchors;
post-edit they shifted by +5 for the `activeCwd` block + a few for the auto-stage
comment, but the anchors are stable enough for review via `git diff`):

| # | Pre-edit line | Spec category | Snippet (~what changed) |
|---|---|---|---|
| 1 | 711 | command audit | `createCommandAuditRecorder({ cwd: activeCwd })` (conversation command-gate recorder IIFE) |
| 2 | 765 | recap brain spawn / repo-map | `makeRecapGenerator({ …, cwd: activeCwd, … })` |
| 3 | 818 | goals projectKey | `makeGoalObjectiveGenerator({ …, cwd: activeCwd, … })` |
| 4 | 870 | goals projectKey | `makeGoalPlanner({ …, cwd: activeCwd, … })` |
| 5 | 917 | goals projectKey | `makeGoalPlannerAttempt({ …, cwd: activeCwd, … })` |
| 6 | 975 | goals projectKey | `makeReplanner({ …, cwd: activeCwd, … })` |
| 7 | 1031 | repo-map / environment | `makeUnderstandingPass({ …, cwd: activeCwd, … })` |
| 8 | 1364 | evidence sink/store + ledger | `createIntentStore({ cwd: activeCwd })` |
| 9 | 1368 | ledger/cost for turns | `readLedger(activeCwd)` (session token seed) |
| 10 | 1827 | shell-passthrough execution cwd | `runShellPassthrough(command, activeCwd, out, …)` |
| 11 | 1939 | evidence sink/store | `join(resolveStateHome(env, activeCwd), '.myshell-tools', 'exports')` |
| 12 | 2381 | preflight deps | `buildPreflightDeps({ …, cwd: activeCwd, … })` |
| 13 | 2411 | orchestrate deps | `buildDeps` return `{ …, cwd: activeCwd, … }` |
| 14 | 2581 | evidence sink/store | `createEvidenceSink({ cwd: activeCwd })` |
| 15 | 2584 | evidence sink/store | `createEvidenceSnapshotBuilder({ cwd: activeCwd, now })` |
| 16 | 2769 | memory/taste/rules projectKey | `resolveProjectKeyOnce`: `resolveProjectKey(activeCwd)` |
| 17 | 2786 | repo-map / repo-identity cache key | `nodeRepoScanPort.readRepoFingerprint(activeCwd)` |
| 18 | 3117 | verify/test execution | `verifyStage({ …, cwd: activeCwd, … })` |
| 19 | 3288 | command audit / meta-decision spawn | meta-decision `ProviderRequest { …, cwd: activeCwd, … }` |
| 20 | 3460 | command audit / evidence sink | `decisionAuditPath = join(getStateDir(activeCwd), 'decisions.jsonl')` |
| 21 | 3508 | PLAN.md writes | `updatePlanMdAfterAdjust`: `join(activeCwd, 'PLAN.md')` |
| 22 | 3729 | verify/test execution | `verificationAvailableForCwd(activeCwd)` |
| 23 | 4013 | orchestrate deps / research spawn | web-search `ProviderRequest { …, cwd: activeCwd, … }` |
| 24 | 4109 | repo-map / environment | `buildEnvironmentContext(activeCwd, nodeRepoScanPort)` |
| 25 | 5050 | ledger/cost for turns | `readLedger(activeCwd)` (goal-run token baseline) |
| 26 | 5054 | ledger/cost for turns | `readLedger(activeCwd)` (live goal tokens) |
| 27 | 5242 | memory/taste/rules project scoping | `join(activeCwd, 'myshell-memory.md')` (`/memory export`) |
| 28 | 5282 | memory/taste/rules project scoping | `/taste`,`/prefs`: `resolveProjectKey(activeCwd)` |
| 29 | 5312 | goals projectKey | `/plan`: `resolveProjectKey(activeCwd)` |
| 30 | 5366 | PLAN.md writes | `/plan` proposal: `join(activeCwd, 'PLAN.md')` |
| 31 | 5577 | PLAN.md writes | goal proposal: `join(activeCwd, 'PLAN.md')` |
| 32 | 6048 | attachments resolution | `resolveImageAttachments(line, { cwd: activeCwd })` |

### Kept on `ctx.cwd` (APP/GLOBAL, by spec)

- `createCapabilityRefreshPort(process.env, ctx.cwd)` at pre-edit line **1107**
  inside `runChatLoop`'s `resolveCapabilitySummaryOnce` closure — provider/account-
  level model-cache + advertised-models refresh, stable per session, not
  file-system-scoped to the conversation workspace.
- Everything in `startMenu` / `computeProviderAccountStates` (pre-edit lines
  ≥ 6684): top-level menu nav ledger reads, account menus, login flows, cost
  recap, `runCost`. Not conversation-scoped.

## Test coverage added (`test/unit/menu-flow.test.ts`, `describe('Slice 9 — CWD threading through chat execution')`)

Drives the real `runChatLoop` with the existing in-memory harness (injected
`store`, `shellRunner`, scripted `readLine`, fake provider). Temp dirs + injected
ports only — no real global git state. Five tests:

1. **Legacy backward-compat (shell + command audit)** — a conversation with NO
   `workspaceRoot`, launched from `launchCwd`: `!rm -rf build` runs in
   `launchCwd`, and the command-audit event lands under `launchCwd`'s state dir
   with `event.cwd === launchCwd`. This is the most-important backward-compat
   guarantee called out by the spec.
2. **Workspace threads shell passthrough** — conversation WITH `workspaceRoot =
   workspaceCwd` (≠ `launchCwd`): `!echo hi` runs in `workspaceCwd`, NOT
   `launchCwd`. Proves `activeCwd → runShellPassthrough` (line 1827).
3. **Workspace threads command-audit recorder** — same shape, fallback gate,
   `!rm -rf build`: audit event lands under `workspaceCwd`'s state dir with
   `event.cwd === workspaceCwd`, and NO audit file is created under `launchCwd`.
   Proves `activeCwd → createCommandAuditRecorder` (line 711).
4. **Workspace threads orchestrate deps cwd → provider `req.cwd`** — a normal
   chat turn with a recording fake provider: every recorded `req.cwd ===
   workspaceCwd`. Proves `activeCwd → buildPreflightDeps` + `buildDeps` return
   (lines 2381 + 2411 → `orchestrate.ts:1190` `cwd: depsArg.cwd`).
5. **Legacy backward-compat for orchestrate deps** — same chat turn with a
   legacy meta (no `workspaceRoot`): every `req.cwd === launchCwd`.

Representative-seam rationale: every other conversation-scoped call site
(ledger read, evidence sink/store, verify, memory/taste/rules `resolveProjectKey`,
goals `resolveProjectKey`, PLAN.md writes, repo-map, attachments, recap/
understanding/goal-planner spawns) consumes the SAME `activeCwd` variable, so
proving the derivation + the three structurally distinct seams (shell cwd,
audit recorder cwd + state-dir location, orchestrate deps cwd) gives strong
end-to-end confidence the threading is correct, including the legacy fallback.

## Judgment calls / beyond the spec's file list

- **auto-stage `ctx.cwd` leak (found by grep, not in spec's file list).** The
  `verificationAvailableForCwd` inner closure (defined at pre-edit line 3187)
  takes `cwd` as a parameter and is passed BY REFERENCE into
  `createAutoStageEngine` (menu.ts ~4282) as part of the deps bundle.
  `src/interface/auto-stage.ts:396` calls
  `deps.verificationAvailableForCwd(deps.ctx.cwd)` — and `deps.ctx` is the
  `ctx` field of that bundle, which `runChatLoop` was passing unchanged (the
  launch `ctx.cwd`). auto-stage only runs during goal execution inside a
  conversation (conversation-scoped), so using the launch cwd for its
  verifiability probe is the exact leak this slice fixes. Because
  `auto-stage.ts` is **outside the allowed file set**, the fix was made from
  within `menu.ts`: the `ctx` passed to `createAutoStageEngine` is now
  `ctx: { ...ctx, cwd: activeCwd }`. auto-stage.ts reads `deps.ctx.cwd` only at
  line 396 (grep-verified), so overriding `cwd` on the shallow clone fixes
  exactly that probe and nothing else; all other `MenuContext` fields
  (`store`, `providers`, `sandbox`, `clock`, `timeoutMs`, …) are passed
  through intact to the engine. The forward-declared closures
  `resolveProjectKeyOnce`, `resolveRepoFingerprintOnce`,
  `verificationAvailableForCwd`, `buildGoalPlanner`, `buildGoalPlannerAttempt`,
  `buildUnderstandingPass`, `buildDeps`, `resolveEnvironmentOnce` passed into
  the engine were already converted to `activeCwd` internally, so the engine's
  use of them is automatically workspace-scoped.
- **No helper signatures changed.** `preflight-deps.ts`, `ledger.ts`,
  `command-audit.ts`, `evidence-sink.ts`, `evidence-store.ts`, `verify-port.ts`,
  and `shell-passthrough.ts` already accepted `cwd` as an explicit parameter —
  confirmed by grepping each export. The spec's "call sites only, not
  architecture" carve-out was the operative constraint; no architecture was
  rewritten.
- **`activeCwd` null/undefined semantics.** `ConversationMeta.workspaceRoot` is
  `string | null | undefined` (Slice 6). `convMeta?.workspaceRoot ?? ctx.cwd`
  means undefined OR null → `ctx.cwd`, exactly preserving the legacy fallback.
  Test 1 (+ test 5) prove this for both the shell/audit and orchestrate-deps
  paths.
- **Comment policy.** Two short comment blocks were added (the `activeCwd`
  derivation and the auto-stage `ctx` override) because the cross-file
  override in particular is a non-obvious judgment call a future maintainer
  could easily revert; documenting it inline prevents silent re-drift. The rest
  of the edits carry no new comments.

## FORBIDDEN-area compliance

- `src/infra/conversation-store.ts`, `src/infra/conversations.ts`,
  `src/interface/workspace.ts` (Slices 6/7) — read-only, NOT edited.
- Doctor/health, Effort Mode copy, home-menu render skeleton — NOT touched.
- ledger/evidence/verify/command-audit internals — NOT redesigned; only call
  sites in `menu.ts`.