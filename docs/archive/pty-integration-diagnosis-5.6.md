# PTY Integration CI Diagnosis

Date: 2026-07-02

## Symptom

The CI `Test` job reaches `.github/workflows/ci.yml` step `Integration tests (real CLI, piped stdin)`, which runs `npm run test:integration` (`package.json` script: `vitest run test/integration`). The failures are in `test/integration/p0-pty-benchmark.test.ts`, specifically the real PTY benchmark cases that expect `scripts/pty-p0-benchmark.mjs` to exit `0`.

Observed CI evidence from run `28600948535`:

- `ubuntu-latest / node 22`: `p0-pty-benchmark.test.ts` ran 9 tests, 4 failed. The failed tests were the four `PTY benchmark -- real PTY run` tests. Each failed with `AssertionError: must exit 0, got 1 stderr:` and empty stderr.
- `ubuntu-latest / node 24`: three real PTY tests passed, and the fourth failed the same way after about 16.5 seconds.
- macOS had the same class of integration failure.
- Windows did not reliably reach integration in the same run because unit tests failed earlier; local Windows reproduction of the benchmark exits `1`/`2` through unsupported capability paths because `util-linux script` is absent.

The important timing detail is that failed real PTY cases take about 16-17 seconds. That matches `TIMEOUT_MS = 15000` in `scripts/pty-p0-benchmark.mjs`, plus startup/component overhead. It does not match the fast capability-unsupported branch or the component-load branch.

## What changed

The failing benchmark/test pair was introduced before/inside the #26 merge:

- `ffe2508 test(p0): deterministic component characterization suite [R6-P0-06b]` added `scripts/p0-component-benchmark.tsx`.
- `984cbc0 test(p0): real-PTY timing gate + aggregate bench:p0 receipt [R6-P0-06c]` added `scripts/pty-p0-benchmark.mjs`, `test/integration/p0-pty-benchmark.test.ts`, and `bench:p0`.
- `7eeef15 feat: land Control Panel + call-budget ledger + login/evidence refactors (10/10 push) (#26)` squashed those files onto main.

The #26 CI runs initially failed earlier at `knip`, so the PTY failure only became visible once later branches fixed the earlier gate enough for integration to run. This is still pre-existing relative to recent docs/feature changes: it was present in the benchmark as landed.

## Exact exit path

The Linux/macOS CI failure is not the capability-unsupported exit `2`, not the component-load exit `1`, and not the missing component branch. It is the PTY sample failure path:

```js
try {
  const { elapsedMs } = await runPtySample();
  if (!isWarmup) {
    rawMs.push(elapsedMs);
  }
} catch (err) {
  ptyStatus = 'failed';
  ptyDetail = err instanceof Error ? err.message : String(err);
  break;
}
...
if (ptyStatus !== 'pass') process.exit(1);
```

The specific thrown error is from the `Library` polling loop in `runPtySample()`:

```js
write('e');
...
if (screen.includes('Library')) {
  latencyEnd = process.hrtime.bigint();
  foundScreen = screen;
  break;
}
if (Date.now() - pollStart >= TIMEOUT_MS) {
  const err = new Error('Library heading never appeared in xterm buffer');
  const currentScreen = await getScreen();
  err.screen = currentScreen;
  throw err;
}
```

Reasoning:

- Unsupported capability exits `2` after writing JSON with `status: "unsupported"`. CI got `1`, and the forced unsupported tests passed on Linux, proving those branches work.
- The component-load and missing-component paths exit `1` before the PTY loop, would be fast, and would write stderr (`Failed to load component suite...` or `Missing component case...`). CI failures had empty stderr and took about one `TIMEOUT_MS`.
- The benchmark writes output JSON before the final `process.exit(1)` in the `ptyStatus !== 'pass'` path. If the tests read it before asserting the exit code, `json.status` would be `failed` and the `pty-root-to-library` case would have `status: "failed"` with detail `Library heading never appeared in xterm buffer`.

## Dependency/capability assessment

This is not a missing `@xterm/headless` dependency:

- `@xterm/headless` is already in `devDependencies`.
- `npm ci` runs before build/integration in CI.
- The forced missing-xterm unsupported test passes, so the guard is exercised.

This is not a missing Linux `script` dependency:

- The Linux/macOS failures are exit `1`, not exit `2`.
- If `script` were missing, the capability guard would write `status: "unsupported"` and `process.exit(2)`.
- Ubuntu/macOS reached the real PTY run, so the guard saw `script` as available.

There is a separate Windows/local issue:

- Windows lacks util-linux `script`, so the benchmark is unsupported there.
- Local Windows also exposes a path quirk: `new URL('../dist/cli.js', import.meta.url).pathname` can make `existsSync(CLI)` report the built CLI as missing on Windows. That is not the Linux CI branch, but the test's `CAPABILITIES_PRESENT` constant is also wrong because it only checks simulation env vars, not real capabilities.

## Root cause

The root cause is a benchmark harness readiness bug, not a proven product CLI regression.

The benchmark decides the root menu is ready when any reconstructed screen is stable twice and has at least three non-empty lines:

```js
const hadContent = screen.length > 0 && screen.split('\n').length >= 3;
if (lastScreen !== null && screen === lastScreen && hadContent) {
  stableCount += 1;
}
...
if (stableCount >= 2) {
  menuReady = true;
}
```

That is too weak for an Ink/PTY single-key timing benchmark. A visually stable screen is not the same as "the hidden Ink input consumer, raw mode, menu-capture FIFO, and `readKey()` resolver are ready to receive a single printable key."

The menu code itself routes single-key input only when the Ink bridge reports a pending menu read or active menu capture:

```ts
readPending={() => bridge._keyResolver != null || bridge._menuCaptureActive}
```

The benchmark cannot observe that internal condition. It writes `e` immediately after visual stability and starts a 15s poll for `Library`. In CI, especially Node 22 and sometimes Node 24, that key can land before the input side is actually key-ready or during an Ink repaint/raw-mode transition. The harness then waits the full `TIMEOUT_MS` and exits through the PTY failed branch.

This also explains the flake pattern:

- Ubuntu Node 24 passed three real PTY runs and failed one later run in the same test file.
- Ubuntu Node 22 failed all four in the sampled run.
- A deterministic missing dependency would not produce that pattern; it would fail the guard consistently with exit `2`.

The product CLI is still covered by `test/integration/menu-cli.test.ts` for piped stdin behavior, and those tests pass in the same integration step. That does not prove real PTY single-key behavior is perfect, but the current failure is not enough evidence to call a product regression because the benchmark does not reliably wait for key readiness and does not preserve the failure screen in the JSON detail.

## Fix plan

Smallest correct fix: fix the benchmark harness and the test capability gate. Do not install new npm packages or apt packages for Linux. Do not skip Linux/macOS real PTY tests unless the benchmark's actual capability guard reports unsupported.

1. Replace the weak root-menu readiness check in `scripts/pty-p0-benchmark.mjs`.

   Add helpers that wait for explicit root-menu markers, for example `[e] Library`, `[q] Quit`, and the final prompt. Do not treat arbitrary stable output as ready.

2. Add a non-measured readiness probe before starting the latency clock.

   After the root menu markers are visible, send a no-op key such as Enter (`'\r'`) and wait for the root menu to repaint/re-stabilize. This proves the Ink/readKey path can consume one key before the measured `e` write. Then start `latencyStart` and write `e`.

   This keeps the measurement meaningful: the measured action is still the single `e` key, not `e` plus Enter.

3. Preserve failure evidence in the benchmark JSON.

   `runPtySample()` already attaches `err.screen`, but `main()` currently keeps only `err.message`. Include a compact `screenTail` or append a sanitized last-screen summary to the PTY case detail. That makes future CI failures self-diagnosing instead of just `must exit 0, got 1 stderr:`.

4. Fix the integration test's real capability gating.

   Replace `CAPABILITIES_PRESENT`, which only checks `MYSHELL_BENCH_SIMULATE_*`, with a real local probe equivalent to the script guard:

   - built `dist/cli.js` exists after `npm run build`,
   - `@xterm/headless` resolves,
   - `script --version` succeeds or exits `1` on POSIX,
   - Windows is unsupported unless a real compatible `script` is present.

   Keep the forced unsupported tests; they verify the benchmark's JSON/exit-2 behavior. Gate only the real PTY tests with a skip reason when actual capabilities are absent.

5. Optional cleanup, not required for Linux CI: make `CLI` path portable by using `fileURLToPath(new URL('../dist/cli.js', import.meta.url))` instead of `.pathname`. This fixes the misleading local Windows "dist/cli.js not built" detail, but Windows still lacks `script`, so real PTY tests should remain skipped there.

## CI verification

This cannot be fully verified on Windows local because util-linux `script` is absent. Windows should verify only the unsupported branch and should skip real PTY cases with a clear reason.

A worker should verify in CI:

- `npm run build`
- `npm run test:integration`
- Matrix targets: `ubuntu-latest` and `macos-latest` on Node 22 and Node 24.
- Confirm the unsupported detection tests still pass.
- Confirm real PTY tests either pass on Linux/macOS or skip only when the script's actual capability probe says unsupported.
- If a real PTY test still fails, inspect the new JSON `pty-root-to-library.detail` / `screenTail`; do not force-green by broad skipping unless the detail proves CI lacks PTY capabilities.

## North-star check

Do not hide a real CLI regression. The correct line is:

- If Linux/macOS have `script`, built CLI, and `@xterm/headless`, the real PTY benchmark should run and fail on true inability to navigate to Library.
- If the environment lacks a required capability, the benchmark should emit `unsupported` JSON and the tests should skip the real PTY assertions with the same reason.
- The current failure should not be treated as unsupported; CI has the capabilities and reaches the PTY sample. The current problem is that the benchmark's readiness condition is weaker than the real input contract it is trying to measure.
