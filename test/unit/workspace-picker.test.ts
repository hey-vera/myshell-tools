import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, vi } from 'vitest';

import type { Clock } from '../../src/core/types.ts';
import type { ConversationMeta, ConversationStore } from '../../src/infra/conversation-store.ts';
import type { MenuContext } from '../../src/interface/menu.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import {
  NAV_ESC,
  NAV_LEFT,
  getMenuStack,
  resetMenuStack,
} from '../../src/interface/menu-key-confirm.ts';

type RankedPriorArg = { workspaceRoot?: string | null; updatedAt: string };

const workspaceSpyState = vi.hoisted(() => ({
  rankCalls: [] as Array<{ currentRoot: string; prior: RankedPriorArg[] }>,
}));

vi.mock('../../src/interface/workspace.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/interface/workspace.ts')>();
  return {
    ...actual,
    rankWorkspaceCandidates: vi.fn((currentRoot: string, prior: RankedPriorArg[], options?: { maxParentDepth?: number; platform?: NodeJS.Platform }) => {
      workspaceSpyState.rankCalls.push({
        currentRoot,
        prior: prior.map((entry) => ({ ...entry })),
      });
      return actual.rankWorkspaceCandidates(currentRoot, prior, options);
    }),
  };
});

import { runWorkspacePicker } from '../../src/interface/workspace-picker.ts';

function makeFakeClock(): Clock {
  let counter = 0;
  const base = 1_700_000_000_000;
  return {
    now: () => base,
    isoNow: () => new Date(base).toISOString(),
    uuid: () => `fake-${++counter}`,
    random: () => 0.5,
  };
}

function makeSink(): OutputSink & { buf: string } {
  let buf = '';
  return {
    get buf() { return buf; },
    write: (s: string) => { buf += s; },
    color: false,
    isTty: false,
  };
}

function makeScriptedReader(lines: ReadonlyArray<string | null>): () => Promise<string | null> {
  let index = 0;
  return async (): Promise<string | null> => {
    if (index >= lines.length) return null;
    const next = lines[index];
    index += 1;
    return next;
  };
}

function normalizeTestPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function makeMeta(id: string, workspaceRoot: string | null, updatedAt: string): ConversationMeta {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    pinned: false,
    category: null,
    ...(workspaceRoot !== null ? { workspaceRoot } : {}),
  };
}

function makeStore(metas: readonly ConversationMeta[]): ConversationStore {
  return {
    list: async () => [...metas],
  } as unknown as ConversationStore;
}

function makeCtx(metas: readonly ConversationMeta[]): MenuContext {
  return {
    version: 'test',
    clock: makeFakeClock(),
    ledger: { record: async () => {} },
    providers: {},
    env: {
      claude: { id: 'claude', installed: true, version: '1.0.0', authenticated: true, plan: null, binaryPath: null, availableModels: ['model-a'] },
      codex: { id: 'codex', installed: false, version: null, authenticated: false, plan: null, binaryPath: null, availableModels: [] },
      opencode: { id: 'opencode', installed: false, version: null, authenticated: false, plan: null, binaryPath: null, availableModels: [] },
      grok: { id: 'grok', installed: false, version: null, authenticated: false, plan: null, binaryPath: null, availableModels: [] },
      hasAnyProvider: true,
      platform: 'linux',
    },
    store: makeStore(metas),
    config: { onboarded: true, setAsDefault: false, smartRoute: false },
    cwd: tmpdir(),
    sandbox: 'workspace-write',
    timeoutMs: 5_000,
    readLine: async () => null,
  } as MenuContext;
}

function makeWorkspaceRoots(): {
  readonly base: string;
  readonly currentRoot: string;
  readonly recentRoot: string;
  readonly olderRoot: string;
} {
  const base = fs.mkdtempSync(join(tmpdir(), 'workspace-picker-'));
  const currentRoot = join(base, 'alpha-repo');
  const recentRoot = join(base, 'beta-repo');
  const olderRoot = join(base, 'gamma-repo');
  fs.mkdirSync(currentRoot, { recursive: true });
  fs.mkdirSync(recentRoot, { recursive: true });
  fs.mkdirSync(olderRoot, { recursive: true });
  return { base, currentRoot, recentRoot, olderRoot };
}

describe('runWorkspacePicker', () => {
  beforeEach(() => {
    resetMenuStack();
    workspaceSpyState.rankCalls.length = 0;
  });

  it('passes the current root and prior workspace roots from store.list to rankWorkspaceCandidates', async () => {
    const { currentRoot, recentRoot, olderRoot } = makeWorkspaceRoots();
    const metas = [
      makeMeta(`conv-${randomUUID()}`, recentRoot, '2024-01-02T00:00:00.000Z'),
      makeMeta(`conv-${randomUUID()}`, null, '2024-01-01T00:00:00.000Z'),
      makeMeta(`conv-${randomUUID()}`, olderRoot, '2024-01-03T00:00:00.000Z'),
    ];
    const sink = makeSink();

    const result = await runWorkspacePicker(
      makeCtx(metas),
      sink,
      makeScriptedReader(['']),
      undefined,
      currentRoot,
    );

    assert.deepEqual(result, { kind: 'select', root: normalizeTestPath(currentRoot) });
    assert.deepEqual(workspaceSpyState.rankCalls, [{
      currentRoot,
      prior: metas.map((meta) => ({
        workspaceRoot: meta.workspaceRoot ?? null,
        updatedAt: meta.updatedAt,
      })),
    }]);
  });

  it('selects the requested numbered row', async () => {
    const { currentRoot, recentRoot, olderRoot } = makeWorkspaceRoots();
    const metas = [
      makeMeta(`conv-${randomUUID()}`, recentRoot, '2024-01-03T00:00:00.000Z'),
      makeMeta(`conv-${randomUUID()}`, olderRoot, '2024-01-02T00:00:00.000Z'),
    ];

    const result = await runWorkspacePicker(
      makeCtx(metas),
      makeSink(),
      makeScriptedReader(['2']),
      undefined,
      currentRoot,
    );

    assert.deepEqual(result, { kind: 'select', root: normalizeTestPath(recentRoot) });
  });

  it('selects the first visible match on Enter', async () => {
    const { currentRoot } = makeWorkspaceRoots();

    const result = await runWorkspacePicker(
      makeCtx([]),
      makeSink(),
      makeScriptedReader(['']),
      undefined,
      currentRoot,
    );

    assert.deepEqual(result, { kind: 'select', root: normalizeTestPath(currentRoot) });
  });

  it('treats non-digit input as a new filter query and re-renders filtered results', async () => {
    const { currentRoot, recentRoot, olderRoot } = makeWorkspaceRoots();
    const metas = [
      makeMeta(`conv-${randomUUID()}`, recentRoot, '2024-01-03T00:00:00.000Z'),
      makeMeta(`conv-${randomUUID()}`, olderRoot, '2024-01-02T00:00:00.000Z'),
    ];
    const sink = makeSink();

    const result = await runWorkspacePicker(
      makeCtx(metas),
      sink,
      makeScriptedReader(['beta', '']),
      undefined,
      currentRoot,
    );

    assert.deepEqual(result, { kind: 'select', root: normalizeTestPath(recentRoot) });
    assert.ok(sink.buf.includes('Filter: beta'), 'filter prompt should show the typed query');
    assert.ok(sink.buf.includes('beta-repo'), 'filtered render should include the matching workspace');
  });

  it('returns back on left-arrow without requesting app exit', async () => {
    const { currentRoot } = makeWorkspaceRoots();

    const result = await runWorkspacePicker(
      makeCtx([]),
      makeSink(),
      makeScriptedReader([]),
      async () => NAV_LEFT,
      currentRoot,
    );

    assert.deepEqual(result, { kind: 'back' });
    assert.equal(getMenuStack().exitRequested, false);
  });

  it('returns exit on ESC and requests app exit', async () => {
    const { currentRoot } = makeWorkspaceRoots();

    const result = await runWorkspacePicker(
      makeCtx([]),
      makeSink(),
      makeScriptedReader([]),
      async () => NAV_ESC,
      currentRoot,
    );

    assert.deepEqual(result, { kind: 'exit' });
    assert.equal(getMenuStack().exitRequested, true);
  });

  it('renders the no-matches line without crashing', async () => {
    const { currentRoot } = makeWorkspaceRoots();
    const sink = makeSink();

    const result = await runWorkspacePicker(
      makeCtx([]),
      sink,
      makeScriptedReader(['does-not-match-anything', null]),
      undefined,
      currentRoot,
    );

    assert.deepEqual(result, { kind: 'exit' });
    assert.ok(sink.buf.includes('(no matches'), 'picker should render the empty-state line');
  });
});
