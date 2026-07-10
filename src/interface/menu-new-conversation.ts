/**
 * src/interface/menu-new-conversation.ts — Slice 8 New Conversation screen.
 *
 * The subflow reached from `[n] New conversation` on the home menu. Renders the
 * locked "New Conversation" skeleton from docs/menu-build-spec-final.md (the
 * Effort Mode box — which stays visible so `m` is still advertised — followed
 * by the small "New Conversation" title box, the `[1] Current` choice with the
 * resolved workspace root, `[2] Pick workspace...`, `Choice: ▌`, and the
 * shared nav footer) and dispatches:
 *
 *   - Enter / `[1]` → create the conversation bound to the CURRENT workspace
 *     root, resolved by Slice 7's {@link resolveWorkspaceRoot} (git toplevel
 *     inside a repo, else the exact cwd). Reused, not reimplemented.
 *   - `[2]`     → open the fuzzy workspace picker (workspace-picker.ts); on a
 *                 selection, create bound to the chosen root. ← from the picker
 *                 returns HERE (not all the way home).
 *   - `m`       → switch Effort Mode (the same `runModeSelect` the home menu
 *                 uses), then re-render. The Effort box's `m = switch modes`
 *                 hint stays visible per the locked skeleton.
 *   - ←         → return to the home menu (pop one nav level).
 *   - ESC       → exit the app (the global Slice 4 nav, via getMenuStack()).
 *
 * All nav (ESC / left / stack push-pop) reuses getMenuStack()/NAV_ESC/NAV_LEFT
 * from src/interface/menu-key-confirm.ts — there is no parallel exit path.
 *
 * The screen does NOT create the conversation itself or run the chat loop: it
 * hands the chosen workspaceRoot back to the `[n]` handler in menu.ts, which
 * calls `ctx.store.create(title, { mode, workspaceRoot })` (Slice 6's options
 * overload), runs goal review, and enters runChatLoop. Keeping creation in the
 * caller preserves the existing auth-gate + goal-review + chat-entry sequencing
 * shared by the `[c]` / `[1-9]` paths.
 */

import type { MenuContext } from './menu.js';
import type { AppConfig } from '../infra/config.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import type { OutputSink } from './render.js';
import { readMenuKey, NAV_ESC, NAV_LEFT, getMenuStack } from './menu-key-confirm.js';
import { titleBox } from '../ui/tui.js';
import { dim } from '../ui/theme.js';
import { nodeRepoScanPort } from '../infra/repo-scan.js';
import { resolveWorkspaceRoot } from './workspace.js';
import { runWorkspacePicker } from './workspace-picker.js';
import { runModeSelect } from './menu-settings.js';
import { resolveAutoMode } from './menu-auto-mode.js';
import { readSubscriptions } from '../infra/subscriptions.js';
import { navFooterText } from './ui/nav-footer.js';
import { formatControlLine, renderEffortModeBox } from './menu-render.js';

/** The screen's outcome handed back to the `[n]` handler in menu.ts. */
export type NewConversationOutcome =
  | { readonly kind: 'create'; readonly workspaceRoot: string }
  | { readonly kind: 'back' }
  | { readonly kind: 'exit' };

/**
 * Run the New Conversation screen until the user picks a workspace ( returns
 * `create`), goes back to home ( `back`), or exits ( `exit`).
 *
 * Pushes one menu-stack level on entry and pops exactly one level on every
 * return path (back / create / exit), so the home menu's depth-1 invariant is
 * preserved. `onConfigChange` is invoked after an `m` Effort Mode switch so the
 * caller can re-sync derived settings (the home menu's `syncSettings`).
 */
export async function runNewConversationScreen(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  out: OutputSink,
  readLine: () => Promise<string | null>,
  inkReadKey: undefined | (() => Promise<string>),
  onConfigChange: () => void,
): Promise<NewConversationOutcome> {
  getMenuStack().push();

  // The current workspace root is stable for the lifetime of this screen —
  // resolve once. ctx.repoScanPort (an injected testing seam added with this
  // slice) wins; production defaults to the real nodeRepoScanPort. The
  // resolveWorkspaceRoot contract is best-effort and never throws.
  const repoScanPort = ctx.repoScanPort ?? nodeRepoScanPort;
  const currentRoot = await resolveWorkspaceRoot(ctx.cwd, repoScanPort);

  try {
    for (;;) {
      // An Effort Mode ESC (runModeSelect calls requestExit on ESC) surfaces here.
      if (getMenuStack().exitRequested) return { kind: 'exit' };

      const color = out.color;
      out.write('\n');
      out.write(renderEffortModeBox(mutableCtx.config.mode, color) + '\n\n');
      out.write(titleBox('New Conversation', { padding: 6, color }) + '\n\n');
      // S.1: bold key tokens + dim path secondary (identity when color off).
      out.write('         ' + formatControlLine('[1] Current', color) + '\n');
      out.write(dim(`             ${currentRoot}`, color) + '\n\n');
      out.write(formatControlLine('[2] Pick workspace...', color) + '\n\n');
      out.write('Choice: ▌\n');
      out.write(navFooterText('back-and-exit', color) + '\n');

      const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

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
      // Enter (no-op) or `[1]` → create bound to the current workspace root.
      if (key === '' || key === '1') {
        return { kind: 'create', workspaceRoot: currentRoot };
      }
      if (key === '2') {
        const pick = await runWorkspacePicker(ctx, out, readLine, inkReadKey, currentRoot);
        if (pick.kind === 'select') return { kind: 'create', workspaceRoot: pick.root };
        if (pick.kind === 'exit') {
          getMenuStack().requestExit();
          return { kind: 'exit' };
        }
        // pick.kind === 'back' → return to THIS screen (picker already popped
        // its own level); re-render and read the next key.
        continue;
      }
      if (key === 'm') {
        const accounts = await readSubscriptions()
          .then((s) => s.accounts)
          .catch(() => [] as const);
        const autoMode = resolveAutoMode(mutableCtx.env, accounts);
        mutableCtx.config = await runModeSelect(
          mutableCtx.config, out, readLine, autoMode, mutableCtx.env, inkReadKey,
        );
        onConfigChange();
        continue;
      }
      // Unknown key → re-render (no-op).
    }
  } finally {
    getMenuStack().pop();
  }
}