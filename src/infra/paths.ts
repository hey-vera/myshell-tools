/**
 * src/infra/paths.ts — Pure path helpers for myshell-tools's filesystem layout.
 *
 * All functions are pure path joins (no fs I/O). The canonical layout is:
 *   <cwd>/
 *     .myshell-tools/
 *       sessions/
 *         current.jsonl   ← active session log
 *       ledger.jsonl       ← cost/usage ledger
 */

import { join } from 'node:path';

/**
 * Returns the path to the `.myshell-tools` directory inside the given working dir.
 */
export function getStateDir(cwd: string): string {
  return join(cwd, '.myshell-tools');
}

/**
 * Returns the path to the `sessions` subdirectory inside `.myshell-tools`.
 */
export function getSessionsDir(cwd: string): string {
  return join(getStateDir(cwd), 'sessions');
}

/**
 * Returns the path to the current session JSONL file.
 * Path: <cwd>/.myshell-tools/sessions/current.jsonl
 */
export function getSessionFile(cwd: string): string {
  return join(getSessionsDir(cwd), 'current.jsonl');
}

/**
 * Returns the path to the cost/usage ledger JSONL file.
 * Path: <cwd>/.myshell-tools/ledger.jsonl
 */
export function getLedgerFile(cwd: string): string {
  return join(getStateDir(cwd), 'ledger.jsonl');
}

/**
 * Returns the path to the eval-results JSONL file (Phase 0, the ruler). One
 * timestamped RunResult per line, append-only, so runs can be compared over time.
 * Path: <cwd>/.myshell-tools/eval-results.jsonl
 */
export function getEvalResultsFile(cwd: string): string {
  return join(getStateDir(cwd), 'eval-results.jsonl');
}

/**
 * Returns the path to the intent-versions JSONL file.
 * Path: <cwd>/.myshell-tools/intent-versions.jsonl
 */
export function getIntentVersionsFile(cwd: string): string {
  return join(getStateDir(cwd), 'intent-versions.jsonl');
}
