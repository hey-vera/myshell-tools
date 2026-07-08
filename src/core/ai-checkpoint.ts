/**
 * Pure AI change checkpoint and undo planner.
 *
 * This module deliberately performs no filesystem writes. It records enough
 * before/after evidence for an impure layer to undo AI-authored changes safely,
 * while refusing to overwrite user edits made after the checkpoint.
 */

export type AiCheckpointFileKind = 'created' | 'modified' | 'deleted';

export interface AiCheckpointFile {
  readonly path: string;
  readonly kind: AiCheckpointFileKind;
  readonly beforeText?: string;
  readonly afterText?: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}

export interface AiChangeCheckpoint {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly repoRoot: string;
  readonly intent: string;
  readonly files: readonly AiCheckpointFile[];
}

export interface CheckpointFileInput {
  readonly path: string;
  readonly beforeText?: string | null;
  readonly afterText?: string | null;
}

export interface BuildAiCheckpointInput {
  readonly id: string;
  readonly createdAt: string;
  readonly repoRoot: string;
  readonly intent: string;
  readonly files: readonly CheckpointFileInput[];
}

export type UndoAction =
  | { readonly type: 'write'; readonly path: string; readonly text: string }
  | { readonly type: 'delete'; readonly path: string };

export interface UndoConflict {
  readonly path: string;
  readonly reason: 'current-changed-after-ai' | 'missing-after-ai' | 'checkpoint-invalid';
  readonly expectedHash: string | null;
  readonly actualHash: string | null;
}

export interface UndoPlan {
  readonly ok: boolean;
  readonly checkpointId: string;
  readonly actions: readonly UndoAction[];
  readonly conflicts: readonly UndoConflict[];
}

export function hashText(text: string): string {
  // Pure, deterministic local fingerprint for checkpoint change detection.
  // This is not a security boundary; it avoids importing node:crypto into core.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function kindOf(beforeText: string | null, afterText: string | null): AiCheckpointFileKind | null {
  if (beforeText === null && afterText === null) return null;
  if (beforeText === null) return 'created';
  if (afterText === null) return 'deleted';
  return 'modified';
}

export function buildAiCheckpoint(input: BuildAiCheckpointInput): AiChangeCheckpoint {
  const files: AiCheckpointFile[] = [];
  for (const file of input.files) {
    const beforeText = file.beforeText ?? null;
    const afterText = file.afterText ?? null;
    const kind = kindOf(beforeText, afterText);
    if (kind === null) continue;
    if (beforeText !== null && afterText !== null && beforeText === afterText) continue;

    files.push({
      path: normalizePath(file.path),
      kind,
      beforeHash: beforeText === null ? null : hashText(beforeText),
      afterHash: afterText === null ? null : hashText(afterText),
      ...(beforeText === null ? {} : { beforeText }),
      ...(afterText === null ? {} : { afterText }),
    });
  }

  return {
    version: 1,
    id: input.id,
    createdAt: input.createdAt,
    repoRoot: input.repoRoot,
    intent: input.intent,
    files,
  };
}

export function planUndoAiCheckpoint(
  checkpoint: AiChangeCheckpoint,
  currentTextByPath: ReadonlyMap<string, string | null | undefined>,
): UndoPlan {
  const actions: UndoAction[] = [];
  const conflicts: UndoConflict[] = [];

  for (const file of checkpoint.files) {
    const currentText = currentTextByPath.get(file.path) ?? null;
    const actualHash = currentText === null ? null : hashText(currentText);

    if (actualHash !== file.afterHash) {
      conflicts.push({
        path: file.path,
        reason: actualHash === null ? 'missing-after-ai' : 'current-changed-after-ai',
        expectedHash: file.afterHash,
        actualHash,
      });
      continue;
    }

    if (file.kind === 'created') {
      actions.push({ type: 'delete', path: file.path });
      continue;
    }

    if (file.beforeText === undefined) {
      conflicts.push({
        path: file.path,
        reason: 'checkpoint-invalid',
        expectedHash: file.afterHash,
        actualHash,
      });
      continue;
    }

    actions.push({ type: 'write', path: file.path, text: file.beforeText });
  }

  return {
    ok: conflicts.length === 0,
    checkpointId: checkpoint.id,
    actions: conflicts.length === 0 ? actions : [],
    conflicts,
  };
}
