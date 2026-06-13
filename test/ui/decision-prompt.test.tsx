import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

import { App, createInkAppBridge } from '../../src/interface/ui/App.js';
import { createInkOutputSink, createInkStore } from '../../src/interface/ui/mount.js';
import { makeConfirm } from '../../src/interface/menu-key-confirm.js';
import { renderDecisionPrompt } from '../../src/interface/decision-prompt.js';

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('decision prompt block is visible before input and Ink single-key confirm still resolves', async () => {
  const bridge = createInkAppBridge();
  const app = render(<App bridge={bridge} color={false} isTty={true} columns={80} />);
  try {
    await tick();

    const store = createInkStore(bridge);
    const out = createInkOutputSink(store, { color: false, isTty: true });

    out.write(renderDecisionPrompt(
      {
        kind: 'keep-going',
        title: 'Keep going?',
        message: 'I can keep working on this autonomously until it\'s done.',
        options: [
          { id: 'yes', label: 'Yes', description: 'continue working until it\'s done', recommended: true },
          { id: 'no', label: 'No', description: 'stop here and wait' },
        ],
        defaultOptionId: 'yes',
      },
      out.color,
    ));
    await tick();

    const beforeInput = app.lastFrame() ?? '';
    assert.match(beforeInput, /Keep Going: Keep going\?/);
    assert.match(beforeInput, /1\. Yes/);
    assert.match(beforeInput, /2\. No/);
    assert.match(beforeInput, /Enter = 1 · y = yes · n = no · Ctrl\+C = cancel/);

    const confirm = makeConfirm(out, () => new Promise<string | null>(() => {}), undefined, false, () =>
      bridge.readKey(),
    );
    const verdict = confirm(true);
    await tick();
    app.stdin.write('y');
    await tick();
    assert.equal(await verdict, true);
  } finally {
    app.unmount();
  }
});
