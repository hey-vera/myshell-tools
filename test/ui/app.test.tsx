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
import { App, ErrorBoundary, createInkAppBridge } from '../../src/interface/ui/App.js';

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

// ---------------------------------------------------------------------------
// item 4 — ErrorBoundary: a render throw must NOT crash the UI uncaught; it
// renders a concise fallback line AND runs the unmount-path teardown (onError)
// so stdin isn't left in raw mode and no pending read hangs.
// ---------------------------------------------------------------------------

function Boom(): React.ReactElement {
  throw new Error('reducer/view exploded');
}

test('ErrorBoundary renders a fallback line and runs teardown on a child throw', () => {
  let tornDown: Error | null = null;
  const { lastFrame } = render(
    <ErrorBoundary color={false} onError={(e) => { tornDown = e; }}>
      <Boom />
    </ErrorBoundary>,
  );
  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('[error]'), `expected a fallback [error] line, got:\n${frame}`);
  assert.ok(frame.includes('reducer/view exploded'), `expected the error message, got:\n${frame}`);
  assert.ok(tornDown !== null, 'onError teardown must run on a caught render throw');
});

test('App body throw: boundary restores cooked mode, resolves pending readKey with ETX, and calls onFatalError', async () => {
  const bridge = createInkAppBridge();
  let cooked = true; // tracks Ink raw-mode: setRawMode(true) → not cooked
  bridge.attachStdinControl({
    setRawMode: (v: boolean) => { cooked = !v; },
    isRawModeSupported: true,
  });
  bridge.stdinControl?.setRawMode(true); // simulate the editor holding raw mode
  assert.equal(cooked, false);

  // A pending single-key read that must be resolved with '\x03' on teardown.
  let resolvedWith: string | null = null;
  bridge._keyResolver = (k: string) => { resolvedWith = k; };

  let fatal: Error | null = null;
  const { lastFrame } = render(
    <App bridge={bridge} color={false} onFatalError={(e) => { fatal = e; }} />,
  );
  await new Promise((r) => setTimeout(r, 20));
  // The InputBox attaches its OWN Ink stdin control on mount (overwriting ours);
  // re-attach the spy so it is the active control when the boundary teardown runs.
  bridge.attachStdinControl({
    setRawMode: (v: boolean) => { cooked = !v; },
    isRawModeSupported: true,
  });
  bridge.stdinControl?.setRawMode(true);
  assert.equal(cooked, false);

  // Push a structured state that makes the App body throw during render: a UiState
  // whose `committed.map` access throws (a corrupt reducer snapshot). The
  // ErrorBoundary must catch it and run App's onBoundaryError teardown.
  const corrupt = {
    get committed(): never { throw new Error('corrupt reducer snapshot'); },
  } as unknown as Parameters<typeof bridge.pushState>[0];
  bridge.pushState(corrupt);
  await new Promise((r) => setTimeout(r, 50));

  const frame = lastFrame() ?? '';
  assert.ok(frame.includes('[error]'), `expected the fallback [error] line, got:\n${frame}`);
  assert.equal(resolvedWith, '\x03', 'pending readKey must be resolved with the ETX sentinel');
  assert.equal(cooked, true, 'cooked mode must be restored on teardown');
  assert.ok(fatal !== null, 'onFatalError (reader.close + unmount delegate) must run');
});
