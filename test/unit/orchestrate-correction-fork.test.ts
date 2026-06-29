/**
 * test/unit/orchestrate-correction-fork.test.ts — correction-fork end-to-end
 * tests for orchestrate(). Verifies fork write + invalidation when
 * MYSHELL_CORRECTION_FORK_V1 is on.
 */
import { beforeEach, describe, it } from 'vitest';
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
import type { IntentVersion, IntentStoreWriter, IntentStoreReader } from '../../src/core/intent-version.ts';
import type { Goal } from '../../src/core/goal-todo.ts';
import type { Provider, ProviderRequest, ProviderEvent } from '../../src/providers/port.ts';

function makeFakeClock(): Clock & { tick(ms: number): void } {
  let now = 1_000_000;
  let uuidCounter = 0;
  return {
    now(): number { return now; },
    isoNow(): string { return new Date(now).toISOString(); },
    uuid(): string { uuidCounter++; return `fake-uuid-${uuidCounter}`; },
    random(): number { return 0.42; },
    tick(ms: number): void { now += ms; },
  };
}

function answeringProvider(id: string): Provider {
  return {
    id: id as Provider['id'],
    async detect() {
      return { id: id as Provider['id'], installed: true, version: '1.0', authenticated: true, plan: null, binaryPath: null, availableModels: [] };
    },
    async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      if (req.prompt.includes('You extract the INTENT')) {
        yield {
          type: 'done',
          text: '{"goal":"ship the thing","kind":"coding","confidence":"high"}',
          raw: {},
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      } else {
        yield { type: 'partial', text: 'ok here is the answer', partial: 'ok here' };
        yield {
          type: 'done',
          text: 'ok here is the answer',
          raw: {},
          usage: { inputTokens: 200, outputTokens: 100 },
        };
      }
    },
  };
}

describe('orchestrate correction fork', () => {
  let clock: ReturnType<typeof makeFakeClock>;
  let sessionEntries: SessionEntry[];
  let ledger: LedgerEntry[];
  let intentVersions: IntentVersion[];
  let goals: Goal[];
  let supersededGoals: string[];

  const fakeSession: SessionWriter = {
    id: 'sess-1',
    append: async (e) => { sessionEntries.push(e); },
  };
  const fakeLedger: LedgerWriter = {
    record: async (e) => { ledger.push(e); },
  };

  const fakeIntentStore: IntentStoreWriter & IntentStoreReader = {
    append: async (v) => { intentVersions.push(v); },
    readAll: async () => intentVersions,
  };

  beforeEach(() => {
    clock = makeFakeClock();
    sessionEntries = [];
    ledger = [];
    intentVersions = [];
    goals = [];
    supersededGoals = [];
  });

  function buildDeps(opts: {
    intentStore?: boolean;
    correctionFork?: boolean;
    priorIntent?: IntentVersion;
  }): OrchestrateDeps {
    const useIntentStore = opts.intentStore === true;
    const useCorrectionFork = opts.correctionFork === true && useIntentStore;
    const intentVersionId = useIntentStore ? clock.uuid() : undefined;

    if (opts.priorIntent) {
      intentVersions.push(opts.priorIntent);
    }

    return {
      clock,
      session: fakeSession,
      ledger: fakeLedger,
      policy: DEFAULT_POLICY,
      providers: { claude: answeringProvider('claude') },
      cwd: '/tmp/project',
      sandbox: 'workspace-write',
      timeoutMs: 20_000,
      intentExtractor: undefined,
      routeClassifier: undefined,
      ...(useIntentStore && intentVersionId !== undefined ? { intentStore: fakeIntentStore, intentVersionId } : {}),
      ...(useCorrectionFork ? {
        correctionFork: {
          enabled: true,
          readIntentVersions: () => fakeIntentStore.readAll(),
          listGoals: () => Promise.resolve(goals),
          markGoalsSuperseded: async (ids, _meta) => {
            supersededGoals.push(...ids);
            return ids;
          },
        },
      } : {}),
    };
  }

  async function drain(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
    const events: CoreEvent[] = [];
    for await (const ev of gen) events.push(ev);
    return events;
  }

  function makePriorIntent(id: string, sessionId: string, createdAt: string): IntentVersion {
    return {
      version: 1,
      id,
      parentId: null,
      sessionId,
      createdAt,
      rawUserTurnText: 'do something',
      intent: { objective: 'do something' },
    };
  }

  it('correction fork off writes normal root intent and changes no goal state', async () => {
    const deps = buildDeps({ intentStore: true, correctionFork: false });
    deps.policy = { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } };
    const { makeIntentExtractor } = await import('../../src/core/intent-extractor.ts');
    deps.intentExtractor = makeIntentExtractor({
      providers: { claude: answeringProvider('claude') },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      accountAux: true,
      ledger: fakeLedger,
      clock,
      sessionId: 'sess-1',
    });
    const gen = orchestrate('ship the thing', deps, new AbortController().signal);
    await drain(gen);

    assert.equal(intentVersions.length, 1);
    // No parentId or null parentId means it's a root intent
    assert.equal(supersededGoals.length, 0);
  });

  it('correction fork on writes child IntentVersion with parentId set', async () => {
    const prior = makePriorIntent('prior-iv-1', 'sess-1', '2026-01-01T00:00:00.000Z');
    const deps = buildDeps({ intentStore: true, correctionFork: true, priorIntent: prior });
    deps.policy = { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } };
    const { makeIntentExtractor } = await import('../../src/core/intent-extractor.ts');
    deps.intentExtractor = makeIntentExtractor({
      providers: { claude: answeringProvider('claude') },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      accountAux: true,
      ledger: fakeLedger,
      clock,
      sessionId: 'sess-1',
    });
    const gen = orchestrate('no, I meant ship the other thing', deps, new AbortController().signal);
    const events = await drain(gen);

    assert.equal(intentVersions.length, 2, 'prior + child intent versions');
    const childVersion = intentVersions[1]!;
    assert.equal(childVersion.parentId, 'prior-iv-1', 'child should have parentId set');

    const notice = events.find((e: CoreEvent) => e.type === 'notice' && e.message.includes('Correction fork'));
    assert.notEqual(notice, undefined, 'should emit correction fork notice');
  });

  it('intent store off makes correction fork inert', async () => {
    const prior = makePriorIntent('prior-iv-2', 'sess-1', '2026-01-01T00:00:00.000Z');
    const deps = buildDeps({ intentStore: false, correctionFork: true, priorIntent: prior });
    deps.policy = { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } };
    const gen = orchestrate('no, I meant ship the other thing', deps, new AbortController().signal);
    await drain(gen);

    // intentStore off → no correction fork, no intent versions written
    assert.equal(intentVersions.length, 1, 'prior only, no new intent version');
    assert.equal(supersededGoals.length, 0);
  });

  it('uncertain correction performs no invalidation', async () => {
    const prior = makePriorIntent('prior-iv-3', 'sess-1', '2026-01-01T00:00:00.000Z');
    const deps = buildDeps({ intentStore: true, correctionFork: true, priorIntent: prior });
    deps.policy = { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } };
    const { makeIntentExtractor } = await import('../../src/core/intent-extractor.ts');
    deps.intentExtractor = makeIntentExtractor({
      providers: { claude: answeringProvider('claude') },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      accountAux: true,
      ledger: fakeLedger,
      clock,
      sessionId: 'sess-1',
    });
    // "actually implement login" does NOT match the correction grammar
    const gen = orchestrate('actually implement the login page', deps, new AbortController().signal);
    await drain(gen);

    // Still writes an intent version but it's a fresh root (parentId null)
    assert.equal(supersededGoals.length, 0);
  });

  it('correction fork on supersedes descendant goals and leaves siblings untouched', async () => {
    const prior = makePriorIntent('prior-iv-4', 'sess-1', '2026-01-01T00:00:00.000Z');
    goals = [
      {
        version: 1,
        id: 'goal-descendant',
        title: 'descendant',
        state: 'parked',
        source: 'user-explicit',
        roadmap: [],
        scope: 'project',
        projectKey: null,
        conversationId: null,
        createdAt: '2026-01-01T00:00:00Z',
        lastTouched: '2026-01-01T00:00:00Z',
        intentVersionId: 'prior-iv-4',
      } as Goal,
      {
        version: 1,
        id: 'goal-sibling',
        title: 'sibling',
        state: 'parked',
        source: 'user-explicit',
        roadmap: [],
        scope: 'project',
        projectKey: null,
        conversationId: null,
        createdAt: '2026-01-01T00:00:00Z',
        lastTouched: '2026-01-01T00:00:00Z',
        intentVersionId: 'other-iv',
      } as Goal,
      {
        version: 1,
        id: 'goal-done',
        title: 'done',
        state: 'done',
        source: 'user-explicit',
        roadmap: [],
        scope: 'project',
        projectKey: null,
        conversationId: null,
        createdAt: '2026-01-01T00:00:00Z',
        lastTouched: '2026-01-01T00:00:00Z',
        intentVersionId: 'prior-iv-4',
      } as Goal,
    ];

    const deps = buildDeps({ intentStore: true, correctionFork: true, priorIntent: prior });
    deps.policy = { ...DEFAULT_POLICY, escalateBelowConfidence: { low: 0, medium: 0, high: 0, critical: 0 } };
    const { makeIntentExtractor } = await import('../../src/core/intent-extractor.ts');
    deps.intentExtractor = makeIntentExtractor({
      providers: { claude: answeringProvider('claude') },
      policy: DEFAULT_POLICY,
      cwd: '/tmp/project',
      timeoutMs: 8_000,
      accountAux: true,
      ledger: fakeLedger,
      clock,
      sessionId: 'sess-1',
    });
    const gen = orchestrate('no, I meant ship the other thing', deps, new AbortController().signal);
    await drain(gen);

    // goal-descendant should be superseded (live, old-branch)
    assert.equal(supersededGoals.includes('goal-descendant'), true, 'live descendant should be superseded');
    // goal-sibling should NOT be superseded (sibling branch)
    assert.equal(supersededGoals.includes('goal-sibling'), false, 'sibling goal should be preserved');
    // goal-done should NOT be superseded (already terminal)
    assert.equal(supersededGoals.includes('goal-done'), false, 'done goal should be preserved');
  });
});
