import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';

import { createWatchdog } from '../../src/interface/ui/mount.tsx';
import type { WatchdogSnapshot, WatchdogOptions } from '../../src/interface/ui/mount.tsx';

vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: () => ({
    enable: () => {},
    disable: () => {},
    reset: () => {},
    max: 0,
    percentile: () => 0,
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

describe('createWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
});
