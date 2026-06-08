/**
 * test/unit/orchestrate-brain.test.ts — the Adaptive Confidence Brain LOOP wired
 * into orchestrate (vision-brain Phase 1). Proves:
 *   - a low-confidence INVESTIGABLE turn triggers a codebase-scrape round
 *     (notice + tier-start/tier-done goal card), re-extracts intent, re-assesses;
 *   - trivial AND confident turns short-circuit: NO round, NO extra extractor call
 *     (the hard fast-path guard);
 *   - the MAX_ROUNDS bound + the no-improvement stop condition prevent spinning;
 *   - ESC mid-loop aborts with a cancel final;
 *   - the narration notice reflects a REAL scrape that actually happened.
 *
 * All deps faked — no network, no fs, no child process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { CODEBASE_NARRATION } from '../../src/core/brain.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
} from '../../src/core/types.ts';
import type { IntentFrame, IntentExtraction } from '../../src/core/intent.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';

function makeFakeClock(): Clock {
  const now = 1_000_000;
  let n = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `uuid-${++n}`,
    random: () => 0.42,
  } as Clock;
}
function makeFakeSession(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return { id: 'sess-1', async append(e) { entries.push(e); }, entries };
}
function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { async record(e) { entries.push(e); }, entries };
}

const ENVELOPE = '{"confidence": 0.88, "escalate": false, "reason": "done", "needs_review": false}';
const FAKE_USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

function fakeProvider(id: 'claude' | 'codex' = 'claude'): Provider & { runCount: number } {
  const p = {
    id,
    runCount: 0,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      p.runCount++;
      yield { type: 'done', text: `Done.\n${ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
    },
  };
  return p;
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function baseDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: { claude: fakeProvider('claude') },
    clock: makeFakeClock(),
    session: makeFakeSession(),
    ledger: makeFakeLedger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake/cwd',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    // A real, present repo map → repoPresentForScrape is true.
    environmentContext: 'ENVIRONMENT: project=node, branch=main, feed.tsx, api/feed.ts',
    ...over,
  };
}

// Multi-clause (commas + "and") so shouldExtractIntent runs the gate, and
// investigable (references the existing "feed"/"api" + a coding kind).
const INVESTIGABLE_TASK =
  'make the activity feed load real data from the api, add loading and empty states, and drop the fixture';

// ---------------------------------------------------------------------------
// The loop TRIGGERS a scrape round on a low-confidence investigable turn
// ---------------------------------------------------------------------------

describe('orchestrate brain loop — investigate round', () => {
  it('a low-confidence investigable turn runs a codebase-scrape round, re-extracts, then answers', async () => {
    let extractorCalls = 0;
    const lowFrame: IntentFrame = {
      version: 1,
      goal: 'load the activity feed from the api',
      kind: 'coding',
      confidence: 'low',
      source: 'model',
    };
    const highFrame: IntentFrame = {
      version: 1,
      goal: 'wire <Feed/> to fetchFeed() and add loading/empty states',
      kind: 'coding',
      confidence: 'high',
      source: 'model',
    };
    // First extraction = low (pre-scrape); the second (enriched) = high and carries
    // REAL measured usage (the IntentExtraction {frame, usage} shape) so the scrape
    // goal card can thread real tokens (Fix 4).
    const extractor = async (): Promise<IntentExtraction> => {
      extractorCalls++;
      return extractorCalls === 1
        ? lowFrame
        : { frame: highFrame, usage: FAKE_USAGE };
    };

    const provider = fakeProvider('claude');
    const events = await collect(
      orchestrate(
        INVESTIGABLE_TASK,
        baseDeps({ providers: { claude: provider }, intentExtractor: extractor }),
        new AbortController().signal,
      ),
    );

    assert.equal(extractorCalls, 2, 'one initial extraction + one re-extraction on the enriched context');

    // The round is NARRATED via a real notice (vision-brain §3).
    const narration = events.find((e) => e.type === 'notice' && e.message === CODEBASE_NARRATION);
    assert.ok(narration !== undefined, 'a codebase-scrape narration notice is emitted');

    // The round surfaces as a live goal card via tier-start (title) → tier-done.
    // HONESTY (Fix 3): the title says "Re-checking … against the project layout"
    // (a re-check of the static layout), NOT "Reading how X is built" (which would
    // imply a file read that Phase 1 does not do).
    const tierStart = events.find(
      (e) => e.type === 'tier-start' && typeof e.title === 'string' && e.title.startsWith('Re-checking'),
    );
    assert.ok(tierStart !== undefined, 'the round shows an honest goal card (Re-checking … layout)');
    assert.ok(
      !events.some((e) => e.type === 'tier-start' && typeof e.title === 'string' && e.title.startsWith('Reading how')),
      'never claims a file read that did not happen',
    );

    // The scrape goal card carries the REAL measured tokens from the re-extraction's
    // intent-extractor run (Fix 4) — not a hardcoded 0.
    const scrapeDone = events.find(
      (e) => e.type === 'tier-done' && e.tier === 'worker' && (e.inputTokens > 0 || e.outputTokens > 0),
    );
    assert.ok(
      scrapeDone !== undefined && scrapeDone.type === 'tier-done',
      'the scrape tier-done shows real tokens threaded from the extractor usage',
    );
    if (scrapeDone !== undefined && scrapeDone.type === 'tier-done') {
      assert.equal(scrapeDone.inputTokens, FAKE_USAGE.inputTokens);
      assert.equal(scrapeDone.outputTokens, FAKE_USAGE.outputTokens);
    }

    // After re-assessing to high confidence, the turn ANSWERS (the provider ran).
    assert.ok(provider.runCount >= 1, 'the work provider ran after the round raised confidence');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success === true);
    assert.equal(final.questions, undefined, 'a confident turn answers, it does not ask');
  });

  it('the enriched re-extraction is fed the real environment context (a real scrape)', async () => {
    const seenTasks: string[] = [];
    const lowFrame: IntentFrame = {
      version: 1, goal: 'load the feed', kind: 'coding', confidence: 'low', source: 'model',
    };
    const extractor = async (task: string): Promise<IntentFrame | null> => {
      seenTasks.push(task);
      return { ...lowFrame, confidence: seenTasks.length === 1 ? 'low' : 'high' };
    };
    await collect(
      orchestrate(INVESTIGABLE_TASK, baseDeps({ intentExtractor: extractor }), new AbortController().signal),
    );
    assert.equal(seenTasks.length, 2);
    assert.ok(
      seenTasks[1]!.includes('feed.tsx') || seenTasks[1]!.includes('ENVIRONMENT'),
      'the re-extraction task carries the REAL repo-map environment context',
    );
  });
});

// ---------------------------------------------------------------------------
// FAST PATH — trivial + confident turns short-circuit with NO round, NO extra call
// ---------------------------------------------------------------------------

describe('orchestrate brain loop — fast-path preservation', () => {
  it('a TRIVIAL turn fires NO round, NO narration, and never calls the extractor', async () => {
    let extractorCalls = 0;
    const extractor = async (): Promise<IntentFrame | null> => {
      extractorCalls++;
      return { version: 1, goal: 'x', confidence: 'low', source: 'model' };
    };
    const events = await collect(
      orchestrate('hi', baseDeps({ intentExtractor: extractor }), new AbortController().signal),
    );
    assert.equal(extractorCalls, 0, 'a trivial turn never calls the extractor (gate + fast path)');
    assert.ok(
      !events.some((e) => e.type === 'notice' && e.message === CODEBASE_NARRATION),
      'no scrape narration on a trivial turn',
    );
    assert.ok(
      !events.some((e) => e.type === 'tier-start' && typeof e.title === 'string' && e.title.startsWith('Re-checking')),
      'no scrape goal card on a trivial turn',
    );
  });

  it('a CONFIDENT (measured-high) substantial turn fires NO scrape round', async () => {
    let extractorCalls = 0;
    const extractor = async (): Promise<IntentFrame | null> => {
      extractorCalls++;
      return { version: 1, goal: 'load the feed', kind: 'coding', confidence: 'high', source: 'model' };
    };
    const events = await collect(
      orchestrate(INVESTIGABLE_TASK, baseDeps({ intentExtractor: extractor }), new AbortController().signal),
    );
    assert.equal(extractorCalls, 1, 'a confident turn extracts ONCE — no re-extraction round');
    assert.ok(
      !events.some((e) => e.type === 'notice' && e.message === CODEBASE_NARRATION),
      'no scrape narration when already confident',
    );
  });

  it('CALIBRATION #1 (the key fast-path proof): a model-measured MEDIUM investigable build turn fires ZERO scrape rounds + ZERO extra extractor calls', async () => {
    let extractorCalls = 0;
    // Measured MEDIUM — an ordinary actionable build turn. Must NOT trigger a
    // scrape: same latency/cost as before the brain (one extraction, no round).
    const extractor = async (): Promise<IntentFrame | null> => {
      extractorCalls++;
      return { version: 1, goal: 'load the feed', kind: 'coding', confidence: 'medium', source: 'model' };
    };
    const events = await collect(
      orchestrate(INVESTIGABLE_TASK, baseDeps({ intentExtractor: extractor }), new AbortController().signal),
    );
    assert.equal(extractorCalls, 1, 'medium confidence: ONE extraction, ZERO re-extraction round');
    assert.ok(
      !events.some((e) => e.type === 'notice' && e.message === CODEBASE_NARRATION),
      'no scrape narration on a medium-confidence build turn',
    );
    assert.ok(
      !events.some((e) => e.type === 'tier-start' && typeof e.title === 'string' && e.title.startsWith('Re-checking')),
      'no scrape goal card on a medium-confidence build turn',
    );
  });

  it('with NO repo map present, an investigable low-confidence turn does NOT scrape (honest)', async () => {
    let extractorCalls = 0;
    const extractor = async (): Promise<IntentFrame | null> => {
      extractorCalls++;
      return { version: 1, goal: 'load the feed', kind: 'coding', confidence: 'low', source: 'model' };
    };
    const events = await collect(
      orchestrate(
        INVESTIGABLE_TASK,
        baseDeps({ environmentContext: undefined, intentExtractor: extractor }),
        new AbortController().signal,
      ),
    );
    assert.equal(extractorCalls, 1, 'no repo map → no scrape → no re-extraction');
    assert.ok(!events.some((e) => e.type === 'notice' && e.message === CODEBASE_NARRATION));
  });
});

// ---------------------------------------------------------------------------
// BOUNDS — MAX_ROUNDS + no-improvement stop condition (no spinning)
// ---------------------------------------------------------------------------

describe('orchestrate brain loop — bounds', () => {
  it('a round that does NOT raise understanding stops the loop (no spinning) — exactly one scrape', async () => {
    let extractorCalls = 0;
    // Always low → the round never improves understanding → stop after one round.
    const extractor = async (): Promise<IntentFrame | null> => {
      extractorCalls++;
      return { version: 1, goal: 'load the feed', kind: 'coding', confidence: 'low', source: 'model' };
    };
    const events = await collect(
      orchestrate(INVESTIGABLE_TASK, baseDeps({ intentExtractor: extractor }), new AbortController().signal),
    );
    // Exactly one re-extraction (the single round); the no-improvement floor halts it.
    assert.equal(extractorCalls, 2, 'one initial + exactly one round — the no-improvement stop condition holds');
    const narrationCount = events.filter((e) => e.type === 'notice' && e.message === CODEBASE_NARRATION).length;
    assert.equal(narrationCount, 1, 'exactly one scrape round runs (no spinning)');
  });

  it('direct posture opts OUT of the deep-dive round (no scrape)', async () => {
    let extractorCalls = 0;
    const extractor = async (): Promise<IntentFrame | null> => {
      extractorCalls++;
      return { version: 1, goal: 'load the feed', kind: 'coding', confidence: 'low', source: 'model' };
    };
    await collect(
      orchestrate(
        INVESTIGABLE_TASK,
        baseDeps({ intentExtractor: extractor, partnerStyle: 'direct' }),
        new AbortController().signal,
      ),
    );
    assert.equal(extractorCalls, 1, 'direct posture: no deep-dive round');
  });
});

// ---------------------------------------------------------------------------
// ESC — abort mid-loop ends the turn with a cancel final
// ---------------------------------------------------------------------------

describe('orchestrate brain loop — ESC cancel', () => {
  it('an aborted signal mid-loop yields a cancel final and stops', async () => {
    const controller = new AbortController();
    controller.abort(); // aborted before the loop's first abort check
    const extractor = async (): Promise<IntentFrame | null> =>
      ({ version: 1, goal: 'load the feed', kind: 'coding', confidence: 'low', source: 'model' });
    const provider = fakeProvider('claude');
    const events = await collect(
      orchestrate(
        INVESTIGABLE_TASK,
        baseDeps({ providers: { claude: provider }, intentExtractor: extractor }),
        controller.signal,
      ),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, false);
    assert.equal(final.canceled, true, 'the loop saw signal.aborted and emitted a cancel final');
    assert.equal(provider.runCount, 0, 'no work provider ran on a cancelled turn');
  });

  it('ESC DURING the re-extraction cancels SAME-iteration with NO dangling done card (Fix 5)', async () => {
    // The scrape round STARTS (notice + tier-start fire), then ESC fires while the
    // extractor is awaiting. The loop must check signal.aborted AFTER the await,
    // BEFORE emitting tier-done — so the cancel arrives the same iteration and there
    // is no "done" scrape card.
    const controller = new AbortController();
    const lowFrame: IntentFrame = {
      version: 1, goal: 'load the feed', kind: 'coding', confidence: 'low', source: 'model',
    };
    let calls = 0;
    const extractor = async (): Promise<IntentFrame | null> => {
      calls++;
      if (calls >= 2) controller.abort(); // abort DURING the re-extraction round
      return lowFrame;
    };
    const provider = fakeProvider('claude');
    const events = await collect(
      orchestrate(
        INVESTIGABLE_TASK,
        baseDeps({ providers: { claude: provider }, intentExtractor: extractor }),
        controller.signal,
      ),
    );

    // The round was narrated + started (the scrape genuinely began)…
    assert.ok(
      events.some((e) => e.type === 'notice' && e.message === CODEBASE_NARRATION),
      'the scrape round started (narrated)',
    );
    assert.ok(
      events.some((e) => e.type === 'tier-start' && typeof e.title === 'string' && e.title.startsWith('Re-checking')),
      'the scrape goal card opened',
    );
    // …but NO tier-done scrape card was emitted (cancelled before it).
    assert.ok(
      !events.some((e) => e.type === 'tier-done' && e.tier === 'worker'),
      'no dangling "done" scrape card — cancel arrived before tier-done',
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.canceled === true);
    assert.equal(provider.runCount, 0, 'no work provider ran after a mid-scrape cancel');
  });
});
