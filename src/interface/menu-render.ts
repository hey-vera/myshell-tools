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

import { basename } from 'node:path';

import type { AppConfig } from '../infra/config.js';
import type { ConversationMeta, ConversationMode } from '../infra/conversation-store.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { UpdateCheckResult } from '../infra/update-check.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import { sectionBox, titleBox } from '../ui/tui.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import type { Goal } from '../core/goal-todo.js';
import {
  hasAnyAuthenticatedProvider,
  conversationModeLabel,
  type ProviderAccountSummary,
} from './menu-display.js';

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
 * Workspace label for the `Recent (<label>):` header. Slice 1 uses the current
 * cwd basename — a real, non-fabricated value. True workspace-root resolution
 * (git root else cwd) and workspace-labelled rows are later slices.
 */
function workspaceLabel(cwd: string): string {
  if (!cwd || cwd.length === 0) return 'workspace';
  const base = basename(cwd);
  return base.length > 0 ? base : cwd;
}

/**
 * Build the Recent list body lines (one row per conversation). Row format:
 *   `[n] <age>  <title>  · <effort>`
 * The locked `engine · effort` column is reduced to `· effort` for Slice 1
 * because ConversationMeta carries no provider/engine field and fabricating one
 * would violate the "no fabricated data" rule. The location column is omitted
 * for the same reason (workspace-root resolution is a later slice).
 */
function renderRecentRows(
  metas: readonly ConversationMeta[],
  nowMs: number,
): string[] {
  return metas.slice(0, 7).map((m, i) => {
    const thenMs = new Date(m.updatedAt).getTime();
    const age = compactAge(thenMs, nowMs);
    const idx = i + 1;
    const effort = conversationModeLabel(m.mode as ConversationMode | undefined);
    return `[${idx}] ${age}  ${m.title}  · ${effort}`;
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
): string {
  const lines: string[] = [];
  const hasConversations = metas.length > 0;
  const accountsLabel = authed ? 'Accounts' : 'Accounts / Sign in';

  if (hasConversations) {
    const latest = metas[0];
    if (latest !== undefined) {
      lines.push('[c] Continue last');
      // Sub-line: locked `└─ engine · title · age`; engine column omitted for
      // Slice 1 (no provider data on ConversationMeta — judgment call).
      const thenMs = new Date(latest.updatedAt).getTime();
      lines.push(`    └─ ${latest.title} · ${compactAge(thenMs, nowMs)}`);
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
  _allGoals: readonly Goal[] = [],
  _accountStates?: Record<string, ProviderAccountSummary>,
  _spendLoading = false,
  listsLoading = false,
): Promise<void> {
  out.write('\n');

  // 1. Effort Mode box (locked Slice 1 copy).
  const effortBox = sectionBox(
    [EFFORT_SECTION_HEADER.slice(), EFFORT_SECTION_FOOTER.slice()],
    { width: EFFORT_BOX_WIDTH, color: out.color },
  );
  out.write(effortBox + '\n\n');

  // 2. Recent (<workspace label>): — one list, no workspace split.
  const authed = hasAnyAuthenticatedProvider(mutableCtx.env);
  const label = workspaceLabel(ctx.cwd);
  out.write(`Recent (${label}):\n`);

  const nowMs = ctx.clock.now();
  if (listsLoading) {
    out.write('  loading…\n');
  } else if (metas.length === 0) {
    out.write(authed ? 'No conversations yet.\n' : 'Sign in to start conversations.\n');
  } else {
    const rows = renderRecentRows(metas, nowMs);
    for (const row of rows) out.write(`  ${row}\n`);
  }
  out.write('\n');

  // 3. Session Manager centered titleBox (sized to text).
  out.write(titleBox('Session Manager', { padding: 6, color: out.color }) + '\n\n');

  // 4. Flat controls (state-dependent).
  out.write(renderControls(metas, nowMs, authed) + '\n\n');

  // 5. Choice prompt. 6. Root footer (only `ESC to exit`).
  out.write('Choice: ▌\n');
  out.write('ESC to exit\n');
}