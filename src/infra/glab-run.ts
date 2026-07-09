/**
 * src/infra/glab-run.ts — fail-soft production runner for the GitLab CLI (`glab`).
 *
 * Shell execution lives here (allowlisted) so interface layers never import
 * `node:child_process`. Callers gate user-facing invocations via CommandGatePort.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Cap so a hung glab never blocks chat. */
const GLAB_RUN_TIMEOUT_MS = 15_000;

/** Result of a single `glab …` invocation (injectable for hermetic tests). */
export interface GlabRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * Production `glab` runner. Never throws — non-zero / spawn failure → ok:false.
 */
export async function runGlab(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GLAB_RUN_TIMEOUT_MS,
): Promise<GlabRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('glab', [...args], {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    });
    return {
      ok: true,
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr: typeof stderr === 'string' ? stderr : '',
      exitCode: 0,
    };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    const exitCode = typeof e.code === 'number' ? e.code : null;
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr:
        typeof e.stderr === 'string' && e.stderr.trim().length > 0
          ? e.stderr
          : typeof e.message === 'string'
            ? e.message
            : 'glab failed',
      exitCode,
    };
  }
}
