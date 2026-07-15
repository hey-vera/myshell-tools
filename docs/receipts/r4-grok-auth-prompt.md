# R4.3 receipt: Grok positive auth signature + safe prompt files

## Behavior

### Auth (`parseGrokAuth`)

`grok models` is treated as authenticated **only** when exit code is 0 **and** a
positive versioned signature is present:

- known logged-in banner: `You are logged in with grok.com` / `You are logged in`, or
- a non-empty `Available models:` list (via `parseGrokModels`)

Mere absence of `not authenticated` is **not** enough. Empty stdout, garbage text,
or only a `Default model:` line stay unauthenticated. Explicit
`not authenticated` short-circuits even if a models-looking fragment appears.
Plan remains always `null` (CLI text exposes no plan).

### Prompt files (`src/providers/grok.ts`)

- Create under `os.tmpdir()/grok-prompt-*/prompt.txt` via `mkdtemp` + exclusive
  open (`O_WRONLY|O_CREAT|O_EXCL`) with mode **0o600**
- Top-level **`finally`** always calls `removePromptFile` after a run
- Cheap once-per-process stale scavenge on `createGrokProvider`: remove
  `grok-prompt-*` dirs older than 1h under `os.tmpdir()`

## Scope

- Branch: `actualize/r4-grok-auth-prompt`
- Touched: `src/providers/detect.ts`, `src/providers/grok.ts`,
  `test/unit/auth-parse.test.ts`, `test/unit/grok-prompt-file.test.ts`, this receipt
- Non-goals held: no stdin prompt transport, no full child-env allowlist (R4.2)

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/auth-parse.test.ts test/unit/grok-prompt-file.test.ts` | 121 passed, 1 skipped (0o600 mode on win32), exit 0 |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
