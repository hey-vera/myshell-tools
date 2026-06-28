/**
 * test/unit/vendor-neutral-wiring.test.ts
 *
 * Flag-ON / flag-OFF tests for slices 9-11: wired route sites in
 * work-call.ts and hedge.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkCall, type WorkCallInput } from '../../src/core/work-call.ts';
import { runHedged, planHedge, type HedgePlan } from '../../src/core/hedge.ts';
import { route } from '../../src/core/route.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { DECLARATIVE_MODEL_CAPABILITIES } from '../../src/core/model-capabilities.ts';
import type {
  Classification,
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
  Tier,
} from '../../src/core/types.ts';
import type {
  Provider,
  ProviderRequest,
  ProviderEvent,
  ProviderId,
  Usage,
} from '../../src/providers/port.ts';
import type { TurnDirective } from '../../src/core/turn-directive.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { EngagementPlan } from '../../src/core/engagement.ts';
import type { WorkContract } from '../../src/core/work-contract.ts';
import type { CapabilityRouteContext } from '../../src/core/route.ts';

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

function makeFakeClock(): Clock {
  let now = 1_000_000;
  let uuidCounter = 0;
  return {
    now: () => (now += 10),
    isoNow: () => new Date(1_000_000).toISOString(),
    uuid: () => `fake-uuid-${++uuidCounter}`,
    random: () => 0.42,
  };
}

function makeFakeSession(id = 'sess-1'): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    async append(entry: SessionEntry): Promise<void> {
      entries.push(entry);
    },
    entries,
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(entry: LedgerEntry): Promise<void> {
      entries.push(entry);
    },
    entries,
  };
}

const DEFAULT_MODELS: readonly string[] = ['opus', 'sonnet', 'haiku'];

function makeFakeProvider(id: ProviderId, text: string): Provider {
  return {
    id,
    async* run(
      req: ProviderRequest,
      signal: AbortSignal,
    ): AsyncGenerator<ProviderEvent> {
      if (signal.aborted) return;
      yield { type: 'text', text };
      yield { type: 'done', text };
    },
  } as Provider;
}

const WORKER: Tier = 'worker';
const HIGH_IC: Classification = { tier: 'ic', risk: 'high', rationale: 'test' };
const EMPTY_DIRECTIVE: TurnDirective = {
  version: 1,
  substantial: false,
  repoOriented: false,
  historyPolicy: { replayMode: 'normal' },
  outputValidators: [],
  requiredBeforeAnswer: [],
};

function makeWorkCallDeps(opts?: {
  vendorNeutralEnabled?: boolean;
  capabilityRegistry?: boolean;
}): {
  deps: OrchestrateDeps;
  input: WorkCallInput;
  provider: Provider;
} {
  const clock = makeFakeClock();
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const provider = makeFakeProvider('claude', "{\"confidence\": 0.95}");
  const deps: OrchestrateDeps = {
    providers: { claude: provider },
    clock,
    session,
    ledger,
    policy: DEFAULT_POLICY,
    cwd: '/test',
    sandbox: 'none',
    timeoutMs: 30000,
    availableModels: { claude: DEFAULT_MODELS },
    authenticatedProviders: ['claude'],
    ...(opts?.capabilityRegistry === true
      ? { capabilityRegistry: DECLARATIVE_MODEL_CAPABILITIES }
      : {}),
  };
  const input: WorkCallInput = {
    task: 'test task',
    deps,
    signal: new AbortController().signal,
    classification: HIGH_IC,
    routePlan: false,
    directive: EMPTY_DIRECTIVE,
    intentFrame: undefined,
    engagementPlan: { actions: ['IMPLEMENT'], tone: 'neutral' } as EngagementPlan,
    goalTitle: '',
    workTrace: undefined,
    incomingWorkContract: undefined,
    available: ['claude'],
    mode: 'balanced',
    taskSignals: { risk: 'high', routePlan: false, taskKind: 'implementation' },
    capabilityContext: undefined,
    historyContext: undefined,
    wantsWebSearch: false,
    hasImageAttachment: false,
    startTier: 'ic',
    autoBrainEscalation: false,
    vendorNeutralEnabled: opts?.vendorNeutralEnabled ?? false,
  };
  return { deps, input, provider };
}

async function collect(
  gen: AsyncGenerator<CoreEvent>,
): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ---------------------------------------------------------------------------
// Slice 9: runWorkCall flag-OFF (byte-identical)
// ---------------------------------------------------------------------------

describe('work-call flag-OFF (byte-identical)', () => {
  it('runWorkCall uses route() when vendorNeutralEnabled is false', async () => {
    const { input } = makeWorkCallDeps({ vendorNeutralEnabled: false });
    const events = await collect(runWorkCall(input));
    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
    }
    // Flag-OFF: the decision uses route() which for claude-only, balanced, IC → sonnet
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.ok(tierStarts.length > 0, 'at least one tier-start');
    const ts = tierStarts[0];
    assert.ok(ts !== undefined && ts.type === 'tier-start');
    if (ts.type === 'tier-start') {
      assert.equal(ts.provider, 'claude');
      // Balanced policy clamps IC to sonnet
      assert.equal(ts.model, 'claude-sonnet-4-6');
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 9: runWorkCall flag-ON (vendor-neutral routing activates)
// ---------------------------------------------------------------------------

describe('work-call flag-ON (vendor-neutral routing)', () => {
  it('runWorkCall uses vendor-neutral route when flag is ON and registry present', async () => {
    const { input } = makeWorkCallDeps({
      vendorNeutralEnabled: true,
      capabilityRegistry: true,
    });
    const events = await collect(runWorkCall(input));
    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
    }
    // Flag-ON with registry: vendor-neutral route selects by suitability
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.ok(tierStarts.length > 0, 'at least one tier-start');
    const ts = tierStarts[0];
    assert.ok(ts !== undefined && ts.type === 'tier-start');
    if (ts.type === 'tier-start') {
      assert.equal(ts.provider, 'claude');
      // IC tier: sonnet has highest IC suitability (85)
      assert.equal(ts.model, 'sonnet');
    }
  });

  it('runWorkCall flag-ON without registry falls through to route()', async () => {
    const { input } = makeWorkCallDeps({
      vendorNeutralEnabled: true,
      capabilityRegistry: false,
    });
    const events = await collect(runWorkCall(input));
    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
    }
    // Without registry, falls back to route() -> sonnet
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.ok(tierStarts.length > 0);
    const ts = tierStarts[0];
    assert.ok(ts !== undefined && ts.type === 'tier-start');
    if (ts.type === 'tier-start') {
      assert.equal(ts.provider, 'claude');
      assert.equal(ts.model, 'claude-sonnet-4-6');
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 11: hedge flag-OFF / flag-ON
// ---------------------------------------------------------------------------

function makeHedgeProvider(id: ProviderId, text: string): Provider {
  return {
    id,
    async* run(
      req: ProviderRequest,
      signal: AbortSignal,
    ): AsyncGenerator<ProviderEvent> {
      if (signal.aborted) return;
      yield { type: 'text', text };
      yield { type: 'done', text };
    },
  } as Provider;
}

const HEDGE_TEST_PLAN: HedgePlan = {
  primaryTier: 'ic',
  speculativeTier: 'manager',
  delayMs: 4000,
  risk: 'high',
};

function hedgeDeps(sleep: (_ms: number) => Promise<void>): {
  deps: OrchestrateDeps;
  ledger: ReturnType<typeof makeFakeLedger>;
} {
  const clock = makeFakeClock();
  const session = makeFakeSession('hedge-sess');
  const ledger = makeFakeLedger();
  const claude = makeHedgeProvider('claude', '{"confidence": 0.95}\nCLAUDES ANSWER');
  const deps: OrchestrateDeps = {
    providers: { claude },
    clock,
    session,
    ledger,
    policy: { ...DEFAULT_POLICY, flagshipAdmission: 'adaptive' as const },
    cwd: '/test',
    sandbox: 'none',
    timeoutMs: 30000,
    sleep,
    availableModels: { claude: DEFAULT_MODELS },
    authenticatedProviders: ['claude'],
  };
  return { deps, ledger };
}

describe('hedge flag-OFF (byte-identical)', () => {
  it('runHedged works with vendorNeutralEnabled false', async () => {
    const { deps, ledger } = hedgeDeps(() => Promise.resolve());
    const events = await collect(
      runHedged('test task', deps, HEDGE_TEST_PLAN, new AbortController().signal, undefined, undefined, false, {
        vendorNeutralEnabled: false,
      }),
    );
    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
    }
    assert.ok(ledger.entries.length > 0, 'at least one ledger entry');
  });
});

describe('hedge flag-ON (vendor-neutral routing)', () => {
  it('runHedged works with vendorNeutralEnabled true and registry', async () => {
    const { deps, ledger } = hedgeDeps(() => Promise.resolve());
    // Add capability registry
    (deps as Record<string, unknown>).capabilityRegistry = DECLARATIVE_MODEL_CAPABILITIES;
    const events = await collect(
      runHedged('test task', deps, HEDGE_TEST_PLAN, new AbortController().signal, undefined, undefined, false, {
        vendorNeutralEnabled: true,
      }),
    );
    const finals = events.filter((e) => e.type === 'final');
    assert.equal(finals.length, 1, 'exactly one final');
    const final = finals[0];
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
    }
    assert.ok(ledger.entries.length > 0, 'at least one ledger entry');
  });
});
