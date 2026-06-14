import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrate } from '../../src/core/orchestrate.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { estimateInputTokens } from '../../src/core/orchestrate-signals.ts';
import { compactHistory } from '../../src/core/history.ts';
import { assembleContextBlocksDetailed } from '../../src/core/prompt-context.ts';
import { buildInitialExecutorContextBlockOptions } from '../../src/core/context-block-options.ts';
import type {
  Clock,
  CoreEvent,
  LedgerEntry,
  LedgerWriter,
  OrchestrateDeps,
  SessionEntry,
  SessionWriter,
} from '../../src/core/types.ts';
import type { Provider, ProviderEvent, ProviderRequest, Usage } from '../../src/providers/port.ts';
import type { CapabilityRegistry } from '../../src/core/model-capabilities.ts';

function makeClock(): Clock {
  const now = 1_000_000;
  let uuid = 0;
  return {
    now: () => now,
    isoNow: () => new Date(now).toISOString(),
    uuid: () => `uuid-${++uuid}`,
    random: () => 0.42,
  };
}

function makeSession(): SessionWriter & { entries: SessionEntry[] } {
  const entries: SessionEntry[] = [];
  return {
    id: 'sess-rendered-estimate',
    entries,
    async append(entry) {
      entries.push(entry);
    },
  };
}

function makeLedger(): LedgerWriter & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
  };
}

const USAGE: Usage = { inputTokens: 100, outputTokens: 50 };
const ENVELOPE =
  '{"confidence": 0.95, "escalate": false, "reason": "done", "needs_review": false}';

function makeRecordingCodex(): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    id: 'codex',
    requests,
    async detect() {
      return {
        id: 'codex',
        installed: true,
        version: '1.0.0',
        authenticated: true,
        binaryPath: '/usr/bin/codex',
        availableModels: ['gpt-5.4', 'gpt-5.2-codex'],
      };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: 'done', text: `ok\n${ENVELOPE}`, usage: USAGE, raw: {} };
    },
  } as Provider & { requests: ProviderRequest[] };
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const events: CoreEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

const REGISTRY: CapabilityRegistry = {
  claude: [],
  opencode: [],
  codex: [
    {
      provider: 'codex',
      id: 'gpt-5.4',
      aliases: [],
      tierHint: 'ic',
      supportedReasoningEfforts: [],
      contextWindow: 400_000,
      source: ['codex-cache'],
    },
    {
      provider: 'codex',
      id: 'gpt-5.2-codex',
      aliases: ['codex'],
      tierHint: 'ic',
      supportedReasoningEfforts: [],
      contextWindow: 128_000,
      source: ['codex-cache'],
    },
  ],
};

function makeDeps(overrides: Partial<OrchestrateDeps> = {}): {
  deps: OrchestrateDeps;
  codex: ReturnType<typeof makeRecordingCodex>;
} {
  const codex = makeRecordingCodex();
  const deps: OrchestrateDeps = {
    providers: { codex },
    clock: makeClock(),
    session: makeSession(),
    ledger: makeLedger(),
    policy: DEFAULT_POLICY,
    cwd: '/fake',
    sandbox: 'workspace-write',
    timeoutMs: 30_000,
    authenticatedProviders: ['codex'],
    availableModels: { codex: ['gpt-5.4', 'gpt-5.2-codex'] },
    capabilityRegistry: REGISTRY,
    ...overrides,
  };
  return { deps, codex };
}

async function firstTierStart(
  task: string,
  deps: OrchestrateDeps,
): Promise<{ model: string; provider: string; tier: string }> {
  for await (const event of orchestrate(task, deps, new AbortController().signal)) {
    if (event.type === 'tier-start') {
      return { model: event.model, provider: event.provider, tier: event.tier };
    }
  }
  throw new Error('expected a tier-start event');
}

describe('orchestrate rendered-input token estimate', () => {
  it('ignores oversized raw sheddable input and routes from the rendered context bytes only', async () => {
    const { deps } = makeDeps({
      environmentContext: `ENVIRONMENT\n${'E'.repeat(500_000)}`,
    });
    const task = 't'.repeat(399_999);
    const context = assembleContextBlocksDetailed(buildInitialExecutorContextBlockOptions(deps) ?? {});
    assert.equal(context.text, '', 'oversized sheddable environment is dropped by rendered assembly');
    assert.equal(
      estimateInputTokens([task, undefined, context.text]),
      99_999,
      'rendered estimate stays below the large-context threshold',
    );

    const start = await firstTierStart(task, deps);
    assert.equal(start.provider, 'codex');
    assert.equal(start.model, 'gpt-5.2-codex');
  });

  it('includes taste and understanding when they render, and can cross the large-context threshold because of them', async () => {
    const { deps } = makeDeps({
      tasteContext: `LEARNED TASTE\n${'T'.repeat(2_900)}`,
      understandingContext: `SYSTEM UNDERSTANDING\n${'U'.repeat(2_900)}`,
    });
    const context = assembleContextBlocksDetailed(buildInitialExecutorContextBlockOptions(deps) ?? {});
    const task = 't'.repeat(400_000 - context.text.length);
    assert.ok(context.text.includes('LEARNED TASTE'));
    assert.ok(context.text.includes('SYSTEM UNDERSTANDING'));
    assert.equal(
      estimateInputTokens([task, undefined, context.text]),
      100_000,
      'rendered taste + understanding push the estimate onto the large-context threshold',
    );

    const start = await firstTierStart(task, deps);
    assert.equal(start.model, 'gpt-5.4');
  });

  it('under cap, the routing estimate matches [task, historyContext, assembled.text] without double-counting context fields', async () => {
    const history = [
      { role: 'user', content: 'previous question', ts: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'previous answer', ts: '2026-01-01T00:00:01.000Z' },
    ] as const;
    const { deps } = makeDeps({
      history,
      environmentContext: 'ENVIRONMENT\nrepo-map',
      toolStateContext: 'ABOUT THIS TOOL\nsigned in',
      memoryContext: 'MEMORY\nremember this',
      tasteContext: 'LEARNED TASTE\nprefer concise answers',
      workStateContext: 'WORK STATE\nnext: patch tests',
      goalContext: 'CURRENT GOALS\nship S4',
      rulesContext: 'STANDING RULES\n- Do not fabricate facts.',
      visionTriageContext: 'VISION TRIAGE\nSOLID: implement exactly S4.',
      understandingContext: 'SYSTEM UNDERSTANDING\norchestrate feeds route with task signals.',
      intentFrame: 'INTENT\nImplement S4 only.',
      engagementPlan: 'ENGAGEMENT\nProceed directly.',
    });
    const historyContext = compactHistory(history);
    const context = assembleContextBlocksDetailed(buildInitialExecutorContextBlockOptions(deps) ?? {});
    const task = 't'.repeat(399_999 - historyContext.length - context.text.length);
    assert.equal(
      estimateInputTokens([task, historyContext, context.text]),
      99_999,
      'exact rendered estimate is below the large-context threshold by one token',
    );

    const start = await firstTierStart(task, deps);
    assert.equal(start.model, 'gpt-5.2-codex');
  });

  it('keeps the actual work prompt bytes aligned with the shared initial-executor context builder', async () => {
    const history = [
      { role: 'user', content: 'earlier user note', ts: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'earlier assistant note', ts: '2026-01-01T00:00:01.000Z' },
    ] as const;
    const { deps, codex } = makeDeps({
      history,
      environmentContext: 'ENVIRONMENT\nrepo-map',
      toolStateContext: 'ABOUT THIS TOOL\nsigned in',
      memoryContext: 'MEMORY\nremember this',
      tasteContext: 'LEARNED TASTE\nprefer concise answers',
      workStateContext: 'WORK STATE\nnext: patch tests',
      goalContext: 'CURRENT GOALS\nship S4',
      rulesContext: 'STANDING RULES\n- Do not fabricate facts.',
      visionTriageContext: 'VISION TRIAGE\nSOLID: implement exactly S4.',
      understandingContext: 'SYSTEM UNDERSTANDING\nroute estimates must use rendered context.',
      intentFrame: 'INTENT\nImplement S4 only.',
      engagementPlan: 'ENGAGEMENT\nProceed directly.',
    });
    const task = 'implement slice s4 only';
    await collect(orchestrate(task, deps, new AbortController().signal));

    const historyContext = compactHistory(history);
    const renderedContext = assembleContextBlocksDetailed(
      buildInitialExecutorContextBlockOptions(deps) ?? {},
    ).text;
    const prompt = codex.requests[0]?.prompt ?? '';
    assert.ok(prompt.includes(renderedContext), 'prompt must include the rendered shared context');
    assert.ok(prompt.includes(historyContext), 'prompt must include the compacted history');
    assert.ok(prompt.includes(task), 'prompt must include the task');
  });
});
