/**
 * Safe natural-language repo chat handler.
 *
 * This is the interface seam between ordinary user language ("what changed?",
 * "run tests", "undo that", "pr status", "pr checks", "create a pr", "mr status",
 * "pipeline status") and repo infrastructure. verify_only and commit execute under
 * commandGate + oversight (same seams as menu/cli verify paths). GitHub PR status
 * (P1.6 thin) runs `gh pr status` when the workspace is GitHub and gh is on PATH.
 * GitHub PR checks (P1.6 thin extension) runs read-only `gh pr checks` for CI/check
 * status (no --watch); on GitLab+glab it runs `glab ci status` instead. GitHub PR
 * create (P1.6 thin extension) runs non-interactive `gh pr create --fill` under the
 * same gate/oversight posture as commit — never force-push, never invent base.
 * GitLab MR list (P1.7 thin) runs `glab mr list` when the workspace is GitLab and
 * glab is on PATH. GitLab MR create (P1.7 thin extension) runs non-interactive
 * `glab mr create --fill --yes` under the same gate/oversight posture as PR create.
 * GitLab CI/pipeline status (P1.7 thin extension) runs read-only `glab ci status`
 * (no watch loops) — honest fail-soft otherwise. Undo plans via checkpoint conflict
 * gate, then applies under oversight + commandGate when safe.
 */

import { planUndoAiCheckpoint } from '../core/ai-checkpoint.js';
import type { CommandGatePort, CommandGateDecision } from '../core/command-gate.js';
import { inferRepoIntent, type RepoOperationIntent } from '../core/repo-intent.js';
import type { VerifyPort } from '../core/verify.js';
import type { WorkspaceContext } from '../core/workspace-context.js';
import type { AiCheckpointStore } from '../infra/ai-checkpoint-store.js';
import { runGh as defaultRunGh, type GhRunResult } from '../infra/gh-run.js';
import { runGlab as defaultRunGlab, type GlabRunResult } from '../infra/glab-run.js';
import type { LocalRepoOps } from '../infra/repo-ops.js';
import { detectWorkspaceContext } from '../infra/workspace-context.js';
import type { Oversight } from './ui/oversight.js';

/** Clip CLI stdout so the chat surface stays readable. */
const FORGE_STATUS_OUTPUT_CAP = 4_000;

export interface RepoChatHandled {
  readonly handled: true;
  readonly operation: RepoOperationIntent;
  readonly mutatesWorkspace: boolean;
  readonly message: string;
}

/** Re-export for callers/tests that type against the injectable runner. */
export type { GhRunResult, GlabRunResult };

export interface RepoChatHandlerDeps {
  readonly cwd: string;
  readonly repoOps: Pick<LocalRepoOps, 'status' | 'diff' | 'detectTestCommand' | 'commitChanges'> &
    Partial<Pick<LocalRepoOps, 'applyUndoActions'>>;
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
  /**
   * Injectable `glab` runner. Production uses {@link defaultRunGlab} from infra;
   * tests inject stubs so unit suites never touch the network or PATH.
   */
  readonly runGlab?: (args: readonly string[], cwd: string) => Promise<GlabRunResult>;
}

function handled(
  operation: RepoOperationIntent,
  message: string,
  opts?: { readonly mutatesWorkspace?: boolean },
): RepoChatHandled {
  return {
    handled: true,
    operation,
    mutatesWorkspace:
      opts?.mutatesWorkspace ??
      (operation === 'commit_current_ai_change' ||
        operation === 'undo_last_ai_change' ||
        operation === 'github_pr_create' ||
        operation === 'gitlab_mr_create'),
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
 * (no I/O). Returns null when host is GitHub and gh is on PATH (caller may run),
 * or when host is GitLab and glab is on PATH (caller may run glab instead).
 */
export function githubPrStatusUnavailableMessage(forge: WorkspaceContext): string | null {
  if (forge.hostClass === 'github' && forge.tools.gh) return null;
  // GitLab + glab: handler runs glab (P1.7 thin) rather than refusing.
  if (forge.hostClass === 'gitlab' && forge.tools.glab) return null;

  if (forge.hostClass === 'gitlab') {
    return 'This workspace is GitLab — not GitHub. gh PR status does not apply, and glab is not on PATH. Use local git or the GitLab UI.';
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

/**
 * Honest message when forge/tools cannot support GitHub PR checks. PURE-ish.
 * Returns null when host is GitHub and gh is on PATH (caller may run gh),
 * or when host is GitLab and glab is on PATH (caller may run glab ci status).
 */
export function githubPrChecksUnavailableMessage(forge: WorkspaceContext): string | null {
  if (forge.hostClass === 'github' && forge.tools.gh) return null;
  // GitLab + glab: handler runs glab ci status (P1.7 thin) rather than refusing.
  if (forge.hostClass === 'gitlab' && forge.tools.glab) return null;

  if (forge.hostClass === 'gitlab') {
    return 'This workspace is GitLab — not GitHub. gh PR checks do not apply, and glab is not on PATH. Use the GitLab UI or install glab (https://gitlab.com/gitlab-org/cli) for `glab ci status` / pipelines.';
  }
  if (forge.hostClass === 'other') {
    return 'This remote is not GitHub — I will not run gh PR checks against a non-GitHub forge.';
  }
  if (forge.hostClass === 'none') {
    return forge.gitRoot !== null
      ? 'Local-only workspace (no remote forge) — there are no GitHub PR checks to query.'
      : 'This folder is not a git repo — there are no GitHub PR checks to query.';
  }
  // github but gh missing
  return 'This is a GitHub repo, but `gh` is not on PATH. Install the GitHub CLI (https://cli.github.com) or check PR checks in the browser. I will not pretend gh is available.';
}

/**
 * Honest message when forge/tools cannot support GitLab CI/pipeline status.
 * Returns null when host is GitLab and glab is on PATH (caller may run),
 * or when host is GitHub and gh is on PATH (caller may run gh pr checks).
 */
export function gitlabCiStatusUnavailableMessage(forge: WorkspaceContext): string | null {
  if (forge.hostClass === 'gitlab' && forge.tools.glab) return null;
  // GitHub + gh: handler runs gh pr checks rather than refusing.
  if (forge.hostClass === 'github' && forge.tools.gh) return null;

  if (forge.hostClass === 'github') {
    return 'This workspace is GitHub — not GitLab. Pipeline status via glab does not apply, and gh is not on PATH. Install the GitHub CLI (https://cli.github.com) or check CI in the browser.';
  }
  if (forge.hostClass === 'other') {
    return 'This remote is not GitLab — I will not run glab CI status against a non-GitLab forge.';
  }
  if (forge.hostClass === 'none') {
    return forge.gitRoot !== null
      ? 'Local-only workspace (no remote forge) — there is no GitLab pipeline status to query.'
      : 'This folder is not a git repo — there is no GitLab pipeline status to query.';
  }
  // gitlab but glab missing
  return 'This is a GitLab repo, but `glab` is not on PATH. Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) or check pipelines in the browser. I will not pretend glab is available.';
}

/**
 * Honest message when forge/tools cannot support GitHub PR create. PURE-ish.
 * Returns null only when host is GitHub and gh is on PATH.
 * GitLab + glab: handler may cross-route to MR create (caller decides).
 */
export function githubPrCreateUnavailableMessage(forge: WorkspaceContext): string | null {
  if (forge.hostClass === 'github' && forge.tools.gh) return null;
  // GitLab + glab: handler runs glab MR create rather than refusing.
  if (forge.hostClass === 'gitlab' && forge.tools.glab) return null;

  if (forge.hostClass === 'gitlab') {
    return 'This workspace is GitLab — not GitHub. PR create via gh does not apply, and glab is not on PATH. Use the GitLab UI or install glab (https://gitlab.com/gitlab-org/cli), then ask to create a merge request.';
  }
  if (forge.hostClass === 'other') {
    return 'This remote is not GitHub — I will not run gh PR create against a non-GitHub forge.';
  }
  if (forge.hostClass === 'none') {
    return forge.gitRoot !== null
      ? 'Local-only workspace (no remote forge) — there is no GitHub host to open a PR against.'
      : 'This folder is not a git repo — there is no PR to create.';
  }
  // github but gh missing
  return 'This is a GitHub repo, but `gh` is not on PATH. Install the GitHub CLI (https://cli.github.com) or open a PR in the browser. I will not pretend gh is available.';
}

/**
 * Honest message when forge/tools cannot support GitLab MR create. PURE-ish.
 * Returns null only when host is GitLab and glab is on PATH.
 * GitHub + gh: handler may cross-route to PR create (caller decides).
 */
export function gitlabMrCreateUnavailableMessage(forge: WorkspaceContext): string | null {
  if (forge.hostClass === 'gitlab' && forge.tools.glab) return null;
  // GitHub + gh: handler runs gh PR create rather than refusing.
  if (forge.hostClass === 'github' && forge.tools.gh) return null;

  if (forge.hostClass === 'github') {
    return 'This workspace is GitHub — not GitLab. MR create via glab does not apply, and gh is not on PATH. Use the GitHub UI or install the GitHub CLI (https://cli.github.com), then ask to create a pull request.';
  }
  if (forge.hostClass === 'other') {
    return 'This remote is not GitLab — I will not run glab MR create against a non-GitLab forge.';
  }
  if (forge.hostClass === 'none') {
    return forge.gitRoot !== null
      ? 'Local-only workspace (no remote forge) — there is no GitLab host to open an MR against.'
      : 'This folder is not a git repo — there is no MR to create.';
  }
  // gitlab but glab missing
  return 'This is a GitLab repo, but `glab` is not on PATH. Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) or open an MR in the browser. I will not pretend glab is available.';
}

/**
 * Honest message when forge/tools cannot support GitLab MR list. Returns null
 * when host is GitLab and glab is on PATH.
 */
export function gitlabMrStatusUnavailableMessage(forge: WorkspaceContext): string | null {
  if (forge.hostClass === 'gitlab' && forge.tools.glab) return null;

  if (forge.hostClass === 'github') {
    return forge.tools.gh
      ? 'This workspace is GitHub — not GitLab. MR status via glab does not apply. Try `gh pr status` (or ask for PR status) instead.'
      : 'This workspace is GitHub — not GitLab. glab MR status does not apply, and gh is not on PATH. Use local git or the GitHub UI.';
  }
  if (forge.hostClass === 'other') {
    return 'This remote is not GitLab — I will not run glab MR status against a non-GitLab forge.';
  }
  if (forge.hostClass === 'none') {
    return forge.gitRoot !== null
      ? 'Local-only workspace (no remote forge) — there is no GitLab MR status to query.'
      : 'This folder is not a git repo — there is no GitLab MR status to query.';
  }
  // gitlab but glab missing
  return 'This is a GitLab repo, but `glab` is not on PATH. Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) or check MRs in the browser. I will not pretend glab is available.';
}

function clipForgeOutput(text: string): string {
  const t = text.trim();
  if (t.length === 0) return '';
  if (t.length <= FORGE_STATUS_OUTPUT_CAP) return t;
  return `${t.slice(0, FORGE_STATUS_OUTPUT_CAP)}\n… (truncated)`;
}

async function confirmGate(
  commandGate: CommandGatePort,
  gate: CommandGateDecision,
  confirmMessage: string,
): Promise<boolean | null> {
  if (!gate.requireConfirmation) return null;
  if (commandGate.confirm === undefined) return false;
  return commandGate.confirm(confirmMessage);
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

async function resolveForge(deps: RepoChatHandlerDeps): Promise<WorkspaceContext | null> {
  const detect = deps.detectForge ?? detectWorkspaceContext;
  return (
    deps.forgeContext ??
    (await detect(deps.cwd).catch(() => null))
  );
}

/**
 * Non-interactive thin create: title/body from commit log via --fill.
 * No force-push; no invented --base. May still push the current branch if gh
 * needs to (normal gh behavior) — that is why create is gated like commit.
 */
const GH_PR_CREATE_ARGS = ['pr', 'create', '--fill'] as const;
const GH_PR_CREATE_DISPLAY = 'gh pr create --fill';
/** Create can push + talk to GitHub; allow more than the status probe budget. */
const GH_PR_CREATE_TIMEOUT_MS = 60_000;

/**
 * Resolve forge + gated non-interactive `gh pr create --fill` when GitHub+gh.
 * On GitLab+glab, cross-routes to thin MR create. Honest degrade otherwise.
 * Never hangs on TTY prompts — if gh cannot fill safely, surfaces the failure
 * + suggested shell command.
 */
async function handleGithubPrCreate(deps: RepoChatHandlerDeps): Promise<RepoChatHandled> {
  const forge = await resolveForge(deps);

  if (forge === null) {
    return handled(
      'github_pr_create',
      'Could not detect workspace forge context just now — try again, or run `gh pr create --fill` in the shell.',
      { mutatesWorkspace: false },
    );
  }

  // PR create language on GitLab → thin glab MR create when available.
  if (forge.hostClass === 'gitlab' && forge.tools.glab) {
    return handleGitlabMrCreate(deps, 'github_pr_create');
  }

  const unavailable = githubPrCreateUnavailableMessage(forge);
  if (unavailable !== null) {
    return handled('github_pr_create', unavailable, { mutatesWorkspace: false });
  }

  const summary =
    'PR create intent: run non-interactive `gh pr create --fill` (title/body from commits; default base; no force-push).';
  const oversight: Oversight = deps.oversight ?? 'checkpoint';
  let proceed = true;
  if (oversight !== 'autonomous') {
    const confirmMsg = `${summary}\n\nProceed with PR create?`;
    if (deps.commandGate?.confirm) {
      proceed = await deps.commandGate.confirm(confirmMsg);
    } else {
      // Non-autonomous without a confirm seam → honest guidance only (safe).
      return handled(
        'github_pr_create',
        `${summary}\n\nI have not created a PR yet. Confirm in chat, or run:\n  ${GH_PR_CREATE_DISPLAY}\n(Requires branch pushed / commits vs base. Use \`gh pr create --title "…" --body "…"\` if --fill is not enough.)`,
        { mutatesWorkspace: false },
      );
    }
  }
  if (!proceed) {
    return handled('github_pr_create', 'PR create declined by gate.', { mutatesWorkspace: false });
  }

  const runGh =
    deps.runGh ??
    ((args: readonly string[], cwd: string) => defaultRunGh(args, cwd, GH_PR_CREATE_TIMEOUT_MS));

  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(GH_PR_CREATE_DISPLAY);
    const confirmed = await confirmGate(
      deps.commandGate,
      gate,
      'Run `gh pr create --fill` to open a GitHub pull request?',
    );
    if (!gate.allowed || confirmed === false) {
      await recordGate(deps.commandGate, deps.cwd, GH_PR_CREATE_DISPLAY, gate, confirmed, 'denied');
      return handled(
        'github_pr_create',
        gate.allowed
          ? 'PR create declined by gate.'
          : 'Command gate denied `gh pr create --fill`.',
        { mutatesWorkspace: false },
      );
    }

    const result = await runGh([...GH_PR_CREATE_ARGS], deps.cwd);
    await recordGate(deps.commandGate, deps.cwd, GH_PR_CREATE_DISPLAY, gate, confirmed, 'ran');
    return formatGhPrCreateResult(result);
  }

  const result = await runGh([...GH_PR_CREATE_ARGS], deps.cwd);
  return formatGhPrCreateResult(result);
}

function formatGhPrCreateResult(result: GhRunResult): RepoChatHandled {
  const out = clipForgeOutput(result.stdout);
  const err = clipForgeOutput(result.stderr);

  if (result.ok) {
    if (out.length > 0) {
      return handled(
        'github_pr_create',
        `GitHub PR created (via gh pr create --fill):\n\n${out}`,
        { mutatesWorkspace: true },
      );
    }
    return handled(
      'github_pr_create',
      'gh pr create --fill returned no output. Check `gh pr status` or the GitHub UI to confirm whether a PR was opened.',
      { mutatesWorkspace: true },
    );
  }

  const detail = err.length > 0 ? err : out.length > 0 ? out : 'unknown error';
  const code = result.exitCode !== null ? ` (exit ${result.exitCode})` : '';
  return handled(
    'github_pr_create',
    `gh pr create --fill failed${code}:\n${detail}\n\nI will not hang on interactive prompts. If title/body or push is needed, run in a real shell:\n  ${GH_PR_CREATE_DISPLAY}\nor:\n  gh pr create --title "…" --body "…"`,
    { mutatesWorkspace: false },
  );
}

/**
 * Non-interactive thin create: title/description from commit log via --fill;
 * --yes skips the glab submission confirmation. Never force-push; no invented
 * --target-branch. --fill may push the current branch (normal glab behavior) —
 * that is why create is gated like commit / gh pr create.
 */
const GLAB_MR_CREATE_ARGS = ['mr', 'create', '--fill', '--yes'] as const;
const GLAB_MR_CREATE_DISPLAY = 'glab mr create --fill --yes';
/** Create can push + talk to GitLab; allow more than the status probe budget. */
const GLAB_MR_CREATE_TIMEOUT_MS = 60_000;

/**
 * Resolve forge + gated non-interactive `glab mr create --fill --yes` when
 * GitLab+glab. On GitHub+gh, cross-routes to thin PR create. Honest degrade
 * otherwise. Never hangs on TTY prompts.
 *
 * `operation` lets "create a pr" on GitLab still report as github_pr_create
 * intent while using the glab runner (and vice versa for MR language on GitHub).
 */
async function handleGitlabMrCreate(
  deps: RepoChatHandlerDeps,
  operation: 'gitlab_mr_create' | 'github_pr_create' = 'gitlab_mr_create',
): Promise<RepoChatHandled> {
  const forge = await resolveForge(deps);

  if (forge === null) {
    return handled(
      operation,
      'Could not detect workspace forge context just now — try again, or run `glab mr create --fill --yes` in the shell.',
      { mutatesWorkspace: false },
    );
  }

  // MR create language on GitHub → thin gh PR create when available.
  if (operation === 'gitlab_mr_create' && forge.hostClass === 'github' && forge.tools.gh) {
    return handleGithubPrCreate({ ...deps, forgeContext: forge });
  }

  const unavailable = gitlabMrCreateUnavailableMessage(forge);
  if (unavailable !== null) {
    return handled(operation, unavailable, { mutatesWorkspace: false });
  }

  const summary =
    'MR create intent: run non-interactive `glab mr create --fill --yes` (title/description from commits; default target; no force-push).';
  const oversight: Oversight = deps.oversight ?? 'checkpoint';
  let proceed = true;
  if (oversight !== 'autonomous') {
    const confirmMsg = `${summary}\n\nProceed with MR create?`;
    if (deps.commandGate?.confirm) {
      proceed = await deps.commandGate.confirm(confirmMsg);
    } else {
      // Non-autonomous without a confirm seam → honest guidance only (safe).
      return handled(
        operation,
        `${summary}\n\nI have not created an MR yet. Confirm in chat, or run:\n  ${GLAB_MR_CREATE_DISPLAY}\n(Requires branch pushed / commits vs target. Use \`glab mr create --title "…" --description "…" --yes\` if --fill is not enough.)`,
        { mutatesWorkspace: false },
      );
    }
  }
  if (!proceed) {
    return handled(operation, 'MR create declined by gate.', { mutatesWorkspace: false });
  }

  const runGlab =
    deps.runGlab ??
    ((args: readonly string[], cwd: string) =>
      defaultRunGlab(args, cwd, GLAB_MR_CREATE_TIMEOUT_MS));

  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(GLAB_MR_CREATE_DISPLAY);
    const confirmed = await confirmGate(
      deps.commandGate,
      gate,
      'Run `glab mr create --fill --yes` to open a GitLab merge request?',
    );
    if (!gate.allowed || confirmed === false) {
      await recordGate(deps.commandGate, deps.cwd, GLAB_MR_CREATE_DISPLAY, gate, confirmed, 'denied');
      return handled(
        operation,
        gate.allowed
          ? 'MR create declined by gate.'
          : 'Command gate denied `glab mr create --fill --yes`.',
        { mutatesWorkspace: false },
      );
    }

    const result = await runGlab([...GLAB_MR_CREATE_ARGS], deps.cwd);
    await recordGate(deps.commandGate, deps.cwd, GLAB_MR_CREATE_DISPLAY, gate, confirmed, 'ran');
    return formatGlabMrCreateResult(result, operation);
  }

  const result = await runGlab([...GLAB_MR_CREATE_ARGS], deps.cwd);
  return formatGlabMrCreateResult(result, operation);
}

function formatGlabMrCreateResult(
  result: GlabRunResult,
  operation: 'gitlab_mr_create' | 'github_pr_create',
): RepoChatHandled {
  const out = clipForgeOutput(result.stdout);
  const err = clipForgeOutput(result.stderr);

  if (result.ok) {
    if (out.length > 0) {
      return handled(
        operation,
        `GitLab MR created (via glab mr create --fill --yes):\n\n${out}`,
        { mutatesWorkspace: true },
      );
    }
    return handled(
      operation,
      'glab mr create --fill --yes returned no output. Check `glab mr list` or the GitLab UI to confirm whether an MR was opened.',
      { mutatesWorkspace: true },
    );
  }

  const detail = err.length > 0 ? err : out.length > 0 ? out : 'unknown error';
  const code = result.exitCode !== null ? ` (exit ${result.exitCode})` : '';
  return handled(
    operation,
    `glab mr create --fill --yes failed${code}:\n${detail}\n\nI will not hang on interactive prompts. If title/description or push is needed, run in a real shell:\n  ${GLAB_MR_CREATE_DISPLAY}\nor:\n  glab mr create --title "…" --description "…" --yes`,
    { mutatesWorkspace: false },
  );
}

/**
 * Resolve forge + gated read-only `gh pr checks` when GitHub+gh.
 * No --watch (non-interactive one-shot). On GitLab+glab, cross-route to
 * `glab ci status` (same user need: CI green?). Other/missing tools → honest degrade.
 *
 * Note: `gh pr checks` exits non-zero when checks failed (1) or pending (8)
 * while still printing a useful table on stdout — surface that table honestly.
 */
async function handleGithubPrChecks(deps: RepoChatHandlerDeps): Promise<RepoChatHandled> {
  const forge = await resolveForge(deps);

  if (forge === null) {
    return handled(
      'github_pr_checks',
      'Could not detect workspace forge context just now — try again, or run `gh pr checks` in the shell.',
      { mutatesWorkspace: false },
    );
  }

  // CI language on GitLab → thin glab path when available (same user need).
  if (forge.hostClass === 'gitlab' && forge.tools.glab) {
    return handleGitlabCiStatus(deps, 'github_pr_checks');
  }

  const unavailable = githubPrChecksUnavailableMessage(forge);
  if (unavailable !== null) {
    return handled('github_pr_checks', unavailable, { mutatesWorkspace: false });
  }

  const display = 'gh pr checks';
  const runGh = deps.runGh ?? defaultRunGh;

  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(display);
    const confirmed = await confirmGate(
      deps.commandGate,
      gate,
      'Run `gh pr checks` to show GitHub PR check / CI status?',
    );
    if (!gate.allowed || confirmed === false) {
      await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'denied');
      return handled(
        'github_pr_checks',
        gate.allowed
          ? 'PR checks query declined by gate.'
          : 'Command gate denied `gh pr checks`.',
        { mutatesWorkspace: false },
      );
    }

    const result = await runGh(['pr', 'checks'], deps.cwd);
    await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'ran');
    return formatGhPrChecksResult(result);
  }

  const result = await runGh(['pr', 'checks'], deps.cwd);
  return formatGhPrChecksResult(result);
}

/**
 * Resolve forge + gated read-only `glab ci status` when GitLab+glab.
 * No watch loops (one-shot). On GitHub+gh, cross-route to gh pr checks.
 * `operation` preserves intent when "ci status" / "pr checks" arrived via
 * github_pr_checks but ran glab on a GitLab host.
 */
async function handleGitlabCiStatus(
  deps: RepoChatHandlerDeps,
  operation: 'gitlab_ci_status' | 'github_pr_checks' = 'gitlab_ci_status',
): Promise<RepoChatHandled> {
  const forge = await resolveForge(deps);

  if (forge === null) {
    return handled(
      operation,
      'Could not detect workspace forge context just now — try again, or run `glab ci status` in the shell.',
      { mutatesWorkspace: false },
    );
  }

  // Pipeline language on GitHub → thin gh path when available.
  if (operation === 'gitlab_ci_status' && forge.hostClass === 'github' && forge.tools.gh) {
    return handleGithubPrChecks({ ...deps, forgeContext: forge });
  }

  const unavailable = gitlabCiStatusUnavailableMessage(forge);
  if (unavailable !== null) {
    return handled(operation, unavailable, { mutatesWorkspace: false });
  }

  const display = 'glab ci status';
  const runGlab = deps.runGlab ?? defaultRunGlab;

  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(display);
    const confirmed = await confirmGate(
      deps.commandGate,
      gate,
      'Run `glab ci status` to show GitLab pipeline / CI status?',
    );
    if (!gate.allowed || confirmed === false) {
      await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'denied');
      return handled(
        operation,
        gate.allowed
          ? 'Pipeline status query declined by gate.'
          : 'Command gate denied `glab ci status`.',
        { mutatesWorkspace: false },
      );
    }

    const result = await runGlab(['ci', 'status'], deps.cwd);
    await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'ran');
    return formatGlabCiStatusResult(result, operation);
  }

  const result = await runGlab(['ci', 'status'], deps.cwd);
  return formatGlabCiStatusResult(result, operation);
}

function formatGlabCiStatusResult(
  result: GlabRunResult,
  operation: 'gitlab_ci_status' | 'github_pr_checks',
): RepoChatHandled {
  const out = clipForgeOutput(result.stdout);
  const err = clipForgeOutput(result.stderr);
  const code = result.exitCode;

  // Prefer stdout even on non-zero exit (pipeline failed / pending still has useful text).
  if (out.length > 0) {
    let headline = 'GitLab CI status (via glab):';
    if (code !== null && code !== 0) {
      headline = 'GitLab CI status (via glab; not all green):';
    }
    return handled(operation, `${headline}\n\n${out}`, {
      mutatesWorkspace: false,
    });
  }

  if (result.ok) {
    return handled(
      operation,
      'glab ci status returned no output. There may be no pipeline for this branch, or CI is not configured. Try `glab pipeline list` in the shell, or open pipelines in the GitLab UI.',
      { mutatesWorkspace: false },
    );
  }

  const detail = err.length > 0 ? err : 'unknown error';
  const codeLabel = code !== null ? ` (exit ${code})` : '';
  return handled(
    operation,
    `glab ci status failed${codeLabel}:\n${detail}`,
    { mutatesWorkspace: false },
  );
}

function formatGhPrChecksResult(result: GhRunResult): RepoChatHandled {
  const out = clipForgeOutput(result.stdout);
  const err = clipForgeOutput(result.stderr);
  const code = result.exitCode;

  // gh pr checks: 0 = all green, 1 = some failed, 8 = pending — still print table.
  if (out.length > 0) {
    let headline = 'GitHub PR checks (via gh):';
    if (code === 8) {
      headline = 'GitHub PR checks (via gh; some pending):';
    } else if (code !== null && code !== 0) {
      headline = 'GitHub PR checks (via gh; not all green):';
    }
    return handled('github_pr_checks', `${headline}\n\n${out}`, {
      mutatesWorkspace: false,
    });
  }

  if (result.ok) {
    return handled(
      'github_pr_checks',
      'gh pr checks returned no output. There may be no open PR for this branch, or no checks configured. Try `gh pr status` or open the PR on GitHub.',
      { mutatesWorkspace: false },
    );
  }

  const detail = err.length > 0 ? err : 'unknown error';
  const codeLabel = code !== null ? ` (exit ${code})` : '';
  return handled(
    'github_pr_checks',
    `gh pr checks failed${codeLabel}:\n${detail}`,
    { mutatesWorkspace: false },
  );
}

/**
 * Resolve forge + (when eligible) run gated `gh pr status`, or on GitLab+glab
 * run `glab mr list` (honest PR/MR language). Fail-soft for other forges.
 */
async function handleGithubPrStatus(deps: RepoChatHandlerDeps): Promise<RepoChatHandled> {
  const forge = await resolveForge(deps);

  if (forge === null) {
    return handled(
      'github_pr_status',
      'Could not detect workspace forge context just now — try again, or run `gh pr status` in the shell.',
      { mutatesWorkspace: false },
    );
  }

  // PR language on GitLab → thin glab path when available (same user need).
  if (forge.hostClass === 'gitlab' && forge.tools.glab) {
    return handleGitlabMrStatus(deps, 'github_pr_status');
  }

  const unavailable = githubPrStatusUnavailableMessage(forge);
  if (unavailable !== null) {
    return handled('github_pr_status', unavailable, { mutatesWorkspace: false });
  }

  const display = 'gh pr status';
  const runGh = deps.runGh ?? defaultRunGh;

  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(display);
    const confirmed = await confirmGate(
      deps.commandGate,
      gate,
      'Run `gh pr status` to show GitHub PR status?',
    );
    if (!gate.allowed || confirmed === false) {
      await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'denied');
      return handled(
        'github_pr_status',
        gate.allowed
          ? 'PR status check declined by gate.'
          : 'Command gate denied `gh pr status`.',
        { mutatesWorkspace: false },
      );
    }

    const result = await runGh(['pr', 'status'], deps.cwd);
    await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'ran');
    return formatGhPrStatusResult(result);
  }

  const result = await runGh(['pr', 'status'], deps.cwd);
  return formatGhPrStatusResult(result);
}

/**
 * Resolve forge + run gated `glab mr list` when GitLab + glab. Fail-soft otherwise.
 * `operation` lets "pr status" on GitLab still report as github_pr_status intent
 * while using the glab runner.
 */
async function handleGitlabMrStatus(
  deps: RepoChatHandlerDeps,
  operation: 'gitlab_mr_status' | 'github_pr_status' = 'gitlab_mr_status',
): Promise<RepoChatHandled> {
  const forge = await resolveForge(deps);

  if (forge === null) {
    return handled(
      operation,
      'Could not detect workspace forge context just now — try again, or run `glab mr list` in the shell.',
      { mutatesWorkspace: false },
    );
  }

  // MR language on GitHub → thin gh path when available.
  if (operation === 'gitlab_mr_status' && forge.hostClass === 'github' && forge.tools.gh) {
    return handleGithubPrStatus({ ...deps, forgeContext: forge });
  }

  const unavailable = gitlabMrStatusUnavailableMessage(forge);
  if (unavailable !== null) {
    return handled(operation, unavailable, { mutatesWorkspace: false });
  }

  const display = 'glab mr list';
  const runGlab = deps.runGlab ?? defaultRunGlab;

  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(display);
    const confirmed = await confirmGate(
      deps.commandGate,
      gate,
      'Run `glab mr list` to show GitLab merge requests?',
    );
    if (!gate.allowed || confirmed === false) {
      await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'denied');
      return handled(
        operation,
        gate.allowed
          ? 'MR list check declined by gate.'
          : 'Command gate denied `glab mr list`.',
        { mutatesWorkspace: false },
      );
    }

    const result = await runGlab(['mr', 'list'], deps.cwd);
    await recordGate(deps.commandGate, deps.cwd, display, gate, confirmed, 'ran');
    return formatGlabMrListResult(result, operation);
  }

  const result = await runGlab(['mr', 'list'], deps.cwd);
  return formatGlabMrListResult(result, operation);
}

function formatGhPrStatusResult(result: GhRunResult): RepoChatHandled {
  const out = clipForgeOutput(result.stdout);
  const err = clipForgeOutput(result.stderr);

  if (result.ok) {
    if (out.length > 0) {
      return handled('github_pr_status', `GitHub PR status (via gh):\n\n${out}`, {
        mutatesWorkspace: false,
      });
    }
    return handled(
      'github_pr_status',
      'gh pr status returned no output. Try `gh pr list --limit 5` in the shell, or open the repo on GitHub.',
      { mutatesWorkspace: false },
    );
  }

  const detail = err.length > 0 ? err : out.length > 0 ? out : 'unknown error';
  const code = result.exitCode !== null ? ` (exit ${result.exitCode})` : '';
  return handled(
    'github_pr_status',
    `gh pr status failed${code}:\n${detail}`,
    { mutatesWorkspace: false },
  );
}

function formatGlabMrListResult(
  result: GlabRunResult,
  operation: 'gitlab_mr_status' | 'github_pr_status',
): RepoChatHandled {
  const out = clipForgeOutput(result.stdout);
  const err = clipForgeOutput(result.stderr);

  if (result.ok) {
    if (out.length > 0) {
      return handled(operation, `GitLab MR list (via glab):\n\n${out}`, {
        mutatesWorkspace: false,
      });
    }
    return handled(
      operation,
      'glab mr list returned no output. Try `glab mr list --all` in the shell, or open the project on GitLab.',
      { mutatesWorkspace: false },
    );
  }

  const detail = err.length > 0 ? err : out.length > 0 ? out : 'unknown error';
  const code = result.exitCode !== null ? ` (exit ${result.exitCode})` : '';
  return handled(
    operation,
    `glab mr list failed${code}:\n${detail}`,
    { mutatesWorkspace: false },
  );
}

async function handleUndoLastAiChange(deps: RepoChatHandlerDeps): Promise<RepoChatHandled> {
  const checkpoint = await deps.checkpointStore.latest();
  if (checkpoint === null) {
    return handled(
      'undo_last_ai_change',
      "I can't safely undo yet: no AI checkpoint exists for this repo.",
      { mutatesWorkspace: false },
    );
  }
  if (deps.readFileText === undefined) {
    return handled(
      'undo_last_ai_change',
      `AI checkpoint ${checkpoint.id} exists, but current-file inspection is not wired, so I will not preview or apply undo.`,
      { mutatesWorkspace: false },
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
      { mutatesWorkspace: false },
    );
  }

  const writes = plan.actions.filter((action) => action.type === 'write').length;
  const deletes = plan.actions.filter((action) => action.type === 'delete').length;
  const summary = `Undo is available for checkpoint ${checkpoint.id}: would write ${writes} file(s) and delete ${deletes} file(s).`;

  // Without applyUndoActions on the deps pick, remain preview-only (tests / thin paths).
  if (typeof deps.repoOps.applyUndoActions !== 'function') {
    return handled(
      'undo_last_ai_change',
      `${summary} I have not applied it yet.`,
      { mutatesWorkspace: false },
    );
  }

  const oversight: Oversight = deps.oversight ?? 'checkpoint';
  let proceed = true;
  if (oversight !== 'autonomous') {
    const confirmMsg = `${summary}\n\nApply this undo?`;
    if (deps.commandGate?.confirm) {
      proceed = await deps.commandGate.confirm(confirmMsg);
    } else {
      // Non-autonomous without a confirm seam → honest preview only (safe).
      return handled(
        'undo_last_ai_change',
        `${summary} I have not applied it yet.`,
        { mutatesWorkspace: false },
      );
    }
  }
  if (!proceed) {
    return handled('undo_last_ai_change', 'Undo declined by gate.', { mutatesWorkspace: false });
  }

  // Record as local-write when a gate is present (audit trail).
  const display = `apply AI checkpoint undo (${checkpoint.id})`;
  if (deps.commandGate !== undefined) {
    const gate = deps.commandGate.gate(display);
    if (!gate.allowed) {
      await recordGate(deps.commandGate, deps.cwd, display, gate, true, 'denied');
      return handled(
        'undo_last_ai_change',
        'Command gate denied AI checkpoint undo.',
        { mutatesWorkspace: false },
      );
    }
    const result = await deps.repoOps.applyUndoActions(deps.cwd, plan.actions);
    await recordGate(deps.commandGate, deps.cwd, display, gate, true, 'ran');
    return formatUndoApplyResult(checkpoint.id, summary, result);
  }

  const result = await deps.repoOps.applyUndoActions(deps.cwd, plan.actions);
  return formatUndoApplyResult(checkpoint.id, summary, result);
}

function formatUndoApplyResult(
  checkpointId: string,
  summary: string,
  result: { readonly applied: number; readonly errors: readonly string[] },
): RepoChatHandled {
  if (result.errors.length === 0) {
    return handled(
      'undo_last_ai_change',
      `${summary}\n\nApplied undo for checkpoint ${checkpointId}: ${result.applied} action(s).`,
      { mutatesWorkspace: true },
    );
  }
  const errClip = result.errors.slice(0, 5).join('; ');
  return handled(
    'undo_last_ai_change',
    `${summary}\n\nPartial undo for checkpoint ${checkpointId}: applied ${result.applied}, errors: ${errClip}.`,
    { mutatesWorkspace: result.applied > 0 },
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
      if (!status.isGitRepo) return handled('status', 'This folder is not a git repo.', { mutatesWorkspace: false });
      if (status.clean) return handled('status', 'Repo status: clean.', { mutatesWorkspace: false });
      return handled(
        'status',
        `Repo status: ${status.changedFiles.length} changed file(s): ${formatPathList(status.changedFiles)}.`,
        { mutatesWorkspace: false },
      );
    }

    case 'github_pr_status':
      return handleGithubPrStatus(deps);

    case 'github_pr_checks':
      return handleGithubPrChecks(deps);

    case 'github_pr_create':
      return handleGithubPrCreate(deps);

    case 'gitlab_mr_status':
      return handleGitlabMrStatus(deps, 'gitlab_mr_status');

    case 'gitlab_mr_create':
      return handleGitlabMrCreate(deps, 'gitlab_mr_create');

    case 'gitlab_ci_status':
      return handleGitlabCiStatus(deps, 'gitlab_ci_status');

    case 'summarize_diff': {
      const diff = await deps.repoOps.diff(deps.cwd);
      if (!diff.isGitRepo) return handled('summarize_diff', 'This folder is not a git repo.', { mutatesWorkspace: false });
      if (diff.empty) return handled('summarize_diff', 'No git diff detected.', { mutatesWorkspace: false });
      const parts = ['Git diff detected.'];
      if (diff.stat.trim().length > 0) parts.push(`Stat:\n${diff.stat.trim()}`);
      if (diff.patchPreview.trim().length > 0) parts.push(`Preview:\n${diff.patchPreview.trim()}`);
      return handled('summarize_diff', parts.join('\n\n'), { mutatesWorkspace: false });
    }

    case 'verify_only': {
      const detect = deps.verifyPort?.detectTestCommand ?? deps.repoOps.detectTestCommand;
      const command = await detect(deps.cwd);
      if (command === null) {
        return handled(
          'verify_only',
          'No test command was detected for this repo yet. I have not run anything.',
          { mutatesWorkspace: false },
        );
      }
      const runner = deps.verifyPort?.runTests;
      if (!runner || !deps.commandGate) {
        return handled(
          'verify_only',
          `Detected test command: ${formatCommand(command)}. I have not run it yet.`,
          { mutatesWorkspace: false },
        );
      }
      const TIMEOUT_MS = 120_000;
      const result = await runner(deps.cwd, command, TIMEOUT_MS, deps.commandGate);
      let outcomeLine = `Test run ${result.outcome.toUpperCase()} for ${formatCommand(command)} in ${result.durationMs}ms.`;
      if (result.output && result.output.trim()) {
        const clip = result.output.trim().slice(0, 400);
        outcomeLine += `\nOutput:\n${clip}${result.output.length > 400 ? '…' : ''}`;
      }
      return handled('verify_only', outcomeLine, { mutatesWorkspace: false });
    }

    case 'commit_current_ai_change': {
      const status = await deps.repoOps.status(deps.cwd);
      const diff = await deps.repoOps.diff(deps.cwd);
      if (!status.isGitRepo) {
        return handled('commit_current_ai_change', 'This folder is not a git repo.', {
          mutatesWorkspace: false,
        });
      }
      if (diff.empty && status.clean) {
        return handled('commit_current_ai_change', 'No changes to commit.', {
          mutatesWorkspace: false,
        });
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
        return handled('commit_current_ai_change', 'Commit declined by gate.', {
          mutatesWorkspace: false,
        });
      }

      const fileCount = status.changedFiles.length;
      const reviewMsg =
        fileCount > 0
          ? `chat: commit ${fileCount} file(s) via natural language [${status.changedFiles.slice(0, 3).join(', ')}${fileCount > 3 ? ', ...' : ''}]`
          : 'chat: commit current changes';
      const commitRes = await deps.repoOps.commitChanges(deps.cwd, reviewMsg);
      const receipt = commitRes.ok
        ? `Commit succeeded: ${commitRes.output}`
        : `Commit failed: ${commitRes.output}`;
      return handled('commit_current_ai_change', `${summary}\n\n${receipt}`, {
        mutatesWorkspace: true,
      });
    }

    case 'undo_last_ai_change':
      return handleUndoLastAiChange(deps);

    default: {
      const exhaustive: never = intent.operation;
      return exhaustive;
    }
  }
}
