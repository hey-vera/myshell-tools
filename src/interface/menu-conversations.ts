/**
 * src/interface/menu-conversations.ts — Extracted from menu.ts — behavior-preserving.
 *
 * Conversation management screens:
 *   - runManage: pin/category/rename/delete the stored conversations.
 *   - runImportNative: resume a native Claude/Codex session under myshell.
 */

import type { AppConfig } from '../infra/config.js';
import type { ConversationMeta } from '../infra/conversation-store.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { LoginMethod } from '../commands/login.js';
import { listRecentNativeSessions, importNativeSession } from '../providers/native-sessions.js';
import { replitPersistentEnv } from '../infra/credentials.js';
import { separator } from '../ui/tui.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import { runChatLoop } from './menu.js';
import { type Confirm, readMenuKey } from './menu-key-confirm.js';
import { type LineReader } from './menu-readline.js';
import { relativeTime, renderConversationList } from './menu-display.js';
import { yesNoHint } from './menu-questions.js';

// ---------------------------------------------------------------------------
// Manage conversations screen
// ---------------------------------------------------------------------------

export async function runManage(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  // Single-key reader for the Ink path. When provided, the [p]/[t]/[r]/[x]/Back
  // menu choice resolves on a SINGLE keypress through Ink's own input pipeline
  // (the legacy raw single-key feel) instead of a line read. The per-action number
  // / text / rename prompts stay on the line editor (they are not menu choices).
  // The delete confirm is already single-key via the passed-in `confirm` (built
  // with the Ink reader upstream). Absent → legacy path is byte-identical.
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  // Inner helper to re-fetch and re-render the conversation list.
  async function renderList(): Promise<ConversationMeta[]> {
    const latest = await ctx.store.list();
    const nowMs = ctx.clock.now();
    const lines = renderConversationList(latest, nowMs, out.color);
    out.write('\n' + separator('Conversations') + '\n');
    for (const line of lines) {
      out.write(`  ${line}\n`);
    }
    out.write('\n  [p] Pin/unpin  [t] Set category  [r] Rename  [x] Delete  [Enter] Back\n\n');
    return latest;
  }

  let metas = await ctx.store.list();

  if (metas.length === 0) {
    out.write('No conversations yet.\n');
    return;
  }

  metas = await renderList();

  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  // EOF → treat as back
  if (key === null) return;
  if (key.length === 0) return;

  if (key === 'p') {
    out.write('Pin/unpin conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        const newPinned = !conv.pinned;
        await ctx.store.setPinned(conv.id, newPinned);
        out.write(newPinned ? `📌 Pinned "${conv.title}"\n` : `Unpinned "${conv.title}"\n`);
        await renderList();
      }
    }
  } else if (key === 't') {
    out.write('Set category for conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        out.write(`Category tag for "${conv.title}" (empty to clear): `);
        const tag = await readLine() ?? '';
        await ctx.store.setCategory(conv.id, tag.length > 0 ? tag : null);
        out.write(tag.length > 0 ? `Category set to "${tag}"\n` : 'Category cleared.\n');
        await renderList();
      }
    }
  } else if (key === 'r') {
    out.write('Rename conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        out.write(`New name for "${conv.title}": `);
        const newTitle = await readLine() ?? '';
        if (newTitle.length > 0) {
          await ctx.store.rename(conv.id, newTitle);
          out.write(`Renamed to "${newTitle}"\n`);
          await renderList();
        }
      }
    }
  } else if (key === 'x') {
    out.write('Delete conversation number: ');
    const numStr = await readLine();
    const num = parseInt(numStr ?? '', 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        // Strict confirm: deletion is irreversible, so there is NO Enter default —
        // only an explicit 'y' removes the conversation (a reflexive Enter cancels).
        out.write(`Delete "${conv.title}"? ${yesNoHint('strict', out.color)} `);
        if (await confirm(false, { requireExplicit: true })) {
          await ctx.store.remove(conv.id);
          out.write('Deleted.\n');
        } else {
          out.write('Cancelled.\n');
        }
      }
    }
  }
  // else: back
}

// ---------------------------------------------------------------------------
// Import a native conversation
// ---------------------------------------------------------------------------

/**
 * Show ONE merged, numbered list of recent Claude AND Codex sessions (newest
 * first, each tagged with its tool), let the user pick a number, then bring that
 * session into myshell — import its history into a new conversation and drop into
 * the chat loop so it continues under myshell's orchestration. No
 * pick-the-provider-first step (mirrors DATA Tools' cross-tool instant resume).
 *
 * Resolves CLAUDE_CONFIG_DIR/CODEX_HOME (incl. the Replit-persistent dirs) so it
 * finds your real sessions. Follows the injected `readLine` seam so it is fully
 * testable without a TTY. Never modifies the native CLI's files.
 */
export async function runImportNative(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  out: OutputSink,
  readLine: () => Promise<string | null>,
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: {
      method?: LoginMethod;
      readLine?: () => Promise<string | null>;
      suspendStdin?: () => () => void;
      confirm?: Confirm;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  confirm: Confirm,
  suspendStdin?: () => () => void,
  lineReader?: LineReader | null,
  // EXPERIMENTAL Ink turn renderer — forwarded to runChatLoop so an imported
  // session's chat also renders through Ink. Absent off the Ink path (unchanged).
  inkRenderTurn?: import('./run.js').TurnRenderer,
  // Single-key reader for the Ink path — forwarded to runChatLoop so the imported
  // session's in-chat /mode and /style menus are single-key under Ink. The number-
  // pick prompt above stays on the line editor. Absent → legacy path unchanged.
  inkReadKey?: () => Promise<string>,
  // Ink turn-interrupt setter — forwarded to runChatLoop so a bare ESC interrupts
  // an imported session's in-flight turn (H1). Absent → legacy path unchanged.
  inkSetInterrupt?: (handler: (() => void) | null) => void,
): Promise<'menu' | 'exit'> {
  const env = { ...process.env, ...replitPersistentEnv(process.env, ctx.cwd) };
  const sessions = await listRecentNativeSessions({ env, limit: 9 });

  if (sessions.length === 0) {
    out.write('\nNo Claude or Codex sessions found to resume.\n');
    return 'menu';
  }

  // One merged, numbered list — newest first, each tagged claude/codex.
  const nowMs = ctx.clock.now();
  out.write('\n' + separator('Resume a Claude / Codex session') + '\n');
  for (let idx = 0; idx < sessions.length; idx++) {
    const s = sessions[idx];
    if (s === undefined) continue;
    const rel = relativeTime(new Date(s.updatedAt).getTime(), nowMs);
    const tag = s.provider === 'codex' ? 'codex' : 'claude';
    const titleDisplay = s.title.length > 0 ? s.title : '(untitled)';
    out.write(`  [${idx + 1}] ${tag.padEnd(6)} ${rel.padEnd(8)} ${titleDisplay}  (${s.messageCount} msgs)\n`);
  }
  out.write('\nPick a number to resume (or Enter to cancel): ');

  const pick = await readLine();
  if (pick === null || pick.trim().length === 0) return 'menu';

  const num = parseInt(pick.trim(), 10);
  if (Number.isNaN(num) || num < 1 || num > sessions.length) {
    out.write('Invalid selection.\n');
    return 'menu';
  }

  const session = sessions[num - 1];
  if (session === undefined) return 'menu';

  const { id, imported } = await importNativeSession(session, ctx.store);
  const convTitle = session.title.length > 0 ? session.title : '(untitled)';
  out.write(`Resuming ${session.provider} session "${convTitle}" (${imported} messages)…\n`);

  // Enter the chat loop for the newly imported conversation.
  // Return value propagates the 'exit' signal to the caller (startMenu).
  return runChatLoop(ctx, mutableCtx, id, out, readLine, loginFn, detectEnvironmentFn, confirm, suspendStdin, lineReader, inkRenderTurn, inkReadKey, inkSetInterrupt);
}
