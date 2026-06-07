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
import { modeLabel } from '../core/policy.js';
import { box, separator, menu } from '../ui/tui.js';
import { dim } from '../ui/theme.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import { resolveAutoMode, autoModeReason } from './menu-auto-mode.js';
import {
  versionStatusLabel,
  renderHeaderLines,
  renderBudgetLine,
  renderConversationList,
} from './menu-display.js';

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
): Promise<void> {
  out.write('\n');

  // Header box — always box(), real provider data.
  // Title carries the live version status so the user always knows whether they
  // are current: "(latest)" when up to date, "→ X.Y.Z available" when not.
  const headerLines = renderHeaderLines(mutableCtx.env, ctx.version, claudeTokenInfo ?? undefined);
  const versionLabel = versionStatusLabel(updateInfo);
  out.write(box(`myshell-tools v${ctx.version}${versionLabel}`, headerLines) + '\n\n');

  // Update banner — only shown when a newer version is genuinely available.
  if (updateInfo?.updateAvailable === true && updateInfo.latest !== null) {
    if (runningUnderNpx) {
      // Self-update can't persist under npx (it re-serves its own cache next run).
      // Be honest and point to the durable fix instead of a no-op "press u".
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

  // Health issues — surfaced automatically, only when something is actually
  // wrong (writable/Node/pricing). Silence means healthy; the user never runs a
  // diagnostic command. Errors get ✗, warnings get ⚠️.
  for (const issue of healthIssues) {
    const marker = issue.severity === 'error' ? '✗' : '⚠️ ';
    out.write(`  ${marker} ${issue.message}\n`);
  }
  if (healthIssues.length > 0) out.write('\n');

  // Budget line — real ledger data, never fabricated. The SpendSummary is
  // computed by the caller and cached across keystrokes (the ledger only
  // changes when a task completes), so navigating the menu never re-parses the
  // unbounded ledger.jsonl on every keypress.
  out.write('  ' + renderBudgetLine(spend, out.color) + '\n');

  // Mode line — visible and one keystroke to change (no settings dive). Shows the
  // effective mode: the user's explicit choice, else the subscription-derived auto
  // default. This is the default for NEW chats; each chat can override its own.
  {
    const autoMode = resolveAutoMode(mutableCtx.env);
    const eff = mutableCtx.config.mode ?? autoMode;
    const autoSuffix = mutableCtx.config.mode === undefined
      ? ` (${autoModeReason(mutableCtx.env)})`
      : '';
    out.write(
      '  ' +
        dim(
          `Mode: ${modeLabel(eff)}${autoSuffix}  ·  press m to change`,
          out.color,
        ) +
        '\n\n',
    );
  }

  // Recent conversations — separator() then list. Header is just "Recent" so it
  // doesn't repeat the "Conversations" action header that follows.
  out.write(separator('Recent') + '\n');
  const nowMs = ctx.clock.now();
  const convLines = renderConversationList(metas, nowMs, out.color);
  if (convLines.length === 0) {
    out.write('  (no conversations yet)\n');
  } else {
    for (const line of convLines) {
      out.write(`  ${line}\n`);
    }
  }
  out.write('\n');

  // Auth section — always include the opencode [o] entry so users can discover
  // and connect opencode even before it is installed. Label parallels the other
  // two providers; when opencode isn't installed yet, the handler offers to
  // install it (with consent) before signing in.
  const opencodeLabel = mutableCtx.env.opencode.installed
    ? 'Login opencode'
    : 'Login opencode (installs it first)';
  const authEntries: Array<{ key: string; label: string; section: string }> = [
    { key: 'j', label: 'Login Claude', section: 'Auth' },
    { key: 'k', label: 'Login Codex', section: 'Auth' },
    { key: 'o', label: opencodeLabel, section: 'Auth' },
  ];

  // [u] Update now — shown only when a newer version is actually available AND
  // an in-place self-update can persist (not under npx, where it would be a no-op).
  const updateEntry =
    updateInfo?.updateAvailable === true && updateInfo.latest !== null && !runningUnderNpx
      ? [{ key: 'u', label: `Update now (→ ${updateInfo.latest})`, section: 'Options' }]
      : [];

  // Menu — sectioned via menu()
  out.write(
    menu([
      // Under the "Conversations" header, so items don't repeat the noun.
      { key: 'c', label: 'Continue last', section: 'Conversations' },
      { key: 'n', label: 'New', section: 'Conversations' },
      { key: '1-9', label: 'Resume numbered', section: 'Conversations' },
      { key: 'e', label: 'Manage', section: 'Conversations' },
      { key: 'i', label: 'Resume a Claude/Codex session', section: 'Conversations' },
      { key: 'r', label: 'Raw provider session', section: 'Conversations' },
      ...authEntries,
      { key: 's', label: 'Settings', section: 'Options' },
      { key: 'd', label: 'Diagnose', section: 'Options' },
      { key: '$', label: 'Usage (tokens)', section: 'Options' },
      ...updateEntry,
      { key: 'q', label: 'Quit', section: 'Options' },
    ]) + '\n\n',
  );
}
