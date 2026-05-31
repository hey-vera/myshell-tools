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
import { createLedger } from './infra/ledger.js';
import { DEFAULT_POLICY } from './core/policy.js';
import type { OrchestrateDeps } from './core/types.js';
import type { OutputSink } from './interface/render.js';
import { runTask } from './interface/run.js';
import { startRepl } from './interface/repl.js';
import { startMenu } from './interface/menu.js';
import type { MenuContext } from './interface/menu.js';
import { buildProviders } from './providers/registry.js';
import { detectEnvironment } from './providers/detect.js';
import { createFileConversationStore } from './infra/conversations.js';
import { loadConfig } from './infra/config.js';
import { checkForUpdate } from './infra/update-check.js';
import { runDoctor } from './commands/doctor.js';
import { runCost } from './commands/cost.js';
import { runLogin } from './commands/login.js';
import { runInstall } from './commands/install.js';
import { banner } from './ui/banner.js';
import { createSpinner } from './ui/spinner.js';
import { dim } from './ui/theme.js';
import { applyStoredCredentials } from './infra/credentials.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const version: string = pkg.version as string;

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
  login [provider]  Sign in to a provider (claude or codex) via its own OAuth.
                    Add --code to use the no-localhost flow (paste a code for
                    claude, device code for codex) — best inside containers /
                    over SSH. Add --browser to force the localhost flow.
  doctor [--fix]    Check provider installation, auth, and environment health.
                    Add --fix to interactively install missing providers and
                    sign in to unauthenticated ones.
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

/** Build the orchestration dependencies (includes provider detection). */
async function buildDeps(cwd: string): Promise<OrchestrateDeps> {
  const [providers, env] = await Promise.all([
    buildProviders(cwd),
    detectEnvironment(),
  ]);

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

  return {
    clock: systemClock,
    session: createSessionWriter({ cwd, id: systemClock.uuid() }),
    ledger: createLedger({ cwd }),
    policy: DEFAULT_POLICY,
    providers,
    cwd,
    sandbox: 'workspace-write',
    timeoutMs: 120000,
    ...(Object.keys(availableModels).length > 0 ? { availableModels } : {}),
    ...(authenticatedProviders.length > 0 ? { authenticatedProviders } : {}),
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
  // Inject any previously-saved Claude OAuth token into process.env before any
  // detection or provider spawn so `claude auth status` and `claude -p …` both
  // see it without the user needing to export CLAUDE_CODE_OAUTH_TOKEN manually.
  await applyStoredCredentials(process.env);

  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
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

  if (args[0] === 'doctor') {
    const fix = args.includes('--fix');
    process.exit(await runDoctor(out, fix ? { fix: true } : undefined));
  }

  if (args[0] === 'cost') {
    process.exit(await runCost(cwd, out));
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
    const deps = await buildDeps(cwd);
    const result = await runTask(taskParts.join(' '), deps, out, new AbortController().signal);
    process.exit(result.code);
  }

  // ---- Interactive Menu (default — sessions-first control panel) ------------
  if (args.length === 0) {
    const spinner = createSpinner(out);
    spinner.start('Detecting providers…');
    const [providers, env, config] = await Promise.all([
      buildProviders(cwd),
      detectEnvironment(),
      loadConfig(),
    ]);
    spinner.stop();

    const store = createFileConversationStore({ clock: systemClock });
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
      timeoutMs: 120000,
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
    const deps = await buildDeps(cwd);
    spinner.stop();
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
