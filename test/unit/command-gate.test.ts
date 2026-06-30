import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { gateCommand } from '../../src/core/command-gate.ts';
import type { CommandGateDecision } from '../../src/core/command-gate.ts';
import type { CommandTier } from '../../src/core/types.ts';

interface DecisionFixture {
  readonly name: string;
  readonly command: string;
  readonly expected: CommandGateDecision;
}

const REPRESENTATIVE_FIXTURES: readonly DecisionFixture[] = [
  {
    name: 'read-only',
    command: 'ls -la',
    expected: {
      commandTier: 'read-only',
      allowed: true,
      requireConfirmation: false,
      forbidBackground: false,
      mustRecord: false,
      rationale: 'read-only: read-only command; no confirmation or audit record required.',
    },
  },
  {
    name: 'test-build',
    command: 'npm test',
    expected: {
      commandTier: 'test-build',
      allowed: true,
      requireConfirmation: false,
      forbidBackground: false,
      mustRecord: false,
      rationale: 'test-build: test/build command; no confirmation or audit record required.',
    },
  },
  {
    name: 'local-write',
    command: 'touch tmp.txt',
    expected: {
      commandTier: 'local-write',
      allowed: true,
      requireConfirmation: false,
      forbidBackground: false,
      mustRecord: true,
      rationale: 'local-write: mutates local files; record for the audit trail.',
    },
  },
  {
    name: 'dependency-install',
    command: 'npm install',
    expected: {
      commandTier: 'dependency-install',
      allowed: true,
      requireConfirmation: true,
      forbidBackground: false,
      mustRecord: true,
      rationale: 'dependency-install: state-changing dependency operation; confirm and record.',
    },
  },
  {
    name: 'destructive-filesystem',
    command: 'rm -rf build',
    expected: {
      commandTier: 'destructive-filesystem',
      allowed: true,
      requireConfirmation: true,
      forbidBackground: true,
      mustRecord: true,
      rationale: 'destructive-filesystem: high-risk command; always confirm, run in foreground, and record.',
    },
  },
  {
    name: 'credential-sensitive',
    command: 'cat .env',
    expected: {
      commandTier: 'credential-sensitive',
      allowed: true,
      requireConfirmation: true,
      forbidBackground: true,
      mustRecord: true,
      rationale: 'credential-sensitive: high-risk command; always confirm, run in foreground, and record.',
    },
  },
];

const HIGH_RISK_COMMANDS: readonly { readonly command: string; readonly expectedTier: CommandTier }[] = [
  { command: 'rm file.txt', expectedTier: 'destructive-filesystem' },
  { command: 'git clean -fd', expectedTier: 'destructive-filesystem' },
  { command: 'git reset --hard HEAD', expectedTier: 'destructive-filesystem' },
  { command: 'find . -delete', expectedTier: 'destructive-filesystem' },
  { command: 'cat .env', expectedTier: 'credential-sensitive' },
  { command: 'cat ~/.ssh/id_rsa', expectedTier: 'credential-sensitive' },
  { command: 'echo $TOKEN', expectedTier: 'credential-sensitive' },
  { command: 'gh auth login', expectedTier: 'credential-sensitive' },
];

describe('gateCommand', () => {
  for (const { name, command, expected } of REPRESENTATIVE_FIXTURES) {
    it(`applies the ${name} policy`, () => {
      assert.deepEqual(gateCommand(command), expected);
    });
  }

  for (const { command, expectedTier } of HIGH_RISK_COMMANDS) {
    it(`${command} obeys the high-risk hard invariant`, () => {
      const decision = gateCommand(command);
      assert.equal(decision.commandTier, expectedTier);
      assert.equal(decision.requireConfirmation, true);
      assert.equal(decision.forbidBackground, true);
      assert.equal(decision.mustRecord, true);
      assert.equal(decision.allowed, true);
    });
  }

  it('does not relent when background is requested for a destructive command', () => {
    const decision = gateCommand('rm -rf build', { requestedBackground: true });
    assert.equal(decision.commandTier, 'destructive-filesystem');
    assert.equal(decision.requireConfirmation, true);
    assert.equal(decision.forbidBackground, true);
    assert.equal(decision.mustRecord, true);
    assert.match(decision.rationale, /Background execution was requested/);
  });

  it('never records or confirms read-only commands', () => {
    const readOnlyCommands = ['ls -la', 'git status --short', 'rg "gateCommand" src test'];
    for (const command of readOnlyCommands) {
      const decision = gateCommand(command);
      assert.equal(decision.commandTier, 'read-only');
      assert.equal(decision.requireConfirmation, false);
      assert.equal(decision.mustRecord, false);
      assert.equal(decision.forbidBackground, false);
    }
  });
});
