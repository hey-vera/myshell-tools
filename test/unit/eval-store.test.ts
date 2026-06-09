/**
 * test/unit/eval-store.test.ts — append-only eval-run storage + command opt-in.
 *
 * Covers the impure store (infra/eval-store.ts) against a real temp dir and the
 * command's opt-in / cost-statement / compare behavior (commands/eval.ts) with a
 * fake OutputSink and NO providers — so no live model call is made. The store is
 * append-only and fail-soft; the command never spends quota without `--yes`.
 *
 * Run: node --import ./test/register.mjs --experimental-strip-types --test test/unit/eval-store.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { appendEvalRun, readEvalRuns } from '../../src/infra/eval-store.ts';
import { getEvalResultsFile } from '../../src/infra/paths.ts';
import { runEvalCommand } from '../../src/commands/eval.ts';
import type { RunResult } from '../../src/core/eval/harness.ts';
import type { OutputSink } from '../../src/interface/render.ts';

const SIGNAL = new AbortController().signal;

function makeRun(ts: string, aggregate: number | null): RunResult {
  return {
    timestamp: ts,
    version: '1.0.0',
    provenance: { answerProvider: 'claude', judgeProvider: 'codex' },
    scorecard: {
      aggregate,
      byDimension: {
        understanding: null,
        judgment: null,
        clarity: null,
        proactivity: null,
        correctness: aggregate,
        honesty: aggregate,
        conciseness: null,
      },
      prompts: [],
      judgedCount: aggregate === null ? 0 : 1,
      totalCount: 1,
    },
  };
}

function sink(): { out: OutputSink; text: () => string } {
  let buf = '';
  return {
    out: { write: (s: string) => { buf += s; }, color: false, isTty: false },
    text: () => buf,
  };
}

describe('eval store — append-only JSONL', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), `eval-store-${randomUUID()}-`));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', async () => {
    assert.deepEqual(await readEvalRuns(dir), []);
  });

  it('appends runs and reads them back oldest-first', async () => {
    await appendEvalRun(dir, makeRun('t1', 4));
    await appendEvalRun(dir, makeRun('t2', 8));
    const runs = await readEvalRuns(dir);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.timestamp, 't1');
    assert.equal(runs[1]!.timestamp, 't2');
    assert.equal(runs[1]!.scorecard.aggregate, 8);
  });

  it('skips malformed lines without crashing', async () => {
    await appendEvalRun(dir, makeRun('t1', 5));
    await appendFile(getEvalResultsFile(dir), 'not json\n{"partial":true}\n', 'utf8');
    const runs = await readEvalRuns(dir);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.timestamp, 't1');
  });
});

describe('eval command — opt-in, cost-stated, never auto-spends', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), `eval-cmd-${randomUUID()}-`));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const baseDeps = (cwd: string) => ({
    cwd,
    version: '1.0.0',
    nowIso: () => '2026-06-09T00:00:00.000Z',
    providers: { claude: { id: 'claude' } } as never,
    policy: undefined as never,
    timeoutMs: 1000,
    authenticatedProviders: ['claude'] as const,
    makeDeps: () => {
      throw new Error('makeDeps must not be called without --yes');
    },
  });

  it('without --yes: prints the cost statement and makes NO model call', async () => {
    const s = sink();
    const code = await runEvalCommand([], baseDeps(dir), s.out, SIGNAL);
    assert.equal(code, 0);
    assert.match(s.text(), /COST:/);
    assert.match(s.text(), /--yes/);
    // No results file was written (nothing ran).
    assert.deepEqual(await readEvalRuns(dir), []);
  });

  it('with no providers: reports honestly and returns non-zero', async () => {
    const s = sink();
    const deps = { ...baseDeps(dir), providers: {} as never, authenticatedProviders: [] as const };
    const code = await runEvalCommand(['--yes'], deps, s.out, SIGNAL);
    assert.equal(code, 1);
    assert.match(s.text(), /No providers/);
  });

  it('--compare with <2 stored runs reports the shortfall (no model call)', async () => {
    const s = sink();
    await appendEvalRun(dir, makeRun('t1', 5));
    const code = await runEvalCommand(['--compare'], baseDeps(dir), s.out, SIGNAL);
    assert.equal(code, 0);
    assert.match(s.text(), /at least two/i);
  });

  it('--compare with ≥2 runs prints the before→after diff', async () => {
    const s = sink();
    await appendEvalRun(dir, makeRun('t1', 4));
    await appendEvalRun(dir, makeRun('t2', 8));
    const code = await runEvalCommand(['--compare'], baseDeps(dir), s.out, SIGNAL);
    assert.equal(code, 0);
    assert.match(s.text(), /4\.0 → 8\.0/);
  });
});
