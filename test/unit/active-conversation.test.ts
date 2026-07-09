import { afterAll, beforeAll, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;

vi.mock('../../src/infra/state-layout.ts', () => ({
  defaultStateLayout: () => ({
    paths: {
      activeConversationFile: join(dir, 'active-conversation.json'),
    },
  }),
}));

import {
  readActiveConversation,
  writeActiveConversation,
  clearActiveConversation,
  refreshActiveConversationUpdatedAt,
} from '../../src/infra/active-conversation.ts';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'active-conv-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearActiveConversation();
});

describe('readActiveConversation', () => {
  it('returns null when no marker exists', async () => {
    const result = await readActiveConversation();
    assert.equal(result, null);
  });

  it('returns null for corrupt JSON', async () => {
    const filePath = join(dir, 'active-conversation.json');
    await writeFile(filePath, 'not json', 'utf8');
    const result = await readActiveConversation();
    assert.equal(result, null);
  });

  it('returns null for invalid schema (missing version)', async () => {
    const filePath = join(dir, 'active-conversation.json');
    await writeFile(filePath, JSON.stringify({ conversationId: 'abc' }), 'utf8');
    const result = await readActiveConversation();
    assert.equal(result, null);
  });

  it('returns null for invalid schema (wrong version)', async () => {
    const filePath = join(dir, 'active-conversation.json');
    await writeFile(filePath, JSON.stringify({ version: 2, conversationId: 'abc' }), 'utf8');
    const result = await readActiveConversation();
    assert.equal(result, null);
  });

  it('returns null for empty conversationId', async () => {
    const filePath = join(dir, 'active-conversation.json');
    const marker = {
      version: 1,
      conversationId: '',
      workspaceRoot: null,
      enteredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: 123,
      argv: [],
      reason: 'chat-active',
    };
    await writeFile(filePath, JSON.stringify(marker), 'utf8');
    const result = await readActiveConversation();
    assert.equal(result, null);
  });
});

describe('writeActiveConversation', () => {
  it('writes a valid marker', async () => {
    await writeActiveConversation({ conversationId: 'test-123' });
    const result = await readActiveConversation();
    assert.notEqual(result, null);
    assert.equal(result!.conversationId, 'test-123');
    assert.equal(result!.version, 1);
    assert.equal(result!.reason, 'chat-active');
    assert.equal(result!.workspaceRoot, null);
    assert.equal(typeof result!.enteredAt, 'string');
    assert.equal(typeof result!.updatedAt, 'string');
    assert.equal(typeof result!.pid, 'number');
    assert.ok(Array.isArray(result!.argv));
  });

  it('preserves enteredAt when updating same conversation', async () => {
    await writeActiveConversation({ conversationId: 'test-123' });
    const first = await readActiveConversation();
    await new Promise((r) => setTimeout(r, 10));
    await writeActiveConversation({ conversationId: 'test-123' }, first);
    const second = await readActiveConversation();
    assert.equal(second!.enteredAt, first!.enteredAt);
    assert.notEqual(second!.updatedAt, first!.updatedAt);
  });

  it('resets enteredAt when switching conversations', async () => {
    await writeActiveConversation({ conversationId: 'conv-a' });
    const first = await readActiveConversation();
    await new Promise((r) => setTimeout(r, 10));
    await writeActiveConversation({ conversationId: 'conv-b' }, first);
    const second = await readActiveConversation();
    assert.notEqual(second!.enteredAt, first!.enteredAt);
    assert.equal(second!.conversationId, 'conv-b');
  });

  it('writes workspaceRoot when provided', async () => {
    await writeActiveConversation({ conversationId: 'test-123', workspaceRoot: '/home/user/project' });
    const result = await readActiveConversation();
    assert.equal(result!.workspaceRoot, '/home/user/project');
  });

  it('writes auto-recovered reason', async () => {
    await writeActiveConversation({ conversationId: 'test-123', reason: 'auto-recovered' });
    const result = await readActiveConversation();
    assert.equal(result!.reason, 'auto-recovered');
  });

  it('creates parent directory if missing', async () => {
    const subDir = join(dir, 'nested', 'deep');
    vi.doMock('../../src/infra/state-layout.ts', () => ({
      defaultStateLayout: () => ({
        paths: {
          activeConversationFile: join(subDir, 'active-conversation.json'),
        },
      }),
    }));
    const mod = await import('../../src/infra/active-conversation.ts');
    await mod.writeActiveConversation({ conversationId: 'nested-test' });
    const result = await mod.readActiveConversation();
    assert.equal(result!.conversationId, 'nested-test');
  });
});

describe('clearActiveConversation', () => {
  it('removes the marker file', async () => {
    await writeActiveConversation({ conversationId: 'test-123' });
    await clearActiveConversation();
    const result = await readActiveConversation();
    assert.equal(result, null);
  });

  it('does not throw when no marker exists', async () => {
    await assert.doesNotReject(clearActiveConversation());
  });
});

describe('refreshActiveConversationUpdatedAt', () => {
  it('updates updatedAt without changing enteredAt', async () => {
    await writeActiveConversation({ conversationId: 'test-123' });
    const first = await readActiveConversation();
    await new Promise((r) => setTimeout(r, 10));
    await refreshActiveConversationUpdatedAt();
    const second = await readActiveConversation();
    assert.equal(second!.enteredAt, first!.enteredAt);
    assert.notEqual(second!.updatedAt, first!.updatedAt);
  });

  it('is a no-op when no marker exists', async () => {
    await assert.doesNotReject(refreshActiveConversationUpdatedAt());
  });
});
