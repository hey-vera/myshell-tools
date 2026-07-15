/**
 * test/unit/native-session.test.ts — unit tests for the pure native-session planner
 * and R2.2 lineage gate.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  planNativeSession,
  shouldResumeNativeLineage,
  filterNativePlanByLineage,
  modelsCompatibleForNativeResume,
} from '../../src/core/native-session.ts';
import type { NativeSessionPlan, NativeLineageEntry } from '../../src/core/native-session.ts';
import type { SessionEntry } from '../../src/core/types.ts';

const userTurn: SessionEntry = { timestamp: '2026-05-31T00:00:00.000Z', role: 'user', content: 'hi' };
const claudeTurn: SessionEntry = {
  timestamp: '2026-05-31T00:00:01.000Z',
  role: 'assistant',
  content: 'hello',
  provider: 'claude',
  model: 'claude-sonnet',
};
const claudeTurnAccount = (accountId: string, model = 'claude-sonnet'): SessionEntry & { accountId: string } => ({
  timestamp: '2026-05-31T00:00:01.000Z',
  role: 'assistant',
  content: 'hello',
  provider: 'claude',
  model,
  accountId,
});
const codexTurn = (sessionId?: string): SessionEntry => ({
  timestamp: '2026-05-31T00:00:02.000Z',
  role: 'assistant',
  content: 'hi from codex',
  provider: 'codex',
  ...(sessionId !== undefined ? { sessionId } : {}),
});

function planFor(plans: NativeSessionPlan[], provider: string): NativeSessionPlan | undefined {
  return plans.find((p) => p.provider === provider);
}

describe('planNativeSession', () => {
  it('returns [] when the feature is disabled', () => {
    assert.deepEqual(planNativeSession({ enabled: false, conversationId: 'abc', history: [] }), []);
  });

  it('returns [] when there is no conversation id (e.g. one-shot run)', () => {
    assert.deepEqual(planNativeSession({ enabled: true, conversationId: '', history: [] }), []);
  });

  it('on a fresh conversation, plans to ESTABLISH a Claude session (resume=false), using the conv id', () => {
    const plans = planNativeSession({ enabled: true, conversationId: 'conv-1', history: [userTurn] });
    const claude = planFor(plans, 'claude');
    assert.ok(claude !== undefined);
    assert.strictEqual(claude.sessionId, 'conv-1');
    assert.strictEqual(claude.resume, false);
  });

  it('after a prior Claude turn (A→A), plans to RESUME Claude (resume=true)', () => {
    const plans = planNativeSession({ enabled: true, conversationId: 'conv-1', history: [userTurn, claudeTurn] });
    assert.strictEqual(planFor(plans, 'claude')?.resume, true);
  });

  it('does NOT plan Codex when no prior Codex thread id was captured', () => {
    const plans = planNativeSession({ enabled: true, conversationId: 'conv-1', history: [userTurn, codexTurn()] });
    assert.strictEqual(planFor(plans, 'codex'), undefined, 'no captured thread id → no codex plan');
  });

  it('plans to RESUME Codex using the most recent captured thread id in the trailing streak', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, codexTurn('thread-OLD'), userTurn, codexTurn('thread-NEW')],
    });
    const codex = planFor(plans, 'codex');
    assert.ok(codex !== undefined);
    assert.strictEqual(codex.sessionId, 'thread-NEW', 'uses the most recent captured thread id');
    assert.strictEqual(codex.resume, true);
  });

  it('Claude plan present on clean single-provider history; Codex when thread id exists', () => {
    // A→B leaves Claude lineage broken; only Codex may resume.
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [claudeTurn, codexTurn('t-1')],
    });
    assert.strictEqual(planFor(plans, 'claude'), undefined, 'A→B: no Claude resume');
    assert.ok(planFor(plans, 'codex') !== undefined);
  });

  it('promotion does not bypass quarantine — quarantined history blocks native plans', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, claudeTurn],
      historyPolicy: { replayMode: 'quarantine_assistant_prose' },
    });
    assert.deepEqual(plans, []);
  });

  it('A→B→A: does NOT resume native Claude (force history path)', () => {
    // History ends with user after B; planning for next turn that may route to A.
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, claudeTurn, userTurn, codexTurn('t-1'), userTurn],
    });
    assert.strictEqual(
      planFor(plans, 'claude'),
      undefined,
      'intervening codex means Claude native session lacks B context',
    );
    // Trailing assistant-with-provider is still codex → Codex may resume its streak.
    assert.strictEqual(planFor(plans, 'codex')?.sessionId, 't-1');
  });

  it('A→B→A with last assistant codex: no Claude plan, Codex may resume trailing streak', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, claudeTurn, userTurn, codexTurn('t-1')],
    });
    assert.strictEqual(planFor(plans, 'claude'), undefined);
    assert.strictEqual(planFor(plans, 'codex')?.sessionId, 't-1');
  });

  it('after foreign provider only, does not establish Claude native (force history)', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, codexTurn('t-1')],
    });
    assert.strictEqual(planFor(plans, 'claude'), undefined);
  });
});

describe('shouldResumeNativeLineage', () => {
  it('A→A: resume OK for same provider', () => {
    const r = shouldResumeNativeLineage({
      history: [userTurn, claudeTurn],
      provider: 'claude',
    });
    assert.equal(r.resume, true);
  });

  it('A→B→A: no resume for A (provider gap)', () => {
    const r = shouldResumeNativeLineage({
      history: [userTurn, claudeTurn, userTurn, codexTurn('t-1'), userTurn],
      provider: 'claude',
    });
    assert.equal(r.resume, false);
    assert.equal(r.reason, 'provider-gap');
  });

  it('account mismatch when both known: no resume', () => {
    const history: NativeLineageEntry[] = [
      userTurn,
      claudeTurnAccount('acct-1'),
    ];
    const r = shouldResumeNativeLineage({
      history,
      provider: 'claude',
      accountId: 'acct-2',
    });
    assert.equal(r.resume, false);
    assert.equal(r.reason, 'account-mismatch');
  });

  it('account match when both known: resume OK', () => {
    const history: NativeLineageEntry[] = [
      userTurn,
      claudeTurnAccount('acct-1'),
    ];
    const r = shouldResumeNativeLineage({
      history,
      provider: 'claude',
      accountId: 'acct-1',
    });
    assert.equal(r.resume, true);
  });

  it('account unknown on either side: resume OK (fail-open)', () => {
    const r = shouldResumeNativeLineage({
      history: [userTurn, claudeTurn],
      provider: 'claude',
      accountId: 'acct-1',
    });
    assert.equal(r.resume, true);
  });

  it('model incompatibility when both known and differ: no resume', () => {
    const r = shouldResumeNativeLineage({
      history: [userTurn, claudeTurn],
      provider: 'claude',
      model: 'claude-opus',
    });
    assert.equal(r.resume, false);
    assert.equal(r.reason, 'model-incompatible');
  });

  it('same model when both known: resume OK', () => {
    const r = shouldResumeNativeLineage({
      history: [userTurn, claudeTurn],
      provider: 'claude',
      model: 'claude-sonnet',
    });
    assert.equal(r.resume, true);
  });

  it('no prior native for provider: no resume', () => {
    const r = shouldResumeNativeLineage({
      history: [userTurn],
      provider: 'claude',
    });
    assert.equal(r.resume, false);
    assert.equal(r.reason, 'no-prior-native');
  });
});

describe('modelsCompatibleForNativeResume', () => {
  it('unknown either side is compatible', () => {
    assert.equal(modelsCompatibleForNativeResume(undefined, 'x'), true);
    assert.equal(modelsCompatibleForNativeResume('x', undefined), true);
    assert.equal(modelsCompatibleForNativeResume(undefined, undefined), true);
  });

  it('exact match required when both known', () => {
    assert.equal(modelsCompatibleForNativeResume('a', 'a'), true);
    assert.equal(modelsCompatibleForNativeResume('a', 'b'), false);
  });
});

describe('filterNativePlanByLineage', () => {
  it('fail-open when history has no assistant providers', () => {
    const plan: NativeSessionPlan = {
      provider: 'claude',
      sessionId: 'conv-1',
      resume: true,
    };
    const r = filterNativePlanByLineage({ plan, history: [userTurn] });
    assert.deepEqual(r.plan, plan);
  });

  it('withholds resume plan on A→B→A evidence', () => {
    const plan: NativeSessionPlan = {
      provider: 'claude',
      sessionId: 'conv-1',
      resume: true,
    };
    const r = filterNativePlanByLineage({
      plan,
      history: [userTurn, claudeTurn, userTurn, codexTurn('t-1')],
    });
    assert.equal(r.plan, undefined);
    assert.equal(r.withholdReason, 'provider-gap');
  });

  it('keeps resume plan on consecutive A→A', () => {
    const plan: NativeSessionPlan = {
      provider: 'claude',
      sessionId: 'conv-1',
      resume: true,
    };
    const r = filterNativePlanByLineage({
      plan,
      history: [userTurn, claudeTurn],
    });
    assert.deepEqual(r.plan, plan);
  });

  it('withholds on account mismatch defense-in-depth', () => {
    const plan: NativeSessionPlan = {
      provider: 'claude',
      sessionId: 'conv-1',
      resume: true,
    };
    const r = filterNativePlanByLineage({
      plan,
      history: [userTurn, claudeTurnAccount('acct-1')],
      accountId: 'acct-2',
    });
    assert.equal(r.plan, undefined);
    assert.equal(r.withholdReason, 'account-mismatch');
  });
});
