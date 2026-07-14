import { afterAll, beforeAll, describe, it } from 'vitest';
import assert from 'node:assert/strict';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { kill } from 'node:process';

const root = resolve(import.meta.dirname, '../..');
const fixture = join(root, 'test', 'fixtures', 'fake-grok-cli.mjs');
const distAdapter = join(root, 'dist', 'providers', 'grok.js');
let tempDir = '';
let fakeBin = '';
let fakeBinArgs: readonly string[] = [];

function request(timeoutMs = 5_000) {
  return {
    model: 'grok-build',
    prompt: 'synthetic prompt only',
    cwd: root,
    sandbox: 'read-only' as const,
    timeoutMs,
  };
}

async function collect(
  provider: {
    run: (req: ReturnType<typeof request>, signal: AbortSignal) => AsyncIterable<unknown>;
  },
  signal: AbortSignal,
) {
  const events: unknown[] = [];
  for await (const event of provider.run(request(), signal)) events.push(event);
  return events;
}

async function collectWithTimeout(
  provider: {
    run: (req: ReturnType<typeof request>, signal: AbortSignal) => AsyncIterable<unknown>;
  },
  timeoutMs: number,
) {
  const events: unknown[] = [];
  for await (const event of provider.run(request(timeoutMs), new AbortController().signal)) {
    events.push(event);
  }
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

describe('built Grok adapter with deterministic fake CLI', () => {
  beforeAll(() => {
    assert.ok(
      existsSync(distAdapter),
      'run npm run build before this built-artifact integration test',
    );
    tempDir = mkdtempSync(join(tmpdir(), 'myshell-fake-grok-'));
    fakeBin = process.execPath;
    fakeBinArgs = [fixture];
  });

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('streams thought, text, and terminal done through the built adapter', async () => {
    const { createGrokProvider } = await import('../../dist/providers/grok.js');
    const events = await withScenario('happy', () =>
      collect(createGrokProvider({ bin: fakeBin, binArgs: fakeBinArgs }), new AbortController().signal),
    );
    assert.deepEqual(
      events.map((event: any) => event.type),
      ['reasoning', 'text', 'done'],
    );
    assert.equal((events[1] as any).delta, 'hello v1');
    assert.equal((events[2] as any).text, 'hello v1');
    assert.equal((events[2] as any).sessionId, 'fake-grok-session-001');
  });

  it('converts stderr plus a nonzero child exit into one error and never a done event', async () => {
    const { createGrokProvider } = await import('../../dist/providers/grok.js');
    const events = await withScenario('error', () =>
      collect(createGrokProvider({ bin: fakeBin, binArgs: fakeBinArgs }), new AbortController().signal),
    );
    assert.deepEqual(
      events.map((event: any) => event.type),
      ['error'],
    );
    assert.equal((events[0] as any).error.category, 'auth');
  });

  it('reports one typed timeout and never a done when the real child produces no terminal output', async () => {
    const { createGrokProvider } = await import('../../dist/providers/grok.js');
    const sentinel = join(tempDir, 'timeout.txt');
    const prior = process.env.MYSHELL_FAKE_SENTINEL;
    process.env.MYSHELL_FAKE_SENTINEL = sentinel;
    let pid: number | undefined;
    try {
      const pending = withScenario('timeout', () =>
        collectWithTimeout(createGrokProvider({ bin: fakeBin, binArgs: fakeBinArgs }), 200),
      );
      const started = Date.now();
      while (!existsSync(sentinel) && Date.now() - started < 2_000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(existsSync(sentinel), 'fake timeout child must publish its PID before timeout');
      pid = Number(readFileSync(sentinel, 'utf8'));
      const events = await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout did not settle')), 5_000),
        ),
      ]);
      assert.deepEqual(
        events.map((event: any) => event.type),
        ['error'],
      );
      assert.equal((events[0] as any).error.category, 'timeout');
      assert.ok(!events.some((event: any) => event.type === 'done'));
      assert.throws(() => kill(pid!, 0), 'fake timeout child PID must not survive timeout');
    } finally {
      if (prior === undefined) delete process.env.MYSHELL_FAKE_SENTINEL;
      else process.env.MYSHELL_FAKE_SENTINEL = prior;
      if (pid !== undefined) {
        try {
          kill(pid, 'SIGKILL');
        } catch {
          /* already terminated */
        }
      }
    }
  });

  it('cancels the real child, records its sentinel, and emits no post-cancel success', async () => {
    const { createGrokProvider } = await import('../../dist/providers/grok.js');
    const sentinel = join(tempDir, 'cancelled.txt');
    const prior = process.env.MYSHELL_FAKE_SENTINEL;
    process.env.MYSHELL_FAKE_SENTINEL = sentinel;
    const controller = new AbortController();
    const pending = withScenario('cancel', () =>
      collect(createGrokProvider({ bin: fakeBin, binArgs: fakeBinArgs }), controller.signal),
    );
    const started = Date.now();
    while (!existsSync(sentinel) && Date.now() - started < 2_000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(existsSync(sentinel), 'fake child must publish its PID before abort');
    controller.abort();
    const events = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cancellation did not settle')), 5_000),
      ),
    ]);
    if (prior === undefined) delete process.env.MYSHELL_FAKE_SENTINEL;
    else process.env.MYSHELL_FAKE_SENTINEL = prior;
    const pid = Number(readFileSync(sentinel, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, 'sentinel must contain fake child PID');
    assert.throws(() => kill(pid, 0), 'fake child PID must not survive cancellation');
    assert.ok(events.some((event: any) => event.type === 'error'));
    assert.ok(!events.some((event: any) => event.type === 'done'));
  });
});
