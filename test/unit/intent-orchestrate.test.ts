/**
 * test/unit/intent-orchestrate.test.ts — the Phase-6 wiring INSIDE orchestrate:
 * the gate (trivial → no intent call, no engagement; substantial → mocked
 * extractor runs), fail-soft (extractor null/throws → rules frame, turn proceeds),
 * RouteDecision.plan consumed, work-contract seeded from the frame, ask_user
 * derived from a planned ASK_CLARIFYING, and INTENT+ENGAGEMENT blocks reaching a
 * PANEL candidate prompt via the shared assembleContextBlocks seam.
 *
 * All deps faked in-memory — no live model.
 */

import { describe, it } from 'vitest';
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
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';

// --- fakes -----------------------------------------------------------------

function makeFakeClock(): Clock {
  const now = 1_000_000;
  let n = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `uuid-${++n}`,
    random: () => 0.42,
  } as Clock;
}
function makeFakeSession(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return { id: 'sess-1', async append(e) { entries.push(e); }, entries };
}
function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { async record(e) { entries.push(e); }, entries };
}

const ENVELOPE = '{"confidence": 0.88, "escalate": false, "reason": "done", "needs_review": false}';
const FAKE_USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

function fakeProvider(id: 'claude' | 'codex', text: string): Provider {
  return {
    id,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
    },
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function baseDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: { claude: fakeProvider('claude', `Done.\n${ENVELOPE}`) },
    clock: makeFakeClock(),
    session: makeFakeSession(),
    ledger: makeFakeLedger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake/cwd',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The gate — trivial turn makes NO intent call, emits NO intent/engagement event
// ---------------------------------------------------------------------------

describe('orchestrate intent gate', () => {
  it('a trivial turn never calls the extractor and emits no intent/engagement events', async () => {
    let calls = 0;
    const extractor = async (): Promise<IntentFrame | null> => {
      calls++;
      return { version: 1, goal: 'x', confidence: 'high', source: 'model' };
    };
    const events = await collect(
      orchestrate('what is 2+2', baseDeps({ intentExtractor: extractor }), new AbortController().signal),
    );
    assert.equal(calls, 0, 'extractor must NOT be called on a trivial turn');
    assert.ok(!events.some((e) => e.type === 'intent'), 'no intent event');
    assert.ok(!events.some((e) => e.type === 'engagement'), 'no engagement event on a trivial turn');
  });

  it('a substantial turn runs the (mocked) extractor and emits an intent event', async () => {
    let calls = 0;
    const frame: IntentFrame = {
      version: 1,
      goal: 'redesign the auth and billing subsystems',
      kind: 'planning',
      confidence: 'low',
      source: 'model',
    };
    const extractor = async (): Promise<IntentFrame | null> => {
      calls++;
      return frame;
    };
    const events = await collect(
      orchestrate(
        'redesign the auth, billing and notification subsystems together end to end',
        baseDeps({ intentExtractor: extractor }),
        new AbortController().signal,
      ),
    );
    assert.equal(calls, 1, 'extractor runs exactly once on a substantial turn');
    const intent = events.find((e) => e.type === 'intent');
    assert.ok(intent !== undefined && intent.type === 'intent');
    assert.equal(intent.frame.goal, 'redesign the auth and billing subsystems');
    assert.equal(intent.frame.source, 'model', 'source is model when extractor is wired');
  });

  it('a substantial turn WITHOUT extractor → if intent emitted, source is "skipped" (rules fallback)', async () => {
    const events = await collect(
      orchestrate(
        'implement the login endpoint with oauth',
        baseDeps(),
        new AbortController().signal,
      ),
    );
    const intent = events.find((e) => e.type === 'intent');
    // Without an extractor, an intent event may or may not be emitted;
    // if it IS emitted, the source must be "skipped" (rules fallback).
    if (intent !== undefined) {
      assert.equal(intent.frame.source, 'skipped', 'source is skipped when no extractor');
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-soft — extractor returns null / throws / "times out" → rules frame
// ---------------------------------------------------------------------------

describe('orchestrate intent fail-soft', () => {
  for (const [label, extractor] of [
    ['null', async () => null],
    ['throws', async () => { throw new Error('boom'); }],
  ] as const) {
    it(`extractor ${label} → turn proceeds to a successful final (no hang)`, async () => {
      const events = await collect(
        orchestrate(
          'first set up the database, then wire the API, and finally add tests',
          baseDeps({ intentExtractor: extractor as unknown as OrchestrateDeps['intentExtractor'] }),
          new AbortController().signal,
        ),
      );
      const final = events.find((e) => e.type === 'final');
      assert.ok(final !== undefined && final.type === 'final');
      assert.equal(final.success, true, 'turn completes despite extractor failure');
    });
  }
});

// ---------------------------------------------------------------------------
// route.plan consumed → work-contract seeded from the frame
// ---------------------------------------------------------------------------

describe('orchestrate work-contract seed from intent', () => {
  it('seeds objective ← frame.goal and a roadmap when route.plan is true (consumed)', async () => {
    const session = makeFakeSession();
    const frame: IntentFrame = {
      version: 1,
      goal: 'ship the analytics dashboard',
      doneWhen: 'all KPIs render under 1s',
      confidence: 'low',
      source: 'model',
    };
    // routeClassifier with plan:true drives RouteDecision.plan on this no-keyword turn.
    const routeClassifier = async () => ({ tier: 'manager' as const, plan: true, reason: 'big' });
    await collect(
      orchestrate(
        'put together the thing we discussed across the stack',
        baseDeps({
          session,
          intentExtractor: async () => frame,
          routeClassifier,
        }),
        new AbortController().signal,
      ),
    );
    const assistant = session.entries.find((e) => e.role === 'assistant');
    assert.ok(assistant !== undefined);
    assert.equal(assistant.workTrace?.objective, 'ship the analytics dashboard');
    assert.equal(assistant.workTrace?.vision, 'all KPIs render under 1s');
    assert.ok((assistant.workTrace?.roadmap?.length ?? 0) >= 1, 'route.plan consumed → roadmap seeded');
  });
});

// ---------------------------------------------------------------------------
// ask_user derived from a planned ASK_CLARIFYING when the model didn't ask
// ---------------------------------------------------------------------------

describe('orchestrate ask_user derived from forks', () => {
  it('surfaces a derived QuestionSet when collaborative + a real fork + model did not ask', async () => {
    const frame: IntentFrame = {
      version: 1,
      goal: 'set up the new service',
      confidence: 'low',
      forks: [{ id: 'F1', question: 'which datastore?', options: ['Postgres', 'DynamoDB'], assumeIfUnasked: 'Postgres' }],
      source: 'model',
    };
    const events = await collect(
      orchestrate(
        'set up the new service for the platform across the board',
        baseDeps({
          intentExtractor: async () => frame,
          partnerStyle: 'collaborative', // raises the fork budget to 1
          completionResultV1: true,
        }),
        new AbortController().signal,
      ),
    );
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.ok(final.questions !== undefined, 'a derived ask_user QuestionSet is surfaced');
    assert.equal(final.questions.questions[0]?.id, 'F1');
    assert.equal(final.questions.questions[0]?.prompt, 'which datastore?');
    assert.equal(final.completionResult?.terminal, 'needs-user');
    assert.equal(final.completionResult?.success, false);
    assert.equal(final.completionResult?.goalSettlement.state, 'needs-user');
    assert.equal(final.completionResult?.replayPolicy.replay, 'needs-user');
  });
});

// ---------------------------------------------------------------------------
// INTENT + ENGAGEMENT blocks reach a PANEL candidate prompt (the seam regression)
// ---------------------------------------------------------------------------

describe('orchestrate intent/engagement blocks reach a panel prompt', () => {
  it('a panel candidate prompt carries the INTENT and ENGAGEMENT blocks', async () => {
    const candidatePrompts: string[] = [];
    const recordingProvider = (id: 'claude' | 'codex'): Provider => ({
      id,
      async detect() {
        return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
        // Candidate prompts contain the panel-member preamble; the intent
        // extractor prompt contains "You extract the INTENT" — exclude it.
        if (req.prompt.includes('independent member of an expert panel')) {
          candidatePrompts.push(req.prompt);
        }
        yield { type: 'done', text: `A panel answer.\n${ENVELOPE}`, usage: FAKE_USAGE, raw: {} };
      },
    });

    // High confidence + a non-substantial single-clause task so the brain's
    // adaptive loop returns `answer` (no investigate/reflect_confirm gate) and the
    // turn reaches the panel branch — which is what this test exercises (the
    // INTENT/ENGAGEMENT block threading into the panel candidate prompt). The
    // recalibrated brain (Fix 2) reflect_confirms a MEASURED substantial build, so
    // this test deliberately uses a clearly-understood, modest-scope turn.
    const frame: IntentFrame = {
      version: 1,
      goal: 'rebuild the homepage as I envisioned',
      kind: 'design',
      doneWhen: 'matches the 2010-youtube mock',
      confidence: 'high',
      source: 'model',
    };

    const deps = baseDeps({
      providers: { claude: recordingProvider('claude'), codex: recordingProvider('codex') },
      authenticatedProviders: ['claude', 'codex'],
      policy: { ...DEFAULT_POLICY, panelPolicy: 'always', maxPanelProviders: 2 },
      intentExtractor: async () => frame,
    });

    await collect(
      orchestrate(
        'rebuild the homepage, give it an old-2010 YouTube social feel and a video feed',
        deps,
        new AbortController().signal,
      ),
    );

    assert.ok(candidatePrompts.length >= 1, 'expected at least one panel candidate prompt');
    const p = candidatePrompts[0] ?? '';
    assert.ok(p.includes('INTENT'), 'panel candidate carries the INTENT block (via the seam)');
    assert.ok(p.includes('rebuild the homepage as I envisioned'), 'INTENT goal present');
    assert.ok(p.includes('ENGAGEMENT'), 'panel candidate carries the ENGAGEMENT block (via the seam)');
  });
});
