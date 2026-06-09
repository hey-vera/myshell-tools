/**
 * test/unit/taste-ledger.test.ts — the I/O layer of the learned-taste ledger
 * (src/infra/taste-ledger.ts).
 *
 * Hermetic: explicit `homeDir` (temp dir) + injected `Clock`, mirroring the
 * user-memory-store tests. Covers: record→recall round-trip, project scoping at
 * the file level, fail-soft on a corrupt/foreign JSONL line, observed-only (an
 * unvalidatable observation is DROPPED, never fabricated), missing-ledger →
 * EMPTY_PLAYBOOK, the 0o600 perimeter, and the privacy-preserving project key
 * re-export. ZERO model calls.
 *
 * Run: node --experimental-strip-types --test test/unit/taste-ledger.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  createFileTasteLedger,
  deriveProjectKey,
  type TasteLedger,
} from '../../src/infra/taste-ledger.ts';
import { classifyPushBackAnswer } from '../../src/core/brain.ts';
import type { Clock } from '../../src/core/types.ts';

function makeFakeClock(startIso = '2026-06-09T00:00:00.000Z'): Clock & { setIso(iso: string): void } {
  let counter = 0;
  let iso = startIso;
  return {
    now() {
      return Date.parse(iso);
    },
    isoNow() {
      return iso;
    },
    uuid() {
      counter += 1;
      return `01HX0000000000000000${String(counter).padStart(6, '0')}`;
    },
    random() {
      return 0.5;
    },
    setIso(next: string) {
      iso = next;
    },
  };
}

let homeDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let ledger: TasteLedger;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), `taste-test-${randomUUID()}-`));
  clock = makeFakeClock();
  ledger = createFileTasteLedger({ homeDir, clock });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

const tasteFile = () => join(homeDir, '.myshell-tools', 'memory', 'taste.jsonl');

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('record → recall round-trip', () => {
  it('records observed events and recalls a distilled playbook', async () => {
    await ledger.record({ signal: 'fork_choice', subject: 'data fetching', choice: 'server', projectKey: null });
    await ledger.record({ signal: 'fork_choice', subject: 'data fetching', choice: 'server', projectKey: null });
    await ledger.record({ signal: 'accept_unchanged', subject: 'plan', choice: 'go', projectKey: null });
    await ledger.record({ signal: 'pushback_accept', subject: 'di', choice: 'di', projectKey: null });

    const all = await ledger.readAll();
    assert.equal(all.length, 4);
    for (const e of all) assert.equal(e.source, 'observed');

    const pb = await ledger.recall(null);
    // accept_unchanged + pushback_accept = +2 net proceed → bias +1.
    assert.equal(pb.memoryBias, 1);
    assert.equal(pb.lines[0], 'data fetching: server'); // support 2, ranked first
  });

  it('a missing ledger recalls the empty playbook (no bias)', async () => {
    const pb = await ledger.recall(null);
    assert.equal(pb.memoryBias, 0);
    assert.deepEqual(pb.lines, []);
  });

  // The FREE JUDGMENT LAYER push-back resolution point (master-judgment §4.2): the
  // user's accept/reject of a push_back, classified by the brain's pure
  // `classifyPushBackAnswer`, round-trips into the ledger as pushback_accept /
  // pushback_reject and distills correctly (the signals that shipped INERT in
  // 3.39.0, now ACTIVATED). This proves the activation path end-to-end at the data
  // level — the same mapping menu.ts wires at the resolution point.
  it('push-back accept/reject (via classifyPushBackAnswer) round-trips and distills', async () => {
    const subject = 'before I build — this is irreversible. Want me to stage it?';
    // The user accepts the partner's call twice → +2 proceed lean → bias +1.
    for (const answer of ['Go with your call', 'Go with your call']) {
      const verdict = classifyPushBackAnswer(answer);
      assert.equal(verdict, 'accept');
      await ledger.record({ signal: 'pushback_accept', subject, choice: answer, projectKey: null });
    }
    // A reject is recorded as the ask-lean signal.
    const rejVerdict = classifyPushBackAnswer('Do it my way');
    assert.equal(rejVerdict, 'reject');
    await ledger.record({ signal: 'pushback_reject', subject, choice: 'Do it my way', projectKey: null });

    const all = await ledger.readAll();
    assert.equal(all.length, 3);
    const signalsSeen = all.map((e) => e.signal).sort();
    assert.deepEqual(signalsSeen, ['pushback_accept', 'pushback_accept', 'pushback_reject']);

    const pb = await ledger.recall(null);
    // 2 accept (+2) + 1 reject (-1) = +1 net → below the +2 bias threshold → 0.
    assert.equal(pb.memoryBias, 0);
    // The push-back subject becomes a distilled taste line (a choice-bearing signal).
    assert.ok(pb.lines.length >= 1, 'push-back outcomes contribute distilled lines');
  });

  it('an ambiguous push-back answer (Explain/free-text) classifies null → not recorded as a pushback signal', () => {
    // The honesty floor: only the unambiguous structured calls are taste signals.
    assert.equal(classifyPushBackAnswer('Explain'), null);
    assert.equal(classifyPushBackAnswer('actually do something completely different'), null);
  });
});

// ---------------------------------------------------------------------------
// Observed-only honesty gate
// ---------------------------------------------------------------------------

describe('observed-only (no fabricated facts)', () => {
  it('drops an unvalidatable observation — nothing is written', async () => {
    // @ts-expect-error — a non-observed/garbage signal must be dropped, not stored
    await ledger.record({ signal: 'guessed_sentiment', subject: 'x', choice: 'y' });
    await ledger.record({ signal: 'fork_choice', subject: '   ', choice: 'blank-subject' });
    const all = await ledger.readAll();
    assert.equal(all.length, 0);
    // The file is never even created when every observation is dropped.
    await assert.rejects(stat(tasteFile()));
  });

  it('every stored event carries source:observed (the honesty floor)', async () => {
    await ledger.record({ signal: 'immediate_edit', subject: 'tone', choice: 'warmer' });
    const raw = await readFile(tasteFile(), 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.source, 'observed');
    assert.equal(parsed.v, 1);
  });
});

// ---------------------------------------------------------------------------
// Project scoping (file level)
// ---------------------------------------------------------------------------

describe('project scoping', () => {
  it('a project-scoped fact only biases its own project; global rides everywhere', async () => {
    const keyA = deriveProjectKey('/home/me/projectA');
    const keyB = deriveProjectKey('/home/me/projectB');
    await ledger.record({ signal: 'fork_choice', subject: 'router', choice: 'app-router', projectKey: keyA });
    await ledger.record({ signal: 'fork_choice', subject: 'style', choice: 'concise', projectKey: null });

    const inA = await ledger.recall(keyA);
    assert.ok(inA.lines.includes('router: app-router'));
    assert.ok(inA.lines.includes('style: concise')); // global rides

    const inB = await ledger.recall(keyB);
    assert.equal(inB.lines.includes('router: app-router'), false); // A's call does NOT leak to B
    assert.ok(inB.lines.includes('style: concise')); // global still rides
  });

  it('deriveProjectKey is privacy-preserving (basename#hash, never the raw path)', () => {
    const key = deriveProjectKey('/home/secret-user/private-repo');
    assert.match(key, /^private-repo#[0-9a-f]{8}$/);
    assert.equal(key.includes('/home/secret-user'), false);
  });
});

// ---------------------------------------------------------------------------
// Fail-soft on corruption
// ---------------------------------------------------------------------------

describe('fail-soft on corrupt / foreign JSONL', () => {
  it('skips a corrupt line and a foreign line, keeps the valid ones', async () => {
    await mkdir(join(homeDir, '.myshell-tools', 'memory'), { recursive: true });
    const valid = JSON.stringify({
      v: 1,
      ts: '2026-06-09T00:00:00.000Z',
      projectKey: null,
      signal: 'fork_choice',
      subject: 'data',
      choice: 'server',
      source: 'observed',
    });
    const foreign = JSON.stringify({ some: 'other-jsonl-record', source: 'inferred' });
    await writeFile(tasteFile(), `${valid}\nthis is not json {{{\n${foreign}\n${valid}\n`, 'utf8');

    const all = await ledger.readAll();
    assert.equal(all.length, 2); // only the two valid lines survive
    const pb = await ledger.recall(null);
    assert.equal(pb.lines[0], 'data: server');
  });

  it('a completely garbage file recalls the empty playbook — never throws', async () => {
    await mkdir(join(homeDir, '.myshell-tools', 'memory'), { recursive: true });
    await writeFile(tasteFile(), 'not\njson\nat\nall\n', 'utf8');
    const pb = await ledger.recall(null);
    assert.deepEqual(pb.lines, []);
    assert.equal(pb.memoryBias, 0);
  });
});

// ---------------------------------------------------------------------------
// Security perimeter
// ---------------------------------------------------------------------------

describe('0o600 perimeter', () => {
  it('the taste ledger file is created mode 0o600', async () => {
    await ledger.record({ signal: 'fork_choice', subject: 'data', choice: 'server' });
    const st = await stat(tasteFile());
    assert.equal(st.mode & 0o777, 0o600);
  });
});
