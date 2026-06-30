/**
 * Unit tests for src/infra/paths.ts
 * Run with: node --experimental-strip-types --test
 *
 * Phase D: paths now delegate to projectStateDirs so state lands under
 * <stateRoot>/projects/<projectKey>/... instead of <cwd>/.myshell-tools/...
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  getStateDir,
  getSessionsDir,
  getSessionFile,
  getLedgerFile,
  getEvalResultsFile,
  getIntentVersionsFile,
  getCommandAuditFile,
} from '../../src/infra/paths.ts';

const CWD = path.join('some', 'project', 'dir');

// ---------------------------------------------------------------------------
// getStateDir
// ---------------------------------------------------------------------------

describe('getStateDir()', () => {
  it('returns a non-empty string', () => {
    const result = getStateDir(CWD);
    assert.ok(result.length > 0);
  });

  it('contains the project-key segment', () => {
    const result = getStateDir(CWD);
    // The path includes a project key derived from CWD
    assert.ok(result.includes('some--project--dir'));
  });
});

// ---------------------------------------------------------------------------
// getSessionsDir
// ---------------------------------------------------------------------------

describe('getSessionsDir()', () => {
  it('is a subdirectory of getStateDir()', () => {
    const stateDir = getStateDir(CWD);
    const sessions = getSessionsDir(CWD);
    assert.ok(
      sessions.startsWith(stateDir),
      `sessions dir "${sessions}" should be inside state dir "${stateDir}"`,
    );
  });

  it('ends with sessions', () => {
    assert.ok(getSessionsDir(CWD).endsWith('sessions'));
  });
});

// ---------------------------------------------------------------------------
// getSessionFile
// ---------------------------------------------------------------------------

describe('getSessionFile()', () => {
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
  it('is inside the state dir', () => {
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
// getEvalResultsFile
// ---------------------------------------------------------------------------

describe('getEvalResultsFile()', () => {
  it('is inside the state dir', () => {
    const stateDir = getStateDir(CWD);
    const file = getEvalResultsFile(CWD);
    assert.ok(
      file.startsWith(stateDir),
      `eval results file "${file}" should be inside state dir "${stateDir}"`,
    );
  });

  it('basename is eval-results.jsonl', () => {
    assert.equal(path.basename(getEvalResultsFile(CWD)), 'eval-results.jsonl');
  });
});

// ---------------------------------------------------------------------------
// getIntentVersionsFile
// ---------------------------------------------------------------------------

describe('getIntentVersionsFile()', () => {
  it('is inside the state dir', () => {
    const stateDir = getStateDir(CWD);
    const file = getIntentVersionsFile(CWD);
    assert.ok(
      file.startsWith(stateDir),
      `intent versions file "${file}" should be inside state dir "${stateDir}"`,
    );
  });

  it('basename is intent-versions.jsonl', () => {
    assert.equal(path.basename(getIntentVersionsFile(CWD)), 'intent-versions.jsonl');
  });
});

// ---------------------------------------------------------------------------
// getCommandAuditFile
// ---------------------------------------------------------------------------

describe('getCommandAuditFile()', () => {
  it('is inside the state dir', () => {
    const stateDir = getStateDir(CWD);
    const file = getCommandAuditFile(CWD);
    assert.ok(
      file.startsWith(stateDir),
      `command audit file "${file}" should be inside state dir "${stateDir}"`,
    );
  });

  it('basename is command-audit.jsonl', () => {
    assert.equal(path.basename(getCommandAuditFile(CWD)), 'command-audit.jsonl');
  });
});

// ---------------------------------------------------------------------------
// Cross-function consistency checks
// ---------------------------------------------------------------------------

describe('path consistency', () => {
  it('getSessionFile is deeper than getLedgerFile (sessions/ subdir)', () => {
    const ledger = getLedgerFile(CWD);
    const session = getSessionFile(CWD);
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
    assert.ok(path.isAbsolute(getEvalResultsFile(absCwd)));
    assert.ok(path.isAbsolute(getIntentVersionsFile(absCwd)));
    assert.ok(path.isAbsolute(getCommandAuditFile(absCwd)));
  });

  it('all paths resolve to the same state root for the same cwd', () => {
    const root = getStateDir(CWD);
    assert.ok(getSessionsDir(CWD).startsWith(root));
    assert.ok(getSessionFile(CWD).startsWith(root));
    assert.ok(getLedgerFile(CWD).startsWith(root));
    assert.ok(getEvalResultsFile(CWD).startsWith(root));
    assert.ok(getIntentVersionsFile(CWD).startsWith(root));
    assert.ok(getCommandAuditFile(CWD).startsWith(root));
  });
});
