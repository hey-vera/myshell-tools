/**
 * test/unit/orchestrate-preflight-guard.test.ts — rank-10 aggregate preflight
 * overhead guard (default-OFF, byte-identical when off).
 *
 * The guard counts blocking pre-answer model calls and SHEDS the next avoidable
 * optional one when the count would exceed the turn-class budget. It uses ONLY
 * the existing CAPABILITY_BUDGET ceiling + existing QuotaPressure signals:
 * NO new probe, NO token meter, NO model call.
 *
 * All deps faked — no network, no fs, no child process.
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
import type { IntentFrame, IntentExtraction } from '../../src/core/intent.ts';
import type { Provider, ProviderRequest, ProviderEvent, Usage } from '../../src/providers/port.ts';
import type { ResearchPort } from '../../src/core/research.ts';

function makeFakeClock(): Clock {
  const now = 1_000_000;
  let n = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `uuid-${++n}`,
    random: () => 0.42,
  };
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
const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };

function makeRecording(id: 'claude' | 'codex'): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const p: Provider & { requests: ProviderRequest[] } = {
    id,
    requests,
    async detect() {
      return { id, installed: true, version: '1', authenticated: true, binaryPath: '/f', availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: 'done', text: `Done.\n${ENVELOPE}`, usage: USAGE, raw: {} };
    },
  };
  return p;
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function modelFrame(over: Partial<IntentFrame> = {}): IntentFrame {
  return {
    version: 1,
    goal: 'explain how the auth module works and suggest improvements',
    kind: 'coding',
    confidence: 'high',
    source: 'model',
    ...over,
  };
}

function countingExtractor(frame: IntentFrame): {
  extractor: (task: string, signal: AbortSignal) => Promise<IntentExtraction>;
  counter: { value: number };
} {
  const counter = { value: 0 };
  const extractor = async (): Promise<IntentExtraction> => {
    counter.value++;
    return { frame, usage: USAGE };
  };
  return { extractor, counter };
}

const INVESTIGATE_TASK =
  'investigate the existing auth module and explain how it works and suggest improvements';

function findingsPort(findings: string): ResearchPort & { counter: { value: number } } {
  const port: ResearchPort & { counter: { value: number } } = {
    counter: { value: 0 },
    async grepRepo() { return ['src/auth.ts']; },
    async readFile() { return findings; },
    async webSearch() { return ''; },
  };
  const originalRead = port.readFile.bind(port);
  port.readFile = async (cwd, rel) => {
    port.counter.value++;
    return originalRead(cwd, rel);
  };
  return port;
}

function baseDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: { claude: makeRecording('claude') },
    clock: makeFakeClock(),
    session: makeFakeSession(),
    ledger: makeFakeLedger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    environmentContext: 'Repo: /fake\n', // makes repoPresent true
    ...over,
  };
}

function workPrompt(deps: OrchestrateDeps): string {
  const p = deps.providers.claude as Provider & { requests: ProviderRequest[] };
  const workReq = p.requests.find((r) => !r.prompt.includes('You extract the INTENT'));
  return workReq?.prompt ?? '';
}

function workCalls(deps: OrchestrateDeps): number {
  const p = deps.providers.claude as Provider & { requests: ProviderRequest[] };
  return p.requests.filter((r) => !r.prompt.includes('You extract the INTENT')).length;
}

// ── OFF NEUTRALITY ───────────────────────────────────────────────────────────

describe('rank-10 — OFF path is byte-identical', () => {
  it('does NOT shed the intent pass and counts the same calls as the pre-guard path', async () => {
    const { extractor, counter } = countingExtractor(modelFrame());
    const deps = baseDeps({
      intentExtractor: extractor,
      // preflightGuard omitted = OFF
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(counter.value, 1, 'OFF: exactly one intent extraction');
    assert.equal(workCalls(deps), 1, 'OFF: exactly one work call');
  });

  it('does NOT shed the rank-9 retrieval when both flags are off', async () => {
    const port = findingsPort('auth module uses tokens');
    const { extractor } = countingExtractor(modelFrame());
    const deps = baseDeps({
      intentExtractor: extractor,
      researchPort: port,
      requiredInvestigation: true,
      // preflightGuard omitted = OFF
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(port.counter.value, 1, 'OFF+requiredInvestigation ON: retrieval fires');
    assert.match(workPrompt(deps), /LOCAL INVESTIGATION/);
  });
});

// ── ON PATH ──────────────────────────────────────────────────────────────────

describe('rank-10 — ON path', () => {
  it('within budget: normal/substantial turn takes the one allowed optional preflight', async () => {
    const { extractor, counter } = countingExtractor(modelFrame());
    const deps = baseDeps({
      intentExtractor: extractor,
      preflightGuard: true,
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(counter.value, 1, 'ON within budget: intent extraction still runs');
    assert.equal(workCalls(deps), 1, 'ON within budget: core answer still runs');
  });

  it('does NOT govern the rank-9 local retrieval — a local grep is not a model call, so it always runs', async () => {
    const port = findingsPort('auth module uses tokens');
    const { extractor, counter } = countingExtractor(modelFrame());
    const deps = baseDeps({
      intentExtractor: extractor,
      researchPort: port,
      requiredInvestigation: true,
      preflightGuard: true,
    });
    const events = await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(counter.value, 1, 'intent extraction runs (the one allowed MODEL call)');
    assert.equal(port.counter.value, 1, 'rank-9 LOCAL retrieval is NOT shed by the guard (orthogonal)');
    assert.match(workPrompt(deps), /LOCAL INVESTIGATION/);
    assert.equal(workCalls(deps), 1, 'core answer still runs');
    assert.ok(events.some((e) => e.type === 'final' && e.success), 'turn succeeds');
  });

  it('over budget with seeded upstream calls: sheds the intent pass (rules fallback)', async () => {
    const { extractor, counter } = countingExtractor(modelFrame());
    const deps = baseDeps({
      intentExtractor: extractor,
      preflightGuard: true,
      observedBlockingCalls: 1, // upstream call already consumed the budget
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(counter.value, 0, 'seeded over budget: intent extraction is shed');
    assert.equal(workCalls(deps), 1, 'seeded over budget: core answer still runs');
  });

  it('trivial turn sheds the optional intent MODEL call (budget 0)', async () => {
    const port = findingsPort('auth module uses tokens');
    const { extractor, counter } = countingExtractor(modelFrame());
    const deps = baseDeps({
      intentExtractor: extractor,
      researchPort: port,
      requiredInvestigation: true,
      preflightGuard: true,
    });
    await collect(orchestrate('what is 2+2', deps, new AbortController().signal));
    // "what is 2+2" is trivial (worker/low), so the guard budget is 0 → the intent
    // MODEL call is shed. The rank-9 local retrieval simply never runs here because a
    // trivial turn carries no INVESTIGATE_CONTEXT (requiredInvestigation derives 'none'),
    // NOT because the guard shed it — rank 10 does not govern the local grep.
    assert.equal(counter.value, 0, 'trivial: intent pass is shed');
    assert.equal(port.counter.value, 0, 'trivial: no INVESTIGATE_CONTEXT → retrieval never runs');
    assert.equal(workCalls(deps), 1, 'trivial: core answer still runs');
  });

  it('pressure 3 matches decideShed: the optional intent MODEL call is denied (local retrieval is not governed)', async () => {
    const port = findingsPort('auth module uses tokens');
    const { extractor, counter } = countingExtractor(modelFrame());
    const deps = baseDeps({
      intentExtractor: extractor,
      researchPort: port,
      requiredInvestigation: true,
      preflightGuard: true,
      governorPressure: 3,
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(counter.value, 0, 'pressure 3: intent pass is shed (matches decideShed)');
    assert.equal(port.counter.value, 1, 'pressure 3: the rank-9 LOCAL retrieval still runs (not a model call)');
    assert.equal(workCalls(deps), 1, 'pressure 3: core answer still runs');
  });

  it('unified path counts its ONE extractor; the rank-9 LOCAL retrieval still runs (not governed)', async () => {
    const port = findingsPort('auth module uses tokens');
    const { extractor, counter } = countingExtractor(modelFrame({ routeTier: 'ic' }));
    const deps = baseDeps({
      intentExtractor: extractor,
      researchPort: port,
      requiredInvestigation: true,
      unifyPreflight: true,
      preflightGuard: true,
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(counter.value, 1, 'unified: one extractor call counted');
    assert.equal(port.counter.value, 1, 'rank-9 LOCAL retrieval runs — the guard governs model calls only');
    assert.match(workPrompt(deps), /LOCAL INVESTIGATION/);
  });
});
