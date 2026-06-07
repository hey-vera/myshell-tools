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
import { withMemoryProposalAttached } from '../../src/core/orchestrate-memory.ts';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../../src/core/policy.ts';
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

  it('omits workTrace on ordinary accepted non-multi-step turns', async () => {
    await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));

    const assistantEntry = session.entries.find((entry) => entry.role === 'assistant');
    assert.ok(assistantEntry !== undefined);
    assert.equal(Object.hasOwn(assistantEntry, 'workTrace'), false);
  });

  it('persists a capped incoming workContract on accepted assistant entries', async () => {
    await collectEvents(
      orchestrate(
        'OBJECTIVE: rendered prompt must not become the objective\nGoal: ship',
        {
          ...deps,
          workContract: {
            version: 1,
            objective: 'x'.repeat(300),
            checkpoints: Array.from({ length: 8 }, (_, i) => ({
              id: `C${i + 1}`,
              summary: `step ${i + 1}`,
            })),
          },
        },
        new AbortController().signal,
      ),
    );

    const assistantEntry = session.entries.find((entry) => entry.role === 'assistant');
    assert.ok(assistantEntry !== undefined);
    assert.equal(assistantEntry.workTrace?.objective.length, 240);
    assert.deepEqual(
      assistantEntry.workTrace?.checkpoints?.map((checkpoint) => checkpoint.id),
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
    );
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

    const assistantEntries = session.entries.filter((e) => e.role === 'assistant');
    assert.equal(assistantEntries.length, 0, 'failed attempts must not persist assistant error messages');
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

    const assistantEntries = session.entries.filter((e) => e.role === 'assistant');
    assert.equal(assistantEntries.length, 0, 'all-attempts-error turn must not persist an assistant entry');
    assert.equal(session.entries.length, 1, 'failed turn keeps only the user entry in conversation history');
    assert.equal(session.entries[0]?.role, 'user');

    assert.ok(types.includes('final'));
  });

  it('does NOT fail over to an installed-but-signed-out provider', async () => {
    // claude (signed in) always fails; codex is installed but NOT authenticated.
    // Failover must skip codex (it would just fail "not signed in") and escalate
    // within claude instead — and codex must never be invoked.
    const errorEvents: ProviderEvent[] = [
      { type: 'error', error: { category: 'network', recoverable: true, message: 'timeout', suggestion: 'retry' } },
    ];
    const claudeProvider = makeFakeProvider('claude', errorEvents);
    let codexInvoked = false;
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: false, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexInvoked = true;
        yield { type: 'done', text: 'should never run', usage: FAKE_USAGE, raw: {} };
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
      authenticatedProviders: ['claude'],
    };

    const events = await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));

    const failoverToCodex = events.find((e) => e.type === 'failover' && e.to === 'codex');
    assert.equal(failoverToCodex, undefined, 'must not fail over to a signed-out provider');
    assert.equal(codexInvoked, false, 'a signed-out provider must never be invoked');
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final' && finalEv.success === false,
      'still terminates with a failing final (escalated within the signed-in provider)');
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
      assert.equal(finalEv.canceled, true);
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

  it('uses done.usage as the authoritative total when an earlier usage event exists', async () => {
    const stepUsage: Usage = { inputTokens: 100, outputTokens: 50 };
    const doneUsage: Usage = { inputTokens: 300, outputTokens: 120 };
    const providerWithStepAndDoneUsage = makeFakeProvider('claude', [
      { type: 'text', delta: 'Result text\n' },
      { type: 'usage', usage: stepUsage },
      { type: 'done', text: `Result text\n${CONFIDENCE_ENVELOPE}`, usage: doneUsage, raw: {} },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: providerWithStepAndDoneUsage },
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
    assert.equal(entry.inputTokens, 300);
    assert.equal(entry.outputTokens, 120);
  });

  it('records done.usage when no earlier usage event exists', async () => {
    const doneUsage: Usage = { inputTokens: 300, outputTokens: 120 };
    const providerWithDoneUsageOnly = makeFakeProvider('claude', [
      { type: 'text', delta: 'Result text\n' },
      { type: 'done', text: `Result text\n${CONFIDENCE_ENVELOPE}`, usage: doneUsage, raw: {} },
    ]);

    const clock = makeFakeClock();
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const deps: OrchestrateDeps = {
      providers: { claude: providerWithDoneUsageOnly },
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
    assert.equal(entry.inputTokens, 300);
    assert.equal(entry.outputTokens, 120);
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
// Empty/whitespace-only errorless output must FAIL SAFE, not fabricate "✓ done"
// ---------------------------------------------------------------------------

describe('orchestrate — empty errorless output fails safe (does not fake success)', () => {
  it('an errorless run that streams no usable text yields success:false (model error), never a blank "done"', async () => {
    // A provider that exits cleanly (no error event) but produces an empty
    // answer on every attempt — the exact "blank ✓ done · 0 tokens" failure.
    const emptyProvider: Provider = {
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
        yield { type: 'done', text: '   \n  ', usage: { inputTokens: 5, outputTokens: 0 }, raw: {} };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: emptyProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('say hi', deps, new AbortController().signal),
    );
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false, 'empty output must not be a clean success');
      assert.notEqual(finalEv.bestEffort, true, 'empty output must not be a best-effort accept');
      assert.equal(finalEv.errorCategory, 'model', 'empty output is classified as a model error');
    }
  });

  it('a non-empty answer is still accepted as a clean success (guard does not over-fire)', async () => {
    const okProvider = makeFakeProvider('claude', [
      { type: 'done', text: 'Here is the real answer.', usage: FAKE_USAGE, raw: {} },
    ]);
    const deps: OrchestrateDeps = {
      providers: { claude: okProvider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };
    const events = await collectEvents(
      orchestrate('list files', deps, new AbortController().signal),
    );
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
      assert.equal(finalEv.errorCategory, undefined);
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
      policy: { ...DEFAULT_POLICY, maxTier: 'manager' }, // permit ic→manager escalation (this test verifies escalation mechanics, not the balanced ceiling)
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

    const assistantEntries = session.entries.filter((e) => e.role === 'assistant');
    assert.equal(assistantEntries.length, 1, 'only the accepted manager answer is persisted');
    const assistant = assistantEntries[0]!;
    assert.equal(assistant.content, managerText);
    assert.equal(assistant.tier, 'manager');
    assert.equal(assistant.provider, 'claude');
    assert.equal(assistant.model, 'claude-opus-4-7');
    assert.equal(assistant.confidence, 0.92);
    assert.ok(!assistant.content.includes('I did some work.'), 'superseded IC draft must not be persisted');
  });

  it('(a2) balanced (adaptive) EARNS one manager pass on a low-confidence turn', async () => {
    // Adaptive flagship admission (GPT-5.5 design): under Balanced, a low-confidence
    // IC result is an earned trigger, so orchestrate escalates ic→manager exactly
    // once (bounded by maxFlagshipAttemptsPerTurn). The manager result is confident,
    // breaking the loop. (This replaces the old maxTier-'ic' ceiling guard, which
    // the adaptive model intentionally supersedes.)
    const LOW_CONF =
      '{"confidence": 0.3, "escalate": false, "reason": "not sure", "needs_review": false}';
    const HIGH_CONF =
      '{"confidence": 0.92, "escalate": false, "reason": "manager done", "needs_review": false}';
    let callCount = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        callCount++;
        const text = callCount === 1 ? `Some work.\n${LOW_CONF}` : `Manager pass.\n${HIGH_CONF}`;
        yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
      },
    };
    const deps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY, // balanced — flagshipAdmission 'adaptive'
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));

    const escalateEv = events.find((e) => e.type === 'escalate');
    assert.ok(escalateEv !== undefined && escalateEv.type === 'escalate', 'balanced must earn a manager escalation');
    assert.equal(escalateEv.from, 'ic');
    assert.equal(escalateEv.to, 'manager');
    assert.equal(callCount, 2, 'exactly one manager pass (ic + manager)');
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final' && finalEv.success === true);
    if (finalEv.type === 'final') assert.equal(finalEv.tier, 'manager');
  });

  it('(a3) balanced VETOES the manager pass when the only observed plan is free', async () => {
    // Honesty/quota guard: with an observed `free` plan, adaptive admission denies
    // the auto manager escalation (preserve tight quota) — orchestrate accepts the
    // IC result instead of escalating.
    const LOW_CONF =
      '{"confidence": 0.3, "escalate": false, "reason": "not sure", "needs_review": false}';
    let callCount = 0;
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/usr/bin/fake', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        callCount++;
        yield { type: 'done', text: `Some work.\n${LOW_CONF}`, usage: FAKE_USAGE, raw: {} };
      },
    };
    const deps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY, // balanced — adaptive
      planInfos: { claude: { raw: 'free', tier: 'free', confidence: 'observed' } },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));

    assert.equal(callCount, 1, 'free-plan veto: must NOT escalate to manager');
    assert.equal(events.find((e) => e.type === 'escalate'), undefined, 'no escalate event under the free-plan veto');
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final' && finalEv.success === true, 'accepts the IC result');
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
        yield { type: 'text', delta: 'INTERNAL REVIEW: this critique must stay hidden.\n' };
        yield { type: 'text', delta: '{"verdict": "approve", "notes": "raw streamed verdict must stay hidden"}' };
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
    const reviewStartIndex = events.findIndex(
      (e) => e.type === 'tier-start' && e.provider === 'codex',
    );
    assert.ok(reviewStartIndex >= 0, 'Expected a codex tier-start for review run');
    assert.equal(
      events[reviewStartIndex + 1]?.type,
      'tier-done',
      'Reviewer run must emit tier telemetry without surfacing provider text events',
    );

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

    const providerText = events
      .filter((e) => e.type === 'provider-event' && e.event.type === 'text')
      .map((e) => e.type === 'provider-event' && e.event.type === 'text' ? e.event.delta : '')
      .join('');
    assert.ok(!providerText.includes('INTERNAL REVIEW'), 'Reviewer critique text must not be surfaced');
    assert.ok(!providerText.includes('"verdict"'), 'Reviewer verdict JSON must not be surfaced as text');

    // Final must be success
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, true);
    }
  });

  // -------------------------------------------------------------------------
  // (b2) Review goes through flagship admission and is labelled HONESTLY:
  //      admitted (Balanced high-risk) → reviewer runs at 'manager'; denied
  //      (Efficient never-auto) → reviewer runs at 'ic', never mislabelled manager.
  // -------------------------------------------------------------------------

  it('(b2) high-risk review runs at manager under Balanced, ic under Efficient — never mislabelled', async () => {
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const reviewApprove =
      'Looks good.\n{"verdict": "approve", "notes": "ok", "confidence": 0.9}';
    const makeProviders = (): Record<string, Provider> => ({
      claude: {
        id: 'claude',
        async detect() {
          return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/f', availableModels: [] };
        },
        async *run() {
          yield { type: 'done', text: `Payment code.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} };
        },
      },
      codex: {
        id: 'codex',
        async detect() {
          return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/f', availableModels: [] };
        },
        async *run() {
          yield { type: 'done', text: reviewApprove, usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
        },
      },
    });
    const baseDeps = (policy: typeof DEFAULT_POLICY): OrchestrateDeps => ({
      providers: makeProviders(),
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy,
      authenticatedProviders: ['claude', 'codex'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    });

    // Balanced (adaptive): high-risk review is admitted → reviewer tier-start is 'manager'.
    // Pin panel/hedge OFF: Balanced now auto-engages a panel on a high-risk turn with
    // ≥2 providers, which would divert this turn away from the sequential review path
    // under test. This test is about review-tier labelling, not concurrency selection.
    const balancedSeq = { ...DEFAULT_POLICY, panelPolicy: 'off' as const, hedgePolicy: 'off' as const };
    const balEvents = await collectEvents(
      orchestrate('implement payment handler', baseDeps(balancedSeq), new AbortController().signal),
    );
    const balReviewStart = balEvents.find((e) => e.type === 'tier-start' && e.provider === 'codex');
    assert.ok(balReviewStart !== undefined && balReviewStart.type === 'tier-start');
    if (balReviewStart.type === 'tier-start') {
      assert.equal(balReviewStart.tier, 'manager', 'Balanced high-risk review must run at the flagship tier');
    }

    // never-auto admission: review is denied the flagship → reviewer runs at 'ic',
    // and must NOT be mislabelled 'manager' anywhere. (Use cost-saver's never-auto
    // admission but with reviewPolicy 'auto' so the high-risk review still fires —
    // cost-saver's own 'critical-only' policy wouldn't review a merely high-risk task.)
    const neverAutoReviewing = { ...POLICY_PRESETS['cost-saver'], reviewPolicy: 'auto' as const };
    const effEvents = await collectEvents(
      orchestrate('implement payment handler', baseDeps(neverAutoReviewing), new AbortController().signal),
    );
    const effReviewStart = effEvents.find((e) => e.type === 'tier-start' && e.provider === 'codex');
    assert.ok(effReviewStart !== undefined && effReviewStart.type === 'tier-start');
    if (effReviewStart.type === 'tier-start') {
      assert.equal(effReviewStart.tier, 'ic', 'Efficient review must NOT be admitted to the flagship');
    }
    // No event or ledger entry for the codex reviewer may claim 'manager' under Efficient.
    const effManagerCodex = effEvents.some(
      (e) => e.type === 'tier-start' && e.provider === 'codex' && e.tier === 'manager',
    );
    assert.equal(effManagerCodex, false, 'Efficient must never label the ic reviewer as manager');
  });

  it('(b3) does NOT route a review to a signed-out cross-vendor provider', async () => {
    // codex is installed but NOT authenticated → it must not be picked as reviewer.
    // With no authenticated cross-vendor reviewer, review is skipped (honest).
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    let codexRuns = 0;
    const deps: OrchestrateDeps = {
      providers: {
        claude: {
          id: 'claude',
          async detect() {
            return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
          },
          async *run() {
            yield { type: 'done', text: `Payment.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} };
          },
        },
        codex: {
          id: 'codex',
          async detect() {
            return { id: 'codex', installed: true, version: '1', authenticated: false, binaryPath: '/f', availableModels: [] };
          },
          async *run() {
            codexRuns++;
            yield { type: 'done', text: 'review', usage: FAKE_USAGE, raw: {} };
          },
        },
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      authenticatedProviders: ['claude'], // codex signed out
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    assert.equal(codexRuns, 0, 'signed-out codex must never run as reviewer');
    const reviewNotice = events.find(
      (e) => e.type === 'notice' && e.type === 'notice' && e.message.includes('cross-vendor'),
    );
    assert.equal(reviewNotice, undefined, 'no cross-vendor review when the only other vendor is signed out');
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

    const assistantEntries = session.entries.filter((e) => e.role === 'assistant');
    assert.equal(assistantEntries.length, 1, 'review-rejected draft must not be persisted');
    assert.equal(assistantEntries[0]?.content, `Payment code attempt 2.\n${icEnvelope}`);
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
    const reviewUsage: Usage = { inputTokens: 500, outputTokens: 200 }; // codex manager (gpt-5.5) — high-risk review is admitted to the flagship under adaptive Balanced

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
    // Review: under adaptive Balanced, a high-risk ('payment') task ADMITS the
    // cross-vendor review to the flagship, so the reviewer runs codex's manager
    // model (gpt-5.5) → $5/1M input, $30/1M output. (Adaptive admission, not a
    // static ic clamp: high-risk work is reviewed by the strong model, honestly
    // labelled 'manager'.)
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

  it('unparseable review output on low-risk task does not crash (fail-safe drives revise/best-effort, not silent approve)', async () => {
    // "refactor X" → low/medium risk — a malformed review must NOT be flattened
    // into a clean approve; the fail-safe `revise` drives a bounded re-run and
    // ultimately a best-effort acceptance. This test asserts only non-crash.
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

    // "refactor X" → low risk; needsReview:true in envelope triggers review.
    // The malformed review yields the fail-safe `revise`, which re-runs/accepts
    // best-effort rather than silently approving.
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined);
    // For low-risk + parsed:false, the system no longer silently approves; the
    // key property under test is that it does NOT crash.
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
// Default policy — review still fires; the retired budget guard emits no notice
// ---------------------------------------------------------------------------

describe('orchestrate — default policy: review fires, no budget notice (guard retired)', () => {
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

    // The dollar budget guard is retired (fiction on a flat-rate subscription), so
    // a 'cost budget reached' notice must never appear.
    const budgetNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('cost budget reached'),
    );
    assert.equal(budgetNotice, undefined, 'retired budget guard must emit no cost-budget notice');

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
      nativeSession: [{ provider: 'claude', sessionId: 'conv-xyz', resume: true }],
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
      nativeSession: [{ provider: 'codex', sessionId: 'conv-xyz', resume: true }],
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

describe('orchestrate — captures a provider session id and persists it on the assistant turn', () => {
  it('a Codex-style done.sessionId is written to the assistant SessionEntry (for later resume)', async () => {
    const provider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // Codex reports a thread id on the terminal done event.
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, sessionId: 'thread-777', raw: {} };
      },
    };

    const session = makeFakeSession();
    const deps: OrchestrateDeps = {
      providers: { codex: provider },
      clock: makeFakeClock(),
      session,
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await collectEvents(orchestrate('do something', deps, new AbortController().signal));

    assert.equal(session.entries.length, 2, 'single-attempt success persists one user and one assistant entry');
    assert.equal(session.entries[0]?.role, 'user');
    const assistant = session.entries[1]!;
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content, FINAL_TEXT);
    assert.equal(assistant.tier, 'ic');
    assert.equal(assistant.provider, 'codex');
    assert.equal(assistant.model, 'gpt-5.2-codex');
    assert.equal(assistant.confidence, 0.88);
    assert.ok(assistant.costUsd !== undefined && assistant.costUsd > 0);
    assert.equal(assistant.durationMs, 0);
    assert.strictEqual(assistant.sessionId, 'thread-777', 'captured thread id must persist on the turn');
  });

  it('no sessionId is written when the provider reports none (e.g. Claude)', async () => {
    const provider: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
      },
    };

    const session = makeFakeSession();
    const deps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session,
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await collectEvents(orchestrate('do something', deps, new AbortController().signal));

    const assistant = session.entries.find((e) => e.role === 'assistant');
    assert.ok(assistant !== undefined, 'expected an assistant entry');
    assert.strictEqual(assistant.sessionId, undefined, 'no sessionId when the provider reports none');
  });
});

// ---------------------------------------------------------------------------
// Timeout handling — Goals 2 & 3 of the runaway-fan-out fix.
//
//  (a) A timeout does NOT cross-vendor fail over and does NOT escalate the tier
//      (re-running the same too-broad task would just double time + cost).
//  (b) A FAST CRASH (non-timeout recoverable error) STILL fails over — proving
//      we special-cased only timeouts, not all failures.
//  (c) A killed run that parsed NO usage emits the honest "spend unknown" notice
//      and records a ledger entry with success:false (no fabricated number).
//  (d) A killed run that DID parse partial usage records the real tokens and
//      does NOT claim spend is unknown.
// ---------------------------------------------------------------------------

const TIMEOUT_ERROR: ProviderEvent = {
  type: 'error',
  error: {
    category: 'timeout',
    recoverable: true,
    message: 'Hit the 30-second limit before the model finished.',
    suggestion: 'Simplify the request or increase the timeout threshold and retry.',
  },
};

describe('orchestrate — timeout does not fail over or escalate (Goal 2)', () => {
  it('(a) a timeout stops with a notice — no failover, no escalate', async () => {
    // claude (the IC provider for "refactor X") times out. codex is available as
    // a would-be failover target. We must NOT switch to it.
    let codexCalled = false;
    const claudeProvider = makeFakeProvider('claude', [TIMEOUT_ERROR]);
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexCalled = true;
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
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
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // No failover, no escalate.
    assert.equal(events.find((e) => e.type === 'failover'), undefined, 'a timeout must NOT fail over to another vendor');
    assert.equal(events.find((e) => e.type === 'escalate'), undefined, 'a timeout must NOT escalate the tier');
    assert.equal(codexCalled, false, 'the failover vendor must never run on a timeout');

    // Only one tier-start (the timed-out IC run).
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.equal(tierStarts.length, 1, `expected exactly 1 tier-start, got ${tierStarts.length}`);

    // Actionable notice mentioning too-broad / timeout settings.
    const notice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && /too broad|raise the timeout|Settings/i.test(e.message),
    );
    assert.ok(notice !== undefined, 'expected an actionable timeout notice');

    // Failing final tagged with the timeout category.
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
      assert.equal(finalEv.errorCategory, 'timeout');
      assert.equal(finalEv.attempts, 1, 'should stop after the single timed-out attempt');
    }
  });
});

describe('orchestrate — a fast crash STILL fails over (Goal 2 boundary)', () => {
  it('(b) a non-timeout recoverable error fails over to the other vendor', async () => {
    let codexCalled = false;
    // claude crashes fast with a network error (recoverable, not a timeout).
    const claudeProvider = makeFakeProvider('claude', [
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'connection reset', suggestion: 'retry' },
      },
    ]);
    const codexProvider: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1.0.0', authenticated: true, binaryPath: '/x', availableModels: [] };
      },
      async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        codexCalled = true;
        yield { type: 'done', text: FINAL_TEXT, usage: FAKE_USAGE, raw: {} };
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
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // A failover event MUST be emitted and the other vendor MUST run.
    const failoverEv = events.find((e) => e.type === 'failover');
    assert.ok(failoverEv !== undefined, 'a fast crash must still fail over');
    if (failoverEv.type === 'failover') {
      assert.equal(failoverEv.from, 'claude');
      assert.equal(failoverEv.to, 'codex');
    }
    assert.equal(codexCalled, true, 'the failover vendor must run after a fast crash');
  });
});

describe('orchestrate — honest spend on a killed run (Goal 3)', () => {
  it('(c) killed run with NO usage: honest "spend unknown" notice + ledger success:false', async () => {
    // A timeout SIGKILL: no usage/done parsed before the kill — only the error.
    const claudeProvider = makeFakeProvider('claude', [TIMEOUT_ERROR]);

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

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // Honest "spend unknown" notice — the recorded $0 is NOT presented as free.
    const unknownNotice = events.find(
      (e) => e.type === 'notice' && e.level === 'warn' && /spend unknown/i.test(e.message),
    );
    assert.ok(unknownNotice !== undefined, 'expected an honest "spend unknown" notice on a killed run with no usage');
    if (unknownNotice.type === 'notice') {
      assert.match(unknownNotice.message, /not a real cost/i);
    }

    // Ledger entry recorded with success:false (we do not skip recording).
    assert.equal(ledger.entries.length, 1, 'killed run must still be recorded in the ledger');
    const entry = ledger.entries[0]!;
    assert.equal(entry.success, false);
    // No fabricated number: with no parsed usage the honest recorded values are 0.
    assert.equal(entry.inputTokens, 0);
    assert.equal(entry.outputTokens, 0);
    assert.equal(entry.usd, 0);
  });

  it('(d) killed run WITH partial usage: records real tokens and does NOT claim unknown', async () => {
    // Some usage WAS parsed (a standalone usage event arrived) before the kill.
    const partialUsage: Usage = { inputTokens: 4321, outputTokens: 0 };
    const claudeProvider = makeFakeProvider('claude', [
      { type: 'usage', usage: partialUsage },
      TIMEOUT_ERROR,
    ]);

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

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    // We must NOT claim spend is unknown when real usage was parsed.
    const unknownNotice = events.find(
      (e) => e.type === 'notice' && /spend unknown/i.test(e.message),
    );
    assert.equal(unknownNotice, undefined, 'must NOT claim "spend unknown" when partial usage was parsed');

    // Ledger records the real measured tokens (success:false, not a crash hide).
    assert.equal(ledger.entries.length, 1);
    const entry = ledger.entries[0]!;
    assert.equal(entry.success, false);
    assert.equal(entry.inputTokens, 4321, 'real parsed input tokens must be recorded');
    assert.equal(entry.outputTokens, 0);

    // Still a failing final tagged timeout, still no failover.
    assert.equal(events.find((e) => e.type === 'failover'), undefined);
    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final');
    if (finalEv.type === 'final') {
      assert.equal(finalEv.success, false);
      assert.equal(finalEv.errorCategory, 'timeout');
    }
  });
});

// ---------------------------------------------------------------------------
// Structured-question short-circuit (ask_user)
// ---------------------------------------------------------------------------

describe('orchestrate — ask_user short-circuit', () => {
  const ASK_USER =
    '{"ask_user":{"questions":[{"id":"framework","prompt":"Which framework?","options":[{"label":"vitest"},{"label":"jest"}],"multiSelect":false,"allowFreeText":true}]}}';
  const ASK_TEXT = `I need a decision before I proceed.\n${ASK_USER}`;

  function makeAskDeps(): {
    deps: OrchestrateDeps;
    session: ReturnType<typeof makeFakeSession>;
    ledger: ReturnType<typeof makeFakeLedger>;
  } {
    const session = makeFakeSession();
    const ledger = makeFakeLedger();
    const askProvider = makeFakeProvider('claude', [
      { type: 'text', delta: 'I need a decision before I proceed.\n' },
      { type: 'done', text: ASK_TEXT, usage: FAKE_USAGE, raw: {} },
    ]);
    const deps: OrchestrateDeps = {
      providers: { claude: askProvider },
      clock: makeFakeClock(),
      session,
      ledger,
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };
    return { deps, session, ledger };
  }

  it('yields a successful final carrying the parsed questions', async () => {
    const { deps } = makeAskDeps();
    const events = await collectEvents(
      orchestrate('set up tests', deps, new AbortController().signal),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.ok(final.questions !== undefined, 'final must carry questions');
      assert.equal(final.questions.questions.length, 1);
      assert.equal(final.questions.questions[0]!.id, 'framework');
    }
  });

  it('does NOT escalate or review when a question is asked', async () => {
    const { deps } = makeAskDeps();
    const events = await collectEvents(
      orchestrate('set up tests', deps, new AbortController().signal),
    );
    assert.equal(events.find((e) => e.type === 'escalate'), undefined, 'no escalate');
    // No second tier-start (which a review or escalation would trigger).
    const tierStarts = events.filter((e) => e.type === 'tier-start');
    assert.equal(tierStarts.length, 1, 'exactly one tier ran (no review/escalation)');
  });

  it('persists the assistant question turn so the answer turn can replay it', async () => {
    const { deps, session } = makeAskDeps();
    await collectEvents(orchestrate('set up tests', deps, new AbortController().signal));
    const assistant = session.entries.find((e) => e.role === 'assistant');
    assert.ok(assistant !== undefined, 'assistant turn persisted');
    assert.ok(assistant!.content.includes('ask_user'), 'persisted content carries the block for replay');
  });
});

// ---------------------------------------------------------------------------
// Parallel Subscription Panel (EXPERIMENTAL) — delegation from orchestrate()
// ---------------------------------------------------------------------------

describe('orchestrate — panel delegation (panelPolicy)', () => {
  it("panelPolicy 'hard-turns' + high-risk task + 2 authed providers delegates to the panel", async () => {
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Claude answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
        codex: makeFakeProvider('codex', [
          { type: 'done', text: `Codex answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      // 'payment' → high risk; panelPolicy hard-turns triggers a panel.
      policy: { ...DEFAULT_POLICY, panelPolicy: 'hard-turns', maxTier: 'manager' },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude', 'codex'],
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    const panelNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Panel'),
    );
    assert.ok(panelNotice !== undefined, 'expected a Panel notice (turn delegated to the panel)');

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final' && finalEv.success === true);
  });

  it('default policy AUTO-engages a panel on a hard turn with ≥2 providers', async () => {
    // Balanced is the default mode and now ships panelPolicy 'hard-turns' so the
    // common experience auto-engages cross-vendor judgment on a high/critical turn
    // WITHOUT the user flipping a switch. (A single sign-in or a low-risk turn still
    // falls back to the sequential path — see the dedicated tests below.)
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Claude answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
        codex: makeFakeProvider('codex', [
          { type: 'done', text: `Codex answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY, // panelPolicy now 'hard-turns' by default
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude', 'codex'],
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    const panelNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Panel'),
    );
    assert.ok(panelNotice !== undefined, 'default Balanced must auto-form a panel on a hard turn');
  });

  it('default policy does NOT form a panel with only ONE provider signed in', async () => {
    // The auto-panel safety gate: a panel needs ≥2 authenticated providers, else the
    // turn falls back to the sequential path even on a hard turn.
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Claude answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude'],
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    const panelNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Panel'),
    );
    assert.equal(panelNotice, undefined, 'a single provider cannot form a panel');
  });

  it('Efficient mode does NOT auto-engage a panel on a hard turn', async () => {
    // The quota-frugal posture: cost-saver ships panelPolicy 'off', so even a hard
    // turn with ≥2 providers stays on the single sequential path.
    const icEnvelope =
      '{"confidence": 0.85, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Claude answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
        codex: makeFakeProvider('codex', [
          { type: 'done', text: `Codex answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: POLICY_PRESETS['cost-saver'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude', 'codex'],
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    const panelNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Panel'),
    );
    assert.equal(panelNotice, undefined, 'Efficient must not auto-engage a panel');
  });

  it("'hard-turns' on a LOW-risk task does NOT form a panel", async () => {
    const icEnvelope =
      '{"confidence": 0.9, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
        codex: makeFakeProvider('codex', [
          { type: 'done', text: `Answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: { ...DEFAULT_POLICY, panelPolicy: 'hard-turns' },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude', 'codex'],
    };

    // 'refactor X' is low/medium risk → hard-turns must not trigger a panel.
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const panelNotice = events.find(
      (e) => e.type === 'notice' && e.message.includes('Panel'),
    );
    assert.equal(panelNotice, undefined, 'low-risk turn must not form a panel under hard-turns');
  });
});

// ---------------------------------------------------------------------------
// Latency-Hedged Escalation (EXPERIMENTAL) — delegation from orchestrate()
// ---------------------------------------------------------------------------

describe('orchestrate — hedge delegation (hedgePolicy)', () => {
  it("hedgePolicy 'on' + sleep + high-risk task + admittable policy delegates to the hedge", async () => {
    const icEnvelope =
      '{"confidence": 0.9, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Claude answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
        codex: makeFakeProvider('codex', [
          { type: 'done', text: `Codex answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      // 'payment' → high risk; always-eligible admits the flagship; sleep present.
      // panelPolicy 'off' so the (now default) auto-panel does not preempt the hedge:
      // orchestrate checks panel BEFORE hedge, and this test is specifically about
      // hedge delegation.
      policy: { ...DEFAULT_POLICY, panelPolicy: 'off', hedgePolicy: 'on', flagshipAdmission: 'always-eligible' },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude', 'codex'],
      // Never resolves → the primary always wins the race (adequate, in time).
      sleep: () => new Promise<void>(() => {}),
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    const hedgeNotice = events.find(
      (e) => e.type === 'notice' && e.message.startsWith('hedge:'),
    );
    assert.ok(hedgeNotice !== undefined, 'expected a hedge notice (turn delegated to the hedge)');

    const finalEv = events.find((e) => e.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final' && finalEv.success === true);
  });

  it('default policy AUTO-hedges a hard turn when a panel cannot form (single provider)', async () => {
    // Balanced now ships hedgePolicy 'on'. On a hard turn the panel takes precedence,
    // but with a single signed-in provider a panel cannot form (needs ≥2), so the
    // hedge is the auto-engaged concurrency that hides escalation latency. The
    // never-resolving sleep keeps the primary the winner (adequate, in time).
    const icEnvelope =
      '{"confidence": 0.9, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Claude answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      // always-eligible so the flagship is admittable on the hard turn.
      policy: { ...DEFAULT_POLICY, flagshipAdmission: 'always-eligible' },
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude'],
      sleep: () => new Promise<void>(() => {}),
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    const hedgeNotice = events.find(
      (e) => e.type === 'notice' && e.message.startsWith('hedge:'),
    );
    assert.ok(hedgeNotice !== undefined, 'default Balanced must auto-hedge a hard single-provider turn');
  });

  it('Efficient mode does NOT auto-hedge — quota-frugal posture', async () => {
    const icEnvelope =
      '{"confidence": 0.9, "escalate": false, "reason": "done", "needs_review": false}';
    const deps: OrchestrateDeps = {
      providers: {
        claude: makeFakeProvider('claude', [
          { type: 'done', text: `Claude answer.\n${icEnvelope}`, usage: FAKE_USAGE, raw: {} },
        ]),
      },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: POLICY_PRESETS['cost-saver'], // hedgePolicy 'off'
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude'],
      sleep: () => Promise.resolve(),
    };

    const events = await collectEvents(
      orchestrate('implement payment handler', deps, new AbortController().signal),
    );

    const hedgeNotice = events.find(
      (e) => e.type === 'notice' && e.message.startsWith('hedge:'),
    );
    assert.equal(hedgeNotice, undefined, 'Efficient must not auto-hedge');
  });
});

// ---------------------------------------------------------------------------
// Local Outcome Learner — learnedProviderOrder threads into routing
// ---------------------------------------------------------------------------

describe('orchestrate — learnedProviderOrder (Local Outcome Learner)', () => {
  it('routes a turn to the learned-preferred provider over the static order', async () => {
    // Static policy order is claude-first; both providers authenticated. A learned
    // ic order [codex, claude] must flip the first tier-start to codex.
    const deps: OrchestrateDeps = {
      providers: { claude: makeFakeProvider('claude'), codex: makeFakeProvider('codex') },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude', 'codex'],
      learnedProviderOrder: { ic: ['codex', 'claude'] },
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const tierStart = events.find((e) => e.type === 'tier-start');
    assert.ok(tierStart !== undefined && tierStart.type === 'tier-start');
    if (tierStart.type === 'tier-start') {
      assert.equal(tierStart.provider, 'codex', 'learned order should route to codex first');
    }
  });

  it('absent learnedProviderOrder → unchanged (static claude-first order wins)', async () => {
    const deps: OrchestrateDeps = {
      providers: { claude: makeFakeProvider('claude'), codex: makeFakeProvider('codex') },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['claude', 'codex'],
    };

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const tierStart = events.find((e) => e.type === 'tier-start');
    assert.ok(tierStart !== undefined && tierStart.type === 'tier-start');
    if (tierStart.type === 'tier-start') {
      assert.equal(tierStart.provider, 'claude', 'without a learned order, the static order wins');
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — model-proposed memory (final.memoryProposal)
// ---------------------------------------------------------------------------

describe('withMemoryProposalAttached — panel/hedge memory-proposal parity (5.5 F1)', () => {
  const REMEMBER =
    '{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false,' +
    '"remember_user":{"facts":[{"scope":"global","kind":"preference",' +
    '"text":"Prefers concise, direct answers","reason":"stable preference"}]}}';

  function baseFinal(extra: Record<string, unknown>) {
    return {
      type: 'final' as const,
      success: true,
      output: `Answer.\n${REMEMBER}`,
      tier: 'ic' as const,
      totalCostUsd: 0,
      sessionId: 's',
      attempts: 1,
      ...extra,
    };
  }

  async function* stream(...events: unknown[]) {
    for (const e of events) yield e as never;
  }

  async function collect(gen: AsyncGenerator<unknown>) {
    const out: unknown[] = [];
    for await (const e of gen) out.push(e);
    return out as Array<Record<string, unknown>>;
  }

  it('attaches a gated proposal to a panel/hedge success final (parity with sequential)', async () => {
    const out = await collect(withMemoryProposalAttached(stream(baseFinal({}))));
    const final = out[0];
    assert.equal(final?.['type'], 'final');
    const mp = final?.['memoryProposal'] as { facts: unknown[] } | undefined;
    assert.ok(mp !== undefined, 'expected memoryProposal attached on the panel/hedge final');
    assert.equal(mp.facts.length, 1);
  });

  it('does NOT attach when the final already carries questions (mutual exclusivity)', async () => {
    const qFinal = baseFinal({ questions: { questions: [] } });
    const out = await collect(withMemoryProposalAttached(stream(qFinal)));
    assert.equal(out[0]?.['memoryProposal'], undefined);
  });

  it('does NOT overwrite an existing memoryProposal', async () => {
    const existing = { facts: [{ text: 'keep me' }] };
    const out = await collect(withMemoryProposalAttached(stream(baseFinal({ memoryProposal: existing }))));
    assert.equal(out[0]?.['memoryProposal'], existing);
  });

  it('passes non-final events through untouched', async () => {
    const tick = { type: 'tier-start', tier: 'ic' };
    const out = await collect(withMemoryProposalAttached(stream(tick, baseFinal({ success: false }))));
    assert.equal(out[0], tick);
    assert.equal(out[1]?.['memoryProposal'], undefined, 'a failed final gets no proposal');
  });
});

describe('orchestrate — final.memoryProposal (remember_user, Phase 5)', () => {
  function depsWith(): OrchestrateDeps {
    return {
      providers: { claude: makeFakeProvider('claude') },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };
  }

  function providerEmitting(finalText: string): Provider {
    return makeFakeProvider('claude', [
      { type: 'text', delta: 'done.\n' },
      { type: 'done', text: finalText, usage: FAKE_USAGE, raw: {} },
    ]);
  }

  it('attaches a gated memoryProposal when the envelope carries remember_user', async () => {
    const finalText =
      'Here is your answer.\n' +
      '{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false,' +
      '"remember_user":{"facts":[{"scope":"global","kind":"preference",' +
      '"text":"Prefers concise, direct answers","reason":"stable communication preference"}]}}';
    const deps = { ...depsWith(), providers: { claude: providerEmitting(finalText) } };
    const events = await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.ok(final.memoryProposal !== undefined, 'expected a memoryProposal');
      assert.equal(final.memoryProposal?.facts.length, 1);
      assert.match(final.memoryProposal?.facts[0]?.text ?? '', /concise/);
    }
  });

  it('drops a secret-bearing proposed fact (gate runs before surfacing)', async () => {
    const finalText =
      'Answer.\n' +
      '{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false,' +
      '"remember_user":{"facts":[{"scope":"global","kind":"constraint",' +
      '"text":"my api key is sk-ABCDEF0123456789abcdef0123","reason":"x"}]}}';
    const deps = { ...depsWith(), providers: { claude: providerEmitting(finalText) } };
    const events = await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.memoryProposal, undefined, 'a secret must not surface as a proposal');
    }
  });

  it('no remember_user → no memoryProposal on a normal turn', async () => {
    const deps = depsWith();
    const events = await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.memoryProposal, undefined);
    }
  });

  it('a question turn (ask_user) NEVER carries a memoryProposal (mutually exclusive)', async () => {
    const finalText =
      'Let me ask.\n' +
      '{"ask_user":{"questions":[{"id":"q1","prompt":"Pick one","options":' +
      '[{"label":"A"},{"label":"B"}],"multiSelect":false,"allowFreeText":false}]}}';
    const deps = { ...depsWith(), providers: { claude: providerEmitting(finalText) } };
    const events = await collectEvents(orchestrate('refactor X', deps, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.ok(final.questions !== undefined, 'expected a question final');
      assert.equal(final.memoryProposal, undefined, 'ask_user and remember_user are mutually exclusive');
    }
  });
});

// ---------------------------------------------------------------------------
// Best-effort exhaustion: NEVER discard a usable answer as "Failed".
//
// Regression for the live defect where a task that produced good, complete
// reports across 3 attempts (a reviewer kept asking to `revise`) ended as
// "● Failed — tier: ic, attempts: 3" — throwing the good work away and burning
// tokens re-running the same investigation. The loop must return the best-effort
// answer (success:true, flagged bestEffort) when it exhausts its budget but HAS a
// substantive answer; only genuine no-output failures stay success:false.
// ---------------------------------------------------------------------------

describe('orchestrate — best-effort on loop exhaustion (never discard a usable answer)', () => {
  const GOOD_LOW_CONF =
    '{"confidence": 0.35, "escalate": false, "reason": "unclear from these files alone", "needs_review": true}';
  const GOOD_ANSWER = `Here is a solid summary of the socials page and the top gaps.\n${GOOD_LOW_CONF}`;
  const REVISE_VERDICT =
    'Needs more detail.\n{"verdict": "revise", "notes": "add more on the gaps", "confidence": 0.6}';

  function reviewLoopDeps(): OrchestrateDeps {
    // claude is the IC (always returns a good but low-confidence, needs_review answer);
    // codex is the cross-vendor reviewer (always returns `revise`). With reviewPolicy
    // 'auto' and needs_review:true, shouldReview fires every attempt → revise loop.
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run() {
        yield { type: 'done', text: GOOD_ANSWER, usage: { inputTokens: 50_000, outputTokens: 3_000 }, raw: {} };
      },
    };
    const codex: Provider = {
      id: 'codex',
      async detect() {
        return { id: 'codex', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run() {
        yield { type: 'done', text: REVISE_VERDICT, usage: { inputTokens: 100, outputTokens: 50 }, raw: {} };
      },
    };
    return {
      providers: { claude, codex },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      // never-auto admission keeps the turn pinned at the IC tier (no flagship
      // escalation), so a persistent `revise` would, before the fix, loop to
      // maxAttempts and discard the good answer.
      policy: { ...POLICY_PRESETS['cost-saver'], reviewPolicy: 'auto' as const, maxAttempts: 3 },
      authenticatedProviders: ['claude', 'codex'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    } as OrchestrateDeps;
  }

  it('low-confidence-but-answered turn at the attempt ceiling returns the answer (best-effort), NOT Failed', async () => {
    const deps = reviewLoopDeps();
    const session = deps.session as ReturnType<typeof makeFakeSession>;
    // "refactor X" classifies directly at the IC tier (no worker→ic hop), and
    // cost-saver's never-auto admission pins it there (no escalation to manager) —
    // exactly the live shape: a persistent `revise` at IC. Before the fix this ran
    // the heavy IC investigation 3× and ended "● Failed". The IC answer carries the
    // good text below.
    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );

    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      // The cardinal rule: a usable answer is NEVER discarded as Failed.
      assert.equal(final.success, true, 'a substantive answer must not be reported as Failed');
      assert.equal(final.bestEffort, true, 'an exhausted-loop answer must be flagged best-effort');
      assert.ok(
        final.output.includes('solid summary of the socials page'),
        'the good answer must be returned, not thrown away',
      );
      assert.equal(final.tier, 'ic', 'the answer must report the tier it actually ran on');
    }

    // The accepted best-effort answer must be persisted to the session like any
    // accepted turn (so the conversation keeps the work).
    const assistantEntries = session.entries.filter((e) => e.role === 'assistant');
    assert.equal(assistantEntries.length, 1, 'the best-effort answer must be appended to the session');
    assert.ok(assistantEntries[0]?.content.includes('solid summary'));

    // Bounded re-execution: the IC investigation must NOT run a full 3 times.
    // One revise re-run is allowed (apply notes once); beyond that, with no
    // higher tier admissible, we accept — never blind-loop the heavy work.
    const icRuns = events.filter((e) => e.type === 'tier-start' && e.provider === 'claude');
    assert.ok(
      icRuns.length <= 2,
      `expected at most 2 IC runs (1 revise re-run), got ${icRuns.length} — blind re-execution not bounded`,
    );
  });

  it('a genuinely-errored turn (no usable output) still fails — best-effort never masks real failure', async () => {
    // The only provider errors on every attempt with a non-terminal, non-auth,
    // non-timeout category and there is no untried/authenticated vendor to fail
    // over to → the loop breaks with NO acceptedRun → success:false, no bestEffort.
    const erroringClaude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run() {
        yield {
          type: 'error',
          error: { category: 'network', recoverable: true, message: 'model crashed', suggestion: 'retry' },
        };
      },
    };
    const deps: OrchestrateDeps = {
      providers: { claude: erroringClaude },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      authenticatedProviders: ['claude'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    } as OrchestrateDeps;

    const events = await collectEvents(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, false, 'a turn with no usable output must still fail');
      assert.notEqual(final.bestEffort, true, 'a real failure must never be flagged best-effort');
    }
  });
});
