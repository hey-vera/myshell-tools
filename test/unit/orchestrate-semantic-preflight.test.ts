import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { classify } from '../../src/core/classify.ts';
import { createTurnCallBudget } from '../../src/core/turn-call-budget.ts';
import { makeSemanticPreflightExtractor } from '../../src/core/semantic-preflight-extractor.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { SemanticPreflightV1 } from '../../src/core/semantic-preflight.ts';
import type { IntentExtraction } from '../../src/core/intent.ts';
import type { Provider, ProviderEvent, ProviderRequest, Usage } from '../../src/providers/port.ts';

const ENVELOPE = '{"confidence": 0.92, "escalate": false, "reason": "done", "needs_review": false}';
const USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

function fakeClock(): Clock {
  return {
    now: () => 1_000,
    isoNow: () => '2026-07-02T00:00:00.000Z',
    uuid: () => 'uuid-1',
    random: () => 0.5,
  };
}

function fakeSession(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return { id: 'sess-1', async append(e) { entries.push(e); }, entries };
}

function fakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { async record(e) { entries.push(e); }, entries };
}

function semantic(over: Partial<SemanticPreflightV1> = {}): SemanticPreflightV1 {
  return {
    version: 1,
    objective: 'complete the requested work',
    taskShape: { kind: 'change', scope: 'single-step', mutatesWorkspace: true },
    route: { tier: 'ic', plan: false, rationale: 'semantic route' },
    risk: { level: 'low', reasons: [] },
    uncertainty: { level: 'low', reasons: [], forks: [] },
    evidenceNeeded: [],
    doneCondition: { status: 'specified', text: 'the requested work is complete' },
    planSteps: [],
    proposedExecution: { provider: 'auto', effort: 'none', rationale: 'auto' },
    source: 'model',
    ...over,
  };
}

function semanticJson(over: Partial<SemanticPreflightV1> = {}): string {
  const s = semantic(over);
  const { source: _source, ...json } = s;
  return JSON.stringify(json);
}

function providerWithPrompts(opts: {
  readonly semanticText?: string;
  readonly workText?: string;
} = {}): Provider & { prompts: string[]; runCount: number; workRuns: number } {
  const p = {
    id: 'claude' as const,
    prompts: [] as string[],
    runCount: 0,
    workRuns: 0,
    async detect() {
      return { id: 'claude' as const, installed: true, version: '1', authenticated: true, availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      p.runCount++;
      p.prompts.push(req.prompt);
      if (req.prompt.includes('semantic preflight extractor')) {
        yield { type: 'done', text: opts.semanticText ?? semanticJson(), usage: USAGE, raw: {} };
        return;
      }
      p.workRuns++;
      yield { type: 'done', text: opts.workText ?? `Done.\n${ENVELOPE}`, usage: USAGE, raw: {} };
    },
  };
  return p;
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function callPurposes(budget: ReturnType<typeof createTurnCallBudget>): string[] {
  return budget.snapshot().events
    .filter((e) => e.type === 'call-begun')
    .map((e) => e.purpose);
}

function baseDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: { claude: providerWithPrompts() },
    clock: fakeClock(),
    session: fakeSession(),
    ledger: fakeLedger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake/cwd',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    ...over,
  };
}

describe('orchestrate semantic preflight V1', () => {
  it('semantic gate off preserves exact legacy event sequence prompts and ledger purposes', async () => {
    const task = 'the dashboard feels off, and the numbers do not line up, then it stalls';
    const makeLegacy = () => {
      let routeCalls = 0;
      let intentCalls = 0;
      return {
        route: async () => {
          routeCalls++;
          return { tier: 'ic' as const, plan: true, reason: 'legacy route' };
        },
        intent: async (): Promise<IntentExtraction> => {
          intentCalls++;
          return {
            frame: {
              version: 1,
              goal: 'fix the dashboard numbers',
              kind: 'coding',
              confidence: 'high',
              source: 'model',
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        counts: () => ({ routeCalls, intentCalls }),
      };
    };
    const budgetA = createTurnCallBudget({
      turnId: 'off-a',
      mode: 'observe',
      totalUnits: 10,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const budgetB = createTurnCallBudget({
      turnId: 'off-b',
      mode: 'observe',
      totalUnits: 10,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const providerA = providerWithPrompts();
    const providerB = providerWithPrompts();
    const legacyA = makeLegacy();
    const legacyB = makeLegacy();

    const eventsA = await collect(orchestrate(
      task,
      baseDeps({
        providers: { claude: providerA },
        routeClassifier: legacyA.route,
        intentExtractor: legacyA.intent,
        turnCallBudget: budgetA,
      }),
      new AbortController().signal,
    ));
    const eventsB = await collect(orchestrate(
      task,
      baseDeps({
        providers: { claude: providerB },
        routeClassifier: legacyB.route,
        intentExtractor: legacyB.intent,
        semanticPreflightExtractor: async () => {
          throw new Error('semantic extractor must be dark when gate is off');
        },
        semanticPreflightV1: false,
        turnCallBudget: budgetB,
      }),
      new AbortController().signal,
    ));

    assert.deepEqual(eventsB, eventsA);
    assert.deepEqual(providerB.prompts, providerA.prompts);
    assert.deepEqual(callPurposes(budgetB), callPurposes(budgetA));
    assert.deepEqual(legacyB.counts(), legacyA.counts());
  });

  it('nontrivial turn has one intent purpose and zero route or reextract purposes', async () => {
    const budget = createTurnCallBudget({
      turnId: 'semantic-nontrivial',
      mode: 'observe',
      totalUnits: 10,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const provider = providerWithPrompts({ semanticText: semanticJson() });
    const extractor = makeSemanticPreflightExtractor({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      timeoutMs: 8_000,
      turnCallBudget: budget,
    });

    await collect(orchestrate(
      'fix the dashboard totals carefully',
      baseDeps({
        providers: { claude: provider },
        semanticPreflightV1: true,
        semanticPreflightExtractor: extractor,
        routeClassifier: async () => {
          throw new Error('legacy route must not run');
        },
        intentExtractor: async () => {
          throw new Error('legacy intent must not run');
        },
        turnCallBudget: budget,
      }),
      new AbortController().signal,
    ));

    const purposes = callPurposes(budget);
    assert.equal(purposes.filter((p) => p === 'intent').length, 1);
    assert.equal(purposes.includes('route'), false);
    assert.equal(purposes.includes('reextract-local'), false);
    assert.equal(purposes.includes('reextract-web'), false);
  });

  it('binds semantic doneCondition onto CompletionResult when completionResultV1 is on', async () => {
    const provider = providerWithPrompts({
      semanticText: semanticJson({
        doneCondition: { status: 'specified', text: 'dashboard totals match fixtures' },
      }),
    });
    const extractor = makeSemanticPreflightExtractor({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      timeoutMs: 8_000,
    });
    const events = await collect(orchestrate(
      'fix the dashboard totals carefully',
      baseDeps({
        providers: { claude: provider },
        semanticPreflightV1: true,
        semanticPreflightExtractor: extractor,
        completionResultV1: true,
        routeClassifier: async () => {
          throw new Error('legacy route must not run');
        },
        intentExtractor: async () => {
          throw new Error('legacy intent must not run');
        },
      }),
      new AbortController().signal,
    ));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    // Preflight doneCondition is bound; settle still requires verify (done=check).
    assert.equal(final.completionResult?.doneCondition, 'dashboard totals match fixtures');
    assert.equal(final.completionResult?.goalSettlement.allowed, false);
  });

  it('trivial turn has zero preflight purposes and unchanged work call', async () => {
    const budget = createTurnCallBudget({
      turnId: 'semantic-trivial',
      mode: 'observe',
      totalUnits: 10,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const provider = providerWithPrompts();

    await collect(orchestrate(
      'thanks',
      baseDeps({
        providers: { claude: provider },
        semanticPreflightV1: true,
        semanticPreflightExtractor: async () => {
          throw new Error('trivial turn must bypass semantic extractor');
        },
        turnCallBudget: budget,
      }),
      new AbortController().signal,
    ));

    assert.deepEqual(callPurposes(budget), ['work']);
    assert.equal(provider.workRuns, 1);
  });

  it('review plan and fix each reach semantic extractor exactly once', async () => {
    for (const task of ['review this', 'plan this', 'fix this']) {
      let semanticCalls = 0;
      let legacyRouteCalls = 0;
      let legacyIntentCalls = 0;
      await collect(orchestrate(
        task,
        baseDeps({
          semanticPreflightV1: true,
          semanticPreflightExtractor: async () => {
            semanticCalls++;
            return { result: semantic() };
          },
          routeClassifier: async () => {
            legacyRouteCalls++;
            return null;
          },
          intentExtractor: async () => {
            legacyIntentCalls++;
            return { frame: null, usage: undefined };
          },
        }),
        new AbortController().signal,
      ));
      assert.equal(semanticCalls, 1, `${task}: semantic extractor`);
      assert.equal(legacyRouteCalls, 0, `${task}: no legacy route`);
      assert.equal(legacyIntentCalls, 0, `${task}: no legacy intent`);
    }
  });

  it('semantic tier lowers fix fixture but policy admission remains downstream', async () => {
    const events = await collect(orchestrate(
      'fix this',
      baseDeps({
        semanticPreflightV1: true,
        semanticPreflightExtractor: async () => ({
          result: semantic({ route: { tier: 'worker', plan: false, rationale: 'semantic lowered tier' } }),
        }),
      }),
      new AbortController().signal,
    ));
    const classified = events.find((e) => e.type === 'classified');
    assert.ok(classified !== undefined && classified.type === 'classified');
    assert.equal(classify('fix this').tier, 'ic');
    assert.equal(classified.classification.tier, 'worker');
  });

  it('semantic risk cannot lower deterministic critical', async () => {
    const task = 'erase secrets and credentials';
    const events = await collect(orchestrate(
      task,
      baseDeps({
        semanticPreflightV1: true,
        semanticPreflightExtractor: async () => ({
          result: semantic({
            route: { tier: 'worker', plan: false, rationale: 'semantic low' },
            risk: { level: 'low', reasons: [] },
          }),
        }),
      }),
      new AbortController().signal,
    ));
    const classified = events.find((e) => e.type === 'classified');
    assert.ok(classified !== undefined && classified.type === 'classified');
    assert.equal(classify(task).risk, 'critical');
    assert.equal(classified.classification.risk, 'critical');
  });

  it('semantic parse failure falls back after one attempt and never calls legacy closures', async () => {
    const budget = createTurnCallBudget({
      turnId: 'semantic-parse-fail',
      mode: 'observe',
      totalUnits: 10,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const provider = providerWithPrompts({ semanticText: 'not json' });
    const extractor = makeSemanticPreflightExtractor({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      timeoutMs: 8_000,
      turnCallBudget: budget,
    });
    let routeCalls = 0;
    let intentCalls = 0;

    const events = await collect(orchestrate(
      'fix the dashboard totals carefully',
      baseDeps({
        providers: { claude: provider },
        semanticPreflightV1: true,
        semanticPreflightExtractor: extractor,
        routeClassifier: async () => {
          routeCalls++;
          return null;
        },
        intentExtractor: async () => {
          intentCalls++;
          return { frame: null, usage: undefined };
        },
        turnCallBudget: budget,
      }),
      new AbortController().signal,
    ));

    const classified = events.find((e) => e.type === 'classified');
    assert.ok(classified !== undefined && classified.type === 'classified');
    assert.equal(classified.classification.tier, classify('fix the dashboard totals carefully').tier);
    assert.equal(routeCalls, 0);
    assert.equal(intentCalls, 0);
    assert.deepEqual(callPurposes(budget), ['intent', 'work']);
  });

  it('semantic extractor throw and abort produce no retry', async () => {
    const ac = new AbortController();
    const provider = providerWithPrompts();
    let semanticCalls = 0;
    let routeCalls = 0;
    let intentCalls = 0;

    const events = await collect(orchestrate(
      'fix the dashboard totals carefully',
      baseDeps({
        providers: { claude: provider },
        semanticPreflightV1: true,
        semanticPreflightExtractor: async () => {
          semanticCalls++;
          ac.abort();
          throw new Error('aborted semantic extractor');
        },
        routeClassifier: async () => {
          routeCalls++;
          return null;
        },
        intentExtractor: async () => {
          intentCalls++;
          return { frame: null, usage: undefined };
        },
      }),
      ac.signal,
    ));

    assert.equal(semanticCalls, 1);
    assert.equal(routeCalls, 0);
    assert.equal(intentCalls, 0);
    assert.equal(provider.workRuns, 0);
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.canceled, true);
  });

  it('same shipped observing budget reaches semantic and work calls', async () => {
    const budget = createTurnCallBudget({
      turnId: 'semantic-shared-budget',
      mode: 'observe',
      totalUnits: 10,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const provider = providerWithPrompts({ semanticText: semanticJson() });
    const extractor = makeSemanticPreflightExtractor({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      timeoutMs: 8_000,
      turnCallBudget: budget,
    });

    await collect(orchestrate(
      'fix the dashboard totals carefully',
      baseDeps({
        providers: { claude: provider },
        semanticPreflightV1: true,
        semanticPreflightExtractor: extractor,
        turnCallBudget: budget,
      }),
      new AbortController().signal,
    ));

    assert.deepEqual(callPurposes(budget), ['intent', 'work']);
  });
});
