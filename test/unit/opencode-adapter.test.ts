/**
 * Unit tests for src/providers/opencode.ts — the execa-backed OpenCode adapter.
 *
 * Focus: a wall-clock timeout must be classified as the recoverable `timeout`
 * category before execa's cancellation flag can turn it into a generic cancel.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeProvider } from '../../src/providers/opencode.ts';
import type { ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const STUB_SOURCE = `#!/usr/bin/env node
setTimeout(() => { process.exit(0); }, 10000);
`;
const ERROR_THEN_EXTRA_SOURCE = `#!/usr/bin/env node
console.log(JSON.stringify({
  type: 'error',
  error: { name: 'AuthError', data: { message: 'not authenticated' } }
}));
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: 'late' } }));
process.exit(0);
`;

let dir: string;
let stubPath: string;
let errorThenExtraStubPath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-'));
  stubPath = join(dir, 'sleeper.mjs');
  errorThenExtraStubPath = join(dir, 'error-then-extra.mjs');
  await writeFile(stubPath, STUB_SOURCE, { mode: 0o755 });
  await writeFile(errorThenExtraStubPath, ERROR_THEN_EXTRA_SOURCE, { mode: 0o755 });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRequest(timeoutMs: number): ProviderRequest {
  return {
    model: 'opencode',
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

describe('opencode adapter — timeout classification', () => {
  it('classifies a wall-clock timeout as category "timeout" (not "unknown" or cancel)', async () => {
    const provider = createOpencodeProvider({ bin: stubPath });
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

describe('opencode adapter — terminal contract', () => {
  it('does not yield events after an inline terminal error event', async () => {
    const provider = createOpencodeProvider({ bin: errorThenExtraStubPath });
    const events = await collect(provider.run(makeRequest(5000), new AbortController().signal));

    assert.deepEqual(events.map((e) => e.type), ['error']);
    const errorEvents = events.filter((e) => e.type === 'error');
    const terminalEvents = events.filter((e) => e.type === 'done' || e.type === 'error');
    assert.equal(errorEvents.length, 1);
    assert.equal(terminalEvents.length, 1);
    const error = errorEvents[0];
    assert.ok(error !== undefined && error.type === 'error');
    if (error.type === 'error') {
      assert.equal(error.error.category, 'auth');
    }
  });
});
