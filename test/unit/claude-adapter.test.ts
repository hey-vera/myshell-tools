/**
 * Unit tests for src/providers/claude.ts — the execa-backed Claude adapter.
 *
 * Focus: a wall-clock TIMEOUT must be classified as the recoverable `timeout`
 * category (errors.ts), NOT fall through to `unknown` ("An unexpected error
 * occurred."). At HEAD a timeout SIGKILLs the child before the Claude CLI emits
 * its terminal `result` line, so claude-parse produces no terminal event; the
 * adapter then inspected stderr (empty) → `unknown`. We now key off execa's
 * `result.timedOut === true` and emit a clear `timeout` error.
 *
 * Hermetic + quota-free: we override the binary with a tiny Node script that
 * sleeps far past a short timeout and never prints anything. No network, no real
 * `claude`. The adapter appends its own argv (`-p …`) which the stub ignores.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeProvider } from '../../src/providers/claude.ts';
import type { ProviderRequest, ProviderEvent } from '../../src/providers/port.ts';

// A cross-platform stub "binary": a Node script that ignores its args, emits
// nothing, and sleeps for 10s — guaranteeing it outlives a short timeout so the
// adapter must take the timed-out-kill path.
const STUB_SOURCE = `#!/usr/bin/env node
setTimeout(() => { process.exit(0); }, 10000);
`;
const NO_PARSEABLE_OUTPUT_SOURCE = `#!/usr/bin/env node
console.log('noise, not json');
process.exit(0);
`;
const TERMINAL_THEN_EXTRA_SOURCE = `#!/usr/bin/env node
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'first',
  usage: { input_tokens: 1, output_tokens: 2 }
}));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } }));
console.log(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'second',
  usage: { input_tokens: 3, output_tokens: 4 }
}));
process.exit(0);
`;

let dir: string;
let stubPath: string;
let noParseableOutputStubPath: string;
let terminalThenExtraStubPath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-adapter-'));
  stubPath = join(dir, 'sleeper.mjs');
  noParseableOutputStubPath = join(dir, 'no-parseable-output.mjs');
  terminalThenExtraStubPath = join(dir, 'terminal-then-extra.mjs');
  await writeFile(stubPath, STUB_SOURCE, { mode: 0o755 });
  await writeFile(noParseableOutputStubPath, NO_PARSEABLE_OUTPUT_SOURCE, { mode: 0o755 });
  await writeFile(terminalThenExtraStubPath, TERMINAL_THEN_EXTRA_SOURCE, { mode: 0o755 });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRequest(timeoutMs: number): ProviderRequest {
  return {
    model: 'claude-sonnet-4-6',
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

describe('claude adapter — timeout classification', () => {
  it('classifies a wall-clock timeout as category "timeout" (not "unknown")', async () => {
    // Run `node <stub>` so we control a real timed-out child. We point the
    // adapter's bin at node itself and rely on it appending the script path?
    // No — the adapter appends Claude flags, not the script. Instead we make the
    // stub the executable directly (chmod +x with a node shebang).
    const provider = createClaudeProvider({ bin: stubPath });

    // 300ms timeout; the stub sleeps 10s → guaranteed SIGKILL via execa timeout.
    const events = await collect(provider.run(makeRequest(300), new AbortController().signal));

    const errorEv = events.find((e) => e.type === 'error');
    assert.ok(errorEv !== undefined, 'expected a terminal error event on timeout');
    if (errorEv.type === 'error') {
      assert.equal(
        errorEv.error.category,
        'timeout',
        `expected category "timeout" but got "${errorEv.error.category}"`,
      );
      // Recoverable per errors.ts descriptor.
      assert.equal(errorEv.error.recoverable, true);
      // Honest, specific message naming the limit — not the generic
      // "An unexpected error occurred." unknown message.
      assert.match(errorEv.error.message, /limit before the model finished/i);
      assert.doesNotMatch(errorEv.error.message, /unexpected error/i);
    }
  });

  it('reports the configured timeout (in seconds) in the message', async () => {
    const provider = createClaudeProvider({ bin: stubPath });
    const events = await collect(provider.run(makeRequest(2000), new AbortController().signal));
    const errorEv = events.find((e) => e.type === 'error');
    assert.ok(errorEv !== undefined && errorEv.type === 'error');
    if (errorEv.type === 'error') {
      // 2000ms → "2-second limit"
      assert.match(errorEv.error.message, /2-second limit/);
    }
  });
});

describe('claude adapter — terminal contract', () => {
  it('emits an unknown error when the CLI exits 0 without parseable terminal output', async () => {
    const provider = createClaudeProvider({ bin: noParseableOutputStubPath });
    const events = await collect(provider.run(makeRequest(5000), new AbortController().signal));

    assert.equal(events.length, 1);
    const errorEv = events[0];
    assert.ok(errorEv !== undefined && errorEv.type === 'error');
    if (errorEv.type === 'error') {
      assert.equal(errorEv.error.category, 'unknown');
      assert.equal(errorEv.error.message, 'claude produced no parseable output.');
    }
  });

  it('does not yield events after the first terminal event', async () => {
    const provider = createClaudeProvider({ bin: terminalThenExtraStubPath });
    const events = await collect(provider.run(makeRequest(5000), new AbortController().signal));

    assert.deepEqual(events.map((e) => e.type), ['usage', 'done']);
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

describe('claude adapter — fan-out safety rail', () => {
  it('every claude -p invocation carries --max-budget-usd', async () => {
    // buildClaudeArgs is the pure flag builder; assert the runaway cap is present.
    const { buildClaudeArgs, CLAUDE_MAX_BUDGET_USD } = await import('../../src/providers/claude.ts');
    const args = buildClaudeArgs(makeRequest(120000));
    const idx = args.indexOf('--max-budget-usd');
    assert.ok(idx >= 0, 'expected --max-budget-usd flag on every claude -p run');
    assert.equal(args[idx + 1], String(CLAUDE_MAX_BUDGET_USD));
  });
});
