/**
 * src/infra/update-check.ts — Self-update detection for myshell-tools.
 *
 * Checks the npm registry for the latest published version, caches the result
 * so the check costs nothing on subsequent runs within the TTL, and reports
 * whether an update is available.
 *
 * Architecture rules:
 *   - NEVER throws — all errors are caught and return a safe default.
 *   - NEVER hits the network in tests — `fetchLatest` is injected so tests stay hermetic.
 *   - Cache is stored atomically at ~/.myshell-tools/update-check.json.
 *   - Date.now() is allowed here (infra layer, same as config.ts / atomic.ts).
 */

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './atomic.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  readonly current: string;
  readonly latest: string | null;
  readonly updateAvailable: boolean;
}

interface UpdateCache {
  checkedAt: number;
  latest: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTL_MS_DEFAULT = 3 * 60 * 60 * 1000; // 3h — bound the window a fresh release can go unseen.
// When the cache says we are ALREADY on the latest version, that is exactly the
// state a brand-new publish silently invalidates (the publishing dev re-runs and
// the cache still insists they're current). Re-verify that state on a very short
// clock so a release is seen on the NEXT launch — the publisher's mental model is
// "npm publish, re-run, get offered the update," and a 20min cache broke that.
// 30s is just long enough to dedupe a rapid double-launch (and prevent an
// update→relaunch→re-check loop), short enough that a fresh publish is caught
// immediately. A known PENDING update still uses the full TTL (re-asking npm
// when we already know an update exists teaches us nothing).
const TTL_MS_WHEN_CURRENT = 30 * 1000; // 30 seconds
const FETCH_TIMEOUT_MS = 1_500;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getCacheDir(homeDir: string): string {
  return join(homeDir, '.myshell-tools');
}

function getCachePath(homeDir: string): string {
  return join(getCacheDir(homeDir), 'update-check.json');
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Load the update cache from disk.  Returns null on missing/corrupt file.
 * Never throws.
 */
export async function loadUpdateCache(homeDir?: string): Promise<UpdateCache | null> {
  const home = homeDir ?? homedir();
  try {
    const raw = await readFile(getCachePath(home), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'checkedAt' in parsed &&
      'latest' in parsed &&
      typeof (parsed as Record<string, unknown>)['checkedAt'] === 'number' &&
      typeof (parsed as Record<string, unknown>)['latest'] === 'string'
    ) {
      return parsed as UpdateCache;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the update cache atomically.  Creates the .myshell-tools directory
 * if it does not exist.  Never throws.
 */
export async function saveUpdateCache(
  latest: string,
  now: number,
  homeDir?: string,
): Promise<void> {
  const home = homeDir ?? homedir();
  try {
    await mkdir(getCacheDir(home), { recursive: true });
    const cache: UpdateCache = { checkedAt: now, latest };
    await atomicWrite(getCachePath(home), JSON.stringify(cache, null, 2));
  } catch {
    // Silently ignore — failing to cache is not a fatal error.
  }
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver-ish version strings.
 *
 * Splits on `.`, compares numeric major/minor/patch segments in order.
 * Any `-prerelease` suffix is stripped before comparison.
 * Non-numeric segments are treated as 0.
 * Returns true iff latest > current.
 * Never throws.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  try {
    const parse = (v: string): number[] => {
      // Strip any prerelease suffix (e.g. "1.2.3-beta.1" → "1.2.3")
      const base = v.split('-')[0] ?? '';
      return base.split('.').map((part) => {
        const n = parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
    };

    const lParts = parse(latest);
    const cParts = parse(current);

    const len = Math.max(lParts.length, cParts.length);
    for (let i = 0; i < len; i++) {
      const l = lParts[i] ?? 0;
      const c = cParts[i] ?? 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false; // equal
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// npm registry fetch (real network — injected in tests)
// ---------------------------------------------------------------------------

/**
 * Fetch the latest published version of myshell-tools from the npm registry.
 *
 * Uses global fetch with a 1500ms AbortSignal timeout.
 * Returns the version string, or null on any error/timeout.
 * Never throws.
 */
export async function fetchLatestFromNpm(): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => { ac.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://registry.npmjs.org/myshell-tools/latest', {
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as unknown;
    if (
      data !== null &&
      typeof data === 'object' &&
      'version' in data &&
      typeof (data as Record<string, unknown>)['version'] === 'string'
    ) {
      return (data as Record<string, string>)['version'] ?? null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CheckForUpdateOpts {
  readonly currentVersion: string;
  readonly now: number;
  readonly homeDir?: string;
  readonly ttlMs?: number;
  readonly fetchLatest?: () => Promise<string | null>;
}

/**
 * Check whether a newer version of myshell-tools is available.
 *
 * Uses a cache file so the npm registry is only contacted once per TTL (default 24h).
 * If the cache is fresh, the registry is NOT contacted at all.
 * On any error returns { current, latest: null, updateAvailable: false }.
 * Never throws.
 */
export async function checkForUpdate(opts: CheckForUpdateOpts): Promise<UpdateCheckResult> {
  const { currentVersion, now, homeDir, ttlMs = TTL_MS_DEFAULT } = opts;
  const fetchFn = opts.fetchLatest ?? fetchLatestFromNpm;

  try {
    // Check if we have a fresh cache
    const cache = await loadUpdateCache(homeDir);
    if (cache !== null) {
      const updateAvailable = isNewerVersion(cache.latest, currentVersion);
      // A cache that already knows about a pending update is trustworthy for the
      // full TTL — re-asking npm won't teach us anything new. But a cache that
      // says "you're current" is precisely the one a new publish invalidates, so
      // re-check it on the 30s clock. This is what closes the "just published,
      // re-ran, but it still says I'm on the latest" blind spot.
      const effectiveTtl = updateAvailable ? ttlMs : Math.min(ttlMs, TTL_MS_WHEN_CURRENT);
      if (now - cache.checkedAt < effectiveTtl) {
        return { current: currentVersion, latest: cache.latest, updateAvailable };
      }
    }

    // Cache is stale or missing — fetch from the registry
    const latest = await fetchFn();
    if (latest !== null) {
      await saveUpdateCache(latest, now, homeDir);
    }

    if (latest === null) {
      return { current: currentVersion, latest: null, updateAvailable: false };
    }

    const updateAvailable = isNewerVersion(latest, currentVersion);
    return { current: currentVersion, latest, updateAvailable };
  } catch {
    return { current: currentVersion, latest: null, updateAvailable: false };
  }
}
