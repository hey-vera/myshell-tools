#!/usr/bin/env node
/**
 * src/cli.ts — single entry point for the myshell-tools CLI.
 *
 * This is the ONLY file in the project that may call process.exit().
 * All other modules return values and let this file decide the exit code.
 */

import { createRequire } from 'node:module';
import { execa } from 'execa';
import { systemClock } from './infra/clock.js';
import { createSessionWriter } from './infra/session.js';
import { createLedger, readLedger } from './infra/ledger.js';
import { learnProviderOrder } from './core/routing-memory.js';
import { DEFAULT_POLICY, POLICY_PRESETS, autoModeForPlans, classifyPlan } from './core/policy.js';
import type { PlanInfo } from './core/policy.js';
import type { OrchestrateDeps } from './core/types.js';
import type { OutputSink } from './interface/render.js';
import { runTask } from './interface/run.js';
import { startRepl } from './interface/repl.js';
import { startMenu } from './interface/menu.js';
import type { MenuContext } from './interface/menu.js';
import { buildProviders } from './providers/registry.js';
import { detectEnvironment } from './providers/detect.js';
import { createFileConversationStore } from './infra/conversations.js';
// Memory 5.5: the file-backed store + project-key resolver, now wired into
// per-turn deps assembly (Phase 4). Re-exported so it stays part of the package
// surface.
import { createFileUserMemoryStore, resolveProjectKey } from './infra/user-memory-store.js';
export { createFileUserMemoryStore };
import { resolveMemoryContext } from './core/memory-injection.js';
import { loadConfig, resolvePartnerStyle } from './infra/config.js';
import { makeIntentExtractor } from './core/intent-extractor.js';
import { replCapabilities } from './core/surface-capabilities.js';
import { checkForUpdate } from './infra/update-check.js';
import { refreshClaudeOauthIfNeeded } from './infra/claude-oauth-refresh.js';
import { syncConversationMirror } from './infra/session-mirror.js';
import { replitPersistentEnv } from './infra/credentials.js';
import { dim as dimText } from './ui/theme.js';
import { defaultStateDir, evaluateHealth, probeLedgerWritable, probeStateWritable } from './infra/health.js';
import { getStateDir } from './infra/paths.js';
import { isPricingStale } from './infra/pricing.js';
import { runDoctor } from './commands/doctor.js';
import { runCost } from './commands/cost.js';
import { runMemoryCli } from './commands/memory.js';
import { runLogin } from './commands/login.js';
import { runInstall } from './commands/install.js';
import { banner } from './ui/banner.js';
import { commandHelpText } from './ui/help.js';
import { createSpinner } from './ui/spinner.js';
import { dim } from './ui/theme.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const version: string = pkg.version as string;

/** Default hard wall-clock timeout (ms) for a single provider run. */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Resolve the per-run wall-clock timeout from loaded config, falling back to the
 * built-in default. Centralised so the menu path (and any future config-aware
 * path) shares one source of truth instead of a scattered magic number.
 */
function resolveTimeoutMs(config: import('./infra/config.js').AppConfig): number {
  return config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

const HELP = `\
myshell-tools v${version}

Usage: myshell-tools [command] [options]

Options:
  -h, --help     Show this help message
  -v, --version  Print version number

Commands:
  (none)            Open the interactive control panel (default)
  run <task...>     Run a one-shot task and exit
  repl              Start the plain line REPL (no menu)
  login [provider]  Sign in to a provider (claude, codex, or opencode) via its own OAuth.
                    Add --code to use the no-localhost flow (paste a code for
                    claude, device code for codex) — best inside containers /
                    over SSH. Add --browser to force the localhost flow.
  cost              Show real spend from the ledger with a per-model breakdown
  install           Write a guarded startup hook to your shell rc file so new
                    interactive shells launch myshell-tools automatically
  uninstall         Remove the startup hook written by "install"

Examples:
  myshell-tools                                 # open the control panel
  myshell-tools run "refactor the auth module"
  myshell-tools login
  myshell-tools login codex --code              # device-code sign-in (no localhost)

Repository: https://github.com/hey-vera/myshell-tools
`;

/** Build the orchestration dependencies from a pre-detected EnvironmentStatus. */
function buildDeps(
  cwd: string,
  env: import('./providers/detect.js').EnvironmentStatus,
  policy = DEFAULT_POLICY,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  learnedProviderOrder?: Partial<
    Record<import('./core/types.js').Tier, readonly import('./providers/port.js').ProviderId[]>
  >,
  // Inject a delay port only when Latency-Hedged Escalation is enabled (policy
  // hedgePolicy 'on'); absent → planHedge returns null and the sequential path
  // runs unchanged. setTimeout-based real impl (the pure core never calls it
  // directly). See core/hedge.ts.
  sleep?: (ms: number) => Promise<void>,
  // Pre-rendered, capped USER MEMORY block (Phase 4, memory §7). Computed by the
  // caller via resolveMemoryContext and threaded once so it rides sequential,
  // hedge, AND panel prompts through assembleContextBlocks. Absent/'' → omit.
  memoryContext?: string,
): OrchestrateDeps {
  const providers = buildProviders(cwd, env);

  // Populate advertised model lists from detection so route() can prefer a
  // model the provider CLI actually has. Only include installed providers.
  const availableModels: Partial<Record<import('./providers/port.js').ProviderId, readonly string[]>> = {};
  if (env.claude.installed && env.claude.availableModels.length > 0) {
    availableModels['claude'] = env.claude.availableModels;
  }
  if (env.codex.installed && env.codex.availableModels.length > 0) {
    availableModels['codex'] = env.codex.availableModels;
  }
  if (env.opencode.installed && env.opencode.availableModels.length > 0) {
    availableModels['opencode'] = env.opencode.availableModels;
  }

  // Collect authenticated providers so route() can prefer signed-in providers
  // over signed-out ones, preventing wasted attempts on unauthenticated installs.
  const authenticatedProviders: import('./providers/port.js').ProviderId[] = [];
  if (env.claude.authenticated) authenticatedProviders.push('claude');
  if (env.codex.authenticated) authenticatedProviders.push('codex');
  if (env.opencode.authenticated) authenticatedProviders.push('opencode');

  // Observed plan per authenticated provider — snapshot for adaptive flagship
  // admission (free-plan veto). Never fabricated (null plan → confidence 'none').
  const planInfos: Partial<Record<import('./providers/port.js').ProviderId, PlanInfo>> = {};
  if (env.claude.authenticated) planInfos['claude'] = classifyPlan(env.claude.plan);
  if (env.codex.authenticated) planInfos['codex'] = classifyPlan(env.codex.plan);
  if (env.opencode.authenticated) planInfos['opencode'] = classifyPlan(env.opencode.plan);

  return {
    clock: systemClock,
    session: createSessionWriter({ cwd, id: systemClock.uuid() }),
    ledger: createLedger({ cwd }),
    policy,
    providers,
    cwd,
    sandbox: 'workspace-write',
    timeoutMs,
    ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
    ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
    ...(Object.keys(planInfos).length > 0 ? { planInfos } : {}),
    ...(learnedProviderOrder !== undefined && Object.keys(learnedProviderOrder).length > 0
      ? { learnedProviderOrder }
      : {}),
    ...(sleep !== undefined ? { sleep } : {}),
    ...(memoryContext !== undefined && memoryContext.length > 0 ? { memoryContext } : {}),
  };
}

/** Honest one-line welcome: which providers were actually detected. */
function welcome(deps: OrchestrateDeps, color: boolean): string {
  const ready = Object.keys(deps.providers);
  if (ready.length > 0) {
    return dim(
      `Providers: ${ready.join(', ')}.  Type a task and press Enter, or /help.  ` +
        `Not signed in? run: myshell-tools login`,
      color,
    );
  }
  return dim(
    'No providers detected.  Install Claude Code or Codex, then run: myshell-tools login  ' +
      '(diagnose: myshell-tools doctor)',
    color,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    // Focused per-command help (e.g. `login --help`) when the first arg is a
    // known command; otherwise the global command list.
    const cmdHelp = args[0] !== undefined ? commandHelpText(args[0]) : null;
    process.stdout.write(cmdHelp ?? HELP);
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }

  const cwd = process.cwd();
  const out: OutputSink = {
    write: (s) => {
      process.stdout.write(s);
    },
    color: process.stdout.isTTY === true && !process.env['NO_COLOR'],
    isTty: process.stdout.isTTY === true,
  };

  // ---- Keep Claude signed in across restarts ---------------------------------
  // Refresh Claude's OAuth token IN PLACE if it's expired or close to it, BEFORE
  // detecting providers, so detection (and any spawned claude) sees a fresh token
  // — this is what makes "sign in once, the container just remembers" hold even
  // after the access token would otherwise have lapsed. Best-effort: a no-op
  // (valid/no-creds) in the common case, a ≤5s network call only when actually
  // near expiry, never throws, never blocks a command from running.
  {
    const refreshEnv = { ...process.env, ...replitPersistentEnv(process.env, cwd) };
    const r = await refreshClaudeOauthIfNeeded({ env: refreshEnv, cwd }).catch(() => undefined);
    if (r?.action === 'refreshed' && out.isTty) {
      out.write(
        dimText(
          `✓ Claude session kept alive (refreshed${r.hoursLeft !== undefined ? `, ~${r.hoursLeft}h left` : ''}).\n`,
          out.color,
        ),
      );
    }
  }

  // ---- Back up conversations into the append-only archive --------------------
  // Grow-only mirror so a deleted/corrupted conversation is still recoverable.
  // Best-effort, fast (a stat per file, copy only when grown), never throws.
  await syncConversationMirror().catch(() => undefined);

  // ---- Commands that do NOT need provider detection --------------------------
  if (args[0] === 'login') {
    const rest = args.slice(1);
    // --code / --device → no-localhost paste/device flow; --browser → force the
    // localhost flow. Omitted → auto-detect (headless envs default to code).
    const method =
      rest.includes('--code') || rest.includes('--device')
        ? ('code' as const)
        : rest.includes('--browser')
          ? ('browser' as const)
          : undefined;
    const provider = rest.find((a) => !a.startsWith('-'));
    process.exit(await runLogin(out, provider, method !== undefined ? { method } : undefined));
  }

  // Health check — surfaced automatically in the control panel, so this is no
  // longer an advertised command. Kept as a hidden, scriptable entry point for
  // support/CI; `status` and `check` are friendlier aliases for the old
  // `doctor` name (which still works for muscle-memory / existing scripts).
  if (args[0] === 'doctor' || args[0] === 'status' || args[0] === 'check') {
    const fix = args.includes('--fix');
    process.exit(await runDoctor(out, fix ? { fix: true } : undefined));
  }

  if (args[0] === 'cost') {
    process.exit(await runCost(cwd, out));
  }

  // ---- Memory one-shot subcommands (Phase 5, memory doc §8(a)) ---------------
  // `memory list | add "<fact>" | forget <id> | export`. No provider detection,
  // no model call — deterministic store I/O. The interactive `/remember`,
  // `/forget`, `/memory` live in the chat loop (menu.ts).
  if (args[0] === 'memory') {
    process.exit(await runMemoryCli(args.slice(1), cwd, out, systemClock));
  }

  if (args[0] === 'install') {
    process.exit(await runInstall(out));
  }

  if (args[0] === 'uninstall') {
    process.exit(await runInstall(out, { uninstall: true }));
  }

  // ---- One-shot run ----------------------------------------------------------
  if (args[0] === 'run') {
    const taskParts = args.slice(1);
    if (taskParts.length === 0) {
      process.stderr.write('myshell-tools run: expected a task description\n');
      process.exit(1);
    }
    const [env, config] = await Promise.all([detectEnvironment(), loadConfig()]);
    // Resolve mode across all authenticated providers when mode is unset (auto).
    const resolvedMode = config.mode ?? autoModeForPlans(
      [env.claude, env.codex, env.opencode]
        .filter((p) => p.authenticated)
        .map((p) => p.plan),
    );
    // EXPERIMENTAL: opt-in Parallel Subscription Panel (config.panel) maps to
    // policy.panelPolicy 'hard-turns'. Absent/false → unchanged sequential path.
    // Opt-in Latency-Hedged Escalation (config.hedge) maps to hedgePolicy 'on'.
    const policy = {
      ...POLICY_PRESETS[resolvedMode],
      ...(config.panel === true ? { panelPolicy: 'hard-turns' as const } : {}),
      ...(config.hedge === true ? { hedgePolicy: 'on' as const } : {}),
    };
    // EXPERIMENTAL Local Outcome Learner (opt-in via config.learnRouting;
    // default off → not read, no field, routing unchanged). Read the ledger once
    // and learn a per-tier provider order from this user's own recorded outcomes
    // (observed-only: success + duration). Pre-filter to the most recent 500
    // entries so stale history doesn't dominate.
    let learnedProviderOrder:
      | Partial<Record<import('./core/types.js').Tier, readonly import('./providers/port.js').ProviderId[]>>
      | undefined;
    if (config.learnRouting === true) {
      const recent = (await readLedger(cwd)).slice(-500);
      const learned: Partial<
        Record<import('./core/types.js').Tier, readonly import('./providers/port.js').ProviderId[]>
      > = {};
      for (const tier of ['worker', 'ic', 'manager'] as const) {
        const order = learnProviderOrder(recent, tier);
        if (order !== null) learned[tier] = order;
      }
      if (Object.keys(learned).length > 0) learnedProviderOrder = learned;
    }
    const task = taskParts.join(' ');
    // ---- USER MEMORY (Phase 4, §7) — read-only inject for the one-shot path.
    // Resolve the project key, run the lazy decay sweep on open, select+render
    // the relevant facts, and markUsed the relevance-selected ids. Fully
    // fail-soft (any store error → no memory injected). The non-TTY one-shot
    // path never prompts — it injects read-only. Skipped entirely when the
    // memory kill-switch is set (config.memory===false).
    const memoryContext = await resolveMemoryContext({
      store: createFileUserMemoryStore({ clock: systemClock }),
      task,
      projectKey: await resolveProjectKey(cwd),
      partnerStyle: resolvePartnerStyle(config, resolvedMode),
      nowIso: systemClock.isoNow(),
      config,
    }).catch(() => '');
    const deps = buildDeps(
      cwd,
      env,
      policy,
      resolveTimeoutMs(config),
      learnedProviderOrder,
      config.hedge === true ? (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)) : undefined,
      memoryContext,
    );
    const result = await runTask(task, deps, out, new AbortController().signal);
    // Notify-only update nudge for the scripted / one-shot path. The interactive
    // menu auto-updates, but `run` must NEVER swap the binary mid-task. Written
    // to stderr and TTY-guarded so it can't corrupt piped stdout or spam CI logs.
    if (process.stderr.isTTY === true) {
      const upd = await checkForUpdate({ currentVersion: version, now: Date.now() }).catch(
        () => undefined,
      );
      if (upd?.updateAvailable === true && upd.latest !== null) {
        process.stderr.write(
          `\n▲ myshell-tools ${upd.current} → ${upd.latest} available — npm install -g myshell-tools@latest\n`,
        );
      }
    }
    process.exit(result.code);
  }

  // ---- Interactive Menu (default — sessions-first control panel) ------------
  if (args.length === 0) {
    const spinner = createSpinner(out);
    spinner.start('Detecting providers…');
    const [env, config, stateWritable, ledgerWritable] = await Promise.all([
      detectEnvironment(),
      loadConfig(),
      probeStateWritable(cwd),
      probeLedgerWritable(cwd),
    ]);
    const providers = buildProviders(cwd, env);
    spinner.stop();

    // Evaluate non-provider environment health once at startup. Surfaced in the
    // menu only when a problem exists — the user never runs a health command.
    const healthIssues = evaluateHealth({
      nodeVersion: process.version,
      stateWritable,
      stateDir: defaultStateDir(),
      ledgerWritable,
      ledgerDir: getStateDir(cwd),
      pricingStale: isPricingStale(),
    });

    const store = createFileConversationStore({
      clock: systemClock,
      onWarning: (message) => {
        out.write(`\n[warn] ${message}\n`);
      },
    });
    const ledger = createLedger({ cwd });

    const menuCtx: MenuContext = {
      version,
      clock: systemClock,
      ledger,
      providers,
      env,
      store,
      config,
      cwd,
      sandbox: 'workspace-write',
      timeoutMs: resolveTimeoutMs(config),
      healthIssues,
      checkForUpdate: () => checkForUpdate({ currentVersion: version, now: Date.now() }),
      updateSelf: async (updateOut) => {
        try {
          const result = await execa('npm', ['install', '-g', 'myshell-tools@latest'], {
            stdio: 'inherit',
            reject: false,
          });
          return result.exitCode === 0;
        } catch {
          updateOut.write('Update failed — run: npm install -g myshell-tools@latest\n');
          return false;
        }
      },
      activeVersion: async () => {
        try {
          const result = await execa('myshell-tools', ['--version'], {
            reject: false,
          });
          if (result.exitCode !== 0) return null;
          const active = result.stdout.trim();
          return active.length > 0 ? active : null;
        } catch {
          return null;
        }
      },
      relaunch: async () => {
        try {
          const result = await execa('myshell-tools', process.argv.slice(2), {
            stdio: 'inherit',
            reject: false,
          });
          return result.exitCode ?? 0;
        } catch {
          return 1;
        }
      },
    };

    await startMenu(menuCtx, out);
    process.exit(0);
  }

  // ---- Interactive REPL (legacy subcommand) ----------------------------------
  if (args[0] === 'repl') {
    out.write(banner(version, out.color) + '\n');
    const spinner = createSpinner(out);
    spinner.start('Detecting providers…');
    const [env, config] = await Promise.all([detectEnvironment(), loadConfig()]);
    const replMode = config.mode ?? autoModeForPlans(
      [env.claude, env.codex, env.opencode]
        .filter((p) => p.authenticated)
        .map((p) => p.plan),
    );
    const replPolicy = POLICY_PRESETS[replMode];
    spinner.stop();

    // REPL asymmetry (whole-tool-finish §4): the REPL is the lean SUBSET. It still
    // gets memory INJECTION + the intent FRAME "for free" because those are
    // deps/prompt concerns, not UI (the matrix's repl:true rows) — so the same
    // shared core delivers memory-aware, intent-sharpened answers. It does NOT get
    // memory-approval / intent-reflection / recap / queue/ESC (the menu-only TUI
    // affordances). The capability matrix is the single source of truth for what
    // is wired here; replCapabilities() drives the read-only deps below.
    const caps = new Set(replCapabilities());

    // Memory injection (read-only): resolved once for the session (the REPL is
    // stateless-per-line and project-scoped, so a single resolve is faithful and
    // cheap). Fail-soft → '' (no memory) on any error.
    let memoryContext = '';
    if (caps.has('memoryInjection')) {
      memoryContext = await resolveMemoryContext({
        store: createFileUserMemoryStore({ clock: systemClock }),
        task: '',
        projectKey: await resolveProjectKey(cwd).catch(() => null),
        partnerStyle: resolvePartnerStyle(config, replMode),
        nowIso: systemClock.isoNow(),
        config,
      }).catch(() => '');
    }

    const baseDeps = buildDeps(
      cwd,
      env,
      replPolicy,
      resolveTimeoutMs(config),
      undefined,
      undefined,
      memoryContext,
    );

    // Intent FRAME (deps concern, not UI): a read-only extractor for sharper
    // prompts. Gated by config.intentEngine like the menu; absent → rules frame.
    const INTENT_TIMEOUT_MS = 8_000;
    const replIntentExtractor =
      caps.has('intentFrame') && config.intentEngine !== false
        ? makeIntentExtractor({
            providers: baseDeps.providers,
            policy: replPolicy,
            cwd,
            timeoutMs: Math.min(resolveTimeoutMs(config), INTENT_TIMEOUT_MS),
            ...(baseDeps.availableModels !== undefined
              ? { availableModels: baseDeps.availableModels }
              : {}),
            ...(baseDeps.authenticatedProviders !== undefined
              ? { authenticatedProviders: baseDeps.authenticatedProviders }
              : {}),
          })
        : undefined;

    const deps: OrchestrateDeps = {
      ...baseDeps,
      partnerStyle: resolvePartnerStyle(config, replMode),
      ...(replIntentExtractor !== undefined ? { intentExtractor: replIntentExtractor } : {}),
    };

    out.write(welcome(deps, out.color) + '\n\n');
    await startRepl(deps, out);
    process.exit(0);
  }

  // ---- Unknown command -------------------------------------------------------
  process.stderr.write(
    `myshell-tools: unknown command "${args[0] ?? ''}"\nRun myshell-tools --help for usage.\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
