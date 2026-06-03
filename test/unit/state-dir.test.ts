import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isReplit, resolveStateHome } from '../../src/infra/state-dir.ts';

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
