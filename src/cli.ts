#!/usr/bin/env node
/**
 * src/cli.ts — single entry point for the myshell-tools CLI.
 *
 * This is the ONLY file in the project that may call process.exit().
 * All other modules return values and let this file decide the exit code.
 */

import { createRequire } from 'node:module';
import { systemClock } from './infra/clock.js';
import { createSessionWriter } from './infra/session.js';
import { createLedger } from './infra/ledger.js';
import { DEFAULT_POLICY } from './core/policy.js';
import type { OrchestrateDeps } from './core/types.js';
import type { OutputSink } from './interface/render.js';
import { runTask } from './interface/run.js';
import { startRepl } from './interface/repl.js';
import { buildProviders } from './providers/registry.js';
import { runDoctor } from './commands/doctor.js';
import { runCost } from './commands/cost.js';
import { runLogin } from './commands/login.js';
import { banner } from './ui/banner.js';
import { createSpinner } from './ui/spinner.js';
import { dim } from './ui/theme.js';

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
  run <task...>     Run a one-shot task and exit
  repl              Start an interactive session (default when no command given)
  login [provider]  Sign in to a provider (claude or codex) via its own OAuth
  doctor            Check provider installation, auth, and environment health
  cost              Show real spend from the ledger with a per-model breakdown

Examples:
  myshell-tools login
  myshell-tools run "refactor the auth module"
  myshell-tools doctor
  myshell-tools

Repository: https://github.com/hey-vera/myshell-tools
`;

/** Build the orchestration dependencies (includes provider detection). */
async function buildDeps(cwd: string): Promise<OrchestrateDeps> {
  return {
    clock: systemClock,
    session: createSessionWriter({ cwd, id: systemClock.uuid() }),
    ledger: createLedger({ cwd }),
    policy: DEFAULT_POLICY,
    providers: await buildProviders(cwd),
    cwd,
    sandbox: 'workspace-write',
    timeoutMs: 120000,
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
    process.exit(await runLogin(out, args[1]));
  }

  if (args[0] === 'doctor') {
    process.exit(await runDoctor(out));
  }

  if (args[0] === 'cost') {
    process.exit(await runCost(cwd, out));
  }

  // ---- One-shot run ----------------------------------------------------------
  if (args[0] === 'run') {
    const taskParts = args.slice(1);
    if (taskParts.length === 0) {
      process.stderr.write('myshell-tools run: expected a task description\n');
      process.exit(1);
    }
    const deps = await buildDeps(cwd);
    const code = await runTask(taskParts.join(' '), deps, out, new AbortController().signal);
    process.exit(code);
  }

  // ---- Interactive REPL (default) --------------------------------------------
  if (args.length === 0 || args[0] === 'repl') {
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
