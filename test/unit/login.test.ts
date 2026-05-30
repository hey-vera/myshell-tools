/**
 * Unit tests for src/commands/login.ts
 *
 * Only the hermetic validation path is unit-tested. The interactive sign-in
 * (which spawns `claude auth login` / `codex login` with inherited stdio) is an
 * integration concern and is not exercised here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderId, runLogin } from '../../src/commands/login.ts';

describe('isProviderId', () => {
  it('accepts claude and codex', () => {
    assert.equal(isProviderId('claude'), true);
    assert.equal(isProviderId('codex'), true);
  });

  it('rejects anything else', () => {
    assert.equal(isProviderId('gpt'), false);
    assert.equal(isProviderId('Claude'), false);
    assert.equal(isProviderId(''), false);
  });
});

describe('runLogin — invalid argument (hermetic, no spawn)', () => {
  it('returns 1 and writes an "unknown provider" error', async () => {
    const buf: string[] = [];
    const out = { write: (s: string) => buf.push(s), color: false, isTty: false };
    const code = await runLogin(out, 'bogus');
    assert.equal(code, 1);
    assert.ok(
      buf.join('').toLowerCase().includes('unknown provider'),
      `expected an "unknown provider" message, got: ${buf.join('')}`,
    );
  });
});
