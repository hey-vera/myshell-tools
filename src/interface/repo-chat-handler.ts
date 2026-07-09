/**
 * Safe natural-language repo chat handler.
 *
 * This is the interface seam between ordinary user language ("what changed?",
 * "run tests", "undo that") and repo infrastructure. verify_only and commit
 * now execute under commandGate + oversight (same seams as menu/cli verify
 * paths). Undo remains preview-only.
 */

import { planUndoAiCheckpoint } from '../core/ai-checkpoint.js';
import { inferRepoIntent, type RepoOperationIntent } from '../core/repo-intent.js';
import type { AiCheckpointStore } from '../infra/ai-checkpoint-store.js';
import type { LocalRepoOps } from '../infra/repo-ops.js';
import type { CommandGatePort } from '../core/command-gate.js';
import type { VerifyPort } from '../core/verify.js';
import type { Oversight } from './ui/oversight.js';

export interface RepoChatHandled {
  readonly handled: true;
  readonly operation: RepoOperationIntent;
  readonly mutatesWorkspace: boolean;
  readonly message: string;
}

export interface RepoChatHandlerDeps {
  readonly cwd: string;
  readonly repoOps: Pick<LocalRepoOps, 'status' | 'diff' | 'detectTestCommand' | 'commitChanges'>;
  readonly checkpointStore: Pick<AiCheckpointStore, 'latest'>;
  readonly readFileText?: (path: string) => Promise<string | null>;
  /** Gated verify port (use ctx.verifyPort from menu which wraps commandGate). */
  readonly verifyPort?: Pick<VerifyPort, 'runTests' | 'detectTestCommand'>;
  readonly commandGate?: CommandGatePort;
  readonly oversight?: Oversight;
}

function handled(operation: RepoOperationIntent, message: string): RepoChatHandled {
  return {
    handled: true,
    operation,
    mutatesWorkspace: operation === 'commit_current_ai_change',
    message,
  };
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
      const detect = deps.verifyPort?.detectTestCommand ?? deps.repoOps.detectTestCommand;
      const command = await detect(deps.cwd);
      if (command === null) {
        return handled('verify_only', 'No test command was detected for this repo yet. I have not run anything.');
      }
      const runner = deps.verifyPort?.runTests;
      if (!runner || !deps.commandGate) {
        return handled('verify_only', `Detected test command: ${formatCommand(command)}. I have not run it yet.`);
      }
      // Use same timeout cap as CLI verify wiring; gate+oversight honored inside runTests when provided.
      const TIMEOUT_MS = 120_000;
      const result = await runner(deps.cwd, command, TIMEOUT_MS, deps.commandGate);
      let outcomeLine = `Test run ${result.outcome.toUpperCase()} for ${formatCommand(command)} in ${result.durationMs}ms.`;
      if (result.output && result.output.trim()) {
        const clip = result.output.trim().slice(0, 400);
        outcomeLine += `\nOutput:\n${clip}${result.output.length > 400 ? '…' : ''}`;
      }
      return handled('verify_only', outcomeLine);
    }

    case 'commit_current_ai_change': {
      const status = await deps.repoOps.status(deps.cwd);
      const diff = await deps.repoOps.diff(deps.cwd);
      if (!status.isGitRepo) {
        return handled('commit_current_ai_change', 'This folder is not a git repo.');
      }
      if (diff.empty && status.clean) {
        return handled('commit_current_ai_change', 'No changes to commit.');
      }
      const summaryParts = ['Commit intent:'];
      if (diff.stat.trim().length > 0) summaryParts.push(`Stat:\n${diff.stat.trim()}`);
      if (status.changedFiles.length > 0) summaryParts.push(`Files: ${formatPathList(status.changedFiles)}`);
      const summary = summaryParts.join('\n\n');

      const oversight: Oversight = deps.oversight ?? 'checkpoint';
      let proceed = true;
      if (oversight !== 'autonomous') {
        const confirmMsg = `${summary}\n\nProceed with commit?`;
        if (deps.commandGate?.confirm) {
          proceed = await deps.commandGate.confirm(confirmMsg);
        } else {
          proceed = false;
        }
      }
      if (!proceed) {
        return handled('commit_current_ai_change', 'Commit declined by gate.');
      }

      // Reviewable commit message (caller + user see it in receipt).
      const fileCount = status.changedFiles.length;
      const reviewMsg =
        fileCount > 0
          ? `chat: commit ${fileCount} file(s) via natural language [${status.changedFiles.slice(0, 3).join(', ')}${fileCount > 3 ? ', ...' : ''}]`
          : 'chat: commit current changes';
      const commitRes = await deps.repoOps.commitChanges(deps.cwd, reviewMsg);
      const receipt = commitRes.ok
        ? `Commit succeeded: ${commitRes.output}`
        : `Commit failed: ${commitRes.output}`;
      return handled('commit_current_ai_change', `${summary}\n\n${receipt}`);
    }

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
