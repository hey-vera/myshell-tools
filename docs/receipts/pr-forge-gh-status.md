# Receipt — GitHub PR status via natural language when gh available (P1.6 thin)

**Branch:** `actualize/pr-forge-gh-status`  
**Base:** `origin/main`  
**Scope:** One high-value NL path for PR status when host is GitHub and `gh` is on PATH. No PR create/merge automation.

## Change

### Pure intent — `src/core/repo-intent.ts`
- New operation: `github_pr_status`.
- Patterns: `pr status`, `what's the PR status`, `github status`, `status of the pr`, `current pr`, etc.
- Matched **before** generic `status` so PR phrases never collapse to local `git status`.

### Command tier — `src/core/classify.ts`
- `gh pr status|list|view|checks` classified **read-only** (no confirm / no audit theater).

### Handler — `src/interface/repo-chat-handler.ts`
- On `github_pr_status`:
  1. Detect forge (`forgeContext` / `detectForge` / `detectWorkspaceContext`).
  2. **Not GitHub / no gh / local-only / other forge** → honest message, **no** `gh` spawn.
  3. GitHub + gh → gate `gh pr status` (when `commandGate` present) then run via injectable `runGh` (production: `execFile`).
  4. Failures (auth, exit non-zero, empty output) surface honestly; empty success hints `gh pr list --limit 5` without auto-running it.
- Menu wiring unchanged: existing `handleRepoChatIntent` divert already covers chat/menu NL.

## Tests
- `test/unit/repo-intent.test.ts` — PR-status phrases → `github_pr_status`; plain `status` still local.
- `test/unit/repo-chat-handler.test.ts` — GitHub+gh runs; missing gh; GitLab; local-only; gh failure; gate deny.
- `test/unit/command-gate.test.ts` — `gh pr status` → read-only.

## Verify

```text
npm run typecheck   # exit 0
npm run knip        # exit 0
npx vitest run test/unit/repo-intent.test.ts test/unit/repo-chat-handler.test.ts test/unit/command-gate.test.ts --reporter=dot
```

## Out of scope
- Full PR create / merge / review comments (rest of P1.6).
- GitLab `glab` MR depth (P1.7).
- Auto `gh pr list` fallback execution (message-only hint on empty status).

## Commit message
`feat: GitHub PR status via natural language when gh available`
