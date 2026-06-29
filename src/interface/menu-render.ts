/**
 * src/interface/menu-render.ts — Extracted from menu.ts — behavior-preserving.
 *
 * The main-screen render block: header box, update/health banners, budget and
 * mode lines, recent conversations, and the sectioned action menu. Pure render
 * over injected state.
 */

import type { AppConfig } from '../infra/config.js';
import type { ConversationMeta } from '../infra/conversation-store.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { UpdateCheckResult } from '../infra/update-check.js';
import type { ClaudeTokenStatus } from '../infra/credentials.js';
import type { HealthIssue } from '../infra/health.js';
import { migrateMode, levelLabel } from '../core/mode-levels.js';
import { box, separator, menu } from '../ui/tui.js';
import { dim, yellow } from '../ui/theme.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import type { Goal } from '../core/goal-todo.js';
import { autoModeReason } from './menu-auto-mode.js';
import {
  versionStatusLabel,
  renderHeaderLines,
  renderBudgetLine,
  renderConversationList,
  hasAnyAuthenticatedProvider,
  computeGoalBadges,
  type ProviderAccountSummary,
} from './menu-display.js';
import { subscriptionsEnabled } from './ui/subscriptions-flag.js';

export async function renderMainScreen(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  metas: ConversationMeta[],
  spend: SpendSummary,
  out: OutputSink,
  updateInfo?: UpdateCheckResult,
  claudeTokenInfo?: ClaudeTokenStatus | null,
  runningUnderNpx = false,
  healthIssues: readonly HealthIssue[] = [],
  allGoals: readonly Goal[] = [],
  accountStates?: Record<string, ProviderAccountSummary>,
  spendLoading = false,
  listsLoading = false,
): Promise<void> {
  out.write('\n');

  const headerLines = renderHeaderLines(
    mutableCtx.env, ctx.version, claudeTokenInfo ?? undefined, accountStates,
  );
  const versionLabel = versionStatusLabel(updateInfo);
  out.write(box(`myshell-tools v${ctx.version}${versionLabel}`, headerLines) + '\n\n');

  if (updateInfo?.updateAvailable === true && updateInfo.latest !== null) {
    if (runningUnderNpx) {
      out.write(
        `  ▲ Update available: ${updateInfo.current} → ${updateInfo.latest}\n` +
        `    You're running via npx, so updates won't stick. Install globally to stay current:\n` +
        `      npm install -g myshell-tools@latest\n\n`,
      );
    } else {
      out.write(
        `  ▲ Update available: ${updateInfo.current} → ${updateInfo.latest}  (press u)\n\n`,
      );
    }
  }

  for (const issue of healthIssues) {
    const marker = issue.severity === 'error' ? '✗' : '⚠️ ';
    out.write(`  ${marker} ${issue.message}\n`);
  }
  if (healthIssues.length > 0) out.write('\n');

  const authed = hasAnyAuthenticatedProvider(mutableCtx.env);
  if (!authed) {
    out.write(
      '  ' +
        yellow(
          '⚠ Not signed in yet — press [a] Accounts to get started',
          out.color,
        ) +
        '\n\n',
    );
  }

  out.write('  ' + renderBudgetLine(spend, out.color, authed, spendLoading) + '\n');

  {
    const isAuto = mutableCtx.config.mode === undefined;
    const label = isAuto ? 'Auto (smart)' : levelLabel(migrateMode(mutableCtx.config.mode ?? 'balanced'));
    const autoSuffix = isAuto
      ? `  |  ${autoModeReason(mutableCtx.env)}`
      : '';
    out.write(
      '  ' +
        dim(
          `New conversation default: ${label}${autoSuffix}  ·  press m to change`,
          out.color,
        ) +
        '\n\n',
    );
  }

  {
    const subsOn = subscriptionsEnabled(process.env, mutableCtx.config);
    const activeCount = accountStates !== undefined
      ? Object.values(accountStates).reduce((sum, s) => sum + s.active, 0)
      : 0;
    const healthLabel = healthIssues.length > 0 ? `${healthIssues.length} issue${healthIssues.length === 1 ? '' : 's'}` : 'OK';
    const accountsPart = subsOn
      ? `Accounts: ${activeCount} active`
      : 'Accounts';
    out.write(
      '  ' +
        dim(
          `${accountsPart}  |  Health: ${healthLabel}`,
          out.color,
        ) +
        '\n\n',
    );
  }

  // Recent conversations
  out.write(separator('Recent') + '\n');
  const nowMs = ctx.clock.now();
  const goalBadges = computeGoalBadges(allGoals, ctx.clock.isoNow());
  const convLines = renderConversationList(metas, nowMs, out.color, goalBadges);
  if (listsLoading) {
    out.write('  ' + dim('loading…', out.color) + '\n');
  } else if (convLines.length === 0) {
    out.write('  (no conversations yet)\n');
  } else {
    for (const line of convLines) {
      out.write(`  ${line}\n`);
    }
  }
  out.write('\n');

  const subsOn = subscriptionsEnabled(process.env, mutableCtx.config);
  const authLabel = subsOn ? 'Accounts' : 'Accounts / Sign in';

  const updateEntry =
    updateInfo?.updateAvailable === true && updateInfo.latest !== null && !runningUnderNpx
      ? [{ key: 'u', label: `Update now (→ ${updateInfo.latest})`, section: 'Controls' }]
      : [];

  out.write(
    menu([
      { key: 'n', label: 'New', section: 'Conversations' },
      { key: 'c', label: 'Continue last', section: 'Conversations' },
      { key: '1-9', label: 'Open numbered', section: 'Conversations' },
      { key: 'e', label: 'Library', section: 'Conversations' },
      { key: 'a', label: authLabel, section: 'Accounts' },
      { key: 'm', label: `New conversation mode: ${mutableCtx.config.mode === undefined ? 'Auto (smart)' : levelLabel(migrateMode(mutableCtx.config.mode ?? 'balanced'))}`, section: 'Controls' },
      { key: 's', label: 'Settings', section: 'Controls' },
      ...updateEntry,
      { key: 'q', label: 'Quit', section: 'Controls' },
    ]) + '\n\n',
  );
}