import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import type {
  CommandAuditEvent,
  CommandGateDecision,
  CommandGatePort,
} from '../../src/core/command-gate.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import {
  createNodeShellRunner,
  runShellPassthrough,
} from '../../src/interface/shell-passthrough.ts';

function makeSink(): OutputSink & { buf: string } {
  let buf = '';
  return {
    get buf() { return buf; },
    write: (s: string) => { buf += s; },
    color: false,
    isTty: false,
  };
}

const readOnlyDecision: CommandGateDecision = {
  commandTier: 'read-only',
  allowed: true,
  requireConfirmation: false,
  forbidBackground: false,
  mustRecord: false,
  rationale: 'read-only',
};

const destructiveDecision: CommandGateDecision = {
  commandTier: 'destructive-filesystem',
  allowed: true,
  requireConfirmation: true,
  forbidBackground: true,
  mustRecord: true,
  rationale: 'destructive command',
};

describe('shell passthrough helper', () => {
  it('runs an allowed command and records it when the policy requires an audit', async () => {
    const sink = makeSink();
    const audit: CommandAuditEvent[] = [];
    const runnerCalls: Array<{ command: string; cwd: string }> = [];
    const gate: CommandGatePort = {
      gate(command) {
        assert.equal(command, 'git status');
        return { ...readOnlyDecision, mustRecord: true };
      },
      record(event) {
        audit.push(event);
      },
    };

    await runShellPassthrough(
      'git status',
      '/repo',
      sink,
      gate,
      {
        async run(command, cwd, out) {
          runnerCalls.push({ command, cwd });
          out.write('ok\n');
          return { exitCode: 0 };
        },
      },
    );

    assert.deepEqual(runnerCalls, [{ command: 'git status', cwd: '/repo' }]);
    assert.equal(sink.buf, 'ok\n');
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.outcome, 'ran');
    assert.equal(audit[0]?.cwd, '/repo');
  });

  it('does not run when confirmation is declined and records a denial', async () => {
    const sink = makeSink();
    const audit: CommandAuditEvent[] = [];
    const confirmMessages: string[] = [];
    let runnerCalls = 0;
    const gate: CommandGatePort = {
      gate(command) {
        assert.equal(command, 'rm -rf build');
        return destructiveDecision;
      },
      async confirm(message) {
        confirmMessages.push(message);
        return false;
      },
      record(event) {
        audit.push(event);
      },
    };

    await runShellPassthrough(
      'rm -rf build',
      '/repo',
      sink,
      gate,
      {
        async run() {
          runnerCalls += 1;
          return { exitCode: 0 };
        },
      },
    );

    assert.equal(runnerCalls, 0);
    assert.deepEqual(confirmMessages, ['destructive command']);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.outcome, 'denied');
    assert.equal(audit[0]?.confirmed, false);
    assert.ok(sink.buf.includes('Shell command not run.'));
  });

  it('denies trailing background syntax when the gate requires foreground execution', async () => {
    const sink = makeSink();
    const audit: CommandAuditEvent[] = [];
    const gateCalls: Array<{ command: string; requestedBackground: boolean }> = [];
    let confirmCalls = 0;
    let runnerCalls = 0;
    const gate: CommandGatePort = {
      gate(command, opts) {
        gateCalls.push({ command, requestedBackground: opts?.requestedBackground === true });
        return destructiveDecision;
      },
      async confirm() {
        confirmCalls += 1;
        return true;
      },
      record(event) {
        audit.push(event);
      },
    };

    await runShellPassthrough(
      'rm -rf build &',
      '/repo',
      sink,
      gate,
      {
        async run() {
          runnerCalls += 1;
          return { exitCode: 0 };
        },
      },
    );

    assert.deepEqual(gateCalls, [{ command: 'rm -rf build &', requestedBackground: true }]);
    assert.equal(confirmCalls, 0);
    assert.equal(runnerCalls, 0);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.outcome, 'denied');
    assert.equal(audit[0]?.confirmed, null);
    assert.ok(sink.buf.includes('Background execution is not allowed for this command.'));
  });

  it('streams interleaved output chunks and returns the exit code', async () => {
    const sink = makeSink();
    const all = new EventEmitter();
    const runner = createNodeShellRunner({
      execaCommand: ((command: string) => {
        assert.equal(command, 'printf ok');
        const child = Promise.resolve({
          exitCode: 3,
          failed: true,
          timedOut: false,
          all: 'stdout\nstderr\n',
        }) as Promise<{
          exitCode: number;
          failed: boolean;
          timedOut: boolean;
          all: string;
        }>;
        return Object.assign(child, { all });
      }) as typeof import('execa').execaCommand,
    });

    const resultPromise = runner.run('printf ok', '/repo', sink);
    all.emit('data', 'stdout\n');
    all.emit('data', 'stderr\n');
    const result = await resultPromise;

    assert.deepEqual(result, { exitCode: 3 });
    assert.equal(sink.buf, 'stdout\nstderr\n');
  });

  it('prints a short spawn-failure line and resolves null on startup failure', async () => {
    const sink = makeSink();
    const runner = createNodeShellRunner({
      execaCommand: (async () => {
        throw new Error('spawn failed');
      }) as typeof import('execa').execaCommand,
    });

    const result = await runner.run('missing-binary', '/repo', sink);

    assert.deepEqual(result, { exitCode: null });
    assert.ok(sink.buf.includes('Shell command failed to start.'));
  });
});
