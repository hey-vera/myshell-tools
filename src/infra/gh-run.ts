/**
 * src/infra/gh-run.ts — fail-soft production runner for the GitHub CLI (`gh`).
 *
 * Shell execution lives here (allowlisted) so interface layers never import
 * `node:child_process`. Callers gate user-facing invocations via CommandGatePort.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Cap so a hung gh never blocks chat. */
const GH_RUN_TIMEOUT_MS = 15_000;

/** Result of a single `gh …` invocation (injectable for hermetic tests). */
export interface GhRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

/**
 * Production `gh` runner. Never throws — non-zero / spawn failure → ok:false.
 */
export async function runGh(
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GH_RUN_TIMEOUT_MS,
): Promise<GhRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', [...args], {
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
            : 'gh failed',
      exitCode,
    };
  }
}
