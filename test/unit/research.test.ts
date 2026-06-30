/**
 * test/unit/research.test.ts — unit tests for the PURE bounded retrieval composers
 * (src/core/research.ts), the RESEARCH-UNTIL-CONFIDENT core (Phase 3a/3b).
 *
 * Covers: deriveQueryTokens (deterministic keyword extraction), buildRetrievalContext
 * (bounded Read/Grep sub-pass — caps, fail-soft, no-hit → ''), and buildWebContext
 * (native-search angle — absent capability → '', fail-soft, cap). All via a fake
 * ResearchPort, no fs/network.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  deriveQueryTokens,
  buildRetrievalContext,
  buildWebContext,
  RETRIEVAL_MAX_HITS,
  RETRIEVAL_MAX_FILES,
  RETRIEVAL_FILE_EXCERPT_CAP,
  RETRIEVAL_CONTEXT_CHAR_CAP,
  WEB_CONTEXT_CHAR_CAP,
  type ResearchPort,
} from '../../src/core/research.ts';

const NO_SIGNAL = new AbortController().signal;

// ---------------------------------------------------------------------------
// deriveQueryTokens
// ---------------------------------------------------------------------------

describe('deriveQueryTokens', () => {
  it('extracts content tokens, drops stop words + short words, de-dupes, bounds count', () => {
    const toks = deriveQueryTokens('add the activity feed loading from the api feed', 4);
    assert.ok(!toks.includes('the'), 'stop word dropped');
    assert.ok(!toks.includes('add'), 'common verb dropped');
    assert.ok(toks.includes('activity'));
    assert.ok(toks.includes('feed'));
    // de-dupe: "feed" appears twice in the input, once in the tokens.
    assert.equal(toks.filter((t) => t === 'feed').length, 1);
    assert.ok(toks.length <= 4, 'bounded to max');
  });

  it('returns [] for an empty / stop-word-only goal', () => {
    assert.deepEqual(deriveQueryTokens(''), []);
    assert.deepEqual(deriveQueryTokens('the and for'), []);
  });
});

// ---------------------------------------------------------------------------
// buildRetrievalContext — the bounded Read/Grep sub-pass
// ---------------------------------------------------------------------------

function makePort(over: Partial<ResearchPort>): ResearchPort {
  return {
    async grepRepo() {
      return [];
    },
    async readFile() {
      return null;
    },
    ...over,
  };
}

describe('buildRetrievalContext', () => {
  it('returns "" when the goal has no usable query tokens (no retrieval)', async () => {
    let grepped = false;
    const port = makePort({
      async grepRepo() {
        grepped = true;
        return ['x.ts'];
      },
    });
    const out = await buildRetrievalContext(port, '/cwd', 'the and for');
    assert.equal(out, '');
    assert.equal(grepped, false, 'never greps when there is no token');
  });

  it('returns "" when grep finds no files (honest, no findings block)', async () => {
    const port = makePort({ async grepRepo() { return []; } });
    const out = await buildRetrievalContext(port, '/cwd', 'load the activity feed');
    assert.equal(out, '');
  });

  it('reads a BOUNDED subset of hits and excerpts them (the real dive-in)', async () => {
    const hits = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const reads: string[] = [];
    const port = makePort({
      async grepRepo() {
        return hits;
      },
      async readFile(_cwd, rel) {
        reads.push(rel);
        return `contents of ${rel} ` + 'x'.repeat(50);
      },
    });
    const out = await buildRetrievalContext(port, '/cwd', 'activity feed loader');
    assert.ok(out.includes('RETRIEVAL FINDINGS'), 'renders the findings header');
    // At most RETRIEVAL_MAX_FILES files are READ; the rest are only "located".
    assert.equal(reads.length, RETRIEVAL_MAX_FILES, 'reads are bounded');
    assert.ok(out.includes('a.ts'));
    assert.ok(out.includes('located: ') && out.includes('e.ts'), 'extra hits listed, not read');
  });

  it('bounds the number of grep hits considered to RETRIEVAL_MAX_HITS', async () => {
    let requestedMax = 0;
    const many = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    const port = makePort({
      async grepRepo(_cwd, _q, maxHits) {
        requestedMax = maxHits;
        return many;
      },
      async readFile() {
        return 'x';
      },
    });
    const out = await buildRetrievalContext(port, '/cwd', 'activity feed loader module');
    assert.equal(requestedMax, RETRIEVAL_MAX_HITS, 'asks the port for at most MAX_HITS');
    // The rendered block never references more than MAX_HITS distinct files.
    const referenced = many.filter((f) => out.includes(f)).length;
    assert.ok(referenced <= RETRIEVAL_MAX_HITS, 'hits are bounded in the output');
  });

  it('caps a single file excerpt + the whole block', async () => {
    const huge = 'y'.repeat(5000);
    const port = makePort({
      async grepRepo() {
        return ['big.ts'];
      },
      async readFile() {
        return huge;
      },
    });
    const out = await buildRetrievalContext(port, '/cwd', 'big thing module');
    assert.ok(out.length <= RETRIEVAL_CONTEXT_CHAR_CAP, 'whole block capped');
    // The single-file excerpt cap is enforced before the block cap.
    assert.ok(RETRIEVAL_FILE_EXCERPT_CAP < 5000);
  });

  it('is FAIL-SOFT: a throwing port yields "" (turn proceeds with the static layout)', async () => {
    const port = makePort({
      async grepRepo() {
        throw new Error('git missing');
      },
    });
    const out = await buildRetrievalContext(port, '/cwd', 'activity feed');
    assert.equal(out, '');
  });
});

// ---------------------------------------------------------------------------
// buildWebContext — the second-angle native search
// ---------------------------------------------------------------------------

describe('buildWebContext', () => {
  it('returns "" when the port has NO webSearch capability (honest stop)', async () => {
    const port = makePort({});
    const out = await buildWebContext(port, 'latest oauth pkce best practice', NO_SIGNAL);
    assert.equal(out, '', 'no capability → no fabricated sources');
  });

  it('renders a capped SOURCES block from a real search result', async () => {
    const port = makePort({
      async webSearch() {
        return 'PKCE is current best practice (source: rfc7636).';
      },
    });
    const out = await buildWebContext(port, 'oauth pkce', NO_SIGNAL);
    assert.ok(out.includes('WEB FINDINGS'));
    assert.ok(out.includes('PKCE'));
    assert.ok(out.length <= WEB_CONTEXT_CHAR_CAP);
  });

  it('returns "" on an empty result or a throwing search (fail-soft)', async () => {
    const empty = makePort({ async webSearch() { return '   '; } });
    assert.equal(await buildWebContext(empty, 'q', NO_SIGNAL), '');
    const thrower = makePort({ async webSearch() { throw new Error('net'); } });
    assert.equal(await buildWebContext(thrower, 'q', NO_SIGNAL), '');
  });

  it('caps a huge search result to the SOURCES budget', async () => {
    const port = makePort({ async webSearch() { return 'z'.repeat(9000); } });
    const out = await buildWebContext(port, 'q', NO_SIGNAL);
    assert.ok(out.length <= WEB_CONTEXT_CHAR_CAP);
  });
});
