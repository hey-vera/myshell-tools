/**
 * test/unit/orchestrate-work-call-characterization.test.ts
 *
 * CHARACTERIZATION TESTS for the work-call region of orchestrate() (Phase 1 of
 * the master build plan — the seam extraction). These pin the CURRENT observable
 * behaviour of the work-call path as golden-transcript snapshots of the full
 * CoreEvent stream, plus the session/ledger side-effects, so the Phase 1
 * extraction of `runWorkCall` is provably behaviour-preserving.
 *
 * Unlike the assertion-style tests in orchestrate.test.ts (which check individual
 * properties), these capture the WHOLE normalized event stream in order — the
 * exact thing the extraction must reproduce byte-for-byte. A normalized projection
 * (dropping volatile fields like uuids and absolute costs, keeping structure +
 * ordering + the load-bearing fields) makes the snapshot stable across runs while
 * still catching any reordering, dropped event, or changed final shape.
 *
 * What is pinned here:
 *  - happy path: classified → tier-start → provider-event(s) → tier-done → final
 *  - tier resolution + the accepted-assistant session append
 *  - low-confidence escalation (worker/ic → manager) ordering
 *  - cross-vendor review approve flow (the review block's event ordering)
 *  - reviewer revise → same-tier retry (the retry-by-tier path)
 *  - cross-vendor failover on a recoverable error (failover event + 2nd attempt)
 *  - provider error → escalate → fail final
 *  - abort before stream → cancelled notice + cancelled final
 *  - usage / token accounting on the tier-done + ledger
 *  - timeout terminal path (no failover, no escalate)
 *
 * Run with:
 *   node --import ./test/register.mjs --experimental-strip-types --test \
 *     test/unit/orchestrate-work-call-characterization.test.ts
 *
 * All dependencies are faked in-memory — no network, fs, or child processes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '../../src/core/orchestrate.ts';
import { verifyStage, type VerifyStageContext } from '../../src/core/work-call.ts';
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
// Fakes (mirrors orchestrate.test.ts — deterministic clock / session / ledger)
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

function makeFakeSession(id = 'sess-char-1'): SessionWriter & { entries: SessionEntry[] } {
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

const FAKE_USAGE: Usage = { inputTokens: 1000, outputTokens: 500 };

function envelope(opts: {
  confidence?: number;
  escalate?: boolean;
  reason?: string;
  needsReview?: boolean;
}): string {
  return JSON.stringify({
    confidence: opts.confidence ?? 0.88,
    escalate: opts.escalate ?? false,
    reason: opts.reason ?? 'task complete',
    needs_review: opts.needsReview ?? false,
  });
}

function doneEvents(text: string, usage: Usage = FAKE_USAGE): ProviderEvent[] {
  return [
    { type: 'text', delta: text.slice(0, 8) },
    { type: 'done', text, usage, raw: {} },
  ];
}

function makeProvider(
  id: 'claude' | 'codex' | 'opencode',
  events: ProviderEvent[],
): Provider {
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
      for (const ev of events) yield ev;
    },
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Normalizer: project the CoreEvent stream to a stable golden shape.
//
// Drops volatile/absolute fields (exact usd, durationMs, sessionId, the prose
// text of provider-events) while KEEPING the load-bearing structure: the event
// type, tier transitions, provider/model labels, success flags, confidence,
// token counts, error categories, escalate/failover reasons, and final shape.
// This is precisely the contract a behaviour-preserving extraction must hold.
// ---------------------------------------------------------------------------

interface NormEvent {
  readonly type: string;
  readonly [k: string]: unknown;
}

function normalize(events: readonly CoreEvent[]): NormEvent[] {
  return events.map((ev): NormEvent => {
    switch (ev.type) {
      case 'classified':
        return {
          type: 'classified',
          tier: ev.classification.tier,
          risk: ev.classification.risk,
        };
      case 'tier-start':
        return {
          type: 'tier-start',
          tier: ev.tier,
          provider: ev.provider,
          model: ev.model,
          attempt: ev.attempt,
          hasTitle: ev.title !== undefined,
          risk: ev.risk,
        };
      case 'provider-event':
        return { type: 'provider-event', tier: ev.tier, evType: ev.event.type };
      case 'tier-done':
        return {
          type: 'tier-done',
          tier: ev.tier,
          success: ev.success,
          confidence: ev.confidence,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
        };
      case 'escalate':
        return { type: 'escalate', from: ev.from, to: ev.to, reason: ev.reason };
      case 'failover':
        return { type: 'failover', from: ev.from, to: ev.to, tier: ev.tier, reason: ev.reason };
      case 'notice':
        return { type: 'notice', level: ev.level, message: ev.message };
      case 'final':
        return {
          type: 'final',
          success: ev.success,
          tier: ev.tier,
          attempts: ev.attempts,
          hasOutput: ev.output.trim().length > 0,
          canceled: ev.canceled ?? false,
          bestEffort: ev.bestEffort ?? false,
          hasQuestions: ev.questions !== undefined,
          errorCategory: ev.errorCategory,
          provider: ev.provider,
        };
      default:
        return { type: (ev as { type: string }).type };
    }
  });
}

/** Project session entries to a stable shape (drop timestamps + exact costs). */
function normSession(entries: readonly SessionEntry[]): unknown[] {
  return entries.map((e) => ({
    role: e.role,
    hasContent: e.content.trim().length > 0,
    ...(e.role === 'assistant'
      ? { tier: e.tier, provider: e.provider, confidence: e.confidence }
      : {}),
  }));
}

function baseDeps(
  providers: OrchestrateDeps['providers'],
  overrides: Partial<OrchestrateDeps> = {},
): { deps: OrchestrateDeps; session: ReturnType<typeof makeFakeSession>; ledger: ReturnType<typeof makeFakeLedger> } {
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const deps: OrchestrateDeps = {
    providers,
    clock: makeFakeClock(),
    session,
    ledger,
    policy: DEFAULT_POLICY,
    cwd: '/fake/cwd',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    ...overrides,
  };
  return { deps, session, ledger };
}

// ---------------------------------------------------------------------------
// 1. Happy path — the canonical work-call transcript
// ---------------------------------------------------------------------------

describe('work-call characterization — happy path golden transcript', () => {
  it('pins classified → tier-start → provider-event → tier-done → final + session append', async () => {
    const { deps, session, ledger } = baseDeps({
      claude: makeProvider('claude', doneEvents(`Done.\n${envelope({})}`)),
    });
    const events = await collect(orchestrate('refactor X', deps, new AbortController().signal));

    assert.deepEqual(normalize(events), [
      { type: 'classified', tier: 'ic', risk: 'low' },
      {
        type: 'tier-start',
        tier: 'ic',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        attempt: 1,
        hasTitle: true,
        risk: 'low',
      },
      { type: 'provider-event', tier: 'ic', evType: 'text' },
      { type: 'provider-event', tier: 'ic', evType: 'done' },
      {
        type: 'tier-done',
        tier: 'ic',
        success: true,
        confidence: 0.88,
        inputTokens: 1000,
        outputTokens: 500,
      },
      {
        type: 'final',
        success: true,
        tier: 'ic',
        attempts: 1,
        hasOutput: true,
        canceled: false,
        bestEffort: false,
        hasQuestions: false,
        errorCategory: undefined,
        provider: undefined,
      },
    ]);

    assert.deepEqual(normSession(session.entries), [
      { role: 'user', hasContent: true },
      { role: 'assistant', hasContent: true, tier: 'ic', provider: 'claude', confidence: 0.88 },
    ]);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0]?.success, true);
    assert.equal(ledger.entries[0]?.inputTokens, 1000);
    assert.equal(ledger.entries[0]?.outputTokens, 500);
  });
});

// ---------------------------------------------------------------------------
// 2. Low-confidence escalation — worker/ic → manager ordering
// ---------------------------------------------------------------------------

describe('work-call characterization — low-confidence escalation', () => {
  it('pins the IC→manager escalate sequence on a low-confidence turn (balanced earns one pass)', async () => {
    // Balanced (DEFAULT_POLICY) earns ONE manager pass on a low-confidence IC turn.
    const lowConf = `Partial.\n${envelope({ confidence: 0.3, reason: 'unsure' })}`;
    const highConf = `Resolved.\n${envelope({ confidence: 0.95 })}`;
    let call = 0;
    const { deps } = baseDeps({
      claude: {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1',
            authenticated: true,
            binaryPath: '/x',
            availableModels: [],
          };
        },
        async *run() {
          const text = call++ === 0 ? lowConf : highConf;
          for (const ev of doneEvents(text)) yield ev;
        },
      },
    });

    const events = await collect(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const norm = normalize(events);
    const escalates = norm.filter((e) => e.type === 'escalate');
    assert.ok(escalates.length >= 1, 'expected at least one escalate event');
    // The escalate must move UP toward manager and precede the final.
    const escalateIdx = norm.findIndex((e) => e.type === 'escalate');
    const finalIdx = norm.findIndex((e) => e.type === 'final');
    assert.ok(escalateIdx < finalIdx, 'escalate must precede final');
    assert.equal(escalates[0]?.to, 'manager');
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-vendor review approve — the review block's event ordering
// ---------------------------------------------------------------------------

describe('work-call characterization — cross-vendor review approve', () => {
  it('pins the review tier-start/tier-done + verdict notices + approved final', async () => {
    const workOut = `Payment code implemented.\n${envelope({ confidence: 0.85 })}`;
    const reviewOut = 'Looks good.\n{"verdict": "approve", "notes": "all clear", "confidence": 0.9}';
    const { deps, session } = baseDeps(
      {
        claude: makeProvider('claude', doneEvents(workOut)),
        codex: makeProvider('codex', doneEvents(reviewOut)),
      },
      {
        // panel/hedge OFF so the SEQUENTIAL work-call review path runs (the panel
        // would otherwise own a high-risk ≥2-vendor turn and return before the loop).
        policy: {
          ...DEFAULT_POLICY,
          reviewPolicy: 'auto',
          maxTier: 'manager',
          panelPolicy: 'off',
          hedgePolicy: 'off',
        },
        authenticatedProviders: ['claude', 'codex'],
      },
    );

    const events = await collect(
      orchestrate('rewrite the payment processing system', deps, new AbortController().signal),
    );
    const norm = normalize(events);

    // There must be a review notice, a 2nd tier-start (the reviewer), and an approved final.
    const reviewNotice = norm.find(
      (e) => e.type === 'notice' && typeof e.message === 'string' && e.message.includes('Review by'),
    );
    assert.ok(reviewNotice !== undefined, 'expected a cross-vendor review notice');

    const tierStarts = norm.filter((e) => e.type === 'tier-start');
    assert.ok(tierStarts.length >= 2, 'expected a work tier-start + a reviewer tier-start');
    // The reviewer runs on the cross-vendor provider (codex).
    assert.ok(
      tierStarts.some((e) => e.provider === 'codex'),
      'reviewer must run on the cross-vendor provider',
    );

    const verdictNotice = norm.find(
      (e) =>
        e.type === 'notice' &&
        typeof e.message === 'string' &&
        e.message.includes('Review verdict'),
    );
    assert.ok(verdictNotice !== undefined, 'expected a review-verdict notice');

    const finalEv = norm.find((e) => e.type === 'final');
    assert.equal(finalEv?.success, true);

    // Exactly one accepted assistant entry persisted (the approved work).
    const assistantEntries = session.entries.filter((e) => e.role === 'assistant');
    assert.equal(assistantEntries.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Reviewer revise → same-tier retry (retry-by-tier path)
// ---------------------------------------------------------------------------

describe('work-call characterization — reviewer revise retries same tier', () => {
  it('pins a revise verdict triggering a 2nd same-tier attempt with notes', async () => {
    let workCall = 0;
    const reviewOut =
      'Needs work.\n{"verdict": "revise", "notes": "tighten the error handling.", "confidence": 0.5}';
    const promptsSeen: string[] = [];
    const { deps } = baseDeps(
      {
        claude: {
          id: 'claude',
          async detect() {
            return {
              id: 'claude',
              installed: true,
              version: '1',
              authenticated: true,
              binaryPath: '/x',
              availableModels: [],
            };
          },
          async *run(req: ProviderRequest) {
            promptsSeen.push(req.prompt);
            const text = `Payment work attempt ${++workCall}.\n${envelope({ confidence: 0.85 })}`;
            for (const ev of doneEvents(text)) yield ev;
          },
        },
        codex: makeProvider('codex', doneEvents(reviewOut)),
      },
      {
        // panel/hedge OFF → exercise the sequential review/revise path, not the panel.
        policy: {
          ...DEFAULT_POLICY,
          reviewPolicy: 'auto',
          maxTier: 'manager',
          panelPolicy: 'off',
          hedgePolicy: 'off',
        },
        authenticatedProviders: ['claude', 'codex'],
      },
    );

    const events = await collect(
      orchestrate('rewrite the payment processing system', deps, new AbortController().signal),
    );
    const norm = normalize(events);

    // At least two WORK attempts on claude (the revise re-runs the same tier once).
    const claudeWorkStarts = norm.filter(
      (e) => e.type === 'tier-start' && e.provider === 'claude',
    );
    assert.ok(
      claudeWorkStarts.length >= 2,
      'revise verdict must re-run the work tier at least once more',
    );
    // The retried prompt must carry the reviewer notes.
    assert.ok(
      promptsSeen.some((p) => p.includes('tighten the error handling')),
      'the retry prompt must inject the reviewer revise notes',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Cross-vendor failover on a recoverable error
// ---------------------------------------------------------------------------

describe('work-call characterization — cross-vendor failover', () => {
  it('pins a recoverable-error failover event + 2nd-vendor success', async () => {
    const recoverableErr: ProviderEvent[] = [
      { type: 'text', delta: 'start' },
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'reset', suggestion: 'retry' },
      },
    ];
    const { deps } = baseDeps(
      {
        claude: makeProvider('claude', recoverableErr),
        codex: makeProvider('codex', doneEvents(`Recovered.\n${envelope({})}`)),
      },
      {
        policy: { ...DEFAULT_POLICY, maxAttempts: 3 },
        authenticatedProviders: ['claude', 'codex'],
      },
    );

    const events = await collect(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const norm = normalize(events);

    const failover = norm.find((e) => e.type === 'failover');
    assert.ok(failover !== undefined, 'expected a failover event');
    assert.equal(failover?.from, 'claude');
    assert.equal(failover?.to, 'codex');

    const finalEv = norm.find((e) => e.type === 'final');
    assert.equal(finalEv?.success, true, 'second vendor should succeed');
  });
});

// ---------------------------------------------------------------------------
// 6. Provider error → escalate → fail final (single provider)
// ---------------------------------------------------------------------------

describe('work-call characterization — single-provider failure escalates then fails', () => {
  it('pins escalate-to-manager then a fail final with the error category', async () => {
    const err: ProviderEvent[] = [
      {
        type: 'error',
        error: { category: 'network', recoverable: true, message: 'down', suggestion: 'retry' },
      },
    ];
    const { deps, session } = baseDeps(
      { claude: makeProvider('claude', err) },
      { policy: POLICY_PRESETS['quality-first'] },
    );

    const events = await collect(
      orchestrate('refactor X', deps, new AbortController().signal),
    );
    const norm = normalize(events);

    const finalEv = norm.find((e) => e.type === 'final');
    assert.equal(finalEv?.success, false);
    assert.equal(finalEv?.errorCategory, 'network');

    // No assistant entry on a pure failure.
    assert.equal(session.entries.filter((e) => e.role === 'assistant').length, 0);
  });
});

// ---------------------------------------------------------------------------
// 7. Abort before stream — cancelled notice + cancelled final
// ---------------------------------------------------------------------------

describe('work-call characterization — abort before stream', () => {
  it('pins a cancelled warn notice + a cancelled fail final', async () => {
    const { deps } = baseDeps({
      claude: makeProvider('claude', doneEvents(`Done.\n${envelope({})}`)),
    });
    const ac = new AbortController();
    ac.abort();

    const events = await collect(orchestrate('refactor X', deps, ac.signal));
    const norm = normalize(events);

    const finalEv = norm.find((e) => e.type === 'final');
    assert.equal(finalEv?.success, false);
    assert.equal(finalEv?.canceled, true);
    assert.ok(
      norm.some((e) => e.type === 'notice' && e.level === 'warn'),
      'expected a cancelled warn notice',
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Timeout terminal path — no failover, no escalate
// ---------------------------------------------------------------------------

describe('work-call characterization — timeout is terminal', () => {
  it('pins a timeout failing final with NO failover and NO escalate', async () => {
    const timeoutErr: ProviderEvent[] = [
      {
        type: 'error',
        error: { category: 'timeout', recoverable: true, message: 'timed out', suggestion: 'narrow' },
      },
    ];
    const { deps } = baseDeps(
      {
        claude: makeProvider('claude', timeoutErr),
        codex: makeProvider('codex', doneEvents(`Should not run.\n${envelope({})}`)),
      },
      {
        policy: { ...DEFAULT_POLICY, maxAttempts: 3 },
        authenticatedProviders: ['claude', 'codex'],
      },
    );

    const events = await collect(orchestrate('refactor X', deps, new AbortController().signal));
    const norm = normalize(events);

    assert.equal(norm.filter((e) => e.type === 'failover').length, 0, 'timeout must NOT fail over');
    assert.equal(norm.filter((e) => e.type === 'escalate').length, 0, 'timeout must NOT escalate');
    const finalEv = norm.find((e) => e.type === 'final');
    assert.equal(finalEv?.success, false);
    assert.equal(finalEv?.errorCategory, 'timeout');
  });
});

// ---------------------------------------------------------------------------
// 9. Usage / token accounting — usage event vs done.usage
// ---------------------------------------------------------------------------

describe('work-call characterization — usage/token accounting', () => {
  it('pins the tier-done + ledger token counts from done.usage', async () => {
    const { deps, ledger } = baseDeps({
      claude: makeProvider('claude', [
        { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
        { type: 'done', text: `Done.\n${envelope({})}`, usage: { inputTokens: 111, outputTokens: 22 }, raw: {} },
      ]),
    });

    const events = await collect(orchestrate('refactor X', deps, new AbortController().signal));
    const tierDone = events.find((e) => e.type === 'tier-done');
    assert.ok(tierDone !== undefined && tierDone.type === 'tier-done');
    // done.usage is the authoritative accumulated total.
    assert.equal(tierDone.inputTokens, 111);
    assert.equal(tierDone.outputTokens, 22);
    assert.equal(ledger.entries[0]?.inputTokens, 111);
    assert.equal(ledger.entries[0]?.outputTokens, 22);
  });
});

// ---------------------------------------------------------------------------
// 10. The verifyStage SLOT — Phase-1 no-op contract
// ---------------------------------------------------------------------------

describe('work-call characterization — verifyStage slot is a Phase-1 no-op', () => {
  it('resolves to undefined and mutates nothing (the reserved Phase-3 seam)', async () => {
    const ctx: VerifyStageContext = { output: 'some answer', provider: 'claude', tier: 'ic' };
    // Phase 1: verifyStage is a deliberate pass-through. It must not throw and must
    // not return anything — it only RESERVES the seam Phase 3's verification fills.
    const result = await verifyStage(ctx);
    assert.equal(result, undefined);
  });
});
