/**
 * src/infra/state-dir.ts — where myshell-tools keeps its own state.
 *
 * The problem this solves
 * -----------------------
 * On Replit, the home directory (`/home/runner`) is EPHEMERAL — only the
 * workspace (`/home/runner/workspace`, the process cwd) survives a container
 * restart. (That's why DATA Tools symlinks `~/.claude` into the workspace.)
 * myshell historically kept its config / conversations / credentials under
 * `~/.myshell-tools/…`, so on Replit they vanished on every restart — onboarding
 * never stuck and chat history was lost. The cost ledger already lived under the
 * workspace (`<cwd>/.myshell-tools/ledger.jsonl`), so this just brings the rest of
 * our state into the same persistent place.
 *
 * The fix: on Replit, anchor `.myshell-tools/…` to the workspace (cwd); off
 * Replit, keep the global `~` home exactly as before. `.myshell-tools/` is already
 * gitignored, so nothing sensitive lands in version control.
 *
 * Pure / never throws. `defaultStateHome()` reads the ambient env + cwd, mirroring
 * how the infra modules previously used `os.homedir()` as their implicit default —
 * callers that pass an explicit `homeDir` are unaffected.
 */

import { homedir } from 'node:os';

/**
 * True when running inside a Replit container, where `~` is ephemeral but the
 * workspace (cwd) persists. Detected from Replit's own env vars. Pure.
 */
export function isReplit(env: NodeJS.ProcessEnv): boolean {
  return env['REPL_ID'] !== undefined || env['REPLIT_DEV_DOMAIN'] !== undefined;
}

/**
 * Resolve the base dir under which `.myshell-tools/…` state should live.
 *   - On Replit → the workspace (cwd), which persists across restarts and is
 *     where the cost ledger already lives, so all state is co-located + durable.
 *   - Elsewhere → the user's home dir (global, shared across projects — unchanged).
 * Pure / never throws.
 */
export function resolveStateHome(
  env: NodeJS.ProcessEnv,
  cwd: string,
  home: string = homedir(),
): string {
  return isReplit(env) ? cwd : home;
}

/**
 * The default state home, resolved from the ambient process env + cwd. Used as
 * the fallback when an infra function is called without an explicit `homeDir`,
 * replacing the old bare `os.homedir()` default so Replit gets a persistent dir
 * automatically. Never throws — falls back to homedir() on any error.
 */
export function defaultStateHome(): string {
  try {
    return resolveStateHome(process.env, process.cwd(), homedir());
  } catch {
    return homedir();
  }
}
