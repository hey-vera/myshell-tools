import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildNativeSessionTelemetry,
  renderNativeSessionTelemetry,
  type NativeSessionTelemetry,
} from '../../src/core/native-session-telemetry.ts';
import type { NativeSessionPlan } from '../../src/core/native-session.ts';
import type { Usage } from '../../src/providers/port.js';

function plan(over: Partial<NativeSessionPlan> = {}): NativeSessionPlan {
  return {
    provider: 'claude',
    sessionId: 'conv-xyz',
    resume: true,
    ...over,
  };
}

function usage(over: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 500,
    outputTokens: 200,
    cachedInputTokens: 300,
    ...over,
  };
}

describe('buildNativeSessionTelemetry', () => {
  it('estimates omitted history tokens on resumed native path', () => {
    const historyContext = 'CONVERSATION SO FAR\nuser: fix a bug\nassistant: ok\nuser: also refactor';
    const sample = buildNativeSessionTelemetry({
      provider: 'claude',
      nativePlan: plan(),
      useNative: true,
      historyContext,
      usage: usage(),
    });

    assert.ok(sample !== undefined);
    assert.equal(sample!.usedNative, true);
    assert.equal(sample!.resume, true);
    assert.equal(sample!.provider, 'claude');
    assert.equal(sample!.sessionId, 'conv-xyz');
    assert.equal(sample!.historyReplayEstimatedTokens, Math.floor(historyContext.length / 4));
    assert.equal(sample!.inputTokenDropVsColdEstimate, sample!.historyReplayEstimatedTokens);
  });

  it('records actual input and cache reads', () => {
    const sample = buildNativeSessionTelemetry({
      provider: 'claude',
      nativePlan: plan(),
      useNative: true,
      historyContext: 'some history',
      usage: usage({ inputTokens: 400, cachedInputTokens: 350, outputTokens: 150 }),
    });

    assert.ok(sample !== undefined);
    assert.equal(sample!.actualInputTokens, 400);
    assert.equal(sample!.cachedInputTokens, 350);
    assert.equal(sample!.cacheWriteInputTokens, undefined);
  });

  it('records cacheWriteInputTokens when present', () => {
    const sample = buildNativeSessionTelemetry({
      provider: 'claude',
      nativePlan: plan(),
      useNative: true,
      historyContext: 'history',
      usage: usage({ cacheWriteInputTokens: 100 }),
    });

    assert.equal(sample!.cacheWriteInputTokens, 100);
  });

  it('renderNativeSessionTelemetry reports resumed provider session and token drop estimate', () => {
    const sample: NativeSessionTelemetry = {
      provider: 'claude',
      sessionId: 'conv-xyz',
      resume: true,
      usedNative: true,
      historyReplayEstimatedTokens: 350,
      actualInputTokens: 400,
      cachedInputTokens: 300,
      inputTokenDropVsColdEstimate: 350,
    };

    const rendered = renderNativeSessionTelemetry(sample);
    assert.ok(rendered.includes('Native session: claude'));
    assert.ok(rendered.includes('resumed'));
    assert.ok(rendered.includes('saved ~350 tokens vs cold replay'));
    assert.ok(rendered.includes('(300 cache reads)'));
  });

  it('fallback telemetry records provider mismatch without claiming savings', () => {
    const sample = buildNativeSessionTelemetry({
      provider: 'claude',
      nativePlan: plan({ provider: 'codex' }),
      useNative: false,
      historyContext: 'some history',
      usage: usage(),
      fallbackReason: 'provider-mismatch',
    });

    assert.ok(sample !== undefined);
    assert.equal(sample!.usedNative, false);
    assert.equal(sample!.fallbackReason, 'provider-mismatch');
    assert.equal(sample!.inputTokenDropVsColdEstimate, 0);

    const rendered = renderNativeSessionTelemetry(sample);
    assert.ok(rendered.includes('fallback: provider-mismatch'));
  });

  it('returns undefined when no plan and no fallback reason', () => {
    const sample = buildNativeSessionTelemetry({
      provider: 'claude',
      nativePlan: undefined,
      useNative: false,
      historyContext: 'history',
      usage: usage(),
    });
    assert.equal(sample, undefined);
  });
});
