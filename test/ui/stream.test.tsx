/**
 * test/ui/stream.test.tsx — Ink component tests for the STEP-3b streaming view
 * (src/interface/ui/Stream.tsx) and the App's structured (reducer-driven)
 * transcript path.
 *
 * Runs under `npm run test:ui` (tsx + ink-testing-library), NOT the strip-types
 * `npm test` suite — JSX is transpiled by tsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Stream, CommittedLine } from '../../src/interface/ui/Stream.js';
import { App, createInkAppBridge } from '../../src/interface/ui/App.js';
import { reduce, initialState, type Action, type UiState } from '../../src/interface/ui/index.js';

function fold(actions: readonly Action[]): UiState {
  return actions.reduce(reduce, initialState);
}

test('<Stream> renders the live buffer headed by the ● marker', () => {
  const { lastFrame } = render(<Stream buffer="Hello there." color={false} />);
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('●'), `expected streaming ● marker, got:\n${frame}`);
  assert.ok(frame.includes('Hello there.'), `expected live prose, got:\n${frame}`);
});

test('<Stream> renders nothing for an empty buffer', () => {
  const { lastFrame } = render(<Stream buffer="" color={false} />);
  // An empty buffer renders no Stream box → frame is empty (or whitespace only).
  assert.equal((lastFrame() ?? '').trim(), '');
});

test('<CommittedLine> shows the line text verbatim (colour is chrome)', () => {
  const { lastFrame } = render(
    <CommittedLine line={{ kind: 'completion', text: '✓ done · 1.5k tokens' }} color={false} />,
  );
  assert.ok((lastFrame() ?? '').includes('✓ done · 1.5k tokens'));
});

test('App structured mode: committed prose + completion + live buffer all visible', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} color={false} rows={24} />);

  // Drive a normal streaming turn through the reducer, then push the snapshot
  // mid-stream (prose still in the live buffer).
  const mid = fold([
    { type: 'tier-start', tier: 'ic', provider: 'claude', model: 'm', attempt: 1, verbosity: 'normal' },
    { type: 'stream/prose', text: 'Streaming answer in progress' },
  ]);
  bridge.pushState(mid);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    (lastFrame() ?? '').includes('Streaming answer in progress'),
    `live buffer should be visible, got:\n${lastFrame()}`,
  );

  // Now finish the turn: the prose commits and the completion line appears.
  const done = [
    { type: 'stream/flush-tier', tier: 'ic', success: true, confidence: 0.9, inputTokens: 1200, outputTokens: 300, durationMs: 100, panelCandidate: false, verbosity: 'normal' },
    { type: 'turn/final', success: true, tier: 'ic', attempts: 1, sessionId: 's', verbosity: 'normal' },
  ] as const;
  bridge.pushState(done.reduce(reduce, mid));
  await new Promise((r) => setTimeout(r, 50));
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('Streaming answer in progress'), `committed prose visible, got:\n${frame}`);
  assert.ok(frame.includes('✓ done'), `completion line visible, got:\n${frame}`);
});
