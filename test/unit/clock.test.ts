/**
 * Unit tests for src/infra/clock.ts
 * Run with: node --experimental-strip-types --test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { systemClock } from '../../src/infra/clock.ts';

// ---------------------------------------------------------------------------
// now()
// ---------------------------------------------------------------------------

describe('systemClock.now()', () => {
  it('returns a number', () => {
    const result = systemClock.now();
    assert.equal(typeof result, 'number');
  });

  it('returns a plausible epoch millisecond timestamp', () => {
    const result = systemClock.now();
    // Must be after 2020-01-01 and before 2100-01-01
    assert.ok(result > 1_577_836_800_000, 'timestamp is too far in the past');
    assert.ok(result < 4_102_444_800_000, 'timestamp is too far in the future');
  });
});

// ---------------------------------------------------------------------------
// isoNow()
// ---------------------------------------------------------------------------

describe('systemClock.isoNow()', () => {
  it('returns a string', () => {
    assert.equal(typeof systemClock.isoNow(), 'string');
  });

  it('parses to a valid Date', () => {
    const iso = systemClock.isoNow();
    const d = new Date(iso);
    assert.ok(!isNaN(d.getTime()), `"${iso}" did not parse to a valid Date`);
  });

  it('round-trips within one second of now()', () => {
    const before = systemClock.now();
    const iso = systemClock.isoNow();
    const after = systemClock.now();
    const ts = new Date(iso).getTime();
    assert.ok(ts >= before - 1, 'isoNow() is before now()');
    assert.ok(ts <= after + 1, 'isoNow() is after now()');
  });
});

// ---------------------------------------------------------------------------
// uuid()
// ---------------------------------------------------------------------------

describe('systemClock.uuid()', () => {
  it('returns a string', () => {
    assert.equal(typeof systemClock.uuid(), 'string');
  });

  it('returns distinct values across calls', () => {
    const ids = new Set([
      systemClock.uuid(),
      systemClock.uuid(),
      systemClock.uuid(),
      systemClock.uuid(),
      systemClock.uuid(),
    ]);
    assert.equal(ids.size, 5, 'expected 5 distinct UUIDs');
  });

  it('matches UUID v4 format', () => {
    const uuid = systemClock.uuid();
    // xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// random()
// ---------------------------------------------------------------------------

describe('systemClock.random()', () => {
  it('returns a number', () => {
    assert.equal(typeof systemClock.random(), 'number');
  });

  it('is in the range [0, 1)', () => {
    for (let i = 0; i < 50; i++) {
      const r = systemClock.random();
      assert.ok(r >= 0, `random() returned ${r} which is < 0`);
      assert.ok(r < 1, `random() returned ${r} which is >= 1`);
    }
  });
});
