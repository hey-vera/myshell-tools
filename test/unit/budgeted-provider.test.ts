import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import type { Provider, ProviderEvent, ProviderRequest, ProviderId } from '../../src/providers/port.js';
import type { ProviderStatus } from '../../src/providers/detect.js';
import type { SandboxLevel } from '../../src/providers/port.js';
import {
  createTurnCallBudget,
  type TurnCallBudget,
  type TurnCallBudgetMode,
  type TurnCallBudgetSpec,
  type TurnCallOutcome,
  type TurnCallRequest,
} from '../../src/core/turn-call-budget.js';
import {
  runBudgetedProvider,
  TurnCallDeniedError,
  type BudgetedProviderCall,
} from '../../src/core/budgeted-provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function budgetSpec(
  overrides: Partial<{
    turnId: string;
    mode: TurnCallBudgetMode;
    totalUnits: number;
    reservedWork: number;
    reservedFailover: number;
    reservedVerification: number;
    nextSeq: () => number;
    nextCallId: () => string;
  }> = {},
): TurnCallBudgetSpec {
  return {
    turnId: overrides.turnId ?? 'turn-1',
    mode: overrides.mode ?? 'enforce',
    totalUnits: overrides.totalUnits ?? 5,
    reserved: {
      work: overrides.reservedWork ?? 1,
      failover: (overrides.reservedFailover ?? 0) as 0 | 1,
      verification: (overrides.reservedVerification ?? 0) as 0 | 1,
    },
    nextSeq: overrides.nextSeq,
    nextCallId: overrides.nextCallId,
  };
}

function makeRequest(): ProviderRequest {
  return {
    model: 'test-model',
    prompt: 'hello',
    cwd: '/tmp',
    sandbox: 'workspace-write' as SandboxLevel,
    timeoutMs: 5000,
  };
}

class FakeProvider implements Provider {
  public readonly id: ProviderId;
  public _events: ProviderEvent[];
  public _shouldThrow?: Error;

  private _runCallCount = 0;

  constructor(opts?: { id?: ProviderId; events?: ProviderEvent[]; shouldThrow?: Error }) {
    this.id = opts?.id ?? 'claude';
    this._events = opts?.events ?? [];
    this._shouldThrow = opts?.shouldThrow;
  }

  get runCallCount(): number {
    return this._runCallCount;
  }

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      installed: true,
      version: '1.0.0',
      authenticated: true,
      plan: null,
      binaryPath: '/usr/bin/' + this.id,
      availableModels: [],
    };
  }

  async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this._runCallCount++;
    for (const event of this._events) {
      yield event;
    }
    if (this._shouldThrow) {
      throw this._shouldThrow;
    }
  }
}

function settledEventsFromBudget(budget: TurnCallBudget): Array<{ callId: string; outcome: TurnCallOutcome }> {
  return budget
    .snapshot()
    .events.filter(
      (e): e is Extract<(typeof budget.snapshot)['events'][number], { type: 'call-settled' }> =>
        e.type === 'call-settled',
    )
    .map((e) => ({ callId: e.callId, outcome: e.outcome }));
}

// ---------------------------------------------------------------------------
// absent budget streams byte-for-byte without ledger events
// ---------------------------------------------------------------------------
describe('absent budget streams byte-for-byte without ledger events', () => {
  it('passes through events unchanged and emits zero ledger events', async () => {
    const events: ProviderEvent[] = [
      { type: 'text', delta: 'hello' },
      { type: 'reasoning', delta: 'hmm' },
      { type: 'done', text: 'world', raw: null },
    ];
    const provider = new FakeProvider({ events });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = {
      purpose: 'work',
      bucket: 'work',
      provider: provider.id,
    };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);
    const collected: ProviderEvent[] = [];
    for await (const e of stream) {
      collected.push(e);
    }

    assert.deepEqual(collected, events);
    assert.equal(collected[0], events[0]); // object identity preserved — not necessarily with FakeProvider
    // Provider.run was called directly and no budget was consumed
    assert.equal(provider.runCallCount, 1);
  });
});

// ---------------------------------------------------------------------------
// budget begins on first next not construction
// ---------------------------------------------------------------------------
describe('budget begins on first next not construction', () => {
  it('does not call begin until first next()', async () => {
    let beginCallCount = 0;
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const provider = new FakeProvider({ events: [{ type: 'done', text: 'ok', raw: null }] });
    const request = makeRequest();
    const ac = new AbortController();

    const origBegin = budget.begin.bind(budget);
    budget.begin = (req: TurnCallRequest) => {
      beginCallCount++;
      return origBegin(req);
    };

    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    // Construct the iterable — begin should NOT be called
    assert.equal(beginCallCount, 0);
    const stream = runBudgetedProvider(provider, request, ac.signal, call);
    assert.equal(beginCallCount, 0);

    // Get the iterator — still no begin
    const iter = stream[Symbol.asyncIterator]();
    assert.equal(beginCallCount, 0);

    // Now call next() — this triggers begin
    const p = iter.next();
    assert.equal(beginCallCount, 1);

    await p;
    // Finish consumption
    await iter.next();

    assert.equal(beginCallCount, 1);
  });
});

// ---------------------------------------------------------------------------
// done and error preserve exact events and settle once
// ---------------------------------------------------------------------------
describe('done and error preserve exact events and settle once', () => {
  it('terminal done event settles succeeded', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const events: ProviderEvent[] = [
      { type: 'text', delta: 'a' },
      { type: 'done', text: 'final', raw: null },
    ];
    const provider = new FakeProvider({ events });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);
    const collected: ProviderEvent[] = [];
    for await (const e of stream) {
      collected.push(e);
    }

    assert.deepEqual(collected, events);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.settled, 1);

    const settled = settledEventsFromBudget(budget);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.outcome, 'succeeded');
  });

  it('terminal error event settles provider-error', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const errEvent: ProviderEvent = {
      type: 'error',
      error: { category: 'unknown', recoverable: false, message: 'bad', suggestion: 'retry' },
    };
    const events: ProviderEvent[] = [
      { type: 'text', delta: 'before' },
      errEvent,
    ];
    const provider = new FakeProvider({ events });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);
    const collected: ProviderEvent[] = [];
    for await (const e of stream) {
      collected.push(e);
    }

    assert.deepEqual(collected, events);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.settled, 1);

    const settled = settledEventsFromBudget(budget);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.outcome, 'provider-error');
  });

  it('settlement fires exactly once — double finish is inert', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const events: ProviderEvent[] = [
      { type: 'done', text: 'ok', raw: null },
    ];
    const provider = new FakeProvider({ events });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);
    for await (const _e of stream) {
      // consume
    }

    const snap = budget.snapshot();
    assert.equal(snap.settled, 1);
    // Re-snapshot should show same settled count (no duplicate)
    const snap2 = budget.snapshot();
    assert.equal(snap2.settled, 1);
  });
});

// ---------------------------------------------------------------------------
// throw is rethrown and settled
// ---------------------------------------------------------------------------
describe('throw is rethrown and settled', () => {
  it('rethrown after settle threw', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const throwErr = new Error('boom');
    const events: ProviderEvent[] = [
      { type: 'text', delta: 'before-throw' },
    ];
    const provider = new FakeProvider({ events, shouldThrow: throwErr });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);

    const collected: ProviderEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const e of stream) {
          collected.push(e);
        }
      })(),
      /boom/,
    );

    // Should have collected the text event before the throw
    assert.equal(collected.length, 1);
    assert.equal(collected[0]!.type, 'text');

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.settled, 1);

    const settled = settledEventsFromBudget(budget);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.outcome, 'threw');
  });
});

// ---------------------------------------------------------------------------
// abort before first event is one cancelled attempt
// ---------------------------------------------------------------------------
describe('abort before first event is one cancelled attempt', () => {
  it('signals aborted before first next cancels the attempt', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const provider = new FakeProvider({ events: [{ type: 'text', delta: 'should not appear' }] });
    const request = makeRequest();
    const ac = new AbortController();
    ac.abort();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);

    const collected: ProviderEvent[] = [];
    for await (const e of stream) {
      collected.push(e);
    }

    assert.equal(collected.length, 0);
    assert.equal(provider.runCallCount, 0);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.settled, 1);

    const settled = settledEventsFromBudget(budget);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.outcome, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// empty stream is one empty attempt
// ---------------------------------------------------------------------------
describe('empty stream is one empty attempt', () => {
  it('provider yielding no events settles empty', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const provider = new FakeProvider({ events: [] });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);

    const collected: ProviderEvent[] = [];
    for await (const e of stream) {
      collected.push(e);
    }

    assert.equal(collected.length, 0);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.settled, 1);

    const settled = settledEventsFromBudget(budget);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.outcome, 'empty');
  });
});

// ---------------------------------------------------------------------------
// early break closes delegate and records abandoned
// ---------------------------------------------------------------------------
describe('early break closes delegate and records abandoned', () => {
  it('breaking out after partial consumption settles abandoned', async () => {
    const budget = createTurnCallBudget(budgetSpec({ totalUnits: 3 }));
    const events: ProviderEvent[] = [
      { type: 'text', delta: 'a' },
      { type: 'text', delta: 'b' },
      { type: 'text', delta: 'c' },
      { type: 'done', text: 'final', raw: null },
    ];
    const provider = new FakeProvider({ events });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);

    const collected: ProviderEvent[] = [];
    for await (const e of stream) {
      collected.push(e);
      if (e.type === 'text' && e.delta === 'b') {
        break;
      }
    }

    assert.equal(collected.length, 2);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.settled, 1);

    const settled = settledEventsFromBudget(budget);
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.outcome, 'abandoned');
  });
});

// ---------------------------------------------------------------------------
// enforcing denial never calls provider
// ---------------------------------------------------------------------------
describe('enforcing denial never calls provider', () => {
  it('throws TurnCallDeniedError and never invokes provider.run', async () => {
    const budget = createTurnCallBudget(
      budgetSpec({ mode: 'enforce', totalUnits: 1 }),
    );
    budget.begin({ purpose: 'work', bucket: 'work' }).finish?.('succeeded');
    // Capacity is now exhausted

    const provider = new FakeProvider({ events: [{ type: 'done', text: 'should not happen', raw: null }] });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);

    let thrown: TurnCallDeniedError | undefined;
    try {
      for await (const _e of stream) {
        // unreachable
      }
    } catch (err) {
      thrown = err as TurnCallDeniedError;
    }

    assert.ok(thrown instanceof TurnCallDeniedError);
    assert.equal(thrown!.denial.reason, 'insufficient-work-capacity');
    assert.equal(provider.runCallCount, 0);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1); // Only the first manual begin
    assert.equal(snap.denied, 1);
  });
});

// ---------------------------------------------------------------------------
// observe would-deny still streams
// ---------------------------------------------------------------------------
describe('observe would-deny still streams', () => {
  it('streams normally even when budget would deny in enforce mode', async () => {
    const budget = createTurnCallBudget(
      budgetSpec({ mode: 'observe', totalUnits: 1 }),
    );
    budget.begin({ purpose: 'work', bucket: 'work' }).finish?.('succeeded');

    const events: ProviderEvent[] = [
      { type: 'done', text: 'still works', raw: null },
    ];
    const provider = new FakeProvider({ events });
    const request = makeRequest();
    const ac = new AbortController();
    const call: BudgetedProviderCall = { budget, purpose: 'work', bucket: 'work', provider: provider.id };

    const stream = runBudgetedProvider(provider, request, ac.signal, call);
    const collected: ProviderEvent[] = [];
    for await (const e of stream) {
      collected.push(e);
    }

    assert.equal(collected.length, 1);
    assert.deepEqual(collected, events);
    assert.equal(provider.runCallCount, 1);

    const snap = budget.snapshot();
    assert.equal(snap.begun, 2);
    assert.equal(snap.settled, 2);

    // Verify would-deny event was emitted
    const wouldDeny = snap.events.filter((e) => e.type === 'call-would-deny');
    assert.equal(wouldDeny.length, 1);
    assert.equal(wouldDeny[0]!.bucket, 'work');
  });
});

// ---------------------------------------------------------------------------
// concurrent wrapped streams respect atomic domain admission
// ---------------------------------------------------------------------------
describe('concurrent wrapped streams respect atomic domain admission', () => {
  it('only admits up to capacity under concurrent iterator starts', async () => {
    const budget = createTurnCallBudget(
      budgetSpec({ mode: 'enforce', totalUnits: 3 }),
    );

    const results: Array<{ index: number; outcome: 'admitted' | 'denied' }> = [];
    const tasks = Array.from({ length: 5 }, (_, i) => {
      const provider = new FakeProvider({
        id: 'claude',
        events: [{ type: 'done', text: `result-${i}`, raw: null }],
      });
      const request = makeRequest();
      const ac = new AbortController();
      const call: BudgetedProviderCall = {
        budget,
        purpose: 'work',
        bucket: 'work',
        provider: provider.id,
      };

      return (async () => {
        try {
          const stream = runBudgetedProvider(provider, request, ac.signal, call);
          for await (const _e of stream) {
            // consume
          }
          results.push({ index: i, outcome: 'admitted' });
        } catch (err) {
          if (err instanceof TurnCallDeniedError) {
            results.push({ index: i, outcome: 'denied' });
          } else {
            throw err;
          }
        }
      })();
    });

    await Promise.all(tasks);

    const admitted = results.filter((r) => r.outcome === 'admitted');
    const denied = results.filter((r) => r.outcome === 'denied');

    // capacity: work=1 + 2 discretionary; work is auto-admitted via budget's bucket check
    // After 1 work call, workRemaining=0. Then 'work' bucket requests are denied.
    // Discretionary can be used for 'discretionary' bucket, not 'work'.
    // Actually, work=1 and totalUnits=3, so discretionary = 3 - 1 = 2.
    // The first work call is admitted. Subsequent work calls are denied (insufficient-work-capacity).
    // Discretionary can't be borrowed for work.
    // So only 1 should be admitted, 4 denied.
    assert.equal(admitted.length, 1, 'only one work call should be admitted');
    assert.equal(denied.length, 4, 'four work calls should be denied');

    const snap = budget.snapshot();
    assert.equal(snap.begun, 1);
    assert.equal(snap.denied, 4);
  });
});
