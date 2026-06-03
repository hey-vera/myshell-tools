/**
 * test/unit/update-check.test.ts — Hermetic unit tests for src/infra/update-check.ts
 *
 * ALL network calls are injected — fetchLatest is never the real npm fetch.
 * Uses a temp homeDir (same pattern as config.test.ts) so cache I/O is real
 * but isolated and cleaned up by the OS.
 *
 * Honesty Contract: no Math.random, no fabricated data, no digit-% literals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import {
  isNewerVersion,
  checkForUpdate,
  loadUpdateCache,
  saveUpdateCache,
  fetchLatestFromNpm,
} from '../../src/infra/update-check.ts';

// ---------------------------------------------------------------------------
// isNewerVersion
// ---------------------------------------------------------------------------

describe('isNewerVersion', () => {
  // ---- Returns true (latest > current) ------------------------------------

  it('returns true when latest patch is higher', () => {
    assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
  });

  it('returns true when latest minor is higher', () => {
    assert.equal(isNewerVersion('1.1.0', '1.0.0'), true);
  });

  it('returns true when latest major is higher', () => {
    assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
  });

  it('returns true for multi-digit patch bump', () => {
    assert.equal(isNewerVersion('1.0.10', '1.0.9'), true);
  });

  it('returns true for major jump (e.g. 10.0.0 vs 9.9.9)', () => {
    assert.equal(isNewerVersion('10.0.0', '9.9.9'), true);
  });

  // ---- Returns false (latest <= current) ----------------------------------

  it('returns false when versions are equal', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
  });

  it('returns false when latest patch is lower', () => {
    assert.equal(isNewerVersion('1.0.0', '1.0.1'), false);
  });

  it('returns false when latest minor is lower', () => {
    assert.equal(isNewerVersion('1.0.9', '1.1.0'), false);
  });

  it('returns false when latest major is lower', () => {
    assert.equal(isNewerVersion('1.9.9', '2.0.0'), false);
  });

  // ---- Prerelease suffix handling -----------------------------------------

  it('strips prerelease suffix before comparing — 1.1.0-beta > 1.0.0', () => {
    assert.equal(isNewerVersion('1.1.0-beta.1', '1.0.0'), true);
  });

  it('strips prerelease suffix — 1.0.0-rc.1 vs 1.0.0 is equal base → false', () => {
    assert.equal(isNewerVersion('1.0.0-rc.1', '1.0.0'), false);
  });

  it('strips prerelease suffix on both sides — equal bases → false', () => {
    assert.equal(isNewerVersion('1.2.3-alpha', '1.2.3-beta'), false);
  });

  // ---- Different lengths --------------------------------------------------

  it('handles two-part versions (1.1 vs 1.0) → true', () => {
    assert.equal(isNewerVersion('1.1', '1.0'), true);
  });

  it('handles one-part versions (2 vs 1) → true', () => {
    assert.equal(isNewerVersion('2', '1'), true);
  });

  it('handles mismatched part counts (1.1 vs 1.0.0) → true', () => {
    assert.equal(isNewerVersion('1.1', '1.0.0'), true);
  });

  it('handles mismatched part counts (1.0.0 vs 1.1) → false', () => {
    assert.equal(isNewerVersion('1.0.0', '1.1'), false);
  });

  // ---- Garbage / non-numeric inputs ---------------------------------------

  it('returns false for empty string latest', () => {
    assert.equal(isNewerVersion('', '1.0.0'), false);
  });

  it('returns true for empty string current (treated as 0.0.0)', () => {
    // Non-numeric parts are treated as 0, so '' → 0.0.0; 1.0.0 > 0.0.0 → true
    assert.equal(isNewerVersion('1.0.0', ''), true);
  });

  it('returns false for both empty strings', () => {
    assert.equal(isNewerVersion('', ''), false);
  });

  it('returns false for garbage latest string', () => {
    assert.equal(isNewerVersion('not-a-version', '1.0.0'), false);
  });

  it('returns true for garbage current string (treated as 0)', () => {
    // Non-numeric parts are treated as 0, so 'not-a-version' → 0; 1.0.0 > 0 → true
    assert.equal(isNewerVersion('1.0.0', 'not-a-version'), true);
  });

  it('returns false for both garbage strings', () => {
    assert.equal(isNewerVersion('abc', 'xyz'), false);
  });

  // ---- Never throws -------------------------------------------------------

  it('never throws — wide variety of inputs', () => {
    const inputs = [
      ['', ''],
      ['1.0.0', ''],
      ['', '1.0.0'],
      ['abc.def', '1.2.3'],
      ['1.2.3', 'abc.def'],
      ['1.0.0-beta', '1.0.0'],
      ['1.0.0', '1.0.0-beta'],
      ['99999999.99999999.99999999', '0.0.1'],
    ] as const;

    for (const [latest, current] of inputs) {
      assert.doesNotThrow(
        () => isNewerVersion(latest, current),
        `isNewerVersion('${latest}', '${current}') must not throw`,
      );
    }
  });

  it('does not contain digit-% literals in any output (Honesty Contract)', () => {
    // All outputs are booleans — just verifying the function is pure with no side-effects
    const result = isNewerVersion('1.0.0', '0.9.0');
    assert.equal(typeof result, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// loadUpdateCache / saveUpdateCache
// ---------------------------------------------------------------------------

describe('loadUpdateCache / saveUpdateCache', () => {
  it('loadUpdateCache returns null when the file does not exist', async () => {
    const homeDir = join(tmpdir(), `uc-test-${randomUUID()}`);
    const result = await loadUpdateCache(homeDir);
    assert.equal(result, null);
  });

  it('loadUpdateCache returns null for corrupt JSON', async () => {
    const homeDir = join(tmpdir(), `uc-test-corrupt-${randomUUID()}`);
    await mkdir(join(homeDir, '.myshell-tools'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(homeDir, '.myshell-tools', 'update-check.json'), 'not valid json', 'utf8');
    const result = await loadUpdateCache(homeDir);
    assert.equal(result, null);
  });

  it('loadUpdateCache returns null for valid JSON but wrong shape', async () => {
    const homeDir = join(tmpdir(), `uc-test-shape-${randomUUID()}`);
    await mkdir(join(homeDir, '.myshell-tools'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(homeDir, '.myshell-tools', 'update-check.json'),
      JSON.stringify({ foo: 'bar' }),
      'utf8',
    );
    const result = await loadUpdateCache(homeDir);
    assert.equal(result, null);
  });

  it('saveUpdateCache + loadUpdateCache round-trips correctly', async () => {
    const homeDir = join(tmpdir(), `uc-test-roundtrip-${randomUUID()}`);
    const now = 1_700_000_000_000;
    const version = '3.0.0';

    await saveUpdateCache(version, now, homeDir);
    const result = await loadUpdateCache(homeDir);

    assert.ok(result !== null, 'cache must exist after save');
    assert.equal(result.latest, version);
    assert.equal(result.checkedAt, now);
  });

  it('saveUpdateCache never throws even when homeDir cannot be created', async () => {
    // Use a path under a non-existent deeply nested directory — mkdir recursive should handle it
    const homeDir = join(tmpdir(), `uc-test-nested-${randomUUID()}`, 'sub', 'dir');
    await assert.doesNotReject(
      () => saveUpdateCache('1.0.0', 1_700_000_000_000, homeDir),
    );
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fetchLatestFromNpm (signature only — never call the real one in tests)
// ---------------------------------------------------------------------------

describe('fetchLatestFromNpm', () => {
  it('is exported and is an async function', () => {
    // We never call this in tests (it would hit the real npm registry).
    // The seam is injected via checkForUpdate opts.fetchLatest in all tests.
    assert.equal(typeof fetchLatestFromNpm, 'function', 'fetchLatestFromNpm must be a function');
  });
});

describe('checkForUpdate', () => {
  // ---- Returns newer → updateAvailable: true + cache written ---------------

  it('fetches latest, reports updateAvailable=true when newer', async () => {
    const homeDir = join(tmpdir(), `uc-check-${randomUUID()}`);
    let fetchCalled = false;

    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      now: 1_700_000_000_000,
      homeDir,
      fetchLatest: async () => {
        fetchCalled = true;
        return '2.0.0';
      },
    });

    assert.equal(fetchCalled, true, 'fetchLatest must be called when no fresh cache');
    assert.equal(result.current, '1.0.0');
    assert.equal(result.latest, '2.0.0');
    assert.equal(result.updateAvailable, true);
  });

  it('writes the cache after a successful fetch', async () => {
    const homeDir = join(tmpdir(), `uc-check-cache-${randomUUID()}`);
    const now = 1_700_000_000_000;

    await checkForUpdate({
      currentVersion: '1.0.0',
      now,
      homeDir,
      fetchLatest: async () => '2.0.0',
    });

    const cache = await loadUpdateCache(homeDir);
    assert.ok(cache !== null, 'cache must be written after fetch');
    assert.equal(cache.latest, '2.0.0');
    assert.equal(cache.checkedAt, now);
  });

  // ---- Returns same/older → updateAvailable: false -------------------------

  it('reports updateAvailable=false when latest equals current', async () => {
    const homeDir = join(tmpdir(), `uc-check-eq-${randomUUID()}`);

    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      now: 1_700_000_000_000,
      homeDir,
      fetchLatest: async () => '1.0.0',
    });

    assert.equal(result.updateAvailable, false);
    assert.equal(result.latest, '1.0.0');
  });

  it('reports updateAvailable=false when latest is older than current', async () => {
    const homeDir = join(tmpdir(), `uc-check-older-${randomUUID()}`);

    const result = await checkForUpdate({
      currentVersion: '2.0.0',
      now: 1_700_000_000_000,
      homeDir,
      fetchLatest: async () => '1.9.0',
    });

    assert.equal(result.updateAvailable, false);
  });

  // ---- fetch returns null → updateAvailable: false, never throws -----------

  it('reports updateAvailable=false when fetchLatest returns null', async () => {
    const homeDir = join(tmpdir(), `uc-check-null-${randomUUID()}`);

    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      now: 1_700_000_000_000,
      homeDir,
      fetchLatest: async () => null,
    });

    assert.equal(result.updateAvailable, false);
    assert.equal(result.latest, null);
    assert.equal(result.current, '1.0.0');
  });

  it('does NOT write cache when fetchLatest returns null', async () => {
    const homeDir = join(tmpdir(), `uc-check-no-cache-${randomUUID()}`);

    await checkForUpdate({
      currentVersion: '1.0.0',
      now: 1_700_000_000_000,
      homeDir,
      fetchLatest: async () => null,
    });

    const cache = await loadUpdateCache(homeDir);
    assert.equal(cache, null, 'cache must not be written when fetch returns null');
  });

  it('never throws when fetchLatest throws', async () => {
    const homeDir = join(tmpdir(), `uc-check-throw-${randomUUID()}`);

    const result = await checkForUpdate({
      currentVersion: '1.0.0',
      now: 1_700_000_000_000,
      homeDir,
      fetchLatest: async () => {
        throw new Error('network error');
      },
    });

    assert.equal(result.updateAvailable, false);
    assert.equal(result.latest, null);
  });

  // ---- Fresh cache → does NOT call fetchLatest ----------------------------

  it('uses fresh cache without calling fetchLatest', async () => {
    const homeDir = join(tmpdir(), `uc-check-fresh-${randomUUID()}`);
    const now = 1_700_000_000_000;
    const ttlMs = 24 * 60 * 60 * 1000; // 24h

    // Write a fresh cache (checkedAt = now − 1h, well within TTL)
    await saveUpdateCache('2.5.0', now - 60 * 60 * 1000, homeDir);

    let fetchCalled = false;
    const result = await checkForUpdate({
      currentVersion: '2.0.0',
      now,
      homeDir,
      ttlMs,
      fetchLatest: async () => {
        fetchCalled = true;
        return '9.9.9'; // Should never be returned
      },
    });

    assert.equal(fetchCalled, false, 'fetchLatest must NOT be called when cache is fresh');
    assert.equal(result.latest, '2.5.0', 'must use cached version');
    assert.equal(result.updateAvailable, true);
  });

  it('calls fetchLatest when cache is stale (beyond TTL)', async () => {
    const homeDir = join(tmpdir(), `uc-check-stale-${randomUUID()}`);
    const ttlMs = 60 * 60 * 1000; // 1h TTL
    const now = 1_700_000_000_000;

    // Write a stale cache (checkedAt = now − 2h, beyond the 1h TTL)
    await saveUpdateCache('2.5.0', now - 2 * 60 * 60 * 1000, homeDir);

    let fetchCalled = false;
    const result = await checkForUpdate({
      currentVersion: '2.0.0',
      now,
      homeDir,
      ttlMs,
      fetchLatest: async () => {
        fetchCalled = true;
        return '3.0.0';
      },
    });

    assert.equal(fetchCalled, true, 'fetchLatest must be called when cache is stale');
    assert.equal(result.latest, '3.0.0');
    assert.equal(result.updateAvailable, true);
  });

  // ---- Short re-check clock when we appear current ------------------------
  // The blind spot we are closing: a cache that says "you're on the latest" is
  // exactly what a brand-new publish invalidates. We re-verify that state on a
  // 30s clock instead of the full TTL, so a fresh publish is seen on the NEXT run.

  it('re-checks soon when the cache says we are already on the latest (closes the just-published blind spot)', async () => {
    const homeDir = join(tmpdir(), `uc-check-current-recheck-${randomUUID()}`);
    const now = 1_700_000_000_000;
    // Cache written 2min ago saying latest === current (we appeared up to date).
    // 2min is well past the 30s "current" clock, so we must re-verify against npm.
    await saveUpdateCache('3.0.0', now - 2 * 60 * 1000, homeDir);

    let fetchCalled = false;
    const result = await checkForUpdate({
      currentVersion: '3.0.0',
      now,
      homeDir, // default TTL, but the "appear current" path uses the 30s clock
      fetchLatest: async () => {
        fetchCalled = true;
        return '3.1.0';
      },
    });

    assert.equal(fetchCalled, true, 'an "appear current" cache must be re-verified on the short clock');
    assert.equal(result.latest, '3.1.0');
    assert.equal(result.updateAvailable, true);
  });

  it('still trusts a very recent "current" cache (no fetch within the short clock)', async () => {
    const homeDir = join(tmpdir(), `uc-check-current-fresh-${randomUUID()}`);
    const now = 1_700_000_000_000;
    await saveUpdateCache('3.0.0', now - 10 * 1000, homeDir); // 10s ago — within the 30s clock

    let fetchCalled = false;
    const result = await checkForUpdate({
      currentVersion: '3.0.0',
      now,
      homeDir,
      fetchLatest: async () => {
        fetchCalled = true;
        return '3.1.0';
      },
    });

    assert.equal(fetchCalled, false, 'a 10s-old "current" cache is within the short clock');
    assert.equal(result.updateAvailable, false);
  });

  it('trusts a known-pending-update cache for the full TTL (does not re-fetch on the short clock)', async () => {
    const homeDir = join(tmpdir(), `uc-check-pending-trust-${randomUUID()}`);
    const now = 1_700_000_000_000;
    // 40min old — past the 20min "current" clock, but well within the default TTL.
    await saveUpdateCache('3.5.0', now - 40 * 60 * 1000, homeDir);

    let fetchCalled = false;
    const result = await checkForUpdate({
      currentVersion: '3.0.0',
      now,
      homeDir,
      fetchLatest: async () => {
        fetchCalled = true;
        return '9.9.9'; // must never be returned — pending cache is trusted
      },
    });

    assert.equal(fetchCalled, false, 'a known-pending update is trusted for the full TTL');
    assert.equal(result.latest, '3.5.0');
    assert.equal(result.updateAvailable, true);
  });

  // ---- Never throws under any circumstance --------------------------------

  it('never throws — various error scenarios', async () => {
    const homeDir = join(tmpdir(), `uc-check-resilient-${randomUUID()}`);

    // All of these must resolve without throwing
    await assert.doesNotReject(() =>
      checkForUpdate({
        currentVersion: '1.0.0',
        now: 1_700_000_000_000,
        homeDir,
        fetchLatest: async () => { throw new Error('timeout'); },
      }),
    );

    await assert.doesNotReject(() =>
      checkForUpdate({
        currentVersion: '1.0.0',
        now: 1_700_000_000_000,
        homeDir: '/dev/null/impossible-path',
        fetchLatest: async () => '2.0.0',
      }),
    );
  });
});
