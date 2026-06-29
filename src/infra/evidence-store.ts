import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EvidenceSnapshot } from '../core/evidence.js';
import { normalizeEvidenceSnapshot } from '../core/evidence.js';
import { atomicAppendJSONL, atomicWrite, withLock } from './atomic.js';
import { defaultStateLayout, projectStateDirs } from './state-layout.js';

const MAX_SNAPSHOTS_PER_TASK = 30;
const VALID_TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

export class InvalidEvidenceTaskIdError extends Error {
  constructor(taskId: string) {
    super(`Invalid evidence task id (path-traversal reject): ${JSON.stringify(taskId)}`);
    this.name = 'InvalidEvidenceTaskIdError';
  }
}

function isValidTaskId(taskId: string): boolean {
  return typeof taskId === 'string' && taskId.length > 0 && VALID_TASK_ID_RE.test(taskId);
}

function getEvidenceDir(cwd: string): string {
  return projectStateDirs(defaultStateLayout(), cwd).evidenceDir;
}

function getEvidencePath(cwd: string, taskId: string): string {
  if (!isValidTaskId(taskId)) {
    throw new InvalidEvidenceTaskIdError(taskId);
  }
  return join(getEvidenceDir(cwd), `${taskId}.jsonl`);
}

function getEvidenceLockPath(cwd: string, taskId: string): string {
  return `${getEvidencePath(cwd, taskId)}.lock`;
}

async function ensureEvidenceDir(cwd: string): Promise<void> {
  await mkdir(getEvidenceDir(cwd), { recursive: true });
}

function parseEvidenceLines(raw: string): EvidenceSnapshot[] {
  const snapshots: EvidenceSnapshot[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const snapshot = normalizeEvidenceSnapshot(JSON.parse(trimmed) as unknown);
      if (snapshot !== null) snapshots.push(snapshot);
    } catch {
      // One malformed/partial JSONL line must not hide the rest of the evidence.
    }
  }
  return snapshots;
}

function byTurnNumber(a: EvidenceSnapshot, b: EvidenceSnapshot): number {
  return a.turnNumber - b.turnNumber;
}

async function readEvidenceFile(path: string): Promise<EvidenceSnapshot[]> {
  const raw = await readFile(path, 'utf8');
  return parseEvidenceLines(raw);
}

async function compactEvidenceLocked(path: string): Promise<void> {
  const snapshots = (await readEvidenceFile(path)).sort(byTurnNumber);
  if (snapshots.length <= MAX_SNAPSHOTS_PER_TASK) return;

  const kept = snapshots.slice(-MAX_SNAPSHOTS_PER_TASK);
  const body = kept.map((snapshot) => JSON.stringify(snapshot)).join('\n') + '\n';
  await atomicWrite(path, body, 0o600);
}

export async function appendEvidence(
  cwd: string,
  snapshot: EvidenceSnapshot,
): Promise<void> {
  const path = getEvidencePath(cwd, snapshot.taskId);
  const lockPath = getEvidenceLockPath(cwd, snapshot.taskId);
  await ensureEvidenceDir(cwd);

  await withLock(lockPath, async () => {
    await atomicAppendJSONL(path, snapshot);
    await compactEvidenceLocked(path);
  });
}

/**
 * Read task evidence in chronological turn order. Malformed JSONL rows and rows
 * with the wrong snapshot shape are skipped so partial hand edits remain safe.
 */
export async function readEvidence(cwd: string, taskId: string): Promise<EvidenceSnapshot[]> {
  const path = getEvidencePath(cwd, taskId);
  try {
    return (await readEvidenceFile(path)).sort(byTurnNumber);
  } catch {
    return [];
  }
}
