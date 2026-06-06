/**
 * src/infra/model-capability-port.ts — the IMPURE fs reader behind the capability
 * registry's `CapabilityRefreshPort` (docs/model-capability-registry-5.6.md §2
 * Layer 2, Stage 1).
 *
 * Mirrors infra/repo-scan.ts: the pure merge lives in core/model-capability-refresh.ts;
 * this is only the raw local-file read of `$CODEX_HOME/models_cache.json`, fully
 * fail-soft (missing/unreadable → null, never throws). NO model call, NO network,
 * NO new dep — just node:fs + node:path.
 *
 * CODEX_HOME resolution mirrors infra/credentials.ts so the registry finds the same
 * cache the spawned Codex CLI uses on Replit:
 *   1. explicit `CODEX_HOME` env var, if set;
 *   2. else the Replit-persistent `.replit-tools/.codex-persistent` dir when it
 *      actually holds an auth.json (matches replitPersistentEnv);
 *   3. else `~/.codex`.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CapabilityRefreshPort } from '../core/model-capability-refresh.js';

/** Resolve the effective CODEX_HOME directory. Pure-ish (reads env + existsSync). */
export function resolveCodexHome(env: NodeJS.ProcessEnv, cwd: string): string {
  const explicit = env['CODEX_HOME'];
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  try {
    const persistent = join(cwd, '.replit-tools', '.codex-persistent');
    if (existsSync(join(persistent, 'auth.json'))) return persistent;
  } catch {
    // ignore — fall through to the default home.
  }
  return join(homedir(), '.codex');
}

/**
 * Build the production `CapabilityRefreshPort` for the given env + cwd. The read is
 * best-effort: a missing file, unreadable dir, or resolution failure returns null
 * so the pure refresh degrades to declarative/detection facts (efforts "unknown").
 */
export function createCapabilityRefreshPort(
  env: NodeJS.ProcessEnv,
  cwd: string,
): CapabilityRefreshPort {
  return {
    async readCodexModelsCache(): Promise<string | null> {
      try {
        const codexHome = resolveCodexHome(env, cwd);
        return await readFile(join(codexHome, 'models_cache.json'), 'utf8');
      } catch {
        return null;
      }
    },
  };
}
