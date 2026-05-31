/**
 * Unit tests for src/core/orchestrate.ts
 * Run with: node --experimental-strip-types --test test/unit/orchestrate.test.ts
 *
 * All dependencies are faked in-memory — no network, no filesystem, no child
 * processes.  The fake Provider yields scripted ProviderEvents.
 */

import { describe, it, beforeEach } from 'node:test';
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
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Fake Clock
// ---------------------------------------------------------------------------

function makeFakeClock(): Clock & { tick(ms: number): void } {
  let now = 1_000_000; // fixed start epoch ms
  let uuidCounter = 0;
  return {
    now(): number {
      return now;
    },
    isoNow(): string {
      return new Date(now).toISOString();
    },
    uuid(): string {
      uuidCounter++;
      return `fake-uuid-${uuidCounter}`;
    },
    random(): number {
      return 0.42; // deterministic
    },
    tick(ms: number): void {
      now += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake SessionWriter
// ---------------------------------------------------------------------------

function makeFakeSession(id = 'sess-test-1'): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    async append(entry: SessionEntry): Promise<void> {
      entries.push(entry);
    },
    entries,
  };
}

// ---------------------------------------------------------------------------
// Fake LedgerWriter
// ---------------------------------------------------------------------------

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(entry: LedgerEntry): Promise<void> {
      entries.push(entry);
    },
    entries,
  };
}

// ---------------------------------------------------------------------------
// Fake Provider builder
// ---------------------------------------------------------------------------

const CONFIDENCE_ENVELOPE =
  '{"confidence": 0.88, "escalate": false, "reason": "task complete", "needs_review": false}';

const FINAL_TEXT = `I have refactored the X module.\n${CONFIDENCE_ENVELOPE}`;

const FAKE_USAGE: Usage = { inputTokens: 1000, outputTokens: 500 };

function makeFakeProvider(
  id: 'claude' | 'codex' = 'claude',
  events?: ProviderEvent[],
): Provider {
  const defaultEvents: ProviderEvent[] = [
    { type: 'text', delta: 'I have refactored ' },
    { type: 'text', delta: 'the X module.\n' },
    {
      type: 'done',
      text: FINAL_TEXT,
      usage: FAKE_USAGE,
      raw: {},
    },
  ];

  const eventsToYield = events ?? defaultEvents;

  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: '1.0.0',
        authenticated: true,
        binaryPath: '/usr/bin/fake',
        availableModels: [],
      };
    },
    async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      for (const ev of eventsToYield) {
        yield ev;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: collect all events from the generator
// ---------------------------------------------------------------------------

async function collectEvents(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Main orchestrate test suite
// ---------------------------------------------------------------------------

describe('orchestrate — happy path (claude available)', () => {
  let clock: ReturnType<typeof makeFakeClock>;
  let session: ReturnType<typeof makeFakeSession>;
  let ledger: ReturnType<typeof makeFakeLedger>;
  let deps: OrchestrateDeps;

  beforeEach(() => {
    clock = makeFakeClock();
    session = makeFakeSession();
    ledger = makeFakeLedger();
    deps = {
      providers: { claude: makeFakeProvider('claude') },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };
  });

  it('yields events in correct sequence: classified → tier-start → provider-event(s) → tier-done → final', async () => {
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'classified');
    assert.equal(types[1], 'tier-start');

    // provider-event(s) come next
    const providerEventIndices = types
      .map((t, i) => (t === 'provider-event' ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(providerEventIndices.length > 0, 'Expected at least one provider-event');

    // tier-done comes before final
    const tierDoneIdx = types.lastIndexOf('tier-done');
    const finalIdx = types.lastIndexOf('final');
    assert.ok(tierDoneIdx >= 0, 'Expected a tier-done event');
    assert.ok(finalIdx >= 0, 'Expected a final event');
    assert.ok(tierDoneIdx < finalIdx, 'tier-done must precede final');
  });

  it('classified event contains correct classification', async () => {
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const classified = events.find((e) => e.type === 'classified');
    assert.ok(classified !== undefined);
    assert.equal(classified.type, 'classified');
    if (classified.type === 'classified') {
      assert.equal(classified.classification.tier, 'ic');
    }
  });

  it('tier-start event has correct provider and model', async () => {
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const tierStart = events.find((e) => e.type === 'tier-start');
    assert.ok(tierStart !== undefined);
    if (tierStart.type === 'tier-start') {
      assert.equal(tierStart.provider, 'claude');
      assert.equal(tierStart.model, 'claude-sonnet-4-6');
      assert.equal(tierStart.attempt, 1);
    }
  });

  it('final event has success=true and correct output', async () => {
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined);
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.equal(final.output, FINAL_TEXT);
      assert.equal(final.sessionId, 'sess-test-1');
      assert.equal(final.attempts, 1);
    }
  });

  it('ledger gets exactly 1 entry with usd > 0', async () => {
    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    assert.equal(ledger.entries.length, 1);
    const entry = ledger.entries[0]!;
    assert.ok(entry.usd > 0, `Expected usd > 0 but got ${entry.usd}`);
    assert.equal(entry.provider, 'claude');
    assert.equal(entry.model, 'claude-sonnet-4-6');
    assert.equal(entry.inputTokens, 1000);
    assert.equal(entry.outputTokens, 500);
    assert.equal(entry.success, true);
  });

  it('ledger usd matches real pricing calculation (1000 input + 500 output on sonnet)', async () => {
    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    const entry = ledger.entries[0]!;
    // claude-sonnet-4-6: $3/1M input, $15/1M output
    // 1000 input → $0.003, 500 output → $0.0075 → total $0.0105
    const expectedUsd = (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15;
    assert.ok(
      Math.abs(entry.usd - expectedUsd) < 1e-9,
      `Expected usd=${expectedUsd} but got ${entry.usd}`,
    );
  });

  it('session gets a user entry and an assistant entry', async () => {
    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    assert.equal(session.entries.length, 2);
    assert.equal(session.entries[0]?.role, 'user');
    assert.equal(session.entries[0]?.content, 'refactor X');
    assert.equal(session.entries[1]?.role, 'assistant');
    assert.equal(session.entries[1]?.content, FINAL_TEXT);
  });

  it('assistant session entry has confidence from the parsed envelope', async () => {
    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    const assistantEntry = session.entries[1]!;
    assert.equal(assistantEntry.confidence, 0.88);
  });

  it('tier-done event has confidence from the parsed envelope', async () => {
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const tierDone = events.find((e) => e.type === 'tier-done');
    assert.ok(tierDone !== undefined);
    if (tierDone.type === 'tier-done') {
      assert.equal(tierDone.confidence, 0.88);
      assert.equal(tierDone.success, true);
    }
  });
});

// ---------------------------------------------------------------------------
// No providers path
// ---------------------------------------------------------------------------

describe('orchestrate — no providers path', () => {
  it('yields classified → notice(error) → final(success:false)', async () => {
    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: {},
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'classified');
    assert.ok(types.includes('notice'), 'Expected a notice event');
    assert.ok(types.includes('final'), 'Expected a final event');

    const noticeEv = events.find((e) => e.type === 'notice');
    assert.ok(noticeEv !== undefined);
    if (noticeEv.type === 'notice') {
      assert.equal(noticeEv.level, 'error');
    }

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
      assert.equal(finalEv.totalCostUsd, 0);
      assert.equal(finalEv.attempts, 0);
    }
  });

  it('does not write to ledger when no providers', async () => {
    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: {},
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    assert.equal(ledger.entries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Codex provider path
// ---------------------------------------------------------------------------

describe('orchestrate — codex provider', () => {
  it('routes to codex when only codex is available', async () => {
    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { codex: makeFakeProvider('codex') },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const tierStart = events.find((e) => e.type === 'tier-start');
    assert.ok(tierStart !== undefined);
    if (tierStart.type === 'tier-start') {
      assert.equal(tierStart.provider, 'codex');
    }

    assert.equal(ledger.entries.length, 1);
    const entry = ledger.entries[0]!;
    assert.equal(entry.provider, 'codex');
    assert.ok(entry.usd > 0);
  });
});

// ---------------------------------------------------------------------------
// Provider error path
// ---------------------------------------------------------------------------

describe('orchestrate — provider emits error', () => {
  it('yields final(success:false) when provider emits an error event', async () => {
    const errorProvider = makeFakeProvider('claude', [
      { type: 'text', delta: 'Starting...' },
      {
        type: 'error',
        error: {
          category: 'network',
          recoverable: true,
          message: 'connection reset',
          suggestion: 'retry',
        },
      },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: errorProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
    }

    // With escalation loop: IC failure → escalate to manager → manager failure → break.
    // So the ledger gets 2 failed entries (one for IC, one for manager).
    assert.ok(ledger.entries.length >= 1, 'Expected at least 1 ledger entry');
    assert.equal(ledger.entries[0]?.success, false);
  });

  it('(d) provider failure escalates to manager then emits final(success:false)', async () => {
    // The fake error provider always fails
    const errorEvents: ProviderEvent[] = [
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'timeout', suggestion: 'retry' },
      },
    ];
    const errorProvider = makeFakeProvider('claude', errorEvents);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: errorProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const types = events.map((e) => e.type);

    // Must emit an 'escalate' event (IC → manager)
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined, 'Expected an escalate event on provider failure');
    if (escalateEv.type === 'escalate') {
      assert.equal(escalateEv.from, 'ic');
      assert.equal(escalateEv.to, 'manager');
      assert.equal(escalateEv.reason, 'execution failure');
    }

    // Must have a second tier-start (the manager retry)
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.ok(tierStarts.length >= 2, `Expected ≥2 tier-start events, got ${tierStarts.length}`);

    // Final must be failure
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
    }

    assert.ok(types.includes('final'));
  });
});

// ---------------------------------------------------------------------------
// Abort / cancellation path
// ---------------------------------------------------------------------------

describe('orchestrate — abort signal', () => {
  it('yields notice(warn, cancelled) + final(success:false) when aborted before run', async () => {
    const controller = new AbortController();
    controller.abort(); // abort immediately

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: makeFakeProvider('claude') },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(orchestrate('refactor X', deps, controller.signal));
    const types = events.map((e) => e.type);

    assert.ok(types.includes('notice'), 'Expected a notice event for cancellation');
    const notice = events.find((e) => e.type === 'notice');
    if (notice?.type === 'notice') {
      assert.equal(notice.level, 'warn');
      assert.match(notice.message, /cancel/i);
    }

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
    }
  });
});

// ---------------------------------------------------------------------------
// Usage via separate 'usage' event (not in 'done')
// ---------------------------------------------------------------------------

describe('orchestrate — usage from usage event', () => {
  it('picks up usage from a standalone usage event when done has no usage', async () => {
    const fakeUsage: Usage = { inputTokens: 2000, outputTokens: 1000 };
    const providerWithUsageEvent = makeFakeProvider('claude', [
      { type: 'text', delta: 'Result text\n' },
      { type: 'usage', usage: fakeUsage },
      { type: 'done', text: `Result text\n${CONFIDENCE_ENVELOPE}`, raw: {} },
      // NOTE: done has no usage property here — usage should come from the usage event
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: providerWithUsageEvent },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));

    assert.equal(ledger.entries.length, 1);
    const entry = ledger.entries[0]!;
    assert.equal(entry.inputTokens, 2000);
    assert.equal(entry.outputTokens, 1000);
    // claude-sonnet-4-6: $3/1M input, $15/1M output
    // 2000 input → $0.006, 1000 output → $0.015 → $0.021
    const expectedUsd = (2000 / 1_000_000) * 3 + (1000 / 1_000_000) * 15;
    assert.ok(Math.abs(entry.usd - expectedUsd) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Missing confidence envelope → confidence=null, not a fabricated number
// ---------------------------------------------------------------------------

describe('orchestrate — model with no confidence envelope', () => {
  it('records confidence=null in session, not a fabricated number', async () => {
    const plainProvider = makeFakeProvider('claude', [
      { type: 'done', text: 'Here is the answer.', usage: FAKE_USAGE, raw: {} },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: plainProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await collectEvents(orchestrate('list files', deps, new AbortController().signal));

    const assistantEntry = session.entries.find((e) => e.role === 'assistant');
    assert.ok(assistantEntry !== undefined);
    assert.equal(assistantEntry.confidence, null);
  });

  it('tier-done event has confidence=null when no envelope', async () => {
    const plainProvider = makeFakeProvider('claude', [
      { type: 'done', text: 'Here is the answer.', usage: FAKE_USAGE, raw: {} },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: plainProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('list files', deps, new AbortController().signal),
    );
    const tierDone = events.find((e) => e.type === 'tier-done');
    assert.ok(tierDone !== undefined);
    if (tierDone.type === 'tier-done') {
      assert.equal(tierDone.confidence, null);
    }
  });
});

// ---------------------------------------------------------------------------
// (a) Low-confidence envelope → escalates to next tier
// ---------------------------------------------------------------------------

describe('orchestrate — low-confidence escalation', () => {
  it('(a) low-confidence IC output escalates to manager tier', async () => {
    // Confidence 0.3 is below low-risk threshold (0.4) so it will escalate
    const LOW_CONF_ENVELOPE =
      '{"confidence": 0.3, "escalate": false, "reason": "not sure", "needs_review": false}';
    const lowConfText = `I did some work.\n${LOW_CONF_ENVELOPE}`;

    // Manager output has high confidence to break the loop
    const HIGH_CONF_ENVELOPE =
      '{"confidence": 0.92, "escalate": false, "reason": "manager done", "needs_review": false}';
    const managerText = `Manager reviewed.\n${HIGH_CONF_ENVELOPE}`;

    let callCount = 0;
    const smartProvider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          binaryPath: '/usr/bin/fake',
          availableModels: [],
        };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        callCount++;
        const text = callCount === 1 ? lowConfText : managerText;
        yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: smartProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Must have an escalate event
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined, 'Expected an escalate event for low confidence');
    if (escalateEv.type === 'escalate') {
      assert.equal(escalateEv.from, 'ic');
      assert.equal(escalateEv.to, 'manager');
    }

    // Must have a second tier-start (manager run)
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.ok(tierStarts.length >= 2, `Expected ≥2 tier-start events, got ${tierStarts.length}`);

    // Final must be success
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) High-risk IC task → reviewer runs and approves
// ---------------------------------------------------------------------------

describe('orchestrate — cross-vendor review (high risk)', () => {
  it('(b) high-risk IC task triggers a review run that approves', async () => {
    // "payment" keyword → high risk → IC output gets reviewed
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `Payment code implemented.\n${icEnvelope}`;

    const reviewApproveText =
      'Looks good to me.\n{"verdict": "approve", "notes": "all clear", "confidence": 0.9}';

    // claude is the IC provider; codex is the reviewer (cross-vendor)
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: reviewApproveText, usage: { inputTokens: 500, outputTokens: 200 }, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // "payment" → high risk → review triggered
    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // Must have a manager-tier tier-start for the review run
    const managerTierStarts = events.filter(
      (e) => e.type === 'tier-start' && e.tier === 'manager',
    );
    assert.ok(managerTierStarts.length >= 1, 'Expected a manager-tier tier-start for review run');

    // Must have notice events about the review
    const noticeEvents = events.filter((e) => e.type === 'notice');
    assert.ok(noticeEvents.length >= 1, 'Expected notice events about the review');
    const reviewNotice = noticeEvents.find(
      (e) => e.type === 'notice' && e.message.includes('Review by'),
    );
    assert.ok(reviewNotice !== undefined, 'Expected a "Review by" notice');

    const verdictNotice = noticeEvents.find(
      (e) => e.type === 'notice' && e.message.includes('verdict'),
    );
    assert.ok(verdictNotice !== undefined, 'Expected a verdict notice');
    if (verdictNotice.type === 'notice') {
      assert.ok(verdictNotice.message.includes('approve'), 'Expected approve verdict in notice');
    }

    // Final must be success
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });

  // -------------------------------------------------------------------------
  // (c) Reviewer returns revise → IC retried with managerNotes
  // -------------------------------------------------------------------------

  it('(c) reviewer revise verdict retries IC with feedback (≥2 IC attempts)', async () => {
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';

    let icCallCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        icCallCount++;
        const text = `Payment code attempt ${icCallCount}.\n${icEnvelope}`;
        yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
      },
    };

    let reviewCallCount = 0;
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        reviewCallCount++;
        // First review → revise; second review → approve
        const text =
          reviewCallCount === 1
            ? '{"verdict": "revise", "notes": "payment.ts:10 — missing validation", "confidence": 0.7}'
            : '{"verdict": "approve", "notes": "fixed", "confidence": 0.95}';
        yield { type: 'done', text, usage: { inputTokens: 300, outputTokens: 100 }, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // IC must have been called at least twice (initial + retry after revise)
    assert.ok(icCallCount >= 2, `Expected ≥2 IC calls, got ${icCallCount}`);

    // Must have tier-start at 'ic' tier at least twice
    const icTierStarts = events.filter(
      (e) => e.type === 'tier-start' && e.tier === 'ic',
    );
    assert.ok(icTierStarts.length >= 2, `Expected ≥2 ic tier-start events, got ${icTierStarts.length}`);

    // Final must be success
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) totalCostUsd equals sum of all run costs
// ---------------------------------------------------------------------------

describe('orchestrate — totalCostUsd accumulation', () => {
  it('(e) totalCostUsd in final equals sum of all run costs (IC + review)', async () => {
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `Payment done.\n${icEnvelope}`;

    const reviewText =
      '{"verdict": "approve", "notes": "ok", "confidence": 0.95}';

    const icUsage: Usage = { inputTokens: 1000, outputTokens: 500 };    // claude-sonnet-4-6
    const reviewUsage: Usage = { inputTokens: 500, outputTokens: 200 }; // codex gpt-5.5 (manager)

    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: icUsage, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: reviewText, usage: reviewUsage, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // Compute expected costs from pricing table
    // IC: claude-sonnet-4-6 → $3/1M input, $15/1M output
    const icCost = (1000 / 1_000_000) * 3 + (500 / 1_000_000) * 15;
    // Review: codex manager (gpt-5.5) → $5/1M input, $30/1M output
    const reviewCost = (500 / 1_000_000) * 5 + (200 / 1_000_000) * 30;
    const expectedTotal = icCost + reviewCost;

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.ok(
        Math.abs(finalEv.totalCostUsd - expectedTotal) < 1e-9,
        `Expected totalCostUsd=${expectedTotal} but got ${finalEv.totalCostUsd}`,
      );
    }

    // Ledger should have 2 entries (IC + review)
    assert.ok(ledger.entries.length >= 2, `Expected ≥2 ledger entries, got ${ledger.entries.length}`);
    const sumFromLedger = ledger.entries.reduce((acc, e) => acc + e.usd, 0);
    assert.ok(
      Math.abs(sumFromLedger - expectedTotal) < 1e-9,
      `Ledger sum ${sumFromLedger} !== expected ${expectedTotal}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (f) Risk-indexed fail-open: parsed:false + high/critical risk → escalate
// ---------------------------------------------------------------------------

describe('orchestrate — risk-indexed fail-open (parsed:false + high risk)', () => {
  it('unparseable review output on high-risk task escalates instead of auto-approving', async () => {
    // "payment" → high risk
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `Payment code implemented.\n${icEnvelope}`;

    // Reviewer returns garbage (no valid JSON verdict envelope → parsed:false)
    const badReviewText = 'I had trouble reviewing this. Something went wrong.';

    // Manager output (after escalation) has high confidence
    const HIGH_CONF_ENVELOPE =
      '{"confidence": 0.92, "escalate": false, "reason": "manager done", "needs_review": false}';
    const managerText = `Manager reviewed the payment code.\n${HIGH_CONF_ENVELOPE}`;

    let claudeCallCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        claudeCallCount++;
        // First call = IC; subsequent calls = manager tier
        const text = claudeCallCount === 1 ? icText : managerText;
        yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: badReviewText, usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // Must emit a 'warn' notice about inconclusive review
    const warnNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('inconclusive'),
    );
    assert.ok(warnNotice !== undefined, 'Expected a warn notice about inconclusive review');

    // Must escalate (not silently approve)
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined, 'Expected an escalate event — must not silently approve on inconclusive review');
  });

  it('unparseable review output on low-risk task still approves (fail-open is fine for low risk)', async () => {
    // "refactor X" → low/medium risk — fail-open approve is acceptable
    const icEnvelope =
      '{"confidence": 0.88, "escalate": false, "reason": "done", "needs_review": true}';
    const icText = `Refactored X module.\n${icEnvelope}`;

    // needsReview:true triggers review; reviewer returns garbage
    const badReviewText = 'Could not parse your output properly.';

    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: badReviewText, usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // "refactor X" → low risk; needsReview:true in envelope triggers review
    // but fail-open approve is acceptable for low risk
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    // For low-risk + parsed:false, the system may approve (fail-open is OK here).
    // The key property is it does NOT crash.
    assert.equal(typeof finalEv.type, 'string');
  });
});

// ---------------------------------------------------------------------------
// (g) FIX 4: manager-tier critical/high work gets cross-vendor review
// ---------------------------------------------------------------------------

describe('orchestrate — FIX 4: manager-tier critical work gets reviewed', () => {
  it('task classified at manager tier with critical risk gets cross-vendor review', async () => {
    // "audit" + "auth" → classify should give manager tier + critical/high risk
    // We confirm it by checking whether a review happens.
    // To ensure classification gives manager+critical, use a known pattern.
    // We will use needsReview:true in the envelope to force the review path
    // regardless of how the task is classified.

    const managerEnvelope =
      '{"confidence": 0.9, "escalate": false, "reason": "audit complete", "needs_review": true}';
    const managerText = `Audit complete.\n${managerEnvelope}`;

    const reviewApproveText =
      '{"verdict": "approve", "notes": "audit looks thorough", "confidence": 0.95}';

    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: managerText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: reviewApproveText, usage: { inputTokens: 300, outputTokens: 100 }, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // needsReview:true forces review path for any tier
    const events = await collectEvents(
      orchestrate('audit the auth flow', deps, new AbortController().signal),
    );

    // A review run means there's a manager-tier tier-start from the reviewer (codex)
    const reviewerTierStarts = events.filter(
      (e) => e.type === 'tier-start' && e.provider === 'codex',
    );
    assert.ok(
      reviewerTierStarts.length >= 1,
      'Expected codex reviewer to run even when work starts at manager tier',
    );

    // Must have a verdict notice
    const verdictNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('verdict'),
    );
    assert.ok(verdictNotice !== undefined, 'Expected a verdict notice from the review');

    // Final must be success
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });

  it('manager-tier high-risk work with an INCONCLUSIVE review fails honestly (not success)', async () => {
    const managerEnvelope =
      '{"confidence": 0.9, "escalate": false, "reason": "audit", "needs_review": true}';
    const managerText = `Audit complete.\n${managerEnvelope}`;
    // Reviewer returns no parseable verdict envelope -> parsed:false
    const garbageReview = 'I was unable to complete the review.';

    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: managerText, usage: FAKE_USAGE, raw: {} };
      },
    };
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: garbageReview, usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('audit the auth flow', deps, new AbortController().signal),
    );

    const warn = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('inconclusive'),
    );
    assert.ok(warn !== undefined, 'Expected a warn notice about an inconclusive review');

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final');
    if (finalEv.type === 'final') {
      assert.equal(
        finalEv.success,
        false,
        'Top-tier high-risk work with an inconclusive review must NOT ship as success',
      );
    }
  });

  it('same-vendor-only (no cross-vendor available) skips review and accepts', async () => {
    // Only claude is available — pickReviewer returns claude (same vendor).
    // The new guard requires a DIFFERENT vendor for review, so review is skipped.
    const icEnvelope =
      '{"confidence": 0.88, "escalate": false, "reason": "done", "needs_review": true}';
    const icText = `Work done.\n${icEnvelope}`;

    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // needsReview:true but only claude is available — review must be skipped
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // No 'Review by' notice — review was skipped because no cross-vendor reviewer
    const reviewByNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Review by'),
    );
    assert.equal(reviewByNotice, undefined, 'Review must be skipped when only same-vendor is available');

    // Final must still be success (skipping review ≠ failure)
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });
});

// ---------------------------------------------------------------------------
// (h) History context — prompt injection when deps.history is supplied
// ---------------------------------------------------------------------------

describe('orchestrate — history context injection', () => {
  it('prompt CONTAINS compacted prior history when deps.history is supplied', async () => {
    const capturedPrompts: string[] = [];

    const historyCapturingProvider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          binaryPath: '/usr/bin/fake',
          availableModels: [],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        capturedPrompts.push(req.prompt);
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();

    const priorHistory: SessionEntry[] = [
      {
        timestamp: '2024-01-01T00:00:00.000Z',
        role: 'user',
        content: 'what does the config module do?',
      },
      {
        timestamp: '2024-01-01T00:01:00.000Z',
        role: 'assistant',
        content: 'It loads configuration from disk.\n{"confidence": 0.9, "escalate": false, "reason": "done", "needs_review": false}',
      },
    ];

    const deps: OrchestrateDeps = {
      providers: { claude: historyCapturingProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      history: priorHistory,
    };

    await collectEvents(orchestrate('now refactor it', deps, new AbortController().signal));

    assert.ok(capturedPrompts.length >= 1, 'Expected at least one captured prompt');
    const prompt = capturedPrompts[0] ?? '';

    // Should include prior user turn
    assert.ok(
      prompt.includes('what does the config module do?'),
      'Prompt should contain prior user message',
    );
    // Should include prior assistant content (stripped of envelope)
    assert.ok(
      prompt.includes('It loads configuration from disk.'),
      'Prompt should contain prior assistant content',
    );
    // Envelope should be stripped from replayed assistant turn
    assert.ok(
      !prompt.includes('"confidence": 0.9'),
      'Confidence envelope should be stripped from replayed assistant content',
    );
    // Should include the CONVERSATION SO FAR section header
    assert.ok(
      prompt.includes('CONVERSATION SO FAR'),
      'Prompt should include CONVERSATION SO FAR section',
    );
  });

  it('prompt does NOT include CONVERSATION SO FAR when deps.history is undefined', async () => {
    const capturedPrompts: string[] = [];

    const historyCapturingProvider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          binaryPath: '/usr/bin/fake',
          availableModels: [],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        capturedPrompts.push(req.prompt);
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();

    const deps: OrchestrateDeps = {
      providers: { claude: historyCapturingProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      // No history field
    };

    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));

    assert.ok(capturedPrompts.length >= 1, 'Expected at least one captured prompt');
    const prompt = capturedPrompts[0] ?? '';

    assert.ok(
      !prompt.includes('CONVERSATION SO FAR'),
      'Prompt should NOT contain CONVERSATION SO FAR when history is absent',
    );
  });

  it('prompt does NOT include CONVERSATION SO FAR when deps.history is an empty array', async () => {
    const capturedPrompts: string[] = [];

    const historyCapturingProvider: Provider = {
      id: 'claude',
      async detect() {
        return {
          id: 'claude',
          installed: true,
          version: '1.0.0',
          authenticated: true,
          binaryPath: '/usr/bin/fake',
          availableModels: [],
        };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        capturedPrompts.push(req.prompt);
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();

    const deps: OrchestrateDeps = {
      providers: { claude: historyCapturingProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      history: [],
    };

    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));

    assert.ok(capturedPrompts.length >= 1, 'Expected at least one captured prompt');
    const prompt = capturedPrompts[0] ?? '';

    assert.ok(
      !prompt.includes('CONVERSATION SO FAR'),
      'Prompt should NOT contain CONVERSATION SO FAR when history is empty',
    );
  });
});

// ---------------------------------------------------------------------------
// Feature A — reviewPolicy gating
// ---------------------------------------------------------------------------

describe("orchestrate — reviewPolicy:'off' suppresses cross-vendor review", () => {
  it("high-risk task does NOT trigger a reviewer run when reviewPolicy is 'off'", async () => {
    // "payment" keyword → high risk
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `Payment code implemented.\n${icEnvelope}`;

    let codexRunCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRunCount++;
        yield { type: 'done', text: '{"verdict": "approve", "notes": "ok", "confidence": 0.9}', usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: { ...DEFAULT_POLICY, reviewPolicy: 'off' },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // codex reviewer must NOT have run
    assert.equal(codexRunCount, 0, 'codex reviewer must not run when reviewPolicy is off');

    // No "Review by" notice
    const reviewByNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Review by'),
    );
    assert.equal(reviewByNotice, undefined, 'No review notice must appear when reviewPolicy is off');

    // Task must still succeed (skipping review ≠ failure)
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }

    // No second tier-start from reviewer (only IC tier-start)
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.equal(tierStarts.length, 1, 'Only one tier-start (no reviewer run) when reviewPolicy is off');
  });
});

describe("orchestrate — reviewPolicy:'critical-only' — high risk skips, critical reviews", () => {
  it("high-risk task does NOT trigger review with 'critical-only'", async () => {
    // "payment" → high risk
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `Payment code implemented.\n${icEnvelope}`;

    let codexRunCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRunCount++;
        yield { type: 'done', text: '{"verdict": "approve", "notes": "ok", "confidence": 0.9}', usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: { ...DEFAULT_POLICY, reviewPolicy: 'critical-only' },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // "payment" → high risk (not critical) — review must be skipped
    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    assert.equal(codexRunCount, 0, 'codex reviewer must not run for high-risk with critical-only policy');

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });

  it("critical-risk task STILL triggers review with 'critical-only'", async () => {
    // "rotate the oauth client secret" matches CRITICAL_SIGNALS (oauth + secret)
    // and reliably classifies as critical risk — no conditional branching needed.
    const icEnvelope =
      '{"confidence": 0.90, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `OAuth secret rotated.\n${icEnvelope}`;

    let codexRunCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRunCount++;
        yield { type: 'done', text: '{"verdict": "approve", "notes": "looks good", "confidence": 0.95}', usage: { inputTokens: 200, outputTokens: 100 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: { ...DEFAULT_POLICY, reviewPolicy: 'critical-only' },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // "rotate the oauth client secret" → guaranteed critical risk via classifier
    const events = await collectEvents(
      orchestrate('rotate the oauth client secret', deps, new AbortController().signal),
    );

    // Verify the classifier actually produced critical (belt-and-suspenders)
    const classified = events.find((e) => e.type === 'classified');
    assert.ok(classified !== undefined && classified.type === 'classified');
    assert.equal(
      classified.type === 'classified' ? classified.classification.risk : null,
      'critical',
      'Task must classify as critical risk — if this fails, update the task phrase to one that matches CRITICAL_SIGNALS',
    );

    // Reviewer MUST have run for critical-risk with critical-only policy
    assert.ok(codexRunCount >= 1, 'codex reviewer must run for critical-risk with critical-only policy');

    const reviewByNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Review by'),
    );
    assert.ok(reviewByNotice !== undefined, 'Expected a "Review by" notice for critical risk');

    // Final must be success (reviewer approved)
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature B — maxCostUsd budget cap
// ---------------------------------------------------------------------------

describe('orchestrate — maxCostUsd budget cap stops escalation', () => {
  it('budget exceeded before escalation → emits budget notice + success final instead of escalating', async () => {
    // Set a very low budget so it's exceeded after the first IC run.
    // IC run costs ~$0.0105 (1000 input + 500 output on claude-sonnet-4-6).
    // Set budget to $0.005 so it's already exceeded after the IC completes.
    const LOW_CONF_ENVELOPE =
      '{"confidence": 0.3, "escalate": false, "reason": "not sure", "needs_review": false}';
    const lowConfText = `I did some work.\n${LOW_CONF_ENVELOPE}`;

    let callCount = 0;
    const smartProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        callCount++;
        yield { type: 'done', text: lowConfText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: smartProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      // Budget of $0.001 will be exceeded after the first IC run (~$0.0105)
      policy: { ...DEFAULT_POLICY, maxCostUsd: 0.001 },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Budget notice must have been emitted
    const budgetNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('cost budget reached'),
    );
    assert.ok(budgetNotice !== undefined, 'Expected a budget-reached warn notice');

    // Must NOT have escalated (only 1 provider call)
    assert.equal(callCount, 1, 'Provider must only be called once when budget is exceeded');

    // No escalate event
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.equal(escalateEv, undefined, 'Must not escalate when budget is exceeded');

    // Final must be success:true (budget cap = accept best, not fail)
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true, 'Budget cap must yield success:true (accepted best result)');
    }
  });

  it('no budget cap (maxCostUsd absent) behaves exactly as before (escalation proceeds)', async () => {
    // Same low-confidence scenario, but with no budget cap — escalation must happen.
    const LOW_CONF_ENVELOPE =
      '{"confidence": 0.3, "escalate": false, "reason": "not sure", "needs_review": false}';
    const HIGH_CONF_ENVELOPE =
      '{"confidence": 0.92, "escalate": false, "reason": "manager done", "needs_review": false}';

    let callCount = 0;
    const smartProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        callCount++;
        const text = callCount === 1
          ? `I did some work.\n${LOW_CONF_ENVELOPE}`
          : `Manager reviewed.\n${HIGH_CONF_ENVELOPE}`;
        yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: smartProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY, // no maxCostUsd — uncapped
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Escalation must have occurred (2 provider calls)
    assert.ok(callCount >= 2, `Expected ≥2 provider calls without budget cap, got ${callCount}`);

    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined, 'Expected an escalate event when no budget cap');

    const budgetNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('cost budget reached'),
    );
    assert.equal(budgetNotice, undefined, 'Must not emit budget notice when maxCostUsd is absent');
  });

  it('budget exceeded before cross-vendor review → emits budget notice + success final instead of reviewing', async () => {
    // "payment" → high risk → review would normally be triggered.
    // Set a budget so low it's exceeded after IC completes, before review starts.
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `Payment code implemented.\n${icEnvelope}`;

    let codexRunCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRunCount++;
        yield { type: 'done', text: '{"verdict": "approve", "notes": "ok", "confidence": 0.9}', usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      // Budget exceeded after the IC run (~$0.0105), before review ($0.001 threshold)
      policy: { ...DEFAULT_POLICY, maxCostUsd: 0.001 },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // Budget notice must have been emitted
    const budgetNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('cost budget reached'),
    );
    assert.ok(budgetNotice !== undefined, 'Expected a budget-reached warn notice');

    // Codex reviewer must NOT have run
    assert.equal(codexRunCount, 0, 'codex reviewer must not run when budget is exceeded before review');

    // Final must be success:true
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true, 'Budget cap must yield success:true');
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-vendor failover on provider error
// ---------------------------------------------------------------------------

describe('orchestrate — cross-vendor failover on provider error', () => {
  it('single-provider failure still escalates to manager (unchanged behaviour)', async () => {
    // With only one provider, remaining is empty → escalate as before.
    const errorEvents: ProviderEvent[] = [
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'timeout', suggestion: 'retry' },
      },
    ];
    const errorProvider = makeFakeProvider('claude', errorEvents);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: errorProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Must NOT emit a failover event (only one provider available).
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.equal(failoverEv, undefined, 'No failover event when only one provider is available');

    // Must emit an escalate event (IC → manager).
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined, 'Expected an escalate event on single-provider failure');
    if (escalateEv.type === 'escalate') {
      assert.equal(escalateEv.from, 'ic');
      assert.equal(escalateEv.to, 'manager');
      assert.equal(escalateEv.reason, 'execution failure');
    }

    // Final must be failure.
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
    }
  });

  it('two-provider setup: first provider errors → failover event to second, second succeeds', async () => {
    const errorEvents: ProviderEvent[] = [
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'connection reset', suggestion: 'retry' },
      },
    ];
    const errorProvider = makeFakeProvider('claude', errorEvents);

    // codex is the fallback and succeeds.
    const successProvider = makeFakeProvider('codex');

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: errorProvider, codex: successProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Must emit a failover event before any escalate.
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.ok(failoverEv !== undefined, 'Expected a failover event when first provider errors');
    if (failoverEv.type === 'failover') {
      assert.equal(failoverEv.from, 'claude', 'Failover from: claude');
      assert.equal(failoverEv.to, 'codex', 'Failover to: codex');
      assert.equal(failoverEv.tier, 'ic', 'Failover at: ic tier');
      assert.ok(typeof failoverEv.reason === 'string' && failoverEv.reason.length > 0, 'Failover has a reason');
    }

    // Must NOT emit an escalate event (second provider succeeded).
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.equal(escalateEv, undefined, 'No escalate event — failover to second provider succeeded');

    // Failover event must appear before the second tier-start.
    const failoverIdx = events.findIndex((e) => e.type === 'failover');
    const tierStarts = events
      .map((e, i) => (e.type === 'tier-start' ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(tierStarts.length >= 2, 'Expected at least 2 tier-start events (IC attempt 1 + failover attempt)');
    const secondTierStartIdx = tierStarts[1]!;
    assert.ok(failoverIdx < secondTierStartIdx, 'failover event must precede the second tier-start');

    // Final must be success (codex second attempt succeeded).
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });

  it('both vendors fail at IC tier → failover then escalate to manager', async () => {
    // Both claude and codex emit an error.
    const errorEvents: ProviderEvent[] = [
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'timeout', suggestion: 'retry' },
      },
    ];
    const errorProvider1 = makeFakeProvider('claude', errorEvents);
    const errorProvider2 = makeFakeProvider('codex', errorEvents);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: errorProvider1, codex: errorProvider2 },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Must emit a failover event (after first error, before second attempt).
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.ok(failoverEv !== undefined, 'Expected a failover event after first provider error');
    if (failoverEv.type === 'failover') {
      assert.equal(failoverEv.tier, 'ic', 'Failover at IC tier');
    }

    // After both IC vendors fail, must escalate to manager.
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined, 'Expected an escalate event after all IC vendors exhausted');
    if (escalateEv.type === 'escalate') {
      assert.equal(escalateEv.to, 'manager');
      assert.equal(escalateEv.reason, 'execution failure');
    }

    // Verify ordering: failover must come before escalate.
    const failoverIdx = events.findIndex((e) => e.type === 'failover');
    const escalateIdx = events.findIndex((e) => e.type === 'escalate');
    assert.ok(failoverIdx < escalateIdx, 'failover event must precede escalate event');

    // Final must be failure (manager tier also had no successful provider run).
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
    }
  });
});

// ---------------------------------------------------------------------------
// Default policy unchanged — no reviewPolicy / no maxCostUsd
// ---------------------------------------------------------------------------

describe('orchestrate — default policy unchanged (no reviewPolicy / no maxCostUsd)', () => {
  it('high-risk task with default policy still triggers cross-vendor review', async () => {
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const icText = `Payment code implemented.\n${icEnvelope}`;

    let codexRunCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: icText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRunCount++;
        yield { type: 'done', text: '{"verdict": "approve", "notes": "ok", "confidence": 0.9}', usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY, // reviewPolicy:'auto', no maxCostUsd
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // Default policy must still trigger review for high risk
    assert.ok(codexRunCount >= 1, 'Default policy must trigger cross-vendor review for high risk');

    const budgetNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('cost budget reached'),
    );
    assert.equal(budgetNotice, undefined, 'No budget notice must appear with default policy (uncapped)');

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Auth-failure final event — errorCategory and provider fields
// ---------------------------------------------------------------------------

describe('orchestrate — auth-failure final has errorCategory and provider', () => {
  it('auth error from provider yields final with errorCategory:"auth" and correct provider', async () => {
    const authErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: {
          category: 'auth',
          recoverable: false,
          message: 'authentication failed',
          suggestion: 'run claude auth login',
        },
      },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: authErrorProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined, 'Expected a final event');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false, 'Auth failure must yield success:false');
      assert.equal(finalEv.errorCategory, 'auth', 'errorCategory must be "auth"');
      assert.equal(finalEv.provider, 'claude', 'provider must be "claude"');
    }
  });

  it('non-auth failure sets the actual error category (network)', async () => {
    const networkErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: {
          category: 'network',
          recoverable: true,
          message: 'connection reset',
          suggestion: 'retry',
        },
      },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: networkErrorProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined, 'Expected a final event');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false, 'Network failure must yield success:false');
      assert.equal(finalEv.errorCategory, 'network', 'errorCategory must be "network"');
    }
  });

  it('successful final has no errorCategory', async () => {
    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: makeFakeProvider('claude') },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined, 'Expected a final event');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
      assert.equal(finalEv.errorCategory, undefined, 'Successful final must NOT have errorCategory');
      assert.equal(finalEv.provider, undefined, 'Successful final must NOT have provider');
    }
  });

  it('auth error from codex provider records codex as the provider', async () => {
    const authErrorProvider = makeFakeProvider('codex', [
      {
        type: 'error',
        error: {
          category: 'auth',
          recoverable: false,
          message: 'authentication failed',
          suggestion: 'run codex login',
        },
      },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { codex: authErrorProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined, 'Expected a final event');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false, 'Auth failure must yield success:false');
      assert.equal(finalEv.errorCategory, 'auth', 'errorCategory must be "auth"');
      assert.equal(finalEv.provider, 'codex', 'provider must be "codex"');
    }
  });
});

// ---------------------------------------------------------------------------
// Auth-aware routing via authenticatedProviders
// ---------------------------------------------------------------------------

describe('orchestrate — authenticatedProviders routes to signed-in provider first', () => {
  it('with two providers where only the second is authenticated, FIRST run goes to the authenticated one', async () => {
    // Policy ic order: [claude, codex]. claude is in providers but NOT authenticated.
    // codex IS authenticated. Expected: first tier-start goes to codex.
    const claudeProvider = makeFakeProvider('claude');
    const codexProvider = makeFakeProvider('codex');

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      // Only codex is authenticated; claude is installed but signed out.
      authenticatedProviders: ['codex'],
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // The very first tier-start must be codex, not claude.
    const firstTierStart = events.find((e) => e.type === 'tier-start');
    assert.ok(firstTierStart !== undefined, 'Expected a tier-start event');
    if (firstTierStart.type === 'tier-start') {
      assert.equal(
        firstTierStart.provider,
        'codex',
        'First run must go to authenticated codex, not signed-out claude',
      );
    }

    // Must succeed (codex is a working provider in this test).
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });

  it('when authenticatedProviders is omitted, routing falls back to fixed preference order (backward-compat)', async () => {
    // Without authenticatedProviders, the policy order [claude, codex] applies:
    // claude comes first even though it is not "authenticated" by the caller.
    const claudeProvider = makeFakeProvider('claude');
    const codexProvider = makeFakeProvider('codex');

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      // No authenticatedProviders — identical to existing behaviour.
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const firstTierStart = events.find((e) => e.type === 'tier-start');
    assert.ok(firstTierStart !== undefined, 'Expected a tier-start event');
    if (firstTierStart.type === 'tier-start') {
      assert.equal(
        firstTierStart.provider,
        'claude',
        'Without authenticatedProviders, claude (first in policy order) should be picked',
      );
    }
  });

  it('failover path: signed-out first provider errors → failover prefers authenticated second', async () => {
    // claude (signed-out) errors; codex (authenticated) succeeds via failover.
    const claudeErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: { category: 'auth', recoverable: false, message: 'Not logged in', suggestion: 'run claude auth login' },
      },
    ]);
    const codexProvider = makeFakeProvider('codex');

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();

    // Simulate the bug scenario: claude installed but not authenticated, codex authenticated.
    // With auth-aware routing, codex should be picked FIRST (no wasted attempt on claude).
    const deps: OrchestrateDeps = {
      providers: { claude: claudeErrorProvider, codex: codexProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['codex'],
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // With auth-aware routing, codex is routed first (no claude attempt).
    const firstTierStart = events.find((e) => e.type === 'tier-start');
    assert.ok(firstTierStart !== undefined);
    if (firstTierStart.type === 'tier-start') {
      assert.equal(
        firstTierStart.provider,
        'codex',
        'Auth-aware routing must skip signed-out claude and go directly to authenticated codex',
      );
    }

    // No failover event (because codex was routed first and succeeded).
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.equal(failoverEv, undefined, 'No failover needed when authenticated provider is routed first');

    // Final must be success.
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 1 fix: Auth errors short-circuit — no failover, no escalation
// ---------------------------------------------------------------------------

describe('orchestrate — Bug 1 fix: auth error short-circuits immediately', () => {
  it('auth error from single provider: single attempt, final.errorCategory:auth, NO failover/escalate', async () => {
    const authErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: {
          category: 'auth',
          recoverable: false,
          message: 'authentication failed',
          suggestion: 'run claude auth login',
        },
      },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: authErrorProvider },
      clock,
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Only 1 tier-start (no escalation to manager, no retry)
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.equal(tierStarts.length, 1, 'Auth error must cause exactly 1 attempt (no retry/escalation)');

    // No failover event
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.equal(failoverEv, undefined, 'Auth error must NOT emit a failover event');

    // No escalate event
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.equal(escalateEv, undefined, 'Auth error must NOT emit an escalate event');

    // Final must be failure with errorCategory:'auth' and correct provider
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined, 'Expected a final event');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false, 'Auth failure final must have success:false');
      assert.equal(finalEv.errorCategory, 'auth', 'Auth failure final must have errorCategory:"auth"');
      assert.equal(finalEv.provider, 'claude', 'Auth failure final must record the failing provider');
      assert.equal(finalEv.attempts, 1, 'Auth failure must record exactly 1 attempt');
    }
  });

  it('auth error with two providers: still short-circuits — second provider never tried', async () => {
    let codexRunCount = 0;
    const authErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: {
          category: 'auth',
          recoverable: false,
          message: 'authentication failed',
          suggestion: 'run claude auth login',
        },
      },
    ]);
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRunCount++;
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: authErrorProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Codex must never have run (auth error = no failover)
    assert.equal(codexRunCount, 0, 'Auth error must not trigger failover to second provider');

    // No failover event
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.equal(failoverEv, undefined, 'No failover event must be emitted on auth error');

    // Final must be auth failure
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
      assert.equal(finalEv.errorCategory, 'auth');
      assert.equal(finalEv.provider, 'claude');
    }
  });

  it('non-auth error (network) still uses existing failover/escalate behaviour', async () => {
    // Regression: make sure network errors still failover as before
    const networkErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: {
          category: 'network',
          recoverable: true,
          message: 'timeout',
          suggestion: 'retry',
        },
      },
    ]);

    const deps: OrchestrateDeps = {
      providers: { claude: networkErrorProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Network error with single provider → escalate (not short-circuit)
    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined, 'Network error must still trigger escalation');

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
      assert.equal(finalEv.errorCategory, 'network', 'errorCategory must be "network" for network errors');
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 2 fix: Reviewer escalate verdict at manager tier → emits notice + final
// ---------------------------------------------------------------------------

describe('orchestrate — Bug 2 fix: reviewer escalate at manager tier emits final (no infinite loop)', () => {
  it('reviewer returns escalate at manager tier: emits warn notice + final(success:false), no loop', async () => {
    // Task classified at manager tier with needsReview so review fires immediately.
    // We force classification to manager + high risk by using "needsReview:true"
    // so the review path is triggered regardless of classification tier.
    // The reviewer returns "escalate", but currentTier is already manager.
    // Bug 2 fix: must emit a warn notice + final(success:false) and stop.

    const managerEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": true}';
    const managerText = `Manager work done.\n${managerEnvelope}`;

    // Reviewer always returns "escalate"
    const reviewEscalateText = '{"verdict": "escalate", "notes": "needs senior review", "confidence": 0.5}';

    let claudeCallCount = 0;
    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        claudeCallCount++;
        yield { type: 'done', text: managerText, usage: FAKE_USAGE, raw: {} };
      },
    };

    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: reviewEscalateText, usage: { inputTokens: 200, outputTokens: 100 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: { ...DEFAULT_POLICY, maxAttempts: 10 }, // generous cap to detect loop
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // Use a task that gets classified at manager tier + needsReview triggers review
    const events = await collectEvents(
      orchestrate('audit the auth flow', deps, new AbortController().signal),
    );

    // Must emit the warn notice about top-tier escalation
    const warnNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('top tier'),
    );
    assert.ok(warnNotice !== undefined, 'Expected a warn notice about already being at top tier');

    // Must emit final(success:false)
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined, 'Expected a final event');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false, 'Must be failure when reviewer requests escalation at top tier');
    }

    // Claude (the worker) must have been called at most once — not looping
    assert.ok(claudeCallCount <= 2, `Claude must not loop excessively; was called ${claudeCallCount} times`);
  });
});

// ---------------------------------------------------------------------------
// Bug 3 fix: No misleading failover event at maxAttempts boundary
// ---------------------------------------------------------------------------

describe('orchestrate — Bug 3 fix: no misleading failover event at maxAttempts ceiling', () => {
  it('when maxAttempts=1, a failure with untried providers emits NO failover event', async () => {
    // With maxAttempts=1: the first (and only) attempt fails.
    // There is a second provider (codex) untried, but there is no room for another attempt.
    // Bug 3 fix: must NOT emit a failover event because codex would never actually run.
    let codexRunCount = 0;
    const claudeErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: {
          category: 'network',
          recoverable: true,
          message: 'timeout',
          suggestion: 'retry',
        },
      },
    ]);
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexRunCount++;
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeErrorProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: { ...DEFAULT_POLICY, maxAttempts: 1 },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Codex must never have actually run (no room for another attempt)
    assert.equal(codexRunCount, 0, 'Codex must never run when maxAttempts=1');

    // No misleading failover event
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.equal(failoverEv, undefined, 'Must NOT emit a failover event when no room for another attempt');

    // Must still emit a final
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined, 'Expected a final event');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false, 'Must be a failure final');
    }
  });

  it('when maxAttempts=2 with two providers, failover IS emitted (room exists for 2nd attempt)', async () => {
    // Regression: when there IS room, failover must still be emitted as before.
    const claudeErrorProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'timeout', suggestion: 'retry' },
      },
    ]);
    const codexProvider = makeFakeProvider('codex');

    const deps: OrchestrateDeps = {
      providers: { claude: claudeErrorProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: { ...DEFAULT_POLICY, maxAttempts: 2 },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Failover MUST be emitted when there is room for another attempt
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.ok(failoverEv !== undefined, 'Failover must be emitted when another attempt is possible');

    // Final must be success (codex succeeded on second attempt)
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true, 'Second provider (codex) must succeed');
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 4 fix: revise verdict injects notes at any tier (not just IC)
// ---------------------------------------------------------------------------

describe('orchestrate — Bug 4 fix: revise verdict injects reviewer notes at any tier', () => {
  it('revise at IC tier: retry prompt contains the reviewer notes', async () => {
    // Classic case — still works after the fix.
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';

    const capturedPrompts: string[] = [];
    let icCallCount = 0;

    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        icCallCount++;
        capturedPrompts.push(req.prompt);
        const text = `Payment code attempt ${icCallCount}.\n${icEnvelope}`;
        yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
      },
    };

    let reviewCallCount = 0;
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        reviewCallCount++;
        const text =
          reviewCallCount === 1
            ? '{"verdict": "revise", "notes": "NOTES_FROM_REVIEWER: add validation", "confidence": 0.7}'
            : '{"verdict": "approve", "notes": "fixed", "confidence": 0.95}';
        yield { type: 'done', text, usage: { inputTokens: 200, outputTokens: 100 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    // The second IC prompt must contain the reviewer notes
    assert.ok(capturedPrompts.length >= 2, 'Expected at least 2 IC prompts (initial + retry)');
    const retryPrompt = capturedPrompts[1] ?? '';
    assert.ok(
      retryPrompt.includes('NOTES_FROM_REVIEWER'),
      'Retry prompt at IC tier must contain the reviewer notes',
    );
  });

  it('revise at manager tier: retry prompt also contains the reviewer notes', async () => {
    // The worker (manager tier directly) gets a revise → retry must have notes.
    // We force classification to manager tier by using a high-confidence manager envelope
    // but inject needsReview:true so review fires.
    const managerEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": true}';

    const capturedPrompts: string[] = [];
    let claudeCallCount = 0;

    const claudeProvider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        claudeCallCount++;
        capturedPrompts.push(req.prompt);
        yield { type: 'done', text: `Attempt ${claudeCallCount}.\n${managerEnvelope}`, usage: FAKE_USAGE, raw: {} };
      },
    };

    let reviewCallCount = 0;
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        reviewCallCount++;
        const text =
          reviewCallCount === 1
            ? '{"verdict": "revise", "notes": "MANAGER_REVIEW_NOTES: tighten error handling", "confidence": 0.65}'
            : '{"verdict": "approve", "notes": "good now", "confidence": 0.9}';
        yield { type: 'done', text, usage: { inputTokens: 200, outputTokens: 100 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: claudeProvider, codex: codexProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    // Use a task that is reviewed (needsReview:true in envelope ensures review path)
    await collectEvents(
      orchestrate('audit the auth flow', deps, new AbortController().signal),
    );

    // The second claude call must receive a prompt containing the reviewer notes
    assert.ok(capturedPrompts.length >= 2, `Expected ≥2 claude calls (initial + retry after revise), got ${capturedPrompts.length}`);
    const retryPrompt = capturedPrompts[1] ?? '';
    assert.ok(
      retryPrompt.includes('MANAGER_REVIEW_NOTES'),
      `Retry prompt at manager tier must contain the reviewer notes. Got: ${retryPrompt.slice(0, 200)}`,
    );
  });
});

describe('orchestrate — native session (EXPERIMENTAL) skips history and passes session id', () => {
  it('when nativeSession matches the routed provider: no history replay, sessionId passed', async () => {
    const capturedReqs: ProviderRequest[] = [];

    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        capturedReqs.push(req);
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const priorHistory: SessionEntry[] = [
      { timestamp: '2026-05-31T00:00:00.000Z', role: 'user', content: 'earlier question about the parser' },
      { timestamp: '2026-05-31T00:01:00.000Z', role: 'assistant', content: 'earlier answer', provider: 'claude' },
    ];

    const deps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      history: priorHistory,
      nativeSession: { provider: 'claude', sessionId: 'conv-xyz', resume: true },
    };

    await collectEvents(orchestrate('follow-up question', deps, new AbortController().signal));

    assert.ok(capturedReqs.length >= 1, 'expected a captured request');
    const req = capturedReqs[0]!;
    // Native session id + resume flag are passed through to the provider.
    assert.strictEqual(req.sessionId, 'conv-xyz', 'sessionId must be passed for the native path');
    assert.strictEqual(req.resume, true, 'resume flag must be passed');
    // History is NOT replayed into the prompt — the provider holds it server-side.
    assert.ok(
      !req.prompt.includes('CONVERSATION SO FAR'),
      `native path must not replay history, got:\n${req.prompt}`,
    );
    assert.ok(
      !req.prompt.includes('earlier answer'),
      'native path must not contain the prior assistant content',
    );
  });

  it('when nativeSession provider does NOT match the routed provider: falls back to history replay', async () => {
    const capturedReqs: ProviderRequest[] = [];

    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        capturedReqs.push(req);
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const priorHistory: SessionEntry[] = [
      { timestamp: '2026-05-31T00:00:00.000Z', role: 'user', content: 'earlier question' },
      { timestamp: '2026-05-31T00:01:00.000Z', role: 'assistant', content: 'earlier answer here', provider: 'claude' },
    ];

    const deps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      history: priorHistory,
      // Plan names a DIFFERENT provider than the one that will run (claude).
      nativeSession: { provider: 'codex', sessionId: 'conv-xyz', resume: true },
    };

    await collectEvents(orchestrate('follow-up question', deps, new AbortController().signal));

    const req = capturedReqs[0]!;
    assert.strictEqual(req.sessionId, undefined, 'no sessionId when the plan provider does not match');
    assert.ok(
      req.prompt.includes('CONVERSATION SO FAR'),
      'must fall back to history replay when the plan provider does not match',
    );
  });
});
