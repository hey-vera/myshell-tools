/**
 * Unit tests for src/core/classify.ts
 * Run with: node --experimental-strip-types --test test/unit/classify.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../src/core/classify.ts';

// ---------------------------------------------------------------------------
// Table-driven tests
// ---------------------------------------------------------------------------

interface Row {
  task: string;
  tier: 'worker' | 'ic' | 'manager';
  risk: 'low' | 'medium' | 'high' | 'critical';
  note?: string;
}

const TABLE: Row[] = [
  // --- worker tier ---
  {
    task: 'find the config file for the database',
    tier: 'worker',
    risk: 'medium',
    note: 'worker keyword "find"; medium keyword "config"',
  },
  {
    task: 'search for all TODO comments in the codebase',
    tier: 'worker',
    risk: 'low',
    note: 'worker keyword "search"; no risk keywords',
  },
  {
    task: 'list all exported functions in utils.ts',
    tier: 'worker',
    risk: 'low',
    note: 'worker keyword "list"; no risk keywords',
  },
  {
    task: 'what is the payment gateway endpoint',
    tier: 'worker',
    risk: 'high',
    note: 'worker keyword "what is"; high keyword "payment"',
  },

  // --- ic tier ---
  {
    task: 'refactor the parser to use an AST',
    tier: 'ic',
    risk: 'low',
    note: 'no tier keyword → ic; no risk keyword → low',
  },
  {
    task: 'implement the retry logic for API calls',
    tier: 'ic',
    risk: 'low',
    note: 'no tier keyword → ic; no risk keyword → low',
  },
  {
    task: 'fix the bug in the user session handler',
    tier: 'ic',
    risk: 'low',
    note: 'no tier keyword → ic; no risk keyword → low',
  },
  {
    task: 'update the test configuration for integration tests',
    tier: 'ic',
    risk: 'medium',
    note: 'no tier keyword → ic; medium keyword "test", "config", "integration"',
  },

  // --- .env / critical risk ---
  {
    task: 'update the DATABASE_URL in the .env file',
    tier: 'ic',
    risk: 'critical',
    note: 'no tier keyword → ic; critical keyword ".env"',
  },
  {
    task: 'rotate the signing token for the auth service',
    tier: 'ic',
    risk: 'critical',
    note: 'no tier keyword → ic; critical keyword "token" and "auth"',
  },

  // --- manager tier ---
  {
    task: 'review the PR for security vulnerabilities',
    tier: 'manager',
    risk: 'low',
    note: 'manager keyword "review", "security"; no additional risk keyword beyond manager-tier',
  },
  {
    task: 'design a new architecture for the data pipeline',
    tier: 'manager',
    risk: 'low',
    note: 'manager keyword "design", "architect"',
  },
  {
    task: 'audit the permission model for the admin panel',
    tier: 'manager',
    risk: 'high',
    note: 'manager keyword "audit"; high keyword "permission"',
  },
  {
    task: 'assess the complexity of the payment migration',
    tier: 'manager',
    risk: 'high',
    note: 'manager keyword "assess", "complex"; high keyword "payment", "migration"',
  },

  // --- critical risk overrides ---
  {
    task: 'check whether the credential is still valid',
    tier: 'ic',
    risk: 'critical',
    note: 'critical keyword "credential"',
  },
  {
    task: 'encrypt the backup before uploading to S3',
    tier: 'ic',
    risk: 'critical',
    note: 'critical keyword "encrypt"',
  },
];

describe('classify — tier detection', () => {
  for (const row of TABLE) {
    it(`"${row.task.slice(0, 60)}" → tier=${row.tier}`, () => {
      const result = classify(row.task);
      assert.equal(
        result.tier,
        row.tier,
        `Expected tier "${row.tier}" but got "${result.tier}". Note: ${row.note ?? ''}. rationale: ${result.rationale}`,
      );
    });
  }
});

describe('classify — risk detection', () => {
  for (const row of TABLE) {
    it(`"${row.task.slice(0, 60)}" → risk=${row.risk}`, () => {
      const result = classify(row.task);
      assert.equal(
        result.risk,
        row.risk,
        `Expected risk "${row.risk}" but got "${result.risk}". Note: ${row.note ?? ''}. rationale: ${result.rationale}`,
      );
    });
  }
});

describe('classify — rationale is non-empty', () => {
  it('every result has a non-empty rationale string', () => {
    for (const row of TABLE) {
      const result = classify(row.task);
      assert.ok(
        result.rationale.trim().length > 0,
        `Expected non-empty rationale for task: "${row.task}"`,
      );
    }
  });
});

describe('classify — critical risk requires no confidence fabrication', () => {
  it('result contains no numeric confidence field (it is a Classification, not an Assessment)', () => {
    const result = classify('rotate the password in .env');
    // Classification has no confidence field — just tier, risk, rationale
    assert.ok(!('confidence' in result), 'classify() must not return a confidence field');
    assert.equal(result.risk, 'critical');
  });
});

describe('classify — priority: manager beats worker when both keywords present', () => {
  it('"review and search the codebase" → tier=manager (manager wins)', () => {
    const result = classify('review and search the codebase');
    // Manager pattern is tested first
    assert.equal(result.tier, 'manager');
  });
});
