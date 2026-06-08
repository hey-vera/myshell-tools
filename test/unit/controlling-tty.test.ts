/**
 * test/unit/controlling-tty.test.ts — resolveInteractiveChildStdin.
 *
 * Verifies the inherited-child stdin source selection that fixes interactive
 * sign-in (`claude /login`) and raw-session passthrough in a pipe-stdin wrapper
 * shell (Replit data-tools): when process.stdin is NOT a TTY, the child must read
 * /dev/tty (the real terminal), not the empty inherited pipe.
 *
 * No real /dev/tty: fs.openSync/closeSync are mocked for the duration of each test.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveInteractiveChildStdin } from '../../src/infra/controlling-tty.ts';

const realIsTTY = process.stdin.isTTY;
const realOpenSync = fs.openSync;
const realCloseSync = fs.closeSync;

function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

afterEach(() => {
  setStdinIsTTY(realIsTTY);
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = realOpenSync;
  (fs as unknown as { closeSync: typeof fs.closeSync }).closeSync = realCloseSync;
});

describe('resolveInteractiveChildStdin', () => {
  it("returns 'inherit' when process.stdin is already a TTY (normal terminal — no change)", () => {
    setStdinIsTTY(true);
    let opened = false;
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = (() => {
      opened = true;
      return 99;
    }) as typeof fs.openSync;

    const r = resolveInteractiveChildStdin();
    assert.equal(r.stdin, 'inherit');
    assert.equal(opened, false, 'must not open /dev/tty when stdin is already a TTY');
    r.cleanup(); // no-op, must not throw
  });

  it('opens /dev/tty (r+) and returns its fd when stdin is NOT a TTY (pipe-stdin shell)', () => {
    if (process.platform === 'win32') return; // /dev/tty path is POSIX-only
    setStdinIsTTY(false);
    let openedPath = '';
    let openedFlags: string | number = '';
    let closed = -1;
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((
      path: fs.PathLike,
      flags: string | number,
    ) => {
      openedPath = String(path);
      openedFlags = flags;
      return 77;
    }) as typeof fs.openSync;
    (fs as unknown as { closeSync: typeof fs.closeSync }).closeSync = ((fd: number) => {
      closed = fd;
    }) as typeof fs.closeSync;

    const r = resolveInteractiveChildStdin();
    assert.equal(r.stdin, 77, 'child stdin should be the /dev/tty fd');
    assert.equal(openedPath, '/dev/tty');
    assert.equal(openedFlags, 'r+', 'open O_RDWR so the child can run termios ioctls');

    r.cleanup();
    assert.equal(closed, 77, 'cleanup() must close the fd it opened');
  });

  it("falls back to 'inherit' when /dev/tty cannot be opened (true non-interactive / CI)", () => {
    if (process.platform === 'win32') return;
    setStdinIsTTY(false);
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = (() => {
      throw new Error('ENXIO: no controlling terminal');
    }) as typeof fs.openSync;

    const r = resolveInteractiveChildStdin();
    assert.equal(r.stdin, 'inherit');
    r.cleanup(); // no-op, must not throw
  });
});
