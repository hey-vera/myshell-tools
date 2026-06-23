import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNodeWorktreePort } from '../../src/infra/worktree.ts';
import { createNodeVerifyPort } from '../../src/infra/verify-port.ts';
import type {
  CommandAuditEvent,
  CommandGateDecision,
  CommandGatePort,
} from '../../src/core/command-gate.ts';

type WorktreeExeca = NonNullable<NonNullable<Parameters<typeof createNodeWorktreePort>[0]>['execa']>;
type VerifyExeca = NonNullable<NonNullable<Parameters<typeof createNodeVerifyPort>[0]>['execa']>;

function fakeWorktreeExeca(calls: Array<{ file: string; args: readonly string[] }>): WorktreeExeca {
  return (async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] });
    return { all: 'ok\n', exitCode: 0, failed: false, timedOut: false };
  }) as WorktreeExeca;
}

function fakeVerifyExeca(calls: Array<{ file: string; args: readonly string[] }>): VerifyExeca {
  return (async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] });
    return { all: 'tests passed\n', exitCode: 0, failed: false, timedOut: false };
  }) as VerifyExeca;
}

const destructiveDecision: CommandGateDecision = {
  commandTier: 'destructive-filesystem',
  allowed: true,
  requireConfirmation: true,
  forbidBackground: true,
  mustRecord: true,
  rationale: 'destructive command',
};

const testBuildDecision: CommandGateDecision = {
  commandTier: 'test-build',
  allowed: true,
  requireConfirmation: false,
  forbidBackground: false,
  mustRecord: false,
  rationale: 'test command',
};

describe('command gate wiring', () => {
  it('execInWorktree confirms destructive commands and does not execute when denied', async () => {
    const execaCalls: Array<{ file: string; args: readonly string[] }> = [];
    const auditEvents: CommandAuditEvent[] = [];
    const confirmMessages: string[] = [];
    const port = createNodeWorktreePort({ execa: fakeWorktreeExeca(execaCalls) });
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
        auditEvents.push(event);
      },
    };

    const result = await port.execInWorktree(
      { cwd: '/tmp/wt', branch: 'HEAD' },
      'rm',
      ['-rf', 'build'],
      1000,
      gate,
    );

    assert.deepEqual(result, { exitCode: null, output: '' });
    assert.deepEqual(execaCalls, []);
    assert.deepEqual(confirmMessages, ['destructive command']);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0]?.outcome, 'denied');
    assert.equal(auditEvents[0]?.confirmed, false);
    assert.equal(auditEvents[0]?.commandTier, 'destructive-filesystem');
    assert.equal(auditEvents[0]?.cwd, '/tmp/wt');
  });

  it('runTests runs normal test-build commands without confirmation', async () => {
    const execaCalls: Array<{ file: string; args: readonly string[] }> = [];
    let confirmCalls = 0;
    const port = createNodeVerifyPort({ execa: fakeVerifyExeca(execaCalls) });
    const gate: CommandGatePort = {
      gate(command) {
        assert.equal(command, 'npm test --silent');
        return testBuildDecision;
      },
      async confirm() {
        confirmCalls += 1;
        return true;
      },
    };

    const result = await port.runTests(
      '/repo',
      { label: 'npm test', command: 'npm', args: ['test', '--silent'] },
      1000,
      gate,
    );

    assert.equal(result.outcome, 'green');
    assert.equal(result.output, 'tests passed\n');
    assert.equal(confirmCalls, 0);
    assert.deepEqual(execaCalls, [{ file: 'npm', args: ['test', '--silent'] }]);
  });

  it('execInWorktree proceeds as before when no commandGate is passed', async () => {
    const execaCalls: Array<{ file: string; args: readonly string[] }> = [];
    const port = createNodeWorktreePort({ execa: fakeWorktreeExeca(execaCalls) });

    const result = await port.execInWorktree(
      { cwd: '/tmp/wt', branch: 'HEAD' },
      'git',
      ['status', '--porcelain'],
      1000,
    );

    assert.deepEqual(result, { exitCode: 0, output: 'ok\n' });
    assert.deepEqual(execaCalls, [{ file: 'git', args: ['status', '--porcelain'] }]);
  });
});
