/**
 * test/ui/app.test.tsx — Ink component tests for the Step-1 skeleton.
 *
 * Runs under `npm run test:ui` (tsx + ink-testing-library), NOT the strip-types
 * `npm test` suite — JSX is transpiled by tsx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App, createInkAppBridge } from '../../src/interface/ui/App.js';

test('idle <App> renders the input caret', () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} />);
  assert.ok(lastFrame()?.includes('❯'), `expected caret in frame, got:\n${lastFrame()}`);
});

test('committed lines appear in the transcript', async () => {
  const bridge = createInkAppBridge();
  const { lastFrame } = render(<App bridge={bridge} />);
  bridge.commit('hello from the sink');
  // Allow Ink to flush a render tick.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    lastFrame()?.includes('hello from the sink'),
    `expected committed line in frame, got:\n${lastFrame()}`,
  );
});
