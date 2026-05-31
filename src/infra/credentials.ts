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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Credentials {
  claudeOauthToken?: string;
}

// ---------------------------------------------------------------------------
// Path helpers (pure)
// ---------------------------------------------------------------------------

function getCredentialsDir(home: string): string {
  return join(home, '.myshell-tools');
}

function getCredentialsPath(home: string): string {
  return join(getCredentialsDir(home), 'credentials.json');
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
export async function loadCredentials(homeDir?: string): Promise<Credentials> {
  const home = homeDir ?? homedir();
  try {
    const raw = await readFile(getCredentialsPath(home), 'utf8');
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
export async function loadClaudeToken(homeDir?: string): Promise<string | null> {
  try {
    const creds = await loadCredentials(homeDir);
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
 */
export async function saveClaudeToken(token: string, homeDir?: string): Promise<void> {
  const home = homeDir ?? homedir();
  const dir = getCredentialsDir(home);
  const path = getCredentialsPath(home);

  // Create the directory with restrictive permissions (0o700) so it is never
  // world-readable.  recursive:true is a no-op when it already exists.
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Load existing credentials so we only replace the token key, preserving others.
  const existing = await loadCredentials(homeDir);
  const updated: Credentials = { ...existing, claudeOauthToken: token };

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
 * Remove the stored Claude OAuth token. Writes the file back without the
 * token key so any future credential fields are preserved.
 * Never throws.
 */
export async function clearClaudeToken(homeDir?: string): Promise<void> {
  try {
    const home = homeDir ?? homedir();
    const dir = getCredentialsDir(home);
    const path = getCredentialsPath(home);

    await mkdir(dir, { recursive: true });

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
): Promise<void> {
  try {
    // Never overwrite an explicitly-set env var — user's env wins.
    if (env['CLAUDE_CODE_OAUTH_TOKEN'] !== undefined) {
      return;
    }
    const creds = await loadCredentials(homeDir);
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
