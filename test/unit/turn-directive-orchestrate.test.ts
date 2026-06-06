/**
 * test/unit/turn-directive-orchestrate.test.ts — Adaptive Partner Engine v2,
 * STAGE 1 wiring INSIDE orchestrate:
 *
 *   - the PRE-PROVIDER terminal ask: a planned ASK_CLARIFYING at a genuine fork
 *     yields a final+questions with ZERO provider attempts and zero cost — the
 *     provider's run() is never called;
 *   - the ONE-RETRY repair: a first answer that is a generic open menu is re-run
 *     once at the same tier with the repair note, and a passing second answer is
 *     accepted; if the second still fails, a usable answer is KEPT (never Failed);
 *   - HISTORY QUARANTINE: a prior assistant generic menu is dropped from the
 *     replayed history block reaching the provider prompt.
 *
 * All deps faked in-memory — no live model.
 */

import { describe, it } from 'node:test';
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

/** A provider whose run() returns a scripted sequence of texts and counts calls. */
function scriptedProvider(
  id: 'claude' | 'codex',
  texts: readonly string[],
): Provider & { calls: number; prompts: string[] } {
  const obj = {
    id,
    calls: 0,
    prompts: [] as string[],
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const text = texts[Math.min(obj.calls, texts.length - 1)] ?? '';
      obj.calls++;
      obj.prompts.push(req.prompt);
      yield { type: 'done', text, usage: FAKE_USAGE, raw: {} };
    },
  };
  return obj as unknown as Provider & { calls: number; prompts: string[] };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function baseDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: { claude: scriptedProvider('claude', [`Done.\n${ENVELOPE}`]) },
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

const GENERIC_MENU =
  'Happy to help! What are you trying to do — are you fixing something broken, ' +
  'adding a new feature, or polishing the layout?';
const GROUNDED_ANSWER = `I inspected src/socials.tsx; the next step is to wire the live feed. Done.\n${ENVELOPE}`;

// ---------------------------------------------------------------------------
// Pre-provider terminal ask — zero provider attempts
// ---------------------------------------------------------------------------

describe('orchestrate pre-provider terminal ask (A1)', () => {
  it('emits final+questions with ZERO provider attempts on a genuine fork', async () => {
    const provider = scriptedProvider('claude', [`Done.\n${ENVELOPE}`]);
    const session = makeFakeSession();
    const frame: IntentFrame = {
      version: 1,
      goal: 'write the launch announcement',
      kind: 'writing',
      confidence: 'low',
      forks: [
        {
          id: 'F1',
          question: 'Which tone do you prefer for the announcement?',
          options: ['Playful', 'Formal'],
          assumeIfUnasked: 'Playful',
        },
      ],
      source: 'model',
    };
    const events = await collect(
      orchestrate(
        'write the launch announcement copy for the whole product team and the press',
        baseDeps({
          providers: { claude: provider },
          session,
          intentExtractor: async () => frame,
          partnerStyle: 'collaborative',
        }),
        new AbortController().signal,
      ),
    );

    assert.equal(provider.calls, 0, 'the provider must NEVER run for a pre-provider ask');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    assert.equal(final.attempts, 0, 'zero attempts');
    assert.equal(final.totalCostUsd, 0, 'zero cost');
    assert.ok(final.questions !== undefined, 'carries the structured QuestionSet');
    assert.equal(final.questions.questions[0]?.id, 'F1');
    // user + empty assistant entry appended symmetrically with the model-ask path.
    assert.equal(session.entries.filter((e) => e.role === 'user').length, 1);
    const assistant = session.entries.find((e) => e.role === 'assistant');
    assert.ok(assistant !== undefined && assistant.content === '');
  });

  it('does NOT pre-ask on an investigable generic-menu fork (runs the provider)', async () => {
    const provider = scriptedProvider('claude', [GROUNDED_ANSWER]);
    const frame: IntentFrame = {
      version: 1,
      goal: 'improve the page',
      kind: 'coding',
      confidence: 'low',
      forks: [
        {
          id: 'F1',
          question: 'What are you trying to do with the existing page?',
          options: ['fix something', 'add a feature', 'polish the layout'],
        },
      ],
      source: 'model',
    };
    const events = await collect(
      orchestrate(
        'make the existing socials page in this repo feel like the real product end to end',
        baseDeps({ providers: { claude: provider }, intentExtractor: async () => frame, partnerStyle: 'collaborative' }),
        new AbortController().signal,
      ),
    );
    assert.ok(provider.calls >= 1, 'an investigable fork runs the provider, not a pre-ask');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.questions, undefined, 'no terminal ask was emitted');
  });
});

// ---------------------------------------------------------------------------
// One-retry repair (A2)
// ---------------------------------------------------------------------------

describe('orchestrate generic-menu repair (A2)', () => {
  it('re-runs ONCE with a repair note and accepts the repaired grounded answer', async () => {
    // First answer is a generic menu; second is grounded. repoPresent via env block.
    const provider = scriptedProvider('claude', [`${GENERIC_MENU}\n${ENVELOPE}`, GROUNDED_ANSWER]);
    const events = await collect(
      orchestrate(
        'make the existing dashboard page in this repo feel like the real product',
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: myapp (clean)\n',
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 2, 'exactly one repair retry');
    // The repair note reached the second prompt.
    assert.match(provider.prompts[1] ?? '', /generic task-category menu/i);
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    assert.match(final.output, /next step is to wire the live feed/);
  });

  it('keeps a usable answer (never Failed) when the repair still returns a menu', async () => {
    const provider = scriptedProvider('claude', [`${GENERIC_MENU}\n${ENVELOPE}`]); // always the menu
    const events = await collect(
      orchestrate(
        'make the existing dashboard page in this repo feel like the real product',
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: myapp (clean)\n',
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 2, 'repair fires once, then stops (bounded)');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true, 'a usable answer is kept, not discarded as Failed');
    assert.match(final.output, /What are you trying to do/);
  });

  it('does NOT repair (no extra call) when there is no repo orientation', async () => {
    const provider = scriptedProvider('claude', [`${GENERIC_MENU}\n${ENVELOPE}`]);
    const events = await collect(
      orchestrate(
        'brainstorm a few directions for a brand-new side project from scratch',
        baseDeps({ providers: { claude: provider } }), // no environmentContext, no investigate
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 1, 'no repair retry on a non-repo brainstorming turn');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
  });
});

// ---------------------------------------------------------------------------
// STAGE 5 (AP2-E, §2.6 E) — grounded-recommendation repair + shared budget
// ---------------------------------------------------------------------------

// A substantial decision task that classifies low-risk (so no cross-vendor review
// preempts the local grounded repair). Repo present so a recommendation is gradable.
const DECISION_TASK = 'which logging approach is better for this small CLI, pino or winston?';
const UNGROUNDED_REC = `I recommend pino. It is better. Trust me.\n${ENVELOPE}`;
const GROUNDED_REC = `I recommend pino — see src/log.ts:3, the CLI already imports it. What would change this: a need for transport plugins.\n${ENVELOPE}`;
const BARE_OPTIONS = `Here are some options: pino, winston, or bunyan. Up to you.\n${ENVELOPE}`;

describe('orchestrate grounded-recommendation repair (AP2-E §2.6 E)', () => {
  it('re-runs ONCE on an ungrounded recommendation and accepts the grounded retry', async () => {
    const provider = scriptedProvider('claude', [UNGROUNDED_REC, GROUNDED_REC]);
    const events = await collect(
      orchestrate(
        DECISION_TASK,
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: cli (clean)\n',
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 2, 'exactly one grounded-recommendation repair retry');
    assert.match(provider.prompts[1] ?? '', /recommend a DEFAULT|grounding|grounded recommendation/i);
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    assert.match(final.output, /src\/log\.ts/);
  });

  it('appends the truthful fallback ONLY when nothing could be grounded after the retry', async () => {
    const provider = scriptedProvider('claude', [UNGROUNDED_REC]); // always ungrounded
    const events = await collect(
      orchestrate(
        DECISION_TASK,
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: cli (clean)\n',
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 2, 'repair fires once, then stops (bounded)');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true, 'a usable answer is kept, not discarded');
    assert.match(
      final.output,
      /cannot ground a recommendation from the current output/,
      'the deterministic truthful fallback is appended when still ungrounded',
    );
  });

  it('does NOT append the fallback when the answer is already grounded', async () => {
    const provider = scriptedProvider('claude', [GROUNDED_REC]);
    const events = await collect(
      orchestrate(
        DECISION_TASK,
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: cli (clean)\n',
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 1, 'a grounded recommendation passes — no repair');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.doesNotMatch(final.output, /cannot ground a recommendation/);
  });

  it('SHARED budget: a generic-menu THEN an ungrounded answer retry AT MOST once total', async () => {
    // First answer is a generic open menu (fires reject_generic_open_menu); the
    // repaired second answer is still ungrounded (would fire the grounded validator)
    // — but the SHARED budget (MAX_VALIDATOR_REPAIRS = 1) is already spent, so the
    // ungrounded answer is KEPT (with the truthful fallback) rather than retried again.
    const provider = scriptedProvider('claude', [`${GENERIC_MENU}\n${ENVELOPE}`, UNGROUNDED_REC]);
    const events = await collect(
      orchestrate(
        DECISION_TASK,
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: cli (clean)\n',
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 2, 'generic-menu + grounded share ONE retry — never two');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, true);
    assert.match(final.output, /cannot ground a recommendation/);
  });

  it('re-runs ONCE on a bare options list with no recommendation', async () => {
    const provider = scriptedProvider('claude', [BARE_OPTIONS, GROUNDED_REC]);
    const events = await collect(
      orchestrate(
        DECISION_TASK,
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: cli (clean)\n',
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(provider.calls, 2, 'a bare options list with no recommendation is repaired once');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.match(final.output, /src\/log\.ts/);
  });

  it('does NOT fire on a tiny factual turn (no repair, no fallback)', async () => {
    const provider = scriptedProvider('claude', [`2 + 2 is 4.\n${ENVELOPE}`]);
    const events = await collect(
      orchestrate('what is 2+2', baseDeps({ providers: { claude: provider } }), new AbortController().signal),
    );
    assert.equal(provider.calls, 1, 'a trivial factual turn is never gated');
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    assert.doesNotMatch(final.output, /cannot ground a recommendation/);
  });
});

// ---------------------------------------------------------------------------
// History quarantine (§3)
// ---------------------------------------------------------------------------

describe('orchestrate history quarantine', () => {
  it('drops a prior assistant generic menu from the replayed history block', async () => {
    const provider = scriptedProvider('claude', [GROUNDED_ANSWER]);
    const history: SessionEntry[] = [
      { timestamp: 't0', role: 'user', content: 'help me with the socials page' },
      {
        timestamp: 't1',
        role: 'assistant',
        content:
          'What are you trying to do — are you fixing something, adding a feature, or polishing the layout?',
      },
      { timestamp: 't2', role: 'user', content: 'the socials page' },
    ];
    await collect(
      orchestrate(
        'make the existing socials page in this repo feel like the real product',
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: myapp\n',
          history,
        }),
        new AbortController().signal,
      ),
    );
    const prompt = provider.prompts[0] ?? '';
    assert.ok(prompt.length > 0);
    // The user turns survive; the poisoned assistant menu is quarantined.
    assert.match(prompt, /help me with the socials page/);
    assert.doesNotMatch(prompt, /are you fixing something, adding a feature/);
  });

  it('keeps normal assistant prose in the replayed history', async () => {
    const provider = scriptedProvider('claude', [GROUNDED_ANSWER]);
    const history: SessionEntry[] = [
      { timestamp: 't0', role: 'user', content: 'wire the feed' },
      { timestamp: 't1', role: 'assistant', content: 'I wired the feed and tests pass.' },
    ];
    await collect(
      orchestrate(
        'make the existing socials page in this repo feel like the real product',
        baseDeps({
          providers: { claude: provider },
          environmentContext: 'ENVIRONMENT:\nrepo: myapp\n',
          history,
        }),
        new AbortController().signal,
      ),
    );
    const prompt = provider.prompts[0] ?? '';
    assert.match(prompt, /I wired the feed and tests pass/);
  });
});
