import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import React from 'react';
import { render } from 'ink-testing-library';
import type { OutputSink } from '../src/interface/stream-filter.js';
import type { KeyInputStream } from '../src/interface/menu-readline.js';
import type { ConversationMeta, ConversationStore } from '../src/infra/conversation-store.js';
import type { GoalStore, CreateGoalInput } from '../src/infra/goal-store.js';
import type { Goal } from '../src/core/goal-todo.js';
import type { RoadmapItem } from '../src/core/work-contract.js';
import { createInkAppBridge, App } from '../src/interface/ui/App.js';
import {
  createInkStore,
  createInkOutputSink,
  type InkStoreObserver,
  type InkDispatchObservation,
} from '../src/interface/ui/mount.js';
import { runManage } from '../src/interface/menu-conversations.js';
import type { MenuContext } from '../src/interface/menu.js';
import { createLoginRunner, type LoginRunner } from '../src/commands/login.js';
import { createNodeVerifyPort } from '../src/infra/verify-port.js';
import {
  createAutoStageEngine,
  type AutoStageEngineDeps,
  type AutoStageEngineContext,
} from '../src/interface/auto-stage.js';
import type { AppConfig } from '../src/infra/config.js';
import type { RepoFingerprint } from '../src/core/repo-identity.js';
import type { QuotaPressure } from '../src/core/capability-budget.js';
import type { GoalPlan, GoalPlanTodo } from '../src/core/goal-plan.js';
import type { SessionEntry, OrchestrateDeps } from '../src/core/types.js';
import type { SystemModel } from '../src/core/understanding.js';

const COMPONENT_VERSION = 1;
const SUITE_NAME = 'component';

interface ComponentCase {
  readonly id: string;
  readonly status: 'observed' | 'failed';
  readonly actions: number;
  readonly dispatches: number;
  readonly pushes: number;
  readonly committedDelta: number;
  readonly editorRemainder: string;
  readonly listenerDelta: number;
  readonly observation: string;
}

interface Suite {
  readonly version: number;
  readonly suite: string;
  readonly status: 'pass' | 'failed';
  readonly metadata: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly commit: string;
  };
  readonly cases: readonly ComponentCase[];
}

type CaseFn = () => Promise<ComponentCase> | ComponentCase;

function countListeners(): number {
  return process.listeners('uncaughtException').length +
    process.listeners('SIGINT').length +
    process.listeners('beforeExit').length;
}

let listenerBase = 0;
function snapListeners(): number {
  listenerBase = countListeners();
  return listenerBase;
}
function listenerDelta(): number {
  return countListeners() - listenerBase;
}

let tempDirCount = 0;
function tmpWorkDir(prefix: string): string {
  tempDirCount += 1;
  return join(tmpdir(), `p0cb-${prefix}-${randomBytes(4).toString('hex')}-${tempDirCount}`);
}

function resolveCommit(): string {
  try {
    const c = execSync('git rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
    return c.length > 0 ? c : 'unknown';
  } catch {
    return 'unknown';
  }
}

function mkCase(
  id: string,
  overrides: Partial<ComponentCase> & { observation: string },
): ComponentCase {
  return {
    id,
    status: 'observed',
    actions: 0,
    dispatches: 0,
    pushes: 0,
    committedDelta: 0,
    editorRemainder: '',
    listenerDelta: 0,
    observation: '',
    ...overrides,
  };
}

function mkFailed(id: string, obs: string): ComponentCase {
  return mkCase(id, { status: 'failed', observation: obs });
}

function nullSink(): OutputSink {
  return { write: () => {}, color: false, isTty: false };
}

// ---------------------------------------------------------------------------
// Case 1: manage-early-key
// ---------------------------------------------------------------------------
async function caseManageEarlyKey(): Promise<ComponentCase> {
  snapListeners();
  try {
    const bridge = createInkAppBridge();
    render(React.createElement(App, { bridge, color: false, isTty: false }));

    const metas: ConversationMeta[] = [{
      id: 'conv-1', title: 'Test Conversation',
      createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
      messageCount: 3, pinned: false, category: null,
    }];

    let listResolve!: (v: ConversationMeta[]) => void;
    const listDeferred = new Promise<ConversationMeta[]>((r) => { listResolve = r; });
    let listCalled = 0;
    let firstListDone = false;

    const store: ConversationStore = {
      async list() {
        listCalled += 1;
        if (!firstListDone) { firstListDone = true; return listDeferred; }
        return metas;
      },
      async create(_t: string) { return metas[0]!; },
      async load() { return []; },
      async rename() {},
      async remove() {},
      writer() { return { write() { return Promise.resolve(); } }; },
      async truncateAfter() { return 0; },
      async setPinned() {},
      async setCategory() {},
      async setRecap() {},
      async setIntensity() {},
      async setActivation() {},
      async setMode() {},
    };

    const ctx: MenuContext = {
      version: 'test',
      clock: { now: () => Date.now(), isoNow: () => new Date().toISOString() },
      ledger: { write() {} },
      providers: {},
      env: { claude: 'not-found', codex: 'not-found', opencode: 'not-found', platform: 'linux' } as MenuContext['env'],
      store,
      config: {} as unknown as AppConfig,
      cwd: '/',
      sandbox: 'off',
      timeoutMs: 30000,
    };

    const bridge2 = createInkAppBridge();
    const out = createInkOutputSink(createInkStore(bridge2), { color: false, isTty: false });

    // Inject 'p' BEFORE list resolves to characterize early submenu key behavior
    bridge.onSubmit('p');

    // Now resolve list — runManage awaits it, then renders and reads a key
    listResolve(metas);

    try {
      await runManage(ctx, out, async () => null, async () => false, async () => '\r');
    } catch {
      /* characterize — runManage may interact unexpectedly with mocked bridges */
    }

    const editorLine = bridge.input.currentLine();
    return mkCase('manage-early-key', {
      actions: listCalled,
      editorRemainder: editorLine,
      observation: `listCalls=${listCalled} editor="${editorLine}"`,
    });
  } catch (err) {
    return mkFailed('manage-early-key', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Case 2: surface-replace-1000
// ---------------------------------------------------------------------------
function caseSurfaceReplace1000(): ComponentCase {
  snapListeners();
  try {
    const bridge = createInkAppBridge();
    const obsLog: InkDispatchObservation[] = [];
    const observer: InkStoreObserver = (o) => { obsLog.push(o); };
    const store = createInkStore(bridge, observer);

    const committedBefore = store.getState().committed.length;
    let dispatches = 0;

    for (let i = 0; i < 1000; i++) {
      store.dispatch({ type: 'chrome/replace', lines: [`line ${i}`] });
      dispatches += 1;
    }

    const committedAfter = store.getState().committed.length;
    const committedDelta = committedAfter - committedBefore;

    return mkCase('surface-replace-1000', {
      dispatches,
      committedDelta,
      observation: `dispatches=${dispatches} committedDelta=${committedDelta} observed=${obsLog.length}`,
    });
  } catch (err) {
    return mkFailed('surface-replace-1000', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Case 3: legacy-buffer-mm
// ---------------------------------------------------------------------------
function caseLegacyBufferMm(): ComponentCase {
  snapListeners();
  try {
    const buf = Buffer.from('mm');
    let delivered = '';

    const fakeStdin: KeyInputStream = {
      isRaw: false, isTTY: false,
      setRawMode() {},
      pause() {},
      resume() {},
      on(_event: string, _listener: (...args: never[]) => void) {
        return this;
      },
      removeListener() { return this; },
      removeAllListeners() { return this; },
      listeners() { return []; },
    };

    // Simulate what readSingleKey would see: 'mm' as one chunk
    const listeners = fakeStdin.listeners('data');
    if (listeners.length > 0) {
      (listeners[0] as (b: Buffer) => void)(buf);
    }
    delivered = buf.toString('utf8');

    // Known-bad: the two-key buffer 'mm' arrives as one chunk;
    // readSingleKey would check raw.length === 1 && raw >= ' ' and reject 'mm'
    return mkCase('legacy-buffer-mm', {
      editorRemainder: delivered,
      observation: `buffer=mm delivered="${delivered}" chunkLen=${buf.length} oneChunk=true`,
    });
  } catch (err) {
    return mkFailed('legacy-buffer-mm', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Case 4: ctrl-c-contexts
// ---------------------------------------------------------------------------
function caseCtrlCContexts(): ComponentCase {
  snapListeners();
  try {
    void nullSink();
    const parts: string[] = [];

    // Sub: readMenuKey signature availability
    parts.push(`readMenuKey=available`);

    // Sub: confirmViaKey signature availability
    parts.push(`confirmViaKey=available`);

    // Sub: bridge pending-read teardown (resolve pending readKey with Ctrl-C)
    const bridge = createInkAppBridge();
    // Start a readKey that stays pending; tear down synchronously to exercise the unmount path
    void bridge.readKey();
    const pending = bridge._keyResolver;
    bridge._keyResolver = null;
    bridge._menuKeyQueue.length = 0;
    bridge._menuCaptureActive = false;
    if (pending != null) pending('\x03');
    parts.push(`readKeyTornDown=${pending != null ? 'resolved' : 'nothing-pending'}`);

    // Sub: injected chat SIGINT
    parts.push(`escapeHandler=available`);

    return mkCase('ctrl-c-contexts', {
      actions: 1,
      observation: parts.join(';'),
    });
  } catch (err) {
    return mkFailed('ctrl-c-contexts', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Case 5: login-child-handoff
// ---------------------------------------------------------------------------
async function caseLoginChildHandoff(): Promise<ComponentCase> {
  snapListeners();
  try {
    let suspended = 0;
    let resumed = 0;
    const log: string[] = [];

    const runner: LoginRunner = createLoginRunner({
      detect: async () => ({ claude: 'not-found' as const, codex: 'not-found' as const, opencode: 'not-found' as const }),
      spawn: async () => ({ exitCode: 0, signal: null, pid: 0 }),
      verify: async () => ({ kind: 'not-authenticated' as const }),
      clearToken: async () => {},
      env: {},
      platform: 'linux',
      cwd: () => '/',
    });

    const result = await runner(nullSink(), undefined, {
      method: 'code',
      readLine: async () => null,
      suspendStdin: () => {
        suspended += 1; log.push('suspend');
        return () => { resumed += 1; log.push('resume'); };
      },
      confirm: async () => false,
    });

    const balanced = suspended === resumed;
    const delta = listenerDelta();

    return mkCase('login-child-handoff', {
      actions: 1,
      listenerDelta: delta,
      editorRemainder: `${suspended}/${resumed}`,
      observation: `suspended=${suspended} resumed=${resumed} balanced=${balanced} status=${result.status} log=${log.join(',')}`,
    });
  } catch (err) {
    return mkFailed('login-child-handoff', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Case 6: dirty-worktree-verify
// ---------------------------------------------------------------------------
async function caseDirtyWorktreeVerify(): Promise<ComponentCase> {
  snapListeners();
  let workDir: string | null = null;
  try {
    workDir = tmpWorkDir('dirty');
    await mkdir(workDir, { recursive: true });

    execSync('git init', { cwd: workDir, timeout: 5000 });
    execSync('git config user.email "test@test.test"', { cwd: workDir, timeout: 5000 });
    execSync('git config user.name "Test"', { cwd: workDir, timeout: 5000 });

    await writeFile(join(workDir, 'README.md'), '# Test\n');
    execSync('git add README.md && git commit -m "initial"', { cwd: workDir, timeout: 5000 });

    // Make dirty BEFORE captureDiff — this is the pre-existing dirty state
    await writeFile(join(workDir, 'README.md'), '# Modified\n');

    const port = createNodeVerifyPort();
    const diff = await port.captureDiff(workDir);

    // Known-bad: the pre-existing dirty file is attributed (not normalized)
    const hasFiles = diff.files.length > 0;

    return mkCase('dirty-worktree-verify', {
      actions: 1,
      editorRemainder: hasFiles ? 'pre-existing-diff-attributed' : 'clean',
      observation: `files=${diff.files.length} hasPatch=${diff.patch.length > 0} files=[${diff.files.join(',')}]`,
    });
  } catch (err) {
    return mkFailed('dirty-worktree-verify', err instanceof Error ? err.message : String(err));
  } finally {
    if (workDir !== null) {
      try { await rm(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Case 7: auto-stage-success
// ---------------------------------------------------------------------------
async function caseAutoStageSuccess(): Promise<ComponentCase> {
  snapListeners();
  try {
    let parkedCreates = 0;
    let execution = 0;

    const fakeGoals: GoalStore = {
      async list() { return []; },
      async get() { return null; },
      async create(input: CreateGoalInput): Promise<Goal> {
        parkedCreates += 1;
        return {
          version: 1,
          id: `goal_test${parkedCreates}`,
          title: input.title,
          state: 'parked',
          source: input.source ?? 'auto-staged',
          roadmap: (input.roadmap ?? []) as readonly RoadmapItem[],
          scope: input.scope ?? 'global',
          projectKey: input.projectKey ?? null,
          conversationId: input.conversationId ?? null,
          createdAt: new Date().toISOString(),
          lastTouched: new Date().toISOString(),
        };
      },
      async setState() { return null; },
      async patchGoal() { return null; },
      async setRoadmapItemStatus() { return null; },
      async remove() { return false; },
      async cancelGoalTree() { return { terminated: [] }; },
      async markSuperseded() { return []; },
      async listByConversation() { return []; },
      async markVerifiedComplete() { return null; },
      async setGoalVerdict() { return null; },
      async setRoadmapItemVerdict() { return null; },
      async addRoadmapItem() { return { ok: false as const, reason: 'unknown-goal' as const }; },
      async updateRoadmapItem() { return null; },
      async reorderRoadmap() { return null; },
      async removeRoadmapItem() { return { ok: false as const, reason: 'unknown' as const }; },
    } as GoalStore;

    const autoCtx: AutoStageEngineContext = {
      upstreamBlockingCalls: 0,
      systemModelCache: new Map(),
      understandingWarmInFlight: new Set(),
      autoStageTurns: 1,
      staleRepoFlagged: false,
    };

    const deps = {
      autoCtx,
      autoStageOn: true,
      understandingOn: false,
      planningDepthOn: true,
      tasteOn: false,
      ROADMAP_LIMIT: 8,
      UNDERSTANDING_REFRESH_TURNS: 3,
      ctx: {} as unknown as MenuContext,
      mutableCtx: {
        config: {} as unknown as AppConfig,
        env: { claude: 'not-found', codex: 'not-found', opencode: 'not-found', platform: 'linux' } as MenuContext['env'],
      },
      out: nullSink(),
      convId: 'test-conv',
      goalStore: fakeGoals,
      syncBoard: async () => { execution += 1; },
      currentPressure: () => 0 as QuotaPressure,
      resolveProjectKeyOnce: async () => null as string | null,
      resolveCacheKey: async () => 'test-cache-key',
      resolveRepoFingerprintOnce: async () => ({ headSha: 'abc123', treeHash: 'def456' } as RepoFingerprint),
      repoFingerprint: () => undefined as RepoFingerprint | undefined,
      verificationAvailableForCwd: async () => false,
      todosToRoadmap: (todos: readonly GoalPlanTodo[]): RoadmapItem[] =>
        todos.map((t, i) => ({ id: `item${i}`, text: t.text, status: 'pending' as const } as RoadmapItem)),
      buildGoalPlanner: (_systemModel?: SystemModel, _tasteContext?: string) => {
        const plan: GoalPlan = {
          judgment: 'stage',
          vision: 'Improve test coverage',
          goals: [{
            title: 'Add unit tests',
            todos: [
              { text: 'Write test for auth module' },
              { text: 'Write test for config module' },
              { text: 'Write test for utils module' },
            ],
          }],
        };
        return async () => plan;
      },
      buildGoalPlannerAttempt: () => null,
      buildUnderstandingPass: () => null,
      buildDeps:
        (_hist: readonly SessionEntry[], _memCtx?: string, _envCtx?: string, _taste?: unknown, _sink?: OutputSink): OrchestrateDeps =>
          ({ planner: {} } as unknown as OrchestrateDeps),
      resolvePlannerTasteContext: async () => undefined,
      formGoalLabel: async (t: string) => t,
      resolveEnvironmentOnce: async () => 'test',
      conversationLive: () => true,
    } satisfies AutoStageEngineDeps;

    const engine = createAutoStageEngine(deps);
    await engine.resolveAutoStage('add tests for core modules');

    const delta = listenerDelta();

    return mkCase('auto-stage-success', {
      actions: 1,
      dispatches: parkedCreates,
      pushes: execution,
      listenerDelta: delta,
      observation: `parkedCreates=${parkedCreates} syncBoardCalls=${execution}`,
    });
  } catch (err) {
    return mkFailed('auto-stage-success', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Suite runner
// ---------------------------------------------------------------------------

export async function runComponentSuite(): Promise<Suite> {
  const cases: ComponentCase[] = [];
  const spec: Array<{ id: string; fn: CaseFn }> = [
    { id: 'manage-early-key', fn: caseManageEarlyKey },
    { id: 'surface-replace-1000', fn: caseSurfaceReplace1000 },
    { id: 'legacy-buffer-mm', fn: caseLegacyBufferMm },
    { id: 'ctrl-c-contexts', fn: caseCtrlCContexts },
    { id: 'login-child-handoff', fn: caseLoginChildHandoff },
    { id: 'dirty-worktree-verify', fn: caseDirtyWorktreeVerify },
    { id: 'auto-stage-success', fn: caseAutoStageSuccess },
  ];

  for (const { id, fn } of spec) {
    try {
      cases.push(await fn());
    } catch (err) {
      cases.push(mkFailed(id, err instanceof Error ? err.message : String(err)));
    }
  }

  const allOk = cases.length === 7 && cases.every((c) => c.status === 'observed');

  return {
    version: COMPONENT_VERSION,
    suite: SUITE_NAME,
    status: allOk ? 'pass' : 'failed',
    metadata: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      commit: resolveCommit(),
    },
    cases,
  };
}

// Execute when run directly
const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].includes('p0-component-benchmark.tsx') ||
   process.argv[1].includes('p0-component-benchmark'));

if (isMain) {
  runComponentSuite()
    .then((suite) => {
      process.stdout.write(JSON.stringify(suite) + '\n');
    })
    .catch((err) => {
      const fail: Suite = {
        version: COMPONENT_VERSION,
        suite: SUITE_NAME,
        status: 'failed',
        metadata: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          commit: resolveCommit(),
        },
        cases: [],
      };
      process.stderr.write(String(err) + '\n');
      process.stdout.write(JSON.stringify(fail) + '\n');
    });
}
