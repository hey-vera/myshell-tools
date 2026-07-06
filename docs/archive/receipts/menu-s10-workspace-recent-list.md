# Receipt — Slice 10: Workspace-Aware Recent List

**Branch:** `slice-10-workspace-recent-list`
**Spec:** `docs/menu-build-spec-final.md` → "Slice 10 - Workspace-Aware Recent List" + "Locked Mockups" → "Home - Populated".

## Files changed

- `src/interface/menu-render.ts` — new exported pure helper `orderRecentForRender()` (the single source of truth for the visible Recent-list order); `renderRecentRows` now consumes it and adds the `<location> · <title>` prefix on non-current rows; `renderControls` now shows the `[c] Continue last` sub-line for the FIRST RENDERED row (matches `[1]`); `renderMainScreen` gained a trailing optional `currentWorkspaceRoot?: string` parameter and now derives the `Recent (<label>):` header from Slice 7's `workspaceLabel(currentRoot)`. Removed the now-redundant local `workspaceLabel(cwd)` and the unused `basename` import.
- `src/interface/menu.ts` — import `orderRecentForRender` (from `./menu-render.js`) and `resolveWorkspaceRoot` (from `./workspace.js`); resolve `currentWorkspaceRoot` once before the first paint (fail-soft, via `ctx.repoScanPort ?? nodeRepoScanPort`); thread it into `renderMainScreen`; fix the `[1]`-`[9]` dispatcher to target `orderRecentForRender(metas, currentWorkspaceRoot)[digit - 1]`; fix the `[c]` dispatcher to target `orderRecentForRender(all, currentWorkspaceRoot)[0]`.
- `test/unit/menu-render.test.ts` — new `describe` block "Slice 10 workspace-aware Recent list": current-workspace rows sort first, non-current `<location> · <title>` prefix, current rows omit the redundant prefix, global/unknown rows render title-only in the non-current tier, `[c]` sub-line names the first rendered row. `render()` helper extended to forward `currentWorkspaceRoot` and the full positional arg list into `renderMainScreen`.
- `test/unit/menu-flow.test.ts` — new `describe` block: the **critical regression test** that pressing `1` opens the FIRST RENDERED row (an older current-workspace conversation) rather than the first raw store row (a newer non-current conversation), asserting which `SessionWriter` got the user task.

## Forbidden-file check

Only the four allowed files were modified. NOT touched (read-only / out of scope), confirmed by `git status --short`:

- `src/interface/workspace.ts` (Slice 7) — reused `workspaceLabel` + `normalizeWorkspacePath` + `resolveWorkspaceRoot` via import; not edited.
- `src/infra/conversation-store.ts` / `src/infra/conversations.ts` (Slice 6) — not edited.
- `src/interface/menu-new-conversation.ts` / `src/interface/workspace-picker.ts` (Slice 8) — not edited.
- `src/interface/menu-display.ts` — checked; it does NOT own the Recent-list build/sort (that lives in `menu-render.ts`), so no edit was needed.
- doctor/health files, Effort Mode copy — not touched.

## How the numeric-dispatch-vs-render-order invariant was fixed

**The problem.** The renderer (`menu-render.ts`) previously iterated `metas.slice(0, 7)` in raw store order, and the `[1]`-`[9]` dispatcher (`menu.ts`) resolved the target via `metas[digit - 1]` — also raw store order. Slice 10 reorders the *visible* list current-workspace-first, so raw store order (pinned-then-recency) and render order diverge whenever an older current-workspace conversation sorts above a newer non-current one. Without a fix, `[1]` would open the raw store-first row, not the row the user sees as `[1]`.

**The fix — one ordering function, two call sites.** A single pure helper, `orderRecentForRender(metas, currentWorkspaceRoot)`, is now the ONLY place the visible Recent-list order is decided. It performs a stable partition (current-workspace rows first, then the rest), preserving the store's pinned-then-recency order within each tier. Both consumers call it:

1. The renderer: `renderRecentRows` calls `orderRecentForRender(metas, currentRoot)` and slices to 7, so the rendered `[n]` index follows the reordered list.
2. The dispatcher: `menu.ts` `[1]`-`[9]` handler now does `const ordered = orderRecentForRender(metas, currentWorkspaceRoot); const target = ordered[digit - 1];` — the SAME function, the SAME root, so `[1]` opens exactly the row the renderer printed as `[1]`.

The same shared root (`currentWorkspaceRoot`, resolved once via Slice 7's `resolveWorkspaceRoot(ctx.cwd, ctx.repoScanPort ?? nodeRepoScanPort)`) is passed to both `renderMainScreen` and `orderRecentForRender` at the dispatch site, so renderer and dispatcher cannot disagree on what "current workspace" means.

**Bonus invariant — `[c] Continue last`.** The locked mockup shows the `[c]` sub-line equal to row `[1]`. Since `[c]` is the conceptual `[0]`, the `[c]` dispatcher and `renderControls`' sub-line were both repointed at `orderRecentForRender(...)[0]` so they keep matching the rendered `[1]` after the reorder. (Judgment call — see below.)

**Regression test.** `test/unit/menu-flow.test.ts` constructs a store whose `list()` returns `[newerOther, olderCurrent]` (newer first), with `olderCurrent` bound to the current workspace. Render order is `[1]=olderCurrent, [2]=newerOther`. The test presses `1`, sends a task, and asserts the opened `SessionWriter` is `older-current` (the rendered `[1]`), and that `newer-other` (the raw store-first) was never opened. This fails on the pre-Slice-10 `metas[digit - 1]` dispatcher and passes on the fixed one — a direct oracle on the invariant.

## Judgment calls

- **Single list, no split.** Per the task contract, the existing single Recent list (Slice 1) is kept; no `Recent in X` + `Other workspaces` split was introduced.
- **Current rows omit the location prefix; non-current rows always show it.** The locked `Home - Populated` mockup shows mixed rows: current rows have no prefix, the one non-current row shows `replit-tools · Port session`. The spec allows current rows to omit the prefix "if width allows"; the cleanest reading (and the one matching the locked sample byte-for-byte) is: current rows omit it (redundant with the header), non-current rows always carry it. No width measurement is performed — every non-current row gets the prefix unconditionally.
- **Global/unknown rows (no `workspaceRoot`) sort in the non-current tier but render with NO fabricated location prefix.** There is no location to show; fabricating one would violate the no-fabricated-data rule. Documented in `orderRecentForRender`'s and `renderRecentRows`' doc comments.
- **Stable partition preserves pinned-then-recency within each tier.** The spec says "current workspace sorts first; then recency (matches the existing Recent-list recency sort, just add the current-workspace-first tier ahead of it)." The existing recency sort already puts pinned first; the stable partition keeps that within each tier, so pinned current rows still beat unpinned current rows.
- **`[c] Continue last` was repointed to the rendered `[1]`.** The spec's critical-invariant text names only the `[1]`-`[9]` dispatcher, but the locked mockup shows `[c]`'s sub-line equal to row `[1]`. Leaving `[c]` on raw store order would make `[c]` identify a different conversation than the one rendered as `[1]` whenever the orders diverge — visibly confusing. Both the `[c]` dispatcher and the `renderControls` sub-line now use `orderRecentForRender(...)[0]`. This is an additive consistency fix within the slice's stated invariant; it does not change `[c]`'s semantics (still "continue the most-recent conversation") — only which conversation is "most-recent" under the new order.
- **`currentWorkspaceRoot` resolved synchronously before the first paint (both live-region and legacy paths).** Adds one fail-soft `gitToplevel` call to first-paint latency, but avoids a visible flicker of the `Recent (<label>):` header from cwd-basename to git-root basename on a later repaint. The resolved value is shared by renderer and dispatcher.
- **`renderMainScreen` parameter (trailing optional `currentWorkspaceRoot?: string`) rather than a new `MenuContext` field.** Tests that drive `renderMainScreen` directly (omitting the arg) fall back to `ctx.cwd`, so the pre-Slice-10 cwd-basename behavior — and every locked-Slice-1 render assertion — stays byte-identical. `startMenu` passes the resolved root explicitly.
- **No edit to `src/interface/menu-display.ts`.** The spec listed it conditionally ("if the Recent-list building/sort logic lives here"). It does not — the build/sort lives in `menu-render.ts`. Verified by reading `menu-display.ts`; only classification/header/budget/keypress helpers live there.

## Verification (exact commands + real tails)

```text
$ npm run typecheck
> myshell-tools@3.162.0 typecheck
> tsc --noEmit
(no output → clean)

$ npm run lint
> myshell-tools@3.162.0 lint
> eslint src test

C:\Users\Josh\Desktop\Github\Repositories\myshell-tools-slice10\test\integration\p0-pty-benchmark.test.ts
  163:3  warning  Unexpected console statement  no-console
  165:3  warning  Unexpected console statement  no-console
  296:5  warning  Unexpected console statement  no-console

✖ 3 problems (0 errors, 3 warnings)
```
The 3 warnings are the known pre-existing `no-console` warnings in `test/integration/p0-pty-benchmark.test.ts` called out in the task contract; 0 errors.

```text
$ npx vitest run test/unit test/arch
 RUN  v4.1.9 C:/Users/Josh/Desktop/Github/Repositories/myshell-tools-slice10

warning: in the working copy of 'package.json', LF will be replaced by CRLF the next time Git touches it
 ...
 Test Files  258 passed | 1 skipped (259)
      Tests  8339 passed | 14 skipped (8353)
   Start at  15:01:44
   Duration  138.84s (transform 14.74s, setup 2.60s, import 44.35s, tests 165.40s, environment 53ms)
```

Baseline before this slice was 8332 passing (Slice 8 merge). This slice adds 7 new tests (6 in `menu-render.test.ts` + 1 critical-regression test in `menu-flow.test.ts`): 8332 + 7 = 8339. No existing test regressed.