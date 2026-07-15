# R2.2 receipt: native session lineage gate (A→B→A continuity)

## Behavior

Native provider sessions are only an execution cache. The visible myshell
conversation remains canonical.

- Pure helper `shouldResumeNativeLineage` resumes only on **consecutive
  compatible lineage**: same provider as the latest assistant-with-provider,
  same account when both known, exact model id when both known.
- **A→B→A**: `planNativeSession` withholds Claude (and any broken provider)
  resume so work-call replays portable history — intervening B context is not
  dropped by silently resuming A's server-side session.
- First-contact Claude establish (`resume: false`) only when no other provider
  has spoken yet; after a foreign provider, no Claude plan (history path).
- Codex resume uses a thread id captured **inside the trailing same-provider
  streak** (never an id from before a provider gap).
- **Defense-in-depth** in `work-call`: `filterNativePlanByLineage` re-checks
  `deps.history` before `useNative`; fail-open when history has no assistant
  providers (fixtures / one-shot). On withhold, emits a concise notice
  (`Native session withheld (…); replaying portable history`) and telemetry
  `fallbackReason: 'lineage-break'`.

## Non-goals held

- Full rich continuity bridge payload (objective/constraints dump)
- Mid-chat inventory refresh redesign
- Persisting `accountId` on `SessionEntry` (structural optional field on
  lineage entries when callers pass it)

## Production path

`planNativeSession` (`src/core/native-session.ts`) → menu `deps.nativeSession`
→ work-call `filterNativePlanByLineage` → `useNative` / history skip

## Scope

- Branch: `actualize/r2-native-lineage-gate`
- Core: `src/core/native-session.ts`, `src/core/work-call.ts` (minimal),
  `src/core/native-session-telemetry.ts` (`lineage-break` reason)
- Tests: `test/unit/native-session.test.ts`
- Receipt: this file

## Named tests

- A→A resume OK
- A→B→A no Claude resume (force history)
- account mismatch when both known → no resume
- model mismatch when both known → no resume
- filterNativePlanByLineage defense-in-depth + fail-open empty history

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/native-session.test.ts test/unit/ap2-hardening.test.ts test/unit/native-session-telemetry.test.ts` | 48 passed |
| `npx vitest run test/unit/orchestrate.test.ts -t nativeSession` | 4 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
