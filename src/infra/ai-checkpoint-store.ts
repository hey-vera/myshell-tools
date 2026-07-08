/**
 * Project-scoped AI checkpoint persistence.
 *
 * Stores only AI change checkpoints, not user secrets. The actual undo decision
 * remains pure in core/ai-checkpoint.ts; this layer only persists and retrieves
 * checkpoint records for the current repo/workspace.
 */

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AiChangeCheckpoint, AiCheckpointFile } from '../core/ai-checkpoint.js';
import type { CheckpointFileInput } from '../core/ai-checkpoint.js';
import { buildAiCheckpoint } from '../core/ai-checkpoint.js';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout, projectStateDirs, type AppStateLayout } from './state-layout.js';

const execFileAsync = promisify(execFile);

export interface AiCheckpointStore {
  readonly save: (checkpoint: AiChangeCheckpoint) => Promise<void>;
  readonly get: (id: string) => Promise<AiChangeCheckpoint | null>;
  readonly latest: () => Promise<AiChangeCheckpoint | null>;
  readonly list: () => Promise<readonly AiChangeCheckpoint[]>;
}

export interface CreateAiCheckpointStoreOptions {
  readonly cwd: string;
  readonly layout?: AppStateLayout;
}

function checkpointDir(layout: AppStateLayout, cwd: string): string {
  return join(projectStateDirs(layout, cwd).root, 'ai-checkpoints');
}

function checkpointPath(layout: AppStateLayout, cwd: string, id: string): string {
  return join(checkpointDir(layout, cwd), `${safeId(id)}.json`);
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'checkpoint';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCheckpointFile(value: unknown): value is AiCheckpointFile {
  if (!isRecord(value)) return false;
  const kind = value['kind'];
  return (
    typeof value['path'] === 'string' &&
    (kind === 'created' || kind === 'modified' || kind === 'deleted') &&
    (typeof value['beforeHash'] === 'string' || value['beforeHash'] === null) &&
    (typeof value['afterHash'] === 'string' || value['afterHash'] === null) &&
    (value['beforeText'] === undefined || typeof value['beforeText'] === 'string') &&
    (value['afterText'] === undefined || typeof value['afterText'] === 'string')
  );
}

export function parseAiCheckpoint(value: unknown): AiChangeCheckpoint | null {
  if (!isRecord(value)) return null;
  if (value['version'] !== 1) return null;
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return null;
  if (typeof value['createdAt'] !== 'string' || value['createdAt'].length === 0) return null;
  if (typeof value['repoRoot'] !== 'string' || value['repoRoot'].length === 0) return null;
  if (typeof value['intent'] !== 'string') return null;
  if (!Array.isArray(value['files']) || !value['files'].every(isCheckpointFile)) return null;

  return {
    version: 1,
    id: value['id'],
    createdAt: value['createdAt'],
    repoRoot: value['repoRoot'],
    intent: value['intent'],
    files: value['files'],
  };
}

async function readCheckpoint(path: string): Promise<AiChangeCheckpoint | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return parseAiCheckpoint(JSON.parse(raw));
  } catch {
    /* ignore git show / read error for before fallback */
    return null;
  }
}

export function createAiCheckpointStore(opts: CreateAiCheckpointStoreOptions): AiCheckpointStore {
  const layout = opts.layout ?? defaultStateLayout();
  const cwd = opts.cwd;
  const dir = checkpointDir(layout, cwd);

  return {
    async save(checkpoint: AiChangeCheckpoint): Promise<void> {
      await mkdir(dir, { recursive: true });
      const path = checkpointPath(layout, cwd, checkpoint.id);
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(path, JSON.stringify(checkpoint, null, 2), 0o600);
    },

    async get(id: string): Promise<AiChangeCheckpoint | null> {
      return readCheckpoint(checkpointPath(layout, cwd, id));
    },

    async list(): Promise<readonly AiChangeCheckpoint[]> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const checkpoints = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map((name) => readCheckpoint(join(dir, name))),
      );
      return checkpoints
        .filter((checkpoint): checkpoint is AiChangeCheckpoint => checkpoint !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async latest(): Promise<AiChangeCheckpoint | null> {
      const checkpoints = await this.list();
      return checkpoints.at(-1) ?? null;
    },
  };
}

export async function capturePreEditSnapshot(cwd: string): Promise<ReadonlyMap<string, string>> {
  const map = new Map<string, string>();
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd, timeout: 3000 });
    const dirty: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const rel = line.slice(3).trim();
      if (rel.length > 0) dirty.push(rel.replace(/\\/g, '/'));
    }
    for (const p of dirty) {
      try {
        const txt = await readFile(join(cwd, p), 'utf8');
        map.set(p, txt);
      } catch { /* ignore */ }
    }
  } catch { /* ignore fs/git errors for pre-snapshot */ }
  return map;
}

async function readFromGitHead(cwd: string, relPath: string): Promise<string | null> {
  const p = relPath.replace(/\\/g, '/');
  try {
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${p}`], { cwd, timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    /* ignore git show / read error for before fallback */
    return null;
  }
}

export function createAiCheckpointCreator(opts: { readonly cwd: string; readonly layout?: AppStateLayout }) {
  return async (input: {
    readonly intent: string;
    readonly changedPaths: readonly string[];
    readonly preSnapshot?: ReadonlyMap<string, string>;
    readonly createdAt: string;
  }): Promise<void> => {
    const { intent, changedPaths = [], preSnapshot, createdAt } = input;
    if (!changedPaths || changedPaths.length === 0) return;
    const fileInputs: CheckpointFileInput[] = [];
    for (const raw of changedPaths) {
      const path = String(raw).replace(/\\/g, '/');
      let beforeText: string | null = (preSnapshot && preSnapshot.get(path)) ?? null;
      if (beforeText === null) {
        beforeText = await readFromGitHead(opts.cwd, path);
      }
      let afterText: string | null = null;
      try {
        afterText = await readFile(join(opts.cwd, path), 'utf8');
      } catch { /* ignore read after for deleted */ }
      fileInputs.push({ path, beforeText: beforeText ?? null, afterText: afterText ?? null });
    }
    const cp = buildAiCheckpoint({
      id: `ai-${createdAt.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt,
      repoRoot: opts.cwd,
      intent: String(intent || 'turn').slice(0, 200),
      files: fileInputs,
    });
    if (cp.files.length === 0) return;
    const store = createAiCheckpointStore({ cwd: opts.cwd, ...(opts.layout ? { layout: opts.layout } : {}) });
    await store.save(cp);
  };
}
