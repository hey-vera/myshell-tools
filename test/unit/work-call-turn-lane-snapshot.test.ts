/**
 * R2.1 integration: runWorkCall freezes inventory at dispatch and stamps ledger.
 *
 * Mid-turn mutation of deps.availableModels must not change the model used for
 * that turn's provider request. A second work-call with updated inventory may
 * adopt a new model. Ledger rows carry inventoryGeneration.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runWorkCall, type WorkCallInput } from '../../src/core/work-call.ts';
import { classify } from '../../src/core/classify.ts';
import { planEngagement, type EngagementSignals } from '../../src/core/engagement.ts';
import { compileTurnDirective } from '../../src/core/turn-directive.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
  Tier,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const DONE =
  'Lane freeze answer.\n{"confidence":0.95,"escalate":false,"reason":"done","needs_review":false}';

function clock(): Clock {
  let now = 1_000;
  let id = 0;
  return {
    now: () => ++now,
    isoNow: () => new Date(0).toISOString(),
    uuid: () => `id-${++id}`,
    random: () => 0.5,
  };
}

function session(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id: 'lane-freeze-session',
    async append(entry) {
      entries.push(entry);
    },
    entries,
  };
}

function ledger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(entry) {
      entries.push(entry);
    },
    entries,
  };
}

function provider(
  id: Provider['id'],
  run: (request: ProviderRequest) => ProviderEvent[],
): Provider {
  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: 'test',
        authenticated: true,
        binaryPath: `/fake/${id}`,
        availableModels: [],
      };
    },
    async *run(request) {
      for (const event of run(request)) yield event;
    },
  };
}

async function collect(stream: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function makeWorkInput(
  deps: OrchestrateDeps,
  startTier: Tier,
): WorkCallInput {
  const task = 'explain what this function returns';
  const classification = classify(task);
  const signals: EngagementSignals = {
    classification,
    routePlan: false,
    engagementBias: 0,
    task,
  };
  const engagementPlan = planEngagement(signals);
  const directive = compileTurnDirective({
    frame: undefined,
    plan: engagementPlan,
    signals,
  });

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
    taskSignals: {
      risk: classification.risk,
      routePlan: false,
      taskKind: 'unknown',
    },
    capabilityContext: undefined,
    historyContext: undefined,
    wantsWebSearch: false,
    hasImageAttachment: false,
    startTier,
  };
}

describe('runWorkCall turn lane freeze (R2.1)', () => {
  it('uses frozen availableModels for the turn even if deps mutate mid-turn', async () => {
    // Worker-tier haiku is pinned by freeze; mid-turn mutation to sonnet must not
    // change this turn's request model.
    const models: Partial<Record<'claude', string[]>> = {
      claude: ['claude-haiku-4-5'],
    };
    const requests: ProviderRequest[] = [];
    const led = ledger();
    const deps: OrchestrateDeps = {
      providers: {
        claude: provider('claude', (req) => {
          requests.push(req);
          // Simulate mid-turn inventory refresh while the provider is running.
          models.claude = ['claude-sonnet-4-6'];
          return [{ type: 'done', text: DONE, raw: {} }];
        }),
      },
      clock: clock(),
      session: session(),
      ledger: led,
      policy: {
        ...DEFAULT_POLICY,
        maxAttempts: 2,
        panelPolicy: 'off',
        hedgePolicy: 'off',
        reviewPolicy: 'off',
      },
      authenticatedProviders: ['claude'],
      availableModels: models,
      inventoryGeneration: 'work-gen-1',
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collect(runWorkCall(makeWorkInput(deps, 'worker')));
    const final = events.find((e) => e.type === 'final');
    const tierStart = events.find((e) => e.type === 'tier-start');

    assert.ok(final !== undefined && final.type === 'final' && final.success);
    assert.ok(tierStart !== undefined && tierStart.type === 'tier-start');
    assert.equal(tierStart.model, 'claude-haiku-4-5');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.model, 'claude-haiku-4-5');
    assert.equal(models.claude![0], 'claude-sonnet-4-6');
    assert.equal(led.entries.length, 1);
    assert.equal(led.entries[0]!.inventoryGeneration, 'work-gen-1');
    assert.equal(led.entries[0]!.model, 'claude-haiku-4-5');
  });

  it('next work-call turn can adopt a new model after inventory updates', async () => {
    const models: Partial<Record<'claude', string[]>> = {
      claude: ['claude-haiku-4-5'],
    };
    const modelsSeen: string[] = [];
    const gensSeen: Array<string | number | undefined> = [];
    const makeDeps = (gen: string | number): OrchestrateDeps => {
      const led = ledger();
      return {
        providers: {
          claude: provider('claude', (req) => {
            modelsSeen.push(req.model);
            return [{ type: 'done', text: DONE, raw: {} }];
          }),
        },
        clock: clock(),
        session: session(),
        ledger: {
          async record(entry) {
            gensSeen.push(entry.inventoryGeneration);
            await led.record(entry);
          },
        },
        policy: {
          ...DEFAULT_POLICY,
          maxAttempts: 1,
          panelPolicy: 'off',
          hedgePolicy: 'off',
          reviewPolicy: 'off',
        },
        authenticatedProviders: ['claude'],
        availableModels: models,
        inventoryGeneration: gen,
        cwd: '/fake/cwd',
        sandbox: 'workspace-write',
        timeoutMs: 30_000,
      };
    };

    const events1 = await collect(runWorkCall(makeWorkInput(makeDeps(1), 'worker')));
    assert.ok(events1.some((e) => e.type === 'final' && e.success));

    // Safe boundary between turns: refresh inventory + escalate tier.
    models.claude = ['claude-sonnet-4-6'];
    const events2 = await collect(runWorkCall(makeWorkInput(makeDeps(2), 'ic')));
    assert.ok(events2.some((e) => e.type === 'final' && e.success));

    assert.deepEqual(modelsSeen, ['claude-haiku-4-5', 'claude-sonnet-4-6']);
    assert.deepEqual(gensSeen, [1, 2]);
    const start1 = events1.find((e) => e.type === 'tier-start');
    const start2 = events2.find((e) => e.type === 'tier-start');
    assert.ok(start1 !== undefined && start1.type === 'tier-start');
    assert.ok(start2 !== undefined && start2.type === 'tier-start');
    assert.equal(start1.model, 'claude-haiku-4-5');
    assert.equal(start2.model, 'claude-sonnet-4-6');
  });
});
