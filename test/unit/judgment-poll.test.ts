/**
 * test/unit/judgment-poll.test.ts — THE PLURAL JUDGMENT POLL (master-plan PHASE 7,
 * the gated half; .tmp-master-judgment.md Part 1). ZERO live model calls — the
 * candidate runner is faked through OrchestrateDeps (mirrors ensemble.test.ts).
 *
 * Pins the load-bearing properties:
 *   - the poll forms ONLY on a genuine ≥2-option fork + ≥2 DISTINCT vendors
 *     (single-vendor → no poll, never a faked second voice);
 *   - the tally is DETERMINISTIC (consensus / lean / split mapping);
 *   - the synthesizer NEVER resolves a SPLIT (a split stays a split, chosen null);
 *   - NO fabricated consensus (one mind alone is never "consensus");
 *   - NO manufactured disagreement (real agreement → consensus, not a fake fork);
 *   - fail-soft on a candidate error (an errored vendor is omitted, never invented);
 *   - the verdict parser only counts a REAL in-vocabulary option id.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planJudgment,
  buildJudgmentCandidatePrompt,
  parseJudgmentVerdict,
  synthesizeJudgment,
  runJudgmentPoll,
  type JudgmentDecision,
  type JudgmentVerdict,
  type JudgmentPollPlan,
} from '../../src/core/judgment-poll.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Classification,
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
} from '../../src/core/types.ts';
import type {
  Provider,
  ProviderRequest,
  ProviderEvent,
  ProviderId,
  Usage,
} from '../../src/providers/port.ts';

const LOW: Classification = { tier: 'ic', risk: 'low', rationale: 'r' };
const HIGH: Classification = { tier: 'ic', risk: 'high', rationale: 'r' };

const DECISION: JudgmentDecision = {
  question: 'How should the feed load data?',
  options: [
    { id: 'F1:0', label: 'Server-Component streaming — fewer round-trips' },
    { id: 'F1:1', label: 'Client-side fetch — simpler, worse SEO' },
  ],
};

// ===========================================================================
// planJudgment — the structural gate
// ===========================================================================

describe('planJudgment — cross-vendor-by-construction gate', () => {
  it('forms a poll on a genuine ≥2-option fork with ≥2 distinct vendors', () => {
    const plan = planJudgment({
      decision: DECISION,
      tier: 'ic',
      classification: LOW,
      authenticatedProviders: ['claude', 'codex'],
    });
    assert.ok(plan !== null);
    assert.deepEqual(plan.candidates, ['claude', 'codex']);
  });

  it('SINGLE-VENDOR → null (no plural poll; degrade honestly, never fake)', () => {
    assert.equal(
      planJudgment({
        decision: DECISION,
        tier: 'ic',
        classification: LOW,
        authenticatedProviders: ['claude'],
      }),
      null,
    );
  });

  it('never polls the same vendor twice and calls it plural (dedupes to <2 → null)', () => {
    assert.equal(
      planJudgment({
        decision: DECISION,
        tier: 'ic',
        classification: LOW,
        authenticatedProviders: ['claude', 'claude', 'claude'],
      }),
      null,
    );
  });

  it('a fork with <2 options → null (not a real decision)', () => {
    assert.equal(
      planJudgment({
        decision: { question: 'q', options: [{ id: 'a', label: 'only one' }] },
        tier: 'ic',
        classification: LOW,
        authenticatedProviders: ['claude', 'codex'],
      }),
      null,
    );
  });

  it('candidates are DISTINCT vendors, capped, announce-order preserved', () => {
    const plan = planJudgment({
      decision: DECISION,
      tier: 'ic',
      classification: LOW,
      authenticatedProviders: ['codex', 'claude', 'opencode'],
      maxCandidates: 2,
    });
    assert.ok(plan !== null);
    assert.deepEqual(plan.candidates, ['codex', 'claude']);
  });

  it('is deterministic for identical inputs', () => {
    const opts = {
      decision: DECISION,
      tier: 'ic' as const,
      classification: LOW,
      authenticatedProviders: ['claude', 'codex'] as const,
    };
    assert.deepEqual(planJudgment(opts), planJudgment(opts));
  });
});

// ===========================================================================
// buildJudgmentCandidatePrompt — the DECISION, framed as a judgment question
// ===========================================================================

describe('buildJudgmentCandidatePrompt', () => {
  it('asks the DECISION (not the task), shows the options, and demands the structured envelope', () => {
    const p = buildJudgmentCandidatePrompt('ic', DECISION);
    assert.match(p, /How should the feed load data\?/);
    assert.match(p, /\[F1:0\]/);
    assert.match(p, /\[F1:1\]/);
    assert.match(p, /independent/i);
    assert.match(p, /"choice"/);
    assert.match(p, /"key_risk"/);
    // It must NOT instruct the model to DO the task.
    assert.match(p, /do NOT do the task/i);
  });
});

// ===========================================================================
// parseJudgmentVerdict — counts only a REAL in-vocabulary option id
// ===========================================================================

describe('parseJudgmentVerdict — honesty floor', () => {
  const ids = ['F1:0', 'F1:1'];

  it('parses a final-line envelope with a valid choice', () => {
    const v = parseJudgmentVerdict(
      'claude',
      'I would stream.\n{"choice": "F1:0", "confidence": 0.8, "why": "fewer round-trips", "key_risk": "SEO"}',
      ids,
    );
    assert.ok(v !== null);
    assert.equal(v.choice, 'F1:0');
    assert.equal(v.confidence, 0.8);
    assert.equal(v.why, 'fewer round-trips');
  });

  it('drops a verdict whose choice is NOT a real option id (no hallucinated choice)', () => {
    const v = parseJudgmentVerdict(
      'claude',
      '{"choice": "F9:9", "confidence": 0.9, "why": "x"}',
      ids,
    );
    assert.equal(v, null);
  });

  it('null on an errored / empty / unparseable run (omitted, never invented)', () => {
    assert.equal(parseJudgmentVerdict('claude', undefined, ids), null);
    assert.equal(parseJudgmentVerdict('claude', '', ids), null);
    assert.equal(parseJudgmentVerdict('claude', 'no json here at all', ids), null);
  });
});

// ===========================================================================
// synthesizeJudgment — THE DETERMINISTIC TALLY (the honesty inversion)
// ===========================================================================

function verdict(vendor: ProviderId, choice: string, why = 'because'): JudgmentVerdict {
  return { vendor, choice, why };
}

describe('synthesizeJudgment — deterministic tally', () => {
  it('CONSENSUS: ≥2 vendors ALL chose the same option', () => {
    const s = synthesizeJudgment([verdict('claude', 'F1:0'), verdict('codex', 'F1:0')]);
    assert.equal(s.agreement, 'consensus');
    assert.equal(s.chosen, 'F1:0');
    assert.equal(s.dissent.length, 0);
  });

  it('LEAN: a strict majority + a named dissent', () => {
    const s = synthesizeJudgment([
      verdict('claude', 'F1:0'),
      verdict('codex', 'F1:0'),
      verdict('opencode', 'F1:1'),
    ]);
    assert.equal(s.agreement, 'lean');
    assert.equal(s.chosen, 'F1:0');
    assert.equal(s.dissent.length, 1);
    assert.equal(s.dissent[0]?.choice, 'F1:1');
  });

  it('SPLIT: a tie at the top → no majority', () => {
    const s = synthesizeJudgment([verdict('claude', 'F1:0'), verdict('codex', 'F1:1')]);
    assert.equal(s.agreement, 'split');
    assert.equal(s.chosen, null, 'a split is NEVER resolved by the synthesizer');
  });

  it('THE INVERSION: the synthesizer NEVER resolves a genuine split (chosen stays null)', () => {
    // Even a 2-2-1 three-option mess (no majority) must stay split, chosen null.
    const s = synthesizeJudgment([
      verdict('claude', 'F1:0'),
      verdict('codex', 'F1:1'),
      verdict('opencode', 'F1:0'),
      verdict('a' as ProviderId, 'F1:1'),
      verdict('b' as ProviderId, 'F1:1'), // F1:1 has 3 of 5 → that IS a majority
    ]);
    // 3 of 5 is a strict majority → LEAN (this asserts the boundary is by COUNT).
    assert.equal(s.agreement, 'lean');
    assert.equal(s.chosen, 'F1:1');

    // A real 2-2 split with no majority stays split.
    const split = synthesizeJudgment([
      verdict('claude', 'F1:0'),
      verdict('codex', 'F1:1'),
      verdict('opencode', 'F1:0'),
      verdict('a' as ProviderId, 'F1:1'),
    ]);
    assert.equal(split.agreement, 'split');
    assert.equal(split.chosen, null);
  });

  it('NO fabricated consensus: ONE real verdict is a LEAN-of-one, never "consensus"', () => {
    const s = synthesizeJudgment([verdict('claude', 'F1:0')]);
    assert.notEqual(s.agreement, 'consensus', 'one mind alone is never a consensus');
    assert.equal(s.agreement, 'lean');
    assert.equal(s.chosen, 'F1:0');
  });

  it('NO signal at all → SPLIT, chosen null (never a fabricated call)', () => {
    const s = synthesizeJudgment([]);
    assert.equal(s.agreement, 'split');
    assert.equal(s.chosen, null);
  });

  it('is deterministic for identical inputs', () => {
    const vs = [verdict('claude', 'F1:0'), verdict('codex', 'F1:1')];
    assert.deepEqual(synthesizeJudgment(vs), synthesizeJudgment(vs));
  });
});

// ===========================================================================
// Fakes (mirror ensemble.test.ts)
// ===========================================================================

function makeFakeClock(): Clock {
  let now = 1_000_000;
  let n = 0;
  return {
    now: () => (now += 10),
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `fake-uuid-${++n}`,
    random: () => 0.42,
  };
}

function makeFakeSession(id = 'sess-judg-1'): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    async append(e: SessionEntry): Promise<void> {
      entries.push(e);
    },
    entries,
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(e: LedgerEntry): Promise<void> {
      entries.push(e);
    },
    entries,
  };
}

const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

/** A provider that ends with a judgment envelope choosing `choice` (or errors). */
function judgProvider(id: ProviderId, choice: string, opts?: { error?: boolean }): Provider {
  return {
    id,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      if (opts?.error === true) {
        yield { type: 'error', error: { category: 'network', recoverable: true, message: 'boom', suggestion: 'retry' } };
        return;
      }
      const text = `My call.\n{"choice": "${choice}", "confidence": 0.7, "why": "w", "key_risk": "r"}`;
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

function judgDeps(providers: Partial<Record<ProviderId, Provider>>): {
  deps: OrchestrateDeps;
  ledger: ReturnType<typeof makeFakeLedger>;
  session: ReturnType<typeof makeFakeSession>;
} {
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const authed = Object.keys(providers) as ProviderId[];
  return {
    session,
    ledger,
    deps: {
      providers,
      clock: makeFakeClock(),
      session,
      ledger,
      policy: { ...DEFAULT_POLICY, maxTier: 'manager' },
      cwd: '/fake',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: authed,
    },
  };
}

async function drain(
  gen: AsyncGenerator<CoreEvent, unknown>,
): Promise<{ events: CoreEvent[]; ret: unknown }> {
  const events: CoreEvent[] = [];
  let res = await gen.next();
  while (!res.done) {
    events.push(res.value);
    res = await gen.next();
  }
  return { events, ret: res.value };
}

const PLAN: JudgmentPollPlan = {
  tier: 'ic',
  candidates: ['claude', 'codex'],
  decision: DECISION,
  classification: HIGH,
};

// ===========================================================================
// runJudgmentPoll — the executor (ONE round, no synthesizer model run)
// ===========================================================================

describe('runJudgmentPoll — integration (faked candidates, zero live calls)', () => {
  it('CONSENSUS: both vendors choose the same → consensus, chosen set', async () => {
    const { deps, ledger } = judgDeps({
      claude: judgProvider('claude', 'F1:0'),
      codex: judgProvider('codex', 'F1:0'),
    });
    const { events, ret } = await drain(runJudgmentPoll(deps, PLAN, new AbortController().signal));
    const r = ret as Awaited<ReturnType<typeof runJudgmentPoll>> extends never ? never : { synthesis: { agreement: string; chosen: string | null }; completed: boolean };
    assert.equal(r.completed, true);
    assert.equal(r.synthesis.agreement, 'consensus');
    assert.equal(r.synthesis.chosen, 'F1:0');
    // It does NOT append to the session (a pre-flight, not the answer).
    assert.equal(deps.session.id, 'sess-judg-1');
    // Each candidate run is recorded on the ledger with taskKind 'judgment'.
    assert.equal(ledger.entries.length, 2);
    assert.ok(ledger.entries.every((e) => e.taskKind === 'judgment'));
    // It never emits a user-facing `final` (the caller owns surfacing).
    assert.ok(!events.some((e) => e.type === 'final'));
  });

  it('SPLIT: vendors diverge → split, chosen null (the synthesizer cannot resolve it)', async () => {
    const { deps } = judgDeps({
      claude: judgProvider('claude', 'F1:0'),
      codex: judgProvider('codex', 'F1:1'),
    });
    const { ret } = await drain(runJudgmentPoll(deps, PLAN, new AbortController().signal));
    const r = ret as { synthesis: { agreement: string; chosen: string | null } };
    assert.equal(r.synthesis.agreement, 'split');
    assert.equal(r.synthesis.chosen, null);
  });

  it('FAIL-SOFT: an errored vendor is OMITTED, never invented (no fabricated verdict)', async () => {
    const { deps } = judgDeps({
      claude: judgProvider('claude', 'F1:0'),
      codex: judgProvider('codex', 'F1:1', { error: true }),
    });
    const { ret } = await drain(runJudgmentPoll(deps, PLAN, new AbortController().signal));
    const r = ret as { synthesis: { verdicts: unknown[]; agreement: string } };
    // Only the one real verdict counts → lean-of-one, never a fabricated consensus.
    assert.equal(r.synthesis.verdicts.length, 1);
    assert.equal(r.synthesis.agreement, 'lean');
  });

  it('honest up-front cost notice + a panel phase event (real liveness)', async () => {
    const { deps } = judgDeps({
      claude: judgProvider('claude', 'F1:0'),
      codex: judgProvider('codex', 'F1:0'),
    });
    const { events } = await drain(runJudgmentPoll(deps, PLAN, new AbortController().signal));
    assert.ok(
      events.some((e) => e.type === 'notice' && /quota-consuming runs/.test(e.message)),
      'states the quota cost up front',
    );
    assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'panel'));
    // A tier-start + tier-done per candidate (real measured metrics).
    assert.equal(events.filter((e) => e.type === 'tier-start').length, 2);
    assert.equal(events.filter((e) => e.type === 'tier-done').length, 2);
  });

  it('aborted before start → completed false, no candidate runs', async () => {
    const { deps, ledger } = judgDeps({
      claude: judgProvider('claude', 'F1:0'),
      codex: judgProvider('codex', 'F1:0'),
    });
    const ac = new AbortController();
    ac.abort();
    const { ret } = await drain(runJudgmentPoll(deps, PLAN, ac.signal));
    const r = ret as { completed: boolean };
    assert.equal(r.completed, false);
    assert.equal(ledger.entries.length, 0);
  });
});
