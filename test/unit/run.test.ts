/**
 * Unit tests for src/interface/run.ts
 *
 * Tests runTask() with fake deps (no network, no filesystem, no child
 * processes). Verifies:
 *   - Returns 0 on success (providers available, task completes)
 *   - Returns 1 on failure (no providers — orchestrate yields honest failure)
 *   - Never fabricates responses; output honestly describes state
 */

import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runTask } from '../../src/interface/run.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
} from '../../src/core/types.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Fake infrastructure (mirrors orchestrate.test.ts pattern)
// ---------------------------------------------------------------------------

function makeFakeClock(): Clock & { tick(ms: number): void } {
  let now = 1_000_000;
  let uuidCounter = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `fake-uuid-${++uuidCounter}`,
    random: () => 0.42,
    tick: (ms: number) => { now += ms; },
  };
}

function makeFakeSession(id = 'run-test-session'): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    async append(entry: SessionEntry): Promise<void> { entries.push(entry); },
    entries,
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(entry: LedgerEntry): Promise<void> { entries.push(entry); },
    entries,
  };
}

// A confidence envelope so assess() returns a real number (not null).
const CONFIDENCE_ENVELOPE =
  '{"confidence": 0.75, "escalate": false, "reason": "task complete", "needs_review": false}';

const FAKE_USAGE: Usage = { inputTokens: 1000, outputTokens: 500 };

function makeFakeProvider(
  id: 'claude' | 'codex' = 'claude',
  events?: ProviderEvent[],
): Provider {
  const defaultEvents: ProviderEvent[] = [
    { type: 'text', delta: 'Task completed successfully.' },
    {
      type: 'done',
      text: `Task completed successfully.\n${CONFIDENCE_ENVELOPE}`,
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

/** Non-color capturing OutputSink. */
function makeSink(): OutputSink & { buf: string[] } {
  const buf: string[] = [];
  return {
    buf,
    write: (s: string) => { buf.push(s); },
    color: false,
    isTty: false,
  };
}

// ---------------------------------------------------------------------------
// 1. Happy path — provider available, task succeeds, returns 0
// ---------------------------------------------------------------------------

describe('runTask — happy path (provider available)', () => {
  let deps: OrchestrateDeps;
  let sink: ReturnType<typeof makeSink>;

  beforeEach(() => {
    deps = {
      providers: { claude: makeFakeProvider('claude') },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };
    sink = makeSink();
  });

  it('returns { code: 0 } on successful task completion', async () => {
    const result = await runTask('write unit tests', deps, sink, new AbortController().signal);
    assert.equal(result.code, 0, 'Should return code 0 on success');
  });

  it('returns final event on success', async () => {
    const result = await runTask('write unit tests', deps, sink, new AbortController().signal);
    assert.ok(result.final !== undefined, 'final should be present on success');
    assert.equal(result.final.success, true, 'final.success should be true');
  });

  it('successful final has no errorCategory', async () => {
    const result = await runTask('write unit tests', deps, sink, new AbortController().signal);
    assert.ok(result.final !== undefined);
    assert.equal(result.final.errorCategory, undefined, 'successful final must not have errorCategory');
  });

  it('output contains the real streamed text delta', async () => {
    await runTask('write unit tests', deps, sink, new AbortController().signal);
    const joined = sink.buf.join('');
    assert.ok(joined.includes('Task completed successfully.'), 'Should include the real provider text output');
  });

  it('output contains the real model id', async () => {
    // Model id is verbose-only chrome (tier-start line) — request verbose.
    await runTask('write unit tests', deps, sink, new AbortController().signal, 'verbose');
    const joined = sink.buf.join('');
    assert.ok(joined.includes('claude-sonnet-4-6'), 'Should include the real model id');
  });

  it('output contains the real session id', async () => {
    // Session id appears on the verbose Success telemetry line.
    await runTask('write unit tests', deps, sink, new AbortController().signal, 'verbose');
    const joined = sink.buf.join('');
    assert.ok(joined.includes('run-test-session'), 'Should include the real session id');
  });

  it('output shows real tokens, not dollars (subscription tool)', async () => {
    await runTask('write unit tests', deps, sink, new AbortController().signal, 'verbose');
    const joined = sink.buf.join('');
    // Provider usage: 1000 in + 500 out = 1500 tokens → "1.5k tokens".
    assert.ok(joined.includes('1.5k tokens'), `Should show real token total, got:\n${joined}`);
    assert.ok(!joined.includes('$'), `Hot path must show no dollar figure, got:\n${joined}`);
  });

  it('output contains confidence rendered as a computed number (from 0.75)', async () => {
    // Confidence is on the verbose tier-done telemetry line.
    await runTask('write unit tests', deps, sink, new AbortController().signal, 'verbose');
    const joined = sink.buf.join('');
    // 0.75 * 100 = 75 — appears as "75" followed by "%"
    assert.ok(joined.includes('75'), 'Should include computed confidence value 75 (from 0.75)');
  });
});

// ---------------------------------------------------------------------------
// 2. No-providers path — honest failure, returns 1
// ---------------------------------------------------------------------------

describe('runTask — no providers (honest failure)', () => {
  let sink: ReturnType<typeof makeSink>;

  beforeEach(() => {
    sink = makeSink();
  });

  it('returns { code: 1 } when no providers are configured', async () => {
    const deps: OrchestrateDeps = {
      providers: {},
      clock: makeFakeClock(),
      session: makeFakeSession('no-provider-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const result = await runTask('do something', deps, sink, new AbortController().signal);
    assert.equal(result.code, 1, 'Should return code 1 when no providers are available');
  });

  it('returns final event on failure', async () => {
    const deps: OrchestrateDeps = {
      providers: {},
      clock: makeFakeClock(),
      session: makeFakeSession('no-provider-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const result = await runTask('do something', deps, sink, new AbortController().signal);
    assert.ok(result.final !== undefined, 'final should be present on failure');
    assert.equal(result.final.success, false, 'final.success should be false');
  });

  it('output honestly states that no providers are available', async () => {
    const deps: OrchestrateDeps = {
      providers: {},
      clock: makeFakeClock(),
      session: makeFakeSession('no-provider-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await runTask('do something', deps, sink, new AbortController().signal);
    const joined = sink.buf.join('');

    // The honest message from orchestrate's no-providers path
    assert.ok(
      joined.includes('No providers') || joined.includes('no providers') || joined.includes('provider'),
      'Should honestly state that no providers are available',
    );
  });

  it('does not fabricate a successful response when no providers exist', async () => {
    const deps: OrchestrateDeps = {
      providers: {},
      clock: makeFakeClock(),
      session: makeFakeSession('no-provider-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await runTask('do something', deps, sink, new AbortController().signal);
    const joined = sink.buf.join('');

    // Must not fabricate AI responses
    const forbidden = [
      'I have completed',
      'Task completed successfully',
      'Here is the result',
    ];
    for (const f of forbidden) {
      assert.ok(!joined.includes(f), `Output must not fabricate response: "${f}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Error propagation — runTask catches thrown errors and returns 1
// ---------------------------------------------------------------------------

describe('runTask — error propagation', () => {
  it('returns 1 and writes error message when orchestrate throws', async () => {
    const sink = makeSink();

    // Build a deps with a provider that throws synchronously during run()
    const errorProvider: Provider = {
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
      run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        // Return an iterable whose iterator throws on first next() call
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<ProviderEvent>> {
                throw new Error('provider exploded');
              },
            };
          },
        };
      },
    };

    const deps: OrchestrateDeps = {
      providers: { claude: errorProvider },
      clock: makeFakeClock(),
      session: makeFakeSession('error-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const result = await runTask('crash task', deps, sink, new AbortController().signal);
    assert.equal(result.code, 1, 'Should return code 1 when an error is thrown');

    const joined = sink.buf.join('');
    assert.ok(joined.includes('provider exploded'), 'Should include the real error message');
  });
});

// ---------------------------------------------------------------------------
// 4. AbortSignal — cancelled task returns 1
// ---------------------------------------------------------------------------

describe('runTask — abort signal', () => {
  it('returns 1 when task is aborted before start', async () => {
    const sink = makeSink();
    const controller = new AbortController();
    controller.abort(); // abort immediately

    const deps: OrchestrateDeps = {
      providers: { claude: makeFakeProvider('claude') },
      clock: makeFakeClock(),
      session: makeFakeSession('abort-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const result = await runTask('cancel me', deps, sink, controller.signal);
    assert.equal(result.code, 1, 'Should return code 1 when task is cancelled');
  });
});
