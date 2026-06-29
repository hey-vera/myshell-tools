/**
 * test/unit/intent-store.test.ts — unit tests for src/infra/intent-store.ts.
 * Hermetic: temp directory + cleanup.
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createIntentStore, readIntentVersions, readIntentVersionById } from '../../src/infra/intent-store.ts';
import type { IntentVersion } from '../../src/core/intent-version.ts';
import { withStateHome } from '../with-state-home.ts';

function makeVersion(id: string): IntentVersion {
  return {
    version: 1,
    id,
    parentId: null,
    sessionId: 'sess-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    rawUserTurnText: 'ship the feature',
    intent: {
      objective: 'ship the feature',
      confidence: 'high',
      source: 'model',
    },
  };
}

describe('intent-store', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'myshell-intent-store-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('createIntentStore writes and readIntentVersionById returns the matching version', async () => {
    await withStateHome(cwd, async () => {
    const store = createIntentStore({ cwd });
    const v1 = makeVersion('id-1');
    await store.append(v1);

    const found = await readIntentVersionById(cwd, 'id-1');
    assert.ok(found !== null);
    assert.equal(found!.id, 'id-1');
    assert.equal(found!.intent.objective, 'ship the feature');

    const notFound = await readIntentVersionById(cwd, 'nonexistent');
    assert.equal(notFound, null);
    });
  });

  it('readIntentVersions returns empty for missing file', async () => {
    await withStateHome(cwd, async () => {
    const entries = await readIntentVersions('/nonexistent/path/should/fail');
    assert.deepEqual(entries, []);
    });
  });

  it('readIntentVersions skips malformed and wrong-shape rows', async () => {
    await withStateHome(cwd, async () => {
    const store = createIntentStore({ cwd });
    await store.append(makeVersion('id-1'));
    // Write a malformed line directly
    const { writeFile } = await import('node:fs/promises');
    const { getIntentVersionsFile } = await import('../../src/infra/paths.ts');
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(getIntentVersionsFile(cwd), 'utf8');
    const bad = existing + '\nnot json\n{"version":2,"id":"wrong"}\n';
    await writeFile(getIntentVersionsFile(cwd), bad);

    const entries = await readIntentVersions(cwd);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'id-1');
    });
  });
});
