/**
 * test/unit/orchestrate-unify-preflight.test.ts — rank-7 S4 live wiring proof.
 *
 * THE LOAD-BEARING GUARD (DESIGN-RANK7 §G trap #1): the unified preflight is a
 * pure CONSOLIDATION, never an addition. It must only ever REMOVE the dedicated
 * route-classifier model call from a turn that was ALREADY going to make the
 * intent extraction call — it can never increase the per-turn model-call count.
 *
 * We prove this with a CALL-COUNT-PARITY assertion across turn classes, counting
 * the route-classifier invocations and the intent-extractor invocations:
 *
 *   class                         | gate OFF (today) | gate ON (unified)
 *   ------------------------------|------------------|------------------
 *   ambiguous + substantial       | router 1, intent 1   (TWO calls) | router 0, intent 1 (ONE)
 *   trivial (evidence/short)      | router 0, intent 0               | router 0, intent 0 (identical)
 *   evidence + substantial        | router 0, intent 1               | router 0, intent 1 (identical)
 *
 * Plus: the frame's routeTier/routePlan flow into the route decision on the
 * unified path, and risk stays the deterministic floor (never model-driven).
 *
 * All deps faked — no network, no fs, no child process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { classify } from '../../src/core/classify.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
  Classification,
  Tier,
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
    // Present so the brain's codebase round CAN run; irrelevant to call-count parity
    // since these turns answer immediately, but keeps the harness realistic.
    environmentContext: 'ENVIRONMENT: project=node, branch=main, feed.tsx, api/feed.ts',
    ...over,
  };
}

// ── Turn fixtures (DESIGN-RANK7 §0, empirically reproduced there) ────────────
//
// AMBIGUOUS + SUBSTANTIAL: no keyword tier evidence (router model would fire) AND
// multi-clause (intent gate fires) → the only class where TWO calls run today.
const AMBIGUOUS_SUBSTANTIAL = 'the dashboard feels off, and the numbers don\'t line up, then it just stalls';
// TRIVIAL: short + single-clause + has evidence ("what") → neither model fires.
const TRIVIAL = 'what is 2+2';

// Counting stubs.
function countingClassifier(over: { tier?: Tier; plan?: boolean } = {}): {
  fn: (task: string, signal: AbortSignal) => Promise<{ tier: Tier; plan: boolean; reason: string } | null>;
  calls: () => number;
} {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      return { tier: over.tier ?? 'ic', plan: over.plan ?? false, reason: 'stub' };
    },
    calls: () => calls,
  };
}
function countingExtractor(frame: IntentFrame): {
  fn: (task: string, signal: AbortSignal) => Promise<IntentExtraction>;
  calls: () => number;
} {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      return { frame, usage: FAKE_USAGE };
    },
    calls: () => calls,
  };
}

// A model frame that carries route hints — on the unified path these drive the
// route decision (tier RAISED to manager; routePlan true). source must be 'model'
// for the brain to treat the frame as a real extraction.
function hintedFrame(over: Partial<IntentFrame> = {}): IntentFrame {
  return {
    version: 1,
    goal: 'figure out why the dashboard numbers are wrong',
    kind: 'coding',
    confidence: 'high',
    source: 'model',
    routeTier: 'manager',
    routePlan: true,
    ...over,
  };
}

describe('orchestrate unified preflight — call-count parity (rank-7 S4)', () => {
  it('AFFECTED CLASS, gate OFF: today\'s TWO-call path (router 1 + intent 1)', async () => {
    const router = countingClassifier();
    const extractor = countingExtractor(hintedFrame());
    await collect(
      orchestrate(
        AMBIGUOUS_SUBSTANTIAL,
        baseDeps({ routeClassifier: router.fn, intentExtractor: extractor.fn /* unifyPreflight omitted = off */ }),
        new AbortController().signal,
      ),
    );
    assert.equal(router.calls(), 1, 'gate off: router model fires on ambiguous turn');
    assert.equal(extractor.calls(), 1, 'gate off: intent fires on substantial turn (first preflight extraction)');
  });

  it('AFFECTED CLASS, gate ON: unified ONE-call path (router 0 + intent 1) — never adds', async () => {
    const router = countingClassifier();
    const extractor = countingExtractor(hintedFrame());
    await collect(
      orchestrate(
        AMBIGUOUS_SUBSTANTIAL,
        baseDeps({ routeClassifier: router.fn, intentExtractor: extractor.fn, unifyPreflight: true }),
        new AbortController().signal,
      ),
    );
    // THE LOAD-BEARING ASSERTION: router SUPPRESSED, intent runs exactly once.
    assert.equal(router.calls(), 0, 'gate on: route-classifier model call is SUPPRESSED');
    assert.equal(extractor.calls(), 1, 'gate on: the ONE preflight extraction still runs (consolidation, not addition)');
  });

  it('AFFECTED CLASS: gate ON makes STRICTLY FEWER model calls than gate OFF', async () => {
    const offRouter = countingClassifier();
    const offExtractor = countingExtractor(hintedFrame());
    await collect(
      orchestrate(
        AMBIGUOUS_SUBSTANTIAL,
        baseDeps({ routeClassifier: offRouter.fn, intentExtractor: offExtractor.fn }),
        new AbortController().signal,
      ),
    );
    const onRouter = countingClassifier();
    const onExtractor = countingExtractor(hintedFrame());
    await collect(
      orchestrate(
        AMBIGUOUS_SUBSTANTIAL,
        baseDeps({ routeClassifier: onRouter.fn, intentExtractor: onExtractor.fn, unifyPreflight: true }),
        new AbortController().signal,
      ),
    );
    const offTotal = offRouter.calls() + offExtractor.calls();
    const onTotal = onRouter.calls() + onExtractor.calls();
    assert.equal(offTotal, 2, 'gate off: two preflight model calls');
    assert.equal(onTotal, 1, 'gate on: one preflight model call');
    assert.ok(onTotal < offTotal, 'unified path strictly reduces the preflight call count');
  });

  it('TRIVIAL turn: identical (zero) preflight calls with gate ON and OFF', async () => {
    for (const unify of [false, true]) {
      const router = countingClassifier();
      const extractor = countingExtractor(hintedFrame());
      await collect(
        orchestrate(
          TRIVIAL,
          baseDeps({
            routeClassifier: router.fn,
            intentExtractor: extractor.fn,
            ...(unify ? { unifyPreflight: true } : {}),
          }),
          new AbortController().signal,
        ),
      );
      assert.equal(router.calls(), 0, `trivial turn (unify=${unify}): no router call (has tier evidence)`);
      assert.equal(extractor.calls(), 0, `trivial turn (unify=${unify}): no intent call (gate skips)`);
    }
  });

  it('gate ON but NO extractor wired: predicate false → router runs exactly as today', async () => {
    const router = countingClassifier();
    await collect(
      orchestrate(
        AMBIGUOUS_SUBSTANTIAL,
        baseDeps({ routeClassifier: router.fn, unifyPreflight: true /* no intentExtractor */ }),
        new AbortController().signal,
      ),
    );
    assert.equal(router.calls(), 1, 'no extractor: unified path excluded, decideRoute runs as today');
  });
});

describe('orchestrate unified preflight — route decision flows from the frame hints', () => {
  it('the frame routeTier RAISES the tier; routePlan flows through; risk stays deterministic', async () => {
    const router = countingClassifier();
    const extractor = countingExtractor(hintedFrame({ routeTier: 'manager', routePlan: true }));
    const events = await collect(
      orchestrate(
        AMBIGUOUS_SUBSTANTIAL,
        baseDeps({ routeClassifier: router.fn, intentExtractor: extractor.fn, unifyPreflight: true }),
        new AbortController().signal,
      ),
    );
    const classified = events.find((e) => e.type === 'classified');
    assert.ok(classified !== undefined && classified.type === 'classified');
    const c: Classification = classified.classification;
    // The model hint raised the tier.
    assert.equal(c.tier, 'manager', 'frame routeTier flows into the route decision (raised)');
    // Risk is NEVER model-driven: it equals the deterministic floor for this task.
    const det = classify(AMBIGUOUS_SUBSTANTIAL);
    assert.equal(c.risk, det.risk, 'risk stays the deterministic floor (never model-driven)');
    assert.equal(router.calls(), 0, 'router still suppressed on the hint-flow path');
  });

  it('extraction failure on the unified path → deterministic route (fail-soft, no router retry)', async () => {
    const router = countingClassifier();
    let extractorCalls = 0;
    const throwingExtractor = async (): Promise<IntentExtraction> => {
      extractorCalls++;
      throw new Error('extractor exploded');
    };
    const events = await collect(
      orchestrate(
        AMBIGUOUS_SUBSTANTIAL,
        baseDeps({ routeClassifier: router.fn, intentExtractor: throwingExtractor, unifyPreflight: true }),
        new AbortController().signal,
      ),
    );
    const classified = events.find((e) => e.type === 'classified');
    assert.ok(classified !== undefined && classified.type === 'classified');
    const det = classify(AMBIGUOUS_SUBSTANTIAL);
    // No hints → combineRoute returns the pure deterministic decision (= decideRoute fallback).
    assert.equal(classified.classification.tier, det.tier, 'fail-soft: tier = deterministic floor');
    assert.equal(classified.classification.risk, det.risk, 'fail-soft: risk = deterministic floor');
    assert.equal(router.calls(), 0, 'fail-soft does NOT add a router retry (forbidden)');
    assert.equal(extractorCalls, 1, 'the single preflight extraction was attempted once');
  });
});
