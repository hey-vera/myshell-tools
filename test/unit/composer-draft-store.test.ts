/**
 * Durable composer draft store (multi-chat PR-A).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withStateHome } from '../with-state-home.ts';
import {
  clearComposerDraft,
  composerDraftPath,
  createDebouncedDraftSaver,
  loadComposerDraft,
  saveComposerDraft,
} from '../../src/infra/composer-draft-store.ts';

describe('composer-draft-store', () => {
  it('saves, loads, and clears a draft under state home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-draft-'));
    try {
      await withStateHome(home, async () => {
        const id = 'conv-abc123';
        assert.equal(await loadComposerDraft(id), '');
        await saveComposerDraft(id, 'half typed message');
        assert.equal(await loadComposerDraft(id), 'half typed message');
        const path = composerDraftPath(id);
        assert.ok(path !== null && path.includes('drafts'));
        await clearComposerDraft(id);
        assert.equal(await loadComposerDraft(id), '');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('empty text clears the draft file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-draft-'));
    try {
      await withStateHome(home, async () => {
        const id = 'conv-empty';
        await saveComposerDraft(id, 'something');
        assert.equal(await loadComposerDraft(id), 'something');
        await saveComposerDraft(id, '');
        assert.equal(await loadComposerDraft(id), '');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects path-traversal conversation ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-draft-'));
    try {
      await withStateHome(home, async () => {
        assert.equal(composerDraftPath('../evil'), null);
        assert.equal(composerDraftPath('a/b'), null);
        await saveComposerDraft('../evil', 'nope');
        assert.equal(await loadComposerDraft('../evil'), '');
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('debounced saver flush writes immediately', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-draft-'));
    try {
      await withStateHome(home, async () => {
        const id = 'conv-debounce';
        const saver = createDebouncedDraftSaver(id, 60_000);
        saver.schedule('pending flush text');
        // Without flush, debounce would wait a minute — flush must write now.
        await saver.flush();
        assert.equal(await loadComposerDraft(id), 'pending flush text');
        saver.dispose();
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
