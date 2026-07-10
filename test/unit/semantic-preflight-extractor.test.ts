import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { makeSemanticPreflightExtractor } from '../../src/core/semantic-preflight-extractor.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { createTurnCallBudget } from '../../src/core/turn-call-budget.ts';
import type { TurnCallBudget, TurnCallBudgetMode, TurnCallBudgetSpec } from '../../src/core/turn-call-budget.ts';
import type { Provider, ProviderEvent, ProviderId, ProviderRequest, Usage } from '../../src/providers/port.ts';
import type { ProviderStatus } from '../../src/providers/detect.ts';

const USAGE: Usage = {
  inputTokens: 11,
  outputTokens: 7,
  cachedInputTokens: 3,
  cacheWriteInputTokens: 2,
};

function validSemantic(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    objective: 'Fix flaky login test',
    taskShape: { kind: 'change', scope: 'single-step', mutatesWorkspace: true },
    route: { tier: 'ic', plan: false, rationale: 'Small code change with test impact' },
    risk: { level: 'medium', reasons: ['Touches auth test behavior'] },
    uncertainty: { level: 'low', reasons: [], forks: [] },
    evidenceNeeded: [
      {
        id: 'E1',
        kind: 'local-code',
        phase: 'before-execution',
        query: 'Inspect login test',
        required: true,
      },
    ],
    doneCondition: { status: 'specified', text: 'Login test passes reliably' },
    planSteps: [{ text: 'Inspect failing test' }],
    proposedExecution: {
      provider: 'claude',
      effort: 'medium',
      rationale: 'Balanced effort for a contained code change',
    },
    ...overrides,
  });
}

function budgetSpec(
  overrides: Partial<{
    turnId: string;
    mode: TurnCallBudgetMode;
    totalUnits: number;
  }> = {},
): TurnCallBudgetSpec {
  return {
    turnId: overrides.turnId ?? 'turn-semantic',
    mode: overrides.mode ?? 'observe',
    totalUnits: overrides.totalUnits ?? 10,
    reserved: { work: 1, failover: 0, verification: 0 },
  };
}

type ProviderBehavior = (
  request: ProviderRequest,
  signal: AbortSignal,
) => AsyncIterable<ProviderEvent>;

class FakeProvider implements Provider {
  public readonly id: ProviderId;
  public readonly requests: ProviderRequest[] = [];
  public runCount = 0;

  private readonly behavior: ProviderBehavior;

  constructor(id: ProviderId, behavior: ProviderBehavior) {
    this.id = id;
    this.behavior = behavior;
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: `/fake/${this.id}`,
      availableModels: [],
    };
  }

  run(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.runCount++;
    this.requests.push(request);
    return this.behavior(request, signal);
  }
}

function providerFromEvents(
  id: ProviderId,
  events: readonly ProviderEvent[],
): FakeProvider {
  return new FakeProvider(id, async function* eventStream() {
    for (const event of events) yield event;
  });
}

function throwingProvider(id: ProviderId): FakeProvider {
  return new FakeProvider(id, async function* thrownStream() {
    throw new Error('injected stream failure');
    yield { type: 'text', delta: 'unreachable' };
  });
}

function delayedProvider(id: ProviderId, delayMs: number): FakeProvider {
  return new FakeProvider(id, async function* delayedStream() {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield { type: 'done', text: validSemantic(), usage: USAGE, raw: {} };
  });
}

function makeExtractor(provider: FakeProvider, budget?: TurnCallBudget) {
  return makeSemanticPreflightExtractor({
    providers: { [provider.id]: provider },
    policy: DEFAULT_POLICY,
    cwd: '/tmp/project',
    timeoutMs: 20_000,
    availableModels: { [provider.id]: ['haiku'] },
    authenticatedProviders: [provider.id],
    ...(budget !== undefined ? { turnCallBudget: budget } : {}),
  });
}

function begunPurposes(budget: TurnCallBudget): string[] {
  return budget
    .snapshot()
    .events.filter((event) => event.type === 'call-begun')
    .map((event) => event.purpose);
}

function settledOutcomes(budget: TurnCallBudget): string[] {
  return budget
    .snapshot()
    .events.filter((event) => event.type === 'call-settled')
    .map((event) => event.outcome);
}

describe('makeSemanticPreflightExtractor', () => {
  it('valid provider reply returns full semantic result and one usage object', async () => {
    const provider = providerFromEvents('claude', [
      { type: 'done', text: validSemantic(), usage: USAGE, raw: {} },
    ]);
    const budget = createTurnCallBudget(budgetSpec());
    const extractor = makeExtractor(provider, budget);

    const result = await extractor('fix the flaky login test', new AbortController().signal);

    assert.ok(result !== null);
    assert.equal(result.result.objective, 'Fix flaky login test');
    assert.equal(result.result.taskShape.kind, 'change');
    assert.equal(result.result.proposedExecution.provider, 'claude');
    assert.deepEqual(result.usage, {
      inputTokens: 11,
      outputTokens: 7,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 2,
    });
    assert.equal(provider.runCount, 1);
    assert.equal(provider.requests[0]!.sandbox, 'read-only');
    assert.equal(provider.requests[0]!.timeoutMs, 8_000);
    assert.equal(budget.snapshot().begun, 1);
  });

  it('ledger records one intent and zero route or reextract purposes', async () => {
    const provider = providerFromEvents('claude', [
      { type: 'done', text: validSemantic(), raw: {} },
    ]);
    const budget = createTurnCallBudget(budgetSpec());
    const extractor = makeExtractor(provider, budget);

    await extractor('fix the flaky login test', new AbortController().signal);

    assert.deepEqual(begunPurposes(budget), ['intent']);
    assert.equal(begunPurposes(budget).filter((purpose) => purpose === 'route').length, 0);
    assert.equal(begunPurposes(budget).filter((purpose) => purpose === 'reextract-local').length, 0);
    assert.equal(begunPurposes(budget).filter((purpose) => purpose === 'reextract-web').length, 0);
    assert.equal(provider.runCount, 1);
  });

  it('construction without iteration consumes no ledger unit', () => {
    const provider = providerFromEvents('claude', [
      { type: 'done', text: validSemantic(), raw: {} },
    ]);
    const budget = createTurnCallBudget(budgetSpec());

    makeExtractor(provider, budget);

    assert.equal(budget.snapshot().begun, 0);
    assert.equal(provider.runCount, 0);
  });

  it('abort before first event settles one cancelled attempt', async () => {
    const provider = providerFromEvents('claude', [
      { type: 'done', text: validSemantic(), raw: {} },
    ]);
    const budget = createTurnCallBudget(budgetSpec());
    const extractor = makeExtractor(provider, budget);
    const ac = new AbortController();
    ac.abort();

    const result = await extractor('fix the flaky login test', ac.signal);

    assert.equal(result, null);
    assert.equal(provider.runCount, 0);
    assert.equal(budget.snapshot().begun, 1);
    assert.deepEqual(settledOutcomes(budget), ['cancelled']);
  });

  it('provider error malformed empty and timeout each return null after one attempt', async () => {
    const cases: ReadonlyArray<{ name: string; provider: FakeProvider; outcome: string }> = [
      {
        name: 'provider-error',
        provider: providerFromEvents('claude', [
          {
            type: 'error',
            error: {
              category: 'unknown',
              recoverable: false,
              message: 'bad',
              suggestion: 'none',
            },
          },
        ]),
        outcome: 'provider-error',
      },
      {
        name: 'malformed',
        provider: providerFromEvents('claude', [
          { type: 'done', text: 'not json', raw: {} },
        ]),
        outcome: 'succeeded',
      },
      {
        name: 'empty',
        provider: providerFromEvents('claude', []),
        outcome: 'empty',
      },
      {
        name: 'timeout',
        provider: providerFromEvents('claude', [
          {
            type: 'error',
            error: {
              category: 'timeout',
              recoverable: true,
              message: 'timed out',
              suggestion: 'retry later',
            },
          },
        ]),
        outcome: 'provider-error',
      },
    ];

    for (const c of cases) {
      const budget = createTurnCallBudget(budgetSpec({ turnId: `turn-${c.name}` }));
      const extractor = makeExtractor(c.provider, budget);

      const result = await extractor('fix the flaky login test', new AbortController().signal);

      assert.equal(result, null, c.name);
      assert.equal(c.provider.runCount, 1, c.name);
      assert.equal(budget.snapshot().begun, 1, c.name);
      assert.deepEqual(settledOutcomes(budget), [c.outcome], c.name);
    }
  });

  it('injected provider throw returns null and ledger settles threw once', async () => {
    const provider = throwingProvider('claude');
    const budget = createTurnCallBudget(budgetSpec());
    const extractor = makeExtractor(provider, budget);

    const result = await extractor('fix the flaky login test', new AbortController().signal);

    assert.equal(result, null);
    assert.equal(provider.runCount, 1);
    assert.equal(budget.snapshot().begun, 1);
    assert.deepEqual(settledOutcomes(budget), ['threw']);
  });

  it('unsupported proposed provider normalizes to auto without selecting it', async () => {
    const provider = providerFromEvents('claude', [
      {
        type: 'done',
        text: validSemantic({
          proposedExecution: {
            provider: 'gemini',
            effort: 'high',
            rationale: 'Unsupported provider proposal must not select execution',
          },
        }),
        raw: {},
      },
    ]);
    const extractor = makeExtractor(provider);

    const result = await extractor('fix the flaky login test', new AbortController().signal);

    assert.ok(result !== null);
    assert.equal(result.result.proposedExecution.provider, 'auto');
    assert.equal(provider.id, 'claude');
    assert.equal(provider.runCount, 1);
  });

  it('prompt contains every required schema field and only allowed provider effort values', async () => {
    const claude = providerFromEvents('claude', [
      { type: 'done', text: validSemantic(), raw: {} },
    ]);
    const codex = providerFromEvents('codex', [
      { type: 'done', text: validSemantic(), raw: {} },
    ]);
    const extractor = makeSemanticPreflightExtractor({
      providers: { claude, codex },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      availableModels: { claude: ['haiku'], codex: ['gpt-5.4-mini'] },
      authenticatedProviders: ['claude'],
    });

    await extractor('fix the flaky login test', new AbortController().signal);

    const prompt = claude.requests[0]!.prompt;
    for (const field of [
      'objective',
      'taskShape',
      'route',
      'risk',
      'uncertainty',
      'evidenceNeeded',
      'doneCondition',
      'planSteps',
      'proposedExecution',
    ]) {
      assert.ok(prompt.includes(field), `${field} missing`);
    }
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.ok(prompt.includes(effort), `${effort} missing`);
    }
    assert.ok(prompt.includes('- claude: none, low, medium, high, xhigh, max'));
    assert.ok(!prompt.includes('- codex:'), 'unauthenticated provider leaked into prompt');
    assert.ok(!prompt.toLowerCase().includes('credential'));
    assert.ok(!prompt.toLowerCase().includes('quota'));
    assert.equal(codex.runCount, 0);
  });

  it('delayed provider p95 wall time stays within hermetic baseline', async () => {
    // Injected delay is the signal under test. Lower bound proves we actually
    // wait on the provider; upper bound only guards pathological hangs — not
    // tight wall-clock perfection. Shared CI hosts (esp. macOS runners) often
    // schedule setTimeout well past delay+overhead, which made the old 60ms
    // ceiling flake (e.g. p95 76ms) while still proving the delay is honored.
    const DELAY_MS = 25;
    const P95_MIN_MS = DELAY_MS - 5;
    const P95_MAX_MS = DELAY_MS + 150;
    const durations: number[] = [];

    for (let i = 0; i < 5; i++) {
      const provider = delayedProvider('claude', DELAY_MS);
      const extractor = makeExtractor(provider);
      await extractor('fix the flaky login test', new AbortController().signal);
    }

    for (let i = 0; i < 30; i++) {
      const provider = delayedProvider('claude', DELAY_MS);
      const extractor = makeExtractor(provider);
      const start = performance.now();
      const result = await extractor('fix the flaky login test', new AbortController().signal);
      durations.push(performance.now() - start);
      assert.ok(result !== null);
      assert.equal(provider.runCount, 1);
    }

    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    assert.ok(
      p95 >= P95_MIN_MS && p95 <= P95_MAX_MS,
      `p95 ${p95.toFixed(2)}ms outside ${P95_MIN_MS}-${P95_MAX_MS}ms`,
    );
  });
});
