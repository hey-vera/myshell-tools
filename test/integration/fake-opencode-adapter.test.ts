import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProviderEvent } from '../../src/providers/port.ts';
const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'dist/providers/opencode.js');
const fixture = join(root, 'test/fixtures/fake-opencode-cli.mjs');
async function withScenario<T>(scenario: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.MYSHELL_FAKE_SCENARIO;
  process.env.MYSHELL_FAKE_SCENARIO = scenario;
  try { return await fn(); } finally { if (prior === undefined) delete process.env.MYSHELL_FAKE_SCENARIO; else process.env.MYSHELL_FAKE_SCENARIO = prior; }
}
describe('built OpenCode JSON adapter', () => it('parses a deterministic JSON-format child without login', async () => {
  assert.ok(existsSync(dist), 'run npm run build first');
  const { createOpencodeProvider } = await import('../../dist/providers/opencode.js');
  const events: ProviderEvent[] = [];
  for await (const e of createOpencodeProvider({ bin: process.execPath, binArgs: [fixture] }).run({ model: 'opencode-go/test', prompt: 'synthetic', cwd: root, sandbox: 'read-only', timeoutMs: 5000 }, new AbortController().signal)) events.push(e);
  assert.deepEqual(events.map(e => e.type), ['text', 'usage', 'done']);
  assert.equal(events[2].text, 'hello v1');
}));
it('returns one typed auth error for stderr plus nonzero exit, never done', async () => {
  const { createOpencodeProvider } = await import('../../dist/providers/opencode.js');
  const events: ProviderEvent[] = [];
  await withScenario('error', async () => { for await (const e of createOpencodeProvider({ bin: process.execPath, binArgs: [fixture] }).run({ model: 'opencode-go/test', prompt: 'synthetic', cwd: root, sandbox: 'read-only', timeoutMs: 5000 }, new AbortController().signal)) events.push(e); });
  assert.deepEqual(events.map(e => e.type), ['error']);
  assert.equal((events[0] as Extract<ProviderEvent, { type: 'error' }>).error.category, 'auth');
});
