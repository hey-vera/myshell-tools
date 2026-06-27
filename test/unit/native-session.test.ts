/**
 * test/unit/native-session.test.ts — unit tests for the pure native-session planner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planNativeSession } from '../../src/core/native-session.ts';
import type { NativeSessionPlan } from '../../src/core/native-session.ts';
import type { SessionEntry } from '../../src/core/types.ts';

const userTurn: SessionEntry = { timestamp: '2026-05-31T00:00:00.000Z', role: 'user', content: 'hi' };
const claudeTurn: SessionEntry = {
  timestamp: '2026-05-31T00:00:01.000Z',
  role: 'assistant',
  content: 'hello',
  provider: 'claude',
};
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

  it('after a prior Claude turn, plans to RESUME Claude (resume=true)', () => {
    const plans = planNativeSession({ enabled: true, conversationId: 'conv-1', history: [userTurn, claudeTurn] });
    assert.strictEqual(planFor(plans, 'claude')?.resume, true);
  });

  it('does NOT plan Codex when no prior Codex thread id was captured', () => {
    const plans = planNativeSession({ enabled: true, conversationId: 'conv-1', history: [userTurn, codexTurn()] });
    assert.strictEqual(planFor(plans, 'codex'), undefined, 'no captured thread id → no codex plan');
  });

  it('plans to RESUME Codex using the most recent captured thread id', () => {
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

  it('a Claude plan is always present when enabled; Codex only when a thread id exists', () => {
    const plans = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [claudeTurn, codexTurn('t-1')],
    });
    assert.ok(planFor(plans, 'claude') !== undefined);
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
});
