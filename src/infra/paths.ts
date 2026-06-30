/**
 * src/infra/paths.ts — Pure path helpers for myshell-tools's filesystem layout.
 *
 * All functions delegate to projectStateDirs from state-layout so project-scoped
 * state lands under <stateRoot>/projects/<projectKey>/... instead of in the
 * working directory.
 */

import { defaultStateLayout, projectStateDirs } from './state-layout.js';

function dirs(cwd: string) {
  return projectStateDirs(defaultStateLayout(), cwd);
}

/**
 * Returns the root project state directory under the global state home.
 */
export function getStateDir(cwd: string): string {
  return dirs(cwd).root;
}

/**
 * Returns the path to the `sessions` subdirectory inside project state.
 */
export function getSessionsDir(cwd: string): string {
  return dirs(cwd).sessionsDir;
}

/**
 * Returns the path to the current session JSONL file.
 */
export function getSessionFile(cwd: string): string {
  return dirs(cwd).sessionFile;
}

/**
 * Returns the path to the cost/usage ledger JSONL file.
 */
export function getLedgerFile(cwd: string): string {
  return dirs(cwd).ledgerFile;
}

/**
 * Returns the path to the eval-results JSONL file (Phase 0, the ruler).
 */
export function getEvalResultsFile(cwd: string): string {
  return dirs(cwd).evalResultsFile;
}

/**
 * Returns the path to the intent-versions JSONL file.
 */
export function getIntentVersionsFile(cwd: string): string {
  return dirs(cwd).intentVersionsFile;
}

/**
 * Returns the path to the command-audit JSONL file.
 */
export function getCommandAuditFile(cwd: string): string {
  return dirs(cwd).commandAuditFile;
}
