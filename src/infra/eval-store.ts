/**
 * src/infra/eval-store.ts — append-only storage + read-back for eval runs.
 *
 * Stores each timestamped {@link RunResult} as one JSONL line under the state dir,
 * reusing the SAME atomic-append infra as the ledger (`atomicAppendJSONL`). Append-
 * only so a run is never lost or overwritten — runs accrete and can be COMPARED
 * over time (before/after a phase → did quality move?).
 *
 * Malformed lines are skipped on read (same fail-soft posture as readLedger), so a
 * partially-written file never crashes `--compare`.
 */

import { mkdir, readFile } from 'node:fs/promises';
import type { RunResult } from '../core/eval/harness.js';
import { atomicAppendJSONL } from './atomic.js';
import { getStateDir, getEvalResultsFile } from './paths.js';

/** Append one completed eval run to the append-only results file (atomic). */
export async function appendEvalRun(cwd: string, run: RunResult): Promise<void> {
  await mkdir(getStateDir(cwd), { recursive: true });
  await atomicAppendJSONL(getEvalResultsFile(cwd), run);
}

/**
 * Shallow structural guard for a stored run line. We do NOT deep-validate the
 * whole scorecard (it is our own serialized type); we only confirm the top-level
 * shape so a foreign/corrupt line is skipped rather than crashing the reader.
 */
function isRunResult(v: unknown): v is RunResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['timestamp'] === 'string' &&
    typeof r['version'] === 'string' &&
    typeof r['scorecard'] === 'object' &&
    r['scorecard'] !== null
  );
}

/**
 * Read all stored eval runs (oldest first). Returns [] when the file does not
 * exist. Malformed lines are skipped.
 */
export async function readEvalRuns(cwd: string): Promise<RunResult[]> {
  let raw: string;
  try {
    raw = await readFile(getEvalResultsFile(cwd), 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return [];
    throw err;
  }
  const runs: RunResult[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRunResult(parsed)) runs.push(parsed);
    } catch {
      // Skip malformed lines.
    }
  }
  return runs;
}
