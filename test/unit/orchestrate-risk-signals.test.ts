/**
 * test/unit/orchestrate-risk-signals.test.ts — rank-8 S5 live wiring proof.
 *
 * Two axes, both default-OFF (DESIGN-RANK8 §D / §E / §F):
 *
 *  RISK AXIS (§D.3): when the riskSignals flag is ON and the intent frame carries
 *  operationRisk/blastRadius hints, combineRisk RAISES classification.risk above the
 *  deterministic floor — never lowers it. The `classified` event (unified branch,
 *  emitted AFTER extraction) carries the raised risk.
 *
 *  WEB AXIS (§E): when ON, the frame's externalFreshness feeds needsExternal
 *  ADDITIVELY ('required' +2 clears RESEARCH_T unaided; 'helpful' +1 cannot trigger
 *  alone) → orchestrate's WEB_RESEARCH determination → route()'s soft search pre-pass
 *  prefers a native-search-capable (codex) provider → req.webSearch=true.
 *
 *  OFF NEUTRALITY (the #1 bar): with the flag absent/false, orchestrate STRIPS
 *  operationRisk/blastRadius/externalFreshness from the frame before any consumer
 *  reads it, so classification.risk stays exactly det.risk AND the WEB_RESEARCH
 *  determination is byte-identical to 3.134.0.
 *
 * All deps faked — no network, no fs, no child process.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { classify } from '../../src/core/classify.ts';
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
import type { CapabilityRegistry } from '../../src/core/model-capabilities.ts';

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

/** A provider that records every request it is asked to run. */
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

/** A model frame; source:'model' so the brain treats it as a real extraction. */
function modelFrame(over: Partial<IntentFrame> = {}): IntentFrame {
  return {
    version: 1,
    goal: 'do the thing the user asked for, carefully and end to end',
    kind: 'coding',
    confidence: 'high',
    source: 'model',
    ...over,
  };
}

// Deterministic-risk fixtures (verified via classify()):
//   LOW_TASK      → risk 'low'
//   CRITICAL_TASK → risk 'critical'
// Both are SUBSTANTIAL/ambiguous enough that shouldExtractIntent fires the extractor.
const LOW_TASK =
  'add a logging line to the helper, and also tidy up the surrounding comments and naming a bit';
const CRITICAL_TASK =
  'rotate the production secrets and credentials, and also clean up the related config a little';

// Web fixtures: a 'low'-risk, substantial turn with NO web keyword (so only the
// frame's externalFreshness can move the WEB_RESEARCH score).
const NO_WEB_KEYWORD_TASK =
  'summarize how the billing module computes a customer invoice, then suggest a cleanup';

/** Codex registry whose in-tier models declare a native search tool. */
const CODEX_SEARCH_REGISTRY: CapabilityRegistry = {
  claude: [],
  codex: [
    { provider: 'codex', id: 'gpt-5.5', aliases: [], tierHint: 'manager', supportedReasoningEfforts: [], supportsSearchTool: true, source: ['declarative'] },
    { provider: 'codex', id: 'gpt-5.4', aliases: [], tierHint: 'ic', supportedReasoningEfforts: [], supportsSearchTool: true, source: ['declarative'] },
  ],
  opencode: [],
};

function riskDeps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    providers: { claude: makeRecording('claude') },
    clock: makeFakeClock(),
    session: makeFakeSession(),
    ledger: makeFakeLedger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    ...over,
  };
}

function classifiedRisk(events: CoreEvent[]): string {
  const c = events.find((e) => e.type === 'classified');
  assert.ok(c !== undefined && c.type === 'classified', 'a classified event was emitted');
  return c.classification.risk;
}

// ── RISK AXIS ────────────────────────────────────────────────────────────────

describe('rank-8 S5 — risk axis (combineRisk into the route decision)', () => {
  it('OFF: a frame with operationRisk:critical does NOT change classification.risk (stays det.risk)', async () => {
    const det = classify(LOW_TASK);
    assert.equal(det.risk, 'low', 'fixture sanity: LOW_TASK is deterministically low');
    const events = await collect(
      orchestrate(
        LOW_TASK,
        riskDeps({
          intentExtractor: extractorReturning(modelFrame({ operationRisk: 'critical', blastRadius: 'critical' })),
          unifyPreflight: true, // unified branch: classified event is AFTER extraction
          // riskSignals omitted = OFF
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(classifiedRisk(events), det.risk, 'OFF path: risk is byte-identical to det.risk');
  });

  it('ON: a low-keyword task with operationRisk:high yields classification.risk === high (raise)', async () => {
    assert.equal(classify(LOW_TASK).risk, 'low');
    const events = await collect(
      orchestrate(
        LOW_TASK,
        riskDeps({
          intentExtractor: extractorReturning(modelFrame({ operationRisk: 'high' })),
          unifyPreflight: true,
          riskSignals: true,
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(classifiedRisk(events), 'high', 'ON path: model RAISED low → high');
  });

  it('ON: blastRadius alone raises; max of the two hints wins', async () => {
    const events = await collect(
      orchestrate(
        LOW_TASK,
        riskDeps({
          intentExtractor: extractorReturning(modelFrame({ operationRisk: 'medium', blastRadius: 'high' })),
          unifyPreflight: true,
          riskSignals: true,
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(classifiedRisk(events), 'high', 'max(low floor, medium, high) === high');
  });

  it('ON: a critical-keyword task with operationRisk:low STAYS critical (deterministic floor wins)', async () => {
    assert.equal(classify(CRITICAL_TASK).risk, 'critical', 'fixture sanity: CRITICAL_TASK is critical');
    const events = await collect(
      orchestrate(
        CRITICAL_TASK,
        riskDeps({
          intentExtractor: extractorReturning(modelFrame({ operationRisk: 'low', blastRadius: 'low' })),
          unifyPreflight: true,
          riskSignals: true,
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(classifiedRisk(events), 'critical', 'floor wins: model can never lower risk');
  });

  it('ON: no frame (extractor throws) → fail-soft, risk stays det.risk (no raise, no throw)', async () => {
    const throwing = async (): Promise<IntentExtraction> => {
      throw new Error('boom');
    };
    const det = classify(LOW_TASK);
    const events = await collect(
      orchestrate(
        LOW_TASK,
        riskDeps({ intentExtractor: throwing, unifyPreflight: true, riskSignals: true }),
        new AbortController().signal,
      ),
    );
    assert.equal(classifiedRisk(events), det.risk, 'fail-soft: no frame → no raise');
  });
});

// ── WEB AXIS ───────────────────────────────────────────────────────────────

describe('rank-8 S5 — web axis (externalFreshness → WEB_RESEARCH, additive + guarded)', () => {
  function webDeps(over: Partial<OrchestrateDeps>): OrchestrateDeps {
    const codex = makeRecording('codex');
    return {
      providers: { codex },
      clock: makeFakeClock(),
      session: makeFakeSession(),
      ledger: makeFakeLedger(),
      policy: DEFAULT_POLICY,
      cwd: '/fake',
      sandbox: 'workspace-write',
      timeoutMs: 30_000,
      authenticatedProviders: ['codex'],
      capabilityRegistry: CODEX_SEARCH_REGISTRY,
      ...over,
    };
  }

  /** Run the turn, return whether the WORK provider request asked for native search. */
  async function ranWithWebSearch(deps: OrchestrateDeps, task: string): Promise<boolean> {
    const codex = deps.providers.codex as Provider & { requests: ProviderRequest[] };
    await collect(orchestrate(task, deps, new AbortController().signal));
    return codex.requests.some((r) => r.webSearch === true);
  }

  it('ON: externalFreshness:required → WEB_RESEARCH fires (req.webSearch true)', async () => {
    const got = await ranWithWebSearch(
      webDeps({
        intentExtractor: extractorReturning(modelFrame({ externalFreshness: 'required' })),
        riskSignals: true,
      }),
      NO_WEB_KEYWORD_TASK,
    );
    assert.equal(got, true, "'required' (+2) clears RESEARCH_T unaided → web search");
  });

  it('ON: externalFreshness:helpful ALONE does NOT fire WEB_RESEARCH (+1 below the bar)', async () => {
    const got = await ranWithWebSearch(
      webDeps({
        intentExtractor: extractorReturning(modelFrame({ externalFreshness: 'helpful' })),
        riskSignals: true,
      }),
      NO_WEB_KEYWORD_TASK,
    );
    assert.equal(got, false, "'helpful' (+1) is strictly below RESEARCH_T → no web search alone");
  });

  it('OFF: externalFreshness:required does NOT fire WEB_RESEARCH (field stripped before engagement)', async () => {
    const got = await ranWithWebSearch(
      webDeps({
        intentExtractor: extractorReturning(modelFrame({ externalFreshness: 'required' })),
        // riskSignals omitted = OFF → frame copy strips externalFreshness → needsExternal sees undefined
      }),
      NO_WEB_KEYWORD_TASK,
    );
    assert.equal(got, false, 'OFF path: byte-identical WEB_RESEARCH determination (no web search)');
  });
});
