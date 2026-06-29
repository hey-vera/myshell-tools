import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { homedir } from 'node:os';
import { isReplit, resolveStateHome, defaultStateHome } from '../../src/infra/state-dir.ts';

describe('isReplit', () => {
  it('true when REPL_ID is set', () => {
    assert.equal(isReplit({ REPL_ID: 'abc' }), true);
  });
  it('true when REPLIT_DEV_DOMAIN is set', () => {
    assert.equal(isReplit({ REPLIT_DEV_DOMAIN: 'x.repl.co' }), true);
  });
  it('false in a plain environment', () => {
    assert.equal(isReplit({}), false);
    assert.equal(isReplit({ HOME: '/home/me' }), false);
  });
});

describe('resolveStateHome', () => {
  it('uses cwd (the persistent workspace) on Replit', () => {
    assert.equal(
      resolveStateHome({ REPL_ID: 'abc' }, '/home/runner/workspace', '/home/runner'),
      '/home/runner/workspace',
    );
  });

  it('uses the home dir off Replit (unchanged global behaviour)', () => {
    assert.equal(resolveStateHome({}, '/some/project', '/home/me'), '/home/me');
  });
});

describe('defaultStateHome (ambient env) — the real persistence default', () => {
  it('resolves to the workspace (cwd) when REPL_ID is present, then restores', () => {
    const prev = process.env['REPL_ID'];
    try {
      process.env['REPL_ID'] = 'test-repl';
      // This is exactly what config/conversations/update-check use as their default
      // homeDir — proving Replit state lands in the persistent workspace, not ~.
      assert.equal(defaultStateHome(), process.cwd());
    } finally {
      if (prev === undefined) delete process.env['REPL_ID'];
      else process.env['REPL_ID'] = prev;
    }
  });

  it('resolves to the home dir when no Replit env is present', () => {
    const prevId = process.env['REPL_ID'];
    const prevDomain = process.env['REPLIT_DEV_DOMAIN'];
    try {
      delete process.env['REPL_ID'];
      delete process.env['REPLIT_DEV_DOMAIN'];
      assert.equal(defaultStateHome(), homedir());
    } finally {
      if (prevId !== undefined) process.env['REPL_ID'] = prevId;
      if (prevDomain !== undefined) process.env['REPLIT_DEV_DOMAIN'] = prevDomain;
    }
  });
});
