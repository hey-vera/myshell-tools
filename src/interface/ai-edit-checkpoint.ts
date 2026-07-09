/**
 * Capture an AI-edit checkpoint from working-tree deltas after a model turn.
 *
 * Pure orchestration over injected ports: compares post-turn dirty files to a
 * pre-turn content map (and HEAD for previously-clean paths), then persists via
 * the AI checkpoint store. Best-effort: callers should swallow errors so chrome
 * never blocks chat.
 */

import { buildAiCheckpoint, type AiChangeCheckpoint } from '../core/ai-checkpoint.js';
import type { AiCheckpointStore } from '../infra/ai-checkpoint-store.js';
import type { LocalRepoOps } from '../infra/repo-ops.js';

const DEFAULT_MAX_FILES = 40;
const INTENT_CAP = 200;

export interface CaptureAiEditCheckpointDeps {
  readonly cwd: string;
  readonly intent: string;
  readonly id: string;
  readonly createdAt: string;
  /** Pre-turn contents of files that were already dirty (path → text). */
  readonly preContents: ReadonlyMap<string, string>;
  readonly repoOps: Pick<LocalRepoOps, 'status' | 'readHeadContent'>;
  readonly readFileText: (path: string) => Promise<string | null>;
  readonly store: Pick<AiCheckpointStore, 'save'>;
  /** Cap files recorded per checkpoint (avoid huge dumps). */
  readonly maxFiles?: number;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

/**
 * If the working tree has AI-authored (or any) dirty files after a turn, build
 * and save a checkpoint. Returns null when there is nothing useful to record.
 */
export async function captureAiEditCheckpoint(
  deps: CaptureAiEditCheckpointDeps,
): Promise<AiChangeCheckpoint | null> {
  const status = await deps.repoOps.status(deps.cwd);
  if (!status.isGitRepo || status.changedFiles.length === 0) return null;

  const maxFiles = deps.maxFiles ?? DEFAULT_MAX_FILES;
  const paths = status.changedFiles.slice(0, maxFiles);
  const fileInputs: Array<{
    path: string;
    beforeText: string | null;
    afterText: string | null;
  }> = [];

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    const afterText = await deps.readFileText(path);
    let beforeText: string | null;
    if (deps.preContents.has(path)) {
      beforeText = deps.preContents.get(path) ?? null;
    } else if (deps.preContents.has(rawPath)) {
      beforeText = deps.preContents.get(rawPath) ?? null;
    } else {
      beforeText = await deps.repoOps.readHeadContent(deps.cwd, path);
    }
    if (beforeText === afterText) continue;
    fileInputs.push({ path, beforeText, afterText });
  }

  if (fileInputs.length === 0) return null;

  const checkpoint = buildAiCheckpoint({
    id: deps.id,
    createdAt: deps.createdAt,
    repoRoot: deps.cwd,
    intent: deps.intent.trim().slice(0, INTENT_CAP),
    files: fileInputs,
  });
  if (checkpoint.files.length === 0) return null;

  await deps.store.save(checkpoint);
  return checkpoint;
}
