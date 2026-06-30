/**
 * Unit tests for src/infra/update-prefix.ts — deriving the npm install PREFIX
 * that owns the running myshell-tools binary.
 * Run with: node --experimental-strip-types --test
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { prefixForRunningEntry } from '../../src/infra/update-prefix.ts';

describe('prefixForRunningEntry()', () => {
  it('returns the prefix for a POSIX global install (lib/node_modules layout)', () => {
    assert.equal(
      prefixForRunningEntry('/usr/local/lib/node_modules/myshell-tools/dist/cli.js'),
      '/usr/local',
    );
  });

  it('handles a single-segment POSIX prefix', () => {
    assert.equal(
      prefixForRunningEntry('/opt/lib/node_modules/myshell-tools/dist/cli.js'),
      '/opt',
    );
  });

  it('returns the prefix for a Windows global install (no lib, package directly under prefix)', () => {
    assert.equal(
      prefixForRunningEntry(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\myshell-tools\\dist\\cli.js',
      ),
      'C:\\Users\\me\\AppData\\Roaming\\npm',
    );
  });

  it('returns the prefix for a Windows lib/node_modules layout too', () => {
    assert.equal(
      prefixForRunningEntry(
        'C:\\Program Files\\nodejs\\lib\\node_modules\\myshell-tools\\dist\\cli.js',
      ),
      'C:\\Program Files\\nodejs',
    );
  });

  it('returns null for a local dev checkout (package dir not node_modules/myshell-tools)', () => {
    assert.equal(
      prefixForRunningEntry('/home/me/myshell-tools/dist/cli.js'),
      null,
    );
  });

  it('returns null for an npx cache path (_npx segment present)', () => {
    assert.equal(
      prefixForRunningEntry(
        '/home/me/.npm/_npx/abc123/node_modules/myshell-tools/dist/cli.js',
      ),
      null,
    );
  });

  it('returns null for a nonsense path', () => {
    assert.equal(prefixForRunningEntry('/totally/unrelated/path/script.js'), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(prefixForRunningEntry(''), null);
  });

  it('returns null when node_modules/myshell-tools sits at the filesystem root (no real prefix)', () => {
    // /node_modules/myshell-tools/... has no prefix segment before node_modules.
    assert.equal(
      prefixForRunningEntry('/node_modules/myshell-tools/dist/cli.js'),
      null,
    );
  });

  it('returns null when node_modules is present but for a different package', () => {
    assert.equal(
      prefixForRunningEntry('/usr/local/lib/node_modules/some-other-pkg/dist/cli.js'),
      null,
    );
  });

  it('ignores trailing-slash / mixed-separator noise but still derives the prefix', () => {
    assert.equal(
      prefixForRunningEntry('/usr/local//lib/node_modules/myshell-tools/dist/cli.js'),
      '/usr/local',
    );
  });
});
