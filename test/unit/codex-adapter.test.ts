/**
 * Unit tests for src/providers/codex.ts — the execa-backed Codex adapter.
 *
 * Focus: a wall-clock timeout must be classified as the recoverable `timeout`
 * category before execa's cancellation flag can turn it into a generic cancel.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexProvider } from '../../src/providers/codex.ts';
import type { ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const STUB_SOURCE = `#!/usr/bin/env node
setTimeout(() => { process.exit(0); }, 10000);
`;
const NO_PARSEABLE_OUTPUT_SOURCE = `#!/usr/bin/env node
console.log('noise, not json');
process.exit(0);
`;
const TERMINAL_THEN_EXTRA_SOURCE = `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'late' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } }));
process.exit(0);
`;

let dir: string;
let stubPath: string;
let noParseableOutputStubPath: string;
let terminalThenExtraStubPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-adapter-'));
  stubPath = join(dir, 'sleeper.mjs');
  noParseableOutputStubPath = join(dir, 'no-parseable-output.mjs');
  terminalThenExtraStubPath = join(dir, 'terminal-then-extra.mjs');
  await writeFile(stubPath, STUB_SOURCE, { mode: 0o755 });
  await writeFile(noParseableOutputStubPath, NO_PARSEABLE_OUTPUT_SOURCE, { mode: 0o755 });
  await writeFile(terminalThenExtraStubPath, TERMINAL_THEN_EXTRA_SOURCE, { mode: 0o755 });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRequest(timeoutMs: number): ProviderRequest {
  return {
    model: 'gpt-5-codex',
    prompt: 'hello',
    cwd: process.cwd(),
    sandbox: 'workspace-write',
    timeoutMs,
  };
}

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('codex adapter — timeout classification', () => {
  it('classifies a wall-clock timeout as category "timeout" (not "unknown" or cancel)', async () => {
    const provider = createCodexProvider({ bin: stubPath });
    const events = await collect(provider.run(makeRequest(300), new AbortController().signal));

    const errorEv = events.find((e) => e.type === 'error');
    assert.ok(errorEv !== undefined, 'expected a terminal error event on timeout');
    if (errorEv.type === 'error') {
      assert.equal(errorEv.error.category, 'timeout');
      assert.equal(errorEv.error.recoverable, true);
      assert.match(errorEv.error.message, /limit before the model finished/i);
      assert.doesNotMatch(errorEv.error.message, /unexpected error/i);
    }
  });
});

describe('codex adapter — terminal contract', () => {
  it('emits an unknown error when the CLI exits 0 without parseable terminal output', async () => {
    const provider = createCodexProvider({ bin: noParseableOutputStubPath });
    const events = await collect(provider.run(makeRequest(5000), new AbortController().signal));

    assert.equal(events.length, 1);
    const errorEv = events[0];
    assert.ok(errorEv !== undefined && errorEv.type === 'error');
    if (errorEv.type === 'error') {
      assert.equal(errorEv.error.category, 'unknown');
      assert.equal(errorEv.error.message, 'codex produced no parseable output.');
    }
  });

  it('does not yield events after the first terminal event', async () => {
    const provider = createCodexProvider({ bin: terminalThenExtraStubPath });
    const events = await collect(provider.run(makeRequest(5000), new AbortController().signal));

    assert.deepEqual(events.map((e) => e.type), ['text', 'usage', 'done']);
    const doneEvents = events.filter((e) => e.type === 'done');
    const terminalEvents = events.filter((e) => e.type === 'done' || e.type === 'error');
    assert.equal(doneEvents.length, 1);
    assert.equal(terminalEvents.length, 1);
    const done = doneEvents[0];
    assert.ok(done !== undefined && done.type === 'done');
    if (done.type === 'done') {
      assert.equal(done.text, 'first');
    }
  });
});
