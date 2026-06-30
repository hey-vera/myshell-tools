/**
 * test/unit/recap.test.ts — the PURE recap core (core/recap.ts): the prompt
 * builder, the parser, and the staleness/eligibility seams. No live model — these
 * are deterministic seams, exactly like intent.test.ts drives intent.ts.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildRecapPrompt,
  buildRecapHistoryBlock,
  parseRecap,
  parseRecapResult,
  isRecapStale,
  recapEligible,
  RECAP_MIN_TURNS,
  RECAP_MAX_CHARS,
  RECAP_TITLE_MAX_CHARS,
} from '../../src/core/recap.ts';
import type { RecapMetaView } from '../../src/core/recap.ts';
import type { SessionEntry } from '../../src/core/types.ts';
import { isStubTitle } from '../../src/infra/conversations.ts';

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

  it('embeds the transcript, the persona/quality bar, and the TITLE+STATE contract', () => {
    const p = buildRecapPrompt(HISTORY);
    assert.ok(p.length > 0);
    assert.ok(p.includes('Migrate the auth module to JWT'), 'transcript content is embedded');
    // Reuses the product-vision / quality-bar persona so the smart model has the bar.
    assert.ok(
      /partner a sharp builder wishes they had/i.test(p),
      'leads with the reused ELITE_VOICE_PREAMBLE persona',
    );
    // Asks for the tagged TITLE + STATE two-part contract.
    assert.ok(/TITLE:/.test(p) && /STATE:/.test(p), 'asks for tagged TITLE + STATE');
    assert.ok(p.includes(String(RECAP_MAX_CHARS)), 'states the recap char budget');
    assert.ok(p.includes(String(RECAP_TITLE_MAX_CHARS)), 'states the title char budget');
  });

  it('forbids echoing the user phrasing / last message (the bug being fixed)', () => {
    const p = buildRecapPrompt(HISTORY);
    assert.ok(/never echo/i.test(p), 'tells the model never to echo');
    assert.ok(/objective/i.test(p), 'tells the model to name the objective');
    // No "we/this conversation/the user" preamble allowed in the title.
    assert.ok(/preamble/i.test(p), 'forbids a we/this-conversation preamble');
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
// parseRecapResult — the structured {title, recap} contract
// ---------------------------------------------------------------------------

describe('parseRecapResult', () => {
  it('splits a tagged TITLE / STATE reply into a clean {title, recap}', () => {
    const out = parseRecapResult(
      'TITLE: heyvera — YouTube-scale video platform\nSTATE: Frontend skeleton is up; next: wire the upload pipeline to S3.',
    );
    assert.ok(out !== null);
    assert.equal(out.title, 'Heyvera — YouTube-scale video platform');
    assert.equal(out.recap, 'Frontend skeleton is up; next: wire the upload pipeline to S3.');
  });

  it('strips a "we/this conversation" preamble + quotes + trailing punctuation from the title', () => {
    const out = parseRecapResult(
      'TITLE: "We are building the JWT auth migration."\nSTATE: 4 files edited; next: expiry tests.',
    );
    assert.ok(out !== null);
    assert.equal(out.title, 'Building the JWT auth migration');
  });

  it('bounds the title to RECAP_TITLE_MAX_CHARS on a word boundary', () => {
    const longTitle = 'word '.repeat(40).trim();
    const out = parseRecapResult(`TITLE: ${longTitle}\nSTATE: doing things; next: more things.`);
    assert.ok(out !== null);
    assert.ok(out.title !== null && out.title.length <= RECAP_TITLE_MAX_CHARS);
    assert.ok(!/\s$/.test(out.title ?? ''), 'no trailing partial word');
  });

  it('is fail-soft: an untagged reply still yields a recap (title null)', () => {
    const out = parseRecapResult('Migrating auth to JWT; next: expiry tests.');
    assert.ok(out !== null);
    assert.equal(out.title, null);
    assert.equal(out.recap, 'Migrating auth to JWT; next: expiry tests.');
  });

  it('yields a recap with title null when only STATE is tagged', () => {
    const out = parseRecapResult('STATE: Indexing the orders table; next: benchmark the query.');
    assert.ok(out !== null);
    assert.equal(out.title, null);
    assert.equal(out.recap, 'Indexing the orders table; next: benchmark the query.');
  });

  it('returns null when there is no usable recap (empty / whitespace / non-string)', () => {
    assert.equal(parseRecapResult(''), null);
    assert.equal(parseRecapResult('   \n  '), null);
    assert.equal(parseRecapResult(undefined), null);
    assert.equal(parseRecapResult(null), null);
    assert.equal(parseRecapResult(123 as unknown as string), null);
  });

  it('returns null (no recap) when a TITLE is given but STATE is blank/missing', () => {
    // Tagged title, no state body and nothing else salvageable → no recap.
    const out = parseRecapResult('TITLE: Some objective');
    assert.equal(out, null);
  });

  it('drops a title too short to be usable (keeps recap)', () => {
    const out = parseRecapResult('TITLE: ok\nSTATE: building the thing; next: ship it.');
    assert.ok(out !== null);
    assert.equal(out.title, null, 'a <3-char title is rejected');
    assert.equal(out.recap, 'building the thing; next: ship it.');
  });

  // The bug this fixes: the user types a rambling message, and the Recent card
  // shows it back verbatim as the title. Once the smart manager pass runs, the
  // model-produced TITLE must REPLACE that stub echo with a crisp objective.
  it('the smart title is NOT a raw echo of the first user message + wins over the stub', () => {
    const firstUserMessage =
      'so yea i think the frontend is a decent skeleton but the upload pipeline is nowhere near done and i want it youtube scale';
    // The provisional stub title is the raw first-words truncation (deriveTitle).
    const stubTitle = firstUserMessage.slice(0, 80);
    // The manager pass returns a professional objective, not the user's phrasing.
    const out = parseRecapResult(
      'TITLE: heyvera — YouTube-scale video platform\nSTATE: Frontend skeleton is up; next: build the upload pipeline.',
    );
    assert.ok(out !== null && out.title !== null);
    // The smart title does not echo the user's opening phrasing.
    assert.ok(
      !out.title.toLowerCase().includes('so yea i think'),
      'title is not a verbatim echo of the user message',
    );
    // The stub IS recognised as a stub (so the menu will replace it)…
    assert.equal(isStubTitle(stubTitle, firstUserMessage), true);
    // …and the model title differs from it, so resolveRecap renames to the model title.
    assert.notEqual(out.title, stubTitle.trim());
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
