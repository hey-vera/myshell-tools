import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';

import {
  createWatchdog,
  evaluateWatchdogSample,
  isBadWatchdogSample,
  isWatchdogTurnProgressAction,
  isWatchdogWatchedActive,
} from '../../src/interface/ui/mount.tsx';
import type { WatchdogSnapshot, WatchdogOptions } from '../../src/interface/ui/mount.tsx';

const histogramSample = vi.hoisted(() => ({ maxNs: 0, p99Ns: 0 }));

vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: () => ({
    enable: () => {},
    disable: () => {},
    reset: () => {},
    get max() { return histogramSample.maxNs; },
    percentile: () => histogramSample.p99Ns,
  }),
}));

function makeOpts(overrides: Partial<WatchdogOptions> = {}): WatchdogOptions & { snapshots: WatchdogSnapshot[] } {
  const snapshots: WatchdogSnapshot[] = [];
  return {
    samplerIntervalMs: 500,
    badSampleThresholdMs: 2_000,
    badSampleP99ThresholdMs: 750,
    consecutiveBadSamplesRequired: 3,
    staleWindowMs: 8_000,
    hardStallThresholdMs: 10_000,
    armCooldownMs: 0,
    isTty: true,
    now: () => Date.now(),
    recoveryRelaunch: false,
    onUnresponsive: (s) => { snapshots.push(s); },
    ...overrides,
    snapshots,
  };
}

describe('pure watchdog detection helpers', () => {
  it('isBadWatchdogSample flags drift / max / p99 thresholds', () => {
    assert.equal(
      isBadWatchdogSample({
        driftMs: 2_000,
        histMaxMs: 0,
        histP99Ms: 0,
        badSampleThresholdMs: 2_000,
        badSampleP99ThresholdMs: 750,
      }),
      true,
    );
    assert.equal(
      isBadWatchdogSample({
        driftMs: 0,
        histMaxMs: 2_000,
        histP99Ms: 0,
        badSampleThresholdMs: 2_000,
        badSampleP99ThresholdMs: 750,
      }),
      true,
    );
    assert.equal(
      isBadWatchdogSample({
        driftMs: 0,
        histMaxMs: 0,
        histP99Ms: 750,
        badSampleThresholdMs: 2_000,
        badSampleP99ThresholdMs: 750,
      }),
      true,
    );
    assert.equal(
      isBadWatchdogSample({
        driftMs: 100,
        histMaxMs: 20,
        histP99Ms: 20,
        badSampleThresholdMs: 2_000,
        badSampleP99ThresholdMs: 750,
      }),
      false,
    );
  });

  it('isWatchdogWatchedActive requires chat + recent input/turn activity', () => {
    assert.equal(
      isWatchdogWatchedActive({
        chatActive: false,
        sampleMs: 10_000,
        lastInputMs: 9_000,
        lastTurnActivityMs: 0,
      }),
      false,
    );
    assert.equal(
      isWatchdogWatchedActive({
        chatActive: true,
        sampleMs: 10_000,
        lastInputMs: 0,
        lastTurnActivityMs: 0,
      }),
      false,
    );
    assert.equal(
      isWatchdogWatchedActive({
        chatActive: true,
        sampleMs: 70_000,
        lastInputMs: 1_000,
        lastTurnActivityMs: 0,
      }),
      false,
      'activity older than 60s is not watched',
    );
    assert.equal(
      isWatchdogWatchedActive({
        chatActive: true,
        sampleMs: 10_000,
        lastInputMs: 9_500,
        lastTurnActivityMs: 0,
      }),
      true,
    );
    assert.equal(
      isWatchdogWatchedActive({
        chatActive: true,
        sampleMs: 90_000,
        lastInputMs: 0,
        lastTurnActivityMs: 50_000,
      }),
      true,
      'turn activity within window is enough',
    );
  });

  it('evaluateWatchdogSample: hard-stall on large drift while watched active', () => {
    const result = evaluateWatchdogSample({
      sampleMs: 20_000,
      driftMs: 12_000,
      histMaxMs: 0,
      histP99Ms: 0,
      consecutiveBadSamplesBefore: 0,
      armedAtMs: 0,
      recoveryRelaunch: false,
      hasUiCommit: true,
      suspended: false,
      chatActive: true,
      lastInputMs: 15_000,
      lastTurnActivityMs: 0,
      lastUiCommitMs: 19_000,
      badSampleThresholdMs: 2_000,
      badSampleP99ThresholdMs: 750,
      consecutiveBadSamplesRequired: 3,
      staleWindowMs: 8_000,
      hardStallThresholdMs: 10_000,
    });
    assert.equal(result.action, 'fire');
    if (result.action === 'fire') {
      assert.equal(result.reason, 'hard-stall');
      assert.equal(result.snapshot.reason, 'hard-stall');
      assert.equal(result.snapshot.lastSampleDriftMs, 12_000);
    }
  });

  it('evaluateWatchdogSample: active-stale after consecutive bad samples + quiet UI', () => {
    const result = evaluateWatchdogSample({
      sampleMs: 30_000,
      driftMs: 2_500,
      histMaxMs: 0,
      histP99Ms: 0,
      consecutiveBadSamplesBefore: 2, // this sample becomes 3
      armedAtMs: 0,
      recoveryRelaunch: false,
      hasUiCommit: true,
      suspended: false,
      chatActive: true,
      lastInputMs: 20_000,
      lastTurnActivityMs: 0,
      lastUiCommitMs: 20_000,
      badSampleThresholdMs: 2_000,
      badSampleP99ThresholdMs: 750,
      consecutiveBadSamplesRequired: 3,
      staleWindowMs: 8_000,
      hardStallThresholdMs: 10_000,
    });
    assert.equal(result.action, 'fire');
    if (result.action === 'fire') {
      assert.equal(result.reason, 'active-stale');
      assert.equal(result.consecutiveBadSamples, 3);
    }
  });

  it('evaluateWatchdogSample: does not fire when UI still committing', () => {
    const result = evaluateWatchdogSample({
      sampleMs: 30_000,
      driftMs: 2_500,
      histMaxMs: 0,
      histP99Ms: 0,
      consecutiveBadSamplesBefore: 5,
      armedAtMs: 0,
      recoveryRelaunch: false,
      hasUiCommit: true,
      suspended: false,
      chatActive: true,
      lastInputMs: 20_000,
      lastTurnActivityMs: 0,
      lastUiCommitMs: 29_500, // fresh commit
      badSampleThresholdMs: 2_000,
      badSampleP99ThresholdMs: 750,
      consecutiveBadSamplesRequired: 3,
      staleWindowMs: 8_000,
      hardStallThresholdMs: 10_000,
    });
    assert.equal(result.action, 'none');
    assert.equal(result.consecutiveBadSamples, 6);
  });

  it('evaluateWatchdogSample: does not fire during arm cooldown', () => {
    const result = evaluateWatchdogSample({
      sampleMs: 5_000,
      driftMs: 12_000,
      histMaxMs: 0,
      histP99Ms: 0,
      consecutiveBadSamplesBefore: 0,
      armedAtMs: 15_000,
      recoveryRelaunch: false,
      hasUiCommit: true,
      suspended: false,
      chatActive: true,
      lastInputMs: 4_000,
      lastTurnActivityMs: 0,
      lastUiCommitMs: 4_000,
      badSampleThresholdMs: 2_000,
      badSampleP99ThresholdMs: 750,
      consecutiveBadSamplesRequired: 3,
      staleWindowMs: 8_000,
      hardStallThresholdMs: 10_000,
    });
    assert.equal(result.action, 'none');
  });

  it('evaluateWatchdogSample: recoveryRelaunch waits for first UI commit', () => {
    const result = evaluateWatchdogSample({
      sampleMs: 20_000,
      driftMs: 12_000,
      histMaxMs: 0,
      histP99Ms: 0,
      consecutiveBadSamplesBefore: 0,
      armedAtMs: 0,
      recoveryRelaunch: true,
      hasUiCommit: false,
      suspended: false,
      chatActive: true,
      lastInputMs: 15_000,
      lastTurnActivityMs: 0,
      lastUiCommitMs: 0,
      badSampleThresholdMs: 2_000,
      badSampleP99ThresholdMs: 750,
      consecutiveBadSamplesRequired: 3,
      staleWindowMs: 8_000,
      hardStallThresholdMs: 10_000,
    });
    assert.equal(result.action, 'none');
  });

  it('evaluateWatchdogSample: good sample resets consecutive bad count', () => {
    const result = evaluateWatchdogSample({
      sampleMs: 20_000,
      driftMs: 10,
      histMaxMs: 5,
      histP99Ms: 5,
      consecutiveBadSamplesBefore: 4,
      armedAtMs: 0,
      recoveryRelaunch: false,
      hasUiCommit: true,
      suspended: false,
      chatActive: true,
      lastInputMs: 15_000,
      lastTurnActivityMs: 0,
      lastUiCommitMs: 19_000,
      badSampleThresholdMs: 2_000,
      badSampleP99ThresholdMs: 750,
      consecutiveBadSamplesRequired: 3,
      staleWindowMs: 8_000,
      hardStallThresholdMs: 10_000,
    });
    assert.equal(result.action, 'none');
    assert.equal(result.consecutiveBadSamples, 0);
  });

  it('isWatchdogTurnProgressAction covers stream/turn paths, not idle chrome', () => {
    assert.equal(isWatchdogTurnProgressAction('turn/start'), true);
    assert.equal(isWatchdogTurnProgressAction('stream/prose'), true);
    assert.equal(isWatchdogTurnProgressAction('tier-start'), true);
    assert.equal(isWatchdogTurnProgressAction('final'), true);
    assert.equal(isWatchdogTurnProgressAction('chrome/replace'), false);
    assert.equal(isWatchdogTurnProgressAction('capacity/sync'), false);
    assert.equal(isWatchdogTurnProgressAction('commit/raw'), false);
  });
});

describe('createWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    histogramSample.maxNs = 0;
    histogramSample.p99Ns = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns no-op heartbeat when isTty is false', () => {
    const opts = makeOpts({ isTty: false });
    const heartbeat = createWatchdog(opts);
    heartbeat.recordUiCommit();
    heartbeat.recordInput();
    heartbeat.recordTurnActivity();
    heartbeat.setChatActive(true);
    heartbeat.setSuspended(false);
    heartbeat.stop();
    assert.equal(opts.snapshots.length, 0);
  });

  it('does not fire during arm cooldown', () => {
    let nowMs = 0;
    const opts = makeOpts({
      armCooldownMs: 15_000,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();

    for (let i = 0; i < 40; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, 0);
  });

  it('does not fire when chat is not active', () => {
    let nowMs = 0;
    const opts = makeOpts({
      armCooldownMs: 0,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);

    for (let i = 0; i < 40; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, 0);
  });

  it('does not fire when suspended', () => {
    let nowMs = 0;
    const opts = makeOpts({
      armCooldownMs: 0,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();
    heartbeat.setSuspended(true);

    for (let i = 0; i < 40; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, 0);
  });

  it('does not fire when idle (no recent input or turn activity)', () => {
    let nowMs = 0;
    const opts = makeOpts({
      armCooldownMs: 0,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);

    for (let i = 0; i < 200; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, 0);
  });

  it('stops firing after stop()', () => {
    let nowMs = 0;
    const opts = makeOpts({
      armCooldownMs: 0,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();
    heartbeat.stop();

    for (let i = 0; i < 40; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    assert.equal(opts.snapshots.length, 0);
  });

  it('normalizes event-loop histogram nanoseconds before applying millisecond thresholds', () => {
    let nowMs = 1_000;
    const opts = makeOpts({ now: () => nowMs });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();
    histogramSample.maxNs = 20_000_000; // 20 ms, a normal sample
    histogramSample.p99Ns = 20_000_000;

    for (let i = 0; i < 20; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, 0);
  });

  it('treats a histogram p99 above the millisecond threshold as a bad sample', () => {
    let nowMs = 1_000;
    const opts = makeOpts({ now: () => nowMs });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();
    histogramSample.p99Ns = 800_000_000; // 800 ms

    for (let i = 0; i < 16; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, 1);
    assert.equal(opts.snapshots[0]!.reason, 'active-stale');
    assert.equal(opts.snapshots[0]!.lastHistogramP99Ms, 800);
  });

  it('fires only once (single-shot)', () => {
    let nowMs = 1_000;
    const opts = makeOpts({
      armCooldownMs: 0,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();

    for (let i = 0; i < 2; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    nowMs += 12_000;
    vi.advanceTimersByTime(500);

    assert.ok(opts.snapshots.length >= 1, `expected at least 1 snapshot, got ${opts.snapshots.length}`);
    assert.equal(opts.snapshots[0]!.reason, 'hard-stall');

    const countAfterFirst = opts.snapshots.length;
    for (let i = 0; i < 50; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, countAfterFirst);
  });

  it('recoveryRelaunch: does not fire when cooldown elapsed but no UI commit', () => {
    let nowMs = 1_000;
    const opts = makeOpts({
      armCooldownMs: 0,
      recoveryRelaunch: true,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();

    for (let i = 0; i < 2; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    nowMs += 12_000;
    vi.advanceTimersByTime(500);

    for (let i = 0; i < 10; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    heartbeat.stop();
    assert.equal(opts.snapshots.length, 0);
  });

  it('recoveryRelaunch: can fire when cooldown elapsed AND UI commit recorded', () => {
    let nowMs = 1_000;
    const opts = makeOpts({
      armCooldownMs: 0,
      recoveryRelaunch: true,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    heartbeat.recordInput();
    heartbeat.recordUiCommit();

    for (let i = 0; i < 2; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    nowMs += 12_000;
    vi.advanceTimersByTime(500);

    heartbeat.stop();
    assert.ok(opts.snapshots.length >= 1, `expected at least 1 snapshot, got ${opts.snapshots.length}`);
    assert.equal(opts.snapshots[0]!.reason, 'hard-stall');
  });

  it('turn activity alone (no input) can arm watched-active for hard-stall', () => {
    let nowMs = 1_000;
    const opts = makeOpts({
      armCooldownMs: 0,
      now: () => nowMs,
    });
    const heartbeat = createWatchdog(opts);
    heartbeat.setChatActive(true);
    // Simulate long-running turn heartbeats without composer input.
    heartbeat.recordTurnActivity();

    for (let i = 0; i < 2; i++) {
      nowMs += 500;
      vi.advanceTimersByTime(500);
    }

    nowMs += 12_000;
    vi.advanceTimersByTime(500);

    heartbeat.stop();
    assert.ok(opts.snapshots.length >= 1, `expected hard-stall from turn activity, got ${opts.snapshots.length}`);
    assert.equal(opts.snapshots[0]!.reason, 'hard-stall');
  });
});
