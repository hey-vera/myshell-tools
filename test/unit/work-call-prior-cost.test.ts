/**
 * Unit tests for FIX 1 — runWorkCall's optional `priorCostUsd` seed.
 *
 * Contract: the terminal `final.totalCostUsd` is the HONEST sum across every metered
 * run this turn. When a judgment poll / rival tribunal ran BEFORE the work-call, its
 * measured spend is threaded in as `priorCostUsd` and the work-call loop SEEDS its
 * own counter from it (added exactly once → no double-counting). When the field is
 * ABSENT it must default to 0 so the loop behaves byte-for-byte as before.
 *
 * All dependencies are faked in-memory — no network, fs, or child processes.
 * Run with: node --import ./test/register.mjs --test test/unit/work-call-prior-cost.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkCall, type WorkCallInput } from '../../src/core/work-call.ts';
import { classify } from '../../src/core/classify.ts';
import { planEngagement, type EngagementSignals } from '../../src/core/engagement.ts';
import { compileTurnDirective } from '../../src/core/turn-directive.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, Usage } from '../../src/providers/port.ts';

// ---- Fakes ----------------------------------------------------------------

function makeFakeClock(): Clock {
  const now = 1_000_000;
  let n = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `fake-uuid-${++n}`,
    random: () => 0.42,
  };
}

function makeFakeSession(id = 'sess-1'): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    async append(e: SessionEntry) {
      entries.push(e);
    },
    entries,
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(e: LedgerEntry) {
      entries.push(e);
    },
    entries,
  };
}

const CONFIDENCE_ENVELOPE =
  '{"confidence": 0.9, "escalate": false, "reason": "done", "needs_review": false}';

// A fake provider that yields a clean, confident answer with a KNOWN, deterministic
// cost via done.costUsd (so the assertion never depends on a pricing table).
function makeFakeProvider(costUsd: number): Provider {
  const events: ProviderEvent[] = [
    { type: 'text', delta: 'The answer.\n' },
    { type: 'done', text: `The answer.\n${CONFIDENCE_ENVELOPE}`, usage: { inputTokens: 100, outputTokens: 50 }, costUsd, raw: {} },
  ];
  return {
    id: 'claude',
    async detect() {
      return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run() {
      for (const ev of events) yield ev;
    },
  };
}

async function collectEvents(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// Build a minimal-but-real WorkCallInput for a trivial, low-risk task that the loop
// answers in one accepted attempt. Reuses the REAL pure builders so the input shape
// matches production.
function makeInput(opts: { providerCostUsd: number; priorCostUsd?: number }): WorkCallInput {
  const task = 'explain what this function returns';
  const classification = classify(task);
  const signals: EngagementSignals = {
    classification,
    routePlan: false,
    engagementBias: 0,
    task,
  };
  const engagementPlan = planEngagement(signals);
  const directive = compileTurnDirective({ frame: undefined, plan: engagementPlan, signals });

  const deps: OrchestrateDeps = {
    providers: { claude: makeFakeProvider(opts.providerCostUsd) },
    clock: makeFakeClock(),
    session: makeFakeSession(),
    ledger: makeFakeLedger(),
    policy: { ...DEFAULT_POLICY, panelPolicy: 'off', hedgePolicy: 'off' },
    authenticatedProviders: ['claude'],
    cwd: '/fake/cwd',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
  };

  return {
    task,
    deps,
    signal: new AbortController().signal,
    classification,
    routePlan: false,
    directive,
    intentFrame: undefined,
    engagementPlan,
    goalTitle: '',
    workTrace: undefined,
    incomingWorkContract: undefined,
    available: ['claude'],
    mode: 'balanced',
    taskSignals: { risk: classification.risk, routePlan: false, taskKind: 'unknown' },
    capabilityContext: undefined,
    historyContext: undefined,
    wantsWebSearch: false,
    hasImageAttachment: false,
    startTier: classification.tier,
    ...(opts.priorCostUsd !== undefined ? { priorCostUsd: opts.priorCostUsd } : {}),
  };
}

function finalCost(events: CoreEvent[]): number {
  const final = events.find((e) => e.type === 'final');
  assert.ok(final !== undefined && final.type === 'final', 'a final event must be emitted');
  return final.totalCostUsd;
}

describe('FIX 1 — runWorkCall priorCostUsd seeds the honest total', () => {
  it('absent priorCostUsd → total is just the provider cost (byte-for-byte default)', async () => {
    const events = await collectEvents(runWorkCall(makeInput({ providerCostUsd: 0.07 })));
    assert.equal(finalCost(events), 0.07);
  });

  it('priorCostUsd is ADDED to the provider cost exactly once (no double-counting)', async () => {
    const events = await collectEvents(
      runWorkCall(makeInput({ providerCostUsd: 0.07, priorCostUsd: 0.12 })),
    );
    // 0.12 (poll/tribunal) + 0.07 (the work-call) — added exactly once.
    assert.ok(Math.abs(finalCost(events) - 0.19) < 1e-9, `expected 0.19, got ${finalCost(events)}`);
  });

  it('priorCostUsd of 0 is identical to omitting it', async () => {
    const withZero = await collectEvents(runWorkCall(makeInput({ providerCostUsd: 0.05, priorCostUsd: 0 })));
    const without = await collectEvents(runWorkCall(makeInput({ providerCostUsd: 0.05 })));
    assert.equal(finalCost(withZero), finalCost(without));
    assert.equal(finalCost(withZero), 0.05);
  });
});

// ---------------------------------------------------------------------------
// cacheWriteInputTokens in work-call ledger entries
// ---------------------------------------------------------------------------

function makeFakeLedgerSpy(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(e: LedgerEntry) {
      entries.push(e);
    },
    entries,
  };
}

function makeFakeProviderWithCache(cache?: Usage): Provider {
  const usage: Usage = {
    inputTokens: 100,
    outputTokens: 50,
    ...(cache !== undefined ? { ...cache } : {}),
  };
  const events: ProviderEvent[] = [
    { type: 'text', delta: 'The answer.\n' },
    { type: 'done', text: `The answer.\n${CONFIDENCE_ENVELOPE}`, usage, raw: {} },
  ];
  return {
    id: 'claude',
    async detect() {
      return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run() {
      for (const ev of events) yield ev;
    },
  };
}

describe('work-call cacheWriteInputTokens in ledger', () => {
  it('cacheAccountingV2 off omits cacheWriteInputTokens from work-call ledger entry', async () => {
    const ledger = makeFakeLedgerSpy();
    const deps: OrchestrateDeps = {
      providers: { claude: makeFakeProviderWithCache({ cachedInputTokens: 30, cacheWriteInputTokens: 20 }) },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger,
      policy: { ...DEFAULT_POLICY, panelPolicy: 'off', hedgePolicy: 'off' },
      authenticatedProviders: ['claude'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      // cacheAccountingV2 absent → off
    };
    const events = await collectEvents(
      runWorkCall({
        task: 'explain what this function returns',
        deps,
        signal: new AbortController().signal,
        classification: classify('explain what this function returns'),
        routePlan: false,
        directive: compileTurnDirective({
          frame: undefined,
          plan: planEngagement({ classification: classify('explain what this function returns'), task: 'explain' }),
          signals: { classification: classify('explain what this function returns'), task: 'explain' },
        }),
        intentFrame: undefined,
        engagementPlan: planEngagement({ classification: classify('explain what this function returns'), task: 'explain' }),
        goalTitle: '',
        workTrace: undefined,
        incomingWorkContract: undefined,
        available: ['claude'],
        mode: 'balanced',
        taskSignals: { risk: 'low', routePlan: false, taskKind: 'unknown' as import('../../src/core/model-capabilities.js').TaskKind },
        capabilityContext: undefined,
        historyContext: undefined,
        wantsWebSearch: false,
        hasImageAttachment: false,
        startTier: 'ic',
      }),
    );
    // At least one ledger entry was recorded
    assert.ok(ledger.entries.length > 0, 'expected at least one ledger entry');
    // Every entry must NOT have cacheWriteInputTokens
    for (const e of ledger.entries) {
      assert.ok(!('cacheWriteInputTokens' in e), 'cacheWriteInputTokens must be absent when flag off');
    }
    // The entry still has cachedInputTokens from the provider
    const mainEntry = ledger.entries.find((e) => e.tier === 'ic');
    assert.ok(mainEntry !== undefined, 'expected a main tier entry');
    assert.equal(mainEntry.cachedInputTokens, 30);
  });

  it('cacheAccountingV2 on records cacheWriteInputTokens from provider usage', async () => {
    const ledger = makeFakeLedgerSpy();
    const deps: OrchestrateDeps = {
      providers: { claude: makeFakeProviderWithCache({ cachedInputTokens: 30, cacheWriteInputTokens: 20 }) },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger,
      policy: { ...DEFAULT_POLICY, panelPolicy: 'off', hedgePolicy: 'off' },
      authenticatedProviders: ['claude'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      cacheAccountingV2: true,
    };
    const events = await collectEvents(
      runWorkCall({
        task: 'explain what this function returns',
        deps,
        signal: new AbortController().signal,
        classification: classify('explain what this function returns'),
        routePlan: false,
        directive: compileTurnDirective({
          frame: undefined,
          plan: planEngagement({ classification: classify('explain what this function returns'), task: 'explain' }),
          signals: { classification: classify('explain what this function returns'), task: 'explain' },
        }),
        intentFrame: undefined,
        engagementPlan: planEngagement({ classification: classify('explain what this function returns'), task: 'explain' }),
        goalTitle: '',
        workTrace: undefined,
        incomingWorkContract: undefined,
        available: ['claude'],
        mode: 'balanced',
        taskSignals: { risk: 'low', routePlan: false, taskKind: 'unknown' as import('../../src/core/model-capabilities.js').TaskKind },
        capabilityContext: undefined,
        historyContext: undefined,
        wantsWebSearch: false,
        hasImageAttachment: false,
        startTier: 'ic',
      }),
    );
    assert.ok(ledger.entries.length > 0, 'expected at least one ledger entry');
    const mainEntry = ledger.entries.find((e) => e.tier === 'ic');
    assert.ok(mainEntry !== undefined, 'expected a main tier entry');
    assert.equal(mainEntry.cacheWriteInputTokens, 20, 'cacheWriteInputTokens must be recorded when flag on');
  });

  describe('account aux stamping', () => {
    it('accountAux off omits stage and intentVersionId from work-call ledger entry', async () => {
      const clock = makeFakeClock();
      const ledger = makeFakeLedger();
      const session = makeFakeSession();

      const provider = makeFakeProvider(0.01);
      const deps: OrchestrateDeps = {
        clock,
        session,
        ledger,
        providers: { claude: provider },
        policy: { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } },
        cwd: '/tmp',
        sandbox: 'workspace-write',
        timeoutMs: 20_000,
      };
      const signal = new AbortController();

      const classification = classify('hello');
      const engSig: EngagementSignals = {
        depth: 'normal', planFirst: false, escalate: false, wantsReview: false, needsExternal: false,
        substantial: false, repoOriented: false, investigationDepth: 'none', bestEffort: false, memoryBias: 0,
      };
      const directive = compileTurnDirective('hello', classification, 'balanced', undefined, false, 'direct');
      const engagementPlan = planEngagement(engSig);

      const gen = runWorkCall({
        task: 'hello',
        deps,
        signal: signal.signal,
        classification,
        routePlan: false,
        directive,
        intentFrame: undefined,
        engagementPlan,
        goalTitle: 'test',
        workTrace: undefined,
        incomingWorkContract: undefined,
        available: ['claude'],
        mode: 'balanced',
        taskSignals: { risk: 'low', routePlan: false, taskKind: 'unknown' as any },
        capabilityContext: undefined,
        historyContext: undefined,
        wantsWebSearch: false,
        hasImageAttachment: false,
        startTier: 'worker',
      });
      const events: any[] = [];
      for await (const ev of gen) events.push(ev);

      const workEntries = ledger.entries.filter((e) => e.tier === 'worker');
      assert.ok(workEntries.length >= 1, 'expected work ledger entry');
      for (const e of workEntries) {
        assert.equal(e.stage, undefined, 'stage must be absent when accountAux is off');
        assert.equal(e.intentVersionId, undefined, 'intentVersionId must be absent when accountAux is off');
      }
    });

    it('accountAux on stamps work stage and intentVersionId on work-call ledger entry', async () => {
      const clock = makeFakeClock();
      const ledger = makeFakeLedger();
      const session = makeFakeSession();

      const provider = makeFakeProvider(0.01);
      const deps: OrchestrateDeps = {
        clock,
        session,
        ledger,
        providers: { claude: provider },
        policy: { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } },
        cwd: '/tmp',
        sandbox: 'workspace-write',
        timeoutMs: 20_000,
        accountAux: true,
        intentVersionId: 'turn-ver-1',
      };
      const signal = new AbortController();

      const classification = classify('build this');
      const engSig: EngagementSignals = {
        depth: 'normal', planFirst: false, escalate: false, wantsReview: false, needsExternal: false,
        substantial: false, repoOriented: false, investigationDepth: 'none', bestEffort: false, memoryBias: 0,
      };
      const directive = compileTurnDirective('build this', classification, 'balanced', undefined, false, 'direct');
      const engagementPlan = planEngagement(engSig);

      const gen = runWorkCall({
        task: 'build this',
        deps,
        signal: signal.signal,
        classification,
        routePlan: false,
        directive,
        intentFrame: undefined,
        engagementPlan,
        goalTitle: 'test',
        workTrace: undefined,
        incomingWorkContract: undefined,
        available: ['claude'],
        mode: 'balanced',
        taskSignals: { risk: 'low', routePlan: false, taskKind: 'implementation' as any },
        capabilityContext: undefined,
        historyContext: undefined,
        wantsWebSearch: false,
        hasImageAttachment: false,
        startTier: 'ic',
      });
      const events: any[] = [];
      for await (const ev of gen) events.push(ev);

      const workEntries = ledger.entries.filter((e) => e.tier === 'ic');
      assert.ok(workEntries.length >= 1, 'expected work ledger entry');
      for (const e of workEntries) {
        assert.equal(e.stage, 'work', 'work entry must have stage=work');
        assert.equal(e.intentVersionId, 'turn-ver-1', 'work entry must have intentVersionId');
      }
    });
  });
});
