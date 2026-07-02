/**
 * test/unit/context-helper-call-budget.test.ts — P1-09g: verify the recap and
 * understanding generators record budgeted provider calls with correct purposes,
 * and that foreground / maintenance budgets are properly isolated.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { makeRecapGenerator } from '../../src/core/recap-generator.ts';
import { makeUnderstandingPass } from '../../src/core/understanding-generator.ts';
import {
  createTurnCallBudget,
  type TurnCallBudget,
  type TurnCallBudgetReceipt,
} from '../../src/core/turn-call-budget.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderId, ProviderRequest } from '../../src/providers/port.ts';
import type { SessionEntry } from '../../src/core/types.ts';

const SIGNAL = new AbortController().signal;

const HISTORY: SessionEntry[] = [
  { timestamp: '2024-01-01T00:00:00.000Z', role: 'user', content: 'Migrate auth to JWT' },
  { timestamp: '2024-01-01T00:01:00.000Z', role: 'assistant', content: '4 files edited.' },
];

const GOOD_UNDERSTANDING = [
  'SUMMARY: auth lives in core/oauth',
  'MODULE: core/oauth — owns refresh',
  'CONSTRAINT: OAuth only',
].join('\n');

function makeBudget(turnId: string, totalUnits = 10): TurnCallBudget {
  return createTurnCallBudget({
    turnId,
    mode: 'observe',
    totalUnits,
    reserved: { work: 1, failover: 0, verification: 0 },
  });
}

interface ProviderSink {
  runCount: number;
  ran: boolean;
}

function fakeProvider(id: ProviderId, events: ProviderEvent[], sink?: ProviderSink): Provider {
  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: '1.0.0',
        authenticated: true,
        plan: null,
        binaryPath: null,
        availableModels: [],
      };
    },
    async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (sink) {
        sink.runCount++;
        sink.ran = true;
      }
      for (const ev of events) yield ev;
    },
  };
}

function budgetCallPurposes(receipt: TurnCallBudgetReceipt): string[] {
  return receipt.events
    .filter((e) => e.type === 'call-begun')
    .map((e) => ('purpose' in e ? (e as { purpose: string }).purpose : ''))
    .filter(Boolean);
}

describe('context-helper-call-budget', () => {
  it('recap and understanding use distinct purposes', async () => {
    const budget = makeBudget('test-both-purposes');
    const recapProvider = fakeProvider('claude', [
      { type: 'done', text: 'TITLE: X\nSTATE: doing things.', raw: {} },
    ]);

    const recapper = makeRecapGenerator({
      providers: { claude: recapProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: budget,
    });
    await recapper(HISTORY, SIGNAL);

    const underProvider = fakeProvider('claude', [
      { type: 'done', text: GOOD_UNDERSTANDING, raw: {} },
    ]);
    const understander = makeUnderstandingPass({
      providers: { claude: underProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: budget,
    });
    await understander('migrate the auth token refresh path', SIGNAL);

    const purposes = budgetCallPurposes(budget.snapshot());
    assert.equal(purposes.length, 2);
    assert.ok(purposes.includes('recap'), 'recap purpose present');
    assert.ok(purposes.includes('understanding'), 'understanding purpose present');
    assert.notEqual(purposes[0], purposes[1], 'purposes are distinct');
  });

  it('parse failure still records an attempt', async () => {
    const budget = makeBudget('test-parse-failure');
    // Emit done with whitespace text — parseRecapResult returns null for whitespace-only
    const provider = fakeProvider('claude', [
      { type: 'done', text: '   ', raw: {} },
    ]);

    const gen = makeRecapGenerator({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: budget,
    });
    const result = await gen(HISTORY, SIGNAL);
    assert.equal(result, null, 'generator returns null on parse failure');

    const receipt = budget.snapshot();
    assert.equal(receipt.begun, 1, 'stream opened so one attempt recorded');
    assert.equal(receipt.settled, 1, 'done event settled the call');
    assert.equal(receipt.denied, 0);
  });

  it('no provider records zero', async () => {
    const budget = makeBudget('test-no-provider');

    const gen = makeRecapGenerator({
      providers: {},
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: budget,
    });
    const result = await gen(HISTORY, SIGNAL);
    assert.equal(result, null, 'no provider so returns null');

    const receipt = budget.snapshot();
    assert.equal(receipt.begun, 0, 'never touched the provider');
    assert.equal(receipt.settled, 0);
    assert.equal(receipt.denied, 0);
  });

  it('maintenance id is preserved and cannot become a user turn id', async () => {
    const foregroundBudget = makeBudget('turn-user-456');
    const maintenanceBudget = makeBudget('maintenance-xyz');

    const fgProvider = fakeProvider('claude', [
      { type: 'done', text: 'TITLE: Fg\nSTATE: foreground.', raw: {} },
    ]);
    const fgGen = makeRecapGenerator({
      providers: { claude: fgProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: foregroundBudget,
    });
    await fgGen(HISTORY, SIGNAL);

    const mtProvider = fakeProvider('claude', [
      { type: 'done', text: 'TITLE: Mt\nSTATE: maintenance.', raw: {} },
    ]);
    const mtGen = makeRecapGenerator({
      providers: { claude: mtProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: maintenanceBudget,
    });
    await mtGen(HISTORY, SIGNAL);

    const fgReceipt = foregroundBudget.snapshot();
    const mtReceipt = maintenanceBudget.snapshot();

    assert.equal(fgReceipt.turnId, 'turn-user-456', 'foreground turnId is preserved');
    assert.equal(mtReceipt.turnId, 'maintenance-xyz', 'maintenance turnId is preserved');
    assert.notEqual(fgReceipt.turnId, mtReceipt.turnId, 'turnIds are distinct');
    assert.notEqual(
      mtReceipt.turnId,
      'turn-user-456',
      'maintenance budget never carries a user-turn id',
    );

    // The maintenance receipt should have its own events, none related to the
    // foreground turn's identity.
    assert.equal(mtReceipt.begun, 1);
    assert.equal(mtReceipt.settled, 1);
  });

  it('receipt counts equal fake provider runs', async () => {
    // Recap: one provider run
    const recapBudget = makeBudget('test-counts-recap');
    const recapSink: ProviderSink = { runCount: 0, ran: false };
    const recapProvider = fakeProvider(
      'claude',
      [{ type: 'done', text: 'TITLE: Count\nSTATE: one.', raw: {} }],
      recapSink,
    );

    const recapper = makeRecapGenerator({
      providers: { claude: recapProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: recapBudget,
    });
    await recapper(HISTORY, SIGNAL);

    const recapReceipt = recapBudget.snapshot();
    assert.equal(recapSink.runCount, 1, 'fake provider ran once');
    assert.equal(recapReceipt.begun, recapSink.runCount, 'begun count equals provider runs');
    assert.equal(recapReceipt.settled, recapSink.runCount, 'settled count equals provider runs');

    // Understanding: one provider run
    const underBudget = makeBudget('test-counts-under');
    const underSink: ProviderSink = { runCount: 0, ran: false };
    const underProvider = fakeProvider(
      'claude',
      [{ type: 'done', text: GOOD_UNDERSTANDING, raw: {} }],
      underSink,
    );

    const understander = makeUnderstandingPass({
      providers: { claude: underProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8000,
      turnCallBudget: underBudget,
    });
    await understander('migrate auth token refresh', SIGNAL);

    const underReceipt = underBudget.snapshot();
    assert.equal(underSink.runCount, 1, 'understanding fake provider ran once');
    assert.equal(underReceipt.begun, underSink.runCount, 'under begun count equals provider runs');
    assert.equal(underReceipt.settled, underSink.runCount, 'under settled count equals provider runs');
  });
});
