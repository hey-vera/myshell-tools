/**
 * test/unit/native-session.test.ts — unit tests for the pure native-session planner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planNativeSession } from '../../src/core/native-session.ts';
import type { SessionEntry } from '../../src/core/types.ts';

const userTurn: SessionEntry = { timestamp: '2026-05-31T00:00:00.000Z', role: 'user', content: 'hi' };
const claudeTurn: SessionEntry = {
  timestamp: '2026-05-31T00:00:01.000Z',
  role: 'assistant',
  content: 'hello',
  provider: 'claude',
};
const codexTurn: SessionEntry = {
  timestamp: '2026-05-31T00:00:02.000Z',
  role: 'assistant',
  content: 'hello',
  provider: 'codex',
};

describe('planNativeSession', () => {
  it('returns null when the feature is disabled', () => {
    assert.strictEqual(
      planNativeSession({ enabled: false, conversationId: 'abc', history: [] }),
      null,
    );
  });

  it('returns null when there is no conversation id (e.g. one-shot run)', () => {
    assert.strictEqual(
      planNativeSession({ enabled: true, conversationId: '', history: [] }),
      null,
    );
  });

  it('on a fresh conversation, plans to ESTABLISH a Claude session (resume=false)', () => {
    const plan = planNativeSession({ enabled: true, conversationId: 'conv-1', history: [userTurn] });
    assert.ok(plan !== null);
    assert.strictEqual(plan.provider, 'claude');
    assert.strictEqual(plan.sessionId, 'conv-1');
    assert.strictEqual(plan.resume, false);
  });

  it('after a prior Claude turn, plans to RESUME (resume=true)', () => {
    const plan = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, claudeTurn],
    });
    assert.ok(plan !== null);
    assert.strictEqual(plan.resume, true);
  });

  it('a prior turn from a DIFFERENT provider does not count as an established Claude session', () => {
    const plan = planNativeSession({
      enabled: true,
      conversationId: 'conv-1',
      history: [userTurn, codexTurn],
    });
    assert.ok(plan !== null);
    assert.strictEqual(plan.resume, false, 'codex turns must not mark the Claude session started');
  });

  it('uses the conversation id verbatim as the session id', () => {
    const plan = planNativeSession({ enabled: true, conversationId: 'uuid-xyz', history: [] });
    assert.strictEqual(plan?.sessionId, 'uuid-xyz');
  });
});
