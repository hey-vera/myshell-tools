# R4.2 receipt: minimal adapter child env allowlist

## Behavior

Provider CLI children **do not inherit full `process.env` by default**.

Production spawn env builders:

| Adapter | Builder |
| --- | --- |
| Claude | `buildClaudeEnv` → `resolveProviderParentEnv` then credential/replit helpers |
| Codex | `buildCodexEnv` |
| Grok | `buildGrokEnv` |
| OpenCode | `buildOpencodeEnv` |

Composition (later wins on key conflict):

1. **Allowlisted parent** — OS/runtime keys (`PATH`/`Path` case-insensitive, `HOME`/`USERPROFILE`, Windows system vars, locale, temp, proxy/TLS) + provider home keys (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `XDG_*`)
2. **Layers** — e.g. `replitPersistentEnv` additions
3. **`accountEnv` LAST** — subscription-scoped homes cannot be shadowed

**Stripped by default:** ambient pay-go keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, arbitrary secrets) so they cannot silently change subscription billing/auth mode.

**Escape hatch:** `MYSHELL_PROVIDER_FULL_ENV=1` (or `true`/`on`/`yes`) restores full parent inheritance and emits a **one-shot** stderr warning.

**Windows:** `Path` / `PATH` both preserved so child PATH is not broken.

## Scope

- Branch: `actualize/r4-child-env-allowlist`
- New: `src/providers/child-env.ts`, `test/unit/child-env.test.ts`, this receipt
- Wired: `src/providers/claude.ts`, `codex.ts`, `grok.ts`, `opencode.ts`
- Test update: `test/unit/opencode-account-routing.test.ts` (R4.2 strip FOO / API keys)

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/child-env.test.ts test/unit/opencode-account-routing.test.ts test/unit/claude-account-routing.test.ts` | 63 passed |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
