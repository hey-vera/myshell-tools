# Receipt — Workspace forge context detector + partner vocabulary (P0.19–P0.20)

**Branch:** `actualize/pr-forge-context`  
**Base:** `origin/main`  
**Scope:** Pure forge/host detector + partner vocabulary + light chat surface. No gh PR automation.

## Change

### Pure core — `src/core/workspace-context.ts`
- Parse `git remote -v` → remotes; classify host: `github` | `gitlab` | `other` | `none`.
- Prefer `origin` (fetch) for primary remote.
- Partner vocabulary: PR/checks (GitHub), MR/pipelines (GitLab), host-native terms (other), local-only honesty (none).
- Formatters: `formatPartnerForgeBlock` (prompt), `formatForgeOrientationLine` (dim UI; null on GitHub default), `mergeEnvironmentWithForge`.

### Impure infra — `src/infra/workspace-context.ts`
- `detectWorkspaceContext(cwd, port?)`: git toplevel + remotes + `gh`/`glab` on PATH.
- Injectable `WorkspaceContextPort` for hermetic tests; production `nodeWorkspaceContextPort`.
- Fully fail-soft (missing git / probe errors → local-only / tools false).

### Surface
- **Chat/menu** (`menu.ts`): merge WORKSPACE FORGE into session ENVIRONMENT context once; dim orientation line on chat open when non-GitHub-default (GitLab / other / local-only). Fire-and-forget, fail-soft.
- **One-shot CLI** (`cli.ts`): same ENVIRONMENT merge for partner fluency outside TUI.

## Tests
- `test/unit/workspace-context.test.ts` — fixtures for github.com, gitlab.com, other, no-git; pure formatters; injected-port detector (31 tests).

## Verify

```text
npm run typecheck   # exit 0
npm run knip        # exit 0
npx vitest run test/unit/workspace-context.test.ts --reporter=dot
# Test Files  1 passed (1)
# Tests  31 passed (31)

npx vitest run test/unit --reporter=dot
# Test Files  268 passed | 1 skipped (270 files)
# Tests  7200 passed | 14 skipped (7215)
# 1 flake (unrelated): menu-flow "understanding failure in post-turn planning…"
#   — re-run alone: passed
```

## Out of scope
- Full `gh` PR create / status / checks automation (P1.6).
- Full GitLab `glab` MR/pipeline depth (P1.7).
- Other-forge API integrations (P1.8).

## Commit message
`feat: workspace forge context detector + partner vocabulary`
