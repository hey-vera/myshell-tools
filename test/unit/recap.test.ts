/**
 * test/unit/recap.test.ts — the PURE recap core (core/recap.ts): the prompt
 * builder, the parser, and the staleness/eligibility seams. No live model — these
 * are deterministic seams, exactly like intent.test.ts drives intent.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecapPrompt,
  buildRecapHistoryBlock,
  parseRecap,
  isRecapStale,
  recapEligible,
  RECAP_MIN_TURNS,
  RECAP_MAX_CHARS,
} from '../../src/core/recap.ts';
import type { RecapMetaView } from '../../src/core/recap.ts';
import type { SessionEntry } from '../../src/core/types.ts';

function entry(role: SessionEntry['role'], content: string): SessionEntry {
  return { timestamp: '2024-01-01T00:00:00.000Z', role, content };
}

const HISTORY: SessionEntry[] = [
  entry('user', 'Migrate the auth module to JWT'),
  entry('assistant', 'Edited 4 files; expiration tests still missing.'),
  entry('user', 'Next, write the token-expiry tests'),
];

// ---------------------------------------------------------------------------
// buildRecapPrompt / buildRecapHistoryBlock
// ---------------------------------------------------------------------------

describe('buildRecapPrompt', () => {
  it('returns "" for empty history (nothing to distill)', () => {
    assert.equal(buildRecapPrompt([]), '');
  });

  it('embeds the (compacted) transcript and the goal/state/next ask', () => {
    const p = buildRecapPrompt(HISTORY);
    assert.ok(p.length > 0);
    assert.ok(p.includes('Migrate the auth module to JWT'), 'transcript content is embedded');
    assert.ok(/goal/i.test(p) && /state/i.test(p) && /next/i.test(p), 'asks for goal/state/next');
    assert.ok(p.includes(String(RECAP_MAX_CHARS)), 'states the char budget');
    assert.ok(/only the recap/i.test(p), 'asks for ONLY the recap text');
  });

  it('buildRecapHistoryBlock is a deterministic truncation of history', () => {
    const block = buildRecapHistoryBlock(HISTORY);
    assert.ok(block.includes('Migrate the auth module to JWT'));
    assert.equal(buildRecapHistoryBlock([]), '');
  });
});

// ---------------------------------------------------------------------------
// parseRecap
// ---------------------------------------------------------------------------

describe('parseRecap', () => {
  it('returns null for undefined/null/empty/whitespace', () => {
    assert.equal(parseRecap(undefined), null);
    assert.equal(parseRecap(null), null);
    assert.equal(parseRecap(''), null);
    assert.equal(parseRecap('   \n  '), null);
  });

  it('returns null for a non-string', () => {
    assert.equal(parseRecap(123 as unknown as string), null);
  });

  it('trims and keeps a clean single-line recap', () => {
    assert.equal(parseRecap('  Migrating auth to JWT; next: expiry tests.  '), 'Migrating auth to JWT; next: expiry tests.');
  });

  it('strips a parroted leading marker/label', () => {
    assert.equal(parseRecap('※ recap: Migrating auth.'), 'Migrating auth.');
    assert.equal(parseRecap('recap — Migrating auth.'), 'Migrating auth.');
    assert.equal(parseRecap('- Migrating auth.'), 'Migrating auth.');
  });

  it('collapses internal newlines to single spaces (one clean note)', () => {
    assert.equal(parseRecap('Goal: ship it.\nState: 4 files.\nNext: tests.'), 'Goal: ship it. State: 4 files. Next: tests.');
  });

  it('caps to RECAP_MAX_CHARS with an ellipsis', () => {
    const long = 'x'.repeat(RECAP_MAX_CHARS + 50);
    const out = parseRecap(long);
    assert.ok(out !== null);
    assert.ok(out.length <= RECAP_MAX_CHARS, `capped to ${RECAP_MAX_CHARS}`);
    assert.ok(out.endsWith('…'));
  });
});

// ---------------------------------------------------------------------------
// recapEligible / isRecapStale
// ---------------------------------------------------------------------------

describe('recapEligible', () => {
  it('is false below the min-turn floor, true at/above it', () => {
    assert.equal(recapEligible(RECAP_MIN_TURNS - 1), false);
    assert.equal(recapEligible(RECAP_MIN_TURNS), true);
    assert.equal(recapEligible(RECAP_MIN_TURNS + 5), true);
  });
});

describe('isRecapStale', () => {
  it('is never stale below the min-turn floor (nothing to recap)', () => {
    const meta: RecapMetaView = { messageCount: RECAP_MIN_TURNS - 1 };
    assert.equal(isRecapStale(meta), false);
  });

  it('is stale when eligible but no recap cached yet', () => {
    const meta: RecapMetaView = { messageCount: 5 };
    assert.equal(isRecapStale(meta), true);
  });

  it('is stale when a recap exists but provenance (recapMessageCount) is missing', () => {
    const meta: RecapMetaView = { messageCount: 5, recap: 'where we were' };
    assert.equal(isRecapStale(meta), true);
  });

  it('is fresh when the cache advanced by < threshold turns', () => {
    const meta: RecapMetaView = { messageCount: 6, recap: 'x', recapMessageCount: 5 };
    assert.equal(isRecapStale(meta, 3), false);
  });

  it('is stale when the cache advanced by >= threshold turns', () => {
    const meta: RecapMetaView = { messageCount: 8, recap: 'x', recapMessageCount: 5 };
    assert.equal(isRecapStale(meta, 3), true);
  });

  it('treats an empty/whitespace cached recap as no cache (stale)', () => {
    const meta: RecapMetaView = { messageCount: 6, recap: '   ', recapMessageCount: 6 };
    assert.equal(isRecapStale(meta), true);
  });
});
