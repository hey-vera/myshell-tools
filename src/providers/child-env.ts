/**
 * src/providers/child-env.ts — minimal adapter child environment (R4.2).
 *
 * Provider CLI children must not inherit the full parent `process.env` by
 * default. Stray API-key variables (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * XAI_API_KEY, …) can silently flip a subscription CLI into pay-as-you-go
 * billing mode.
 *
 * Default composition:
 *   1. allowlisted OS/runtime keys from parentEnv (PATH/HOME/Windows system)
 *   2. provider-home keys (CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME / XDG_*)
 *   3. optional layers (e.g. replitPersistentEnv additions)
 *   4. accountEnv LAST (subscription-scoped homes always win)
 *
 * Escape hatch: `MYSHELL_PROVIDER_FULL_ENV=1` restores full parent inheritance
 * and emits a one-shot stderr warning (compatibility only).
 *
 * Pure except the one-shot warn write. Never throws.
 */

export type ProviderChildId = 'claude' | 'codex' | 'grok' | 'opencode';

/** Env flag that restores pre-R4.2 full inheritance. */
export const PROVIDER_FULL_ENV_FLAG = 'MYSHELL_PROVIDER_FULL_ENV';

/**
 * OS / runtime keys safe to pass to every provider child.
 * PATH is handled separately (case-insensitive) so Windows `Path` is never dropped.
 */
export const CHILD_ENV_BASE_ALLOWLIST: readonly string[] = [
  // Identity / home
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  // Locale / terminal
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  // Temp
  'TMPDIR',
  'TMP',
  'TEMP',
  // Windows process launch
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'PathExt',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  // TLS / proxy (corporate / Replit often need these)
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  // CI marker some CLIs check (non-secret)
  'CI',
] as const;

/**
 * Provider-owned config/credential home keys. Intentionally excludes pay-go
 * API key names so subscription auth is not overridden by ambient host env.
 */
export const CHILD_ENV_PROVIDER_ALLOWLIST: Readonly<
  Record<ProviderChildId, readonly string[]>
> = {
  claude: [
    'CLAUDE_CONFIG_DIR',
    // Only present when intentionally injected (legacy opt-in) or user-exported.
    'CLAUDE_CODE_OAUTH_TOKEN',
  ],
  codex: ['CODEX_HOME'],
  grok: ['GROK_HOME'],
  opencode: [
    'XDG_DATA_HOME',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
  ],
};

/** True when full parent env inheritance is explicitly requested. */
export function isProviderFullEnvEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env[PROVIDER_FULL_ENV_FLAG];
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

let fullEnvWarned = false;

/** Test-only: reset the one-shot full-env warning gate. */
export function resetProviderFullEnvWarnForTests(): void {
  fullEnvWarned = false;
}

function warnProviderFullEnvOnce(): void {
  if (fullEnvWarned) return;
  fullEnvWarned = true;
  try {
    process.stderr.write(
      '[myshell-tools] MYSHELL_PROVIDER_FULL_ENV is set: provider child processes inherit the full parent environment. Unset it for the default minimal allowlist (R4.2).\n',
    );
  } catch {
    // Best-effort — never throw from env construction.
  }
}

function isPathEnvKey(key: string): boolean {
  return key.toLowerCase() === 'path';
}

/**
 * Copy allowlisted keys from parentEnv. Always copies PATH/Path case-insensitively
 * so Windows child spawns keep a working PATH.
 *
 * Pure / never throws.
 */
export function pickAllowlistedChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  provider: ProviderChildId,
): NodeJS.ProcessEnv {
  const allow = new Set<string>([
    ...CHILD_ENV_BASE_ALLOWLIST,
    ...CHILD_ENV_PROVIDER_ALLOWLIST[provider],
  ]);
  const out: NodeJS.ProcessEnv = {};
  try {
    for (const key of Object.keys(parentEnv)) {
      if (!isPathEnvKey(key) && !allow.has(key)) continue;
      const val = parentEnv[key];
      if (val !== undefined) out[key] = val;
    }
  } catch {
    // Best-effort — return whatever was copied.
  }
  return out;
}

/**
 * Resolve the parent-side base for a provider child: allowlisted by default,
 * or full parentEnv when MYSHELL_PROVIDER_FULL_ENV is opted in (with one warn).
 *
 * Pure aside from the optional one-shot stderr warn. Never throws.
 */
export function resolveProviderParentEnv(
  parentEnv: NodeJS.ProcessEnv,
  provider: ProviderChildId,
): NodeJS.ProcessEnv {
  if (isProviderFullEnvEnabled(parentEnv)) {
    warnProviderFullEnvOnce();
    return { ...parentEnv };
  }
  return pickAllowlistedChildEnv(parentEnv, provider);
}

/**
 * Compose the final child env for a provider spawn.
 *
 * Order (later wins on key conflict):
 *   resolveProviderParentEnv(parent) → layers… → accountEnv
 *
 * `layers` is for additions such as `replitPersistentEnv(base, cwd)`. Callers
 * should compute layers from the resolved base (or parent) before merge.
 * accountEnv is always applied last so subscription homes cannot be shadowed.
 *
 * Pure aside from optional full-env warn. Never throws.
 */
export function buildProviderChildEnv(opts: {
  readonly provider: ProviderChildId;
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly layers?: readonly NodeJS.ProcessEnv[];
  readonly accountEnv?: Readonly<Partial<NodeJS.ProcessEnv>>;
}): NodeJS.ProcessEnv {
  const base = resolveProviderParentEnv(opts.parentEnv, opts.provider);
  let result: NodeJS.ProcessEnv = { ...base };
  if (opts.layers !== undefined) {
    for (const layer of opts.layers) {
      result = { ...result, ...layer };
    }
  }
  if (opts.accountEnv !== undefined) {
    result = { ...result, ...opts.accountEnv };
  }
  return result;
}
