/**
 * Safe natural-language repo chat handler.
 *
 * This is the interface seam between ordinary user language ("what changed?",
 * "run tests", "undo that") and repo infrastructure. The handler itself stays
 * non-mutating (preview + detection). Execution for undo / test / commit is
 * performed by the caller (menu) behind checkpoint gates + oversight.
 */

import { planUndoAiCheckpoint } from '../core/ai-checkpoint.js';
import { inferRepoIntent, type RepoOperationIntent } from '../core/repo-intent.js';
import type { AiCheckpointStore } from '../infra/ai-checkpoint-store.js';
import type { LocalRepoOps } from '../infra/repo-ops.js';

export interface RepoChatHandled {
  readonly handled: true;
  readonly operation: RepoOperationIntent;
  readonly mutatesWorkspace: false;
  readonly message: string;
}

export interface RepoChatHandlerDeps {
  readonly cwd: string;
  readonly repoOps: Pick<LocalRepoOps, 'status' | 'diff' | 'detectTestCommand'>;
  readonly checkpointStore: Pick<AiCheckpointStore, 'latest'>;
  readonly readFileText?: (path: string) => Promise<string | null>;
}

function handled(operation: RepoOperationIntent, message: string): RepoChatHandled {
  return { handled: true, operation, mutatesWorkspace: false, message };
}

function formatPathList(paths: readonly string[], max = 10): string {
  if (paths.length === 0) return '';
  const shown = paths.slice(0, max).join(', ');
  const remaining = paths.length - max;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function formatCommand(command: { readonly label: string; readonly command: string; readonly args: readonly string[] }): string {
  const raw = [command.command, ...command.args].join(' ').trim();
  return command.label === raw ? raw : `${command.label} (${raw})`;
}

async function currentTextMap(
  paths: readonly string[],
  readFileText: (path: string) => Promise<string | null>,
): Promise<ReadonlyMap<string, string | null>> {
  const entries = await Promise.all(paths.map(async (path) => [path, await readFileText(path)] as const));
  return new Map(entries);
}

export async function handleRepoChatIntent(
  input: string,
  deps: RepoChatHandlerDeps,
): Promise<RepoChatHandled | null> {
  const intent = inferRepoIntent(input);

  switch (intent.operation) {
    case 'none':
    case 'edit_and_verify':
    case 'plan_only':
    case 'provider_steering':
      return null;

    case 'status': {
      const status = await deps.repoOps.status(deps.cwd);
      if (!status.isGitRepo) return handled('status', 'This folder is not a git repo.');
      if (status.clean) return handled('status', 'Repo status: clean.');
      return handled(
        'status',
        `Repo status: ${status.changedFiles.length} changed file(s): ${formatPathList(status.changedFiles)}.`,
      );
    }

    case 'summarize_diff': {
      const diff = await deps.repoOps.diff(deps.cwd);
      if (!diff.isGitRepo) return handled('summarize_diff', 'This folder is not a git repo.');
      if (diff.empty) return handled('summarize_diff', 'No git diff detected.');
      const parts = ['Git diff detected.'];
      if (diff.stat.trim().length > 0) parts.push(`Stat:\n${diff.stat.trim()}`);
      if (diff.patchPreview.trim().length > 0) parts.push(`Preview:\n${diff.patchPreview.trim()}`);
      return handled('summarize_diff', parts.join('\n\n'));
    }

    case 'verify_only': {
      const command = await deps.repoOps.detectTestCommand(deps.cwd);
      if (command === null) {
        return handled('verify_only', 'No test command was detected for this repo yet. I have not run anything.');
      }
      return handled('verify_only', `Detected test command: ${formatCommand(command)}. I have not run it yet.`);
    }

    case 'commit_current_ai_change':
      return handled(
        'commit_current_ai_change',
        'Commit intent detected. I will summarize changes and commit if the workspace looks safe.',
      );

    case 'undo_last_ai_change': {
      const checkpoint = await deps.checkpointStore.latest();
      if (checkpoint === null) {
        return handled('undo_last_ai_change', "I can't safely undo yet: no AI checkpoint exists for this repo.");
      }
      if (deps.readFileText === undefined) {
        return handled(
          'undo_last_ai_change',
          `AI checkpoint ${checkpoint.id} exists, but current-file inspection is not wired, so I will not preview or apply undo.`,
        );
      }

      const paths = checkpoint.files.map((file) => file.path);
      const current = await currentTextMap(paths, deps.readFileText);
      const plan = planUndoAiCheckpoint(checkpoint, current);
      if (!plan.ok) {
        const conflicts = plan.conflicts.map((conflict) => `${conflict.path} (${conflict.reason})`);
        return handled(
          'undo_last_ai_change',
          `I can't safely undo checkpoint ${checkpoint.id}: ${formatPathList(conflicts)} changed after the AI edit.`,
        );
      }

      const writes = plan.actions.filter((action) => action.type === 'write').length;
      const deletes = plan.actions.filter((action) => action.type === 'delete').length;
      return handled(
        'undo_last_ai_change',
        `Undo is available for checkpoint ${checkpoint.id}: would write ${writes} file(s) and delete ${deletes} file(s). I have not applied it yet.`,
      );
    }

    default: {
      const exhaustive: never = intent.operation;
      return exhaustive;
    }
  }
}
