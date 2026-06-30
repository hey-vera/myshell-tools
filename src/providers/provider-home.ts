/**
 * src/providers/provider-home.ts — shared provider-home resolver.
 *
 * Single authority for where each vendor CLI's config/credentials live, so
 * cloud/account-scoped persistence can be placed under myshell's own
 * `provider-homes/` instead of relying on the external `.replit-tools/.X-persistent`
 * scheme. No symlinks, no SSH, no ~/.ssh — pure path resolution with exist checks.
 *
 * Exports:
 *  - resolveProviderHome  — full precedence: explicit env → myshell-managed →
 *                            .replit-tools back-compat → home-dir fallback.
 *  - preferredProviderHome — myshell-managed dir intended for new writes
 *                            (no existence check).
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppStateLayout } from '../infra/state-layout.js';

export type ProviderHomeId = 'claude' | 'codex' | 'opencode' | 'grok';

export interface ProviderHomeOpts {
  readonly env: NodeJS.ProcessEnv;
  readonly layout: AppStateLayout;
  readonly cwd: string;
  readonly home: string;
  readonly account?: string;
}

// ── Explicit vendor env helpers ──────────────────────────────────────────────

function explicitProviderHome(provider: ProviderHomeId, env: NodeJS.ProcessEnv): string | null {
  switch (provider) {
    case 'claude': {
      const v = env['CLAUDE_CONFIG_DIR'];
      return v !== undefined && v.length > 0 ? v : null;
    }
    case 'codex': {
      const v = env['CODEX_HOME'];
      return v !== undefined && v.length > 0 ? v : null;
    }
    case 'opencode': {
      const v = env['XDG_DATA_HOME'];
      return v !== undefined && v.length > 0 ? join(v, 'opencode') : null;
    }
    case 'grok': {
      const v = env['GROK_HOME'];
      return v !== undefined && v.length > 0 ? v : null;
    }
  }
}

// ── Final fallback (step 4) ──────────────────────────────────────────────────

function defaultProviderHome(provider: ProviderHomeId, home: string): string {
  switch (provider) {
    case 'claude':
      return join(home, '.claude');
    case 'codex':
      return join(home, '.codex');
    case 'opencode':
      return join(home, '.local', 'share', 'opencode');
    case 'grok':
      return join(home, '.grok');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the config-base directory for a vendor CLI.
 *
 * Precedence (PRESERVE existing behavior — only INSERT myshell's dir):
 *  1. explicit vendor env override (CLAUDE_CONFIG_DIR / CODEX_HOME /
 *     XDG_DATA_HOME for opencode / GROK_HOME) — UNCHANGED, always wins.
 *  2. NEW: myshell-managed `<providerHomesDir>/[<account>/]<provider>` IF
 *     that directory already exists.
 *  3. read-only back-compat `<cwd>/.replit-tools/.<provider>-persistent` IF
 *     that directory exists.
 *  4. final fallback `<home>/.<provider>` (or the provider's current default
 *     e.g. `~/.local/share/opencode`).
 *
 * Pure aside from existsSync. Never throws.
 */
export function resolveProviderHome(
  provider: ProviderHomeId,
  opts: ProviderHomeOpts,
): string {
  // Step 1 — explicit vendor env
  const explicit = explicitProviderHome(provider, opts.env);
  if (explicit !== null) return explicit;

  // Step 2 — myshell-managed provider-homes
  try {
    const scoped = opts.account !== undefined
      ? join(opts.layout.paths.providerHomesDir, opts.account, provider)
      : join(opts.layout.paths.providerHomesDir, provider);
    if (existsSync(scoped)) return scoped;
  } catch {
    // ignore
  }

  // Step 3 — .replit-tools back-compat
  try {
    const replit = join(opts.cwd, '.replit-tools', `.${provider}-persistent`);
    if (existsSync(replit)) return replit;
  } catch {
    // ignore
  }

  // Step 4 — final home-dir fallback
  return defaultProviderHome(provider, opts.home);
}

/**
 * Return the myshell-managed path where NEW provider config/credentials
 * SHOULD be written — no existence check. Used when myshell needs to point
 * a vendor CLI at a persistent home via env override on cloud/account-scoped
 * runs.
 */
export function preferredProviderHome(
  provider: ProviderHomeId,
  opts: ProviderHomeOpts,
): string {
  return opts.account !== undefined
    ? join(opts.layout.paths.providerHomesDir, opts.account, provider)
    : join(opts.layout.paths.providerHomesDir, provider);
}
