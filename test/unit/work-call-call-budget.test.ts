/**
 * test/unit/work-call-call-budget.test.ts — P1-09d call-budget ledger tests.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { runWorkCall, type WorkCallInput } from '../../src/core/work-call.ts';
import { createTurnCallBudget } from '../../src/core/turn-call-budget.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  CoreEvent,
  LedgerEntry,
  OrchestrateDeps,
  SessionEntry,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderRequest, ProviderId } from '../../src/providers/port.ts';
import type { EngagementPlan } from '../../src/core/engagement.ts';
import type { TurnDirective } from '../../src/core/turn-directive.ts';

const WORKER_TIER = { tier: 'worker' as const, risk: 'medium' as const, rationale: 'test' };
const HIGH_TIER = { tier: 'worker' as const, risk: 'high' as const, rationale: 'test' };
const EMPTY_DIRECTIVE: TurnDirective = {
  version: 1, substantial: false, repoOriented: false,
  historyPolicy: { replayMode: 'normal' }, outputValidators: [], requiredBeforeAnswer: [],
};

let seqCounter = 0;
let callIdCounter = 0;
function makeBudget(mode: 'observe' | 'enforce' = 'observe', overrides?: {
  totalUnits?: number; failover?: 0 | 1; verification?: 0 | 1; work?: number;
}) {
  seqCounter = 0; callIdCounter = 0;
  return createTurnCallBudget({
    turnId: `turn-${Date.now()}`,
    mode,
    totalUnits: overrides?.totalUnits ?? 8,
    reserved: {
      work: overrides?.work ?? 1,
      failover: overrides?.failover ?? 1,
      verification: overrides?.verification ?? 1,
    },
    nextSeq: () => seqCounter++,
    nextCallId: () => `call-${callIdCounter++}`,
  });
}

function mkProvider(id: ProviderId, events: ProviderEvent[]): Provider {
  return {
    id,
    async detect() { return { id, installed: true, version: '1.0.0', authenticated: true, binaryPath: `/fake/${id}`, availableModels: [] }; },
    async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      for (const ev of events) yield ev;
    },
  };
}

interface DepsOpts {
  firstEvents?: ProviderEvent[];
  secondEvents?: ProviderEvent[];
  thirdEvents?: ProviderEvent[];
  firstProvider?: ProviderId;
  secondProvider?: ProviderId;
  thirdProvider?: ProviderId;
  maxAttempts?: number;
  reviewPolicy?: import('../../src/core/policy.js').ReviewPolicy;
  highRisk?: boolean;
  available?: ProviderId[];
}

function makeWorkInput(opts: DepsOpts & { turnCallBudget?: number } = {}): WorkCallInput {
  const first = opts.firstProvider ?? 'claude';
  const second = opts.secondProvider ?? 'codex';
  const third = opts.thirdProvider;

  const providers: Record<string, Provider> = {};
  const avail: ProviderId[] = [];
  const authed: ProviderId[] = [];

  if (opts.firstEvents !== undefined) {
    providers[first] = mkProvider(first, opts.firstEvents);
    avail.push(first); authed.push(first);
  }
  if (opts.secondEvents !== undefined) {
    providers[second] = mkProvider(second, opts.secondEvents);
    avail.push(second); authed.push(second);
  }
  if (third !== undefined && opts.thirdEvents !== undefined) {
    providers[third] = mkProvider(third, opts.thirdEvents);
    avail.push(third); authed.push(third);
  }

  let now = 2_000_000; let uid = 0;
  const deps: OrchestrateDeps = {
    providers,
    clock: { now: () => (now += 10), isoNow: () => new Date(1_000_000).toISOString(), uuid: () => `u-${++uid}`, random: () => 0.42 },
    session: { id: 's', async append(_e: SessionEntry): Promise<void> {} },
    ledger: { async record(_e: LedgerEntry): Promise<void> {} },
    policy: { ...DEFAULT_POLICY, maxAttempts: opts.maxAttempts ?? 3, panelPolicy: 'off', hedgePolicy: 'off', reviewPolicy: opts.reviewPolicy ?? 'off' },
    cwd: '/test', sandbox: 'none', timeoutMs: 5000,
    availableModels: { claude: ['sonnet'] as readonly string[], opencode: ['deepseek-v4-flash'] as readonly string[], codex: ['gpt-5.1'] as readonly string[] },
    authenticatedProviders: authed,
  };

  return {
    task: 'test task', deps,
    signal: new AbortController().signal,
    classification: opts.highRisk ? HIGH_TIER : WORKER_TIER,
    routePlan: false, directive: EMPTY_DIRECTIVE,
    intentFrame: undefined,
    engagementPlan: { actions: ['IMPLEMENT'], tone: 'neutral' } as EngagementPlan,
    goalTitle: '', workTrace: undefined, incomingWorkContract: undefined,
    available: opts.available ?? avail,
    mode: 'balanced',
    taskSignals: { risk: opts.highRisk ? 'high' : 'medium', routePlan: false, taskKind: 'implementation' },
    capabilityContext: undefined, historyContext: undefined,
    wantsWebSearch: false, hasImageAttachment: false,
    startTier: 'worker', autoBrainEscalation: false,
    turnCallBudget: opts.turnCallBudget,
  };
}

async function collectE(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const e: CoreEvent[] = []; for await (const ev of gen) e.push(ev); return e;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P1-09d work-call call-budget ledger', () => {
  it('single accepted execution reconciles one work call', async () => {
    const budget = makeBudget();
    const input = makeWorkInput({ firstEvents: [{ type: 'done', text: 'answer', raw: {} }] });
    await collectE(runWorkCall({ ...input, turnCallLedger: budget }));
    const snap = budget.snapshot();
    assert.equal(snap.begun, 1, 'one call begun');
  });

  it('route miss records zero attempts', async () => {
    const budget = makeBudget();
    const input = makeWorkInput({ firstEvents: [{ type: 'done', text: 'x', raw: {} }] });
    const depsNoProv = { ...input.deps, providers: {} };
    await collectE(runWorkCall({ ...input, deps: depsNoProv, turnCallLedger: budget }));
    const snap = budget.snapshot();
    assert.equal(snap.begun, 0, 'no calls on route miss');
  });

  it('empty and thrown streams each record one failed attempt', async () => {
    // Empty stream
    {
      const budget = makeBudget();
      const input = makeWorkInput({ firstEvents: [], maxAttempts: 1, available: ['claude'] });
      await collectE(runWorkCall({ ...input, turnCallLedger: budget }));
      const snap = budget.snapshot();
      assert.equal(snap.begun, 1, 'empty stream counts');
      assert.ok(snap.events.some((e) => e.type === 'call-settled' && 'outcome' in e && e.outcome === 'empty'));
    }
    // Error stream
    {
      const budget = makeBudget();
      const input = makeWorkInput({
        firstEvents: [{ type: 'error', error: { category: 'network', recoverable: true, message: 'fail', suggestion: '' } }],
        maxAttempts: 1, available: ['claude'],
      });
      await collectE(runWorkCall({ ...input, turnCallLedger: budget }));
      const snap = budget.snapshot();
      assert.equal(snap.begun, 1, 'error stream counts');
      assert.ok(snap.events.some((e) => e.type === 'call-settled' && 'outcome' in e && e.outcome === 'provider-error'));
    }
  });

  it('objective repair is discretionary and parent-linked', async () => {
    const budget = makeBudget();
    let verifyCalls = 0;
    const vp: import('../../src/core/verify.js').VerifyPort = {
      async captureDiff() { return { files: ['a.ts'], patch: '+x' }; },
      async detectTestCommand() { return { label: 'npm test', command: 'npm', args: ['test'] }; },
      async runTests() {
        verifyCalls++;
        if (verifyCalls === 1) return { outcome: 'red' as const, output: 'fail', durationMs: 10 };
        return { outcome: 'green' as const, output: 'ok', durationMs: 5 };
      },
    };

    const input = makeWorkInput({
      firstEvents: [{ type: 'done', text: 'A good answer', raw: {} }],
      maxAttempts: 3, available: ['claude'],
    });
    const workInput: WorkCallInput = {
      ...input, turnCallLedger: budget, verifyLevel: 'tests',
      deps: { ...input.deps, verifyPort: vp },
    };

    await collectE(runWorkCall(workInput));

    const snap = budget.snapshot();
    assert.ok(snap.begun >= 2, `expected >=2 calls begun, got ${snap.begun}`);
    const repairCall = snap.events.filter((e) => e.type === 'call-begun' && 'purpose' in e && e.purpose === 'work-repair');
    assert.ok(repairCall.length >= 1, 'at least one work-repair call');
  });

  it('A to B failover consumes reserved failover', async () => {
    const budget = makeBudget('observe', { totalUnits: 4, work: 1, failover: 1, verification: 0 });
    const input = makeWorkInput({
      firstEvents: [{ type: 'error', error: { category: 'network', recoverable: true, message: 'fail', suggestion: 'try other' } }],
      secondEvents: [{ type: 'done', text: 'recovered', raw: {} }],
      maxAttempts: 5,
    });
    await collectE(runWorkCall({ ...input, turnCallLedger: budget }));

    const snap = budget.snapshot();
    assert.equal(snap.begun, 2, 'A(work) + B(failover) = 2');
    const calls = snap.events.filter((e) => e.type === 'call-begun');
    assert.equal(calls.length, 2);

    const c0 = calls[0]! as { type: 'call-begun'; callId: string; bucket: string; purpose: string };
    assert.equal(c0.bucket, 'work');
    assert.equal(c0.purpose, 'work');

    const c1 = calls[1]! as { type: 'call-begun'; callId: string; bucket: string; purpose: string; parentCallId?: string };
    assert.equal(c1.bucket, 'failover');
    assert.equal(c1.purpose, 'failover');
    assert.equal(c1.parentCallId, c0.callId);
  });

  it('A to B to C marks second continuation would-deny in observe mode', async () => {
    const budget = makeBudget('observe', { totalUnits: 4, work: 1, failover: 1, verification: 0 });
    const input = makeWorkInput({
      firstEvents: [{ type: 'error', error: { category: 'network', recoverable: true, message: 'A fail', suggestion: '' } }],
      secondEvents: [{ type: 'error', error: { category: 'network', recoverable: true, message: 'B fail', suggestion: '' } }],
      thirdEvents: [{ type: 'done', text: 'C ok', raw: {} }],
      thirdProvider: 'opencode',
      maxAttempts: 10,
    });
    await collectE(runWorkCall({ ...input, turnCallLedger: budget }));

    const snap = budget.snapshot();
    assert.equal(snap.begun, 3, 'A+B+C = 3 calls');
    const wouldDeny = snap.events.filter((e) => e.type === 'call-would-deny');
    assert.ok(wouldDeny.length >= 1, 'C should trigger a would-deny event');
  });

  it('typed loss override permits one distinct no-answer fallback in enforce mode', async () => {
    const budget = makeBudget('enforce', { totalUnits: 3, work: 1, failover: 0, verification: 0 });
    const b1 = budget.begin({ purpose: 'work', bucket: 'work' });
    assert.ok(b1.allowed);
    if (b1.allowed) {
      b1.finish('provider-error');
      const result = budget.requestLossPreservationOverride({
        failedCallId: b1.callId,
        reason: 'rate-limit',
        nextProviderDistinct: true,
        sameIdempotencyKey: true,
      });
      assert.equal(result, true, 'loss override should be granted');
      const b2 = budget.begin({ purpose: 'failover', bucket: 'failover' });
      assert.equal(b2.allowed, true, 'failover allowed after override');
    }
  });

  it('generic review and verify critic use verification reservation', async () => {
    const budget = makeBudget('observe', { totalUnits: 8, work: 1, failover: 1, verification: 1 });
    const input = makeWorkInput({
      firstEvents: [{ type: 'done', text: 'Reworked answer with confidence.', raw: {} }],
      secondEvents: [{ type: 'done', text: 'Approve', raw: {} }],
      highRisk: true, reviewPolicy: 'always', maxAttempts: 5,
    });
    await collectE(runWorkCall({ ...input, turnCallLedger: budget }));

    const snap = budget.snapshot();
    const verificationCalls = snap.events.filter(
      (e) => e.type === 'call-begun' && 'bucket' in e && e.bucket === 'verification',
    );
    assert.ok(verificationCalls.length >= 1, 'at least one verification call for review');
  });

  it('budget receipt total equals fake provider run count and not available provider count', async () => {
    const budget = makeBudget();
    let runCountA = 0;
    let runCountB = 0;
    const provA: Provider = {
      id: 'claude',
      async detect() { return { id: 'claude' as ProviderId, installed: true, version: '1', authenticated: true, binaryPath: '/f/claude', availableModels: [] }; },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncGenerator<ProviderEvent> {
        runCountA++; yield { type: 'done', text: 'answer from claude', raw: {} };
      },
    };
    const provB: Provider = {
      id: 'codex',
      async detect() { return { id: 'codex' as ProviderId, installed: true, version: '1', authenticated: true, binaryPath: '/f/codex', availableModels: [] }; },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncGenerator<ProviderEvent> {
        runCountB++; yield { type: 'done', text: 'codex answer', raw: {} };
      },
    };

    let now = 2_000_000; let uid = 0;
    const deps: OrchestrateDeps = {
      providers: { claude: provA, codex: provB },
      clock: { now: () => (now += 10), isoNow: () => new Date(1_000_000).toISOString(), uuid: () => `u-${++uid}`, random: () => 0.42 },
      session: { id: 's', async append(_e: SessionEntry): Promise<void> {} },
      ledger: { async record(_e: LedgerEntry): Promise<void> {} },
      policy: { ...DEFAULT_POLICY, maxAttempts: 3, panelPolicy: 'off', hedgePolicy: 'off', reviewPolicy: 'off' },
      cwd: '/test', sandbox: 'none', timeoutMs: 5000,
      availableModels: { claude: ['sonnet'] as readonly string[], codex: ['gpt-5.1'] as readonly string[] },
      authenticatedProviders: ['claude', 'codex'],
    };
    const workInput: WorkCallInput = {
      task: 'test task', deps,
      signal: new AbortController().signal,
      classification: WORKER_TIER,
      routePlan: false, directive: EMPTY_DIRECTIVE,
      intentFrame: undefined,
      engagementPlan: { actions: ['IMPLEMENT'], tone: 'neutral' } as EngagementPlan,
      goalTitle: '', workTrace: undefined, incomingWorkContract: undefined,
      available: ['claude', 'codex'],
      mode: 'balanced',
      taskSignals: { risk: 'medium', routePlan: false, taskKind: 'implementation' },
      capabilityContext: undefined, historyContext: undefined,
      wantsWebSearch: false, hasImageAttachment: false,
      startTier: 'worker', autoBrainEscalation: false,
      turnCallLedger: budget,
    };

    await collectE(runWorkCall(workInput));

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1, 'only the provider that actually streamed counts');
    assert.equal(runCountA, 1, 'claude ran once');
    assert.equal(runCountB, 0, 'codex never called');
  });
});
