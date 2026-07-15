# R4.1 receipt: Official CLI auth default; legacy token opt-in only

## Behavior

Clean install / default detect and spawn paths **do not** inject
`CLAUDE_CODE_OAUTH_TOKEN` from `~/.myshell-tools/credentials.json`.

- Production path: `detect` / `buildClaudeEnv` → `claudeEnvWithStoredFallback` → spawn
- Default: `storedCredentialInjection` **off**
- Explicit opt-in: `MYSHELL_LEGACY_CLAUDE_TOKEN=1` (or `true`) restores injection
  and emits a one-shot stderr migration warning
- Account-scoped runs still force injection **off** (never shadow selected account)
- `clearClaudeToken` writes credentials.json with mode **0o600** (matches save)
- Dual-proof clear retained: clear legacy token only when Claude-owned OAuth
  credentials exist on disk, or `claude auth status` succeeds without a token
  (never delete the sole working credential without proof of official auth)

## Scope

- Branch: `actualize/r4-legacy-token-opt-in`
- Touched: `src/infra/credentials.ts`, `src/providers/detect.ts`,
  `src/providers/claude.ts`, `test/unit/credentials.test.ts`,
  `test/unit/detect-claude-credentials.test.ts`, this receipt
- Non-goals held: no full child env allowlist (R4.2), no Grok prompt scavenger (R4.3)

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/credentials.test.ts test/unit/detect-claude-credentials.test.ts` | 134 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
