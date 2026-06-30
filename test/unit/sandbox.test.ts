import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { helperSandbox, sandboxForEnvironment } from '../../src/infra/sandbox.ts';

describe('sandboxForEnvironment', () => {
  it('uses full access when REPL_ID identifies a Replit container', () => {
    assert.equal(sandboxForEnvironment('workspace-write', { REPL_ID: 'repl' }), 'full-access');
    assert.equal(sandboxForEnvironment('read-only', { REPL_ID: 'repl' }), 'full-access');
  });

  it('uses full access when REPLIT_DEV_DOMAIN identifies a Replit container', () => {
    assert.equal(
      sandboxForEnvironment('workspace-write', { REPLIT_DEV_DOMAIN: 'example.replit.dev' }),
      'full-access',
    );
  });

  it('preserves the requested sandbox off Replit', () => {
    assert.equal(sandboxForEnvironment('workspace-write', {}), 'workspace-write');
    assert.equal(sandboxForEnvironment('read-only', {}), 'read-only');
  });
});

describe('helperSandbox', () => {
  it('keeps helper passes read-only on ordinary hosts', () => {
    assert.equal(helperSandbox('workspace-write'), 'read-only');
  });

  it('inherits full access inside the Replit container boundary', () => {
    assert.equal(helperSandbox('full-access'), 'full-access');
  });
});
