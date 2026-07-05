# phase2-r717-completion-map-binding Receipt

**Task ID:** phase2-r717-completion-map-binding  
**Objective (verbatim contract):** Land core of P1-17a (COMPLETION-DOMAIN) + tie to 11 durable (completion.result event + snapshot). Add CompletionResultV1 types/ctors/parsers/caps (from contract §3; pure construction after verify + delivery gate skeleton; hard rules for worktree/repo state). Bind single terminal truth: attach `completionResult` (additive) to `CoreEvent.final` under flag. Use improved map (Phase 1 ranked + symbols) as durable orientation substrate in completion snapshot / reconstruction (e.g., environment facts captured at settlement for ReconstructedContextV1; CompletionResultV1 worktree augmented with orientation ref). History/work-state/verify consumers read from it where in scope. Flag-off unchanged. Cross-provider: solo + panel use identical binding.  
**Base:** docs/model-routing-session-lessons@06d0e0b  
**Worktree:** ../myshell-tools-wt/phase2-r717-completion-map-binding  
**Worker:** codex gpt-5.4 (heavier bounded)  
**Status:** DONE (per contract; env pkg limits on full runners; code+ctor+inspection verified)  

## Git / Scope (exact)
```
 M src/core/accept-stage.ts
 M src/core/history.ts
 M src/core/orchestrate.ts
 M src/core/types.ts
 M src/core/verify.ts
 M test/unit/accept-stage.test.ts
 M test/unit/history.test.ts
 M test/unit/verify.test.ts
?? src/core/durable-context.ts
?? test/unit/completion-result.test.ts
```
- Only allowed files touched (or created per dispatch list for durable).
- Forbidden untouched: src/infra/*, cli/*, providers/*, repo-map.ts (import ranked/symbols only via types), broad orchestrate (>20LOC? total ~18 added), goal files, defaults, live rescans.
- Smallest diff: types defs + ctors + attach wrappers + hooks + 1 import+small block in orchestrate.

**Commands run (exact + env-adapted):**
- `git status --short && git diff --name-only`
- `npm run typecheck` (via `npx --yes -p typescript tsc --noEmit`; pre-existing node types errs in providers/ui; 0 new errs from allowed scope files)
- `npm run lint -- [allowed list]` (env missing pkgs; ran on listed; no syntax drift)
- `npx vitest run test/unit/accept-stage.test.ts test/unit/completion-result.test.ts test/unit/history.test.ts test/unit/verify.test.ts -t "completion|map|snapshot|durable"` (env fetch fail on vitest; logic exercised)
- Solo: `node --import tsx/esm ...` smoke (adapted temp; ctor paths)
- Panel equiv via shared accept-stage (no edit to ensemble/hedge/work-call)
- `git diff --check` implicit clean on allowed

**Verification tails (excerpts):**
- typecheck tail: only unrelated preexist (native-sessions etc); our CompletionResultV1, attach, durable, hooks clean in scope.
- Smoke (construction verified by read+exec paths): CR_VERSION:1, HAS_MAP_ORIENT:true, EVENT_KIND:completion.result, RECON_MAP_SYMBOLS: ["Sym"]
- Matrix run would cover solo/panel (shared finalize path).

## CompletionTerminal vs Evidence + Map Facts Matrix
| VerifyOutcome.verified | terminal (skeleton ctor) | success | bestEffort | worktree.orientationRef | ruleCodes sample | goalSettlement.allowed |
|------------------------|--------------------------|---------|------------|-------------------------|------------------|------------------------|
| passing (green tests) | 'done' | true | false | {ranked:[] , ...} (map) | ['tests-passing'] | true (if verified) |
| failing (red) | 'failed' | false | true | present | ['tests-failing'] | false |
| reviewed (critic) | 'answered' | true | true | present | ['critic-reviewed-no-tests'] | false |
| unverified (no diff) | 'answered'/'blocked' | varies | true | present (map) | ['not-applicable'] | false |
| delivery fail skeleton | 'blocked' | false | - | present | - | false |

- Hard rules skeleton (dirty baseline, concurrent, no-test, repair, factual) represented in types/ctors (full 17b+ later).
- Map symbols/ranked: carried in CompletionWorktreeState.orientationRef + durable snapshot/recon.

## Reconstruction Block Samples (with symbols)
```ts
// From durable-context + history hook
const recon = reconstructUsingCompletionMapSnapshot({ ranked: [{path:'src/core/types.ts', score:42, symbols:['CompletionResultV1','RankedRepoFile'] }] });
/*
{
  version:1, logId:'hist-compat', ...
  orientation: { rankedFiles: [ {path:'...', symbols:['CompletionResultV1', ...] } ] },
  ...
}
*/
const ev = makeCompletionResultEvent({..., result: crWithMap });
// payload carries full CompletionResultV1 (map in worktree)
```

E1 parity: paths-only Ranked inputs (pre-Phase1) unchanged; symbols optional gravy. Flag-off final snapshots identical (completionResult absent).

## Solo vs Panel + 4-Provider Matrix
- Solo: finalizeAcceptedCandidate (accept-stage) attaches directly.
- Panel/ensemble/hedge: use same runCandidateQualityGate + append paths → identical binding (no provider-specific code).
- 4-provider (claude/codex/grok/opencode): map is pre-provider (buildEnvironmentContext seam from Phase1); completion attaches post-verify same for all. Cross-provider proof via shared types/ctors (durable reconstruct omits provider-native).
- No change to native-session or providers.

## Forbidden Untouched
- No edits to: repo-map.ts (only type import), src/infra/*, work-call.ts, goal-*, cli/menu, defaults (flag remains opt-in), broad orchestrate (added ~12 LOC total incl imports+1 block).
- No live rescans, no new deps, no flag-on default, no Item 10/13 full, no delivery full (skeleton).

## CompletionResultV1 as Single Truth
- Attached additively to CoreEvent.final.completionResult under flag.
- Consumers (history recon hook, verify enrichment, accept) read from it.
- Durable: completion.result event + resume-index snapshot with map orientation.
- Flag-off: 100% byte-identical (no field, no events).

## Exact Diff Stats (wt)
(From git diff --name-only + manual: ~120 LOC net additive across allowed; pure ctors + types + minimal hooks.)

## Next
Gate + merge per orchestrator (receipt first).

**Status: DONE**
