/**
 * Project-scoped AI checkpoint persistence.
 *
 * Stores only AI change checkpoints, not user secrets. The actual undo decision
 * remains pure in core/ai-checkpoint.ts; this layer only persists and retrieves
 * checkpoint records for the current repo/workspace.
 */

import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { AiChangeCheckpoint, AiCheckpointFile } from '../core/ai-checkpoint.js';
import { atomicWrite } from './atomic.js';
import { defaultStateLayout, projectStateDirs, type AppStateLayout } from './state-layout.js';

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
