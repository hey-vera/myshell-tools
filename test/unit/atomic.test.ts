/**
 * Unit tests for src/infra/atomic.ts
 * Run with: node --experimental-strip-types --test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireLock,
  releaseLock,
  withLock,
  atomicWrite,
  atomicAppendJSONL,
  LockTimeoutError,
} from '../../src/infra/atomic.ts';

// ---------------------------------------------------------------------------
// Shared temp directory — created once, cleaned up after all tests
// ---------------------------------------------------------------------------

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// acquireLock / releaseLock
// ---------------------------------------------------------------------------

describe('acquireLock / releaseLock', () => {
  it('basic acquire-release cycle', async () => {
    const lockPath = join(dir, 'basic.lock');
    await acquireLock(lockPath);
    // Lock file must exist while held
    const { stat } = await import('node:fs/promises');
    await assert.doesNotReject(stat(lockPath));
    await releaseLock(lockPath);
    // Lock file must be gone after release
    await assert.rejects(stat(lockPath), { code: 'ENOENT' });
  });

  it('releaseLock is idempotent (no throw when file absent)', async () => {
    const lockPath = join(dir, 'idempotent.lock');
    await assert.doesNotReject(releaseLock(lockPath));
  });
});

// ---------------------------------------------------------------------------
// withLock
// ---------------------------------------------------------------------------

describe('withLock', () => {
  it('executes fn and returns its value', async () => {
    const lockPath = join(dir, 'wl-basic.lock');
    const result = await withLock(lockPath, async () => 42);
    assert.equal(result, 42);
  });

  it('releases lock even when fn throws', async () => {
    const lockPath = join(dir, 'wl-throws.lock');

    await assert.rejects(
      withLock(lockPath, async () => {
        throw new Error('boom');
      }),
      { message: 'boom' },
    );

    // Lock should have been released — we should be able to acquire it again
    await assert.doesNotReject(
      withLock(lockPath, async () => {
        /* no-op */
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Double-lock timeout
// ---------------------------------------------------------------------------

describe('double-lock', () => {
  it('second acquire times out when first is never released', async () => {
    const lockPath = join(dir, 'double.lock');

    // Acquire and hold
    await acquireLock(lockPath);

    try {
      await assert.rejects(
        acquireLock(lockPath, { timeoutMs: 200, staleMs: 60_000 }),
        (err: unknown) => {
          assert.ok(err instanceof LockTimeoutError, 'expected LockTimeoutError');
          return true;
        },
      );
    } finally {
      await releaseLock(lockPath);
    }
  });
});

// ---------------------------------------------------------------------------
// Stale lock detection
// ---------------------------------------------------------------------------

describe('stale lock', () => {
  it('steals a stale lock and acquires successfully', async () => {
    const lockPath = join(dir, 'stale.lock');

    // Plant a lock file whose mtime we will fake by writing it then waiting,
    // but that's slow — instead write it then use a staleMs of 0 so any lock
    // is immediately considered stale.
    await acquireLock(lockPath);

    // With staleMs=0 the lock we just planted is immediately stale.
    await assert.doesNotReject(
      acquireLock(lockPath, { timeoutMs: 2_000, staleMs: 0 }),
    );

    await releaseLock(lockPath);
  });
});

// ---------------------------------------------------------------------------
// atomicWrite
// ---------------------------------------------------------------------------

describe('atomicWrite', () => {
  it('creates file with correct content', async () => {
    const filePath = join(dir, 'write-test.txt');
    await atomicWrite(filePath, 'hello atomic');
    const content = await readFile(filePath, 'utf8');
    assert.equal(content, 'hello atomic');
  });

  it('overwrites existing file atomically', async () => {
    const filePath = join(dir, 'write-overwrite.txt');
    await atomicWrite(filePath, 'first');
    await atomicWrite(filePath, 'second');
    const content = await readFile(filePath, 'utf8');
    assert.equal(content, 'second');
  });

  it('leaves no tmp file on success', async () => {
    const filePath = join(dir, 'write-no-tmp.txt');
    await atomicWrite(filePath, 'clean');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    const tmps = files.filter((f) => f.startsWith('write-no-tmp.txt.tmp.'));
    assert.equal(tmps.length, 0);
  });
});

// ---------------------------------------------------------------------------
// atomicAppendJSONL
// ---------------------------------------------------------------------------

describe('atomicAppendJSONL', () => {
  it('creates file if it does not exist', async () => {
    const filePath = join(dir, 'append-new.jsonl');
    await atomicAppendJSONL(filePath, { msg: 'first' });
    const content = await readFile(filePath, 'utf8');
    assert.equal(content.trim(), JSON.stringify({ msg: 'first' }));
  });

  it('appends without rewriting — 100 entries all present', async () => {
    const filePath = join(dir, 'append-100.jsonl');

    for (let i = 0; i < 100; i++) {
      await atomicAppendJSONL(filePath, { index: i });
    }

    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 100);

    lines.forEach((line, i) => {
      const parsed = JSON.parse(line) as { index: number };
      assert.equal(parsed.index, i);
    });
  });

  it('appends to an existing file', async () => {
    const filePath = join(dir, 'append-existing.jsonl');
    await atomicAppendJSONL(filePath, { n: 1 });
    await atomicAppendJSONL(filePath, { n: 2 });
    await atomicAppendJSONL(filePath, { n: 3 });

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal((JSON.parse(lines[2]!) as { n: number }).n, 3);
  });
});
