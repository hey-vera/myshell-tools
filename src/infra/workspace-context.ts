/**
 * src/infra/workspace-context.ts — IMPURE gather for workspace forge context (P0.19).
 *
 * Probes git root + `git remote -v` + PATH presence of `gh` / `glab`, then hands
 * facts to the pure assembler in `core/workspace-context.ts`. Fully fail-soft:
 * missing git, non-repo cwd, or tool probe failures degrade to honest `none` /
 * tools-false rather than throwing.
 *
 * Tool presence is injectable so unit tests never touch the real PATH.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  buildWorkspaceContext,
  parseGitRemoteV,
  type ForgeTools,
  type WorkspaceContext,
} from '../core/workspace-context.js';

const execFileAsync = promisify(execFile);

/** Cap so a hung git never blocks chat open. */
const GIT_TIMEOUT_MS = 4000;
/** Cap for `which` / `where` / version probes. */
const TOOL_TIMEOUT_MS = 2500;

/**
 * Narrow port the detector needs. Injected for hermetic tests; production uses
 * {@link nodeWorkspaceContextPort}.
 */
export interface WorkspaceContextPort {
  /** Git toplevel abs path, or null when not a git repo / git missing. */
  gitToplevel(cwd: string): Promise<string | null>;
  /** Raw stdout of `git remote -v` at root; empty string on failure. */
  gitRemoteV(root: string): Promise<string>;
  /** True when the binary resolves on PATH (best-effort). */
  toolOnPath(name: 'gh' | 'glab'): Promise<boolean>;
}

/**
 * Production port: real git + PATH probes. Each method swallows its own failure.
 */
export const nodeWorkspaceContextPort: WorkspaceContextPort = {
  async gitToplevel(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      const top = stdout.trim();
      return top.length > 0 ? top : null;
    } catch {
      return null;
    }
  },

  async gitRemoteV(root: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['remote', '-v'], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
      });
      return typeof stdout === 'string' ? stdout : '';
    } catch {
      return '';
    }
  },

  async toolOnPath(name: 'gh' | 'glab'): Promise<boolean> {
    return probeOnPath(name);
  },
};

/**
 * Detect workspace forge context for `cwd`. Fully fail-soft → local-only / tools
 * false on any error. NO model call, NO network.
 */
export async function detectWorkspaceContext(
  cwd: string,
  port: WorkspaceContextPort = nodeWorkspaceContextPort,
): Promise<WorkspaceContext> {
  try {
    const gitRoot = await safe(() => port.gitToplevel(cwd), null);
    const remoteStdout =
      gitRoot !== null ? await safe(() => port.gitRemoteV(gitRoot), '') : '';
    const remotes = parseGitRemoteV(remoteStdout);
    const tools = await probeTools(port);
    return buildWorkspaceContext({ cwd, gitRoot, remotes, tools });
  } catch {
    return buildWorkspaceContext({
      cwd,
      gitRoot: null,
      remotes: [],
      tools: { gh: false, glab: false },
    });
  }
}

async function probeTools(port: WorkspaceContextPort): Promise<ForgeTools> {
  const [gh, glab] = await Promise.all([
    safe(() => port.toolOnPath('gh'), false),
    safe(() => port.toolOnPath('glab'), false),
  ]);
  return { gh, glab };
}

/**
 * Best-effort PATH probe. Prefer `where` (Windows) / `which` (POSIX); fall back
 * to `<bin> --version` so a PATH hit with a broken which still counts.
 */
async function probeOnPath(bin: string): Promise<boolean> {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(whichCmd, [bin], {
      timeout: TOOL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (typeof stdout === 'string' && stdout.trim().length > 0) return true;
  } catch {
    // fall through to --version
  }
  try {
    await execFileAsync(bin, ['--version'], {
      timeout: TOOL_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
