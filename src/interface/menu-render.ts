/**
 * src/interface/menu-render.ts — Slice 1 home render skeleton (locked).
 *
 * Renders the locked home-menu skeleton from docs/menu-build-spec-final.md:
 *   1. Mode rounded box (sectionBox, two sections + internal divider) —
 *      LIVE from config.mode (not a hardcoded Auto mockup). R8.1: this is the
 *      Mode dial (lane + verification), not an unshipped Effort/Speed pair.
 *   2. One `Recent (<workspace label>):` list (no workspace location column yet —
 *      workspace-root resolution is a later slice; the label is just the current
 *      cwd basename, never fabricated).
 *   3. Small centered `Session Manager` titleBox (sized to text).
 *   4. Flat controls list, state-dependent (populated / empty signed in / empty
 *      not signed in).
 *   5. `Choice: ▌` prompt line.
 *   6. Root footer `ESC to exit`.
 */

// See docs/menu-build-spec-final.md (locked slices + Slice 3 doctor de-advertise) + kern-spec.md

import type { AppConfig } from '../infra/config.js';
import type { ConversationMeta, ConversationMode } from '../infra/conversation-store.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { UpdateCheckResult } from '../infra/update-check.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import type { HealthIssue } from '../infra/health.js';
import type { Mode } from '../core/policy.js';
import { levelLabel, LEVEL_DESC, migrateMode } from '../core/mode-levels.js';
import type { Level } from '../core/mode-levels.js';
import { sectionBox, titleBox } from '../ui/tui.js';
import { bold, cyan, dim, label } from '../ui/theme.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import type { Goal } from '../core/goal-todo.js';
import {
  hasAnyAuthenticatedProvider,
  conversationModeLabel,
  type ProviderAccountSummary,
} from './menu-display.js';
import { conversationWorkerCount } from './goal-worker-registry.js';
import { workspaceLabel, normalizeWorkspacePath } from './workspace.js';
import { navFooterText } from './ui/nav-footer.js';

// ---------------------------------------------------------------------------
// Mode box — live from config.mode (shared pure helper).
// R8.1: user-facing name is "Mode" (lane + verification). Intensity is separate.
// ---------------------------------------------------------------------------

/** Inner content width matching the locked mockup box (48 columns of text). */
export const EFFORT_BOX_WIDTH = 48;

/**
 * User-facing short label for a persisted config.mode:
 *   undefined → Auto (smart); cost-saver → Budget; balanced → Balanced;
 *   quality-first → Max (via migrateMode). PURE.
 */
export function effortModeShortLabel(mode: Mode | string | null | undefined): string {
  const level = migrateMode(mode);
  if (level === 'auto') return 'Auto (smart)';
  return levelLabel(level);
}

/** Word-wrap plain text to `width` columns (no ANSI). PURE. */
function wrapWords(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur = `${cur} ${w}`;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

/**
 * Build the two sectionBox sections for the Mode box from a persisted
 * config.mode. Shared by home and New Conversation. PURE.
 *
 * Header: `Mode:  <label>` + LEVEL_DESC lines (wrapped to width 48).
 * Footer: `m = switch modes` left + current short label right-aligned.
 *
 * When `color` is true: cyan/bold title + mode, dim description + switch hint.
 * When false (NO_COLOR / tests): plain text for golden tests.
 */
export function buildEffortModeSections(
  mode: Mode | string | null | undefined,
  color = false,
): { header: string[]; footer: string[] } {
  const level: Level = migrateMode(mode);
  const short = effortModeShortLabel(mode);
  // Visual hierarchy: label + mode read as primary; description is secondary.
  // R8.1: "Mode" not "Effort Mode" — avoids implying the unshipped Effort/Speed pair.
  const headerLine = `${bold(cyan('Mode:', color), color)}  ${bold(short, color)}`;
  const descLines = wrapWords(LEVEL_DESC[level], EFFORT_BOX_WIDTH).map((l) => dim(l, color));
  const left = 'm = switch modes';
  const gap = Math.max(1, EFFORT_BOX_WIDTH - left.length - short.length);
  const footerLine = dim(left, color) + ' '.repeat(gap) + cyan(short, color);
  return {
    header: [headerLine, ...descLines],
    footer: [footerLine],
  };
}

/** Render the 48-wide Mode sectionBox for the given mode. PURE (no I/O). */
export function renderEffortModeBox(
  mode: Mode | string | null | undefined,
  color: boolean,
): string {
  const { header, footer } = buildEffortModeSections(mode, color);
  return sectionBox([header, footer], { width: EFFORT_BOX_WIDTH, color });
}

// ---------------------------------------------------------------------------
// Home visual-polish helpers (S.1) — pure, color-gated
// ---------------------------------------------------------------------------

/**
 * Section header for home lists (`Recent (…):`). Cyan-bold when color is on;
 * identity when off so locked golden strings stay byte-identical. PURE.
 */
export function formatHomeSectionHeader(text: string, color: boolean): string {
  return label(text, color);
}

/**
 * One Recent-list row with dim secondary fields (age + provider/effort) when
 * color is on. Key index and title stay normal weight for scannability. PURE.
 *
 * Shape: `[n] <age>  <titleColumn>  <providerEffort>[  <workStatus>]`
 * Optional `workStatus` is multi-chat live work chrome (`2 working · 1 parked`).
 */
export function formatRecentRow(
  index: number,
  age: string,
  titleColumn: string,
  providerEffort: string,
  color: boolean,
  workStatus?: string | null,
): string {
  const base = `[${index}] ${dim(age, color)}  ${titleColumn}  ${dim(providerEffort, color)}`;
  if (typeof workStatus !== 'string' || workStatus.length === 0) return base;
  return `${base}  ${dim(workStatus, color)}`;
}

// ---------------------------------------------------------------------------
// Multi-chat home work status (M1) — pure chips from real counts
// ---------------------------------------------------------------------------

/** Per-conversation work counts feeding Recent-row status chips. PURE inputs. */
export interface ConversationWorkStatusInput {
  /** In-process live workers (`conversationWorkerCount`). */
  readonly liveWorkers: number;
  /** Durable goal store `state === 'running'` for this conversation. */
  readonly runningGoals: number;
  /** Durable goal store `state === 'parked'` for this conversation. */
  readonly parkedGoals: number;
  /** Active detached jobs (`goalJobStore.listActive`) for this conversation. */
  readonly activeJobs: number;
}

/**
 * Glanceable work chips for a Recent row. Fail-soft callers pass zeros when
 * stores are unavailable. Empty string when nothing is live/parked/jobbed.
 *
 * Examples: `2 working` · `1 parked` · `job alive` · `1 running · job alive`
 * (store-only running when no in-process worker is registered).
 */
export function formatConversationWorkStatus(input: ConversationWorkStatusInput): string {
  const live = Math.max(0, Math.floor(input.liveWorkers) || 0);
  const running = Math.max(0, Math.floor(input.runningGoals) || 0);
  const parked = Math.max(0, Math.floor(input.parkedGoals) || 0);
  const jobs = Math.max(0, Math.floor(input.activeJobs) || 0);
  const parts: string[] = [];
  if (live > 0) {
    parts.push(`${live} working`);
  } else if (running > 0) {
    parts.push(`${running} running`);
  }
  if (parked > 0) {
    parts.push(`${parked} parked`);
  }
  if (jobs > 0) {
    parts.push(jobs === 1 ? 'job alive' : `${jobs} jobs`);
  }
  return parts.join(' · ');
}

/** Minimal job shape needed for home status aggregation (conversation scope). */
export interface HomeActiveJobRef {
  readonly conversationId: string;
}

/**
 * Build conversationId → formatted work-status string for Recent rows.
 * Uses live registry counts (injectable for tests) + durable goals + active jobs.
 * Goals with null/empty conversationId are ignored. PURE given `liveWorkerCount`.
 */
export function buildConversationWorkStatusById(
  goals: readonly Goal[],
  activeJobs: readonly HomeActiveJobRef[],
  liveWorkerCount: (conversationId: string) => number = conversationWorkerCount,
): ReadonlyMap<string, string> {
  const runningBy = new Map<string, number>();
  const parkedBy = new Map<string, number>();
  for (const g of goals) {
    const cid = g.conversationId;
    if (typeof cid !== 'string' || cid.length === 0) continue;
    if (g.state === 'running') {
      runningBy.set(cid, (runningBy.get(cid) ?? 0) + 1);
    } else if (g.state === 'parked') {
      parkedBy.set(cid, (parkedBy.get(cid) ?? 0) + 1);
    }
  }
  const jobsBy = new Map<string, number>();
  for (const j of activeJobs) {
    const cid = j.conversationId;
    if (typeof cid !== 'string' || cid.length === 0) continue;
    jobsBy.set(cid, (jobsBy.get(cid) ?? 0) + 1);
  }
  const ids = new Set<string>([...runningBy.keys(), ...parkedBy.keys(), ...jobsBy.keys()]);
  // Also include conversations that only have live workers (no durable row yet).
  // Caller may not know those ids from stores alone — paintMenu only has metas;
  // live workers are looked up per meta id in renderRecentRows instead when map miss.
  const out = new Map<string, string>();
  for (const id of ids) {
    let live = 0;
    try {
      live = liveWorkerCount(id);
    } catch {
      live = 0;
    }
    const text = formatConversationWorkStatus({
      liveWorkers: live,
      runningGoals: runningBy.get(id) ?? 0,
      parkedGoals: parkedBy.get(id) ?? 0,
      activeJobs: jobsBy.get(id) ?? 0,
    });
    if (text.length > 0) out.set(id, text);
  }
  return out;
}

/**
 * Resolve work-status text for one conversation id (map hit, else live-only
 * registry lookup so in-process workers still show when stores are empty).
 */
export function resolveConversationWorkStatus(
  conversationId: string,
  byId: ReadonlyMap<string, string>,
  liveWorkerCount: (conversationId: string) => number = conversationWorkerCount,
): string {
  const hit = byId.get(conversationId);
  if (typeof hit === 'string' && hit.length > 0) return hit;
  let live = 0;
  try {
    live = liveWorkerCount(conversationId);
  } catch {
    live = 0;
  }
  if (live <= 0) return '';
  return formatConversationWorkStatus({
    liveWorkers: live,
    runningGoals: 0,
    parkedGoals: 0,
    activeJobs: 0,
  });
}

/**
 * Control-list line polish: bold the leading `[key]` token when color is on;
 * dim indented secondary lines (e.g. `    └─ …`). Identity when color is off. PURE.
 */
export function formatControlLine(line: string, color: boolean): string {
  if (!color) return line;
  if (line.startsWith('    ') || line.startsWith('\t')) return dim(line, color);
  const m = line.match(/^(\[[^\]]+\])(.*)$/);
  if (m === null) return line;
  return `${bold(m[1] ?? '', color)}${m[2] ?? ''}`;
}
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
  color = false,
  workStatusById: ReadonlyMap<string, string> = new Map(),
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
    const workStatus = resolveConversationWorkStatus(m.id, workStatusById);
    return formatRecentRow(idx, age, titleColumn, providerEffort, color, workStatus);
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
  color = false,
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
  return lines.map((l) => formatControlLine(l, color)).join('\n');
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
  allGoals: readonly Goal[] = [],
  _accountStates?: Record<string, ProviderAccountSummary>,
  _spendLoading = false,
  listsLoading = false,
  currentWorkspaceRoot?: string,
  /** Active detached goal jobs (fail-soft empty when store unavailable). */
  activeJobs: readonly HomeActiveJobRef[] = [],
): Promise<void> {
  out.write('\n');

  const color = out.color;

  // 1. Mode box — live from config.mode (blank line after for section rhythm).
  out.write(renderEffortModeBox(mutableCtx.config.mode, color) + '\n\n');

  // 2. Recent (<current workspace label>): — one list, no workspace split.
  //
  // Slice 10 — the label comes from Slice 7's `workspaceLabel(currentRoot)`,
  // where `currentRoot` is the resolved workspace root (git toplevel else cwd)
  // supplied by `startMenu` (which resolves it once via `resolveWorkspaceRoot`).
  // When omitted (e.g. unit tests driving `renderMainScreen` directly), it
  // falls back to `ctx.cwd` — the cwd basename, matching the pre-Slice-10
  // behavior so locked-Slice-1 render assertions stay byte-identical.
  //
  // M1 — each Recent row may append live work chips from durable goals +
  // active jobs + in-process goal-worker-registry (never fabricated).
  const authed = hasAnyAuthenticatedProvider(mutableCtx.env);
  const currentRoot = currentWorkspaceRoot ?? ctx.cwd;
  const wsLabel = workspaceLabel(currentRoot);
  // S.1: cyan-bold section header when color is on (identity when off).
  out.write(formatHomeSectionHeader(`Recent (${wsLabel}):`, color) + '\n');

  const nowMs = ctx.clock.now();
  if (listsLoading) {
    out.write(dim('  loading…', color) + '\n');
  } else if (metas.length === 0) {
    const empty = authed ? 'No conversations yet.' : 'Sign in to start conversations.';
    out.write(dim(empty, color) + '\n');
  } else {
    let workStatusById: ReadonlyMap<string, string> = new Map();
    try {
      workStatusById = buildConversationWorkStatusById(allGoals, activeJobs);
    } catch {
      workStatusById = new Map();
    }
    const rows = renderRecentRows(metas, nowMs, currentRoot, color, workStatusById);
    for (const row of rows) out.write(`  ${row}\n`);
  }
  out.write('\n');

  // 3. Session Manager centered titleBox (sized to text).
  out.write(titleBox('Session Manager', { padding: 6, color }) + '\n\n');

  // 4. Flat controls (state-dependent). The [c] Continue-last sub-line names the
  // FIRST RENDERED row (current-workspace-first order), so it always matches
  // the `[1]` row above it — the locked mockup shows `[c]`'s sub-line equal to
  // row `[1]`, and the render/dispatch invariant says visible order == dispatch
  // order ([c] is the conceptual `[0]`).
  out.write(renderControls(metas, nowMs, authed, currentRoot, color) + '\n\n');

  // 5. Choice prompt. 6. Root footer via shared nav-footer pattern (P0.11 light).
  // Same glyphs as locked skeleton (`ESC to exit`); dimmed when color is on so
  // it reads as chrome, not a crammed control row.
  out.write('Choice: ▌\n');
  out.write(navFooterText('exit-only', color) + '\n');
}
