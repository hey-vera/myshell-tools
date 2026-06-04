/**
 * Unit tests for src/providers/codex.ts — the execa-backed Codex adapter.
 *
 * Focus: a wall-clock timeout must be classified as the recoverable `timeout`
 * category before execa's cancellation flag can turn it into a generic cancel.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexProvider } from '../../src/providers/codex.ts';
import type { ProviderEvent, ProviderRequest } from '../../src/providers/port.ts';

const STUB_SOURCE = `#!/usr/bin/env node
setTimeout(() => { process.exit(0); }, 10000);
`;

let dir: string;
let stubPath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-adapter-'));
  stubPath = join(dir, 'sleeper.mjs');
  await writeFile(stubPath, STUB_SOURCE, { mode: 0o755 });
});

after(async () => {
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
