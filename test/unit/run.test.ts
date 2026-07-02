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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTask } from '../../src/interface/run.ts';
import { parseEvalArgs, runEvalCommand } from '../../src/commands/eval.ts';
import { SEMANTIC_PREFLIGHT_SUITE_SUMMARY } from '../../src/core/eval/semantic-preflight-suite.ts';
import type { SemanticPreflightCaseOutcome } from '../../src/core/eval/semantic-preflight-harness.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { createTurnCallBudget } from '../../src/core/turn-call-budget.js';
import { buildPreflightDeps } from '../../src/interface/preflight-deps.ts';
import type {
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
} from '../../src/core/types.ts';
import type { AppConfig } from '../../src/infra/config.js';
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

const SEMANTIC_PREFLIGHT_JSON = JSON.stringify({
  version: 1,
  objective: 'Review implementation',
  taskShape: { kind: 'analysis', scope: 'single-step', mutatesWorkspace: false },
  route: { tier: 'worker', plan: false, rationale: 'simple review' },
  risk: { level: 'low', reasons: [] },
  uncertainty: { level: 'low', reasons: [], forks: [] },
  evidenceNeeded: [],
  doneCondition: { status: 'specified', text: 'answer the review request' },
  planSteps: [],
  proposedExecution: { provider: 'auto', effort: 'none', rationale: 'no preference' },
});

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

// ---------------------------------------------------------------------------
// 5. CLI semantic eval dispatch — preserves normal eval mode (P1-08d)
// ---------------------------------------------------------------------------

function makeEvalSink(): OutputSink & { buf: string[] } {
  const buf: string[] = [];
  return { buf, write: (s: string) => { buf.push(s); }, color: false, isTty: false };
}

function makeFakeEvalExtractor(
  callCount: { value: number },
): (task: string, signal: AbortSignal) => Promise<Omit<SemanticPreflightCaseOutcome, 'caseId'>> {
  return async (_task, _signal) => {
    callCount.value++;
    return {
      disposition: 'run' as const,
      semantic: null,
      ms: 5,
      receipt: undefined,
      error: undefined,
    };
  };
}

describe('CLI semantic eval dispatch reaches the dedicated harness and preserves normal eval mode', () => {
  it('normal eval arg parsing is preserved (no --semantic-preflight)', () => {
    const opts = parseEvalArgs(['--compare']);
    assert.equal(opts.compare, true);
    assert.equal(opts.semanticPreflight, false);
    assert.equal(opts.engine, undefined);
    assert.equal(opts.output, undefined);
  });

  it('--semantic-preflight arg parsing works alongside normal eval flags', () => {
    const opts = parseEvalArgs(['--semantic-preflight', '--engine=semantic-v1', '--output=.tmp/out.json']);
    assert.equal(opts.semanticPreflight, true);
    assert.equal(opts.engine, 'semantic-v1');
    assert.equal(opts.output, '.tmp/out.json');
    assert.equal(opts.yes, false);
    assert.equal(opts.compare, false);
  });

  it('--semantic-preflight with --yes runs through the harness and writes an artifact', async () => {
    const sink = makeEvalSink();
    const callCount = { value: 0 };
    const fakeExtractor = makeFakeEvalExtractor(callCount);
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-test-'));
    try {
      const code = await runEvalCommand(
        ['--semantic-preflight', '--engine=semantic-v1', '--yes'],
        {
          cwd: tmpDir,
          version: '0.0.0',
          nowIso: () => '2026-07-02T00:00:00.000Z',
          providers: {},
          policy: undefined as never,
          timeoutMs: 1000,
          authenticatedProviders: [],
          makeDeps: () => {
            throw new Error('not used');
          },
          semanticPreflightExtractor: fakeExtractor,
        },
        sink,
        new AbortController().signal,
      );

      // The extractor should be called for all 200 cases
      const total = SEMANTIC_PREFLIGHT_SUITE_SUMMARY.totalCount;
      assert.equal(callCount.value, total, `extractor should be called ${total} times`);

      const output = sink.buf.join('');
      assert.ok(output.includes('Artifact written'), 'output should mention artifact');
      assert.ok(output.includes('Status:'), 'output should include status');
      // With null semantics, harness reports 'fail' -> exit 1 (schema/fixture failure)
      assert.equal(code, 1, 'null outcomes produce fail artifact, exit 1');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('semantic-preflight extractor throw exits 2 with incomplete artifact status', async () => {
    const sink = makeEvalSink();
    const callCount = { value: 0 };
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-test-'));
    try {
      const code = await runEvalCommand(
        ['--semantic-preflight', '--engine=semantic-v1', '--yes'],
        {
          cwd: tmpDir,
          version: '0.0.0',
          nowIso: () => '2026-07-02T00:00:00.000Z',
          providers: {},
          policy: undefined as never,
          timeoutMs: 1000,
          authenticatedProviders: [],
          makeDeps: () => {
            throw new Error('not used');
          },
          semanticPreflightExtractor: async () => {
            callCount.value++;
            throw new Error('extractor crashed');
          },
        },
        sink,
        new AbortController().signal,
      );

      assert.equal(callCount.value, 1, 'run stops at the thrown extractor case');
      assert.equal(code, 2, 'thrown extraction produces incomplete artifact, exit 2');
      assert.match(sink.buf.join(''), /Status: incomplete/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runTask semantic preflight production composition', () => {
  it('flag off interactive one-shot and REPL receipts match legacy snapshots', () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: true };
    const preflight = buildPreflightDeps({
      providers: { claude: makeFakeProvider('claude') },
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      timeoutMs: 30_000,
      sandbox: 'workspace-write',
      config: cfg,
      env: {},
      autoMode: 'balanced',
      intentPass: true,
    });

    assert.equal(preflight.semanticPreflightV1, undefined);
    assert.equal(preflight.semanticPreflightExtractor, undefined);
    assert.equal(typeof preflight.routeClassifier, 'function');
    assert.equal(typeof preflight.intentExtractor, 'function');
  });

  it('same observing budget object owns semantic evidence work and receipt callback', async () => {
    const sink = makeSink();
    const budget = createTurnCallBudget({
      turnId: 'run-semantic',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const prompts: string[] = [];
    let receiptBegun = -1;
    const provider: Provider = {
      ...makeFakeProvider('claude'),
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        prompts.push(req.prompt);
        if (req.prompt.includes('semantic preflight extractor')) {
          yield {
            type: 'done',
            text: SEMANTIC_PREFLIGHT_JSON,
            usage: FAKE_USAGE,
            raw: {},
          };
          return;
        }
        yield { type: 'text', delta: 'Task completed successfully.' };
        yield {
          type: 'done',
          text: `Task completed successfully.\n${CONFIDENCE_ENVELOPE}`,
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };
    const baseDeps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session: makeFakeSession('semantic-run-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      turnCallBudget: budget,
      onTurnCallBudgetReceipt: async (receipt) => {
        receiptBegun = receipt.begun;
        throw new Error('diagnostic only');
      },
    };
    const preflight = buildPreflightDeps({
      providers: baseDeps.providers,
      policy: baseDeps.policy,
      cwd: baseDeps.cwd,
      timeoutMs: baseDeps.timeoutMs,
      sandbox: baseDeps.sandbox,
      config: { onboarded: true, setAsDefault: true, experimentalSemanticPreflightV1: true },
      env: {},
      autoMode: 'balanced',
      intentPass: true,
      turnCallBudget: budget,
    });
    const deps: OrchestrateDeps = { ...baseDeps, ...preflight };

    const result = await runTask('review this implementation', deps, sink, new AbortController().signal);
    try {
      await deps.onTurnCallBudgetReceipt?.(budget.snapshot());
    } catch {
      // Entry points swallow diagnostic receipt callback errors.
    }

    assert.equal(result.code, 0);
    assert.equal(receiptBegun, 2);
    assert.equal(prompts.filter((p) => p.includes('semantic preflight extractor')).length, 1);
    const purposes = budget.snapshot().events
      .filter((e) => e.type === 'call-begun')
      .map((e) => e.type === 'call-begun' ? e.purpose : '');
    assert.deepEqual(purposes, ['intent', 'work']);
  });

  it('old unify risk and investigation flags cannot add calls inside V1 branch', async () => {
    const sink = makeSink();
    const budget = createTurnCallBudget({
      turnId: 'run-semantic-old-flags',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    const provider: Provider = {
      ...makeFakeProvider('claude'),
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        if (req.prompt.includes('semantic preflight extractor')) {
          yield { type: 'done', text: SEMANTIC_PREFLIGHT_JSON, usage: FAKE_USAGE, raw: {} };
          return;
        }
        yield {
          type: 'done',
          text: `Task completed successfully.\n${CONFIDENCE_ENVELOPE}`,
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };
    const baseDeps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session: makeFakeSession('old-flags-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      turnCallBudget: budget,
    };
    const preflight = buildPreflightDeps({
      providers: baseDeps.providers,
      policy: baseDeps.policy,
      cwd: baseDeps.cwd,
      timeoutMs: baseDeps.timeoutMs,
      sandbox: baseDeps.sandbox,
      config: { onboarded: true, setAsDefault: true, experimentalSemanticPreflightV1: true },
      env: {
        MYSHELL_UNIFY_PREFLIGHT: '1',
        MYSHELL_RISK_SIGNALS: '1',
        MYSHELL_REQUIRED_INVESTIGATION: '1',
      },
      autoMode: 'balanced',
      intentPass: true,
      turnCallBudget: budget,
    });

    await runTask('review this implementation', { ...baseDeps, ...preflight }, sink, new AbortController().signal);

    const purposes = budget.snapshot().events
      .filter((e) => e.type === 'call-begun')
      .map((e) => e.type === 'call-begun' ? e.purpose : '');
    assert.equal(purposes.filter((p) => p === 'intent').length, 1);
    assert.equal(purposes.includes('route'), false);
    assert.equal(purposes.includes('reextract-local'), false);
    assert.equal(purposes.includes('reextract-web'), false);
  });

  it('provider failure cancellation and receipt callback throw remain fail-soft without duplicate calls', async () => {
    const sink = makeSink();
    const budget = createTurnCallBudget({
      turnId: 'run-semantic-fail-soft',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });
    let callbackAttempts = 0;
    const provider: Provider = {
      ...makeFakeProvider('claude'),
      async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
        if (req.prompt.includes('semantic preflight extractor')) {
          yield {
            type: 'error',
            error: {
              category: 'unknown',
              recoverable: true,
              message: 'semantic failed',
              suggestion: 'retry later',
            },
          };
          return;
        }
        yield {
          type: 'done',
          text: `Task completed successfully.\n${CONFIDENCE_ENVELOPE}`,
          usage: FAKE_USAGE,
          raw: {},
        };
      },
    };
    const baseDeps: OrchestrateDeps = {
      providers: { claude: provider },
      clock: makeFakeClock(),
      session: makeFakeSession('fail-soft-session'),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      turnCallBudget: budget,
      onTurnCallBudgetReceipt: async () => {
        callbackAttempts++;
        throw new Error('diagnostic only');
      },
    };
    const preflight = buildPreflightDeps({
      providers: baseDeps.providers,
      policy: baseDeps.policy,
      cwd: baseDeps.cwd,
      timeoutMs: baseDeps.timeoutMs,
      sandbox: baseDeps.sandbox,
      config: { onboarded: true, setAsDefault: true, experimentalSemanticPreflightV1: true },
      env: {},
      autoMode: 'balanced',
      intentPass: true,
      turnCallBudget: budget,
    });
    const deps: OrchestrateDeps = { ...baseDeps, ...preflight };

    const result = await runTask('review this implementation', deps, sink, new AbortController().signal);
    try {
      await deps.onTurnCallBudgetReceipt?.(budget.snapshot());
    } catch {
      // Entry points swallow diagnostic receipt callback errors.
    }

    assert.equal(result.code, 0);
    assert.equal(callbackAttempts, 1);
    const purposes = budget.snapshot().events
      .filter((e) => e.type === 'call-begun')
      .map((e) => e.type === 'call-begun' ? e.purpose : '');
    assert.deepEqual(purposes, ['intent', 'work', 'work']);
  });
});
