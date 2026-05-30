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
import type { EnvironmentStatus } from '../providers/detect.js';
import { detectEnvironment, getInstallCommand } from '../providers/detect.js';
import { installProvider, installCommandFor } from '../providers/install.js';
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
  /**
   * Optional injected line reader for testing. When provided, `startMenu` uses
   * this instead of the real `node:readline` interface, allowing tests to drive
   * the menu with scripted input without a TTY.
   *
   * Returns the next trimmed line of input, or `null` on EOF/close.
   */
  readonly readLine?: () => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Return the shell alias hint the user can add to their shell profile to make
 * `myshell-tools` the default command-line assistant.
 *
 * This is a pure, I/O-free helper — it never reads or writes any file. The
 * caller is responsible for printing the result. No claim is made that the
 * system has been changed; the output is a copy-pasteable suggestion only.
 *
 * @param shell    - The value of `process.env.SHELL` (e.g. '/bin/bash'), or
 *                   empty/undefined on Windows where SHELL is absent.
 * @param platform - The `process.platform` string (e.g. 'win32', 'linux').
 * @returns A human-readable string containing the exact alias line to add.
 */
export function defaultAliasHint(shell: string | undefined, platform: string): string {
  if (platform === 'win32') {
    return (
      'Add to your PowerShell profile ($PROFILE):\n' +
      "  function mst { myshell-tools @args }"
    );
  }
  const shellName = typeof shell === 'string' && shell.length > 0
    ? shell.split('/').at(-1) ?? 'bash'
    : 'bash';
  if (shellName === 'fish') {
    return (
      'Add to ~/.config/fish/config.fish:\n' +
      '  alias mst="myshell-tools"'
    );
  }
  const rcFile = shellName === 'zsh' ? '~/.zshrc' : '~/.bashrc';
  return (
    `Add to ${rcFile}:\n` +
    '  alias mst="myshell-tools"'
  );
}

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
    const planSuffix = ps.plan != null ? ` (${ps.plan})` : '';

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

/**
 * An event-driven line reader over a single readline interface.
 *
 * This is the proven-correct pattern (mirrors `repl.ts`): instead of a
 * per-prompt `rl.question()` — which (a) throws `ERR_USE_AFTER_CLOSE` if the
 * interface has already closed and (b) loses lines that `readline` eagerly
 * drains from a pipe before the first prompt is even written — we attach a
 * single `'line'` listener that buffers every line and a single `'close'`
 * listener that marks EOF.
 *
 * `nextLine()` returns the next buffered/awaited line, or `null` once the
 * stream is closed/EOF. It NEVER throws and returns `null` for every call after
 * close, so callers can treat `null` as a clean end-of-input sentinel.
 */
interface LineReader {
  /** Resolve with the next line, or `null` on EOF (and for every call after). */
  nextLine(): Promise<string | null>;
  /** Close the underlying readline interface (idempotent). */
  close(): void;
}

/**
 * Build a {@link LineReader} backed by a single `node:readline` interface.
 *
 * Lines that arrive before they are awaited are buffered (fixing the eager
 * pipe-drain line loss); awaiters that arrive before a line block on a queued
 * resolver. On `close`, every pending and future awaiter resolves to `null`.
 */
function createLineReader(rl: readline.Interface): LineReader {
  // Lines received but not yet consumed by a nextLine() caller.
  const buffered: string[] = [];
  // nextLine() callers waiting for a line that hasn't arrived yet.
  const waiters: Array<(value: string | null) => void> = [];
  let closed = false;

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      buffered.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    // Drain every pending awaiter with the EOF sentinel.
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(null);
    }
  });

  return {
    nextLine(): Promise<string | null> {
      // Deliver any buffered line first (FIFO).
      if (buffered.length > 0) {
        const next = buffered.shift();
        return Promise.resolve(next ?? null);
      }
      // Once closed with nothing buffered, every call yields EOF — never throws.
      if (closed) {
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close(): void {
      rl.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Welcome screen (first run)
// ---------------------------------------------------------------------------

async function runWelcome(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  mutableConfig: AppConfig,
): Promise<AppConfig> {
  // Use the mutable env so re-detection after installs is visible downstream.
  let env = ctx.env;

  const headerLines = renderHeaderLines(env, ctx.version);
  out.write('\n' + box(`🧠 myshell-tools v${ctx.version} — Setup`, headerLines) + '\n\n');

  // ---- Offer to install any missing provider --------------------------------
  // Consent is required: we ask once per missing provider.  Enter = yes, n = skip.
  const providers: ProviderId[] = ['claude', 'codex'];
  let didInstallAny = false;

  for (const id of providers) {
    const ps = env[id];
    if (ps.installed) continue;

    const pkg = id === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
    out.write(`Install ${id} (${pkg})? [Enter] yes · [n] no\n`);
    out.write('> ');
    const ans = await readLine();

    // EOF or 'n'/'no' → skip; anything else (including '') → yes
    const skip = ans === null || ans.toLowerCase() === 'n' || ans.toLowerCase() === 'no';
    if (!skip) {
      const ok = await installProvider(id, out);
      if (ok) {
        didInstallAny = true;
      }
    } else {
      out.write(`Skipping ${id} install. You can run it yourself: ${installCommandFor(id)}\n`);
    }
  }

  // ---- Re-detect if anything was installed so sign-in offers are accurate --
  if (didInstallAny) {
    env = await detectEnvironment();
  }

  // ---- Offer sign-in for installed-but-unauthenticated providers -----------
  for (const id of providers) {
    const ps = env[id];
    if (!ps.installed || ps.authenticated) continue;

    out.write(`\nSign in to ${id} now? [Enter] yes · [n] no\n`);
    out.write('> ');
    const ans = await readLine();

    const skip = ans === null || ans.toLowerCase() === 'n' || ans.toLowerCase() === 'no';
    if (!skip) {
      await runLogin(out, id);
    }
  }

  // ---- Mode / default-shell options ----------------------------------------
  out.write('\n');
  out.write('  [c]     Customize mode\n');
  out.write('  [Enter] Continue\n\n');
  out.write('> ');
  const key = await readLine();

  // EOF during setup — save bare onboarded config and return
  if (key === null) {
    const saved: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      ...(mutableConfig.mode !== undefined ? { mode: mutableConfig.mode } : {}),
    };
    await saveConfig(saved);
    return saved;
  }

  let updated = mutableConfig;

  if (key === 'c') {
    updated = await runModeSelect(updated, out, readLine);
  }
  // [Enter] or anything else → fall through to save & go

  out.write('Set myshell-tools as your default shell tool? (y/n) ');
  const defaultAns = await readLine();

  // EOF before answer → treat as "no"
  const setAsDefault = (defaultAns ?? '').toLowerCase() === 'y';

  const saved: AppConfig = {
    onboarded: true,
    setAsDefault,
    ...(updated.mode !== undefined ? { mode: updated.mode } : {}),
  };

  await saveConfig(saved);

  // When the user opted in, print the alias hint so the prompt is honest.
  if (setAsDefault) {
    const hint = defaultAliasHint(process.env['SHELL'], process.platform);
    out.write('\n[info] To make myshell-tools your default, ' + hint + '\n\n');
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

async function runModeSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
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

  out.write('[1/2/3 to change, Enter to keep] ');
  const key = await readLine();

  // EOF → keep current mode
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
  readLine: () => Promise<string | null>,
): Promise<void> {
  mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine);
}

// ---------------------------------------------------------------------------
// Manage conversations screen
// ---------------------------------------------------------------------------

async function runManage(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
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
    out.write('[Enter to go back] ');
    await readLine();
    return;
  }

  metas = await renderList();

  out.write('> ');
  const key = await readLine();

  // EOF → treat as back
  if (key === null) return;

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
        out.write(`Delete "${conv.title}"? (y/n) `);
        const confirmAns = await readLine();
        if ((confirmAns ?? '').toLowerCase() === 'y') {
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
  readLine: () => Promise<string | null>,
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
      out.write('myshell-tools> ');
      const line = await readLine();

      // EOF → exit the chat loop gracefully
      if (line === null) break;

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
 * Never calls process.exit() — resolves when the user presses [q] or when
 * stdin reaches EOF (resolves cleanly, no ERR_USE_AFTER_CLOSE thrown).
 *
 * When `ctx.readLine` is provided (e.g. in tests), it is used directly in
 * place of a real readline interface. When absent, a readline interface is
 * created from `process.stdin` as usual; the `close` event is wired up so
 * that EOF resolves gracefully instead of throwing.
 */
export async function startMenu(ctx: MenuContext, out: OutputSink): Promise<void> {
  // Build the readLine function — either injected (for tests) or backed by a
  // real readline interface driven by the event-driven LineReader queue.
  let readLine: () => Promise<string | null>;
  let lineReader: LineReader | null = null;

  if (ctx.readLine !== undefined) {
    // Injected reader — no real readline needed.
    readLine = ctx.readLine;
  } else {
    // Create ONE readline interface for the whole menu lifecycle and drive it
    // through the event-driven queue (NOT per-prompt rl.question). This buffers
    // lines that arrive before they're awaited (fixing pipe eager-drain loss)
    // and resolves to `null` on EOF instead of throwing ERR_USE_AFTER_CLOSE.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: out.isTty,
    });
    lineReader = createLineReader(rl);
    const reader = lineReader;
    // All prompt text is already written to `out` before readLine() is called.
    readLine = () => reader.nextLine();
  }

  // Mutable local copy of config & env — updated as the user changes settings /
  // re-authenticates without mutating the immutable ctx parameter.
  const mutableCtx: { config: AppConfig; env: EnvironmentStatus } = {
    config: ctx.config,
    env: ctx.env,
  };

  try {
    // ---- A. First-run welcome -----------------------------------------------
    if (!mutableCtx.config.onboarded) {
      mutableCtx.config = await runWelcome(ctx, out, readLine, mutableCtx.config);
    }

    // ---- B. Main screen loop -------------------------------------------------
    while (true) {
      const metas = await ctx.store.list();
      await renderMainScreen(ctx, mutableCtx, metas, out);

      out.write('> ');
      const key = await readLine();

      // ---- EOF / close — exit gracefully (FIX 1: no ERR_USE_AFTER_CLOSE) ----
      if (key === null) {
        break;
      }

      // ---- [q] Quit -----------------------------------------------------------
      if (key === 'q') {
        break;
      }

      // ---- [n] New conversation -----------------------------------------------
      if (key === 'n') {
        out.write('First message (becomes the title): ');
        const firstMsg = await readLine();
        if (firstMsg !== null && firstMsg.length > 0) {
          const meta = await ctx.store.create(firstMsg);
          await runChatLoop(ctx, mutableCtx, meta.id, out, readLine);
        }
        continue;
      }

      // ---- [c] Continue most-recent conversation ------------------------------
      if (key === 'c') {
        const all = await ctx.store.list();
        const latest = all[0];
        if (latest !== undefined) {
          await runChatLoop(ctx, mutableCtx, latest.id, out, readLine);
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
          await runChatLoop(ctx, mutableCtx, target.id, out, readLine);
        } else {
          out.write(`No conversation at position ${digit}.\n`);
        }
        continue;
      }

      // ---- [e] Manage conversations -------------------------------------------
      if (key === 'e') {
        await runManage(ctx, out, readLine);
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
        await runSettings(ctx, mutableCtx, out, readLine);
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
    lineReader?.close();
  }
}
