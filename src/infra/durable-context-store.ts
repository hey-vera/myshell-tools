/**
 * src/infra/durable-context-store.ts — minimal append-only durable provider-neutral context store (vision P0 / start of r7-item11).
 *
 * Design: jsonl per logId (conversation) under state/durable-context/.
 * - <logId>.events.jsonl : CanonicalEventV1 lines (append only)
 * - <logId>.snapshots.jsonl : ContextSnapshotV1 lines (append only)
 *
 * Writer/reader use atomicAppendJSONL + guard-skipping readers (malformed lines dropped).
 * No full CAS/locking/snapshot cadence yet — keep minimal slice.
 * Reconstruction uses the pure core reconstructContextV1 (wired by passing loaded data to it).
 *
 * Global like conversations (not per-project). Ids assumed valid per core isValidId.
 *
 * Off any flag, this is unreachable; synthetic paths in history remain for compat.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CanonicalEventV1, ContextSnapshotV1 } from '../core/durable-context.js';
import { atomicAppendJSONL } from './atomic.js';
import { isCanonicalEventV1, isContextSnapshotV1 } from './jsonl-guards.js';
import { defaultStateLayout } from './state-layout.js';

function resolveDurableDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  const l = defaultStateLayout();
  return l.paths.durableContextDir;
}

function safeLogId(logId: string): string {
  // conservative filesystem safe; core already validates
  return (logId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function getEventsPath(logId: string, overrideDir?: string): string {
  return join(resolveDurableDir(overrideDir), `${safeLogId(logId)}.events.jsonl`);
}

function getSnapshotsPath(logId: string, overrideDir?: string): string {
  return join(resolveDurableDir(overrideDir), `${safeLogId(logId)}.snapshots.jsonl`);
}

async function ensureDurableDir(overrideDir?: string): Promise<void> {
  await mkdir(resolveDurableDir(overrideDir), { recursive: true });
}

/** Writer for durable canonical events + snapshots. */
export interface DurableContextWriter {
  appendEvent(logId: string, event: CanonicalEventV1): Promise<void>;
  appendSnapshot(logId: string, snapshot: ContextSnapshotV1): Promise<void>;
}

/** Reader for durable canonical events + snapshots (used to feed pure reconstruct). */
export interface DurableContextReader {
  readEvents(logId: string): Promise<readonly CanonicalEventV1[]>;
  readSnapshots(logId: string): Promise<readonly ContextSnapshotV1[]>;
}

export interface CreateDurableContextStoreOptions {
  /** Test override for the durable dir (absolute). When set, bypasses layout. */
  readonly dir?: string;
}

/**
 * Create a combined writer+reader. Callers (orchestrate wiring etc) inject as needed.
 * For P0 minimal, no config/flag here; higher layers decide reachability.
 */
export function createDurableContextStore(opts: CreateDurableContextStoreOptions = {}): DurableContextWriter & DurableContextReader {
  const { dir } = opts;
  return {
    async appendEvent(logId: string, event: CanonicalEventV1): Promise<void> {
      await ensureDurableDir(dir);
      await atomicAppendJSONL(getEventsPath(logId, dir), event);
    },
    async appendSnapshot(logId: string, snapshot: ContextSnapshotV1): Promise<void> {
      await ensureDurableDir(dir);
      await atomicAppendJSONL(getSnapshotsPath(logId, dir), snapshot);
    },
    async readEvents(logId: string): Promise<readonly CanonicalEventV1[]> {
      return readDurableEvents(logId, dir);
    },
    async readSnapshots(logId: string): Promise<readonly ContextSnapshotV1[]> {
      return readDurableSnapshots(logId, dir);
    },
  };
}

/** Read + guard-filter events for a log. Empty on missing file. */
export async function readDurableEvents(logId: string, dir?: string): Promise<CanonicalEventV1[]> {
  const path = getEventsPath(logId, dir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return [];
    throw err;
  }
  const entries: CanonicalEventV1[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isCanonicalEventV1(parsed)) entries.push(parsed);
    } catch {
      // skip malformed / non-matching
    }
  }
  return entries;
}

/** Read + guard-filter snapshots for a log. Empty on missing file. */
export async function readDurableSnapshots(logId: string, dir?: string): Promise<ContextSnapshotV1[]> {
  const path = getSnapshotsPath(logId, dir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return [];
    throw err;
  }
  const entries: ContextSnapshotV1[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isContextSnapshotV1(parsed)) entries.push(parsed);
    } catch {
      // skip malformed / non-matching
    }
  }
  return entries;
}

/**
 * Minimal wire helper: load events + snapshots for log and feed pure reconstruct.
 * Callers in history/prompt paths can use this (via async composition).
 * Still synthetic-compatible when no files; returns what reconstruct produces.
 */
export async function loadAndReconstruct(
  logId: string,
  conversationId: string,
  dir?: string,
): Promise<import('../core/durable-context.js').ReconstructedContextV1> {
  const { reconstructContextV1 } = await import('../core/durable-context.js');
  const snapshots = await readDurableSnapshots(logId, dir);
  const tailEvents = await readDurableEvents(logId, dir);
  return reconstructContextV1({ logId, conversationId, snapshots, tailEvents });
}
