#!/usr/bin/env node
/**
 * src/cli.ts — single entry point for the myshell-tools CLI.
 *
 * This is the ONLY file in the project that may call process.exit().
 * All other modules return values and let this file decide the exit code.
 */

import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { prefixForRunningEntry } from './infra/update-prefix.js';
import { systemClock } from './infra/clock.js';
import { createSessionWriter } from './infra/session.js';
import { createLedger, readLedger } from './infra/ledger.js';
import { learnProviderOrder, learnModelOutcomeOrder } from './core/routing-memory.js';
import {
  DEFAULT_POLICY,
  POLICY_PRESETS,
  autoModeForPlans,
  classifyPlan,
  tunePolicyForMaxSubTier,
} from './core/policy.js';
import type { PlanInfo } from './core/policy.js';
import type { OrchestrateDeps } from './core/types.js';
import type { OutputSink } from './interface/render.js';
import { runTask } from './interface/run.js';
import { resolveImageAttachments } from './infra/attachments.js';
import { startRepl } from './interface/repl.js';
import { startMenu } from './interface/menu.js';
import { hasAuthenticatedProvider } from './interface/menu-auto-mode.js';
import type { MenuContext } from './interface/menu.js';
import { StartupInputBuffer } from './interface/startup-input.js';
import type { StartupInputStream } from './interface/startup-input.js';
import { buildAuthenticatedProviders } from './providers/registry.js';
import { detectEnvironment } from './providers/detect.js';
import { createFileConversationStore } from './infra/conversations.js';
// Memory 5.5: the file-backed store + project-key resolver, now wired into
// per-turn deps assembly (Phase 4). Re-exported so it stays part of the package
// surface.
import { createFileUserMemoryStore, resolveProjectKey } from './infra/user-memory-store.js';
export { createFileUserMemoryStore };
import { resolveMemoryContext } from './core/memory-injection.js';
import { buildEnvironmentContext } from './core/repo-map.js';
import {
  buildToolStateContext,
  buildCapabilitySummary,
  type ToolStateProvider,
  type CapabilitySelfAwarenessSummary,
} from './core/tool-state.js';
import { refreshCapabilities } from './core/model-capability-refresh.js';
import { createCapabilityRefreshPort } from './infra/model-capability-port.js';
import { nodeRepoScanPort } from './infra/repo-scan.js';
import { loadConfig, resolvePartnerStyle } from './infra/config.js';
import { makeIntentExtractor } from './core/intent-extractor.js';
import { replCapabilities } from './core/surface-capabilities.js';
import { checkForUpdate } from './infra/update-check.js';
import { refreshClaudeOauthIfNeeded } from './infra/claude-oauth-refresh.js';
import { syncConversationMirror } from './infra/session-mirror.js';
import { replitPersistentEnv } from './infra/credentials.js';
import { helperSandbox, sandboxForEnvironment } from './infra/sandbox.js';
import { dim as dimText } from './ui/theme.js';
import { defaultStateDir, evaluateHealth, probeLedgerWritable, probeStateWritable } from './infra/health.js';
import { getStateDir } from './infra/paths.js';
import { isPricingStale } from './infra/pricing.js';
import { runDoctor } from './commands/doctor.js';
import { runCost } from './commands/cost.js';
import { runEvalCommand } from './commands/eval.js';
import { runMemoryCli } from './commands/memory.js';
import { runLogin } from './commands/login.js';
import { runInstall, isHookInstalled } from './commands/install.js';
import { banner } from './ui/banner.js';
import { commandHelpText } from './ui/help.js';
import { createSpinner } from './ui/spinner.js';
import { dim } from './ui/theme.js';
import { inkEnabled } from './interface/ui/flag.js';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const version: string = pkg.version as string;

/** Display labels for the three providers (shared with the menu's PROVIDER_LABEL). */
const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
};

/**
 * Refresh the Model Capability Registry (Stage 1) and build the capped
 * self-awareness summary from the live detection facts + the local Codex cache.
 * Cheap, gathered once per session like environmentContext, and FULLY fail-soft:
 * any error → `undefined` (the ABOUT block renders exactly as before). NO model
 * call, NO network. Shared by the one-shot and repl paths.
 */
async function gatherCapabilitySummary(
  env: import('./providers/detect.js').EnvironmentStatus,
  cwd: string,
): Promise<
  | {
      readonly summary: CapabilitySelfAwarenessSummary | undefined;
      readonly registry: import('./core/model-capabilities.js').CapabilityRegistry;
    }
  | undefined
> {
  try {
    // ONE refresh; we keep BOTH the structured registry (Stage 3 — threaded into
    // OrchestrateDeps so route()/selectReasoningEffort can use it) AND the capped
    // self-awareness summary (Stage 1). Do NOT recompute either separately.
    const { registry } = await refreshCapabilities(
      {
        providers: [env.claude, env.codex, env.opencode, env.grok].map((p) => ({
          provider: p.id,
          authenticated: p.authenticated,
          availableModels: p.availableModels,
        })),
        nowIso: systemClock.isoNow(),
      },
      createCapabilityRefreshPort(process.env, cwd),
    );
    const summary = buildCapabilitySummary(
      registry,
      {
        claude: env.claude.authenticated,
        codex: env.codex.authenticated,
        opencode: env.opencode.authenticated,
        grok: env.grok.authenticated,
      },
      (p) => PROVIDER_LABEL[p] ?? p,
    );
    return { summary, registry };
  } catch {
    return undefined;
  }
}

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
  login [provider]  Sign in to a provider (claude, codex, opencode, or grok) via its own OAuth.
                    Add --code to use the no-localhost flow (paste a code for
                    claude, device code for codex/grok) — best inside containers /
                    over SSH. Add --browser to force the localhost flow.
  cost              Show real spend from the ledger with a per-model breakdown
  eval              Run the frozen answer-quality ruler (Phase 0). Opt-in + cost-
                    stated: prints the cost and exits unless you pass --yes. Add
                    --compare to diff the latest two stored runs (no model calls).
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
  // Pre-rendered, capped ENVIRONMENT / repo-map orientation block (E1, codebase-
  // awareness §1.2). Gathered once for the one-shot run via buildEnvironmentContext
  // and threaded so orientation rides every prompt builder. Absent/'' → omit.
  environmentContext?: string,
  // Pre-rendered TOOL-STATE / "ABOUT THIS TOOL" block (tool self-awareness): authed
  // subscriptions + plans, the effective mode (auto vs explicit), smart-routing
  // state, and what the tool can do. Pure assembly, NO model call. Absent/'' → omit.
  toolStateContext?: string,
  // The merged structured capability registry (Stage 3) — the SAME snapshot the
  // self-awareness summary above was derived from (REUSED, not recomputed). When
  // present, orchestrate threads it into route()/selectReasoningEffort. Absent →
  // no capability context, no effort flag (byte-for-byte unchanged routing).
  capabilityRegistry?: import('./core/model-capabilities.js').CapabilityRegistry,
  // Stage 4 (§2 Layer 3): learned MODEL-level outcome order per task kind, computed
  // by the caller from this user's own ledger (learnModelOutcomeOrder). Absent /
  // below-threshold → no entry → route() gets no learned tie-break (unchanged).
  modelOutcomeOrderByTaskKind?: Partial<
    Record<
      import('./core/model-capabilities.js').TaskKind,
      readonly import('./core/model-capabilities.js').ModelPreference[]
    >
  >,
): OrchestrateDeps {
  const providers = buildAuthenticatedProviders(cwd, env);

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
  if (env.grok.installed && env.grok.availableModels.length > 0) {
    availableModels['grok'] = env.grok.availableModels;
  }

  // Collect authenticated providers so route() can prefer signed-in providers
  // over signed-out ones, preventing wasted attempts on unauthenticated installs.
  const authenticatedProviders: import('./providers/port.js').ProviderId[] = [];
  if (env.claude.authenticated) authenticatedProviders.push('claude');
  if (env.codex.authenticated) authenticatedProviders.push('codex');
  if (env.opencode.authenticated) authenticatedProviders.push('opencode');
  if (env.grok.authenticated) authenticatedProviders.push('grok');

  // Observed plan per authenticated provider — snapshot for adaptive flagship
  // admission (free-plan veto). Never fabricated (null plan → confidence 'none').
  const planInfos: Partial<Record<import('./providers/port.js').ProviderId, PlanInfo>> = {};
  if (env.claude.authenticated) planInfos['claude'] = classifyPlan(env.claude.plan);
  if (env.codex.authenticated) planInfos['codex'] = classifyPlan(env.codex.plan);
  if (env.opencode.authenticated) planInfos['opencode'] = classifyPlan(env.opencode.plan);
  if (env.grok.authenticated) planInfos['grok'] = classifyPlan(env.grok.plan);

  return {
    clock: systemClock,
    session: createSessionWriter({ cwd, id: systemClock.uuid() }),
    ledger: createLedger({ cwd }),
    policy,
    providers,
    cwd,
    sandbox: sandboxForEnvironment('workspace-write'),
    timeoutMs,
    ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
    ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
    ...(Object.keys(planInfos).length > 0 ? { planInfos } : {}),
    ...(capabilityRegistry !== undefined ? { capabilityRegistry } : {}),
    ...(learnedProviderOrder !== undefined && Object.keys(learnedProviderOrder).length > 0
      ? { learnedProviderOrder }
      : {}),
    ...(modelOutcomeOrderByTaskKind !== undefined &&
    Object.keys(modelOutcomeOrderByTaskKind).length > 0
      ? { modelOutcomeOrderByTaskKind }
      : {}),
    ...(sleep !== undefined ? { sleep } : {}),
    ...(memoryContext !== undefined && memoryContext.length > 0 ? { memoryContext } : {}),
    ...(environmentContext !== undefined && environmentContext.length > 0
      ? { environmentContext }
      : {}),
    ...(toolStateContext !== undefined && toolStateContext.length > 0
      ? { toolStateContext }
      : {}),
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
  // Keep grok signed in across Replit sessions. Unlike claude/codex/opencode —
  // whose persistent dirs (CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_*) the replit-tools
  // wrapper already sets — nothing sets GROK_HOME, so grok's ~/.grok creds are
  // ephemeral. Apply the persistent-dir redirect to process.env ONCE here (before
  // any detection or spawn) so detection, the work spawn, and login all agree.
  // No-op off Replit / when GROK_HOME is already set / before the first grok login.
  {
    const grokHome = replitPersistentEnv(process.env, cwd)['GROK_HOME'];
    if (grokHome !== undefined && process.env['GROK_HOME'] === undefined) {
      process.env['GROK_HOME'] = grokHome;
    }
  }
  const out: OutputSink = {
    write: (s) => {
      process.stdout.write(s);
    },
    color: process.stdout.isTTY === true && !process.env['NO_COLOR'],
    isTty: process.stdout.isTTY === true,
  };
  const startupConfigPromise = args.length === 0 ? loadConfig() : null;
  let startupInput =
    args.length === 0 &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    inkEnabled(process.env, undefined)
      ? new StartupInputBuffer()
      : null;
  startupInput?.arm(process.stdin as unknown as StartupInputStream);
  const startupConfig = startupConfigPromise !== null ? await startupConfigPromise : null;
  // Propagate the persisted color theme into the environment before any ANSI
  // rendering so theme.ts's isLightTheme() sees the correct value for the full
  // session. Only light needs explicit signaling; dark is the default.
  if (startupConfig?.colorTheme === 'light') {
    process.env['MYSHELL_THEME'] = 'light';
  }
  if (startupInput !== null && !inkEnabled(process.env, startupConfig ?? undefined)) {
    startupInput.dispose();
    startupInput = null;
  }

  try {
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
    } else if ((r?.action === 'expired-no-refresh' || r?.action === 'failed') && out.isTty) {
      // The refresh token is gone (expired-no-refresh) or the refresh endpoint/write
      // failed — the user MUST re-login. Surface a one-line, actionable pointer at
      // startup so they don't only learn indirectly via "not signed in" later. Dim,
      // non-blocking, fail-soft: the command still runs (it'll just hit the not-
      // signed-in path if it needs Claude).
      out.write(
        dimText(
          `Claude session expired — run: myshell-tools login claude --code\n`,
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

  // ---- Eval: the owner-invoked answer-quality ruler (Phase 0) ----------------
  // Reads-only on `--compare`; otherwise opt-in + cost-stated, and spends quota
  // ONLY with `--yes`. Reuses the SAME real answer path (orchestrate via buildDeps)
  // and the cross-vendor provider machinery — no API key, no metered eval service.
  if (args[0] === 'eval') {
    const evalArgs = args.slice(1);
    // `--compare` is read-only — skip provider detection entirely.
    if (evalArgs.includes('--compare')) {
      process.exit(
        await runEvalCommand(
          evalArgs,
          {
            cwd,
            version,
            nowIso: () => systemClock.isoNow(),
            providers: {},
            policy: DEFAULT_POLICY,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            authenticatedProviders: [],
            // --compare is read-only and returns before any run; this is never called.
            makeDeps: () => {
              throw new Error('compare mode does not run prompts');
            },
          },
          out,
          new AbortController().signal,
        ),
      );
    }
    const [env, config] = await Promise.all([detectEnvironment(), loadConfig()]);
    const resolvedMode = config.mode ?? autoModeForPlans(
      [env.claude, env.codex, env.opencode, env.grok]
        .filter((p) => p.authenticated)
        .map((p) => p.plan),
    );
    const policy = POLICY_PRESETS[resolvedMode];
    const providers = buildAuthenticatedProviders(cwd, env);
    const authenticatedProviders: import('./providers/port.js').ProviderId[] = [];
    if (env.claude.authenticated) authenticatedProviders.push('claude');
    if (env.codex.authenticated) authenticatedProviders.push('codex');
    if (env.opencode.authenticated) authenticatedProviders.push('opencode');
    if (env.grok.authenticated) authenticatedProviders.push('grok');
    const availableModels: Partial<Record<import('./providers/port.js').ProviderId, readonly string[]>> = {};
    if (env.claude.installed && env.claude.availableModels.length > 0) availableModels['claude'] = env.claude.availableModels;
    if (env.codex.installed && env.codex.availableModels.length > 0) availableModels['codex'] = env.codex.availableModels;
    if (env.opencode.installed && env.opencode.availableModels.length > 0) availableModels['opencode'] = env.opencode.availableModels;
    if (env.grok.installed && env.grok.availableModels.length > 0) availableModels['grok'] = env.grok.availableModels;
    const code = await runEvalCommand(
      evalArgs,
      {
        cwd,
        version,
        nowIso: () => systemClock.isoNow(),
        providers,
        policy,
        timeoutMs: resolveTimeoutMs(config),
        sandbox: helperSandbox(sandboxForEnvironment('workspace-write')),
        authenticatedProviders,
        ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
        // Fresh deps per prompt — same real answer path the `run` subcommand uses.
        makeDeps: () => buildDeps(cwd, env, policy, resolveTimeoutMs(config)),
      },
      out,
      new AbortController().signal,
    );
    process.exit(code);
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
    // Fast auth pre-check: a one-shot `run` with NO signed-in provider should give
    // clear guidance, not attempt work against an unauthenticated CLI (which can
    // hang or error opaquely). Mirrors `doctor`'s "Not ready" message. opencode
    // counts as authenticated when installed (free models), so this only fires for
    // a genuinely signed-out setup.
    if (!hasAuthenticatedProvider(env)) {
      process.stderr.write(
        'No providers are signed in. Run `myshell-tools login` to sign in ' +
          '(claude, codex, opencode, or grok), then try again.\n',
      );
      process.exit(1);
    }
    // Resolve mode across all authenticated providers when mode is unset (auto).
    const resolvedMode = config.mode ?? autoModeForPlans(
      [env.claude, env.codex, env.opencode, env.grok]
        .filter((p) => p.authenticated)
        .map((p) => p.plan),
    );
    // EXPERIMENTAL: opt-in Parallel Subscription Panel (config.panel) maps to
    // policy.panelPolicy 'hard-turns'. Absent/false → unchanged sequential path.
    // Opt-in Latency-Hedged Escalation (config.hedge) maps to hedgePolicy 'on'.
    // Quota-aware auto tuning: when mode is AUTO (unset), narrow the Max panel to
    // 2 providers for a detected Max 5x account; explicit-mode users are untouched.
    const autoTunedPreset =
      config.mode === undefined
        ? tunePolicyForMaxSubTier(
            POLICY_PRESETS[resolvedMode],
            [env.claude, env.codex, env.opencode, env.grok]
              .filter((p) => p.authenticated)
              .map((p) => p.plan),
          )
        : POLICY_PRESETS[resolvedMode];
    const policy = {
      ...autoTunedPreset,
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
    // Stage 4 (§2 Layer 3): the model-level outcome order per task kind, learned
    // from the SAME recent-ledger slice. Weakest signal; below-threshold task
    // kinds get no entry (learnModelOutcomeOrder → null) so routing is unchanged.
    let modelOutcomeOrderByTaskKind:
      | Partial<
          Record<
            import('./core/model-capabilities.js').TaskKind,
            readonly import('./core/model-capabilities.js').ModelPreference[]
          >
        >
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
      const byKind: Partial<
        Record<
          import('./core/model-capabilities.js').TaskKind,
          readonly import('./core/model-capabilities.js').ModelPreference[]
        >
      > = {};
      for (const kind of [
        'trivial', 'implementation', 'debug', 'review', 'architecture', 'large-context', 'unknown',
      ] as const) {
        const order = learnModelOutcomeOrder(recent, kind);
        if (order !== null) byKind[kind] = order;
      }
      if (Object.keys(byKind).length > 0) modelOutcomeOrderByTaskKind = byKind;
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
    // ENVIRONMENT / repo-map orientation block (E1, codebase-awareness §1.2):
    // gather the deterministic block once for the one-shot run. Fully fail-soft
    // (→ ''), NO model call. Kill-switch: config.codebaseAwareness === false → skip.
    const environmentContext =
      config.codebaseAwareness === false
        ? ''
        : await buildEnvironmentContext(cwd, nodeRepoScanPort).catch(() => '');
    // TOOL SELF-AWARENESS (tool-state §): render the authoritative "ABOUT THIS
    // TOOL" block from the live env + effective mode + config so the partner
    // answers the user's setup/mode questions from truth. Pure, NO model call.
    // MODEL CAPABILITY REGISTRY (Stage 1, §4) — refresh the objective capability
    // facts once per one-shot run (cheap, fully fail-soft, NO model call) and feed
    // the capped summary into the self-awareness block. Missing/corrupt Codex cache
    // degrades to detection/declarative facts (reasoning efforts "unknown").
    const capability = await gatherCapabilitySummary(env, cwd);
    const toolStateContext = buildToolStateContext({
      version,
      providers: [env.claude, env.codex, env.opencode, env.grok].map(
        (p): ToolStateProvider => ({
          label: PROVIDER_LABEL[p.id] ?? p.id,
          installed: p.installed,
          authenticated: p.authenticated,
          plan: p.plan,
        }),
      ),
      mode: resolvedMode,
      modeIsAuto: config.mode === undefined,
      smartRoute: config.smartRoute !== false,
      ...(capability?.summary !== undefined ? { capabilitySummary: capability.summary } : {}),
    });
    const deps = buildDeps(
      cwd,
      env,
      policy,
      resolveTimeoutMs(config),
      learnedProviderOrder,
      config.hedge === true ? (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)) : undefined,
      memoryContext,
      environmentContext,
      toolStateContext,
      capability?.registry,
      modelOutcomeOrderByTaskKind,
    );
    // Image attachments (audit #4, image scope): the IMPURE existence check lives
    // here (fs allowed). The pure extractor finds candidate image paths in the
    // task; we keep only those that exist on disk and thread them onto deps so
    // orchestrate sets needsVision + passes them to a vision-capable provider.
    // No real image → empty → field omitted → behaviour byte-for-byte unchanged.
    const imageAttachments = resolveImageAttachments(task, { cwd });
    const depsWithAttachments: OrchestrateDeps =
      imageAttachments.length > 0 ? { ...deps, attachments: imageAttachments } : deps;
    const result = await runTask(task, depsWithAttachments, out, new AbortController().signal);
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
      startupConfigPromise ?? loadConfig(),
      probeStateWritable(cwd),
      probeLedgerWritable(cwd),
    ]);
    const providers = buildAuthenticatedProviders(cwd, env);
    spinner.stop();

    // Self-heal "set as default shell" so the setting actually matches reality
    // after events that clear the rc file (Replit container restart makes ~ ephemeral;
    // new shells won't auto-launch until the hook is back in the current rc).
    // If the persisted config says the user wants default but the live check says
    // no hook in the rc that *this* shell will source, re-apply now. This makes
    // "enabled in settings" actually cause auto-pop on new shells / after resume-kill.
    // Best-effort only; errors never block the menu.
    if (config.setAsDefault) {
      try {
        const hookPresent = await isHookInstalled(process.env, process.platform).catch(() => false);
        if (!hookPresent) {
          await runInstall(out).catch(() => undefined);
        }
      } catch {
        // never block launch
      }
    }

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
      sandbox: sandboxForEnvironment('workspace-write'),
      timeoutMs: resolveTimeoutMs(config),
      healthIssues,
      checkForUpdate: () => checkForUpdate({ currentVersion: version, now: Date.now() }),
      updateSelf: async (updateOut) => {
        // Build the npm args, targeting the prefix that owns the *running*
        // binary when we can confidently derive it — so the update lands on the
        // copy that's actually executing, not just npm's global prefix. Any
        // failure to derive falls back to plain `-g`, so this is never worse
        // than the old behaviour.
        let installArgs = ['install', '-g', 'myshell-tools@latest'];
        try {
          const entry = realpathSync(fileURLToPath(import.meta.url));
          const prefix = prefixForRunningEntry(entry);
          if (prefix !== null) {
            installArgs = ['install', '-g', '--prefix', prefix, 'myshell-tools@latest'];
          }
        } catch {
          // Derivation failed — keep the plain `-g` args.
        }
        try {
          const result = await execa('npm', installArgs, {
            stdio: ['ignore', 'inherit', 'inherit'],
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
      activeBinPath: async () => {
        // Resolve WHERE the active `myshell-tools` on PATH lives, so a post-update
        // version mismatch can point the user at the stale copy. `which`/`where`
        // may print several lines (PATH shadowing) — take the first. Fail-soft.
        try {
          const finder = process.platform === 'win32' ? 'where' : 'which';
          const result = await execa(finder, ['myshell-tools'], { reject: false });
          if (result.exitCode !== 0) return null;
          const first = result.stdout.split(/\r?\n/)[0]?.trim() ?? '';
          return first.length > 0 ? first : null;
        } catch {
          return null;
        }
      },
      relaunch: async (env) => {
        try {
          const result = await execa('myshell-tools', process.argv.slice(2), {
            stdio: 'inherit',
            reject: false,
            ...(env !== undefined ? { env } : {}),
          });
          return result.exitCode ?? 0;
        } catch {
          return 1;
        }
      },
      ...(startupInput !== null ? { startupInput } : {}),
    };

    await startMenu(menuCtx, out);
    process.exit(0);
  }

  // ---- Interactive REPL (legacy subcommand) ----------------------------------
  if (args[0] === 'repl') {
    out.write(banner(version, out.color) + '\n');
    const spinner = createSpinner(out);
    spinner.start('Detecting providers…');
    const [env, config] = await Promise.all([detectEnvironment(), startupConfigPromise ?? loadConfig()]);
    const replMode = config.mode ?? autoModeForPlans(
      [env.claude, env.codex, env.opencode, env.grok]
        .filter((p) => p.authenticated)
        .map((p) => p.plan),
    );
    const replPolicy =
      config.mode === undefined
        ? tunePolicyForMaxSubTier(
            POLICY_PRESETS[replMode],
            [env.claude, env.codex, env.opencode, env.grok]
              .filter((p) => p.authenticated)
              .map((p) => p.plan),
          )
        : POLICY_PRESETS[replMode];
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

    // TOOL SELF-AWARENESS for the REPL subset too (deps/prompt concern, not UI):
    // the same authoritative ABOUT block so the partner answers setup/mode
    // questions accurately. Pure assembly, NO model call.
    const replCapability = await gatherCapabilitySummary(env, cwd);
    const replToolStateContext = buildToolStateContext({
      version,
      providers: [env.claude, env.codex, env.opencode, env.grok].map(
        (p): ToolStateProvider => ({
          label: PROVIDER_LABEL[p.id] ?? p.id,
          installed: p.installed,
          authenticated: p.authenticated,
          plan: p.plan,
        }),
      ),
      mode: replMode,
      modeIsAuto: config.mode === undefined,
      smartRoute: config.smartRoute !== false,
      ...(replCapability?.summary !== undefined ? { capabilitySummary: replCapability.summary } : {}),
    });

    const baseDeps = buildDeps(
      cwd,
      env,
      replPolicy,
      resolveTimeoutMs(config),
      undefined,
      undefined,
      memoryContext,
      undefined,
      replToolStateContext,
      replCapability?.registry,
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
            sandbox: helperSandbox(baseDeps.sandbox),
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
  } catch (err) {
    startupInput?.dispose();
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
