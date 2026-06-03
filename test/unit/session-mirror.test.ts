import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveConversation, syncConversationMirror } from '../../src/infra/session-mirror.ts';

const convDir = (home: string): string => join(home, '.myshell-tools', 'conversations');
const archDir = (home: string): string => join(home, '.myshell-tools', '.session-archive');

const newHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'mirror-'));
  await mkdir(convDir(home), { recursive: true });
  return home;
};

describe('syncConversationMirror', () => {
  it('copies new conversation logs into the archive', async () => {
    const home = await newHome();
    await writeFile(join(convDir(home), 'a.jsonl'), 'line1\nline2\n');
    await writeFile(join(convDir(home), 'b.jsonl'), 'x\n');

    const r = await syncConversationMirror(home);
    assert.deepEqual(r, { copied: 2, grew: 0 });
    assert.equal(await readFile(join(archDir(home), 'a.jsonl'), 'utf8'), 'line1\nline2\n');
    assert.equal(await readFile(join(archDir(home), 'b.jsonl'), 'utf8'), 'x\n');
  });

  it('only grows — re-syncing an unchanged file is a no-op', async () => {
    const home = await newHome();
    await writeFile(join(convDir(home), 'a.jsonl'), 'one\n');
    await syncConversationMirror(home);
    const r2 = await syncConversationMirror(home);
    assert.deepEqual(r2, { copied: 0, grew: 0 }, 'unchanged file must not be re-copied');
  });

  it('updates the archive when the live log grows', async () => {
    const home = await newHome();
    await writeFile(join(convDir(home), 'a.jsonl'), 'one\n');
    await syncConversationMirror(home);
    await writeFile(join(convDir(home), 'a.jsonl'), 'one\ntwo\nthree\n'); // grew
    const r = await syncConversationMirror(home);
    assert.deepEqual(r, { copied: 0, grew: 1 });
    assert.equal(await readFile(join(archDir(home), 'a.jsonl'), 'utf8'), 'one\ntwo\nthree\n');
  });

  it('never shrinks the archive when the live log is truncated', async () => {
    const home = await newHome();
    await writeFile(join(convDir(home), 'a.jsonl'), 'full\ncontent\nhere\n');
    await syncConversationMirror(home);
    await writeFile(join(convDir(home), 'a.jsonl'), 'oops\n'); // truncated/corrupted
    const r = await syncConversationMirror(home);
    assert.deepEqual(r, { copied: 0, grew: 0 }, 'a smaller live file must not overwrite the archive');
    assert.equal(
      await readFile(join(archDir(home), 'a.jsonl'), 'utf8'),
      'full\ncontent\nhere\n',
      'archive keeps the larger prior content',
    );
  });

  it('ignores non-jsonl files (e.g. index.json) and a missing dir', async () => {
    const home = await newHome();
    await writeFile(join(convDir(home), 'index.json'), '[]');
    const r = await syncConversationMirror(home);
    assert.deepEqual(r, { copied: 0, grew: 0 });

    const empty = await mkdtemp(join(tmpdir(), 'mirror-empty-'));
    assert.deepEqual(await syncConversationMirror(empty), { copied: 0, grew: 0 }, 'no conversations dir → no throw');
  });
});

describe('archiveConversation (archive-before-delete)', () => {
  it('preserves a conversation in the archive so a delete is recoverable', async () => {
    const home = await newHome();
    await writeFile(join(convDir(home), 'doomed.jsonl'), 'precious\nhistory\n');

    await archiveConversation('doomed', home);

    assert.ok(existsSync(join(archDir(home), 'doomed.jsonl')), 'archived before delete');
    assert.equal(await readFile(join(archDir(home), 'doomed.jsonl'), 'utf8'), 'precious\nhistory\n');
    // Even after the live file is "deleted", the archive still holds the content.
    const archived = await readdir(archDir(home));
    assert.ok(archived.includes('doomed.jsonl'));
  });

  it('is a silent no-op when the conversation file does not exist', async () => {
    const home = await newHome();
    await assert.doesNotReject(() => archiveConversation('ghost', home));
    assert.ok(!existsSync(join(archDir(home), 'ghost.jsonl')));
  });
});
