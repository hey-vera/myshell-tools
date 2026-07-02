import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { compileTurnDirective, validateTurnOutput, type TurnDirective } from '../../src/core/turn-directive.ts';
import { planEngagement, type EngagementSignals } from '../../src/core/engagement.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { EvidenceReceiptV1 } from '../../src/core/evidence-investigation.ts';
import type { ResearchPort } from '../../src/core/research.ts';
import type { SemanticPreflightV1 } from '../../src/core/semantic-preflight.ts';
import type { Provider, ProviderEvent, ProviderRequest, Usage } from '../../src/providers/port.ts';

const ENVELOPE = '{"confidence": 0.9, "escalate": false, "reason": "done", "needs_review": false}';
const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

function clock(): Clock {
  let n = 0;
  return {
    now: () => 1_000_000,
    isoNow: () => new Date(1_000_000).toISOString(),
    uuid: () => `uuid-${++n}`,
    random: () => 0.5,
  };
}

function session(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return { id: 'sess-1', async append(e) { entries.push(e); }, entries };
}

function ledger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { async record(e) { entries.push(e); }, entries };
}

function provider(texts: readonly string[]): Provider & { calls: number; prompts: string[] } {
  const state = {
    id: 'claude' as const,
    calls: 0,
    prompts: [] as string[],
    async detect() {
      return { id: 'claude' as const, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const text = texts[Math.min(state.calls, texts.length - 1)] ?? `Done.\n${ENVELOPE}`;
      state.calls++;
      state.prompts.push(req.prompt);
      yield { type: 'done', text, usage: USAGE, raw: {} };
    },
  };
  return state;
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function semantic(over: Partial<SemanticPreflightV1> = {}): SemanticPreflightV1 {
  return {
    version: 1,
    objective: 'inspect auth behavior',
    taskShape: { kind: 'analysis', scope: 'single-step', mutatesWorkspace: false },
    route: { tier: 'worker', plan: false, rationale: 'semantic route' },
    risk: { level: 'low', reasons: [] },
    uncertainty: { level: 'medium', reasons: ['needs evidence'], forks: [] },
    evidenceNeeded: [],
    doneCondition: { status: 'specified', text: 'answer is grounded' },
    planSteps: [],
    proposedExecution: { provider: 'auto', effort: 'none', rationale: 'auto' },
    source: 'model',
    ...over,
  };
}

function deps(over: Partial<OrchestrateDeps> = {}, p = provider([`Done.\n${ENVELOPE}`])): OrchestrateDeps {
  return {
    providers: { claude: p },
    clock: clock(),
    session: session(),
    ledger: ledger(),
    policy: DEFAULT_POLICY,
    cwd: '/repo',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    environmentContext: 'Repo: /repo\n',
    semanticPreflightV1: true,
    ...over,
  };
}

function localPort(content = 'auth module uses tokens'): ResearchPort & { grepCalls: number; readCalls: number } {
  const state = { grepCalls: 0, readCalls: 0 };
  return {
    get grepCalls() { return state.grepCalls; },
    get readCalls() { return state.readCalls; },
    async grepRepo() { state.grepCalls++; return ['src/auth.ts']; },
    async readFile() { state.readCalls++; return content; },
    async webSearch() { return ''; },
  };
}

describe('semantic evidence enforcement wiring', () => {
  it('medium uncertainty runs after local evidence and one semantic call only', async () => {
    let semanticCalls = 0;
    const p = provider([`I inspected src/auth.ts and it uses tokens.\n${ENVELOPE}`]);
    const port = localPort();
    await collect(orchestrate('explain auth module', deps({
      providers: { claude: p },
      researchPort: port,
      semanticPreflightExtractor: async () => {
        semanticCalls++;
        return { result: semantic() };
      },
    }, p), new AbortController().signal));

    assert.equal(semanticCalls, 1);
    assert.equal(port.readCalls, 1);
    assert.equal(p.calls, 1);
    assert.match(p.prompts[0] ?? '', /OBSERVED LOCAL EVIDENCE/);
    assert.match(p.prompts[0] ?? '', /auth module uses tokens/);
  });

  it('medium uncertainty may execute with required test obligation but cannot settle it complete', async () => {
    const p = provider([`Implemented the change.\n${ENVELOPE}`]);
    await collect(orchestrate('change the formatter', deps({
      providers: { claude: p },
      semanticPreflightExtractor: async () => ({
        result: semantic({
          objective: 'choose logging approach',
          taskShape: { kind: 'decision', scope: 'single-step', mutatesWorkspace: false },
          evidenceNeeded: [{
            id: 'TEST1',
            kind: 'test-result',
            phase: 'before-completion',
            query: 'run formatter tests',
            required: true,
          }],
        }),
      }),
    }, p), new AbortController().signal));

    assert.equal(p.calls, 1);
    assert.match(p.prompts[0] ?? '', /EVIDENCE OBLIGATIONS/);
    assert.match(p.prompts[0] ?? '', /pending; do not claim completion/);
  });

  it('missing local capability proceeds with work and carries UNVERIFIED EVIDENCE GAP into prompt and final output', async () => {
    const p = provider([`Unverified: I could not read the local repository evidence required for this claim because no local read capability is available. Based on the prompt alone, the auth module appears to use tokens.\n${ENVELOPE}`]);
    const events = await collect(orchestrate('explain auth module', deps({
      providers: { claude: p },
      researchPort: undefined,
      semanticPreflightExtractor: async () => ({ result: semantic() }),
    }, p), new AbortController().signal));

    // R1: work called exactly once
    assert.equal(p.calls, 1);

    // R2: prompt contains gap reason / evidence obligation block
    assert.match(p.prompts[0] ?? '', /UNVERIFIED EVIDENCE GAP/);
    assert.match(p.prompts[0] ?? '', /cannot ground/);

    // R3: final output contains explicit Unverified: label
    const final = events.find((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(final !== undefined);
    assert.equal(final.success, true);
    assert.match(final.output, /Unverified:/);

    // R4: no fabricated observed receipt
    const receiptNotices = events.filter(
      (e) => e.type === 'notice' && (e.message.includes('OBSERVED') || e.message.includes('obtained')),
    );
    assert.equal(receiptNotices.length, 0);

    // R5: completion/verdict is unverified — no passing/reviewed/done fabrication
    const passingNotices = events.filter(
      (e) => e.type === 'notice' && (e.message.includes('tests passing') || e.message.includes('reviewed by')),
    );
    assert.equal(passingNotices.length, 0);
    // Also verify no fabricated terminal done/reviewed receipt
    assert.ok(!('receipt' in final) || final.receipt === undefined || final.receipt === null, 'no fabricated receipt');
  });

  it('fresh external claim obtains one web receipt and cites it', async () => {
    let webCalls = 0;
    const source = 'Official status page says version 2.0 is current. https://example.test/status';
    const p = provider([`Official status page says version 2.0 is current. https://example.test/status\n${ENVELOPE}`]);
    const port: ResearchPort = {
      async grepRepo() { return []; },
      async readFile() { return null; },
      async webSearch() { webCalls++; return source; },
    };
    await collect(orchestrate('research the current external release status and compare the latest version for rollout', deps({
      providers: { claude: p },
      researchPort: port,
      semanticPreflightExtractor: async () => ({
        result: semantic({
          objective: 'current version lookup',
          taskShape: { kind: 'lookup', scope: 'single-step', mutatesWorkspace: false },
          evidenceNeeded: [{
            id: 'WEB1',
            kind: 'external-source',
            phase: 'before-answer',
            query: 'current version',
            required: true,
          }],
        }),
      }),
    }, p), new AbortController().signal));

    assert.equal(webCalls, 1);
    assert.equal(p.calls, 1);
    assert.match(p.prompts[0] ?? '', /OBSERVED WEB EVIDENCE/);
    assert.match(p.prompts[0] ?? '', /Official status page/);
  });

  it('local retrieval failure cannot set groundedness', async () => {
    const p = provider([`Should not run.\n${ENVELOPE}`]);
    const port: ResearchPort = {
      async grepRepo() { return ['src/auth.ts']; },
      async readFile() { throw new Error('read failed'); },
    };
    const events = await collect(orchestrate('explain auth module', deps({
      providers: { claude: p },
      researchPort: port,
      semanticPreflightExtractor: async () => ({ result: semantic() }),
    }, p), new AbortController().signal));

    assert.equal(p.calls, 0);
    const final = events.find((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(final !== undefined);
    assert.match(final.output, /DET_LOCAL:failed/);
  });

  it('observed read path passes validator while invented path fails', () => {
    const receipt: EvidenceReceiptV1 = {
      version: 1,
      needId: 'LOCAL1',
      kind: 'local-code',
      status: 'obtained',
      query: 'auth',
      pathsLocated: ['src/auth.ts'],
      pathsRead: ['src/auth.ts'],
      renderedContext: 'auth',
    };
    const directive: TurnDirective = {
      version: 1,
      requiredBeforeAnswer: [],
      outputValidators: [{ kind: 'require_observed_grounding' }],
      historyPolicy: { replayMode: 'normal', reasons: [] },
      repoOriented: true,
      substantial: false,
      evidenceReceipts: [receipt],
    };
    assert.equal(validateTurnOutput('See src/auth.ts for the behavior.', directive), null);
    const failure = validateTurnOutput('See src/payment.ts for the behavior.', directive);
    assert.ok(failure !== null);
    assert.equal(failure.kind, 'unobserved_grounding');
  });

  it('explicit Unverified sentence is honest fallback and passes', () => {
    const directive = compileTurnDirective({
      frame: undefined,
      plan: planEngagement({
        classification: { tier: 'worker', risk: 'low', rationale: 't' },
        routePlan: false,
        engagementBias: 0,
        task: 'lookup current version',
      } satisfies EngagementSignals),
      signals: {
        classification: { tier: 'worker', risk: 'low', rationale: 't' },
        routePlan: false,
        engagementBias: 0,
        task: 'lookup current version',
      },
      semanticTaskKind: 'lookup',
    });
    assert.equal(validateTurnOutput('Unverified: the current version appears to be 2.0.', directive), null);
  });

  it('trivial turn performs no semantic local or web investigation', async () => {
    let semanticCalls = 0;
    let webCalls = 0;
    const port: ResearchPort = {
      async grepRepo() { throw new Error('should not grep'); },
      async readFile() { throw new Error('should not read'); },
      async webSearch() { webCalls++; return 'unused'; },
    };
    await collect(orchestrate('hi', deps({
      researchPort: port,
      semanticPreflightExtractor: async () => {
        semanticCalls++;
        return { result: semantic() };
      },
    }), new AbortController().signal));

    assert.equal(semanticCalls, 0);
    assert.equal(webCalls, 0);
  });

  it('cancellation during evidence collection yields cancelled final and zero work calls', async () => {
    const p = provider([`Should not run.\n${ENVELOPE}`]);
    const ac = new AbortController();
    const port: ResearchPort = {
      async grepRepo() { ac.abort(); return ['src/auth.ts']; },
      async readFile() { throw new Error('read after abort'); },
    };
    const events = await collect(orchestrate('explain auth module', deps({
      providers: { claude: p },
      researchPort: port,
      semanticPreflightExtractor: async () => ({ result: semantic() }),
    }, p), ac.signal));

    assert.equal(p.calls, 0);
    const final = events.find((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(final !== undefined);
    assert.equal(final.canceled, true);
  });

  it('injected retrieval throw yields failed receipt and zero fabricated evidence', async () => {
    const p = provider([`Should not run.\n${ENVELOPE}`]);
    const port: ResearchPort = {
      async grepRepo() { throw new Error('grep failed'); },
      async readFile() { return null; },
    };
    const events = await collect(orchestrate('explain auth module', deps({
      providers: { claude: p },
      researchPort: port,
      semanticPreflightExtractor: async () => ({ result: semantic() }),
    }, p), new AbortController().signal));

    assert.equal(p.calls, 0);
    const final = events.find((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(final !== undefined);
    assert.match(final.output, /^Unverified:/);
    assert.doesNotMatch(final.output, /src\/auth\.ts was read/);
  });
});
