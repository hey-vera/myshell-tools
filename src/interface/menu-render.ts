/**
 * src/interface/menu-render.ts — Slice 1 home render skeleton (locked).
 *
 * Renders the locked home-menu skeleton from docs/menu-build-spec-final.md:
 *   1. Effort Mode rounded box (sectionBox, two sections + internal divider).
 *   2. One `Recent (<workspace label>):` list (no workspace location column yet —
 *      workspace-root resolution is a later slice; the label is just the current
 *      cwd basename, never fabricated).
 *   3. Small centered `Session Manager` titleBox (sized to text).
 *   4. Flat controls list, state-dependent (populated / empty signed in / empty
 *      not signed in).
 *   5. `Choice: ▌` prompt line.
 *   6. Root footer `ESC to exit`.
 *
 * The Effort Mode copy is rendered VERBATIM per the Slice 1 locked mockup. The
 * internal `mode`/`ConversationMode` rename and dynamic effort selection are
 * Slice 2 — Slice 1 ships the locked skeleton copy as-is.
 */

// See docs/menu-build-spec-final.md (locked slices + Slice 3 doctor de-advertise) + kern-spec.md

import type { AppConfig } from '../infra/config.js';
import type { ConversationMeta, ConversationMode } from '../infra/conversation-store.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { UpdateCheckResult } from '../infra/update-check.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import type { HealthIssue } from '../infra/health.js';
import { sectionBox, titleBox } from '../ui/tui.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import type { Goal } from '../core/goal-todo.js';
import {
  hasAnyAuthenticatedProvider,
  conversationModeLabel,
  type ProviderAccountSummary,
} from './menu-display.js';
import { workspaceLabel, normalizeWorkspacePath } from './workspace.js';

// ---------------------------------------------------------------------------
// Effort Mode box — locked Slice 1 copy (verbatim from the mockup).
// ---------------------------------------------------------------------------

/** Inner content width matching the locked mockup box (48 columns of text). */
const EFFORT_BOX_WIDTH = 48;

const EFFORT_SECTION_HEADER: readonly string[] = [
  'Effort Mode:  Auto (smart)',
  'Picks the right effort each turn from task,',
  'risk, and provider headroom.',
];

// `m = switch modes` (16) + 16 spaces + `Auto recommended` (16) = 48 columns,
// right-aligning `Auto recommended` near the box's right border.
const EFFORT_SECTION_FOOTER: readonly string[] = [
  'm = switch modes' + ' '.repeat(16) + 'Auto recommended',
];

// ---------------------------------------------------------------------------
// Pure helpers (Slice 1 scoped)
// ---------------------------------------------------------------------------

/**
 * Compact age label for the Recent rows — `just now` / `Nm` / `Nh`. Mirrors the
 * locked mockup's `12m` / `3h` / `40h` style (no ` ago` suffix). Pure.
 */
function compactAge(thenMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  return `${hours}h`;
}

/**
 * Recent-list render order: current-workspace rows first, then the rest,
 * preserving the store's pinned-then-recency order WITHIN each tier (stable
 * partition — `filter` preserves input order, and the input is already
 * pinned-then-recency-sorted by `ConversationStore.list()`). PURE.
 *
 * `currentWorkspaceRoot` is the resolved workspace root of the current launch
 * (git toplevel else cwd — Slice 7's `resolveWorkspaceRoot`). A row is
 * "current" when its own `workspaceRoot` normalizes (Slice 7's
 * `normalizeWorkspacePath`, case-insensitive on win32/darwin) to the same path
 * as the current root. Rows with a null/absent `workspaceRoot` (global/
 * unknown, e.g. a legacy conversation created before Slice 6) are NEVER
 * "current" — they sort into the non-current tier but render with NO location
 * prefix (there is no location to fabricate, per the no-fabricated-data rule).
 *
 * This single function is the ONE place the visible Recent-list order is
 * decided. BOTH the renderer (`renderRecentRows`) and the numeric-open
 * dispatcher in `menu.ts` (`[1]`-`[9]`) call it, so the rendered `[n]` index
 * and the conversation `[n]` opens always refer to the same row — the
 * "visible render order must match numeric dispatch order" invariant.
 */
export function orderRecentForRender(
  metas: readonly ConversationMeta[],
  currentWorkspaceRoot: string | null | undefined,
): ConversationMeta[] {
  if (metas.length === 0) return [];
  const normCurrent =
    typeof currentWorkspaceRoot === 'string' && currentWorkspaceRoot.length > 0
      ? normalizeWorkspacePath(currentWorkspaceRoot)
      : '';
  const isCurrent = (m: ConversationMeta): boolean => {
    if (normCurrent.length === 0) return false;
    if (typeof m.workspaceRoot !== 'string' || m.workspaceRoot.length === 0) return false;
    return normalizeWorkspacePath(m.workspaceRoot) === normCurrent;
  };
  const current = metas.filter(isCurrent);
  const other = metas.filter((m) => !isCurrent(m));
  return [...current, ...other];
}

/**
 * Build the Recent list body lines (one row per conversation). Row format:
 *   `[n] <age>  <title-column>  <provider> · <effort>`
 * Legacy / never-run conversations keep the effort-only fallback (`· <effort>`)
 * because provider labels are shown only when a real completed turn recorded
 * `lastProvider`; they are never inferred or fabricated.
 *
 * Slice 10 — workspace-aware rows. The list is ordered by
 * {@link orderRecentForRender} (current-workspace rows first). The title column
 * carries the location prefix for NON-current rows only, matching the locked
 * `Home - Populated` mockup's mixed rows:
 *   - current-workspace row:  `<title>`           (location is redundant — the
 *                                                header already names this workspace)
 *   - non-current row:         `<location> · <title>` (`<location>` = Slice 7's
 *                                                `workspaceLabel` of THAT row's own
 *                                                `workspaceRoot`, never the current one)
 *   - row with no/empty `workspaceRoot` (global/unknown): renders as `<title>`
 *     with no prefix — there is no location to fabricate. It still sorts into the
 *     non-current tier.
 */
function renderRecentRows(
  metas: readonly ConversationMeta[],
  nowMs: number,
  currentWorkspaceRoot: string | null | undefined,
): string[] {
  const ordered = orderRecentForRender(metas, currentWorkspaceRoot);
  const normCurrent =
    typeof currentWorkspaceRoot === 'string' && currentWorkspaceRoot.length > 0
      ? normalizeWorkspacePath(currentWorkspaceRoot)
      : '';
  return ordered.slice(0, 7).map((m, i) => {
    const thenMs = new Date(m.updatedAt).getTime();
    const age = compactAge(thenMs, nowMs);
    const idx = i + 1;
    const effort = conversationModeLabel(m.mode as ConversationMode | undefined);
    const providerEffort =
      m.lastProvider !== undefined
        ? `${m.lastProvider} · ${effort}`
        : `· ${effort}`;
    const isCurrent =
      normCurrent.length > 0 &&
      typeof m.workspaceRoot === 'string' &&
      m.workspaceRoot.length > 0 &&
      normalizeWorkspacePath(m.workspaceRoot) === normCurrent;
    const hasLocation =
      typeof m.workspaceRoot === 'string' && m.workspaceRoot.length > 0;
    const titleColumn = !isCurrent && hasLocation
      ? `${workspaceLabel(m.workspaceRoot as string)} · ${m.title}`
      : m.title;
    return `[${idx}] ${age}  ${titleColumn}  ${providerEffort}`;
  });
}

/**
 * Build the flat controls list for the current state. Locked Slice 1 controls:
 *   - populated (≥1 conversation):            [c]+subline, [1-9], [n], [e], [a], [q]
 *   - empty, signed in:                        [n], [e], [a], [q]
 *   - empty, not signed in:                    [a] Accounts / Sign in, [q]
 */
function renderControls(
  metas: readonly ConversationMeta[],
  nowMs: number,
  authed: boolean,
  currentWorkspaceRoot: string | null | undefined,
): string {
  const lines: string[] = [];
  const ordered = orderRecentForRender(metas, currentWorkspaceRoot);
  const hasConversations = ordered.length > 0;
  const accountsLabel = authed ? 'Accounts' : 'Accounts / Sign in';

  if (hasConversations) {
    const latest = ordered[0];
    if (latest !== undefined) {
      lines.push('[c] Continue last');
      const thenMs = new Date(latest.updatedAt).getTime();
      const age = compactAge(thenMs, nowMs);
      lines.push(
        latest.lastProvider !== undefined
          ? `    └─ ${latest.lastProvider} · ${latest.title} · ${age}`
          : `    └─ ${latest.title} · ${age}`,
      );
      lines.push('[1-9] Open numbered above');
    }
    lines.push('[n] New conversation');
    lines.push('[e] Library / all conversations');
    lines.push(`[a] ${accountsLabel}`);
    lines.push('[q] Quit');
  } else if (authed) {
    lines.push('[n] New conversation');
    lines.push('[e] Library / all conversations');
    lines.push(`[a] ${accountsLabel}`);
    lines.push('[q] Quit');
  } else {
    lines.push(`[a] ${accountsLabel}`);
    lines.push('[q] Quit');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderMainScreen
// ---------------------------------------------------------------------------

export async function renderMainScreen(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  metas: ConversationMeta[],
  _spend: SpendSummary,
  out: OutputSink,
  _updateInfo?: UpdateCheckResult,
  _claudeTokenInfo?: ClaudeTokenStatus | null,
  _runningUnderNpx = false,
  _healthIssues: readonly HealthIssue[] = [],
  _allGoals: readonly Goal[] = [],
  _accountStates?: Record<string, ProviderAccountSummary>,
  _spendLoading = false,
  listsLoading = false,
  currentWorkspaceRoot?: string,
): Promise<void> {
  out.write('\n');

  // 1. Effort Mode box (locked Slice 1 copy).
  const effortBox = sectionBox(
    [EFFORT_SECTION_HEADER.slice(), EFFORT_SECTION_FOOTER.slice()],
    { width: EFFORT_BOX_WIDTH, color: out.color },
  );
  out.write(effortBox + '\n\n');

  // 2. Recent (<current workspace label>): — one list, no workspace split.
  //
  // Slice 10 — the label comes from Slice 7's `workspaceLabel(currentRoot)`,
  // where `currentRoot` is the resolved workspace root (git toplevel else cwd)
  // supplied by `startMenu` (which resolves it once via `resolveWorkspaceRoot`).
  // When omitted (e.g. unit tests driving `renderMainScreen` directly), it
  // falls back to `ctx.cwd` — the cwd basename, matching the pre-Slice-10
  // behavior so locked-Slice-1 render assertions stay byte-identical.
  const authed = hasAnyAuthenticatedProvider(mutableCtx.env);
  const currentRoot = currentWorkspaceRoot ?? ctx.cwd;
  const label = workspaceLabel(currentRoot);
  out.write(`Recent (${label}):\n`);

  const nowMs = ctx.clock.now();
  if (listsLoading) {
    out.write('  loading…\n');
  } else if (metas.length === 0) {
    out.write(authed ? 'No conversations yet.\n' : 'Sign in to start conversations.\n');
  } else {
    const rows = renderRecentRows(metas, nowMs, currentRoot);
    for (const row of rows) out.write(`  ${row}\n`);
  }
  out.write('\n');

  // 3. Session Manager centered titleBox (sized to text).
  out.write(titleBox('Session Manager', { padding: 6, color: out.color }) + '\n\n');

  // 4. Flat controls (state-dependent). The [c] Continue-last sub-line names the
  // FIRST RENDERED row (current-workspace-first order), so it always matches
  // the `[1]` row above it — the locked mockup shows `[c]`'s sub-line equal to
  // row `[1]`, and the render/dispatch invariant says visible order == dispatch
  // order ([c] is the conceptual `[0]`).
  out.write(renderControls(metas, nowMs, authed, currentRoot) + '\n\n');

  // 5. Choice prompt. 6. Root footer (only `ESC to exit`).
  out.write('Choice: ▌\n');
  out.write('ESC to exit\n');
}
