/**
 * Unit tests for src/core/ensemble.ts — the Parallel Subscription Panel.
 *
 * Pure tests for planPanel + the two prompt builders, plus integration tests for
 * runPanel using fake providers (mirrors test/unit/orchestrate.test.ts).
 * Run with: node --experimental-strip-types --test test/unit/ensemble.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planPanel,
  runPanel,
  buildPanelCandidatePrompt,
  buildPanelSynthesisPrompt,
  type PanelPlan,
} from '../../src/core/ensemble.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type {
  Classification,
  Clock,
  SessionWriter,
  SessionEntry,
  LedgerWriter,
  LedgerEntry,
  OrchestrateDeps,
  CoreEvent,
} from '../../src/core/types.ts';
import type {
  Provider,
  ProviderRequest,
  ProviderEvent,
  ProviderId,
  Usage,
} from '../../src/providers/port.ts';

// ---------------------------------------------------------------------------
// Pure: planPanel
// ---------------------------------------------------------------------------

const HIGH: Classification = { tier: 'ic', risk: 'high', rationale: 'r' };
const LOW: Classification = { tier: 'ic', risk: 'low', rationale: 'r' };
const CRIT: Classification = { tier: 'manager', risk: 'critical', rationale: 'r' };

describe('planPanel — gating', () => {
  it("panelPolicy 'off' → null", () => {
    assert.equal(
      planPanel({
        panelPolicy: 'off',
        classification: HIGH,
        tier: 'ic',
        authenticatedProviders: ['claude', 'codex'],
        maxPanelProviders: 2,
      }),
      null,
    );
  });

  it('panelPolicy undefined → null', () => {
    assert.equal(
      planPanel({
        panelPolicy: undefined,
        classification: HIGH,
        tier: 'ic',
        authenticatedProviders: ['claude', 'codex'],
        maxPanelProviders: 2,
      }),
      null,
    );
  });

  it("'hard-turns' on low risk → null", () => {
    assert.equal(
      planPanel({
        panelPolicy: 'hard-turns',
        classification: LOW,
        tier: 'ic',
        authenticatedProviders: ['claude', 'codex'],
        maxPanelProviders: 2,
      }),
      null,
    );
  });

  it("'hard-turns' on high risk → a plan", () => {
    const plan = planPanel({
      panelPolicy: 'hard-turns',
      classification: HIGH,
      tier: 'ic',
      authenticatedProviders: ['claude', 'codex'],
      maxPanelProviders: 2,
    });
    assert.ok(plan !== null);
    assert.deepEqual(plan.candidates, ['claude', 'codex']);
  });

  it("'hard-turns' on critical risk → a plan", () => {
    const plan = planPanel({
      panelPolicy: 'hard-turns',
      classification: CRIT,
      tier: 'manager',
      authenticatedProviders: ['claude', 'codex'],
      maxPanelProviders: 2,
    });
    assert.ok(plan !== null);
  });

  it("'always' forms a plan even on low risk", () => {
    const plan = planPanel({
      panelPolicy: 'always',
      classification: LOW,
      tier: 'ic',
      authenticatedProviders: ['claude', 'codex'],
      maxPanelProviders: 2,
    });
    assert.ok(plan !== null);
  });
});

describe('planPanel — composition', () => {
  it('fewer than 2 authenticated providers → null', () => {
    assert.equal(
      planPanel({
        panelPolicy: 'always',
        classification: LOW,
        tier: 'ic',
        authenticatedProviders: ['claude'],
        maxPanelProviders: 2,
      }),
      null,
    );
    assert.equal(
      planPanel({
        panelPolicy: 'always',
        classification: LOW,
        tier: 'ic',
        authenticatedProviders: [],
        maxPanelProviders: 4,
      }),
      null,
    );
  });

  it('cap floors at 2 even when maxPanelProviders < 2', () => {
    const plan = planPanel({
      panelPolicy: 'always',
      classification: LOW,
      tier: 'ic',
      authenticatedProviders: ['claude', 'codex', 'opencode'],
      maxPanelProviders: 1,
    });
    assert.ok(plan !== null);
    assert.equal(plan.candidates.length, 2);
    assert.deepEqual(plan.candidates, ['claude', 'codex']);
  });

  it('slices candidates to the cap', () => {
    const plan = planPanel({
      panelPolicy: 'always',
      classification: LOW,
      tier: 'ic',
      authenticatedProviders: ['claude', 'codex', 'opencode'],
      maxPanelProviders: 2,
    });
    assert.ok(plan !== null);
    assert.deepEqual(plan.candidates, ['claude', 'codex']);
  });

  it('cap above provider count keeps all authenticated providers', () => {
    const plan = planPanel({
      panelPolicy: 'always',
      classification: LOW,
      tier: 'ic',
      authenticatedProviders: ['claude', 'codex', 'opencode'],
      maxPanelProviders: 10,
    });
    assert.ok(plan !== null);
    assert.deepEqual(plan.candidates, ['claude', 'codex', 'opencode']);
  });

  it('synthesizer is candidates[0] and tier is passed through', () => {
    const plan = planPanel({
      panelPolicy: 'always',
      classification: LOW,
      tier: 'manager',
      authenticatedProviders: ['codex', 'claude'],
      maxPanelProviders: 2,
    });
    assert.ok(plan !== null);
    assert.equal(plan.synthesizer, 'codex');
    assert.equal(plan.tier, 'manager');
    // The plan threads the task classification through so runPanel can gate the
    // synthesizer's flagship admission.
    assert.deepEqual(plan.classification, LOW);
  });

  it('is deterministic for identical inputs', () => {
    const opts = {
      panelPolicy: 'always' as const,
      classification: LOW,
      tier: 'ic' as const,
      authenticatedProviders: ['claude', 'codex'] as const,
      maxPanelProviders: 2,
    };
    assert.deepEqual(planPanel(opts), planPanel(opts));
  });
});

// ---------------------------------------------------------------------------
// Pure: prompt builders
// ---------------------------------------------------------------------------

describe('buildPanelCandidatePrompt', () => {
  it('includes the task, the envelope keys, and the independence framing', () => {
    const p = buildPanelCandidatePrompt('ic', 'refactor the auth module');
    assert.match(p, /refactor the auth module/);
    assert.match(p, /independent/i);
    assert.match(p, /"confidence"/);
    assert.match(p, /"assumptions"/);
    assert.match(p, /"what_would_make_this_wrong"/);
  });

  it('injects the history context block when provided', () => {
    const p = buildPanelCandidatePrompt('ic', 'task', 'prior turn summary');
    assert.match(p, /CONVERSATION SO FAR/);
    assert.match(p, /prior turn summary/);
  });

  it('omits the history block when not provided', () => {
    const p = buildPanelCandidatePrompt('ic', 'task');
    assert.doesNotMatch(p, /CONVERSATION SO FAR/);
  });
});

describe('buildPanelSynthesisPrompt', () => {
  const EXPECTED_SYNTH_PROMPT_NO_CONTRACT = `\
You are a senior synthesizer adjudicating an expert panel. 2
engineers each answered the SAME task independently (their answers are below).
Your job is to produce the single best final answer for the user.

How to synthesize:
- Read every panelist's answer carefully and cross-check their claims against one
  another. Where they agree on something substantive, that agreement is evidence
  it is right.
- Where they DISAGREE on something material, do not paper over it: decide which
  position is better supported (and briefly say why), or surface the disagreement
  honestly if it genuinely cannot be resolved from what's here.
- Prefer the best-supported, most concrete claims; discard anything a panelist
  asserted without support that another panelist contradicts.
- Do NOT just stitch the answers together or pick one wholesale — integrate them
  into one coherent, correct answer in your own voice.
- Write the final answer directly to the user. Do not mention "panelists" or this
  instruction unless a real disagreement is worth flagging.

Original task:
design a cache

Independent panel answers:
--- PANELIST 1 (claude) ---
use an LRU

--- PANELIST 2 (codex) ---
use a TTL map

Now write the single final answer for the user.`;

  it('without a contract matches the existing prompt byte-for-byte', () => {
    assert.equal(
      buildPanelSynthesisPrompt('design a cache', [
        { provider: 'claude', output: 'use an LRU' },
        { provider: 'codex', output: 'use a TTL map' },
      ]),
      EXPECTED_SYNTH_PROMPT_NO_CONTRACT,
    );
  });

  it('includes the task, every candidate output, and synthesis instructions', () => {
    const p = buildPanelSynthesisPrompt('design a cache', [
      { provider: 'claude', output: 'use an LRU' },
      { provider: 'codex', output: 'use a TTL map' },
    ]);
    assert.match(p, /design a cache/);
    assert.match(p, /use an LRU/);
    assert.match(p, /use a TTL map/);
    assert.match(p, /claude/);
    assert.match(p, /codex/);
    assert.match(p, /synthesiz/i);
  });

  it('with a contract adds adjudication criteria before the original task', () => {
    const p = buildPanelSynthesisPrompt(
      'design a cache',
      [
        { provider: 'claude', output: 'use an LRU' },
        { provider: 'codex', output: 'use a TTL map' },
      ],
      { version: 1, objective: 'choose a simple cache', vision: 'avoid broad rewrites' },
    );

    assert.match(p, /CONTRACT TO ADJUDICATE AGAINST:\nOBJECTIVE: choose a simple cache\nVISION: avoid broad rewrites/);
    assert.ok(p.indexOf('CONTRACT TO ADJUDICATE AGAINST') < p.indexOf('Original task:'));
  });
});

// ---------------------------------------------------------------------------
// MF1 — the binding regression: panel turns are no longer context-blind.
//
// Before Phase 2, the panel builders threaded NO memory/intent/engagement/
// partner context, so the highest-stakes multi-model turns silently dropped it.
// These assert that BOTH the candidate AND the synthesizer prompt now carry the
// rendered context blocks, in canonical order, via assembleContextBlocks.
// ---------------------------------------------------------------------------

describe('MF1 — panel prompts carry context blocks (no longer context-blind)', () => {
  const MEM = 'USER PREFERENCES AND MEMORY:\n- prefers concise answers';
  const INTENT = 'INTENT (your current understanding):\nShip the cache';
  const ENG = 'ENGAGEMENT:\nFirst inspect the cache layer. Then reflect the goal.';

  it('a panel CANDIDATE prompt contains the MEMORY, INTENT, ENGAGEMENT, and partner-nudge blocks', () => {
    const p = buildPanelCandidatePrompt('ic', 'design a cache', undefined, {
      memoryContext: MEM,
      intentFrame: INTENT,
      engagementPlan: ENG,
      partnerStyle: 'collaborative',
    });
    assert.match(p, /USER PREFERENCES AND MEMORY/);
    assert.match(p, /INTENT \(your current understanding\)/);
    assert.match(p, /ENGAGEMENT:/);
    assert.match(p, /PARTNER POSTURE/);
    // Canonical order MEMORY → INTENT → ENGAGEMENT → nudge, and blocks sit
    // BEFORE the task.
    assert.ok(p.indexOf(MEM) < p.indexOf(INTENT));
    assert.ok(p.indexOf(INTENT) < p.indexOf(ENG));
    assert.ok(p.indexOf(ENG) < p.indexOf('PARTNER POSTURE'));
    assert.ok(p.indexOf('PARTNER POSTURE') < p.indexOf('Task:'));
  });

  it('a panel SYNTHESIS prompt contains the same context blocks, before the panel answers', () => {
    const p = buildPanelSynthesisPrompt(
      'design a cache',
      [
        { provider: 'claude', output: 'use an LRU' },
        { provider: 'codex', output: 'use a TTL map' },
      ],
      undefined,
      {
        memoryContext: MEM,
        intentFrame: INTENT,
        engagementPlan: ENG,
        partnerStyle: 'direct',
      },
    );
    assert.match(p, /USER PREFERENCES AND MEMORY/);
    assert.match(p, /INTENT \(your current understanding\)/);
    assert.match(p, /ENGAGEMENT:/);
    assert.match(p, /PARTNER POSTURE/);
    assert.ok(p.indexOf(MEM) < p.indexOf(INTENT));
    assert.ok(p.indexOf(INTENT) < p.indexOf(ENG));
    // Context rides AFTER the synthesizer preamble and BEFORE the panel answers.
    assert.ok(p.indexOf('PARTNER POSTURE') < p.indexOf('Independent panel answers:'));
  });

  it('panel CANDIDATE stays byte-identical when no context is supplied', () => {
    const withUndefined = buildPanelCandidatePrompt('ic', 'task', undefined, undefined);
    const without = buildPanelCandidatePrompt('ic', 'task');
    assert.equal(withUndefined, without);
    assert.doesNotMatch(without, /PARTNER POSTURE/);
  });

  it('a partner nudge alone reaches both panel builders (soft-bias plumbing)', () => {
    const cand = buildPanelCandidatePrompt('ic', 'task', undefined, {
      partnerStyle: 'direct',
    });
    const synth = buildPanelSynthesisPrompt(
      'task',
      [{ provider: 'claude', output: 'a' }],
      undefined,
      { partnerStyle: 'direct' },
    );
    assert.match(cand, /PARTNER POSTURE/);
    assert.match(synth, /PARTNER POSTURE/);
  });
});

// ---------------------------------------------------------------------------
// Fakes (mirrors orchestrate.test.ts)
// ---------------------------------------------------------------------------

function makeFakeClock(): Clock {
  let now = 1_000_000;
  let n = 0;
  return {
    now: () => (now += 10),
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `fake-uuid-${++n}`,
    random: () => 0.42,
  };
}

function makeFakeSession(id = 'sess-panel-1'): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id,
    async append(e: SessionEntry): Promise<void> {
      entries.push(e);
    },
    entries,
  };
}

function makeFakeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    async record(e: LedgerEntry): Promise<void> {
      entries.push(e);
    },
    entries,
  };
}

const USAGE: Usage = { inputTokens: 1000, outputTokens: 500 };

function makeProvider(
  id: ProviderId,
  text: string,
  opts?: { error?: boolean; onRun?: () => void },
): Provider {
  return {
    id,
    async detect() {
      return {
        id,
        installed: true,
        version: '1',
        authenticated: true,
        binaryPath: '/f',
        availableModels: [],
      };
    },
    async *run(_req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      opts?.onRun?.();
      if (opts?.error === true) {
        yield {
          type: 'error',
          error: { category: 'network', recoverable: true, message: 'boom', suggestion: 'retry' },
        };
        return;
      }
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function panelDeps(providers: Partial<Record<ProviderId, Provider>>): {
  deps: OrchestrateDeps;
  session: ReturnType<typeof makeFakeSession>;
  ledger: ReturnType<typeof makeFakeLedger>;
} {
  const session = makeFakeSession();
  const ledger = makeFakeLedger();
  const authed = Object.keys(providers) as ProviderId[];
  return {
    session,
    ledger,
    deps: {
      providers,
      clock: makeFakeClock(),
      session,
      ledger,
      policy: { ...DEFAULT_POLICY, panelPolicy: 'hard-turns', maxTier: 'manager' },
      cwd: '/fake',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: authed,
    },
  };
}

const PLAN: PanelPlan = {
  tier: 'ic',
  candidates: ['claude', 'codex'],
  synthesizer: 'claude',
  classification: HIGH,
};

// ---------------------------------------------------------------------------
// Integration: runPanel
// ---------------------------------------------------------------------------

describe('runPanel — happy path', () => {
  it('(a) emits tier-start per candidate and a success final = synthesizer text', async () => {
    // synthesizer is 'claude' (candidates[0]); give it a distinct text so we can
    // assert the final output is the synthesizer's, not a candidate's.
    let claudeCalls = 0;
    const claude = makeProvider('claude', 'CLAUDE-ANSWER', {
      onRun: () => {
        claudeCalls++;
      },
    });
    const codex = makeProvider('codex', 'CODEX-ANSWER');
    // claude runs as a candidate AND as synthesizer; make synthesizer text differ
    // by wrapping: easiest is to have claude always answer 'CLAUDE-ANSWER' — the
    // final output is whatever the synthesizer (claude) returned. We assert it is
    // the claude text (the synthesizer's output), distinct from codex's.
    const { deps, session } = panelDeps({ claude, codex });

    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));

    const candidateStarts = events.filter(
      (e) => e.type === 'tier-start' && (e.provider === 'claude' || e.provider === 'codex'),
    );
    // 2 candidate starts + 1 synthesizer start = 3 tier-starts total.
    assert.ok(candidateStarts.length >= 2, 'expected tier-start for each candidate');

    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.equal(final.output, 'CLAUDE-ANSWER');
    }
    // claude invoked at least twice (candidate + synthesizer).
    assert.ok(claudeCalls >= 2, `expected claude to run as candidate + synthesizer, got ${claudeCalls}`);

    // session has a user + assistant entry.
    assert.equal(session.entries[0]?.role, 'user');
    assert.ok(session.entries.some((e) => e.role === 'assistant' && e.content === 'CLAUDE-ANSWER'));
  });

  it('(b) every candidate provider is actually invoked', async () => {
    let claudeRan = false;
    let codexRan = false;
    const claude = makeProvider('claude', 'A', { onRun: () => (claudeRan = true) });
    const codex = makeProvider('codex', 'B', { onRun: () => (codexRan = true) });
    const { deps } = panelDeps({ claude, codex });
    await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    assert.ok(claudeRan, 'claude candidate must run');
    assert.ok(codexRan, 'codex candidate must run');
  });

  it('(d) ledger has entries for both candidates + the synthesizer', async () => {
    const { deps, ledger } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    // 2 candidates + 1 synthesizer = 3 ledger entries.
    assert.equal(ledger.entries.length, 3);
    assert.ok(ledger.entries.every((e) => e.usd > 0), 'each run records real cost');
  });

  it('notice names the panel composition', async () => {
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    const notice = events.find((e) => e.type === 'notice' && e.message.includes('Panel'));
    assert.ok(notice !== undefined, 'expected a Panel notice');
  });
});

describe('runPanel — synthesizer flagship admission', () => {
  // The LAST tier-start is the synthesizer's run (candidate starts come first,
  // before the concurrent await; the synthesizer starts after). Its `tier` is the
  // RESOLVED tier the synthesizer actually routes at.
  const synthStart = (events: CoreEvent[]) => {
    const starts = events.filter((e) => e.type === 'tier-start');
    return starts[starts.length - 1];
  };

  it('admits the synthesizer to manager on a CRITICAL-risk panel (adaptive policy)', async () => {
    // CRITICAL risk + adaptive admission (DEFAULT_POLICY/balanced) → the
    // synthesizer (the final decision-maker) earns the flagship tier.
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    const plan: PanelPlan = { ...PLAN, classification: CRIT };
    const events = await collect(runPanel('hard task', deps, plan, new AbortController().signal));
    const last = synthStart(events);
    assert.ok(last !== undefined && last.type === 'tier-start');
    if (last.type === 'tier-start') {
      assert.equal(last.provider, plan.synthesizer);
      assert.equal(last.tier, 'manager', 'synthesizer should be admitted to the flagship on a critical turn');
    }
    // The user-facing success final reports the synthesizer's resolved tier.
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') assert.equal(final.tier, 'manager');
  });

  it('admits the synthesizer to manager when admission is always-eligible (Max)', async () => {
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    deps.policy = { ...deps.policy, flagshipAdmission: 'always-eligible' };
    // Even a LOW-risk turn is admitted under always-eligible (Max).
    const plan: PanelPlan = { ...PLAN, classification: LOW };
    const events = await collect(runPanel('hard task', deps, plan, new AbortController().signal));
    const last = synthStart(events);
    assert.ok(last !== undefined && last.type === 'tier-start');
    if (last.type === 'tier-start') assert.equal(last.tier, 'manager');
  });

  it('keeps the synthesizer at plan.tier on a LOW-risk panel under adaptive (denied)', async () => {
    // 'always' panel, LOW risk, adaptive admission → not justified → denied → the
    // synthesizer stays at plan.tier ('ic'). Honest: we never open manager-first
    // off a soft classification.
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    deps.policy = { ...deps.policy, panelPolicy: 'always' };
    const plan: PanelPlan = { ...PLAN, tier: 'ic', classification: LOW };
    const events = await collect(runPanel('hard task', deps, plan, new AbortController().signal));
    const last = synthStart(events);
    assert.ok(last !== undefined && last.type === 'tier-start');
    if (last.type === 'tier-start') {
      assert.equal(last.provider, plan.synthesizer);
      assert.equal(last.tier, 'ic', 'low-risk adaptive turn must not auto-open the flagship for the synthesizer');
    }
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') assert.equal(final.tier, 'ic');
  });
});

describe('runPanel — all candidates fail', () => {
  it('(c) yields a failing final when no candidate succeeds', async () => {
    const { deps, ledger } = panelDeps({
      claude: makeProvider('claude', '', { error: true }),
      codex: makeProvider('codex', '', { error: true }),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, false);
    }
    // No synthesizer run when all candidates failed → only 2 candidate ledger entries.
    assert.equal(ledger.entries.length, 2);
    assert.ok(ledger.entries.every((e) => e.success === false));
  });
});

describe('runPanel — partial failure still synthesizes', () => {
  it('synthesizes from the surviving candidate when one fails', async () => {
    // claude (synthesizer + a candidate) succeeds; codex candidate fails.
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'GOOD'),
      codex: makeProvider('codex', '', { error: true }),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final.type === 'final') {
      assert.equal(final.success, true);
      assert.equal(final.output, 'GOOD');
    }
  });
});

describe('runPanel — abort', () => {
  it('yields cancelled notice + failing final when aborted before start', async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, ac.signal));
    const notice = events.find((e) => e.type === 'notice' && e.level === 'warn');
    assert.ok(notice !== undefined && /cancel/i.test(notice.message));
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success === false);
    if (final.type === 'final') {
      assert.equal(final.canceled, true);
    }
  });
});
