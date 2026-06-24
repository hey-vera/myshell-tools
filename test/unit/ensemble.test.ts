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
  buildPanelCritiqueSynthesisPrompt,
  classifyPanelAgreement,
  formatPanelDebateNotice,
  isLowSynthesisConfidence,
  type PanelPlan,
  type PanelDebateReceipt,
} from '../../src/core/ensemble.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { renderUntrustedBlock } from '../../src/core/untrusted-content.ts';
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
import type { IntentFrame } from '../../src/core/intent.ts';
import type {
  DetectedTestCommand,
  TestRunResult,
  VerifyPort,
} from '../../src/core/verify.ts';

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
${renderUntrustedBlock({
  source: 'model-output',
  label: 'panelist-1-claude',
  content: 'PANELIST 1 (claude)\nuse an LRU',
})}

${renderUntrustedBlock({
  source: 'model-output',
  label: 'panelist-2-codex',
  content: 'PANELIST 2 (codex)\nuse a TTL map',
})}

Now write the single final answer for the user.`;

  it('without a contract matches the boundary-aware prompt byte-for-byte', () => {
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

  it('in compact mode keeps a body <= 2000 chars whole', () => {
    const body = 'SMALL-BODY\n' + 'x'.repeat(1800) + '\nEND-SMALL';
    const prompt = buildPanelSynthesisPrompt(
      'design a cache',
      [
        {
          provider: 'claude',
          output: `${body}\n{"choice":"F1:0","confidence":0.9}`,
        },
      ],
      undefined,
      undefined,
      { compactCandidates: true },
    );

    assert.match(prompt, /CONCLUSION: {"choice":"F1:0","confidence":0.9}/);
    assert.match(prompt, /ANSWER EXCERPT:\nSMALL-BODY/);
    assert.match(prompt, /END-SMALL/);
    assert.doesNotMatch(prompt, /…\[candidate body compacted\]…/);
  });

  it('in compact mode emits stable records with head-tail excerpts and preserves candidate order', () => {
    const longA = makeLongCandidateOutput('alpha');
    const longB = makeLongCandidateOutput('beta');
    const prompt = buildPanelSynthesisPrompt(
      'design a cache',
      [
        { provider: 'claude', output: longA.output },
        { provider: 'codex', output: longB.output },
      ],
      undefined,
      undefined,
      { compactCandidates: true },
    );

    assert.ok(prompt.indexOf('--- PANELIST 1 (claude) ---') < prompt.indexOf('--- PANELIST 2 (codex) ---'));
    assert.match(prompt, /CONCLUSION: {"choice":"ALPHA","confidence":0.91,"assumptions":"alpha","what_would_make_this_wrong":"alpha-fail"}/);
    assert.match(prompt, /CONCLUSION: {"choice":"BETA","confidence":0.91,"assumptions":"beta","what_would_make_this_wrong":"beta-fail"}/);
    assert.match(prompt, /HEAD-alpha-/);
    assert.match(prompt, /HEAD-beta-/);
    assert.match(prompt, /TAIL-alpha/);
    assert.match(prompt, /TAIL-beta/);
    assert.match(prompt, /…\[candidate body compacted\]…/);
    assert.doesNotMatch(prompt, /MIDDLE-OMIT-alpha/);
    assert.doesNotMatch(prompt, /MIDDLE-OMIT-beta/);
  });
});

describe('S2 — panel agreement projection', () => {
  it('classifies same valid choice from two candidates as consensus', () => {
    assert.equal(
      classifyPanelAgreement(
        [
          { provider: 'claude', output: 'A\n{"choice":"F1:0","confidence":0.9}' },
          { provider: 'codex', output: 'B\n{"choice":"F1:0","confidence":0.8}' },
        ],
        ['F1:0', 'F1:1'],
      ),
      'consensus',
    );
  });

  it('classifies different valid choices as material disagreement', () => {
    assert.equal(
      classifyPanelAgreement(
        [
          { provider: 'claude', output: 'A\n{"choice":"F1:0","confidence":0.9}' },
          { provider: 'codex', output: 'B\n{"choice":"F1:1","confidence":0.8}' },
        ],
        ['F1:0', 'F1:1'],
      ),
      'material-disagreement',
    );
  });

  it('classifies malformed or partial verdicts as unknown', () => {
    assert.equal(
      classifyPanelAgreement(
        [
          { provider: 'claude', output: 'A\n{"choice":"F1:0","confidence":0.9}' },
          { provider: 'codex', output: 'B\n{"choice":"nope","confidence":0.8}' },
        ],
        ['F1:0', 'F1:1'],
      ),
      'unknown',
    );
  });

  it('OPEN and no counting vocabulary never manufacture disagreement', () => {
    assert.equal(
      classifyPanelAgreement(
        [
          { provider: 'claude', output: 'A\n{"choice":"OPEN","confidence":0.9}' },
          { provider: 'codex', output: 'B\n{"choice":"OPEN","confidence":0.8}' },
        ],
        ['OPEN'],
        [],
      ),
      'unknown',
    );
  });
});

describe('S3/S4 — pure helpers', () => {
  it('builds a critique+synthesis prompt with both conclusions and the assess envelope instruction', () => {
    const prompt = buildPanelCritiqueSynthesisPrompt(
      'ship the feature',
      [
        { provider: 'claude', output: 'Answer A\n{"choice":"F1:0","confidence":0.7}' },
        { provider: 'codex', output: 'Answer B\n{"choice":"F1:1","confidence":0.6}' },
      ],
      { version: 1, objective: 'ship the feature safely' },
      { memoryContext: 'USER PREFERENCES AND MEMORY:\n- concise' },
    );
    assert.match(prompt, /CANDIDATE 1 \(claude\)/);
    assert.match(prompt, /CANDIDATE 2 \(codex\)/);
    assert.match(prompt, /"choice":"F1:0"/);
    assert.match(prompt, /"choice":"F1:1"/);
    assert.match(prompt, /critique each candidate's conclusion/i);
    assert.match(prompt, /"needs_review": false/);
    assert.match(prompt, /CONTRACT TO ADJUDICATE AGAINST/);
    assert.match(prompt, /USER PREFERENCES AND MEMORY/);
  });

  it('formats the additive debate receipts honestly', () => {
    const ran: PanelDebateReceipt = {
      status: 'ran',
      reason: 'material-disagreement',
      participants: ['claude', 'codex'],
      calls: 1,
    };
    const low: PanelDebateReceipt = {
      status: 'not-run',
      reason: 'low-synthesis-confidence-budget-exhausted',
      participants: ['claude', 'codex'],
      calls: 0,
    };
    assert.equal(formatPanelDebateNotice(ran), 'Panel debate: ran (material disagreement)');
    assert.equal(
      formatPanelDebateNotice(low),
      'Panel debate: trigger observed (low synthesis confidence), not run (budget exhausted)',
    );
  });

  it('reuses the policy confidence gate for low synthesis confidence', () => {
    assert.equal(
      isLowSynthesisConfidence(
        { confidence: 0.2, escalate: false, reason: 'unsure', needsReview: false },
        DEFAULT_POLICY,
        HIGH,
      ),
      true,
    );
    assert.equal(
      isLowSynthesisConfidence(
        { confidence: 0.95, escalate: false, reason: 'done', needsReview: false },
        DEFAULT_POLICY,
        HIGH,
      ),
      false,
    );
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

  it('E1 — the ENVIRONMENT block reaches a panel CANDIDATE prompt, FIRST and before the task', () => {
    const ENV = 'ENVIRONMENT\n  cwd:    /work\n  repo:   acme-web  (branch main)';
    const cand = buildPanelCandidatePrompt('ic', 'make the socials page real', undefined, {
      environmentContext: ENV,
      memoryContext: MEM,
    });
    assert.match(cand, /ENVIRONMENT/);
    assert.match(cand, /repo:\s+acme-web/);
    // Orientation precedes memory and sits before the task.
    assert.ok(cand.indexOf(ENV) < cand.indexOf(MEM));
    assert.ok(cand.indexOf(ENV) < cand.indexOf('Task:'));
    // And it reaches the synthesizer too.
    const synth = buildPanelSynthesisPrompt(
      'make the socials page real',
      [{ provider: 'claude', output: 'a' }],
      undefined,
      { environmentContext: ENV },
    );
    assert.match(synth, /repo:\s+acme-web/);
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

const DECIDE_FRAME: IntentFrame = {
  version: 1,
  goal: 'pick an implementation path',
  confidence: 'high',
  source: 'model',
  forks: [
    { id: 'F1', question: 'Which path?', options: ['A', 'B'] },
  ],
};

function governedCapability(
  shape: 'decide' | 'risky' | 'investigate' = 'decide',
): NonNullable<Parameters<typeof runPanel>[5]> {
  return {
    turnCallBudget: 3,
    governorPlan: { panelAllowed: true, shape, turnCallBudget: 3 },
    ...(shape === 'decide' ? { intentFrame: DECIDE_FRAME } : {}),
  };
}

function makeLongCandidateOutput(label: string): {
  output: string;
  body: string;
  conclusion: string;
} {
  const headPrefix = `HEAD-${label}-`;
  const head = headPrefix + 'H'.repeat(1600 - headPrefix.length);
  const middle = `MIDDLE-OMIT-${label}-` + 'M'.repeat(5000);
  const tail = 'T'.repeat(350) + `TAIL-${label}`;
  const body = `${head}${middle}${tail}`;
  const conclusion =
    `{"choice":"${label.toUpperCase()}","confidence":0.91,"assumptions":"${label}","what_would_make_this_wrong":"${label}-fail"}`;
  return {
    output: `${body}\n${conclusion}`,
    body,
    conclusion,
  };
}

// ---------------------------------------------------------------------------
// Integration: runPanel
// ---------------------------------------------------------------------------

describe('runPanel — happy path', () => {
  it('governor budget below 3 denies the panel before any call or session append', async () => {
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['unused'], rec);
    const codex = makeProvider('codex', 'unused');
    const { deps, session } = panelDeps({ claude, codex });

    const events = await collect(
      runPanel('hard task', deps, PLAN, new AbortController().signal, undefined, {
        turnCallBudget: 2,
      }),
    );

    assert.deepEqual(events, []);
    assert.equal(rec.calls, 0);
    assert.deepEqual(session.entries, []);
  });

  it('governor budget reduces candidates to leave exactly one synthesis call', async () => {
    const claudeRec = { calls: 0, prompts: [] as string[] };
    const codexRec = { calls: 0, prompts: [] as string[] };
    const opencodeRec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['A', 'SYNTH'], claudeRec);
    const codex = makeSeqProvider('codex', ['B'], codexRec);
    const opencode = makeSeqProvider('opencode', ['C'], opencodeRec);
    const { deps } = panelDeps({ claude, codex, opencode });
    const widePlan: PanelPlan = { ...PLAN, candidates: ['claude', 'codex', 'opencode'] };

    const events = await collect(
      runPanel('hard task', deps, widePlan, new AbortController().signal, undefined, {
        turnCallBudget: 3,
      }),
    );

    const panelPhase = events.find((e) => e.type === 'phase' && e.phase === 'panel');
    assert.ok(panelPhase !== undefined && panelPhase.type === 'phase');
    assert.deepEqual(panelPhase.participants, ['claude', 'codex']);
    assert.equal(claudeRec.calls + codexRec.calls + opencodeRec.calls, 3);
    assert.equal(opencodeRec.calls, 0, 'candidate reduction is restrictive only');
  });

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

  it('emits a typed phase:panel event (with participants) then phase:synthesis (with success count)', async () => {
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));

    // The panel phase event names the concurrent candidates, in run order, and is
    // emitted BEFORE the up-front candidate tier-starts (the renderer enters panel
    // mode off this real signal, not the notice string).
    const panelIdx = events.findIndex((e) => e.type === 'phase' && e.phase === 'panel');
    const firstStartIdx = events.findIndex((e) => e.type === 'tier-start');
    assert.ok(panelIdx >= 0, 'expected a phase:panel event');
    assert.ok(panelIdx < firstStartIdx, 'phase:panel must precede the candidate tier-starts');
    const panelEv = events[panelIdx];
    assert.ok(panelEv !== undefined && panelEv.type === 'phase');
    if (panelEv.type === 'phase') {
      assert.deepEqual(panelEv.participants, PLAN.candidates);
    }

    // The synthesis phase event carries the count of SUCCESSFUL candidate answers
    // (both succeed here) and is emitted after the candidate tier-dones, before
    // the synthesizer tier-start.
    const synthIdx = events.findIndex((e) => e.type === 'phase' && e.phase === 'synthesis');
    assert.ok(synthIdx >= 0, 'expected a phase:synthesis event');
    assert.ok(synthIdx > panelIdx, 'synthesis phase comes after panel phase');
    const synthEv = events[synthIdx];
    assert.ok(synthEv !== undefined && synthEv.type === 'phase');
    if (synthEv.type === 'phase') {
      assert.equal(synthEv.count, 2);
    }
  });

  it('phase:synthesis is NOT emitted when every candidate fails (nothing to synthesize)', async () => {
    const claude = makeProvider('claude', 'A', { error: true });
    const codex = makeProvider('codex', 'B', { error: true });
    const { deps } = panelDeps({ claude, codex });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    // The panel phase still fires (candidates were announced)…
    assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'panel'));
    // …but synthesis never runs, so no synthesis phase event.
    assert.ok(!events.some((e) => e.type === 'phase' && e.phase === 'synthesis'));
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

  it('notice names the panel composition AND discloses the quota cost (honesty guardrail)', async () => {
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    const notice = events.find((e) => e.type === 'notice' && e.message.includes('Panel'));
    assert.ok(notice !== undefined, 'expected a Panel notice');
    // Because the panel can now AUTO-engage (mode preset), the up-front notice MUST
    // disclose that it spends quota — never silently, never billed as "free".
    assert.ok(
      notice.type === 'notice' && /quota-consuming runs/.test(notice.message),
      'panel notice must disclose the quota cost up front',
    );
    assert.ok(
      notice.type === 'notice' && !/\bfree\b/i.test(notice.message),
      'panel notice must NOT claim the runs are free',
    );
  });

  it('governor-off panels keep full candidate bodies even above the 12000-char threshold', async () => {
    const claudeLong = makeLongCandidateOutput('alpha');
    const codexLong = makeLongCandidateOutput('beta');
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', [
      claudeLong.output,
      'Synth\n{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false}',
    ], rec);
    const codex = makeSeqProvider('codex', [codexLong.output]);
    const { deps } = panelDeps({ claude, codex });

    await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));

    assert.equal(
      rec.prompts[1],
      buildPanelSynthesisPrompt('hard task', [
        { provider: 'claude', output: claudeLong.output },
        { provider: 'codex', output: codexLong.output },
      ], { version: 1, objective: 'hard task' }),
    );
    assert.match(rec.prompts[1] ?? '', /MIDDLE-OMIT-alpha/);
    assert.match(rec.prompts[1] ?? '', /MIDDLE-OMIT-beta/);
    assert.doesNotMatch(rec.prompts[1] ?? '', /ANSWER EXCERPT:/);
  });

  it('governed large panels compact candidate summaries only in the synthesis prompt', async () => {
    const claudeLong = makeLongCandidateOutput('alpha');
    const codexLong = makeLongCandidateOutput('beta');
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', [
      claudeLong.output,
      'Synth\n{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false}',
    ], rec);
    const codex = makeSeqProvider('codex', [codexLong.output]);
    const { deps } = panelDeps({ claude, codex });

    await collect(
      runPanel('hard task', deps, PLAN, new AbortController().signal, undefined, governedCapability('risky')),
    );

    assert.equal(
      rec.prompts[1],
      buildPanelSynthesisPrompt('hard task', [
        { provider: 'claude', output: claudeLong.output },
        { provider: 'codex', output: codexLong.output },
      ], { version: 1, objective: 'hard task' }, undefined, { compactCandidates: true }),
    );
    assert.match(rec.prompts[1] ?? '', /--- PANELIST 1 \(claude\) ---/);
    assert.match(rec.prompts[1] ?? '', /--- PANELIST 2 \(codex\) ---/);
    assert.match(rec.prompts[1] ?? '', /CONCLUSION: {"choice":"ALPHA","confidence":0.91,"assumptions":"alpha","what_would_make_this_wrong":"alpha-fail"}/);
    assert.match(rec.prompts[1] ?? '', /CONCLUSION: {"choice":"BETA","confidence":0.91,"assumptions":"beta","what_would_make_this_wrong":"beta-fail"}/);
    assert.match(rec.prompts[1] ?? '', /HEAD-alpha-/);
    assert.match(rec.prompts[1] ?? '', /HEAD-beta-/);
    assert.match(rec.prompts[1] ?? '', /TAIL-alpha/);
    assert.match(rec.prompts[1] ?? '', /TAIL-beta/);
    assert.match(rec.prompts[1] ?? '', /…\[candidate body compacted\]…/);
    assert.doesNotMatch(rec.prompts[1] ?? '', /MIDDLE-OMIT-alpha/);
    assert.doesNotMatch(rec.prompts[1] ?? '', /MIDDLE-OMIT-beta/);
  });
});

describe('runPanel — live candidate progress (no silent hang)', () => {
  // A provider that emits a NON-prose liveness event (reasoning) and a prose text
  // delta before completing. `gate`, when supplied, withholds the terminal `done`
  // until the returned resolve() is called — letting a test order completions.
  function makeLivenessProvider(
    id: ProviderId,
    text: string,
    gate?: { wait: Promise<void> },
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
        // Liveness BEFORE the answer — this is what now reaches the renderer as
        // "still working" feedback during the candidate phase.
        yield { type: 'reasoning', delta: `${id}-thinking` };
        yield { type: 'text', delta: text };
        if (gate !== undefined) await gate.wait;
        yield { type: 'done', text, usage: USAGE, raw: {} };
      },
    };
  }

  it('streams candidate liveness (reasoning) provider-events DURING the candidate phase, before synthesis', async () => {
    const { deps } = panelDeps({
      claude: makeLivenessProvider('claude', 'A'),
      codex: makeLivenessProvider('codex', 'B'),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));

    const synthIdx = events.findIndex((e) => e.type === 'phase' && e.phase === 'synthesis');
    assert.ok(synthIdx >= 0, 'expected a synthesis phase');

    // The candidate-phase liveness: a provider-event carrying a non-text reasoning
    // delta, emitted at the candidate tier BEFORE synthesis began. This is the new
    // behaviour — previously candidates ran inside Promise.all and yielded NOTHING.
    const candidateLiveness = events.filter(
      (e, i) =>
        i < synthIdx &&
        e.type === 'provider-event' &&
        e.tier === PLAN.tier &&
        e.event.type === 'reasoning',
    );
    assert.ok(
      candidateLiveness.length >= 2,
      `expected each candidate to stream a reasoning liveness event during the panel phase, got ${candidateLiveness.length}`,
    );

    // Candidate PROSE is NOT streamed — no candidate-tier text provider-event ever
    // reaches the user (the synthesizer owns the single clean stream).
    const candidateProse = events.filter(
      (e, i) =>
        i < synthIdx &&
        e.type === 'provider-event' &&
        e.tier === PLAN.tier &&
        e.event.type === 'text',
    );
    assert.equal(candidateProse.length, 0, 'candidate prose must never be streamed to the user');
  });

  it('emits a fast candidate tier-done BEFORE a slow candidate finishes (no Promise.all stall)', async () => {
    // codex is gated open immediately; claude is held until we release it. With the
    // old Promise.all aggregation, NEITHER tier-done could be emitted until BOTH
    // resolved. With the concurrent merge, codex's tier-done fires while claude is
    // still running.
    let releaseClaude!: () => void;
    const claudeWait = new Promise<void>((r) => {
      releaseClaude = r;
    });
    const codexWait = Promise.resolve();

    const claude = makeLivenessProvider('claude', 'CLAUDE', { wait: claudeWait });
    const codex = makeLivenessProvider('codex', 'CODEX', { wait: codexWait });
    const { deps } = panelDeps({ claude, codex });

    const out: CoreEvent[] = [];
    const gen = runPanel('hard task', deps, PLAN, new AbortController().signal);
    // Drain until codex's candidate tier-done arrives — claude is still blocked, so
    // if the merge stalled on Promise.all this loop would hang forever (the test
    // timeout would catch it). The first tier-done we see is codex's (fastest).
    let sawCandidateDone = false;
    while (!sawCandidateDone) {
      const { value, done } = await gen.next();
      if (done) break;
      out.push(value);
      if (value.type === 'tier-done') sawCandidateDone = true;
    }
    assert.ok(sawCandidateDone, 'a candidate tier-done must arrive before the slow candidate resolves');
    // claude has NOT been released yet, so synthesis cannot have started.
    assert.ok(
      !out.some((e) => e.type === 'phase' && e.phase === 'synthesis'),
      'synthesis must not begin while a candidate is still running',
    );

    // Now release claude and finish the turn cleanly — totals/final stay intact.
    releaseClaude();
    for await (const ev of gen) out.push(ev);
    const final = out.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final' && final.success);
    // Both candidate tier-dones + the synthesizer's = 3 tier-dones, accounting intact.
    assert.equal(out.filter((e) => e.type === 'tier-done').length, 3);
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

// ---------------------------------------------------------------------------
// Capability parity: the panel must carry the SAME per-turn capability data the
// sequential path carries — image attachments + native web-search — onto EVERY
// provider request (each candidate AND the synthesizer). Regression guard for
// the audit finding that the ensemble path silently dropped them.
// ---------------------------------------------------------------------------

/**
 * A provider that records each ProviderRequest it receives (so a test can assert
 * which fields reached it), then answers like a normal fake provider.
 */
function makeCapturingProvider(
  id: ProviderId,
  text: string,
  reqs: ProviderRequest[],
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
    async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
      reqs.push(req);
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

describe('runPanel — capability parity (attachments + webSearch)', () => {
  it('threads image attachments + webSearch onto every candidate AND synthesizer request', async () => {
    const claudeReqs: ProviderRequest[] = [];
    const codexReqs: ProviderRequest[] = [];
    const { deps } = panelDeps({
      claude: makeCapturingProvider('claude', 'A', claudeReqs),
      codex: makeCapturingProvider('codex', 'B', codexReqs),
    });
    const attachments = [{ path: '/tmp/shot.png', kind: 'image' as const }];

    await collect(
      runPanel('hard task', deps, PLAN, new AbortController().signal, undefined, {
        attachments,
        webSearch: true,
      }),
    );

    // claude ran as a candidate AND as the synthesizer → both its requests carry
    // the attachments + webSearch; codex ran as a candidate → its one request too.
    const all = [...claudeReqs, ...codexReqs];
    assert.ok(all.length >= 3, `expected ≥3 provider requests (2 candidates + synth), got ${all.length}`);
    for (const req of all) {
      assert.deepEqual(req.attachments, attachments, 'every panel request must carry the image attachments');
      assert.equal(req.webSearch, true, 'every panel request must carry the web-search flag');
    }
  });

  it('omits attachments when no image attachment is present (byte-for-byte unchanged)', async () => {
    const claudeReqs: ProviderRequest[] = [];
    const codexReqs: ProviderRequest[] = [];
    const { deps } = panelDeps({
      claude: makeCapturingProvider('claude', 'A', claudeReqs),
      codex: makeCapturingProvider('codex', 'B', codexReqs),
    });

    // No capability bag → no attachments, no webSearch on any request.
    await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));

    for (const req of [...claudeReqs, ...codexReqs]) {
      assert.equal(req.attachments, undefined, 'no image attachment → attachments omitted');
      assert.equal(req.webSearch, undefined, 'no web-search need → webSearch omitted');
    }
  });
});

// ---------------------------------------------------------------------------
// P0.1b — panel synthesis routes through the SHARED Candidate Quality Gate.
//
// Only a typed RED test (or a parsed critic revise) changes behaviour: ONE
// same-author repair on plan.synthesizer at synthDecision.tier, then accept the
// repaired green output or block with final.success:false + no assistant append.
// The non-verify transcripts above remain unchanged (no verifyPort there).
// ---------------------------------------------------------------------------

/** A provider that emits a DIFFERENT text on each successive run (for repair). */
function makeSeqProvider(
  id: ProviderId,
  texts: string[],
  rec?: { calls: number; prompts: string[] },
): Provider {
  let calls = 0;
  return {
    id,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const text = texts[Math.min(calls, texts.length - 1)] ?? '';
      if (rec !== undefined) { rec.calls++; rec.prompts.push(req.prompt); }
      calls++;
      yield { type: 'text', delta: text };
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
}

function makeVerifyPort(
  runs: TestRunResult[],
  detected: DetectedTestCommand | null = { label: 'npm test', command: 'npm', args: ['test'] },
): VerifyPort & { calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    async captureDiff() {
      return { files: ['src/a.ts'], patch: '+ fixed' };
    },
    async detectTestCommand() {
      return detected;
    },
    async runTests() {
      const result = runs[Math.min(calls, runs.length - 1)];
      calls++;
      return result ?? { outcome: 'errored', output: '', durationMs: 0 };
    },
  };
}

const redRun = (output = 'FAIL a.test.ts'): TestRunResult => ({ outcome: 'red', output, durationMs: 5 });
const greenRun = (): TestRunResult => ({ outcome: 'green', output: 'ok', durationMs: 4 });

function panelAssistantEntries(all: readonly SessionEntry[]): SessionEntry[] {
  return all.filter((e) => e.role === 'assistant');
}

describe('runPanel — Candidate Quality Gate', () => {
  it('synthesis red → one synthesizer repair → green success', async () => {
    // claude is candidate[0] + synthesizer + repair author. Calls:
    //   1 candidate, 2 synthesis, 3 repair.
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['cand-A', 'SYNTH-RED', 'SYNTH-GREEN'], rec);
    const codex = makeSeqProvider('codex', ['cand-B']);
    const { deps, session, ledger } = panelDeps({ claude, codex });
    const port = makeVerifyPort([redRun(), greenRun()]);
    const events = await collect(
      runPanel('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final' && final.success === true);
    assert.equal(final.output, 'SYNTH-GREEN');
    assert.equal(port.calls, 2, 'verify ran twice (synth red, repair green)');
    assert.equal(rec.calls, 3, 'claude ran candidate + synthesis + repair');
    assert.match(rec.prompts[2] ?? '', /Acceptance verification failed/);
    assert.match(rec.prompts[2] ?? '', /FAIL a\.test\.ts/);
    assert.equal(panelAssistantEntries(session.entries)[0]?.content, 'SYNTH-GREEN');
    // ledger: 2 candidates + synth + repair = 4 entries; repair is a real review run.
    assert.equal(ledger.entries.length, 4);
    assert.equal(ledger.entries.at(-1)?.taskKind, 'review');
    assert.equal(ledger.entries.at(-1)?.provider, 'claude');
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });

  it('synthesis red → red blocks (final.success:false, no assistant append)', async () => {
    const claude = makeSeqProvider('claude', ['cand-A', 'SYNTH-RED', 'STILL-RED']);
    const codex = makeSeqProvider('codex', ['cand-B']);
    const { deps, session } = panelDeps({ claude, codex });
    const port = makeVerifyPort([redRun(), redRun('FAIL again')]);
    const events = await collect(
      runPanel('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, false);
    assert.equal(final.memoryProposal, undefined);
    assert.equal(panelAssistantEntries(session.entries).length, 0, 'no assistant append on a blocked red');
    assert.equal(events.filter((e) => e.type === 'final').length, 1, 'exactly one final');
  });

  it('passing tests accept with no repair (one final, one append)', async () => {
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider('claude', ['cand-A', 'SYNTH-OK'], rec);
    const codex = makeSeqProvider('codex', ['cand-B']);
    const { deps, session } = panelDeps({ claude, codex });
    const port = makeVerifyPort([greenRun()]);
    const events = await collect(
      runPanel('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final' && final.success === true);
    assert.equal(final.output, 'SYNTH-OK');
    assert.equal(rec.calls, 2, 'no repair run on green');
    assert.equal(port.calls, 1);
    assert.equal(panelAssistantEntries(session.entries).length, 1);
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });

  it('repair-error blocks with exactly one final and no append', async () => {
    // synthesis red, then the repair run errors → original red remains → block.
    let claudeCalls = 0;
    const claude: Provider = {
      id: 'claude',
      async detect() {
        return { id: 'claude', installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
      },
      async *run(): AsyncIterable<ProviderEvent> {
        // call 0 = candidate, call 1 = synthesis, call 2 = repair (errors).
        if ((claudeCalls++) === 2) {
          yield { type: 'error', error: { category: 'network', recoverable: true, message: 'boom', suggestion: 'retry' } };
          return;
        }
        yield { type: 'text', delta: 'X' };
        yield { type: 'done', text: 'SYNTH-RED', usage: USAGE, raw: {} };
      },
    };
    const codex = makeSeqProvider('codex', ['cand-B']);
    const { deps, session } = panelDeps({ claude, codex });
    const port = makeVerifyPort([redRun()]);
    const events = await collect(
      runPanel('hard task', { ...deps, verifyPort: port, verifyLevel: 'tests' }, PLAN, new AbortController().signal),
    );
    const final = events.at(-1);
    assert.ok(final !== undefined && final.type === 'final');
    assert.equal(final.success, false);
    assert.equal(panelAssistantEntries(session.entries).length, 0);
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });
});

describe('S2/S3/S4 — governed panel debate', () => {
  it('consensus uses the byte-identical ordinary synthesis prompt and exactly three calls', async () => {
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider(
      'claude',
      ['Candidate A\n{"choice":"F1:0","confidence":0.9}', 'Synth\n{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false}'],
      rec,
    );
    const codexRec = { calls: 0, prompts: [] as string[] };
    const codex = makeSeqProvider(
      'codex',
      ['Candidate B\n{"choice":"F1:0","confidence":0.8}'],
      codexRec,
    );
    const { deps, ledger } = panelDeps({ claude, codex });

    const events = await collect(
      runPanel('hard task', deps, PLAN, new AbortController().signal, undefined, governedCapability()),
    );

    assert.equal(rec.calls + codexRec.calls, 3);
    assert.equal(ledger.entries.length, 3);
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final?.type === 'final') assert.equal(final.attempts, 3);
    assert.equal(
      rec.prompts[1],
      buildPanelSynthesisPrompt('hard task', [
        { provider: 'claude', output: 'Candidate A\n{"choice":"F1:0","confidence":0.9}' },
        { provider: 'codex', output: 'Candidate B\n{"choice":"F1:0","confidence":0.8}' },
      ], { version: 1, objective: 'hard task' }),
    );
    assert.ok(events.some((e) => e.type === 'notice' && e.message === 'Panel debate: not run (consensus)'));
    assert.ok(!events.some((e) => e.type === 'notice' && /ran \(material disagreement\)/.test(e.message)));
  });

  it('unknown consumes exactly three calls and still uses the ordinary synthesis prompt', async () => {
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider(
      'claude',
      ['Candidate A\n{"choice":"OPEN","confidence":0.9}', 'Synth\n{"confidence":0.9,"escalate":false,"reason":"done","needs_review":false}'],
      rec,
    );
    const codexRec = { calls: 0, prompts: [] as string[] };
    const codex = makeSeqProvider('codex', ['Candidate B\n{"choice":"OPEN","confidence":0.8}'], codexRec);
    const { deps } = panelDeps({ claude, codex });

    const events = await collect(
      runPanel('hard task', deps, PLAN, new AbortController().signal, undefined, governedCapability('risky')),
    );

    assert.equal(rec.calls + codexRec.calls, 3);
    assert.ok(events.some((e) => e.type === 'notice' && e.message === 'Panel debate: not run (no parseable decision split)'));
    assert.equal(
      rec.prompts[1],
      buildPanelSynthesisPrompt('hard task', [
        { provider: 'claude', output: 'Candidate A\n{"choice":"OPEN","confidence":0.9}' },
        { provider: 'codex', output: 'Candidate B\n{"choice":"OPEN","confidence":0.8}' },
      ], { version: 1, objective: 'hard task' }),
    );
  });

  it('material disagreement uses exactly one combined critique+synthesis call with context/contract/request parity', async () => {
    const claudeReqs: ProviderRequest[] = [];
    const codexReqs: ProviderRequest[] = [];
    let claudeCall = 0;
    const { deps, ledger } = panelDeps({
      claude: {
        id: 'claude',
        async detect() {
          return {
            id: 'claude',
            installed: true,
            version: '1',
            authenticated: true,
            binaryPath: '/f',
            availableModels: [],
          };
        },
        async *run(req: ProviderRequest, _signal: AbortSignal): AsyncIterable<ProviderEvent> {
          claudeReqs.push(req);
          const text = claudeCall++ === 0
            ? 'Candidate A\n{"choice":"F1:0","confidence":0.9}'
            : 'Final synthesis\n{"confidence":0.92,"escalate":false,"reason":"done","needs_review":false}';
          yield { type: 'done', text, usage: USAGE, raw: {} };
        },
      },
      codex: makeCapturingProvider('codex', 'Candidate B\n{"choice":"F1:1","confidence":0.8}', codexReqs),
    });
    const governedDeps: OrchestrateDeps = {
      ...deps,
      memoryContext: 'USER PREFERENCES AND MEMORY:\n- concise',
      workContract: { version: 1, objective: 'keep the fix local' },
    };

    const events = await collect(
      runPanel('hard task', governedDeps, PLAN, new AbortController().signal, undefined, {
        ...governedCapability(),
        attachments: [{ path: '/tmp/a.png', kind: 'image' }],
        webSearch: true,
      }),
    );

    assert.equal(claudeReqs.length + codexReqs.length, 3);
    assert.equal(ledger.entries.length, 3);
    const synthPrompt = claudeReqs[1]?.prompt ?? '';
    assert.match(synthPrompt, /CANDIDATE 1 \(claude\)/);
    assert.match(synthPrompt, /CANDIDATE 2 \(codex\)/);
    assert.match(synthPrompt, /"choice":"F1:0"/);
    assert.match(synthPrompt, /"choice":"F1:1"/);
    assert.match(synthPrompt, /critique each candidate's conclusion/i);
    assert.match(synthPrompt, /CONTRACT TO ADJUDICATE AGAINST/);
    assert.match(synthPrompt, /USER PREFERENCES AND MEMORY/);
    assert.equal(claudeReqs[1]?.webSearch, true);
    assert.deepEqual(claudeReqs[1]?.attachments, [{ path: '/tmp/a.png', kind: 'image' }]);
    const final = events.find((e) => e.type === 'final');
    assert.ok(final !== undefined && final.type === 'final');
    if (final?.type === 'final') assert.equal(final.attempts, 3);
    assert.ok(events.some((e) => e.type === 'notice' && e.message === 'Panel debate: ran (material disagreement)'));
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
  });

  it('governor-off panels never emit the debate receipt', async () => {
    const { deps } = panelDeps({
      claude: makeProvider('claude', 'A'),
      codex: makeProvider('codex', 'B'),
    });
    const events = await collect(runPanel('hard task', deps, PLAN, new AbortController().signal));
    assert.ok(!events.some((e) => e.type === 'notice' && e.message.startsWith('Panel debate:')));
  });

  it('debate output reaches the gate: green accepts once, red blocks when no repair budget remains', async () => {
    const greenClaude = makeSeqProvider(
      'claude',
      [
        'Candidate A\n{"choice":"F1:0","confidence":0.9}',
        'Debated\n{"confidence":0.91,"escalate":false,"reason":"done","needs_review":false}',
      ],
    );
    const greenCodex = makeSeqProvider('codex', ['Candidate B\n{"choice":"F1:1","confidence":0.8}']);
    const greenPort = makeVerifyPort([greenRun()]);
    const green = panelDeps({ claude: greenClaude, codex: greenCodex });
    const greenEvents = await collect(
      runPanel(
        'hard task',
        { ...green.deps, verifyPort: greenPort, verifyLevel: 'tests' },
        PLAN,
        new AbortController().signal,
        undefined,
        governedCapability(),
      ),
    );
    const greenFinal = greenEvents.at(-1);
    assert.ok(greenFinal !== undefined && greenFinal.type === 'final' && greenFinal.success === true);
    assert.equal(panelAssistantEntries(green.session.entries).length, 1);
    assert.equal(greenEvents.filter((e) => e.type === 'final').length, 1);

    const redClaudeRec = { calls: 0, prompts: [] as string[] };
    const redClaude = makeSeqProvider(
      'claude',
      [
        'Candidate A\n{"choice":"F1:0","confidence":0.9}',
        'Debated\n{"confidence":0.91,"escalate":false,"reason":"done","needs_review":false}',
      ],
      redClaudeRec,
    );
    const redCodex = makeSeqProvider('codex', ['Candidate B\n{"choice":"F1:1","confidence":0.8}']);
    const redPort = makeVerifyPort([redRun()]);
    const red = panelDeps({ claude: redClaude, codex: redCodex });
    const redEvents = await collect(
      runPanel(
        'hard task',
        { ...red.deps, verifyPort: redPort, verifyLevel: 'tests' },
        PLAN,
        new AbortController().signal,
        undefined,
        governedCapability(),
      ),
    );
    const redFinal = redEvents.at(-1);
    assert.ok(redFinal !== undefined && redFinal.type === 'final' && redFinal.success === false);
    assert.equal(panelAssistantEntries(red.session.entries).length, 0);
    assert.equal(redClaudeRec.calls, 2, 'no repair call remains after the 3-call cap is spent');
    assert.equal(redEvents.filter((e) => e.type === 'final').length, 1);
  });

  it('low synthesis confidence records trigger-observed/budget-exhausted with no fourth call', async () => {
    const rec = { calls: 0, prompts: [] as string[] };
    const claude = makeSeqProvider(
      'claude',
      [
        'Candidate A\n{"choice":"F1:0","confidence":0.9}',
        'Ordinary synth\n{"confidence":0.2,"escalate":false,"reason":"unsure","needs_review":false}',
      ],
      rec,
    );
    const codexRec = { calls: 0, prompts: [] as string[] };
    const codex = makeSeqProvider('codex', ['Candidate B\n{"choice":"F1:0","confidence":0.8}'], codexRec);
    const { deps, ledger } = panelDeps({ claude, codex });

    const events = await collect(
      runPanel('hard task', deps, PLAN, new AbortController().signal, undefined, governedCapability()),
    );

    assert.equal(rec.calls + codexRec.calls, 3);
    assert.equal(ledger.entries.length, 3);
    assert.ok(events.some((e) => e.type === 'notice' && e.message === 'Panel debate: trigger observed (low synthesis confidence), not run (budget exhausted)'));
    assert.equal(events.filter((e) => e.type === 'final').length, 1);
    assert.ok(!rec.prompts.some((p) => /critique each candidate's conclusion/i.test(p)));
  });
});
