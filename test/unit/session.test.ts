/**
 * Unit tests for src/infra/session.ts
 * Run with: node --experimental-strip-types --test
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createSessionWriter, readSession } from '../../src/infra/session.ts';
import { getSessionFile, getSessionsDir } from '../../src/infra/paths.ts';
import type { SessionEntry } from '../../src/core/types.ts';
import { withStateHome } from '../with-state-home.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    timestamp: new Date().toISOString(),
    role: 'user',
    content: 'Hello, world!',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// append() and readSession()
// ---------------------------------------------------------------------------

describe('createSessionWriter — append and readSession', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `session-test-${randomUUID()}-`));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends two entries and readSession returns them both', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'two-entries');
    const writer = createSessionWriter({ cwd, id: randomUUID() });

    const entry1 = makeEntry({ role: 'user', content: 'first message' });
    const entry2 = makeEntry({ role: 'assistant', content: 'second message' });

    await writer.append(entry1);
    await writer.append(entry2);

    const entries = await readSession(cwd);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.content, 'first message');
    assert.equal(entries[0]?.role, 'user');
    assert.equal(entries[1]?.content, 'second message');
    assert.equal(entries[1]?.role, 'assistant');
    });
  });

  it('writer.id matches the opts.id provided', () => {
    const id = randomUUID();
    const writer = createSessionWriter({ cwd: dir, id });
    assert.equal(writer.id, id);
  });

  it('append creates sessions directory when it does not exist', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'nested-dir-creation');
    const writer = createSessionWriter({ cwd, id: randomUUID() });

    await writer.append(makeEntry({ content: 'dir creation test' }));

    // Verify the sessions directory was created
    const sessionsDir = getSessionsDir(cwd);
    const { stat } = await import('node:fs/promises');
    const st = await stat(sessionsDir);
    assert.ok(st.isDirectory(), 'sessions dir should be a directory');
    });
  });

  it('readSession returns empty array when file does not exist', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'nonexistent-session');
    const entries = await readSession(cwd);
    assert.deepEqual(entries, []);
    });
  });

  it('readSession skips malformed lines', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'malformed-lines');

    // First create a valid entry via the writer (which creates the dir)
    const writer = createSessionWriter({ cwd, id: randomUUID() });
    const validEntry = makeEntry({ content: 'valid entry' });
    await writer.append(validEntry);

    // Now inject a malformed line directly into the file
    const sessionFile = getSessionFile(cwd);
    await appendFile(sessionFile, 'NOT VALID JSON\n', 'utf8');

    // Append another valid entry
    const validEntry2 = makeEntry({ content: 'another valid entry' });
    await writer.append(validEntry2);

    const entries = await readSession(cwd);
    // Should have 2 valid entries; the malformed line is skipped
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.content, 'valid entry');
    assert.equal(entries[1]?.content, 'another valid entry');
    });
  });

  it('readSession skips valid JSON records with the wrong shape', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'wrong-shape-lines');

    const writer = createSessionWriter({ cwd, id: randomUUID() });
    await writer.append(makeEntry({ content: 'valid entry' }));

    await appendFile(
      getSessionFile(cwd),
      ['null', '{}', '{"timestamp":123,"role":"user","content":"bad"}', '123', ''].join('\n'),
      'utf8',
    );

    await writer.append(makeEntry({ role: 'assistant', content: 'another valid entry' }));

    const entries = await readSession(cwd);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.content, 'valid entry');
    assert.equal(entries[1]?.content, 'another valid entry');
    assert.doesNotThrow(() => entries.at(-1)?.content.slice(0, 10));
    });
  });

  it('appended entries preserve optional fields like tier and model', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'optional-fields');
    const writer = createSessionWriter({ cwd, id: randomUUID() });

    const entry = makeEntry({
      role: 'assistant',
      content: 'with optional fields',
      tier: 'ic',
      model: 'claude-sonnet-4-6',
      costUsd: 0.0012,
    });

    await writer.append(entry);

    const entries = await readSession(cwd);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.tier, 'ic');
    assert.equal(entries[0]?.model, 'claude-sonnet-4-6');
    assert.equal(entries[0]?.costUsd, 0.0012);
    });
  });

  it('round-trips persisted workTrace records', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'work-trace');
    const writer = createSessionWriter({ cwd, id: randomUUID() });

    await writer.append(
      makeEntry({
        role: 'assistant',
        content: 'done',
        workTrace: {
          version: 1,
          objective: 'ship the widget',
          checkpoints: [{ id: 'C1', summary: 'implemented the widget' }],
        },
      }),
    );

    const entries = await readSession(cwd);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0]?.workTrace, {
      version: 1,
      objective: 'ship the widget',
      checkpoints: [{ id: 'C1', summary: 'implemented the widget' }],
    });
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrent appends (basic ordering check)
// ---------------------------------------------------------------------------

describe('createSessionWriter — concurrent appends', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `session-concurrent-${randomUUID()}-`));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('10 concurrent appends all persist', async () => {
    await withStateHome(dir, async () => {
    const cwd = join(dir, 'concurrent');
    const writer = createSessionWriter({ cwd, id: randomUUID() });

    const promises = Array.from({ length: 10 }, (_, i) =>
      writer.append(makeEntry({ content: `msg-${i}` })),
    );
    await Promise.all(promises);

    const entries = await readSession(cwd);
    assert.equal(entries.length, 10);
    });
  });
});
