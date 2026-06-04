/**
 * src/infra/ledger.ts — LedgerWriter implementation, ledger reader, and summarizer.
 *
 * The ledger is a JSONL file at `.myshell-tools/ledger.jsonl`. Each `record` call appends
 * one LedgerEntry atomically. `readLedger` re-hydrates entries (skipping malformed
 * lines). `summarizeLedger` is a pure reduction used by `myshell-tools cost`.
 */

import { mkdir, readFile } from 'node:fs/promises';
import type { LedgerEntry, LedgerWriter } from '../core/types.js';
import { atomicAppendJSONL } from './atomic.js';
import { isLedgerEntry } from './jsonl-guards.js';
import { getStateDir, getLedgerFile } from './paths.js';

/**
 * Create a LedgerWriter for the given working directory.
 *
 * @param opts.cwd - The project working directory (parent of `.myshell-tools/`).
 */
export function createLedger(opts: { cwd: string }): LedgerWriter {
  const { cwd } = opts;

  return {
    async record(entry: LedgerEntry): Promise<void> {
      await mkdir(getStateDir(cwd), { recursive: true });
      await atomicAppendJSONL(getLedgerFile(cwd), entry);
    },
  };
}

/**
 * Read all LedgerEntry records from the ledger JSONL file.
 *
 * Returns an empty array if the file does not exist. Malformed lines are
 * silently skipped.
 *
 * @param cwd - The project working directory.
 */
export async function readLedger(cwd: string): Promise<LedgerEntry[]> {
  let raw: string;
  try {
    raw = await readFile(getLedgerFile(cwd), 'utf8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return [];
    throw err;
  }

  const entries: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isLedgerEntry(parsed)) entries.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/** Aggregate summary returned by `summarizeLedger`. */
export interface LedgerSummary {
  readonly totalUsd: number;
  readonly calls: number;
  readonly byModel: Record<string, { readonly calls: number; readonly usd: number }>;
}

/**
 * Pure reduction over a ledger entry array.
 *
 * Computes:
 *  - `totalUsd`  — sum of all `entry.usd` values
 *  - `calls`     — total number of entries
 *  - `byModel`   — per-model breakdown keyed by `entry.model`
 *
 * No I/O. Safe to call in tests with hand-built arrays.
 *
 * @param entries - Array of LedgerEntry objects (may be empty).
 */
export function summarizeLedger(entries: LedgerEntry[]): LedgerSummary {
  let totalUsd = 0;
  const byModel: Record<string, { calls: number; usd: number }> = {};

  for (const entry of entries) {
    totalUsd += entry.usd;

    const existing = byModel[entry.model];
    if (existing !== undefined) {
      existing.calls += 1;
      existing.usd += entry.usd;
    } else {
      byModel[entry.model] = { calls: 1, usd: entry.usd };
    }
  }

  return {
    totalUsd,
    calls: entries.length,
    byModel,
  };
}
