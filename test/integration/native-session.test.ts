/**
 * test/integration/native-session.test.ts — LIVE verification of Claude native
 * session continuity (the EXPERIMENTAL config.nativeSessions feature).
 *
 * This is the honest verification mechanism for the one behavior that cannot be
 * proven by a unit test: that reusing a Claude session id across separate
 * `claude -p` invocations actually carries conversation context server-side
 * (which is what lets myshell-tools skip replaying history). The unit tests
 * prove the planning logic and the arg construction; THIS test proves the live
 * behavior the feature depends on.
 *
 * It is GATED OFF by default — it spawns the real `claude` CLI and consumes
 * real subscription quota, and requires an authenticated Claude. Run it
 * deliberately:
 *
 *   MYSHELL_NATIVE_SESSION_E2E=1 npm run test:integration
 *
 * If it passes, native session continuity works on your setup and you can enable
 * it: Settings → [4] Native sessions, or "nativeSessions": true in config.json.
 * If it fails, the assumption behind the feature does not hold on your CLI
 * version — leave it off and the default history-replay path is used.
 *
 * Honesty Contract: no fabricated data. The test asserts real CLI output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const ENABLED = process.env['MYSHELL_NATIVE_SESSION_E2E'] === '1';

/** A fresh RFC-4122-ish v4 uuid without pulling in a dependency. */
function uuid(): string {
  const h = (n: number): string => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  return `${h(8)}-${h(4)}-4${h(3)}-8${h(3)}-${h(8)}${h(4)}`;
}

/** Run `claude -p` once, delivering the prompt via stdin; resolve with stdout. */
function runClaude(args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited ${code}: ${err}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Run a command, deliver the prompt via stdin; resolve with stdout. */
function runCli(cmd: string, args: string[], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

describe('Claude native session continuity (live, gated)', () => {
  it(
    'a resumed session remembers context from the prior turn',
    { skip: ENABLED ? false : 'set MYSHELL_NATIVE_SESSION_E2E=1 (needs authenticated claude) to run' },
    async () => {
      const sessionId = uuid();
      const model = ['--model', 'haiku'];

      // Turn 1: establish the session with our chosen id and plant a fact.
      await runClaude(
        ['-p', '--model', 'haiku', '--session-id', sessionId],
        'Remember this codeword for later: PINEAPPLE. Reply with just "ok".',
      );

      // Turn 2: resume the SAME session WITHOUT repeating the codeword. If native
      // continuity works, Claude still knows it from turn 1.
      const out = await runClaude(
        ['-p', ...model, '--resume', sessionId],
        'What codeword did I ask you to remember? Reply with just the word.',
      );

      assert.match(
        out,
        /PINEAPPLE/i,
        `Resumed session should recall the codeword from turn 1. Got:\n${out}`,
      );
    },
  );
});

describe('Codex native session continuity (live, gated)', () => {
  it(
    'a resumed Codex thread remembers context from the prior turn',
    { skip: ENABLED ? false : 'set MYSHELL_NATIVE_SESSION_E2E=1 (needs authenticated codex) to run' },
    async () => {
      // Turn 1: establish a thread and plant a fact. Capture the thread id from
      // the JSON stream's thread.started event (this is exactly what codex-parse
      // extracts and what myshell-tools persists for resume).
      const turn1 = await runCli(
        'codex',
        ['exec', '--json', '--sandbox', 'read-only'],
        'Remember this codeword for later: PINEAPPLE. Reply with just "ok".',
      );
      let threadId: string | undefined;
      for (const line of turn1.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t) as { type?: string; thread_id?: string };
          if (o.type === 'thread.started' && typeof o.thread_id === 'string') {
            threadId = o.thread_id;
            break;
          }
        } catch { /* ignore non-JSON lines */ }
      }
      assert.ok(threadId, `expected a thread id from codex thread.started. Got:\n${turn1}`);

      // Turn 2: resume the SAME thread without repeating the codeword.
      const out = await runCli(
        'codex',
        ['exec', 'resume', threadId!, '--json', '--sandbox', 'read-only'],
        'What codeword did I ask you to remember? Reply with just the word.',
      );

      assert.match(
        out,
        /PINEAPPLE/i,
        `Resumed Codex thread should recall the codeword from turn 1. Got:\n${out}`,
      );
    },
  );
});
