/**
 * src/interface/workspace-picker.ts — Slice 8 fuzzy workspace picker screen.
 *
 * The "Pick Workspace..." subflow reached from the New Conversation screen
 * (src/interface/menu-new-conversation.ts). Renders the locked "Pick Workspace"
 * title box + a numbered candidate list + a `Filter:` line, and lets the user
 * either pick a row by number / Enter, refine the filter by typing, or go back
 * to the New Conversation screen / exit the app via the shared menu-stack nav
 * (ESC exits, left pops one level — Slice 4, src/interface/menu-key-confirm.ts).
 *
 * Candidate ranking is Slice 7's {@link rankWorkspaceCandidates} (current root,
 * then prior conversation workspaceRoots by recency, then ancestor dirs, deduped)
 * — picked verbatim, not reimplemented. The filter is Slice 7's
 * {@link filterWorkspaceCandidates} (fuzzyRank over the normalized root path),
 * so all ranking/matching logic stays in exactly one place. The prior
 * workspaceRoots are sourced from `ctx.store.list()` and mapped into Slice 7's
 * minimal {@link PriorWorkspaceEntry} shape.
 *
 * Input model (Ink-vs-legacy): the repo has no pre-existing text-filter subflow
 * convention, and the shared `readMenuKey` classifier exposes only single
 * lowercased chars / nav sentinels / Enter — not multi-char strings or
 * backspace — so a true per-keystroke live Ink filter is not trivially
 * available at this call site (it would need Ink's chat InputBox, which is
 * owned by the chat loop). Per the slice contract's latitude ("do not block the
 * whole feature on live filtering if the Ink path is not trivially available"),
 * the picker uses ONE unified prompt that works identically on the Ink and
 * legacy/test paths: type a filter (any text) and re-render, type a digit 1-9 to
 * select that row, Enter to select the first visible match, ← to return to the
 * New Conversation screen, ESC to exit. Single-key selection (digit/Enter/nav)
 * is still instant on the Ink path because `inkReadKey` is threaded into
 * `readMenuKey`; only the filter text itself is line-buffered.
 */

import type { MenuContext } from './menu.js';
import type { OutputSink } from './render.js';
import { readMenuKey, NAV_ESC, NAV_LEFT, getMenuStack } from './menu-key-confirm.js';
import { titleBox } from '../ui/tui.js';
import {
  rankWorkspaceCandidates,
  filterWorkspaceCandidates,
  normalizeWorkspacePath,
  type PriorWorkspaceEntry,
} from './workspace.js';

/** The picker's per-row origin tag, shown after the label (matches the mockup). */
type WorkspaceTag = 'current' | 'recent' | 'parent';

/** What the picker hands back to the New Conversation screen. */
export type WorkspacePickerOutcome =
  | { readonly kind: 'select'; readonly root: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'exit' };

/**
 * Display width of the candidate `[n] <label>` column. The locked mockup
 * (`[1] myshell-tools       current`) right-aligns the tag at a 20-wide label
 * field, so a single trailing space separates the padded label from the tag.
 */
const LABEL_COLUMN_WIDTH = 20;

/**
 * Single-digit rows are the only ones reachable by a number key (the home menu
 * uses the same [1-9] convention). Candidates past this cap are still ranked
 * and filterable but not number-selectable; Enter selects the first visible
 * match regardless.
 */
const MAX_NUMBERED_ROWS = 9;

/**
 * Classify a ranked candidate's tag for display. The rank contract
 * (first occurrence wins after dedup) means each candidate is exactly one of:
 * the current root, a prior conversation root, or an ancestor directory — in
 * that priority order — so a plain membership check against the prior set
 * (after the current-root check) tags correctly even when a path is both a
 * prior workspace and an ancestor.
 */
function tagForCandidate(root: string, currentRoot: string, priorRoots: Set<string>): WorkspaceTag {
  if (root === currentRoot) return 'current';
  if (priorRoots.has(root)) return 'recent';
  return 'parent';
}

/**
 * Render the picker's numbered candidate rows (up to {@link MAX_NUMBERED_ROWS})
 * to `out`. Each row mirrors the locked mockup:
 *   `[n] <label padded to LABEL_COLUMN_WIDTH><tag>`
 *   `    <root>`
 */
function renderCandidateRows(
  candidates: readonly { readonly root: string; readonly label: string; readonly tag: WorkspaceTag }[],
  out: OutputSink,
): void {
  if (candidates.length === 0) {
    out.write('  (no matches — type a different filter)\n');
    return;
  }
  const shown = candidates.slice(0, MAX_NUMBERED_ROWS);
  for (const [i, c] of shown.entries()) {
    const idx = i + 1;
    const labelField = c.label.length >= LABEL_COLUMN_WIDTH ? c.label : c.label + ' '.repeat(LABEL_COLUMN_WIDTH - c.label.length);
    out.write(`[${idx}] ${labelField} ${c.tag}\n`);
    out.write(`    ${c.root}\n`);
  }
}

/**
 * The fuzzy workspace picker subflow.
 *
 * Pushes one menu-stack level on entry and pops exactly one level on every
 * return path, so the New Conversation screen's depth is preserved across a
 * back/exit. Reads prior workspaces from `ctx.store.list()` (the same list the
 * home Recent list uses) and maps each `ConversationMeta` into Slice 7's
 * `PriorWorkspaceEntry` shape — no store knowledge leaks into the picker beyond
 * that minimal projection.
 */
export async function runWorkspacePicker(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  inkReadKey: undefined | (() => Promise<string>),
  currentRoot: string,
): Promise<WorkspacePickerOutcome> {
  getMenuStack().push();

  try {
    // Prior workspaceRoots from the conversation store, projected into Slice 7's
    // minimal shape. `list()` is pinned-first then updatedAt-desc, but
    // rankWorkspaceCandidates re-sorts by updatedAt itself, so the input order
    // here does not affect ranking.
    const metas = await ctx.store.list();
    const prior: PriorWorkspaceEntry[] = metas.map((m) => ({
      workspaceRoot: m.workspaceRoot ?? null,
      updatedAt: m.updatedAt,
    }));
    const priorRoots = new Set(
      prior
        .map((p) => (typeof p.workspaceRoot === 'string' && p.workspaceRoot.length > 0 ? normalizeWorkspacePath(p.workspaceRoot) : ''))
        .filter((s) => s.length > 0),
    );

    // Rank once (current root → prior roots by recency → ancestor dirs, deduped).
    const ranked = rankWorkspaceCandidates(currentRoot, prior);
    // Attach the per-row origin tag (current/recent/parent). filterWorkspaceCandidates
    // returns plain WorkspaceCandidate[] (Slice 7 — read-only), dropping the tag, so
    // we keep a root→tagged-row index and re-attach the tag after filtering. Roots are
    // unique (rank dedupes), so the map is a faithful 1:1.
    const taggedByRoot = new Map(
      ranked.map((c) => [c.root, {
        root: c.root,
        label: c.label,
        tag: tagForCandidate(c.root, currentRoot, priorRoots),
      }] as const),
    );
    let query = '';

    // Single render+input loop. The same prompt serves filter-refinement and
    // row-selection: a non-empty, non-digit, non-nav input is treated as a new
    // filter query and the screen re-renders; a digit selects that row; Enter
    // selects the first visible match; ← back / ESC exit handle as usual.
    for (;;) {
      if (getMenuStack().exitRequested) return { kind: 'exit' };

      const filtered = filterWorkspaceCandidates(query, ranked)
        .map((c) => taggedByRoot.get(c.root))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);

      out.write('\n');
      out.write(titleBox('Pick Workspace', { padding: 6, color: out.color }) + '\n\n');
      out.write(`Filter: ${query}\n\n`);
      renderCandidateRows(filtered, out);
      out.write('\n← back · ESC to exit\n\n');
      out.write('> ');

      const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
      out.write('\n');

      // EOF / Ctrl-C → exit the app (mirrors the root null-handling).
      if (key === null) {
        getMenuStack().requestExit();
        return { kind: 'exit' };
      }
      if (key === NAV_ESC) {
        getMenuStack().requestExit();
        return { kind: 'exit' };
      }
      if (key === NAV_LEFT) {
        return { kind: 'back' };
      }
      // Enter → select the first visible match (no-op re-render when empty).
      if (key === '') {
        const first = filtered[0];
        if (first !== undefined) return { kind: 'select', root: first.root };
        continue;
      }
      // A single digit 1-9 selects that row directly (if it exists).
      if (key.length === 1 && key >= '1' && key <= '9') {
        const idx = parseInt(key, 10) - 1;
        const row = filtered[idx];
        if (row !== undefined) return { kind: 'select', root: row.root };
        // No row at that digit yet — fall through to treating it as a filter.
      }
      // A typed filter replaces the whole query in line-mode, but on the Ink
      // single-key path we accumulate printable chars so filtering still refines
      // immediately without relying on a multi-char text box here.
      query = inkReadKey !== undefined ? query + key : key;
    }
  } finally {
    getMenuStack().pop();
  }
}
