import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  EvidenceRecord,
  EvidenceSnapshotV1,
  EvidenceSnapshotV2,
} from '../core/evidence.js';
import {
  normalizeEvidenceSnapshotV1,
  normalizeEvidenceSnapshotV2,
} from '../core/evidence.js';
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

function getEvidenceV2Dir(cwd: string): string {
  return join(getEvidenceDir(cwd), 'v2');
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

function getEvidenceV2Path(cwd: string, taskId: string): string {
  if (!isValidTaskId(taskId)) {
    throw new InvalidEvidenceTaskIdError(taskId);
  }
  return join(getEvidenceV2Dir(cwd), `${taskId}.jsonl`);
}

function getEvidenceV2LockPath(cwd: string, taskId: string): string {
  return `${getEvidenceV2Path(cwd, taskId)}.lock`;
}

async function ensureEvidenceDir(cwd: string): Promise<void> {
  await mkdir(getEvidenceDir(cwd), { recursive: true });
}

async function ensureEvidenceV2Dir(cwd: string): Promise<void> {
  await mkdir(getEvidenceV2Dir(cwd), { recursive: true });
}

function parseEvidenceLines(raw: string): EvidenceSnapshotV1[] {
  const snapshots: EvidenceSnapshotV1[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const snapshot = normalizeEvidenceSnapshotV1(JSON.parse(trimmed) as unknown);
      if (snapshot !== null) snapshots.push(snapshot);
    } catch {
      // One malformed/partial JSONL line must not hide the rest of the evidence.
    }
  }
  return snapshots;
}

function parseEvidenceLinesV2(raw: string): EvidenceSnapshotV2[] {
  const snapshots: EvidenceSnapshotV2[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const snapshot = normalizeEvidenceSnapshotV2(JSON.parse(trimmed) as unknown);
      if (snapshot !== null) snapshots.push(snapshot);
    } catch {
      // One malformed/partial JSONL line must not hide the rest of the evidence.
    }
  }
  return snapshots;
}

function byTurnNumber(a: { turnNumber: number }, b: { turnNumber: number }): number {
  return a.turnNumber - b.turnNumber;
}

async function readEvidenceFile(path: string): Promise<EvidenceSnapshotV1[]> {
  const raw = await readFile(path, 'utf8');
  return parseEvidenceLines(raw);
}

async function readEvidenceFileV2(path: string): Promise<EvidenceSnapshotV2[]> {
  const raw = await readFile(path, 'utf8');
  return parseEvidenceLinesV2(raw);
}

async function compactEvidenceLocked(path: string): Promise<void> {
  const snapshots = (await readEvidenceFile(path)).sort(byTurnNumber);
  if (snapshots.length <= MAX_SNAPSHOTS_PER_TASK) return;

  const kept = snapshots.slice(-MAX_SNAPSHOTS_PER_TASK);
  const body = kept.map((snapshot) => JSON.stringify(snapshot)).join('\n') + '\n';
  await atomicWrite(path, body, 0o600);
}

async function compactEvidenceV2Locked(path: string): Promise<void> {
  const snapshots = (await readEvidenceFileV2(path)).sort(byTurnNumber);
  if (snapshots.length <= MAX_SNAPSHOTS_PER_TASK) return;

  const kept = snapshots.slice(-MAX_SNAPSHOTS_PER_TASK);
  const body = kept.map((snapshot) => JSON.stringify(snapshot)).join('\n') + '\n';
  await atomicWrite(path, body, 0o600);
}

export async function appendEvidence(
  cwd: string,
  snapshot: EvidenceSnapshotV1,
): Promise<void> {
  const path = getEvidencePath(cwd, snapshot.taskId);
  const lockPath = getEvidenceLockPath(cwd, snapshot.taskId);
  await ensureEvidenceDir(cwd);

  await withLock(lockPath, async () => {
    await atomicAppendJSONL(path, snapshot);
    await compactEvidenceLocked(path);
  });
}

export async function appendEvidenceV2(
  cwd: string,
  snapshot: EvidenceSnapshotV2,
): Promise<void> {
  const path = getEvidenceV2Path(cwd, snapshot.taskId);
  const lockPath = getEvidenceV2LockPath(cwd, snapshot.taskId);
  await ensureEvidenceV2Dir(cwd);

  await withLock(lockPath, async () => {
    await atomicAppendJSONL(path, snapshot);
    await compactEvidenceV2Locked(path);
  });
}

function mergeEarliestFirst(
  v1: EvidenceSnapshotV1[],
  v2: EvidenceSnapshotV2[],
): EvidenceRecord[] {
  type Tagged = { readonly s: EvidenceRecord; readonly lane: 1 | 2 };
  const all: Tagged[] = [
    ...v1.map((s): Tagged => ({ s, lane: 1 })),
    ...v2.map((s): Tagged => ({ s, lane: 2 })),
  ];

  all.sort((a, b) => {
    const tn = a.s.turnNumber - b.s.turnNumber;
    if (tn !== 0) return tn;
    const ts = a.s.timestamp - b.s.timestamp;
    if (ts !== 0) return ts;
    return a.lane - b.lane;
  });

  const deduped = new Map<string, EvidenceRecord>();
  for (const { s } of all) {
    const key = `${s.taskId}|${s.turnNumber}|${s.timestamp}`;
    deduped.set(key, s);
  }

  const result = [...deduped.values()];
  result.sort((a, b) => {
    const tn = a.turnNumber - b.turnNumber;
    if (tn !== 0) return tn;
    return a.timestamp - b.timestamp;
  });

  return result;
}

/**
 * Read task evidence from both V1 and V2 lanes in chronological order.
 * Malformed JSONL rows are skipped so partial hand edits remain safe.
 * On an exact (taskId, turnNumber, timestamp) collision V2 is preferred.
 * Returns the newest 30 snapshots without rewriting V1.
 */
export async function readEvidence(cwd: string, taskId: string): Promise<EvidenceRecord[]> {
  if (!isValidTaskId(taskId)) {
    throw new InvalidEvidenceTaskIdError(taskId);
  }

  const v1Path = getEvidencePath(cwd, taskId);
  const v2Path = getEvidenceV2Path(cwd, taskId);

  let v1: EvidenceSnapshotV1[] = [];
  let v2: EvidenceSnapshotV2[] = [];

  try {
    v1 = await readEvidenceFile(v1Path);
  } catch {
    // V1 file may not exist — that is fine
  }

  try {
    v2 = await readEvidenceFileV2(v2Path);
  } catch {
    // V2 file may not exist — that is fine
  }

  if (v1.length === 0 && v2.length === 0) return [];

  const merged = mergeEarliestFirst(v1, v2);
  return merged.slice(-MAX_SNAPSHOTS_PER_TASK);
}
