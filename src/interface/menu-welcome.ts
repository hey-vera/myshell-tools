/**
 * src/interface/menu-welcome.ts — Extracted from menu.ts — behavior-preserving.
 *
 * First-run welcome / ~30-second setup flow: offer to install missing providers,
 * sign in, pick a mode, optionally set as default shell, and opt into launch
 * update checks. Returns the saved {@link AppConfig}.
 */

import type { AppConfig } from '../infra/config.js';
import { saveConfig } from '../infra/config.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { installCommandFor } from '../providers/install.js';
import type { ProviderId } from '../providers/port.js';
import type { LoginMethod } from '../commands/login.js';
import type { CommandGatePort } from '../core/command-gate.js';
import { runInstall, isHookInstalled } from '../commands/install.js';
import { levelLabel, LEVEL_DESC, ALL_LEVELS } from '../core/mode-levels.js';
import { box } from '../ui/tui.js';
import { dim, green } from '../ui/theme.js';
import { createSpinner } from '../ui/spinner.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import { type Confirm, readMenuKey } from './menu-key-confirm.js';
import { renderHeaderLines } from './menu-display.js';
import { yesNoHint } from './menu-questions.js';

export async function runWelcome(
  ctx: MenuContext,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  confirm: Confirm,
  suspendStdin: (() => () => void) | undefined,
  mutableConfig: AppConfig,
  installProviderFn: (id: ProviderId, out: OutputSink) => Promise<boolean>,
  loginFn: (
    out: OutputSink,
    providerArg?: string,
    opts?: {
      method?: LoginMethod;
      readLine?: () => Promise<string | null>;
      suspendStdin?: () => () => void;
      confirm?: Confirm;
      commandGate?: CommandGatePort;
    },
  ) => Promise<number>,
  detectEnvironmentFn: () => Promise<EnvironmentStatus>,
  // Single-key reader for the Ink path. When provided, the mode-select keypress
  // resolves on a SINGLE key through Ink's own input pipeline (the legacy raw
  // single-key feel). The install/sign-in/default-shell/update confirms are already
  // single-key via the passed-in `confirm`. Absent → legacy path is byte-identical.
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  // Use the mutable env so re-detection after installs is visible downstream.
  let env = ctx.env;

  const headerLines = renderHeaderLines(env, ctx.version);
  out.write('\n' + box(`myshell-tools v${ctx.version} — Setup`, headerLines) + '\n\n');

  // ---- Orientation header --------------------------------------------------
  out.write('Quick setup — a few questions, ~30 seconds. Press Enter for the default (marked (enter)), or y / n.\n\n');

  // ---- Offer to install any missing provider (claude / codex) --------------
  // Consent is required: we ask once per missing provider.
  // Display: (Y/n) — default YES, so Enter installs; explicit n skips.
  const providers: ProviderId[] = ['claude', 'codex'];
  let didInstallAny = false;

  for (const id of providers) {
    const ps = env[id];
    if (ps.installed) continue;

    const pkg = id === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
    out.write(`Install ${id} (${pkg})? ${yesNoHint('yes', out.color)} `);

    if (await confirm(true)) {
      const resumeStdin = suspendStdin?.();
      let ok = false;
      try {
        ok = await installProviderFn(id, out);
      } finally {
        resumeStdin?.();
      }
      if (ok) {
        didInstallAny = true;
      }
    } else {
      out.write(`Skipping ${id} install. Install later: ${installCommandFor(id)}\n`);
    }
  }

  // ---- Re-detect if anything was installed so sign-in offers are accurate --
  if (didInstallAny) {
    env = await detectEnvironmentFn();
  }

  // ---- Offer opencode (optional OpenCode account gateway) ------------------
  // Enter = yes, consistent with the claude/codex install prompts above (adding a
  // CLI is additive and easily removed). Decline with n.
  if (!env.opencode.installed) {
    out.write(`Add opencode? (optional — connect an OpenCode account) ${yesNoHint('yes', out.color)} `);
    if (await confirm(true)) {
      const resumeStdin = suspendStdin?.();
      let ok = false;
      try {
        ok = await installProviderFn('opencode', out);
      } finally {
        resumeStdin?.();
      }
      if (ok) {
        // Re-detect so downstream sign-in logic sees the freshly installed opencode.
        env = await detectEnvironmentFn();
      }
    }
    // No nag on skip — opencode is always discoverable via [o] in the main menu.
  }

  // ---- Offer grok (optional xAI Grok subscription gateway) -----------------
  // Enter = yes, consistent with the optional-provider install prompts above.
  if (!env.grok.installed) {
    out.write(`Add grok? (optional — connect an X / SuperGrok account) ${yesNoHint('yes', out.color)} `);
    if (await confirm(true)) {
      const resumeStdin = suspendStdin?.();
      let ok = false;
      try {
        ok = await installProviderFn('grok', out);
      } finally {
        resumeStdin?.();
      }
      if (ok) {
        env = await detectEnvironmentFn();
      }
    }
  }

  // ---- Offer sign-in for installed-but-unauthenticated providers -----------
  // grok now reports authenticated from a real credential probe (`grok models`),
  // so a freshly installed grok is offered sign-in here too.
  for (const id of ['claude', 'codex', 'opencode', 'grok'] as const) {
    const ps = env[id];
    if (!ps.installed || ps.authenticated) continue;

    out.write(`\nSign in to ${id}? ${yesNoHint('yes', out.color)} `);

    if (await confirm(true)) {
      // loginFn auto-detects the right method (code in containers/SSH where the
      // localhost OAuth callback can't be reached, browser on a desktop).
      // Pass readLine so the browser-failed "retry with code?" prompt shares the
      // menu's reader, and suspendStdin so the vendor CLI owns the terminal alone
      // during its interactive sign-in (no paste byte-race).
      await loginFn(out, id, {
        readLine,
        confirm,
        ...(suspendStdin !== undefined ? { suspendStdin } : {}),
      });
      // Keep onboarding's auth loop in sync with the credential the vendor just
      // persisted, so a completed sign-in cannot be offered again from stale env.
      env = await detectEnvironmentFn();
    }
  }

  // ---- Mode — optional picker, Auto (smart) is the default -----------------
  // No forced mode choice: Auto is on by default. Press 1-5 to set an explicit
  // mode, or Enter to keep the smart default. The picker uses the 5-level dial.
  // newMode === undefined means Auto (no config.mode persisted).
  out.write('\n');
  out.write('Mode: Auto (smart) is on by default.\n');
  out.write('  It chooses effort each turn from task, risk, goals, and provider headroom.\n');
  for (const level of ALL_LEVELS) {
    const idx = ALL_LEVELS.indexOf(level) + 1;
    const desc = LEVEL_DESC[level];
    const suffix = level === 'auto' ? `  ‹default›` : '';
    const line = `  [${idx}] ${levelLabel(level)}${level === 'auto' ? ' (smart)' : ''} — ${desc}${suffix}`;
    out.write(level === 'auto' ? line + '\n' : dim(line, out.color) + '\n');
  }
  out.write('\nPress Enter to keep Auto, or 1-5 to change: ');
  const modeKey = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  // EOF during setup — save bare onboarded config and return.
  // Use the mutable config's setAsDefault (now defaults to true) so the
  // default-on behaviour applies even when the user hits EOF before choosing.
  if (modeKey === null) {
    const saved: AppConfig = {
      onboarded: true,
      setAsDefault: mutableConfig.setAsDefault,
      ...(mutableConfig.mode !== undefined ? { mode: mutableConfig.mode } : {}),
      ...(mutableConfig.autoGoal === true ? { autoGoal: true } : {}),
    };
    await saveConfig(saved);
    return saved;
  }

  let newMode = mutableConfig.mode; // undefined means Auto (smart)
  if (modeKey === '1') newMode = undefined;       // Auto (smart)
  else if (modeKey === '2') newMode = 'cost-saver'; // Budget
  else if (modeKey === '3') newMode = 'balanced';   // Balanced
  else if (modeKey === '4') newMode = 'quality-first'; // High (alias Max)
  else if (modeKey === '5') newMode = 'quality-first'; // Max
  // Enter/empty/anything else → keep current (Auto smart default)

  const updated: AppConfig = {
    onboarded: mutableConfig.onboarded,
    setAsDefault: mutableConfig.setAsDefault,
    ...(newMode !== undefined ? { mode: newMode } : {}),
    ...(mutableConfig.autoGoal === true ? { autoGoal: true } : {}),
  };

  // Detect whether we're already the default shell BEFORE asking — show a quick
  // spinner, then a checkmark if so (no redundant prompt).
  const checkHook = ctx.isHookInstalled ?? (() => isHookInstalled(process.env, process.platform));
  const spinner = createSpinner(out);
  spinner.start('Checking your shell setup…');
  const alreadyDefault = await checkHook().catch(() => false);
  spinner.stop();
  let setAsDefault = alreadyDefault;
  if (alreadyDefault) {
    out.write(green('✓ Already set as your default shell tool.\n', out.color));
  } else {
    // Default YES: Enter installs the hook. Only the user choosing n skips it.
    out.write(`Set myshell-tools as your default shell tool? ${yesNoHint('yes', out.color)} `);
    const wantsDefault = await confirm(true);

    if (wantsDefault) {
      // Only persist true when the installer actually succeeds — honest persistence.
      const code = await runInstall(out);
      setAsDefault = code === 0;
    }
    // else: wantsDefault is false → setAsDefault stays alreadyDefault (false).
    // The caller persists defaultShellOptOut:true so the migration keeps it off.
  }

  // Default is YES: check for updates at launch and OFFER to install (we ask
  // first — never a silent swap). Opt out with n or via Settings.
  out.write(`Check for updates at launch (I'll show the version and ask first)? ${yesNoHint('yes', out.color)} `);
  const autoUpdate = await confirm(true);

  // The one setup-time disclosure (whole-tool-finish §1.1, §1.4): memory is the
  // only always-on surface that writes durable state about the user, so it gets a
  // single honest "memory is on; here's how to manage/turn it off" line — the
  // other four surfaces self-explain just-in-time via first-touch. Gated inside
  // runWelcome (so it's structurally once-only for fresh users; upgraders skip
  // runWelcome and meet memory via the first-touch line at their first approval).
  out.write(
    dim(
      "\nMemory is on — I'll remember preferences you approve. Turn it off or see what's stored anytime with /memory.\n",
      out.color,
    ),
  );

  const saved: AppConfig = {
    onboarded: true,
    setAsDefault,
    ...(alreadyDefault ? {} : { defaultShellOptOut: !setAsDefault } as Partial<AppConfig>),
    ...(updated.mode !== undefined ? { mode: updated.mode } : {}),
    ...(!autoUpdate ? { autoUpdate: false } : {}),
    ...(updated.autoGoal === true ? { autoGoal: true } : {}),
  };

  await saveConfig(saved);

  return saved;
}
