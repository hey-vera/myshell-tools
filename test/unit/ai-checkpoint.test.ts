import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildAiCheckpoint,
  hashText,
  planUndoAiCheckpoint,
} from '../../src/core/ai-checkpoint.ts';

describe('ai checkpoint undo planning', () => {
  it('plans writes/deletes to restore modified, created, and deleted files', () => {
    const checkpoint = buildAiCheckpoint({
      id: 'cp-1',
      createdAt: '2026-07-07T00:00:00.000Z',
      repoRoot: '/repo',
      intent: 'fix tests',
      files: [
        { path: 'src/a.ts', beforeText: 'old', afterText: 'new' },
        { path: 'src/new.ts', beforeText: null, afterText: 'created' },
        { path: 'src/deleted.ts', beforeText: 'gone', afterText: null },
      ],
    });

    const plan = planUndoAiCheckpoint(
      checkpoint,
      new Map([
        ['src/a.ts', 'new'],
        ['src/new.ts', 'created'],
        ['src/deleted.ts', null],
      ]),
    );

    assert.equal(plan.ok, true);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.actions, [
      { type: 'write', path: 'src/a.ts', text: 'old' },
      { type: 'delete', path: 'src/new.ts' },
      { type: 'write', path: 'src/deleted.ts', text: 'gone' },
    ]);
  });

  it('refuses undo when a user changed an AI-touched file after the checkpoint', () => {
    const checkpoint = buildAiCheckpoint({
      id: 'cp-2',
      createdAt: '2026-07-07T00:00:00.000Z',
      repoRoot: '/repo',
      intent: 'fix tests',
      files: [{ path: 'src/a.ts', beforeText: 'old', afterText: 'new' }],
    });

    const plan = planUndoAiCheckpoint(checkpoint, new Map([['src/a.ts', 'user edit']]));

    assert.equal(plan.ok, false);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.conflicts, [{
      path: 'src/a.ts',
      reason: 'current-changed-after-ai',
      expectedHash: hashText('new'),
      actualHash: hashText('user edit'),
    }]);
  });

  it('refuses undo when a file expected after AI work is missing', () => {
    const checkpoint = buildAiCheckpoint({
      id: 'cp-3',
      createdAt: '2026-07-07T00:00:00.000Z',
      repoRoot: '/repo',
      intent: 'create file',
      files: [{ path: 'src/new.ts', beforeText: null, afterText: 'created' }],
    });

    const plan = planUndoAiCheckpoint(checkpoint, new Map([['src/new.ts', null]]));

    assert.equal(plan.ok, false);
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.conflicts[0]?.reason, 'missing-after-ai');
  });

  it('normalizes windows paths and skips unchanged files', () => {
    const checkpoint = buildAiCheckpoint({
      id: 'cp-4',
      createdAt: '2026-07-07T00:00:00.000Z',
      repoRoot: '/repo',
      intent: 'edit',
      files: [
        { path: '.\\src\\a.ts', beforeText: 'a', afterText: 'b' },
        { path: 'same.ts', beforeText: 'same', afterText: 'same' },
      ],
    });

    assert.equal(checkpoint.files.length, 1);
    assert.equal(checkpoint.files[0]?.path, 'src/a.ts');
  });
});
