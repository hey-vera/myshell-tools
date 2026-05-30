/**
 * Unit tests for src/commands/login.ts
 *
 * Only the hermetic validation path is unit-tested. The interactive sign-in
 * (which spawns `claude auth login` / `codex login` with inherited stdio) is an
 * integration concern and is not exercised here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProviderId, isHeadlessEnv, resolveLoginMethod, runLogin } from '../../src/commands/login.ts';

describe('isProviderId', () => {
  it('accepts claude, codex, and opencode', () => {
    assert.equal(isProviderId('claude'), true);
    assert.equal(isProviderId('codex'), true);
    assert.equal(isProviderId('opencode'), true);
  });

  it('rejects anything else', () => {
    assert.equal(isProviderId('gpt'), false);
    assert.equal(isProviderId('Claude'), false);
    assert.equal(isProviderId(''), false);
  });
});

// ---------------------------------------------------------------------------
// isHeadlessEnv — pure env detection
// ---------------------------------------------------------------------------

describe('isHeadlessEnv — detects headless/container/SSH environments', () => {
  it('returns true when REPL_ID is set (Replit)', () => {
    assert.equal(isHeadlessEnv({ REPL_ID: 'abc123' }, 'linux'), true);
  });

  it('returns true when REPLIT_DEV_DOMAIN is set', () => {
    assert.equal(isHeadlessEnv({ REPLIT_DEV_DOMAIN: 'foo.replit.dev' }, 'linux'), true);
  });

  it('returns true when CODESPACES is set', () => {
    assert.equal(isHeadlessEnv({ CODESPACES: 'true' }, 'linux'), true);
  });

  it('returns true when GITPOD_WORKSPACE_ID is set', () => {
    assert.equal(isHeadlessEnv({ GITPOD_WORKSPACE_ID: 'ws-123' }, 'linux'), true);
  });

  it('returns true when SSH_CONNECTION is set', () => {
    assert.equal(isHeadlessEnv({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 12345' }, 'linux'), true);
  });

  it('returns true when SSH_TTY is set', () => {
    assert.equal(isHeadlessEnv({ SSH_TTY: '/dev/pts/0' }, 'linux'), true);
  });

  it('returns true on linux with no DISPLAY or WAYLAND_DISPLAY', () => {
    assert.equal(isHeadlessEnv({}, 'linux'), true);
  });

  it('returns true on linux with empty DISPLAY and no WAYLAND_DISPLAY', () => {
    assert.equal(isHeadlessEnv({ DISPLAY: '' }, 'linux'), true);
  });

  it('returns false on linux when DISPLAY is set', () => {
    assert.equal(isHeadlessEnv({ DISPLAY: ':0' }, 'linux'), false);
  });

  it('returns false on linux when WAYLAND_DISPLAY is set', () => {
    assert.equal(isHeadlessEnv({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), false);
  });

  it('returns false on darwin (macOS) with empty env', () => {
    assert.equal(isHeadlessEnv({}, 'darwin'), false);
  });

  it('returns false on win32 with empty env', () => {
    assert.equal(isHeadlessEnv({}, 'win32'), false);
  });
});

// ---------------------------------------------------------------------------
// resolveLoginMethod — explicit override and auto-detection
// ---------------------------------------------------------------------------

describe('resolveLoginMethod — explicit method overrides detection', () => {
  it('returns "browser" when explicitly requested, even on headless env', () => {
    assert.equal(resolveLoginMethod('browser', { REPL_ID: 'x' }, 'linux'), 'browser');
  });

  it('returns "code" when explicitly requested, even on a desktop env', () => {
    assert.equal(resolveLoginMethod('code', { DISPLAY: ':0' }, 'linux'), 'code');
  });

  it('auto-detects "code" for headless linux (no DISPLAY)', () => {
    assert.equal(resolveLoginMethod(undefined, {}, 'linux'), 'code');
  });

  it('auto-detects "code" for Replit environment', () => {
    assert.equal(resolveLoginMethod(undefined, { REPL_ID: 'abc' }, 'linux'), 'code');
  });

  it('auto-detects "browser" on macOS with no SSH/container env vars', () => {
    assert.equal(resolveLoginMethod(undefined, {}, 'darwin'), 'browser');
  });

  it('auto-detects "browser" on linux when DISPLAY is set', () => {
    assert.equal(resolveLoginMethod(undefined, { DISPLAY: ':0' }, 'linux'), 'browser');
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
