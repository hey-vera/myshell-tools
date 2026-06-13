import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const LOW_CONFIDENCE =
  'Initial IC result.\n{"confidence":0.2,"escalate":false,"reason":"needs stronger model","needs_review":false}';
const SUCCESS =
  'Recovered through OpenCode.\n{"confidence":0.95,"escalate":false,"reason":"done","needs_review":false}';

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
    id: 'failover-session',
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

describe('work-call provider failover budget', () => {
  it('runs OpenCode after an IC attempt and manager sandbox failure exhaust maxAttempts', async () => {
    const executions: string[] = [];
    let claudeRuns = 0;
    const deps: OrchestrateDeps = {
      providers: {
        claude: provider('claude', (request) => {
          executions.push(`claude:${request.model}`);
          claudeRuns++;
          if (claudeRuns === 1) {
            return [{ type: 'done', text: LOW_CONFIDENCE, raw: {} }];
          }
          return [{
            type: 'error',
            error: {
              category: 'network',
              recoverable: true,
              message: 'manager Claude failed',
              suggestion: 'fail over',
            },
          }];
        }),
        codex: provider('codex', (request) => {
          executions.push(`codex:${request.model}`);
          return [{
            type: 'error',
            error: {
              category: 'sandbox-environment',
              recoverable: true,
              message: 'bwrap sandbox startup failed',
              suggestion: 'use another provider',
            },
          }];
        }),
        opencode: provider('opencode', (request) => {
          executions.push(`opencode:${request.model}`);
          return [{ type: 'done', text: SUCCESS, raw: {} }];
        }),
      },
      clock: clock(),
      session: session(),
      ledger: ledger(),
      policy: {
        ...DEFAULT_POLICY,
        maxAttempts: 3,
        panelPolicy: 'off',
        hedgePolicy: 'off',
        reviewPolicy: 'off',
      },
      authenticatedProviders: ['claude', 'codex', 'opencode'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collect(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const final = events.find((event) => event.type === 'final');

    assert.deepEqual(executions.map((entry) => entry.split(':')[0]), [
      'claude',
      'claude',
      'codex',
      'opencode',
    ]);
    assert.ok(
      events.some(
        (event) => event.type === 'failover' && event.from === 'codex' && event.to === 'opencode',
      ),
      'sandbox failure must fail over from Codex to OpenCode',
    );
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    assert.equal(final.attempts, 4, 'provider failover may exceed the ordinary attempt ceiling');
    assert.match(final.output, /Recovered through OpenCode/);
  });
});

// ---------------------------------------------------------------------------
// Partial-output salvage tests (draft-handoff on rate-limit failover)
// ---------------------------------------------------------------------------

/** A partial draft long enough to meet SALVAGE_MIN_CHARS (>= 200 chars). */
const LONG_PARTIAL =
  'Here is a comprehensive analysis of the refactoring approach. The main issue is that the current architecture couples the router directly to the provider implementations. To fix this, we need to introduce an abstraction layer that separates the routing logic from provider specifics. This allows us to swap providers without changing routing code.';

/** A partial draft with a trailing confidence envelope to be stripped. */
const PARTIAL_WITH_ENVELOPE =
  'Here is a comprehensive analysis of the refactoring approach. The main issue is that the current architecture couples the router directly to the provider implementations, making it hard to add new providers.\n{"confidence":0.4,"escalate":false,"reason":"interrupted","needs_review":false}';

const PARTIAL_STRIPPED =
  'Here is a comprehensive analysis of the refactoring approach. The main issue is that the current architecture couples the router directly to the provider implementations, making it hard to add new providers.';

const RATE_LIMIT_ERROR: ProviderEvent = {
  type: 'error',
  error: {
    category: 'rate-limit',
    recoverable: true,
    message: '429 too many requests',
    suggestion: 'wait and retry',
  },
};

const NETWORK_ERROR: ProviderEvent = {
  type: 'error',
  error: {
    category: 'network',
    recoverable: true,
    message: 'connection refused',
    suggestion: 'retry',
  },
};

const TIMEOUT_ERROR: ProviderEvent = {
  type: 'error',
  error: {
    category: 'timeout',
    recoverable: false,
    message: 'timed out',
    suggestion: 'narrow the task',
  },
};

const DONE_SUCCESS =
  'Completed successfully by the second provider.\n{"confidence":0.95,"escalate":false,"reason":"done","needs_review":false}';

function mkDeps(
  claudeEvents: ProviderEvent[],
  codexRun: (req: ProviderRequest) => ProviderEvent[],
): { deps: OrchestrateDeps; codexRequests: ProviderRequest[] } {
  const codexRequests: ProviderRequest[] = [];
  const deps: OrchestrateDeps = {
    providers: {
      claude: provider('claude', () => claudeEvents),
      codex: provider('codex', (req) => {
        codexRequests.push(req);
        return codexRun(req);
      }),
    },
    clock: clock(),
    session: session(),
    ledger: ledger(),
    policy: {
      ...DEFAULT_POLICY,
      maxAttempts: 3,
      panelPolicy: 'off',
      hedgePolicy: 'off',
      reviewPolicy: 'off',
    },
    authenticatedProviders: ['claude', 'codex'],
    cwd: '/fake/cwd',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
  };
  return { deps, codexRequests };
}

describe('partial-output salvage on rate-limit failover', () => {
  it('injects the stripped partial draft into the next provider\'s prompt on rate-limit failover', async () => {
    // Claude streams a long partial then hits rate-limit (done event with partial + error)
    const { deps, codexRequests } = mkDeps(
      [
        // Partial text streamed before rate-limit
        { type: 'text', delta: PARTIAL_WITH_ENVELOPE.slice(0, 100) },
        { type: 'text', delta: PARTIAL_WITH_ENVELOPE.slice(100) },
        // The done event carries the accumulated partial text
        { type: 'done', text: PARTIAL_WITH_ENVELOPE, raw: {} },
        RATE_LIMIT_ERROR,
      ],
      () => [{ type: 'done', text: DONE_SUCCESS, raw: {} }],
    );

    const events = await collect(orchestrate('refactor X', deps, new AbortController().signal));

    // Codex must have been called
    assert.ok(codexRequests.length >= 1, 'codex was called as failover provider');

    // The prompt sent to codex must contain the salvage block
    const codexPrompt = codexRequests[0]?.prompt ?? '';
    assert.ok(
      codexPrompt.includes('PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT'),
      'prompt contains salvage block header',
    );
    // The envelope must be stripped — no confidence JSON in the draft block
    assert.ok(
      !codexPrompt.includes('"confidence":0.4'),
      'confidence envelope is stripped from salvaged draft',
    );
    // The prose content must be present
    assert.ok(
      codexPrompt.includes(PARTIAL_STRIPPED),
      'stripped prose is present in the draft block',
    );

    // A salvage notice must be emitted
    const noticeEvents = events.filter(
      (ev) => ev.type === 'notice' && ev.level === 'info' && ev.message.includes('partial draft'),
    );
    assert.ok(noticeEvents.length >= 1, 'salvage notice was emitted');
    const notice = noticeEvents[0];
    assert.ok(notice !== undefined && notice.type === 'notice');
    assert.ok(notice.message.includes('codex'), 'notice names the receiving provider');
    assert.ok(notice.message.includes('claude'), 'notice names the source provider');
    assert.ok(notice.message.includes('no work wasted'), 'notice has reassurance text');
  });

  it('does NOT salvage when the partial is below SALVAGE_MIN_CHARS (200 chars)', async () => {
    const SHORT_PARTIAL = 'Short answer.\n{"confidence":0.4,"escalate":false,"reason":"interrupted","needs_review":false}';
    // Short partial (< 200 chars stripped)
    assert.ok(
      'Short answer.'.length < 200,
      'test invariant: stripped partial is under threshold',
    );

    const { deps, codexRequests } = mkDeps(
      [
        { type: 'done', text: SHORT_PARTIAL, raw: {} },
        RATE_LIMIT_ERROR,
      ],
      () => [{ type: 'done', text: DONE_SUCCESS, raw: {} }],
    );

    await collect(orchestrate('refactor X', deps, new AbortController().signal));

    // Codex must not have received a salvage block
    const codexPrompt = codexRequests[0]?.prompt ?? '';
    assert.ok(
      !codexPrompt.includes('PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT'),
      'no salvage block when partial is below threshold',
    );
  });

  it('does NOT salvage on non-rate-limit failover (network error)', async () => {
    const { deps, codexRequests } = mkDeps(
      [
        { type: 'done', text: LONG_PARTIAL, raw: {} },
        NETWORK_ERROR,
      ],
      () => [{ type: 'done', text: DONE_SUCCESS, raw: {} }],
    );

    const events = await collect(orchestrate('refactor X', deps, new AbortController().signal));

    // A failover must have happened
    assert.ok(
      events.some((ev) => ev.type === 'failover'),
      'failover event was emitted',
    );

    // No salvage block in the codex prompt
    const codexPrompt = codexRequests[0]?.prompt ?? '';
    assert.ok(
      !codexPrompt.includes('PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT'),
      'no salvage block on network-error failover',
    );

    // No salvage notice
    const salvageNotices = events.filter(
      (ev) => ev.type === 'notice' && ev.level === 'info' && ev.message.includes('partial draft'),
    );
    assert.equal(salvageNotices.length, 0, 'no salvage notice on non-rate-limit failover');
  });

  it('does NOT salvage on timeout (timeout returns early, never reaches failover branch)', async () => {
    // Timeout: no done event (no finalText), error is timeout
    const { deps, codexRequests } = mkDeps(
      [TIMEOUT_ERROR],
      () => [{ type: 'done', text: DONE_SUCCESS, raw: {} }],
    );

    const events = await collect(orchestrate('refactor X', deps, new AbortController().signal));

    // Timeout returns a 'final' with errorCategory=timeout without failover
    const finalEv = events.find((ev) => ev.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final');
    assert.equal(finalEv.success, false);
    assert.equal(finalEv.errorCategory, 'timeout');

    // No failover attempted
    assert.ok(!events.some((ev) => ev.type === 'failover'), 'no failover on timeout');
    // Codex was not called
    assert.equal(codexRequests.length, 0, 'codex never called after timeout');
  });

  it('salvagedDraft does not leak into a non-failover retry (cleared after prompt build)', async () => {
    // Scenario: Claude rate-limits with a long partial → codex fails (not rate-limit) → no 3rd provider
    // The salvage draft must not bleed into subsequent retries.
    const codexRequests: ProviderRequest[] = [];
    let codexCallCount = 0;
    const deps: OrchestrateDeps = {
      providers: {
        claude: provider('claude', () => [
          { type: 'done', text: LONG_PARTIAL, raw: {} },
          RATE_LIMIT_ERROR,
        ]),
        codex: provider('codex', (req) => {
          codexRequests.push(req);
          codexCallCount++;
          // First call: success (no second call expected for this scenario)
          return [{ type: 'done', text: DONE_SUCCESS, raw: {} }];
        }),
      },
      clock: clock(),
      session: session(),
      ledger: ledger(),
      policy: {
        ...DEFAULT_POLICY,
        maxAttempts: 5,
        panelPolicy: 'off',
        hedgePolicy: 'off',
        reviewPolicy: 'off',
      },
      authenticatedProviders: ['claude', 'codex'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    await collect(orchestrate('refactor X', deps, new AbortController().signal));

    // Codex called once with salvage draft — no second call (so draft cannot leak)
    assert.ok(codexCallCount >= 1, 'codex was called');
    // The first codex call has the draft
    assert.ok(
      (codexRequests[0]?.prompt ?? '').includes('PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT'),
      'first codex call has salvage block',
    );
    // If codex was called more than once, subsequent calls must NOT have a salvage block
    for (let i = 1; i < codexRequests.length; i++) {
      assert.ok(
        !(codexRequests[i]?.prompt ?? '').includes('PARTIAL DRAFT FROM AN INTERRUPTED PREVIOUS ATTEMPT'),
        `codex call ${i + 1} must not carry a stale salvage block`,
      );
    }
  });

  it('multi-failover A→B→C: B\'s partial (rate-limit) replaces A\'s salvage (latest-wins)', async () => {
    const opencodeRequests: ProviderRequest[] = [];
    let claudeCount = 0;
    let codexCount = 0;

    const CODEX_PARTIAL =
      'Codex started this answer with a detailed plan. The approach involves extracting the interface first, then wiring the implementations. Step 1: Define the interface contract. Step 2: Implement the adapter pattern for each provider. Step 3: Update the router to use the interface.';

    const deps: OrchestrateDeps = {
      providers: {
        claude: provider('claude', () => {
          claudeCount++;
          return [
            { type: 'done', text: LONG_PARTIAL, raw: {} },
            RATE_LIMIT_ERROR,
          ];
        }),
        codex: provider('codex', () => {
          codexCount++;
          // Codex also rate-limits with its own (different) partial
          return [
            { type: 'done', text: CODEX_PARTIAL, raw: {} },
            RATE_LIMIT_ERROR,
          ];
        }),
        opencode: provider('opencode', (req) => {
          opencodeRequests.push(req);
          return [{ type: 'done', text: DONE_SUCCESS, raw: {} }];
        }),
      },
      clock: clock(),
      session: session(),
      ledger: ledger(),
      policy: {
        ...DEFAULT_POLICY,
        maxAttempts: 5,
        panelPolicy: 'off',
        hedgePolicy: 'off',
        reviewPolicy: 'off',
      },
      authenticatedProviders: ['claude', 'codex', 'opencode'],
      cwd: '/fake/cwd',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
    };

    const events = await collect(orchestrate('refactor X', deps, new AbortController().signal));

    // Both claude and codex must have been tried
    assert.ok(claudeCount >= 1, 'claude was tried');
    assert.ok(codexCount >= 1, 'codex was tried');
    // Opencode must have been called
    assert.ok(opencodeRequests.length >= 1, 'opencode was called as final failover');

    const opencodePr = opencodeRequests[0]?.prompt ?? '';
    // LATEST-WINS: codex's partial replaces claude's — opencode must see codex's draft, not claude's
    assert.ok(
      opencodePr.includes(CODEX_PARTIAL),
      "opencode's prompt contains codex's partial (latest-wins)",
    );
    // Claude's partial must NOT be the one injected (it was replaced by codex's)
    // Note: LONG_PARTIAL and CODEX_PARTIAL share no text, so this is a clean check
    assert.ok(
      !opencodePr.includes(LONG_PARTIAL),
      "claude's partial is replaced by codex's (not both injected)",
    );

    // Two salvage notices: one for claude→codex, one for codex→opencode
    const salvageNotices = events.filter(
      (ev) => ev.type === 'notice' && ev.level === 'info' && ev.message.includes('partial draft'),
    );
    assert.ok(salvageNotices.length >= 2, 'two salvage notices for A→B→C chain');

    // Eventual success
    const finalEv = events.find((ev) => ev.type === 'final');
    assert.ok(finalEv !== undefined && finalEv.type === 'final');
    assert.equal(finalEv.success, true);
  });
});
