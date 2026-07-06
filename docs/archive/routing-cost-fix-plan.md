# Routing Cost Fix Plan

Save as `docs/routing-cost-fix-plan.md`.

## Goal

Fix the routing-cost leak diagnosed in `docs/routing-cost-diagnosis.md`: trivial one-shot prompts such as `run "Reply with exactly: SPINE_OK"` must not default to `ic`/Claude Sonnet.

Ship three default behavior changes in one PR:

1. Worker-tier provider order prefers `opencode` first.
2. Trivial exact-output prompts classify as `worker`.
3. One-shot `run` and plain REPL wire the same route/intent/auto-brain preflight machinery as the menu.

Keep unchanged:

- `ic` and `manager`/frontier provider order remain Claude-first.
- Auth fallback stays intact: if `opencode` is unavailable or unauthenticated, `route()` falls through to the next preferred provider.
- No pricing changes.
- No flag gate for these defaults, except existing menu gates reused for individual preflight components.

Rationale to record near the policy edit: this matches the owner’s standing policy, “prefer the OpenCode Go sub over Anthropic quota wherever possible.” `route()` walks policy order and returns the first authenticated+available preferred provider at `src/core/route.ts:458-470`, then falls back to first available at `src/core/route.ts:474-483`.

## File-By-File Changes

### `src/core/policy.ts`

Anchors:

- `DEFAULT_POLICY.providerOrderByTier` at `src/core/policy.ts:47-50`.
- `POLICY_PRESETS['cost-saver'].providerOrderByTier` at `src/core/policy.ts:391-394`.
- `POLICY_PRESETS['quality-first'].providerOrderByTier` at `src/core/policy.ts:420-423`.

Edits:

- Change only each `worker` row from:

```ts
worker: ['claude', 'codex', 'opencode', 'grok'],
```

to:

```ts
worker: ['opencode', 'claude', 'codex', 'grok'],
```

- Leave `ic` and `manager` rows exactly as:

```ts
ic: ['claude', 'codex', 'opencode', 'grok'],
manager: ['claude', 'codex', 'opencode', 'grok'],
```

- Update the stale comment at `src/core/policy.ts:42-46`; it currently says opencode is listed last globally. Replace with a scoped comment: worker prefers opencode to preserve Anthropic quota; higher tiers remain Claude-first; `route()` still respects authenticated-provider fallback.

### `src/core/classify.ts`

Anchors:

- Worker signal table begins at `src/core/classify.ts:95`.
- Default-to-IC branch is `src/core/classify.ts:359-367`.

Edit:

- Add a conservative worker signal for exact-output/reply-only prompts in `WORKER_SIGNALS`, before broad lookup signals.

Use an anchored matcher, not a broad substring. It must match short format-only prompts like:

- `Reply with exactly: SPINE_OK`
- `respond exactly "OK"`
- `say only hello`
- `answer with just "yes"`

It must not be the only reason real engineering work routes to worker. Keep the existing scoring/tie behavior: if a prompt also contains an IC signal such as `fix`, `implement`, `build`, or `refactor`, IC still wins on tie at `src/core/classify.ts:351-356`.

Recommended shape:

```ts
/^\s*(?:please\s+)?(?:reply|respond|say|answer)\s+(?:(?:with\s+)?(?:exactly|just|only)|(?:exactly|just|only)\s+(?:with\s+)?)\s*:?\s*(?:"[^"\r\n]{1,120}"|'[^'\r\n]{1,120}'|`[^`\r\n]{1,120}`|[A-Za-z0-9_ .,:;!?-]{1,80})\s*$/i,
```

If this proves too broad in tests, implement a tiny `isTrivialExactOutputPrompt()` helper and feed a sentinel match into `workerMatches`; do not route real tasks to worker just because they contain “answer exactly”.

### `src/interface/preflight-deps.ts` new file

Create a small shared helper so `menu`, `run`, and REPL do not duplicate route/intent/auto-brain construction.

Export:

```ts
export function buildPreflightDeps(input: ...): Pick<
  OrchestrateDeps,
  'routeClassifier' | 'intentExtractor' | 'autoBrainRungTuple'
>
```

Inputs must include:

- `providers`
- `policy`
- `cwd`
- `timeoutMs`
- `sandbox`
- `availableModels?`
- `authenticatedProviders?`
- `config`
- `env`
- `autoMode`
- `intentPass?: boolean`
- aux accounting fields: `accountAux?`, `ledger?`, `clock?`, `sessionId?`, `cacheAccountingV2?`
- `memoryBias?`

Use the exact menu gates and constants:

- Route classifier: `config.smartRoute !== false`; timeout cap `20_000`; current menu anchor `src/interface/menu.ts:2271-2295`.
- Intent extractor: `config.intentEngine !== false && intentPass !== false`; timeout cap `8_000`; current menu anchor `src/interface/menu.ts:2297-2332`.
- Auto brain: `experimentalEnabledByDefault(env, config, 'MYSHELL_AUTO_BRAIN', config.experimentalAutoBrain, autoBrainEnabled)`; current menu anchor `src/interface/menu.ts:2498-2525`.

Use existing constructors:

- `makeRouteClassifier` from `src/core/route-classifier.ts:53`.
- `makeIntentExtractor` from `src/core/intent-extractor.ts:67`.
- `fuseRung` from `src/core/auto-brain.ts`.

Pass `byproductFallbackEnabled(env, config)` into the intent extractor exactly like menu does at `src/interface/menu.ts:2319-2321`.

### `src/interface/menu.ts`

Anchors:

- Route classifier construction: `src/interface/menu.ts:2271-2295`.
- Intent extractor construction: `src/interface/menu.ts:2297-2332`.
- Auto brain IIFE: `src/interface/menu.ts:2498-2525`.
- Spreads into deps: `src/interface/menu.ts:2563-2564`.

Edit:

- Replace the inline route/intent/auto-brain construction with `buildPreflightDeps(...)`.
- Spread the helper result into the deps object.
- Pass `intentPass: shedPlan.intentPass`.
- Pass `memoryBias: taste?.memoryBias`.
- Preserve all existing account-aux/cache-accounting values and timeouts.
- Do not change unrelated menu fields, dynamic provider order, verify, trust, judgment, draft goals, or native sessions.

### `src/cli.ts`

Anchors:

- Imports around `src/cli.ts:63-90`.
- `buildDeps` returns `OrchestrateDeps` at `src/cli.ts:326-370`.
- One-shot `run` builds deps at `src/cli.ts:756-768`.
- Verify/trust layering starts at `src/cli.ts:779-811`.
- REPL `baseDeps` at `src/cli.ts:1040-1051`.
- REPL bespoke intent extractor at `src/cli.ts:1053-1092`.

Edits:

- Import `buildPreflightDeps`.
- After one-shot `const deps = buildDeps(...)`, create `const preflightDeps = buildPreflightDeps(...)` using the just-built `deps`.
- Build `const depsWithPreflight: OrchestrateDeps = { ...deps, ...preflightDeps }`.
- Apply verify/trust layering to `depsWithPreflight`, not `deps`.
- For one-shot run, use `autoMode: resolvedMode`, `intentPass: true`, and the same aux fields already present on `deps`.

REPL:

- Replace the bespoke `replIntentExtractor` block at `src/cli.ts:1053-1087` with `buildPreflightDeps(...)`.
- Keep REPL memory/tool-state behavior unchanged.
- Add `routeClassifier` and `autoBrainRungTuple` to REPL deps through the helper.
- Preserve the existing REPL intent capability if tests require it, but do not use it to suppress route classifier or auto brain.

## Test Reconciliation

Update expectations, do not delete or weaken tests.

### `test/unit/route.test.ts`

Expected breaking cases:

- `route — worker tier` case at `test/unit/route.test.ts:100-103` currently expects both available worker providers choose Claude. Rename to `both available → opencode first for worker tier` and assert provider `opencode` when pool includes `opencode`.
- Add a worker auth fallback case: with pool `['opencode', 'claude', 'codex']` and authenticated providers `['claude']`, assert provider `claude`.
- Existing IC cases at `test/unit/route.test.ts:54-58`, manager cases at `test/unit/route.test.ts:145-152`, and capability/search tests that explicitly assert Claude-first for `ic` must remain unchanged.
- Cases at `test/unit/route.test.ts:540` and `test/unit/route.test.ts:1107` are deep-equality neutrality checks; update only expected snapshots if they embed worker provider/model.

### `test/unit/policy-presets.test.ts`

Add semantic assertions:

- `DEFAULT_POLICY.providerOrderByTier.worker[0] === 'opencode'`.
- Every preset’s `worker[0] === 'opencode'`.
- Every preset’s `ic[0] === 'claude'`.
- Every preset’s `manager[0] === 'claude'`.

### `test/unit/classify.test.ts`

Add worker cases under `classify — worker tier comprehensive` at `test/unit/classify.test.ts:235`:

- `Reply with exactly: SPINE_OK` → tier `worker`, risk `low`.
- `respond exactly "OK"` → tier `worker`.
- `say only hello` → tier `worker`.
- `answer with just "yes"` → tier `worker`.

Add negative/tie cases:

- `implement the endpoint and reply exactly "done"` → `ic`.
- `fix the bug and respond exactly "fixed"` → `ic`.
- Keep existing default-IC test at `test/unit/classify.test.ts:842-847` for unrelated nonsense such as `frobnicate the wotsit`.

### Preflight Wiring Tests

Add `test/unit/preflight-deps.test.ts` for the new helper:

- Default config builds `routeClassifier`, `intentExtractor`, and `autoBrainRungTuple`.
- `smartRoute: false` omits only `routeClassifier`.
- `intentEngine: false` omits only `intentExtractor`.
- `experimentalAutoBrain: false` omits only `autoBrainRungTuple`.
- The helper’s route and intent classifier route worker-tier; with providers `{ opencode, claude }` and both authenticated, provider calls hit `opencode`.

Add or extend an orchestrate/intent-store test:

- With `intentStore` enabled and an `intentExtractor` returning `{ source: 'model' }` for a normal/substantial prompt, the stored intent version frame source is `model`, not `skipped`.
- This verifies the run/REPL wiring can provide the extractor that `orchestrate` consumes at `src/core/orchestrate.ts:397-452`.

## New Proof Tests Required

1. Worker tier prefers opencode when authenticated:
   - `route('worker', ['opencode', 'claude', 'codex'], DEFAULT_POLICY, undefined, ['opencode', 'claude'])` → `opencode`.

2. Worker tier falls through when opencode is not authenticated:
   - same pool, auth `['claude']` → `claude`.

3. IC and manager stay Claude-first:
   - `route('ic', ['opencode', 'claude'], DEFAULT_POLICY, undefined, ['opencode', 'claude'])` → `claude`.
   - manager-allowed policy equivalent → `claude`.

4. Exact-output prompt routes worker:
   - `classify('Reply with exactly: SPINE_OK').tier === 'worker'`.

5. Run/REPL brain deps are built:
   - Through the shared helper and `cli.ts` call sites, default config includes `routeClassifier`, `intentExtractor`, and `autoBrainRungTuple`.

## Verification Commands

Targeted first:

```sh
npm run typecheck
node --import tsx/esm --test test/unit/route.test.ts test/unit/policy-presets.test.ts test/unit/classify.test.ts test/unit/preflight-deps.test.ts
node --import tsx/esm --test test/unit/intent-orchestrate.test.ts test/unit/orchestrate-account-aux.test.ts
```

Full required suite:

```sh
find test/unit test/arch test/contract -name '*.test.ts' | sort | xargs node --import tsx/esm --test
```

Success criteria:

- `tsc --noEmit` clean.
- Targeted tests pass.
- Full-suite failure name-diff versus `main` shows zero new failing names. Do not compare raw counts; this repo has roughly 33 known pre-existing flaky/Windows failures.

## Ordered Checklist

1. Read `docs/routing-cost-diagnosis.md`.
2. Edit `src/core/policy.ts` worker rows only in `DEFAULT_POLICY`, `cost-saver`, and `quality-first`.
3. Update the policy comment so it no longer says opencode is globally last.
4. Add the exact-output worker classifier signal in `src/core/classify.ts`.
5. Extract menu route/intent/auto-brain construction into `src/interface/preflight-deps.ts`.
6. Replace menu inline construction with the shared helper.
7. Wire the helper into one-shot `run` in `src/cli.ts` before verify/trust/attachments are layered.
8. Wire the helper into plain REPL in `src/cli.ts`.
9. Update route/policy/classify tests to assert the new intended behavior.
10. Add preflight helper tests.
11. Add intent-store/orchestrate proof that a normal prompt gets source `model`, not `skipped`, when extractor is wired.
12. Run targeted tests.
13. Run `npm run typecheck`.
14. Run the full suite and compare failing test names against `main`.
15. Confirm no pricing, IC order, manager order, auth fallback, or unrelated refactor changed.

## Risks And Safe Defaults

- Do not let opencode-first leak into `ic` or `manager`; only worker rows change.
- Do not change `route()` fallback logic. The policy order change must rely on existing auth-aware selection.
- Do not broaden exact-output classification into real engineering work. IC signals must still win.
- Keep preflight construction fail-soft. If route/intent providers fail, `orchestrate` must fall back as it already does.
- Avoid changing menu dynamic capacity behavior unless a test proves it is required for this PR; the requested keystone is the policy worker row and run/REPL paths.