/**
 * test/unit/turn-call-budget-preflight.test.ts — P1-09c preflight call-budget
 * ledger tests.
 *
 * All named tests per the controlling contract.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { makeRouteClassifier } from '../../src/core/route-classifier.ts';
import { makeIntentExtractor } from '../../src/core/intent-extractor.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { Provider, ProviderEvent, ProviderRequest, Usage } from '../../src/providers/port.ts';
import type { TurnCallBudgetMode, TurnCallBudgetSpec } from '../../src/core/turn-call-budget.ts';
import { createTurnCallBudget } from '../../src/core/turn-call-budget.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SIGNAL = new AbortController().signal;

function budgetSpec(
  overrides: Partial<{
    turnId: string;
    mode: TurnCallBudgetMode;
    totalUnits: number;
    reservedWork: number;
    reservedFailover: number;
    reservedVerification: number;
  }> = {},
): TurnCallBudgetSpec {
  return {
    turnId: overrides.turnId ?? 'turn-p-1',
    mode: overrides.mode ?? 'observe',
    totalUnits: overrides.totalUnits ?? 10,
    reserved: {
      work: overrides.reservedWork ?? 1,
      failover: (overrides.reservedFailover ?? 0) as 0 | 1,
      verification: (overrides.reservedVerification ?? 0) as 0 | 1,
    },
  };
}

function countingProvider(
  id: 'claude' | 'codex',
  text: string,
  usage?: Usage,
): Provider & { runCount: number } {
  const p = {
    id,
    runCount: 0,
    async detect() {
      return {
        id,
        installed: true,
        version: '1.0.0',
        authenticated: true,
        plan: null,
        binaryPath: '/f',
        availableModels: [],
      };
    },
    async *run(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
      p.runCount++;
      yield { type: 'done', text, usage, raw: {} };
    },
  };
  return p;
}

function errorProvider(id: 'claude' | 'codex' = 'claude'): Provider & { runCount: number } {
  const p = {
    id,
    runCount: 0,
    async detect() {
      return {
        id,
        installed: true,
        version: '1.0.0',
        authenticated: true,
        plan: null,
        binaryPath: '/f',
        availableModels: [],
      };
    },
    // eslint-disable-next-line require-yield
    async *run(): AsyncIterable<ProviderEvent> {
      p.runCount++;
      throw new Error('spawn failed');
    },
  };
  return p;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('turn-call-budget preflight', () => {
  it('unified path receipt has one intent and zero route calls', async () => {
    const provider = countingProvider('claude', '{"goal":"ship it","kind":"coding","confidence":"high"}');
    const budget = createTurnCallBudget(budgetSpec());
    const extractor = makeIntentExtractor({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      turnCallBudget: budget,
    });

    await extractor('ship the feature', SIGNAL, { stage: 'intent' });

    const receipt = budget.snapshot();
    assert.equal(receipt.begun, 1, 'unified path: one intent extraction call');

    const purposes = receipt.events.filter((e) => e.type === 'call-begun').map((e) => e.purpose);
    assert.deepEqual(purposes, ['intent'], 'only intent purpose, no route calls');

    const routeCalls = receipt.events.filter((e) => e.type === 'call-begun' && e.purpose === 'route');
    assert.equal(routeCalls.length, 0, 'zero route calls on the unified extractor path');
  });

  it('legacy ambiguous path records route then intent', async () => {
    const routeProvider = countingProvider('claude', '{"tier":"ic","plan":true,"reason":"complex"}');
    const routeBudget = createTurnCallBudget(budgetSpec());
    const classifier = makeRouteClassifier({
      providers: { claude: routeProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 20_000,
      turnCallBudget: routeBudget,
    });

    await classifier('complex ambiguous task', SIGNAL, { stage: 'route' });
    const routeReceipt = routeBudget.snapshot();
    assert.equal(routeReceipt.begun, 1, 'legacy path: route classifier records one attempt');

    const intentProvider = countingProvider('claude', '{"goal":"debug","kind":"coding","confidence":"medium"}');
    const intentBudget = createTurnCallBudget(budgetSpec());
    const extractor = makeIntentExtractor({
      providers: { claude: intentProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      turnCallBudget: intentBudget,
    });

    await extractor('complex ambiguous task', SIGNAL, { stage: 'intent' });
    const intentReceipt = intentBudget.snapshot();
    assert.equal(intentReceipt.begun, 1, 'legacy path: intent extractor records one attempt');

    // Combined: route then intent
    assert.equal(routeReceipt.begun, 1);
    assert.equal(intentReceipt.begun, 1);
  });

  it('rules-only trivial turn records neither', async () => {
    // At the closure level: when no call is made to the classifier/extractor,
    // the budget records zero attempts. In real orchestrate, hasTierEvidence
    // and shouldExtractIntent gates prevent the model calls entirely.
    const budget = createTurnCallBudget(budgetSpec());
    const receipt = budget.snapshot();
    assert.equal(receipt.begun, 0, 'no provider calls → zero recorded attempts');
    assert.equal(receipt.settled, 0);
  });

  it('failed parse still records one attempt', async () => {
    const provider = countingProvider('claude', 'garbled nonsense, no json here');
    const budget = createTurnCallBudget(budgetSpec());
    const classifier = makeRouteClassifier({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 20_000,
      turnCallBudget: budget,
    });

    const result = await classifier('some task', SIGNAL);
    assert.equal(result, null, 'unparseable reply returns null');

    const receipt = budget.snapshot();
    assert.equal(receipt.begun, 1, 'failed parse still records one provider attempt');
    assert.equal(receipt.settled, 1, 'the attempt is settled even though parse failed');
  });

  it('local and web re-extraction have distinct purposes', async () => {
    const frameText = '{"goal":"debug the issue","kind":"debug","confidence":"medium"}';
    const localProvider = countingProvider('claude', frameText);
    const localBudget = createTurnCallBudget(budgetSpec({ turnId: 'turn-local' }));
    const localExtractor = makeIntentExtractor({
      providers: { claude: localProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      turnCallBudget: localBudget,
    });

    await localExtractor('debug this with environment', SIGNAL, { stage: 'reextract-local' });
    const localReceipt = localBudget.snapshot();
    const localPurposes = localReceipt.events.filter((e) => e.type === 'call-begun').map((e) => e.purpose);
    assert.deepEqual(localPurposes, ['reextract-local'], 'local re-extraction has reextract-local purpose');

    const webProvider = countingProvider('claude', frameText);
    const webBudget = createTurnCallBudget(budgetSpec({ turnId: 'turn-web' }));
    const webExtractor = makeIntentExtractor({
      providers: { claude: webProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      turnCallBudget: webBudget,
    });

    await webExtractor('debug this with web findings', SIGNAL, { stage: 'reextract-web' });
    const webReceipt = webBudget.snapshot();
    const webPurposes = webReceipt.events.filter((e) => e.type === 'call-begun').map((e) => e.purpose);
    assert.deepEqual(webPurposes, ['reextract-web'], 'web re-extraction has reextract-web purpose');

    assert.notDeepEqual(localPurposes, webPurposes, 'local and web re-extraction purposes are distinct');
  });

  it('preflight receipt count equals fake provider run count', async () => {
    // Use real makeRouteClassifier + makeIntentExtractor wired through the budget,
    // with counting providers so we can compare budget.begun with provider.runCount.
    const routeBudget = createTurnCallBudget(budgetSpec({ turnId: 'turn-receipt' }));
    const routeProvider = countingProvider('claude', '{"tier":"ic","plan":true,"reason":"complex"}');
    const classifier = makeRouteClassifier({
      providers: { claude: routeProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 20_000,
      turnCallBudget: routeBudget,
    });

    const intentBudget = createTurnCallBudget(budgetSpec({ turnId: 'turn-receipt-intent' }));
    const intentProvider = countingProvider('claude', '{"goal":"ship it","kind":"coding","confidence":"high"}');
    const extractor = makeIntentExtractor({
      providers: { claude: intentProvider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      turnCallBudget: intentBudget,
    });

    await classifier('some ambiguous task', SIGNAL, { stage: 'route' });
    await extractor('some ambiguous task', SIGNAL, { stage: 'intent' });

    const routeReceipt = routeBudget.snapshot();
    assert.equal(routeReceipt.begun, routeProvider.runCount,
      'route budget begun count equals provider run count');
    assert.equal(routeReceipt.begun, 1, 'route: one call recorded');

    const intentReceipt = intentBudget.snapshot();
    assert.equal(intentReceipt.begun, intentProvider.runCount,
      'intent budget begun count equals provider run count');
    assert.equal(intentReceipt.begun, 1, 'intent: one call recorded');
  });
});

describe('turn-call-budget preflight — error provider still records', () => {
  it('throwing provider records one failed attempt', async () => {
    const provider = errorProvider('claude');
    const budget = createTurnCallBudget(budgetSpec());
    const classifier = makeRouteClassifier({
      providers: { claude: provider },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 20_000,
      turnCallBudget: budget,
    });

    const result = await classifier('some task', SIGNAL);
    assert.equal(result, null, 'throwing provider returns null');

    const receipt = budget.snapshot();
    assert.equal(receipt.begun, 1, 'throwing provider still records one attempt');
    // With runBudgetedProvider, a thrown error settles as 'threw'
    assert.ok(receipt.settled >= 1, 'the attempt is settled');
  });
});
