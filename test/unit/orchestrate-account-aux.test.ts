/**
 * test/unit/orchestrate-account-aux.test.ts — account-aux end-to-end tests
 * for orchestrate(). Verifies intentVersionId correlation and off-flag byte-identity.
 */

import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { orchestrate } from '../../src/core/orchestrate.ts';
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
import type { Provider, ProviderRequest, ProviderEvent } from '../../src/providers/port.ts';

function makeFakeClock(): Clock & { tick(ms: number): void } {
  let now = 1_000_000;
  let uuidCounter = 0;
  return {
    now(): number { return now; },
    isoNow(): string { return new Date(now).toISOString(); },
    uuid(): string { uuidCounter++; return `fake-uuid-${uuidCounter}`; },
    random(): number { return 0.42; },
    tick(ms: number): void { now += ms; },
  };
}

/**
 * A provider that echoes back a valid intent frame + returns a short plain answer,
 * so the turn completes cleanly with a work call ledger entry.
 */
function answeringProvider(id: string): Provider {
  return {
    id: id as Provider['id'],
    async detect() {
      return { id: id as Provider['id'], installed: true, version: '1.0', authenticated: true, plan: null, binaryPath: null, availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (req.prompt.includes('You extract the INTENT')) {
        yield {
          type: 'done',
          text: '{"goal":"ship the thing","kind":"coding","confidence":"high"}',
          raw: {},
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      } else {
        yield { type: 'partial', text: 'ok here is the answer', partial: 'ok here' };
        yield {
          type: 'done',
          text: 'ok here is the answer',
          raw: {},
          usage: { inputTokens: 200, outputTokens: 100 },
        };
      }
    },
  };
}

describe('orchestrate account aux', () => {
  let clock: ReturnType<typeof makeFakeClock>;
  let sessionEntries: SessionEntry[];
  let ledger: LedgerEntry[];
  const fakeSession: SessionWriter = {
    id: 'sess-1',
    append: async (e) => { sessionEntries.push(e); },
  };
  const fakeLedger: LedgerWriter = {
    record: async (e) => { ledger.push(e); },
  };

  beforeEach(() => {
    clock = makeFakeClock();
    sessionEntries = [];
    ledger = [];
  });

  function buildDeps(accountAux: boolean): OrchestrateDeps {
    const intentVersionId = accountAux ? clock.uuid() : undefined;
    return {
      clock,
      session: fakeSession,
      ledger: fakeLedger,
      policy: DEFAULT_POLICY,
      providers: { claude: answeringProvider('claude') },
      cwd: '/tmp/project',
      sandbox: 'workspace-write',
      timeoutMs: 20_000,
      intentExtractor: undefined,
      routeClassifier: undefined,
      ...(accountAux && intentVersionId !== undefined ? { accountAux: true, intentVersionId } : {}),
    };
  }

  /**
   * Consumes the generator and returns the set of events. The deps used are
   * mutable (clock), so call orchestrate directly.
   */
  async function drain(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
    const events: CoreEvent[] = [];
    for await (const ev of gen) events.push(ev);
    return events;
  }

  it('account aux off leaves work ledger entries without stage or intentVersionId', async () => {
    // Run a simple worker turn — the rules classify it as worker,
    // no route classifier, no intent extractor → quick path, one work call.
    const deps = buildDeps(false);
    deps.policy = { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } };
    const signal = new AbortController();
    const gen = orchestrate('hello', deps, signal.signal);
    await drain(gen);

    // Filter ledger entries from the work call (stage-less).
    const workEntries = ledger.filter((e) => e.tier === 'worker' || e.tier === 'ic' || e.tier === 'manager');
    for (const e of workEntries) {
      assert.equal(e.stage, undefined, 'work entry should have no stage when aux is off');
      assert.equal(e.intentVersionId, undefined, 'work entry should have no intentVersionId when aux is off');
    }
    // At least the user message and one work call should have been recorded.
    assert.ok(ledger.length >= 1, 'expected at least one ledger entry');
  });

  it('account aux on correlates intent and work ledger entries with one intentVersionId', async () => {
    // Wire a real intent extractor that the fake provider handles.
    const { makeIntentExtractor } = await import('../../src/core/intent-extractor.ts');
    const intentExtractor = makeIntentExtractor({
      providers: { claude: answeringProvider('claude') },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      accountAux: true,
      ledger: fakeLedger,
      clock,
      sessionId: 'sess-1',
    });

    const deps = buildDeps(true);
    deps.intentExtractor = intentExtractor as NonNullable<OrchestrateDeps['intentExtractor']>;
    // Use a multi-clause/long task so shouldExtractIntent fires the intent pass.
    const task = 'please implement a new user login flow that handles multi-factor authentication and also supports password reset via email and SMS';
    deps.policy = { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } };

    const signal = new AbortController();
    const gen = orchestrate(task, deps, signal.signal);
    await drain(gen);

    // There should be an intent entry (stage=intent) and at least one work entry (stage=work).
    const intentEntries = ledger.filter((e) => e.stage === 'intent');
    const workEntries = ledger.filter((e) => e.stage === 'work');

    assert.ok(intentEntries.length >= 1, 'expected at least one intent entry');
    assert.ok(workEntries.length >= 1, 'expected at least one work entry');

    // All entries from this turn should share the same intentVersionId.
    const allIds = new Set(ledger.map((e) => e.intentVersionId).filter(Boolean));
    assert.equal(allIds.size, 1, 'all ledger entries should share the same intentVersionId');
  });
});
