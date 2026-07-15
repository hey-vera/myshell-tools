/**
 * Unit tests for src/core/progress-invariant.ts (R7.1).
 * Pure table tests + a production-path simulation of the manager-cycle
 * classification → observe → shouldStopAutoContinue loop (same calls menu.ts uses).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  DEFAULT_NO_PROGRESS_LIMIT,
  buildProgressFingerprint,
  blockedRecordForNoProgress,
  classifyManagerCycleProgress,
  createProgressInvariantState,
  fingerprintRoadmap,
  isMeaningfulProgress,
  observeProgressCycle,
  shouldStopAutoContinue,
} from '../../src/core/progress-invariant.ts';

describe('isMeaningfulProgress', () => {
  it('accepts verdict_write, evidence, blocker_code_change, file_diff_receipt', () => {
    assert.equal(isMeaningfulProgress({ kind: 'verdict_write', detail: 'x' }), true);
    assert.equal(isMeaningfulProgress({ kind: 'evidence', detail: 'x' }), true);
    assert.equal(isMeaningfulProgress({ kind: 'blocker_code_change', detail: 'x' }), true);
    assert.equal(isMeaningfulProgress({ kind: 'file_diff_receipt', detail: 'x' }), true);
  });

  it('rejects status_only and heartbeat (reworded status is never progress)', () => {
    assert.equal(isMeaningfulProgress({ kind: 'status_only', detail: 'still working…' }), false);
    assert.equal(isMeaningfulProgress({ kind: 'heartbeat' }), false);
  });
});

describe('buildProgressFingerprint / fingerprintRoadmap', () => {
  it('is stable for the same parts and differs when parts differ', () => {
    const a = buildProgressFingerprint(['a', 'b']);
    const b = buildProgressFingerprint(['a', 'b']);
    const c = buildProgressFingerprint(['a', 'c']);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('roadmap fingerprint ignores reworded text (status theater)', () => {
    const base = fingerprintRoadmap([
      { id: 'r1', status: 'pending', verdict: { state: 'failing', receipt: 'red' }, text: 'do thing' },
    ]);
    const reworded = fingerprintRoadmap([
      {
        id: 'r1',
        status: 'pending',
        verdict: { state: 'failing', receipt: 'red' },
        text: 'still doing thing (reworded status)',
      },
    ]);
    assert.equal(base, reworded);
  });

  it('roadmap fingerprint changes on verdict or status', () => {
    const before = fingerprintRoadmap([{ id: 'r1', status: 'pending' }]);
    const afterVerdict = fingerprintRoadmap([
      { id: 'r1', status: 'pending', verdict: { state: 'passing', receipt: 'green' } },
    ]);
    const afterStatus = fingerprintRoadmap([{ id: 'r1', status: 'blocked' }]);
    assert.notEqual(before, afterVerdict);
    assert.notEqual(before, afterStatus);
  });
});

describe('classifyManagerCycleProgress', () => {
  it('prefers file/diff receipt when paths exist', () => {
    const obs = classifyManagerCycleProgress({
      changedPaths: ['src/a.ts'],
      verdictState: 'passing',
      verdictReceipt: 'ok',
    });
    assert.equal(obs.kind, 'file_diff_receipt');
  });

  it('classifies verdict write when a state is present', () => {
    const obs = classifyManagerCycleProgress({
      verdictState: 'passing',
      verdictReceipt: 'tests green',
      roadmapFingerprintBefore: 'before',
      roadmapFingerprintAfter: 'after',
    });
    assert.equal(obs.kind, 'verdict_write');
  });

  it('classifies blocker when item blocked or fix-it spawned', () => {
    assert.equal(
      classifyManagerCycleProgress({ blockedItemId: 'r1', fixItSpawned: false }).kind,
      'blocker_code_change',
    );
    assert.equal(
      classifyManagerCycleProgress({ fixItSpawned: true }).kind,
      'blocker_code_change',
    );
  });

  it('status_only when nothing durable changed', () => {
    const fp = fingerprintRoadmap([{ id: 'r1', status: 'pending' }]);
    const obs = classifyManagerCycleProgress({
      roadmapFingerprintBefore: fp,
      roadmapFingerprintAfter: fp,
    });
    assert.equal(obs.kind, 'status_only');
  });
});

describe('observeProgressCycle / shouldStopAutoContinue', () => {
  it('starts with empty streak and never stops immediately', () => {
    const s = createProgressInvariantState();
    assert.equal(s.continuationCount, 0);
    assert.equal(s.noProgressStreak, 0);
    assert.equal(s.lastMeaningfulProgressAt, null);
    assert.equal(shouldStopAutoContinue(s), false);
  });

  it('resets streak on new meaningful progress', () => {
    let s = createProgressInvariantState();
    let r = observeProgressCycle(s, { kind: 'status_only' }, { nowTick: 1, noProgressLimit: 3 });
    s = r.state;
    assert.equal(s.noProgressStreak, 1);
    r = observeProgressCycle(
      s,
      { kind: 'verdict_write', detail: 'pass-1' },
      { nowTick: 2, noProgressLimit: 3 },
    );
    s = r.state;
    assert.equal(s.noProgressStreak, 0);
    assert.equal(s.lastMeaningfulProgressAt, 2);
    assert.equal(r.decision.shouldStopAutoContinue, false);
  });

  it('identical meaningful fingerprint does not reset streak (stuck loop)', () => {
    let s = createProgressInvariantState();
    const same = { kind: 'verdict_write' as const, detail: 'same-receipt' };
    let r = observeProgressCycle(s, same, { nowTick: 1, noProgressLimit: 3 });
    s = r.state;
    assert.equal(s.noProgressStreak, 0);
    r = observeProgressCycle(s, same, { nowTick: 2, noProgressLimit: 3 });
    s = r.state;
    assert.equal(s.noProgressStreak, 1);
    r = observeProgressCycle(s, same, { nowTick: 3, noProgressLimit: 3 });
    s = r.state;
    assert.equal(s.noProgressStreak, 2);
    r = observeProgressCycle(s, same, { nowTick: 4, noProgressLimit: 3 });
    assert.equal(r.state.noProgressStreak, 3);
    assert.equal(r.decision.shouldStopAutoContinue, true);
    assert.equal(r.decision.code, 'no_meaningful_progress');
    assert.ok(r.decision.blocked !== null);
    assert.ok(r.decision.reason.includes('No meaningful progress'));
  });

  it('N heartbeats / status_only trips the stop gate with typed blocked reason', () => {
    let s = createProgressInvariantState();
    let decision = observeProgressCycle(s, { kind: 'heartbeat' }, { nowTick: 0 }).decision;
    for (let i = 0; i < DEFAULT_NO_PROGRESS_LIMIT; i++) {
      const r = observeProgressCycle(s, { kind: 'status_only', detail: `still active ${i}` }, {
        nowTick: i + 1,
        noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
      });
      s = r.state;
      decision = r.decision;
    }
    assert.equal(s.noProgressStreak, DEFAULT_NO_PROGRESS_LIMIT);
    assert.equal(decision.shouldStopAutoContinue, true);
    assert.equal(decision.code, 'no_meaningful_progress');
    assert.ok(decision.blocked);
    assert.ok(decision.blocked!.reason.length > 0);
    assert.ok(decision.blocked!.nextAction.length > 0);
    assert.ok(decision.blocked!.preservedWork.length > 0);
  });

  it('blockedRecordForNoProgress always returns a valid record', () => {
    const rec = blockedRecordForNoProgress({ noProgressStreak: 3, limit: 3, progressFingerprint: 'abc' });
    assert.ok(rec);
    assert.match(rec!.reason, /No meaningful progress/);
    assert.equal(rec!.code, 'verification_failed');
  });
});

/**
 * Production-path simulation: the same classify → observe sequence the manager
 * cycle in menu.ts uses after each to-do. Proves status theater auto-continue
 * stops, and real verdict/diff progress keeps going.
 */
describe('production-path: manager cycle auto-continue stop', () => {
  it('stops after N identical failing verdicts with no roadmap change', () => {
    const roadmap = [
      { id: 'r1', status: 'pending' as const, verdict: { state: 'failing', receipt: 'tests red' } },
    ];
    const fp = fingerprintRoadmap(roadmap);
    let inv = createProgressInvariantState();
    let stop = false;
    let reason = '';

    for (let turn = 1; turn <= 5; turn++) {
      const obs = classifyManagerCycleProgress({
        verdictState: 'failing',
        verdictReceipt: 'tests red',
        roadmapFingerprintBefore: fp,
        roadmapFingerprintAfter: fp,
      });
      // classify still yields verdict_write (receipt present) — but identical
      // fingerprint across cycles trips the stuck-loop rule in observe.
      const stepped = observeProgressCycle(inv, obs, {
        nowTick: turn,
        noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
      });
      inv = stepped.state;
      if (stepped.decision.shouldStopAutoContinue) {
        stop = true;
        reason = stepped.decision.reason;
        break;
      }
    }

    assert.equal(stop, true);
    assert.ok(reason.includes('No meaningful progress'));
    // First cycle establishes fingerprint (streak 0); next three identical → stop at 3.
    assert.ok(inv.continuationCount >= DEFAULT_NO_PROGRESS_LIMIT);
  });

  it('continues when each cycle advances with a new file_diff_receipt', () => {
    let inv = createProgressInvariantState();
    for (let turn = 1; turn <= 5; turn++) {
      const obs = classifyManagerCycleProgress({
        changedPaths: [`src/file-${String(turn)}.ts`],
        verdictState: 'passing',
        verdictReceipt: `green-${String(turn)}`,
      });
      assert.equal(obs.kind, 'file_diff_receipt');
      const stepped = observeProgressCycle(inv, obs, {
        nowTick: turn,
        noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
      });
      inv = stepped.state;
      assert.equal(stepped.decision.shouldStopAutoContinue, false);
    }
    assert.equal(inv.noProgressStreak, 0);
    assert.equal(inv.lastMeaningfulProgressAt, 5);
  });

  it('menu-shaped status_only streak (reworded UI) halts auto-continue', () => {
    let inv = createProgressInvariantState();
    const fp = fingerprintRoadmap([{ id: 'r1', status: 'pending' }]);
    let halted = false;
    for (let turn = 1; turn <= DEFAULT_NO_PROGRESS_LIMIT; turn++) {
      // No verdict, no paths, same roadmap → status_only (what heartbeats look like).
      const obs = classifyManagerCycleProgress({
        roadmapFingerprintBefore: fp,
        roadmapFingerprintAfter: fp,
      });
      assert.equal(obs.kind, 'status_only');
      const stepped = observeProgressCycle(inv, obs, {
        nowTick: turn,
        noProgressLimit: DEFAULT_NO_PROGRESS_LIMIT,
      });
      inv = stepped.state;
      if (stepped.decision.shouldStopAutoContinue) {
        halted = true;
        assert.equal(stepped.decision.code, 'no_meaningful_progress');
        break;
      }
    }
    assert.equal(halted, true);
  });
});
