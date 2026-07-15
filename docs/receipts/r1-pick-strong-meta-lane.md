# R1.2 receipt: remove dated `pickStrongMeta` bypass

## Behavior

Menu strong-meta / conscious orchestration no longer hard-codes dated model IDs
(`claude-opus-4-8`, `gpt-5.5`, `opencode-go/kimi-k2.7-code`). Selection goes
through `selectStrongMetaLane` (`src/core/strong-meta-lane.ts`), which:

- Forces **manager** tier with live `availableModels` / authenticated providers
- Uses **atomic** `selectExecutionLane` (R1.1) for provider + model + account
- Attaches managed-account `accountEnv` on the meta `ProviderRequest` when a
  lane account is selected; refuses ambient fallthrough when managed accounts
  exist but none are eligible
- Chooses high/max-style reasoning effort via `effortForDecision` against the
  capability registry (declarative floor when no live registry) — never a
  second dated model table

## Scope

- Branch: `actualize/r1-pick-strong-meta-lane`
- New: `src/core/strong-meta-lane.ts`, `test/unit/strong-meta-lane.test.ts`, this receipt
- Touched: `src/interface/menu.ts` (`pickStrongMeta` / `callStrongMeta`)
- Non-goals held: no R1.3 per-account inventory, no hedge/detached rewrites,
  no semver / credentials / CI matrix

## Production path

`pickStrongMeta` (menu) → `selectStrongMetaLane` → `selectExecutionLane` →
manager model from inventory + optional account → `callStrongMeta` spawns the
CLI with `reasoningEffort` (when supported) and `accountEnv` (when managed).
`refreshChatAccounts()` runs before meta lane select so managed inventory is
not silently unread.

## Command evidence (this slice)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npx vitest run test/unit/strong-meta-lane.test.ts` | 10 passed |
| menu strong-meta dated model return literals | none (`model: 'claude-opus-4-8'\|gpt-5.5\|kimi…` gone) |
| `npm run lint` | exit 0 (3 pre-existing no-console warnings in p0-pty-benchmark) |
| `npm run knip` | exit 0 |
| `git diff --check` | exit 0 |
