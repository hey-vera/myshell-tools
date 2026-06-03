/**
 * src/infra/claude-oauth-refresh.ts — keep Claude logged in by refreshing its
 * OAuth token IN PLACE before it expires.
 *
 * Why this exists
 * ---------------
 * Claude Code persists a subscription login as an OAuth token in
 * `<CLAUDE_CONFIG_DIR>/.credentials.json` (`claudeAiOauth.accessToken` +
 * `refreshToken` + `expiresAt`). The access token is short-lived; when it lapses
 * the user is forced to sign in again. This module does what `claude` itself does
 * on use — exchanges the stored refresh token for a fresh access token — but
 * proactively at launch, so a container that's been idle past expiry comes back
 * already signed in. This is the mechanism behind "log in once, it just
 * remembers" (mirrors DATA Tools' claude-auth-refresh.sh).
 *
 * Security contract (the user explicitly authorised in-place refresh)
 * -------------------------------------------------------------------
 *  - The refresh token is read from, and the new token written back to, CLAUDE'S
 *    OWN credentials file only. It is NEVER copied into our own store, logged, or
 *    sent anywhere but Anthropic's own token endpoint.
 *  - The credentials file is backed up before writing and restored on any write
 *    failure, so a botched refresh can never corrupt a working login.
 *  - A failed refresh drops a cooldown marker so we don't hammer the endpoint
 *    (or wedge shell startup) on every launch while offline / truly expired.
 *
 * Layering: infra. Date.now() is allowed here (same as update-check.ts). The
 * network fetch is injected so tests stay hermetic and never hit the real
 * endpoint. Never throws — every path resolves to a RefreshResult.
 */

import { readFile, writeFile, copyFile, rename, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Constants — Claude Code's public OAuth client (same id its own login uses)
// ---------------------------------------------------------------------------

const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

/** Refresh when fewer than this many ms remain (2h, matching DATA Tools). */
const DEFAULT_THRESHOLD_MS = 2 * 60 * 60 * 1000;
/** Fail fast — never block shell startup on a hung network. */
const FETCH_TIMEOUT_MS = 5_000;
/** After a failed refresh, wait this long before trying again. */
const COOLDOWN_MS = 60 * 60 * 1000; // 1h

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeOauth {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number | null; // epoch ms
}

/** What the token-endpoint POST returned (already normalised). */
export interface RefreshResponse {
  readonly accessToken: string;
  readonly refreshToken?: string; // some responses omit it → keep the old one
  readonly expiresInSec: number;
}

type TokenFetcher = (refreshToken: string) => Promise<RefreshResponse | null>;

export type RefreshDecision = 'valid' | 'refresh' | 'expired-no-refresh' | 'no-expiry';

type RefreshAction =
  | 'valid' // token still good — nothing to do
  | 'refreshed' // we minted a fresh token and wrote it back
  | 'failed' // a refresh was attempted but the endpoint/write failed
  | 'expired-no-refresh' // token lapsed and there is no refresh token to use
  | 'no-creds' // no credentials file (e.g. macOS Keychain, or never signed in)
  | 'no-expiry' // creds present but no expiresAt — can't reason about lifetime
  | 'cooldown'; // a recent refresh failed; skipping until the cooldown elapses

export interface RefreshResult {
  readonly action: RefreshAction;
  /** Whole hours left on the token when known (after refresh on success). */
  readonly hoursLeft?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O) — the testable decision core
// ---------------------------------------------------------------------------

/**
 * Pull the `claudeAiOauth` block out of a raw `.credentials.json` string.
 * Returns null when the file isn't JSON, has no oauth block, or lacks an
 * access token. Never throws.
 */
export function parseClaudeOauth(raw: string): ClaudeOauth | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const oauth = (parsed as Record<string, unknown>)['claudeAiOauth'];
    if (typeof oauth !== 'object' || oauth === null) return null;
    const o = oauth as Record<string, unknown>;
    const accessToken = typeof o['accessToken'] === 'string' ? o['accessToken'] : '';
    if (accessToken.length === 0) return null;
    const refreshToken =
      typeof o['refreshToken'] === 'string' && o['refreshToken'].length > 0
        ? o['refreshToken']
        : null;
    const expiresAt = typeof o['expiresAt'] === 'number' ? o['expiresAt'] : null;
    return { accessToken, refreshToken, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Decide what to do with a parsed OAuth block at time `nowMs`.
 *   - `valid`              → more than `thresholdMs` remains; leave it alone.
 *   - `refresh`            → expired or within threshold, and a refresh token exists.
 *   - `expired-no-refresh` → needs refresh but there is no refresh token.
 *   - `no-expiry`          → no expiresAt to reason about.
 * Pure / never throws.
 */
export function oauthRefreshDecision(
  oauth: ClaudeOauth,
  nowMs: number,
  thresholdMs = DEFAULT_THRESHOLD_MS,
): RefreshDecision {
  if (oauth.expiresAt === null) return 'no-expiry';
  const msLeft = oauth.expiresAt - nowMs;
  if (msLeft > thresholdMs) return 'valid';
  return oauth.refreshToken === null ? 'expired-no-refresh' : 'refresh';
}

/**
 * Produce the updated credentials object after a successful refresh, preserving
 * every other key in the file and only touching the oauth access/refresh/expiry
 * fields. Pure / never throws.
 */
export function applyRefreshToCreds(
  rawObj: Record<string, unknown>,
  resp: RefreshResponse,
  nowMs: number,
): Record<string, unknown> {
  const prevOauth =
    typeof rawObj['claudeAiOauth'] === 'object' && rawObj['claudeAiOauth'] !== null
      ? (rawObj['claudeAiOauth'] as Record<string, unknown>)
      : {};
  const nextOauth: Record<string, unknown> = {
    ...prevOauth,
    accessToken: resp.accessToken,
    expiresAt: nowMs + resp.expiresInSec * 1000,
  };
  if (resp.refreshToken !== undefined && resp.refreshToken.length > 0) {
    nextOauth['refreshToken'] = resp.refreshToken;
  }
  return { ...rawObj, claudeAiOauth: nextOauth };
}

const hoursLeft = (expiresAtMs: number, nowMs: number): number =>
  Math.floor((expiresAtMs - nowMs) / (60 * 60 * 1000));

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve where Claude's `.credentials.json` lives. Honours `CLAUDE_CONFIG_DIR`
 * (set by Replit/bashrc or our own replitPersistentEnv), then the Replit
 * persistent workspace dir, then the default `~/.claude`. Pure / never throws.
 */
export function resolveClaudeCredsPath(
  env: NodeJS.ProcessEnv,
  cwd: string,
  home: string = homedir(),
): string {
  const cfg = env['CLAUDE_CONFIG_DIR'];
  if (cfg !== undefined && cfg.length > 0) return join(cfg, '.credentials.json');
  const replit = join(cwd, '.replit-tools', '.claude-persistent', '.credentials.json');
  if (existsSync(replit)) return replit;
  return join(home, '.claude', '.credentials.json');
}

// ---------------------------------------------------------------------------
// Network fetch (real — injected in tests)
// ---------------------------------------------------------------------------

/**
 * Exchange a refresh token for a fresh access token at Anthropic's own OAuth
 * endpoint. Returns null on any non-OK / malformed / timed-out response. The
 * token is sent ONLY to the official endpoint and never logged. Never throws.
 */
async function fetchRefreshedToken(refreshToken: string): Promise<RefreshResponse | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => { ac.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (typeof data !== 'object' || data === null) return null;
    const d = data as Record<string, unknown>;
    if (typeof d['access_token'] !== 'string' || d['access_token'].length === 0) return null;
    return {
      accessToken: d['access_token'],
      ...(typeof d['refresh_token'] === 'string' && d['refresh_token'].length > 0
        ? { refreshToken: d['refresh_token'] }
        : {}),
      expiresInSec: typeof d['expires_in'] === 'number' ? d['expires_in'] : 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cooldown marker (avoid hammering the endpoint after a failure)
// ---------------------------------------------------------------------------

function cooldownMarkerPath(home: string): string {
  return join(home, '.myshell-tools', '.claude-refresh-failed');
}

async function inCooldown(home: string, nowMs: number): Promise<boolean> {
  try {
    // The marker stores the logical timestamp of the last failure in its contents
    // (not mtime) so the cooldown is deterministic under an injected clock.
    const stored = parseInt((await readFile(cooldownMarkerPath(home), 'utf8')).trim(), 10);
    if (!Number.isFinite(stored)) return false;
    return nowMs - stored < COOLDOWN_MS;
  } catch {
    return false; // no marker → not in cooldown
  }
}

async function setCooldown(home: string, nowMs: number): Promise<void> {
  try {
    const p = cooldownMarkerPath(home);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, String(nowMs), 'utf8');
  } catch {
    /* best-effort */
  }
}

async function clearCooldown(home: string): Promise<void> {
  try {
    await rm(cooldownMarkerPath(home), { force: true });
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

export interface RefreshOpts {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
  readonly nowMs?: number;
  readonly thresholdMs?: number;
  /** Injected token exchange — defaults to the real {@link fetchRefreshedToken}. */
  readonly fetcher?: TokenFetcher;
  /** Override the credentials path directly (tests). */
  readonly credsPath?: string;
}

/**
 * Refresh Claude's OAuth token in place if it's expired or close to it. Safe to
 * call unconditionally at launch — it's a no-op (`valid`/`no-creds`) in the
 * common case and only ever touches the file when a fresh token was minted.
 * Never throws.
 */
export async function refreshClaudeOauthIfNeeded(opts: RefreshOpts = {}): Promise<RefreshResult> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const nowMs = opts.nowMs ?? Date.now();
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const fetcher = opts.fetcher ?? fetchRefreshedToken;
  const credsPath = opts.credsPath ?? resolveClaudeCredsPath(env, cwd, home);

  try {
    let raw: string;
    try {
      raw = await readFile(credsPath, 'utf8');
    } catch {
      return { action: 'no-creds' };
    }

    const oauth = parseClaudeOauth(raw);
    if (oauth === null) return { action: 'no-creds' };

    const decision = oauthRefreshDecision(oauth, nowMs, thresholdMs);
    if (decision === 'no-expiry') return { action: 'no-expiry' };
    if (decision === 'valid') {
      return { action: 'valid', hoursLeft: hoursLeft(oauth.expiresAt ?? nowMs, nowMs) };
    }
    if (decision === 'expired-no-refresh') return { action: 'expired-no-refresh' };

    // decision === 'refresh' — but back off if a recent attempt failed.
    if (await inCooldown(home, nowMs)) return { action: 'cooldown' };

    const resp = await fetcher(oauth.refreshToken as string);
    if (resp === null) {
      await setCooldown(home, nowMs);
      return { action: 'failed' };
    }

    // Parse the existing file as a plain object to preserve unknown keys.
    let rawObj: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) rawObj = parsed as Record<string, unknown>;
    } catch {
      await setCooldown(home, nowMs);
      return { action: 'failed' };
    }

    const next = applyRefreshToCreds(rawObj, resp, nowMs);
    const backup = `${credsPath}.myshell-bak`;
    try {
      await copyFile(credsPath, backup); // backup before touching the live file
      const tmp = `${credsPath}.myshell-tmp`;
      await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
      await rename(tmp, credsPath); // atomic swap
      await rm(backup, { force: true });
    } catch {
      // Restore the backup if the write went sideways, then report failure.
      try {
        if (existsSync(backup)) await rename(backup, credsPath);
      } catch {
        /* best-effort restore */
      }
      await setCooldown(home, nowMs);
      return { action: 'failed' };
    }

    await clearCooldown(home);
    const newExpiry = nowMs + resp.expiresInSec * 1000;
    return { action: 'refreshed', hoursLeft: hoursLeft(newExpiry, nowMs) };
  } catch {
    return { action: 'no-creds' };
  }
}
