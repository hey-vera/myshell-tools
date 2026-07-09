import { describe, expect, it } from 'vitest';

import { hashText } from '../../src/core/ai-checkpoint.js';
import { captureAiEditCheckpoint } from '../../src/interface/ai-edit-checkpoint.js';

describe('captureAiEditCheckpoint', () => {
  it('returns null when not a git repo', async () => {
    const saved: unknown[] = [];
    const result = await captureAiEditCheckpoint({
      cwd: '/repo',
      intent: 'fix foo',
      id: 'cp-1',
      createdAt: '2026-07-09T00:00:00.000Z',
      preContents: new Map(),
      repoOps: {
        async status() {
          return { isGitRepo: false, clean: true, changedFiles: [], raw: '' };
        },
        async readHeadContent() {
          return null;
        },
      },
      async readFileText() {
        return null;
      },
      store: {
        async save(cp) {
          saved.push(cp);
        },
      },
    });
    expect(result).toBeNull();
    expect(saved).toEqual([]);
  });

  it('returns null when working tree is clean', async () => {
    const result = await captureAiEditCheckpoint({
      cwd: '/repo',
      intent: 'no edits',
      id: 'cp-2',
      createdAt: '2026-07-09T00:00:00.000Z',
      preContents: new Map(),
      repoOps: {
        async status() {
          return { isGitRepo: true, clean: true, changedFiles: [], raw: '' };
        },
        async readHeadContent() {
          return null;
        },
      },
      async readFileText() {
        return 'x';
      },
      store: {
        async save() {},
      },
    });
    expect(result).toBeNull();
  });

  it('saves a checkpoint for modified + created files using preContents and HEAD', async () => {
    const saved: Array<{ id: string; files: readonly { path: string; kind: string }[] }> = [];
    const result = await captureAiEditCheckpoint({
      cwd: '/repo',
      intent: 'fix parser',
      id: 'cp-3',
      createdAt: '2026-07-09T12:00:00.000Z',
      preContents: new Map([['src/a.ts', 'before-a']]),
      repoOps: {
        async status() {
          return {
            isGitRepo: true,
            clean: false,
            changedFiles: ['src/a.ts', 'src/new.ts'],
            raw: ' M src/a.ts\n?? src/new.ts',
          };
        },
        async readHeadContent(_cwd, path) {
          if (path === 'src/a.ts') return 'head-a';
          return null;
        },
      },
      async readFileText(path) {
        if (path === 'src/a.ts') return 'after-a';
        if (path === 'src/new.ts') return 'brand new';
        return null;
      },
      store: {
        async save(cp) {
          saved.push({ id: cp.id, files: cp.files.map((f) => ({ path: f.path, kind: f.kind })) });
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe('cp-3');
    expect(result!.intent).toBe('fix parser');
    expect(result!.files).toHaveLength(2);
    const mod = result!.files.find((f) => f.path === 'src/a.ts');
    const created = result!.files.find((f) => f.path === 'src/new.ts');
    expect(mod?.kind).toBe('modified');
    expect(mod?.beforeText).toBe('before-a');
    expect(mod?.afterText).toBe('after-a');
    expect(mod?.beforeHash).toBe(hashText('before-a'));
    expect(created?.kind).toBe('created');
    expect(created?.beforeText).toBeUndefined();
    expect(created?.afterText).toBe('brand new');
    expect(saved).toHaveLength(1);
  });

  it('uses HEAD content when file was clean before the turn', async () => {
    const result = await captureAiEditCheckpoint({
      cwd: '/repo',
      intent: 'edit clean file',
      id: 'cp-4',
      createdAt: '2026-07-09T12:00:00.000Z',
      preContents: new Map(), // was clean pre-turn
      repoOps: {
        async status() {
          return {
            isGitRepo: true,
            clean: false,
            changedFiles: ['src/b.ts'],
            raw: ' M src/b.ts',
          };
        },
        async readHeadContent() {
          return 'from-head';
        },
      },
      async readFileText() {
        return 'after-edit';
      },
      store: {
        async save() {},
      },
    });

    expect(result?.files).toHaveLength(1);
    expect(result?.files[0]?.beforeText).toBe('from-head');
    expect(result?.files[0]?.afterText).toBe('after-edit');
    expect(result?.files[0]?.kind).toBe('modified');
  });
});
