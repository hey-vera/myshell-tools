/**
 * src/infra/credentials.ts — Persisted credential store for myshell-tools.
 *
 * Stores a small JSON file at <homeDir>/.myshell-tools/credentials.json with
 * shape `{ claudeOauthToken?: string }` so the Claude OAuth token captured
 * during `myshell-tools login claude --code` is available across restarts.
 *
 * Token scoping: instead of injecting the token into the global `process.env`
 * at startup (which would expose it to every child process), callers use
 * `loadClaudeToken()` + `claudeEnv()` to build a scoped env object that is
 * passed only to Claude CLI invocations.  Other providers (codex, opencode,
 * npm) never see the token.
 *
 * Security: the file is written with mode 0o600 (owner-read-only) on POSIX
 * systems. The chmod is best-effort — a failure is silently ignored so the
 * function never throws on Windows or unusual filesystems.
 */

import { mkdir, readFile, chmod } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout, resolveStateLayout, isReplit, type AppStateLayout } from './state-layout.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Credentials {
  claudeOauthToken?: string;
  claudeTokenCapturedAt?: string;
}

// ---------------------------------------------------------------------------
// Pure token-lifetime helper
// ---------------------------------------------------------------------------

export interface ClaudeTokenStatus {
  /** ISO string of when the token was saved. */
  readonly capturedAt: string;
  /** ISO string of the computed expiry (capturedAt + lifetimeDays). */
  readonly expiresAt: string;
  /** Whole days remaining until expiry (floor). 0 when expiring today, negative when expired. */
  readonly daysLeft: number;
  /** True when daysLeft <= 0. */
  readonly expired: boolean;
  /** True when 0 < daysLeft <= warnWithinDays. */
  readonly nearExpiry: boolean;
}

/**
 * Compute token lifetime status from a stored ISO capture timestamp.
 *
 * Pure — no I/O, no Date.now() inside. Pass `nowMs` for deterministic testing.
 * Never throws.
 *
 * @param capturedAtIso  - ISO string stored at save time, or undefined/null.
 * @param nowMs          - Current epoch-ms (e.g. Date.now() from the caller).
 * @param lifetimeDays   - Total token lifetime in days (default 365).
 * @param warnWithinDays - Warn when this many days or fewer remain (default 14).
 * @returns Status object, or null when capturedAtIso is missing or unparseable.
 */
export function claudeTokenStatus(
  capturedAtIso: string | undefined,
  nowMs: number,
  lifetimeDays = 365,
  warnWithinDays = 14,
): ClaudeTokenStatus | null {
  try {
    if (capturedAtIso === undefined || capturedAtIso === null || capturedAtIso.length === 0) {
      return null;
    }
    const capturedMs = new Date(capturedAtIso).getTime();
    if (!Number.isFinite(capturedMs)) {
      return null;
    }
    const lifetimeMs = lifetimeDays * 24 * 60 * 60 * 1000;
    const expiresMs = capturedMs + lifetimeMs;
    const expiresAt = new Date(expiresMs).toISOString();
    const msLeft = expiresMs - nowMs;
    const daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));
    const expired = daysLeft <= 0;
    const nearExpiry = !expired && daysLeft <= warnWithinDays;
    return { capturedAt: capturedAtIso, expiresAt, daysLeft, expired, nearExpiry };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layout resolution (homeDir compat bridge)
// ---------------------------------------------------------------------------

function resolveLayout(homeDir?: string, layout?: AppStateLayout): AppStateLayout {
  if (layout) return layout;
  if (homeDir !== undefined) {
    return resolveStateLayout({
      env: {},
      platform: 'linux',
      cwd: homeDir,
      homeDir,
    });
  }
  return defaultStateLayout();
}

// ---------------------------------------------------------------------------
// Path helpers (pure)
// ---------------------------------------------------------------------------

function getCredentialsPath(l: AppStateLayout): string {
  return l.paths.credentialsFile;
}

function replitClaudeConfigDir(cwd: string): string {
  return join(cwd, '.replit-tools', '.claude-persistent');
}

function replitCodexHome(cwd: string): string {
  return join(cwd, '.replit-tools', '.codex-persistent');
}

function replitGrokHome(cwd: string): string {
  return join(cwd, '.replit-tools', '.grok-persistent');
}

function replitOpencodeConfigHome(cwd: string): string {
  return join(cwd, '.config');
}

function replitOpencodeDataHome(cwd: string): string {
  return join(cwd, '.local', 'share');
}

// ---------------------------------------------------------------------------
// Internal parse helper
// ---------------------------------------------------------------------------

/**
 * Parse credentials from raw JSON text. Returns `{}` on any error so callers
 * never need to handle thrown exceptions from the load path.
 */
function parseCredentials(raw: string): Credentials {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    const result: Credentials = {};
    if (typeof obj['claudeOauthToken'] === 'string' && obj['claudeOauthToken'].length > 0) {
      result.claudeOauthToken = obj['claudeOauthToken'];
    }
    if (typeof obj['claudeTokenCapturedAt'] === 'string' && obj['claudeTokenCapturedAt'].length > 0) {
      result.claudeTokenCapturedAt = obj['claudeTokenCapturedAt'];
    }
    return result;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load stored credentials. Never throws — missing or corrupt files return `{}`.
 */
export async function loadCredentials(homeDir?: string, layout?: AppStateLayout): Promise<Credentials> {
  const l = resolveLayout(homeDir, layout);
  try {
    const raw = await readFile(getCredentialsPath(l), 'utf8');
    return parseCredentials(raw);
  } catch {
    return {};
  }
}

/**
 * Load the stored Claude OAuth token. Returns `null` when no token is stored
 * or when the credentials file is missing/corrupt. Never throws.
 *
 * This is a thin convenience wrapper over `loadCredentials` that returns the
 * token string directly so callers don't need to destructure `Credentials`.
 */
export async function loadClaudeToken(homeDir?: string, layout?: AppStateLayout): Promise<string | null> {
  try {
    const creds = await loadCredentials(homeDir, layout);
    return creds.claudeOauthToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a child-process environment that injects the Claude OAuth token into
 * ONLY the `CLAUDE_CODE_OAUTH_TOKEN` variable, leaving all other variables
 * from `baseEnv` intact.
 *
 * Rules (pure — no I/O):
 *  - Returns `baseEnv` unchanged when `token` is `null` (nothing stored).
 *  - Returns `baseEnv` unchanged when `baseEnv.CLAUDE_CODE_OAUTH_TOKEN` is
 *    already set — the user's explicitly-exported value always wins.
 *  - Otherwise returns `{ ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: token }`.
 *
 * Pass the result as the `env` option to execa for Claude CLI spawns only.
 * Never pass it to codex/opencode/npm children — they do not need it and
 * should not see the token.
 *
 * Pure / never throws.
 */
/**
 * Replit (and replit-tools) persist the claude/codex login in workspace dirs and
 * point the CLIs at them via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Those vars are set
 * inside agent sessions but NOT always in a plain shell — so a plainly-launched
 * `myshell-tools` would spawn claude/codex against the EPHEMERAL `~/.claude` /
 * `~/.codex` and miss the durable login ("not signed in" despite a one-time
 * sign-in). This returns the env vars to ADD so the spawned CLI finds the
 * persistent login — exactly how replit-tools makes one sign-in stick.
 *
 * Only redirects when the var isn't already set AND the persistent dir actually
 * holds creds, so it can never break a working ephemeral login by pointing at an
 * empty dir. Harmless off Replit (the dirs won't exist). Never throws.
 *
 * @param baseEnv - The env to read existing CLAUDE_CONFIG_DIR / CODEX_HOME from.
 * @param cwd     - The workspace dir to resolve `.replit-tools/*` against.
 */
export function replitPersistentEnv(baseEnv: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const add: NodeJS.ProcessEnv = {};
  try {
    if (baseEnv['CLAUDE_CONFIG_DIR'] === undefined) {
      const dir = replitClaudeConfigDir(cwd);
      if (existsSync(join(dir, '.credentials.json'))) add['CLAUDE_CONFIG_DIR'] = dir;
    }
    if (baseEnv['CODEX_HOME'] === undefined) {
      const dir = replitCodexHome(cwd);
      if (existsSync(join(dir, 'auth.json'))) add['CODEX_HOME'] = dir;
    }
    // opencode keeps its config (your own provider/subscription — Kimi etc.) in
    // XDG dirs. On Replit those point at the persistent workspace; a plain shell
    // may lack them → opencode reads ephemeral ~/.config and forgets your setup.
    if (baseEnv['XDG_CONFIG_HOME'] === undefined) {
      const cfg = replitOpencodeConfigHome(cwd);
      if (existsSync(join(cfg, 'opencode'))) add['XDG_CONFIG_HOME'] = cfg;
    }
    if (baseEnv['XDG_DATA_HOME'] === undefined) {
      const data = replitOpencodeDataHome(cwd);
      if (existsSync(join(data, 'opencode'))) add['XDG_DATA_HOME'] = data;
    }
    // grok stores its OAuth subscription credential under GROK_HOME (default
    // ~/.grok), which is ephemeral on Replit. Once `myshell login grok` has created
    // the persistent dir, redirect to it so the sign-in sticks across sessions —
    // the grok analogue of CLAUDE_CONFIG_DIR / CODEX_HOME above.
    if (baseEnv['GROK_HOME'] === undefined) {
      const dir = replitGrokHome(cwd);
      if (existsSync(dir)) add['GROK_HOME'] = dir;
    }
  } catch {
    // Best-effort — never throw on env resolution.
  }
  return add;
}

/**
 * Build the env additions for a provider login on Replit, where the container
 * home is ephemeral and first-time credentials must be written under the
 * workspace. Unlike `replitPersistentEnv`, this login-time resolver creates the
 * target dirs and points the provider CLI there before credentials exist.
 *
 * Only redirects on Replit, never overrides an already-set env var, and never
 * reads or copies credential contents. Off Replit it returns `{}` so vendor CLIs
 * keep using their normal default homes.
 *
 * @param baseEnv   - The env to read Replit and existing config vars from.
 * @param cwd       - The workspace dir to resolve persistent dirs against.
 * @param providers - Providers whose login dirs should be prepared.
 */
export function loginPersistentEnv(
  baseEnv: NodeJS.ProcessEnv,
  cwd: string,
  providers: readonly ('claude' | 'codex' | 'opencode' | 'grok')[],
): NodeJS.ProcessEnv {
  const add: NodeJS.ProcessEnv = {};
  try {
    if (!isReplit(baseEnv)) return add;

    if (providers.includes('claude') && baseEnv['CLAUDE_CONFIG_DIR'] === undefined) {
      const dir = replitClaudeConfigDir(cwd);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      add['CLAUDE_CONFIG_DIR'] = dir;
    }

    if (providers.includes('codex') && baseEnv['CODEX_HOME'] === undefined) {
      const dir = replitCodexHome(cwd);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      add['CODEX_HOME'] = dir;
    }

    if (providers.includes('opencode')) {
      if (baseEnv['XDG_CONFIG_HOME'] === undefined) {
        const cfg = replitOpencodeConfigHome(cwd);
        mkdirSync(cfg, { recursive: true, mode: 0o700 });
        add['XDG_CONFIG_HOME'] = cfg;
      }
      if (baseEnv['XDG_DATA_HOME'] === undefined) {
        const data = replitOpencodeDataHome(cwd);
        mkdirSync(data, { recursive: true, mode: 0o700 });
        add['XDG_DATA_HOME'] = data;
      }
    }

    if (providers.includes('grok') && baseEnv['GROK_HOME'] === undefined) {
      const dir = replitGrokHome(cwd);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      add['GROK_HOME'] = dir;
    }
  } catch {
    // Best-effort — never throw on env resolution.
  }
  return add;
}

export function claudeEnv(
  baseEnv: NodeJS.ProcessEnv,
  token: string | null,
): NodeJS.ProcessEnv {
  if (token === null) {
    return baseEnv;
  }
  if (baseEnv['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined) {
    // User's explicitly-exported env wins — do not overwrite.
    return baseEnv;
  }
  return { ...baseEnv, CLAUDE_CODE_OAUTH_TOKEN: token };
}

/**
 * Persist the Claude OAuth token atomically to
 * `~/.myshell-tools/credentials.json` with restrictive permissions (0o600).
 *
 * Records `claudeTokenCapturedAt` (ISO timestamp) so the token's age can be
 * tracked for expiry warnings.
 */
export async function saveClaudeToken(token: string, homeDir?: string, layout?: AppStateLayout): Promise<void> {
  const l = resolveLayout(homeDir, layout);
  const path = getCredentialsPath(l);

  // Create directory with restrictive permissions (0o700) so it is never
  // world-readable.  recursive:true is a no-op when it already exists.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  // Load existing credentials so we only replace the token key, preserving others.
  const existing = await loadCredentials(homeDir, layout);
  const updated: Credentials = {
    ...existing,
    claudeOauthToken: token,
    claudeTokenCapturedAt: new Date().toISOString(),
  };

  // atomicWrite with mode 0o600 guarantees the temp file is never more permissive
  // than the final destination — no world-readable window before the rename.
  await atomicWrite(path, JSON.stringify(updated, null, 2), 0o600);

  // Best-effort: restrict to owner-read-only. Silently ignored on Windows or
  // unusual filesystems where chmod is unavailable or unsupported.
  try {
    await chmod(path, 0o600);
  } catch {
    // Cross-platform best-effort only — never throws
  }
}

/**
 * Load the ISO timestamp recorded when the Claude OAuth token was last saved.
 * Returns `undefined` when no token has been saved, or when the stored value
 * is missing from an older credential file. Never throws.
 */
export async function loadClaudeTokenCapturedAt(homeDir?: string, layout?: AppStateLayout): Promise<string | undefined> {
  try {
    const creds = await loadCredentials(homeDir, layout);
    return creds.claudeTokenCapturedAt;
  } catch {
    return undefined;
  }
}

/**
 * Remove the stored Claude OAuth token. Writes the file back without the
 * token key so any future credential fields are preserved.
 * Never throws.
 */
export async function clearClaudeToken(homeDir?: string, layout?: AppStateLayout): Promise<void> {
  try {
    const l = resolveLayout(homeDir, layout);
    const path = getCredentialsPath(l);

    await mkdir(dirname(path), { recursive: true });

    // Load the raw file to preserve unknown future keys.
    let rawObj: Record<string, unknown> = {};
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        rawObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or corrupt file — start from empty
    }

    delete rawObj['claudeOauthToken'];
    await atomicWrite(path, JSON.stringify(rawObj, null, 2));
  } catch {
    // Never throws — clear is best-effort
  }
}

/**
 * Inject a previously-saved Claude OAuth token into `env` if:
 *   1. A token is stored in `~/.myshell-tools/credentials.json`, AND
 *   2. `env.CLAUDE_CODE_OAUTH_TOKEN` is not already set (user's explicit env wins).
 *
 * Called once at the very top of `main()` so every code path — detection,
 * spawned `claude -p …`, and the menu — sees the token without the user
 * needing to export it manually.
 *
 * Never throws.
 */
export async function applyStoredCredentials(
  env: NodeJS.ProcessEnv,
  homeDir?: string,
  layout?: AppStateLayout,
): Promise<void> {
  try {
    // Never overwrite an explicitly-set env var — user's env wins.
    if (env['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined) {
      return;
    }
    const creds = await loadCredentials(homeDir, layout);
    if (creds.claudeOauthToken !== undefined) {
      env['CLAUDE_CODE_OAUTH_TOKEN'] = creds.claudeOauthToken;
    }
  } catch {
    // Never throws — startup injection is best-effort
  }
}

// ---------------------------------------------------------------------------
// Pure token extraction and classification helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first Claude long-lived OAuth token from `text`.
 *
 * Token format: `sk-ant-oat` followed by optional digits/lowercase-letters,
 * then a dash, then one or more Base64url characters (`[A-Za-z0-9_-]+`).
 *
 * Returns `null` when no token is found. Never throws.
 *
 * @example
 *   extractClaudeToken('Token: sk-ant-oat01-abc-XYZ123') // → 'sk-ant-oat01-abc-XYZ123'
 *   extractClaudeToken('no token here')                   // → null
 */
export function extractClaudeToken(text: string): string | null {
  try {
    const match = text.match(/sk-ant-oat[0-9a-z]*-[A-Za-z0-9_-]+/);
    return match !== null && match[0] !== undefined ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * Strip surrounding whitespace and enclosing `"` or `'` quotes from a pasted
 * string. Useful for normalising user-pasted tokens before extraction.
 *
 * Pure / never throws.
 *
 * @example
 *   stripPastedSecretWrapper('"  sk-ant-oat01-abc  "') // → 'sk-ant-oat01-abc'
 *   stripPastedSecretWrapper("'token'")               // → 'token'
 *   stripPastedSecretWrapper('  plain  ')             // → 'plain'
 */
export function stripPastedSecretWrapper(raw: string): string {
  try {
    let s = raw.trim();
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      s = s.slice(1, -1).trim();
    }
    return s;
  } catch {
    return raw;
  }
}

/**
 * Aggressively normalise a pasted Claude token so a direct copy works on the
 * first try, regardless of how the terminal mangled it on the way in.
 *
 * A real `sk-ant-oat…` token contains NO whitespace, so we can safely:
 *   1. Strip ANSI / bracketed-paste escape sequences (e.g. ESC[200~ … ESC[201~)
 *      that some terminals wrap around pasted text.
 *   2. Strip an enclosing pair of quotes and surrounding whitespace.
 *   3. Remove ALL internal whitespace — this reassembles a token that a terminal
 *      soft-wrap or a stray newline broke across what looks like multiple lines.
 *
 * This is intentionally more aggressive than {@link stripPastedSecretWrapper}
 * (which preserves internal characters) because the input here is expected to be
 * a single secret, not free-form prose. Pure / never throws.
 *
 * @example
 *   sanitizePastedToken('sk-ant-oat01-abc def-XYZ')        // → 'sk-ant-oat01-abcdef-XYZ'
 *   sanitizePastedToken('\x1b[200~sk-ant-oat01-x\x1b[201~') // → 'sk-ant-oat01-x'
 */
export function sanitizePastedToken(raw: string): string {
  try {
    // 1. Remove ANSI/bracketed-paste escape sequences (CSI: ESC [ … final-byte).
    // eslint-disable-next-line no-control-regex
    let s = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    // 2. Strip surrounding quotes + outer whitespace (reuse the shared helper).
    s = stripPastedSecretWrapper(s);
    // 3. Collapse ALL internal whitespace — a token never contains any, so this
    //    only ever rejoins a value the terminal split apart.
    s = s.replace(/\s+/g, '');
    return s;
  } catch {
    return raw;
  }
}

/**
 * Classify a pasted secret string into one of three categories:
 *
 * - `'oauth-token'` — starts with `sk-ant-oat` (the expected setup-token output).
 * - `'api-key'`     — starts with `sk-ant-api` (a raw Anthropic API key, NOT what we want).
 * - `'none'`        — neither; blank or unrecognised.
 *
 * Uses `startsWith` semantics: mid-string occurrences of `sk-ant-oat` or
 * `sk-ant-api` do NOT classify as oauth-token or api-key respectively.
 * Input is pre-normalised (trimmed, quotes stripped) by the caller.
 * Pure / never throws.
 *
 * @example
 *   classifyPastedSecret('sk-ant-oat01-abc-XYZ') // → 'oauth-token'
 *   classifyPastedSecret('sk-ant-api03-abc-XYZ') // → 'api-key'
 *   classifyPastedSecret('not-a-token')           // → 'none'
 *   classifyPastedSecret('prefix sk-ant-oat01-x') // → 'none'
 */
export function classifyPastedSecret(s: string): 'oauth-token' | 'api-key' | 'none' {
  try {
    if (s.startsWith('sk-ant-oat')) return 'oauth-token';
    if (s.startsWith('sk-ant-api')) return 'api-key';
    return 'none';
  } catch {
    return 'none';
  }
}
