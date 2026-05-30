/**
 * Unit tests for src/infra/paths.ts
 * Run with: node --experimental-strip-types --test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  getStateDir,
  getSessionsDir,
  getSessionFile,
  getLedgerFile,
} from '../../src/infra/paths.ts';

const CWD = path.join('some', 'project', 'dir');

// ---------------------------------------------------------------------------
// getStateDir
// ---------------------------------------------------------------------------

describe('getStateDir()', () => {
  it('ends with .myshell-tools segment', () => {
    const result = getStateDir(CWD);
    assert.ok(
      result.endsWith(path.join('.myshell-tools')),
      `expected result to end with ".myshell-tools", got: ${result}`,
    );
  });

  it('is rooted in the given cwd', () => {
    const result = getStateDir(CWD);
    assert.ok(result.startsWith(CWD), `expected result to start with cwd "${CWD}", got: ${result}`);
  });
});

// ---------------------------------------------------------------------------
// getSessionsDir
// ---------------------------------------------------------------------------

describe('getSessionsDir()', () => {
  it('ends with .myshell-tools/sessions', () => {
    const result = getSessionsDir(CWD);
    assert.ok(
      result.endsWith(path.join('.myshell-tools', 'sessions')),
      `expected result to end with ".myshell-tools/sessions", got: ${result}`,
    );
  });

  it('is a subdirectory of getStateDir()', () => {
    const stateDir = getStateDir(CWD);
    const sessions = getSessionsDir(CWD);
    assert.ok(
      sessions.startsWith(stateDir),
      `sessions dir "${sessions}" should be inside state dir "${stateDir}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// getSessionFile
// ---------------------------------------------------------------------------

describe('getSessionFile()', () => {
  it('ends with .myshell-tools/sessions/current.jsonl', () => {
    const result = getSessionFile(CWD);
    assert.ok(
      result.endsWith(path.join('.myshell-tools', 'sessions', 'current.jsonl')),
      `expected result to end with ".myshell-tools/sessions/current.jsonl", got: ${result}`,
    );
  });

  it('is inside the sessions dir', () => {
    const sessions = getSessionsDir(CWD);
    const file = getSessionFile(CWD);
    assert.ok(
      file.startsWith(sessions),
      `session file "${file}" should be inside sessions dir "${sessions}"`,
    );
  });

  it('basename is current.jsonl', () => {
    assert.equal(path.basename(getSessionFile(CWD)), 'current.jsonl');
  });
});

// ---------------------------------------------------------------------------
// getLedgerFile
// ---------------------------------------------------------------------------

describe('getLedgerFile()', () => {
  it('ends with .myshell-tools/ledger.jsonl', () => {
    const result = getLedgerFile(CWD);
    assert.ok(
      result.endsWith(path.join('.myshell-tools', 'ledger.jsonl')),
      `expected result to end with ".myshell-tools/ledger.jsonl", got: ${result}`,
    );
  });

  it('is inside the myshell-tools dir', () => {
    const stateDir = getStateDir(CWD);
    const file = getLedgerFile(CWD);
    assert.ok(
      file.startsWith(stateDir),
      `ledger file "${file}" should be inside state dir "${stateDir}"`,
    );
  });

  it('basename is ledger.jsonl', () => {
    assert.equal(path.basename(getLedgerFile(CWD)), 'ledger.jsonl');
  });
});

// ---------------------------------------------------------------------------
// Cross-function consistency checks
// ---------------------------------------------------------------------------

describe('path consistency', () => {
  it('getSessionFile is deeper than getLedgerFile (sessions/ subdir)', () => {
    const ledger = getLedgerFile(CWD);
    const session = getSessionFile(CWD);
    // session file has an extra path segment (sessions/)
    assert.ok(
      session.length > ledger.length,
      'session file path should be longer than ledger file path',
    );
  });

  it('all paths are absolute when given an absolute cwd', () => {
    const absCwd = path.resolve('/tmp/myshell-tools-test');
    assert.ok(path.isAbsolute(getStateDir(absCwd)));
    assert.ok(path.isAbsolute(getSessionsDir(absCwd)));
    assert.ok(path.isAbsolute(getSessionFile(absCwd)));
    assert.ok(path.isAbsolute(getLedgerFile(absCwd)));
  });
});
