/**
 * Safe natural-language repo chat handler.
 *
 * This is the interface seam between ordinary user language ("what changed?",
 * "run tests", "undo that", "pr status") and repo infrastructure. verify_only
 * and commit execute under commandGate + oversight (same seams as menu/cli
 * verify paths). GitHub PR status (P1.6 thin) runs `gh pr status` when the
 * workspace is GitHub and gh is on PATH — honest fail-soft otherwise.
 * Undo remains preview-only.
 */

import { planUndoAiCheckpoint } from '../core/ai-checkpoint.js';
import type { CommandGatePort, CommandGateDecision } from '../core/command-gate.js';
import { inferRepoIntent, type RepoOperationIntent } from '../core/repo-intent.js';
import type { VerifyPort } from '../core/verify.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { AiCheckpointStore } from '../infra/ai-checkpoint-store.js';
import { runGh as defaultRunGh, type GhRunResult } from '../infra/gh-run.js';
import type { LocalRepoOps } from '../infra/repo-ops.js';
import { detectWorkspaceContext } from '../infra/workspace-context.js';
import type { Oversight } from './ui/oversight.js';

/** Clip gh stdout so the chat surface stays readable. */
const GH_PR_STATUS_OUTPUT_CAP = 4_000;

export interface RepoChatHandled {
  readonly handled: true;
  readonly operation: RepoOperationIntent;
  readonly mutatesWorkspace: boolean;
  readonly message: string;
}

/** Re-export for callers/tests that type against the injectable runner. */
export type { GhRunResult };

export interface RepoChatHandlerDeps {
  readonly cwd: string;
  readonly repoOps: Pick<LocalRepoOps, 'status' | 'diff' | 'detectTestCommand' | 'commitChanges'>;
  readonly checkpointStore: Pick<AiCheckpointStore, 'latest'>;
  readonly readFileText?: (path: string) => Promise<string | null>;
  /** Gated verify port (use ctx.verifyPort from menu which wraps commandGate). */
  readonly verifyPort?: Pick<VerifyPort, 'runTests' | 'detectTestCommand'>;
  readonly commandGate?: CommandGatePort;
  readonly oversight?: Oversight;
  /**
   * Optional pre-resolved forge context (tests inject). When omitted, production
   * uses {@link detectWorkspaceContext} (or `detectForge` when provided).
   */
  readonly forgeContext?: WorkspaceContext;
  /** Injectable forge detector (defaults to detectWorkspaceContext). */
  readonly detectForge?: (cwd: string) => Promise<WorkspaceContext>;
  /**
   * Injectable `gh` runner. Production uses {@link defaultRunGh} from infra;
   * tests inject stubs so unit suites never touch the network or PATH.
   */
  readonly runGh?: (args: readonly string[], cwd: string) => Promise<GhRunResult>;
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

/**
 * Honest message when forge/tools cannot support GitHub PR status. PURE-ish
 * (no I/O). Returns null when host is GitHub and gh is on PATH (caller may run).
 */
export function githubPrStatusUnavailableMessage(forge: WorkspaceContext): string | null {
  if (forge.hostClass === 'github' && forge.tools.gh) return null;

  if (forge.hostClass === 'gitlab') {
    return forge.tools.glab
      ? 'This workspace is GitLab — not GitHub. PR status via gh does not apply. Try `glab mr list` (or ask for MR status) instead.'
      : 'This workspace is GitLab — not GitHub. gh PR status does not apply, and glab is not on PATH. Use local git or the GitLab UI.';
  }
  if (forge.hostClass === 'other') {
    return 'This remote is not GitHub — I will not run gh PR status against a non-GitHub forge.';
  }
  if (forge.hostClass === 'none') {
    return forge.gitRoot !== null
      ? 'Local-only workspace (no remote forge) — there is no GitHub PR status to query.'
      : 'This folder is not a git repo — there is no GitHub PR status to query.';
  }
  // github but gh missing
  return 'This is a GitHub repo, but `gh` is not on PATH. Install the GitHub CLI (https://cli.github.com) or check PR status in the browser. I will not pretend gh is available.';
}

function clipGhOutput(text: string): string {
  const t = text.trim();
  if (t.length === 0) return '';
  if (t.length <= GH_PR_STATUS_OUTPUT_CAP) return t;
  return `${t.slice(0, GH_PR_STATUS_OUTPUT_CAP)}\n… (truncated)`;
}

async function confirmGate(
  commandGate: CommandGatePort,
  gate: CommandGateDecision,
): Promise<boolean | null> {
  if (!gate.requireConfirmation) return null;
  if (commandGate.confirm === undefined) return false;
  return commandGate.confirm('Run `gh pr status` to show GitHub PR status?');
}

async function recordGate(
  commandGate: CommandGatePort,
  cwd: string,
  command: string,
  gate: CommandGateDecision,
  confirmed: boolean | null,
  outcome: 'ran' | 'skipped' | 'denied',
): Promise<void> {
  if (!gate.mustRecord || commandGate.record === undefined) return;
  await commandGate.record({
    ts: new Date().toISOString(),
    command,
    commandTier: gate.commandTier,
    requireConfirmation: gate.requireConfirmation,
    forbidBackground: gate.forbidBackground,
    confirmed,
    outcome,
    cwd,
  });
}

/**
 * Resolve forge + (when eligible) run gated `gh pr status`. Fail-soft honest
 * messages for non-GitHub / missing gh / gate deny / gh failure.
 */
async function handleGithubPrStatus(deps: RepoChatHandlerDeps): Promise<RepoChatHandled> {
  const detect = deps.detectForge ?? detectWorkspaceContext;
  const forge =
    deps.forgeContext ??
    (await detect(deps.cwd).catch(() => null));

  if (forge === null) {
    return handled(
      'github_pr_status',
      'Could not detect workspace forge context just now — try again, or run `gh pr status` in the shell.',
    );
  }

  const unavailable = githubPrStatusUnavailableMessage(forge);
  if (unavailable !== null) {
    return handled('github_pr_status', unavailable);
  }

  const display = 'gh pr status';
  const runGh = deps.runGh ?? defaultRunGh;

  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(display);
    const confirmed = await confirmGate(deps.commandGate, gate);
    if (!gate.allowed || confirmed === false) {
      await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'denied');
      return handled(
        'github_pr_status',
        gate.allowed
          ? 'PR status check declined by gate.'
          : 'Command gate denied `gh pr status`.',
      );
    }

    const result = await runGh(['pr', 'status'], deps.cwd);
    await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'ran');
    return formatGhPrStatusResult(result);
  }

  // No gate wired (thin paths / tests) — still run honestly.
  const result = await runGh(['pr', 'status'], deps.cwd);
  return formatGhPrStatusResult(result);
}

function formatGhPrStatusResult(result: GhRunResult): RepoChatHandled {
  const out = clipGhOutput(result.stdout);
  const err = clipGhOutput(result.stderr);

  if (result.ok) {
    if (out.length > 0) {
      return handled('github_pr_status', `GitHub PR status (via gh):\n\n${out}`);
    }
    // Empty success — still honest; point at list as a next step without auto-running it.
    return handled(
      'github_pr_status',
      'gh pr status returned no output. Try `gh pr list --limit 5` in the shell, or open the repo on GitHub.',
    );
  }

  const detail = err.length > 0 ? err : out.length > 0 ? out : 'unknown error';
  const code =
    result.exitCode !== null ? ` (exit ${result.exitCode})` : '';
  return handled(
    'github_pr_status',
    `gh pr status failed${code}:\n${detail}`,
  );
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

    case 'github_pr_status':
      return handleGithubPrStatus(deps);

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
