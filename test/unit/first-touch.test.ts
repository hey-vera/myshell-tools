/**
 * test/unit/first-touch.test.ts — the pure "show this once, ever" seam
 * (whole-tool-finish-5.5.md §0.1, §1.2, §1.5).
 *
 * Each hint shows once then never again (driven by the per-user `seen` map);
 * upgraders / seasoned users whose `seen` map is full see nothing; `markSeen` is
 * immutable and preserves the rest of config.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  shouldShowFirstTouch,
  markSeen,
  hasSeenAll,
  FIRST_TOUCH_KEYS,
  FIRST_TOUCH_LINES,
} from '../../src/core/first-touch.ts';
import type { AppConfig, FirstTouchKey } from '../../src/infra/config.ts';

const BASE: AppConfig = { onboarded: true, setAsDefault: true };

describe('shouldShowFirstTouch', () => {
  it('is true when the key is absent (nothing shown yet)', () => {
    for (const key of FIRST_TOUCH_KEYS) {
      assert.equal(shouldShowFirstTouch(key, undefined), true, `${key} absent → show`);
      assert.equal(shouldShowFirstTouch(key, {}), true, `${key} empty map → show`);
    }
  });

  it('is false after the key is marked seen', () => {
    for (const key of FIRST_TOUCH_KEYS) {
      const cfg = markSeen(key, BASE);
      assert.equal(shouldShowFirstTouch(key, cfg.seen), false, `${key} seen → hide`);
    }
  });

  it('tolerates a garbage seen value (treats it as nothing shown)', () => {
    const garbage = { onboarded: true, setAsDefault: false, seen: null } as unknown as AppConfig;
    assert.equal(shouldShowFirstTouch('recap', garbage.seen), true);
  });

  it('only the marked key is suppressed — others still show', () => {
    const cfg = markSeen('recap', BASE);
    assert.equal(shouldShowFirstTouch('recap', cfg.seen), false);
    assert.equal(shouldShowFirstTouch('memorySave', cfg.seen), true);
    assert.equal(shouldShowFirstTouch('intentReflect', cfg.seen), true);
  });

  it('a hint shows once then never on the second occurrence (drive the gate)', () => {
    let cfg = BASE;
    const key: FirstTouchKey = 'panelWaiting';
    // First occurrence → shown.
    assert.equal(shouldShowFirstTouch(key, cfg.seen), true);
    cfg = markSeen(key, cfg); // the interface persists this after showing
    // Second occurrence → suppressed.
    assert.equal(shouldShowFirstTouch(key, cfg.seen), false);
    // And remains suppressed indefinitely.
    cfg = markSeen(key, cfg);
    assert.equal(shouldShowFirstTouch(key, cfg.seen), false);
  });
});

describe('markSeen', () => {
  it('is immutable — never mutates the input config or its seen map', () => {
    const seen = {};
    const cfg: AppConfig = { ...BASE, seen };
    const next = markSeen('recap', cfg);
    assert.notEqual(next, cfg, 'returns a new object');
    assert.notEqual(next.seen, seen, 'returns a new seen map');
    assert.deepEqual(seen, {}, 'original seen map untouched');
    assert.equal(cfg.seen?.recap, undefined, 'original config untouched');
  });

  it('preserves other seen keys and the rest of config', () => {
    const cfg: AppConfig = { ...BASE, mode: 'balanced', memory: true, seen: { recap: true } };
    const next = markSeen('memorySave', cfg);
    assert.equal(next.seen?.recap, true, 'prior key preserved');
    assert.equal(next.seen?.memorySave, true, 'new key set');
    assert.equal(next.mode, 'balanced', 'unrelated config preserved');
    assert.equal(next.memory, true);
    assert.equal(next.onboarded, true);
  });

  it('creates a seen map when one is absent', () => {
    const next = markSeen('apeEngage', BASE);
    assert.deepEqual(next.seen, { apeEngage: true });
  });
});

describe('hasSeenAll (upgraders / seasoned users see nothing)', () => {
  it('false when nothing seen', () => {
    assert.equal(hasSeenAll(undefined), false);
    assert.equal(hasSeenAll({}), false);
  });

  it('true once every key is marked seen — nothing more to show', () => {
    let cfg = BASE;
    for (const key of FIRST_TOUCH_KEYS) cfg = markSeen(key, cfg);
    assert.equal(hasSeenAll(cfg.seen), true);
    for (const key of FIRST_TOUCH_KEYS) {
      assert.equal(shouldShowFirstTouch(key, cfg.seen), false, `${key} hidden`);
    }
  });
});

describe('FIRST_TOUCH_LINES', () => {
  it('has one short, non-empty, ANSI-free line per key', () => {
    for (const key of FIRST_TOUCH_KEYS) {
      const line = FIRST_TOUCH_LINES[key];
      assert.ok(typeof line === 'string' && line.length > 0, `${key} has text`);
      assert.ok(!/\x1b\[/.test(line), `${key} line is ANSI-free (color applied at render)`);
      assert.ok(!line.includes('\n'), `${key} line is single-line`);
    }
  });

  it('the recap line mentions ※ and the memory line names /memory', () => {
    assert.ok(FIRST_TOUCH_LINES.recap.includes('※'));
    assert.ok(FIRST_TOUCH_LINES.memorySave.includes('/memory'));
  });
});
