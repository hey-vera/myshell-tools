import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { kill } from 'node:process';

const root = resolve(import.meta.dirname, '../..');
const fixture = join(root, 'test', 'fixtures', 'fake-provider-cli.mjs');
const distAdapter = join(root, 'dist', 'providers', 'codex.js');
let tempDir = '';
let fakeBin = '';
let fakeBinArgs: readonly string[] = [];

function request() {
  return {
    model: 'gpt-5',
    prompt: 'synthetic prompt only',
    cwd: root,
    sandbox: 'read-only' as const,
    timeoutMs: 5_000,
  };
}

async function collect(provider: { run: (req: ReturnType<typeof request>, signal: AbortSignal) => AsyncIterable<unknown> }, signal: AbortSignal) {
  const events: unknown[] = [];
  for await (const event of provider.run(request(), signal)) events.push(event);
  return events;
}

function withScenario<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.MYSHELL_FAKE_SCENARIO;
  process.env.MYSHELL_FAKE_SCENARIO = name;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.MYSHELL_FAKE_SCENARIO;
    else process.env.MYSHELL_FAKE_SCENARIO = prior;
  });
}

describe('built Codex adapter with deterministic fake CLI', () => {
  beforeAll(() => {
    assert.ok(existsSync(distAdapter), 'run npm run build before this built-artifact integration test');
    tempDir = mkdtempSync(join(tmpdir(), 'myshell-fake-codex-'));
    fakeBin = process.execPath;
    fakeBinArgs = [fixture];
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('streams session, partial text, tool, and terminal events through the built adapter', async () => {
    const { createCodexProvider } = await import('../../dist/providers/codex.js');
    const events = await withScenario('happy', () => collect(createCodexProvider({ bin: fakeBin, binArgs: fakeBinArgs }), new AbortController().signal));
    assert.deepEqual(events.map((event: any) => event.type), ['text', 'tool', 'text', 'usage', 'done']);
    assert.equal((events[0] as any).delta, 'partial ');
    assert.equal((events[1] as any).detail, 'fake tool finished');
    assert.equal((events[4] as any).text, 'partial answer');
    assert.equal((events[4] as any).sessionId, 'fake-thread-001');
  });

  it('converts stderr plus a nonzero child exit into one error and never a done event', async () => {
    const { createCodexProvider } = await import('../../dist/providers/codex.js');
    const events = await withScenario('error', () => collect(createCodexProvider({ bin: fakeBin, binArgs: fakeBinArgs }), new AbortController().signal));
    assert.deepEqual(events.map((event: any) => event.type), ['error']);
    assert.equal((events[0] as any).error.category, 'auth');
  });

  it('cancels the real child, records its sentinel, and emits no post-cancel success', async () => {
    const { createCodexProvider } = await import('../../dist/providers/codex.js');
    const sentinel = join(tempDir, 'cancelled.txt');
    const prior = process.env.MYSHELL_FAKE_SENTINEL;
    process.env.MYSHELL_FAKE_SENTINEL = sentinel;
    const controller = new AbortController();
    const pending = withScenario('cancel', () => collect(createCodexProvider({ bin: fakeBin, binArgs: fakeBinArgs }), controller.signal));
    const started = Date.now();
    while (!existsSync(sentinel) && Date.now() - started < 2_000) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(sentinel), 'fake child must publish its PID before abort');
    controller.abort();
    const events = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cancellation did not settle')), 5_000))]);
    if (prior === undefined) delete process.env.MYSHELL_FAKE_SENTINEL;
    else process.env.MYSHELL_FAKE_SENTINEL = prior;
    const pid = Number(readFileSync(sentinel, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, 'sentinel must contain fake child PID');
    assert.throws(() => kill(pid, 0), 'fake child PID must not survive cancellation');
    assert.ok(events.some((event: any) => event.type === 'error'));
    assert.ok(!events.some((event: any) => event.type === 'done'));
  });
});
