/**
 * test/unit/orchestrate-required-investigation.test.ts — rank-9 S5 wiring proof.
 *
 * Default-OFF + byte-identical when off. When the requiredInvestigation flag is ON:
 *   - an INVESTIGATE_CONTEXT turn that the confidence brain did NOT already ground
 *     runs exactly ONE bounded `buildRetrievalContext` call before the work call,
 *     and its findings reach the work prompt as `deps.investigationContext`.
 *   - if the brain already grounded the turn, the preflight is skipped (idempotent).
 *   - if the directive says 'none' or no researchPort is wired, no retrieval runs.
 *   - abort during the preflight emits a cancel final.
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

function extractorReturning(frame: IntentFrame): (task: string, signal: AbortSignal) => Promise<IntentExtraction> {
  return async () => ({ frame, usage: USAGE });
}

const INVESTIGATE_TASK =
  'investigate the existing auth module and explain how it works and suggest improvements';
const TRIVIAL_TASK = 'what is 2+2';

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

function recordingResearchPort(): ResearchPort & { grepCalls: number; readCalls: number } {
  const state = { grepCalls: 0, readCalls: 0 };
  const port: ResearchPort & { grepCalls: number; readCalls: number } = {
    get grepCalls() { return state.grepCalls; },
    get readCalls() { return state.readCalls; },
    async grepRepo() { return []; },
    async readFile() { return null; },
    async webSearch() { return ''; },
  };
  const originalGrep = port.grepRepo.bind(port);
  const originalRead = port.readFile.bind(port);
  port.grepRepo = async (cwd, query, maxHits) => {
    state.grepCalls++;
    return originalGrep(cwd, query, maxHits);
  };
  port.readFile = async (cwd, rel) => {
    state.readCalls++;
    return originalRead(cwd, rel);
  };
  return port;
}

function findingsPort(findings: string): ResearchPort & { grepCalls: number; readCalls: number } {
  const state = { grepCalls: 0, readCalls: 0 };
  const port: ResearchPort & { grepCalls: number; readCalls: number } = {
    get grepCalls() { return state.grepCalls; },
    get readCalls() { return state.readCalls; },
    async grepRepo() { return ['src/auth.ts']; },
    async readFile() { return findings; },
    async webSearch() { return ''; },
  };
  const originalGrep = port.grepRepo.bind(port);
  const originalRead = port.readFile.bind(port);
  port.grepRepo = async (cwd, query, maxHits) => {
    state.grepCalls++;
    return originalGrep(cwd, query, maxHits);
  };
  port.readFile = async (cwd, rel) => {
    state.readCalls++;
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

// ── OFF NEUTRALITY ───────────────────────────────────────────────────────────

describe('rank-9 S5 — OFF path is byte-identical', () => {
  it('does NOT run buildRetrievalContext and does NOT inject investigationContext', async () => {
    const port = recordingResearchPort();
    await collect(
      orchestrate(
        INVESTIGATE_TASK,
        baseDeps({
          intentExtractor: extractorReturning(modelFrame()),
          researchPort: port,
          // requiredInvestigation omitted = OFF
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(port.grepCalls + port.readCalls, 0, 'OFF: no retrieval call');
  });
});

// ── ON + LOCAL + NOT GROUNDED ────────────────────────────────────────────────

describe('rank-9 S5 — ON path', () => {
  it('runs exactly ONE buildRetrievalContext call and threads findings into the work prompt', async () => {
    const port = findingsPort('auth module uses tokens');
    const deps = baseDeps({
      intentExtractor: extractorReturning(modelFrame()),
      researchPort: port,
      requiredInvestigation: true,
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.ok(port.grepCalls > 0, 'ON+local+not-grounded: retrieval fired');
    assert.equal(port.readCalls, 1, 'ON+local+not-grounded: exactly one file read batch');
    const prompt = workPrompt(deps);
    assert.match(prompt, /LOCAL INVESTIGATION/);
    assert.match(prompt, /auth module uses tokens/);
  });

  it('is idempotent: skips the preflight when the brain already grounded the turn', async () => {
    const port = findingsPort('auth module uses tokens');
    // Low-confidence model frame triggers the brain's codebase round, which sets
    // brainGroundedness === 'grounded'. The rank-9 preflight must then skip its
    // own retrieval, so the total read count stays at 1 (the brain's single batch).
    const deps = baseDeps({
      intentExtractor: extractorReturning(modelFrame({ confidence: 'low' })),
      researchPort: port,
      requiredInvestigation: true,
    });
    await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.equal(port.readCalls, 1, 'already-grounded: preflight skipped (idempotent)');
    const prompt = workPrompt(deps);
    assert.doesNotMatch(prompt, /LOCAL INVESTIGATION/);
  });

  it('skips the preflight when the directive derives requiredInvestigation:none', async () => {
    const port = findingsPort('unused');
    const deps = baseDeps({
      intentExtractor: extractorReturning(modelFrame({ goal: TRIVIAL_TASK })),
      researchPort: port,
      requiredInvestigation: true,
    });
    await collect(orchestrate(TRIVIAL_TASK, deps, new AbortController().signal));
    assert.equal(port.grepCalls + port.readCalls, 0, 'none directive: no retrieval');
  });

  it('skips the preflight fail-soft when no researchPort is wired', async () => {
    const deps = baseDeps({
      intentExtractor: extractorReturning(modelFrame()),
      requiredInvestigation: true,
      // researchPort omitted
    });
    const events = await collect(orchestrate(INVESTIGATE_TASK, deps, new AbortController().signal));
    assert.ok(events.some((e) => e.type === 'tier-done' || e.type === 'final'), 'turn completes without port');
  });

  it('emits a cancel final when aborted during the preflight', async () => {
    const port: ResearchPort = {
      async grepRepo() { return ['src/auth.ts']; },
      async readFile() { return 'auth module uses tokens'; },
    };
    const ac = new AbortController();
    ac.abort();
    const deps = baseDeps({
      intentExtractor: extractorReturning(modelFrame()),
      researchPort: port,
      requiredInvestigation: true,
    });
    const events = await collect(orchestrate(INVESTIGATE_TASK, deps, ac.signal));
    const final = events.find((e): e is Extract<CoreEvent, { type: 'final' }> => e.type === 'final');
    assert.ok(final !== undefined);
    assert.equal(final.success, false);
    assert.equal(final.canceled, true);
  });
});
