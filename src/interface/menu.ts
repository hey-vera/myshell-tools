/**
 * src/interface/menu.ts — Sessions-first interactive control panel.
 *
 * Implements the dual-brain UX design bible:
 *   - A boxed header with provider status (real, from EnvironmentStatus).
 *   - Recent conversations (up to 7, relative timestamps from the store).
 *   - A sectioned menu with letter-key dispatch.
 *   - First-run welcome / 10-second setup flow.
 *   - Per-conversation chat loop backed by runTask().
 *
 * Architecture rules:
 *   - NO process.exit() — caller (cli.ts) owns process lifetime.
 *   - NO Math.random() — all ids / timestamps via injected Clock.
 *   - NO fabricated data — every displayed value is real (env, store, clock).
 *   - NO digit-% literals — percentages are always computed, never hardcoded.
 *   - All rendering goes through ui/tui.ts primitives.
 */

import readline from 'node:readline';
import type { Clock, LedgerWriter, OrchestrateDeps } from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import { saveConfig } from '../infra/config.js';
import type { ConversationMeta, ConversationStore } from '../infra/conversation-store.js';
import { readLedger } from '../infra/ledger.js';
import { summarizeSpend, formatUsd } from '../infra/insights.js';
import type { SpendSummary } from '../infra/insights.js';
import type { EnvironmentStatus, ProviderStatus } from '../providers/detect.js';
import { detectEnvironment, getInstallCommand } from '../providers/detect.js';
import type { Provider, ProviderId, SandboxLevel } from '../providers/port.js';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../core/policy.js';
import type { OutputSink } from './render.js';
import { runTask } from './run.js';
import { runLogin } from '../commands/login.js';
import { runDoctor } from '../commands/doctor.js';
import { runCost } from '../commands/cost.js';
import { box, separator, menu, prompt } from '../ui/tui.js';

// ---------------------------------------------------------------------------
// MenuContext
// ---------------------------------------------------------------------------

export interface MenuContext {
  readonly version: string;
  readonly clock: Clock;
  readonly ledger: LedgerWriter;
  readonly providers: Partial<Record<ProviderId, Provider>>;
  readonly env: EnvironmentStatus;
  readonly store: ConversationStore;
  readonly config: AppConfig;
  readonly cwd: string;
  readonly sandbox: SandboxLevel;
  readonly timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Format a relative time string from a past epoch-ms to a now epoch-ms.
 * Returns "just now", "Nm ago" (minutes), "Nh ago" (hours), or "Nd ago" (days).
 * All arithmetic is pure — no Date, no Math.random.
 */
export function relativeTime(thenMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - thenMs);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return `${days}d ago`;
}

/**
 * Build the header box lines (provider status) from real EnvironmentStatus.
 * Returns string[] safe to pass as the `lines` arg to box().
 *
 * Per-provider logic (uses REAL authenticated + plan fields):
 *   ✅  when ps.installed && ps.authenticated
 *   ⚠️  when ps.installed && !ps.authenticated  (append " not signed in")
 *   ❌  when !ps.installed                       (append install command)
 * Plan label appended when ps.plan is non-null (e.g. " (Max x5)").
 */
export function renderHeaderLines(env: EnvironmentStatus, _version: string): string[] {
  const lines: string[] = [];

  for (const ps of [env.claude, env.codex]) {
    // `plan` is added by a parallel workstream; access defensively so this
    // file compiles standalone while the parallel agent's detect.ts lands.
    const plan: string | null = (ps as ProviderStatus & { readonly plan?: string | null }).plan ?? null;
    const planSuffix = plan != null ? ` (${plan})` : '';

    if (!ps.installed) {
      lines.push(`❌ ${ps.id}: not installed — ${getInstallCommand(ps.id)}`);
    } else if (ps.authenticated) {
      lines.push(`✅ ${ps.id}: ready${planSuffix}`);
    } else {
      lines.push(`⚠️  ${ps.id}: not signed in${planSuffix}`);
    }
  }

  return lines;
}

/**
 * Render the budget/spend status line shown beneath the provider header.
 *
 * Uses real numbers only — all values come from the SpendSummary which is
 * derived from `readLedger`. No digit-% literals appear in this function; it
 * shows dollar amounts only.
 *
 * @param spend - Output of summarizeSpend() over real ledger entries.
 * @param color - When false, no ANSI escape codes are emitted.
 */
export function renderBudgetLine(spend: SpendSummary, _color: boolean): string {
  if (spend.calls === 0) {
    return 'Today: ' + formatUsd(0) + ' · no runs yet';
  }
  const todayPart = 'Today: ' + formatUsd(spend.todayUsd) + ' · ' + String(spend.calls) + ' calls';
  const totalPart = 'Total: ' + formatUsd(spend.totalUsd);
  return todayPart + '   ·   ' + totalPart;
}

/**
 * Build the conversation list lines from real ConversationMeta[].
 * Format: "[N] <pin> <relative-time>  <title>[  [<category>]]"
 *
 * Pin prefix: "📌 " for pinned, "   " (3 spaces) for alignment when not pinned.
 * Category suffix: "  [<category>]" appended when category is set, omitted otherwise.
 * Returns string[] (no ANSI — pure string building, safe for tests).
 */
export function renderConversationList(metas: ConversationMeta[], nowMs: number): string[] {
  return metas.slice(0, 7).map((m, i) => {
    const thenMs = new Date(m.updatedAt).getTime();
    const rel = relativeTime(thenMs, nowMs);
    const idx = i + 1;
    const pin = m.pinned ? '📌 ' : '   ';
    const categorySuffix = m.category != null ? `  [${m.category}]` : '';
    return `[${idx}] ${pin}${rel}  ${m.title}${categorySuffix}`;
  });
}

// ---------------------------------------------------------------------------
// Internal readline helpers
// ---------------------------------------------------------------------------

/** Ask a question and resolve with the trimmed answer. */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (ans) => resolve(ans.trim()));
  });
}

// ---------------------------------------------------------------------------
// Welcome screen (first run)
// ---------------------------------------------------------------------------

async function runWelcome(
  ctx: MenuContext,
  out: OutputSink,
  rl: readline.Interface,
  mutableConfig: AppConfig,
): Promise<AppConfig> {
  const headerLines = renderHeaderLines(ctx.env, ctx.version);
  out.write('\n' + box(`🧠 myshell-tools v${ctx.version} — Setup`, headerLines) + '\n\n');
  out.write('  [Enter] Save & go\n');
  out.write('  [l]     Sign in to providers\n');
  out.write('  [c]     Customize mode\n\n');

  const key = await ask(rl, '> ');

  let updated = mutableConfig;

  if (key === 'l') {
    const loginCode = await runLogin(out);
    if (loginCode !== 0) {
      out.write('[warn] Login did not complete cleanly.\n');
    }
  } else if (key === 'c') {
    updated = await runModeSelect(updated, out, rl);
  }
  // [Enter] or anything else → fall through to save & go

  const defaultAns = await ask(rl, 'Set myshell-tools as your default shell tool? (y/n) ');
  const setAsDefault = defaultAns.toLowerCase() === 'y';

  const saved: AppConfig = {
    onboarded: true,
    setAsDefault,
    ...(updated.mode !== undefined ? { mode: updated.mode } : {}),
  };

  await saveConfig(saved);
  return saved;
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

async function runModeSelect(
  config: AppConfig,
  out: OutputSink,
  rl: readline.Interface,
): Promise<AppConfig> {
  const currentMode = config.mode ?? 'balanced';
  const settingsLines = [
    '',
    'Mode:',
    `  [1] cost-saver${currentMode === 'cost-saver' ? ' (active)' : ''}`,
    `  [2] balanced${currentMode === 'balanced' ? ' (active)' : ''}`,
    `  [3] quality-first${currentMode === 'quality-first' ? ' (active)' : ''}`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  const key = await ask(rl, '[1/2/3 to change, Enter to keep] ');

  let newMode = config.mode;
  if (key === '1') newMode = 'cost-saver';
  else if (key === '2') newMode = 'balanced';
  else if (key === '3') newMode = 'quality-first';

  const updated: AppConfig = {
    onboarded: config.onboarded,
    setAsDefault: config.setAsDefault,
    ...(newMode !== undefined ? { mode: newMode } : {}),
  };

  await saveConfig(updated);
  out.write(`Mode set to: ${newMode ?? 'balanced'}\n`);
  return updated;
}

async function runSettings(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig },
  out: OutputSink,
  rl: readline.Interface,
): Promise<void> {
  mutableCtx.config = await runModeSelect(mutableCtx.config, out, rl);
}

// ---------------------------------------------------------------------------
// Manage conversations screen
// ---------------------------------------------------------------------------

async function runManage(
  ctx: MenuContext,
  out: OutputSink,
  rl: readline.Interface,
): Promise<void> {
  // Inner helper to re-fetch and re-render the conversation list.
  async function renderList(): Promise<ConversationMeta[]> {
    const latest = await ctx.store.list();
    const nowMs = ctx.clock.now();
    const lines = renderConversationList(latest, nowMs);
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
    await ask(rl, '[Enter to go back] ');
    return;
  }

  metas = await renderList();

  const key = await ask(rl, '> ');

  if (key === 'p') {
    const numStr = await ask(rl, 'Pin/unpin conversation number: ');
    const num = parseInt(numStr, 10);
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
    const numStr = await ask(rl, 'Set category for conversation number: ');
    const num = parseInt(numStr, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        const tag = await ask(rl, `Category tag for "${conv.title}" (empty to clear): `);
        await ctx.store.setCategory(conv.id, tag.length > 0 ? tag : null);
        out.write(tag.length > 0 ? `Category set to "${tag}"\n` : 'Category cleared.\n');
        await renderList();
      }
    }
  } else if (key === 'r') {
    const numStr = await ask(rl, 'Rename conversation number: ');
    const num = parseInt(numStr, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        const newTitle = await ask(rl, `New name for "${conv.title}": `);
        if (newTitle.length > 0) {
          await ctx.store.rename(conv.id, newTitle);
          out.write(`Renamed to "${newTitle}"\n`);
          await renderList();
        }
      }
    }
  } else if (key === 'x') {
    const numStr = await ask(rl, 'Delete conversation number: ');
    const num = parseInt(numStr, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= metas.length) {
      const conv = metas[num - 1];
      if (conv !== undefined) {
        const confirm = await ask(rl, `Delete "${conv.title}"? (y/n) `);
        if (confirm.toLowerCase() === 'y') {
          await ctx.store.remove(conv.id);
          out.write('Deleted.\n');
        }
      }
    }
  }
  // else: back
}

// ---------------------------------------------------------------------------
// Chat loop
// ---------------------------------------------------------------------------

async function runChatLoop(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig },
  convId: string,
  out: OutputSink,
  rl: readline.Interface,
): Promise<void> {
  // Print a short recap of the conversation (last entry) if history exists
  const history = await ctx.store.load(convId);
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last !== undefined) {
      out.write(
        `\n  Resuming — last message (${last.role}): ${last.content.slice(0, 80)}${last.content.length > 80 ? '…' : ''}\n\n`,
      );
    }
  }

  out.write(prompt('task or /help', out.color) + '\n');

  let currentAc: AbortController | null = null;

  // Handle SIGINT: cancel in-flight task or return to menu
  const sigintHandler = (): void => {
    if (currentAc !== null) {
      currentAc.abort();
      out.write('\n[warn] Task cancelled.\n');
      currentAc = null;
    } else {
      out.write('\n[info] Use /back or /exit to return to the menu.\n');
    }
  };

  process.on('SIGINT', sigintHandler);

  try {
    while (true) {
      const line = await ask(rl, 'myshell-tools> ');

      if (line.length === 0) continue;

      if (line === '/exit' || line === '/back') {
        break;
      }

      if (line === '/help') {
        out.write(
          '  /back or /exit — return to main menu\n' +
          '  /help          — show this help\n' +
          '  <anything>     — run as a task in this conversation\n',
        );
        continue;
      }

      const policy =
        mutableCtx.config.mode !== undefined
          ? POLICY_PRESETS[mutableCtx.config.mode]
          : DEFAULT_POLICY;

      const deps: OrchestrateDeps = {
        clock: ctx.clock,
        session: ctx.store.writer(convId),
        ledger: ctx.ledger,
        policy,
        providers: ctx.providers,
        cwd: ctx.cwd,
        sandbox: ctx.sandbox,
        timeoutMs: ctx.timeoutMs,
      };

      const ac = new AbortController();
      currentAc = ac;
      await runTask(line, deps, out, ac.signal);
      currentAc = null;
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}

// ---------------------------------------------------------------------------
// Main screen render
// ---------------------------------------------------------------------------

async function renderMainScreen(
  ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  metas: ConversationMeta[],
  out: OutputSink,
): Promise<void> {
  out.write('\n');

  // Header box — always box(), 🧠 emoji, real provider data
  const headerLines = renderHeaderLines(mutableCtx.env, ctx.version);
  out.write(box(`🧠 myshell-tools v${ctx.version}`, headerLines) + '\n\n');

  // Budget line — real ledger data, never fabricated
  const entries = await readLedger(ctx.cwd);
  const spend = summarizeSpend(entries, ctx.clock.isoNow());
  out.write('  ' + renderBudgetLine(spend, out.color) + '\n\n');

  // Recent conversations — separator() then list
  out.write(separator('Recent Conversations') + '\n');
  const nowMs = ctx.clock.now();
  const convLines = renderConversationList(metas, nowMs);
  if (convLines.length === 0) {
    out.write('  (no conversations yet — press n to start one)\n');
  } else {
    for (const line of convLines) {
      out.write(`  ${line}\n`);
    }
  }
  out.write('\n');

  // Menu — sectioned via menu()
  out.write(
    menu([
      { key: 'c', label: 'Continue last conversation', section: 'Conversations' },
      { key: 'n', label: 'New conversation', section: 'Conversations' },
      { key: '1-9', label: 'Resume numbered conversation', section: 'Conversations' },
      { key: 'e', label: 'Manage conversations', section: 'Conversations' },
      { key: 'j', label: 'Login Claude', section: 'Auth' },
      { key: 'k', label: 'Login Codex', section: 'Auth' },
      { key: 's', label: 'Settings', section: 'Options' },
      { key: 'd', label: 'Doctor', section: 'Options' },
      { key: '$', label: 'Cost', section: 'Options' },
      { key: 'q', label: 'Quit', section: 'Options' },
    ]) + '\n\n',
  );
}

// ---------------------------------------------------------------------------
// startMenu — public entry point
// ---------------------------------------------------------------------------

/**
 * Start the sessions-first interactive menu.
 *
 * Follows the dual-brain UX design bible:
 *   A. First run: welcome / 10-second setup → mark onboarded.
 *   B. Main screen loop: header + recent conversations + sectioned menu.
 *   C. Per-conversation chat loop backed by runTask().
 *
 * Never calls process.exit() — resolves when the user presses [q].
 */
export async function startMenu(ctx: MenuContext, out: OutputSink): Promise<void> {
  // Create ONE readline interface for the whole menu lifecycle.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: out.isTty,
  });

  // Mutable local copy of config & env — updated as the user changes settings /
  // re-authenticates without mutating the immutable ctx parameter.
  const mutableCtx: { config: AppConfig; env: EnvironmentStatus } = {
    config: ctx.config,
    env: ctx.env,
  };

  try {
    // ---- A. First-run welcome -----------------------------------------------
    if (!mutableCtx.config.onboarded) {
      mutableCtx.config = await runWelcome(ctx, out, rl, mutableCtx.config);
    }

    // ---- B. Main screen loop -------------------------------------------------
    while (true) {
      const metas = await ctx.store.list();
      await renderMainScreen(ctx, mutableCtx, metas, out);

      const key = await ask(rl, '> ');

      // ---- [q] Quit -----------------------------------------------------------
      if (key === 'q') {
        break;
      }

      // ---- [n] New conversation -----------------------------------------------
      if (key === 'n') {
        const firstMsg = await ask(rl, 'First message (becomes the title): ');
        if (firstMsg.length > 0) {
          const meta = await ctx.store.create(firstMsg);
          await runChatLoop(ctx, mutableCtx, meta.id, out, rl);
        }
        continue;
      }

      // ---- [c] Continue most-recent conversation ------------------------------
      if (key === 'c') {
        const all = await ctx.store.list();
        const latest = all[0];
        if (latest !== undefined) {
          await runChatLoop(ctx, mutableCtx, latest.id, out, rl);
        } else {
          out.write('No conversations yet. Press n to start one.\n');
        }
        continue;
      }

      // ---- [1-9] Resume numbered conversation ---------------------------------
      const digit = parseInt(key, 10);
      if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
        const target = metas[digit - 1];
        if (target !== undefined) {
          await runChatLoop(ctx, mutableCtx, target.id, out, rl);
        } else {
          out.write(`No conversation at position ${digit}.\n`);
        }
        continue;
      }

      // ---- [e] Manage conversations -------------------------------------------
      if (key === 'e') {
        await runManage(ctx, out, rl);
        continue;
      }

      // ---- [j] Login Claude ---------------------------------------------------
      if (key === 'j') {
        await runLogin(out, 'claude');
        mutableCtx.env = await detectEnvironment();
        continue;
      }

      // ---- [k] Login Codex ----------------------------------------------------
      if (key === 'k') {
        await runLogin(out, 'codex');
        mutableCtx.env = await detectEnvironment();
        continue;
      }

      // ---- [s] Settings -------------------------------------------------------
      if (key === 's') {
        await runSettings(ctx, mutableCtx, out, rl);
        continue;
      }

      // ---- [d] Doctor ---------------------------------------------------------
      if (key === 'd') {
        await runDoctor(out);
        continue;
      }

      // ---- [$] Cost -----------------------------------------------------------
      if (key === '$') {
        await runCost(ctx.cwd, out);
        continue;
      }

      // ---- Unknown key --------------------------------------------------------
      if (key.length > 0) {
        out.write(`Unknown option: "${key}". Press q to quit.\n`);
      }
    }
  } finally {
    rl.close();
  }
}
