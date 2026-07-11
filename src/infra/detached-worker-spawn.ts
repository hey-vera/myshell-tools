/**
 * src/infra/detached-worker-spawn.ts — ensure a detached myshell goal worker
 * process is running (multi-chat PR-D daemon-lite).
 *
 * Not a Windows service. Spawns `node <cli> worker` (or argv0) with
 * `detached: true` + `unref()` so it survives TUI exit. Fail-soft: any spawn
 * error returns `{ ok: false }` and the caller falls back to in-process work.
 *
 * Shell-exec site: reviewed, allowlisted in test/arch/guards.test.ts.
 * Spawns only this package's CLI entry — never arbitrary user shell.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  goalJobsRoot,
  isProcessAlive,
  readWorkerPid,
  writeWorkerPidFile,
} from './goal-job-store.js';
import { workerLogFilePath } from './goal-job.js';
import { defaultStateLayout } from './state-layout.js';

export interface EnsureWorkerResult {
  readonly ok: boolean;
  /** True when a worker was already alive (pid file + kill 0). */
  readonly alreadyRunning: boolean;
  readonly pid?: number;
  readonly reason?: string;
}

export interface EnsureWorkerOptions {
  /** Override jobs root (tests). */
  readonly jobsRoot?: string;
  /** Working directory for the worker process. */
  readonly cwd?: string;
  /** Extra env (never used to inject secrets beyond process.env inheritance). */
  readonly env?: NodeJS.ProcessEnv;
  /** Resolve CLI entry path (tests). */
  readonly resolveCliEntry?: () => string | null;
  /** Inject spawn (tests). */
  readonly spawnImpl?: typeof spawn;
  /** Inject liveness check (tests). */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * Resolve the built CLI entry (`dist/cli.js`) relative to this module, or the
 * currently running script when already executing via the CLI.
 */
export function resolveMyshellCliEntry(): string | null {
  // 1) Prefer the running entry when it looks like our CLI.
  const argv1 = process.argv[1];
  if (typeof argv1 === 'string' && argv1.length > 0 && existsSync(argv1)) {
    const base = argv1.replace(/\\/g, '/');
    if (base.endsWith('/cli.js') || base.endsWith('/cli.ts') || base.endsWith('/cli.mjs')) {
      return argv1;
    }
  }
  // 2) dist/cli.js next to package (this file → …/dist/infra/ → …/dist/cli.js)
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', 'cli.js'),
      join(here, '..', '..', 'dist', 'cli.js'),
      join(process.cwd(), 'dist', 'cli.js'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    /* fail-soft */
  }
  return null;
}

/**
 * Ensure a detached `myshell-tools worker` process is running.
 * Idempotent via worker.pid + process liveness. Fail-soft on any error.
 */
export async function ensureWorkerProcess(
  options: EnsureWorkerOptions = {},
): Promise<EnsureWorkerResult> {
  const jobsRoot = options.jobsRoot ?? goalJobsRoot(defaultStateLayout());
  const isAlive = options.isAlive ?? isProcessAlive;
  const spawnImpl = options.spawnImpl ?? spawn;
  const resolveCli = options.resolveCliEntry ?? resolveMyshellCliEntry;

  try {
    await mkdir(jobsRoot, { recursive: true });
  } catch {
    return { ok: false, alreadyRunning: false, reason: 'mkdir-failed' };
  }

  // Already supervised?
  try {
    const existing = await readWorkerPid(jobsRoot);
    if (existing !== null && isAlive(existing)) {
      return { ok: true, alreadyRunning: true, pid: existing };
    }
  } catch {
    /* continue to spawn */
  }

  const cliEntry = resolveCli();
  if (cliEntry === null) {
    return { ok: false, alreadyRunning: false, reason: 'cli-entry-missing' };
  }

  const cwd = options.cwd ?? process.cwd();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    // Marker so nested tools can detect worker context (no secrets).
    MYSHELL_DETACHED_WORKER: '1',
  };

  try {
    const child = spawnImpl(process.execPath, [cliEntry, 'worker'], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Detach from parent event loop / job group so TUI exit does not kill worker.
    child.unref();

    const pid = child.pid;
    if (pid === undefined || !Number.isFinite(pid) || pid <= 0) {
      return { ok: false, alreadyRunning: false, reason: 'spawn-no-pid' };
    }

    await writeWorkerPidFile(jobsRoot, pid);

    // Best-effort log line (no secrets).
    try {
      const line = `${new Date().toISOString()} ensureWorkerProcess spawned pid=${pid}\n`;
      await appendFile(workerLogFilePath(jobsRoot), line, 'utf8');
    } catch {
      /* ignore */
    }

    return { ok: true, alreadyRunning: false, pid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      alreadyRunning: false,
      reason: `spawn-failed:${message.slice(0, 120)}`,
    };
  }
}
