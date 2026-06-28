/**
 * Unit tests for src/core/classify.ts
 * Run with: node --experimental-strip-types --test test/unit/classify.test.ts
 *
 * Covers:
 *  - Multi-signal tier scoring (manager / ic / worker)
 *  - Risk cascade (critical > high > medium > low)
 *  - Tie-break: manager > ic > worker (when scores equal)
 *  - Word-boundary non-matches (no false positives)
 *  - Empty / whitespace input (safe default)
 *  - Rationale names matched signals (honesty contract)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classify, hasWorkIntent } from '../../src/core/classify.ts';

// ---------------------------------------------------------------------------
// Table-driven baseline tests
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
    note: 'ic keyword "refactor"; no risk keyword → low',
  },
  {
    task: 'implement the retry logic for API calls',
    tier: 'ic',
    risk: 'low',
    note: 'ic keyword "implement"; no risk keyword → low',
  },
  {
    // NOTE: "session" is a critical risk signal (session hijacking / management
    // is a security concern). Updated from the old expectation of risk=low.
    task: 'fix the bug in the user session handler',
    tier: 'ic',
    risk: 'critical',
    note: 'ic keyword "fix"; critical keyword "session" (session management is security-sensitive)',
  },
  {
    task: 'update the test configuration for integration tests',
    tier: 'ic',
    risk: 'medium',
    note: 'ic keyword "update"; medium keyword "test", "config", "integration"',
  },

  // --- .env / critical risk ---
  {
    task: 'update the DATABASE_URL in the .env file',
    tier: 'ic',
    risk: 'critical',
    note: 'ic keyword "update"; critical keyword ".env"',
  },
  {
    task: 'rotate the signing token for the auth service',
    tier: 'ic',
    risk: 'critical',
    note: 'ic keyword (none direct, defaults to ic); critical keyword "token" and "auth"',
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

describe('hasWorkIntent — gate for the auto-stage planner (work, not lookups)', () => {
  it('fires on manager/IC work signals', () => {
    for (const t of [
      'wire up the auth login flow',
      'implement the dark-mode toggle',
      'refactor the goal store',
      'add tests for the planner',
      'build and ship the billing system',
      'fix the failing migration',
    ]) {
      assert.equal(hasWorkIntent(t), true, `expected work intent: "${t}"`);
    }
  });
  it('does NOT fire on pure read-only lookups / questions', () => {
    for (const t of [
      'how does the router work?',
      'what is the verify engine?',
      'explain the goal store',
      'find the auth module',
      'show me the recent goals',
      'sounds good?',
      '',
    ]) {
      assert.equal(hasWorkIntent(t), false, `expected NO work intent: "${t}"`);
    }
  });
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

describe('classify — manager corroboration: a lone soft signal does NOT win', () => {
  it('"review and search the codebase" → tier=worker (lone soft "review" → not manager; "search" → worker)', () => {
    // UPDATED for the manager-corroboration fix. "review" is a lone SOFT manager
    // signal, which is no longer sufficient to force manager. With a worker
    // signal ("search") present, this routes to worker. (Previously expected
    // manager via the lone-keyword tie-break — that was the overtrigger bug.)
    const result = classify('review and search the codebase');
    assert.equal(result.tier, 'worker', `rationale: ${result.rationale}`);
  });

  it('"review and design the codebase" → tier=manager (TWO distinct soft signals corroborate)', () => {
    // review + design = 2 distinct soft manager signals → manager qualifies.
    const result = classify('review and design the codebase');
    assert.equal(result.tier, 'manager', `rationale: ${result.rationale}`);
  });
});

// ---------------------------------------------------------------------------
// New: comprehensive multi-signal tier tests
// ---------------------------------------------------------------------------

describe('classify — worker tier comprehensive', () => {
  const workerCases: Row[] = [
    {
      task: 'grep for usages of the deprecated API',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "grep"',
    },
    {
      task: 'locate the file that defines the routing table',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "locate"',
    },
    {
      task: 'show me all the TODO comments',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "show"',
    },
    {
      task: 'display the current environment variables',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "display"',
    },
    {
      task: 'count the number of lines in each source file',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "count"',
    },
    {
      task: 'how does the retry mechanism work',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "how does"',
    },
    {
      task: 'explain the difference between map and flatMap',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "explain"',
    },
    {
      task: 'describe the current database schema',
      tier: 'worker',
      risk: 'high',
      note: 'worker keyword "describe"; high keyword "schema"',
    },
    {
      task: 'summarize what the orchestrate module does',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "summarize"',
    },
    {
      task: 'what does the classify function return',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "what does"',
    },
    {
      task: 'scan the codebase for unused imports',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "scan"',
    },
    {
      task: 'where are the API endpoints defined',
      tier: 'worker',
      risk: 'low',
      note: 'worker keyword "where are"',
    },
    {
      task: 'Reply with exactly: SPINE_OK',
      tier: 'worker',
      risk: 'low',
      note: 'exact-output "reply exactly"',
    },
    {
      task: 'respond exactly "OK"',
      tier: 'worker',
      risk: 'low',
      note: 'exact-output "respond exactly"',
    },
    {
      task: 'say only hello',
      tier: 'worker',
      risk: 'low',
      note: 'exact-output "say only"',
    },
    {
      task: 'answer with just "yes"',
      tier: 'worker',
      risk: 'low',
      note: 'exact-output "answer with just"',
    },
  ];

  for (const row of workerCases) {
    it(`"${row.task.slice(0, 60)}" → tier=${row.tier}, risk=${row.risk}`, () => {
      const result = classify(row.task);
      assert.equal(result.tier, row.tier, `tier mismatch: ${result.rationale}`);
      assert.equal(result.risk, row.risk, `risk mismatch: ${result.rationale}`);
    });
  }
});

describe('classify — exact-output tie-break (IC wins)', () => {
  it('"implement the endpoint and reply exactly \"done\"" → ic (IC signal wins on tie)', () => {
    const result = classify('implement the endpoint and reply exactly "done"');
    assert.equal(result.tier, 'ic', `rationale: ${result.rationale}`);
  });

  it('"fix the bug and respond exactly \"fixed\"" → ic (IC signal wins on tie)', () => {
    const result = classify('fix the bug and respond exactly "fixed"');
    assert.equal(result.tier, 'ic', `rationale: ${result.rationale}`);
  });
});

describe('classify — ic tier comprehensive', () => {
  const icCases: Row[] = [
    {
      task: 'add a retry wrapper around the HTTP client',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "add"',
    },
    {
      task: 'create a new utility function for date formatting',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "create"',
    },
    {
      task: 'build the CSV export feature',
      tier: 'ic',
      risk: 'medium',
      note: 'ic keyword "build"; medium keyword "build"',
    },
    {
      task: 'debug the null pointer exception in the parser',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "debug"',
    },
    {
      task: 'rename the variable from tmp to result',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "rename"',
    },
    {
      task: 'remove the dead code in the util module',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "remove"',
    },
    {
      task: 'move the helper functions to a shared module',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "move"',
    },
    {
      task: 'rewrite the legacy XML parser in TypeScript',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "rewrite"',
    },
    {
      task: 'optimize the database query to use an index',
      tier: 'ic',
      risk: 'medium',
      note: 'ic keyword "optimize"; medium keyword "build" not present, but "config" not present either — medium from no context... actually low',
    },
    {
      task: 'wire up the new route in the Express router',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "wire up"',
    },
    {
      task: 'hook up the event emitter to the UI layer',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "hook up"',
    },
    {
      task: 'add tests for the new validation logic',
      tier: 'ic',
      risk: 'medium',
      note: 'ic keyword "add tests"; medium keyword "test"',
    },
    {
      task: 'format the source files with prettier',
      tier: 'ic',
      risk: 'low',
      note: 'ic keyword "format"',
    },
  ];

  for (const row of icCases) {
    it(`"${row.task.slice(0, 60)}" → tier=${row.tier}`, () => {
      const result = classify(row.task);
      assert.equal(result.tier, row.tier, `tier mismatch: ${result.rationale}`);
    });
  }
});

describe('classify — manager tier comprehensive', () => {
  const managerCases: Row[] = [
    {
      // UPDATED for the manager-corroboration fix: "plan" is now a SOFT manager
      // signal and "migration" (without "large") is not a manager signal at all,
      // so this lone soft signal no longer forces manager — it routes to ic.
      // (Previously expected manager; that encoded the lone-keyword overtrigger.)
      // "migration" still drives risk=high via the risk cascade.
      task: 'plan the migration from REST to GraphQL',
      tier: 'ic',
      risk: 'high',
      note: 'lone soft manager keyword "plan" → ic (needs ≥2 soft or a strong signal); high keyword "migration"',
    },
    {
      task: 'evaluate the trade-offs between Redis and Memcached',
      tier: 'manager',
      risk: 'low',
      note: 'manager keyword "evaluate", "trade-offs"',
    },
    {
      task: 'should we adopt a monorepo structure',
      tier: 'manager',
      risk: 'low',
      note: 'manager keyword "should we"',
    },
    {
      task: 'define the high-level strategy for the v3 API',
      tier: 'manager',
      risk: 'low',
      note: 'manager keyword "strategy", "high-level"',
    },
    {
      task: 'assess the end-to-end impact of removing the legacy adapter',
      tier: 'manager',
      risk: 'low',
      note: 'manager keyword "assess", "end-to-end"',
    },
    {
      task: 'which approach is better: polling or websockets',
      tier: 'manager',
      risk: 'low',
      note: 'manager keyword "which approach"',
    },
    {
      task: 'threat model the new authentication flow',
      tier: 'manager',
      risk: 'critical',
      note: 'manager keyword "threat model"; critical keyword "auth"',
    },
    {
      task: 'compare approaches for handling distributed transactions',
      tier: 'manager',
      risk: 'low',
      note: 'manager keyword "compare approaches"',
    },
    {
      task: 'review the security architecture across the codebase',
      tier: 'manager',
      risk: 'low',
      note: 'manager keyword "review", "security", "architect", "across the codebase"',
    },
    {
      task: 'design a complicated migration across the system',
      tier: 'manager',
      risk: 'high',
      note: 'manager keyword "design", "complicated"; high keyword "migration"',
    },
  ];

  for (const row of managerCases) {
    it(`"${row.task.slice(0, 60)}" → tier=${row.tier}`, () => {
      const result = classify(row.task);
      assert.equal(result.tier, row.tier, `tier mismatch: ${result.rationale}`);
    });
  }
});

// ---------------------------------------------------------------------------
// New: risk level comprehensive tests
// ---------------------------------------------------------------------------

describe('classify — critical risk signals', () => {
  const criticalCases = [
    { task: 'update the oauth callback URL', signal: 'oauth' },
    { task: 'store the api key in the vault', signal: 'api key + vault' },
    { task: 'rotate the api-key for the payment service', signal: 'api-key' },
    { task: 'generate a new private key for the TLS cert', signal: 'private key' },
    { task: 'invalidate the jwt after logout', signal: 'jwt' },
    { task: 'fix the session expiry bug', signal: 'session' },
    { task: 'clear the cookie on logout', signal: 'cookie' },
    { task: 'update the vault secrets rotation policy', signal: 'vault' },
    { task: 'check the certificate validity period', signal: 'certificate' },
    { task: 'encrypt the user passwords at rest', signal: 'encrypt + password' },
  ];

  for (const { task, signal } of criticalCases) {
    it(`"${task.slice(0, 60)}" → risk=critical (signal: ${signal})`, () => {
      const result = classify(task);
      assert.equal(
        result.risk,
        'critical',
        `Expected critical for signal "${signal}" but got "${result.risk}". rationale: ${result.rationale}`,
      );
    });
  }
});

describe('classify — high risk signals', () => {
  const highCases = [
    { task: 'deploy the hotfix to production', signal: 'deploy + production' },
    { task: 'deploy the service to the prod environment', signal: 'deploy + prod' },
    { task: 'run the database migration script', signal: 'migration' },
    { task: 'rollback the release to v2.3', signal: 'rollback + release' },
    { task: 'update the terraform plan for the new infra', signal: 'terraform + infra' },
    { task: 'scale the kubernetes cluster', signal: 'kubernetes' },
    { task: 'update the docker image for the API', signal: 'docker' },
    { task: 'run the db migration for the schema change', signal: 'db migration + schema' },
    { task: 'update the billing integration', signal: 'billing' },
    { task: 'add k8s resource limits to the deployment', signal: 'k8s + deployment' },
    { task: 'update infrastructure terraform modules', signal: 'infrastructure + terraform' },
  ];

  for (const { task, signal } of highCases) {
    it(`"${task.slice(0, 60)}" → risk=high (signal: ${signal})`, () => {
      const result = classify(task);
      assert.equal(
        result.risk,
        'high',
        `Expected high for signal "${signal}" but got "${result.risk}". rationale: ${result.rationale}`,
      );
    });
  }
});

describe('classify — plural risk signals', () => {
  const criticalCases = [
    ['rotate API keys and credentials', 'api keys + credentials'],
    ['update auth cookies', 'auth + cookies'],
    ['invalidate active sessions', 'sessions'],
    ['rotate secrets and tokens', 'secrets + tokens'],
    ['reset passwords and certificates', 'passwords + certificates'],
    ['replace private keys in the signer', 'private keys'],
    ['revoke jwts issued yesterday', 'jwts'],
  ] as const;

  for (const [task, signal] of criticalCases) {
    it(`"${task}" → risk=critical (plural signal: ${signal})`, () => {
      const result = classify(task);
      assert.equal(result.risk, 'critical', `rationale: ${result.rationale}`);
    });
  }

  const criticalSingularCases = [
    'rotate the API key and credential',
    'update the auth cookie',
    'invalidate the active session',
    'rotate the secret and token',
    'reset the password and certificate',
    'replace the private key in the signer',
    'revoke the jwt issued yesterday',
  ];

  for (const task of criticalSingularCases) {
    it(`"${task}" → risk=critical (singular still matches)`, () => {
      const result = classify(task);
      assert.equal(result.risk, 'critical', `rationale: ${result.rationale}`);
    });
  }

  const highCases = [
    ['fix payments permissions', 'payments + permissions'],
    ['run the db migrations', 'db migrations'],
    ['run the database migrations', 'database migrations'],
    ['apply schema changes', 'schema'],
    ['review upcoming deployments', 'deployments'],
    ['check release rollbacks', 'releases + rollbacks'],
    ['review failed logins', 'logins'],
  ] as const;

  for (const [task, signal] of highCases) {
    it(`"${task}" → risk=high (plural signal: ${signal})`, () => {
      const result = classify(task);
      assert.equal(result.risk, 'high', `rationale: ${result.rationale}`);
    });
  }

  const highSingularCases = [
    'fix a payment permission',
    'run the db migration',
    'run the database migration',
    'apply a schema change',
    'review the deployment',
    'check the release rollback',
    'review a failed login',
  ];

  for (const task of highSingularCases) {
    it(`"${task}" → risk=high (singular still matches)`, () => {
      const result = classify(task);
      assert.equal(result.risk, 'high', `rationale: ${result.rationale}`);
    });
  }

  const benignCases = [
    'ask the secretary to organize notes',
    'tokenize the parser input',
    'review schematic diagrams',
    'discuss permissionless blockchains',
    'read about deploymental history',
  ];

  for (const task of benignCases) {
    it(`"${task}" does not hit critical/high via partial plural matching`, () => {
      const result = classify(task);
      assert.notEqual(result.risk, 'critical', `rationale: ${result.rationale}`);
      assert.notEqual(result.risk, 'high', `rationale: ${result.rationale}`);
    });
  }
});

describe('classify — medium risk signals', () => {
  const mediumCases = [
    { task: 'add a lint rule for trailing commas', signal: 'lint' },
    { task: 'fix the CI pipeline failure', signal: 'ci' },
    { task: 'update the dependencies to the latest versions', signal: 'dependencies' },
    { task: 'update the shared utility for date formatting', signal: 'shared + util' },
    { task: 'write integration tests for the new parser', signal: 'integration' },
    { task: 'update the build script to output ES modules', signal: 'build' },
    { task: 'fix the spec that was failing intermittently', signal: 'spec' },
    { task: 'add the lib to the main dependency list', signal: 'lib + dependency' },
  ];

  for (const { task, signal } of mediumCases) {
    it(`"${task.slice(0, 60)}" → risk=medium (signal: ${signal})`, () => {
      const result = classify(task);
      assert.equal(
        result.risk,
        'medium',
        `Expected medium for signal "${signal}" but got "${result.risk}". rationale: ${result.rationale}`,
      );
    });
  }
});

describe('classify — low risk (no signals)', () => {
  const lowCases = [
    'refactor the parser to use an AST',
    'implement a basic debounce function',
    'add a helper to format durations',
    'fix the typo in the error message',
    'reorder the function arguments',
    'move the constant to the top of the file',
  ];

  for (const task of lowCases) {
    it(`"${task.slice(0, 60)}" → risk=low`, () => {
      const result = classify(task);
      assert.equal(
        result.risk,
        'low',
        `Expected low risk but got "${result.risk}". rationale: ${result.rationale}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// New: tie-break and scoring tests
// ---------------------------------------------------------------------------

describe('classify — tie-break: manager wins over ic and worker', () => {
  it('"review and design the codebase" → manager (2 distinct soft signals corroborate)', () => {
    // UPDATED: was "review and search the codebase" → manager via lone-keyword
    // tie-break. Manager now needs corroboration; review+design (2 soft) qualifies.
    const result = classify('review and design the codebase');
    assert.equal(result.tier, 'manager');
  });

  it('"review and implement the design" → manager (review + design = 2 distinct soft signals)', () => {
    // review (soft) + design (soft) = 2 distinct soft signals → manager qualifies,
    // and manager outranks the ic signal "implement".
    const result = classify('review and implement the design');
    assert.equal(result.tier, 'manager');
  });

  it('"plan and build the new feature" → ic (lone soft "plan" → not manager; ic signal "build" wins)', () => {
    // UPDATED for the manager-corroboration fix: "plan" alone is a lone soft
    // signal and no longer forces manager; the ic signal "build" makes this ic.
    // (Previously expected manager via lone-keyword tie-break.)
    const result = classify('plan and build the new feature');
    assert.equal(result.tier, 'ic', `rationale: ${result.rationale}`);
  });
});

describe('classify — tie-break: ic wins over worker', () => {
  it('"find and fix the bug" → ic (ic > worker when scores tie)', () => {
    // find = worker signal, fix = ic signal → tie → ic wins
    const result = classify('find and fix the bug');
    assert.equal(result.tier, 'ic');
  });

  it('"search and implement a solution" → ic (ic > worker on tie)', () => {
    const result = classify('search and implement a solution');
    assert.equal(result.tier, 'ic');
  });
});

describe('classify — multi-signal manager wins over single ic signal', () => {
  it('"review, design, and audit across the codebase" → manager (many manager signals)', () => {
    const result = classify('review, design, and audit across the codebase');
    assert.equal(result.tier, 'manager');
  });
});

// ---------------------------------------------------------------------------
// New: word-boundary non-matches (false-positive prevention)
// ---------------------------------------------------------------------------

describe('classify — word-boundary: no false positives', () => {
  it('"press the keyboard shortcut" does not hit "key" critical signal', () => {
    // "keyboard" contains "key" but should not match \bkey\b
    const result = classify('press the keyboard shortcut');
    assert.notEqual(result.risk, 'critical', `rationale: ${result.rationale}`);
  });

  it('"tokenize the input string" does not hit "token" critical signal', () => {
    // "tokenize" contains "token" but should not match \btoken\b
    const result = classify('tokenize the input string');
    assert.notEqual(result.risk, 'critical', `rationale: ${result.rationale}`);
  });

  it('"fix the Docker container startup" → risk=high (docker), not accidentally critical', () => {
    const result = classify('fix the Docker container startup');
    assert.equal(result.risk, 'high', `Expected high (docker) but got ${result.risk}. rationale: ${result.rationale}`);
  });

  it('"list the configuration keys" does not escalate to critical for "key"', () => {
    // "keys" — \bkey\b should not match "keys" at word boundary since the 's' follows
    // Actually \bkey\b WOULD match in "keys" because word boundary is before/after word chars.
    // "keys" → k-e-y-s, \bkey\b would not match because after "y" there's "s" (word char).
    // So "keys" is safe — the boundary at end of "key" is not a word boundary.
    const result = classify('list the configuration keys');
    // "list" → worker, "configuration" → medium (config)
    assert.equal(result.tier, 'worker', `Expected worker but got ${result.tier}. rationale: ${result.rationale}`);
    assert.notEqual(result.risk, 'critical', `Should not hit critical for "keys". rationale: ${result.rationale}`);
  });

  it('"research the problem" does not hit "search" worker signal', () => {
    // "research" contains "search" but \bsearch\b should not match it
    const result = classify('research the problem');
    // No clear tier signal → defaults to ic
    assert.equal(result.tier, 'ic', `Expected ic (no match in research) but got ${result.tier}. rationale: ${result.rationale}`);
  });

  it('"scan and fix the lint warnings" → ic (fix outweighs scan, both match → ic wins by default)', () => {
    // Both "scan" (worker) and "fix" (ic) match; tie → ic > worker
    const result = classify('scan and fix the lint warnings');
    assert.equal(result.tier, 'ic', `Expected ic but got ${result.tier}. rationale: ${result.rationale}`);
  });
});

// ---------------------------------------------------------------------------
// New: empty / whitespace input
// ---------------------------------------------------------------------------

describe('classify — empty / whitespace input', () => {
  it('empty string → tier=ic, risk=low (safe default)', () => {
    const result = classify('');
    assert.equal(result.tier, 'ic');
    assert.equal(result.risk, 'low');
    assert.ok(result.rationale.trim().length > 0, 'rationale must be non-empty');
  });

  it('whitespace-only string → tier=ic, risk=low (safe default)', () => {
    const result = classify('   ');
    assert.equal(result.tier, 'ic');
    assert.equal(result.risk, 'low');
    assert.ok(result.rationale.trim().length > 0, 'rationale must be non-empty');
  });

  it('newline-only string → tier=ic, risk=low (safe default)', () => {
    const result = classify('\n\t\r');
    assert.equal(result.tier, 'ic');
    assert.equal(result.risk, 'low');
  });
});

// ---------------------------------------------------------------------------
// New: rationale names the matched signals (honesty contract)
// ---------------------------------------------------------------------------

describe('classify — rationale names matched signals', () => {
  it('worker task rationale includes the matched word', () => {
    const result = classify('find the config file');
    assert.ok(
      result.rationale.includes('find'),
      `Expected rationale to contain "find" but got: "${result.rationale}"`,
    );
  });

  it('ic task rationale includes the matched word', () => {
    const result = classify('implement the new API endpoint');
    assert.ok(
      result.rationale.includes('implement'),
      `Expected rationale to contain "implement" but got: "${result.rationale}"`,
    );
  });

  it('manager task rationale includes the matched word', () => {
    const result = classify('review the architecture');
    assert.ok(
      result.rationale.includes('review') || result.rationale.includes('architect'),
      `Expected rationale to contain "review" or "architect" but got: "${result.rationale}"`,
    );
  });

  it('critical risk rationale includes the matched word', () => {
    const result = classify('rotate the oauth token');
    assert.ok(
      result.rationale.includes('oauth') || result.rationale.includes('token'),
      `Expected rationale to contain "oauth" or "token" but got: "${result.rationale}"`,
    );
  });

  it('high risk rationale includes the matched word', () => {
    const result = classify('deploy to production');
    assert.ok(
      result.rationale.includes('deploy') || result.rationale.includes('production'),
      `Expected rationale to contain "deploy" or "production" but got: "${result.rationale}"`,
    );
  });

  it('default-ic rationale says "defaulting to ic"', () => {
    const result = classify('frobnicate the wotsit');
    assert.ok(
      result.rationale.includes('defaulting to ic'),
      `Expected "defaulting to ic" in rationale but got: "${result.rationale}"`,
    );
  });

  it('default-low rationale says "defaulting to low"', () => {
    const result = classify('frobnicate the wotsit');
    assert.ok(
      result.rationale.includes('defaulting to low'),
      `Expected "defaulting to low" in rationale but got: "${result.rationale}"`,
    );
  });

  it('rationale uses "matched:" prefix to list signals', () => {
    const result = classify('review and audit the codebase');
    assert.ok(
      result.rationale.includes('matched:'),
      `Expected "matched:" in rationale but got: "${result.rationale}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// New: additional new signal tests
// ---------------------------------------------------------------------------

describe('classify — new critical signals (oauth, api key, jwt, vault, session, cookie)', () => {
  it('"add oauth login flow" → risk=critical', () => {
    assert.equal(classify('add oauth login flow').risk, 'critical');
  });

  it('"store the api key securely" → risk=critical', () => {
    assert.equal(classify('store the api key securely').risk, 'critical');
  });

  it('"parse the api-key from the header" → risk=critical', () => {
    assert.equal(classify('parse the api-key from the header').risk, 'critical');
  });

  it('"decode the jwt claims" → risk=critical', () => {
    assert.equal(classify('decode the jwt claims').risk, 'critical');
  });

  it('"read from the vault" → risk=critical', () => {
    assert.equal(classify('read from the vault').risk, 'critical');
  });

  it('"store session data in redis" → risk=critical', () => {
    assert.equal(classify('store session data in redis').risk, 'critical');
  });

  it('"set the cookie expiry to 30 days" → risk=critical', () => {
    assert.equal(classify('set the cookie expiry to 30 days').risk, 'critical');
  });

  it('"generate private key for signing" → risk=critical', () => {
    assert.equal(classify('generate private key for signing').risk, 'critical');
  });
});

describe('classify — new high signals (production, prod, rollback, infra, terraform, kubernetes, k8s, docker, db migration)', () => {
  it('"push to production" → risk=high', () => {
    assert.equal(classify('push to production').risk, 'high');
  });

  it('"deploy to prod" → risk=high', () => {
    assert.equal(classify('deploy to prod').risk, 'high');
  });

  it('"rollback the broken release" → risk=high', () => {
    assert.equal(classify('rollback the broken release').risk, 'high');
  });

  it('"update infra terraform scripts" → risk=high', () => {
    assert.equal(classify('update infra terraform scripts').risk, 'high');
  });

  it('"scale the kubernetes pods" → risk=high', () => {
    assert.equal(classify('scale the kubernetes pods').risk, 'high');
  });

  it('"update the k8s config map" → risk=high', () => {
    assert.equal(classify('update the k8s config map').risk, 'high');
  });

  it('"build a new docker image" → risk=high', () => {
    assert.equal(classify('build a new docker image').risk, 'high');
  });

  it('"write the db migration for the new schema" → risk=high', () => {
    assert.equal(classify('write the db migration for the new schema').risk, 'high');
  });

  it('"update infrastructure networking rules" → risk=high', () => {
    assert.equal(classify('update infrastructure networking rules').risk, 'high');
  });
});

describe('classify — new medium signals (lint, ci, build, dependencies)', () => {
  it('"run the lint checks" → risk=medium', () => {
    assert.equal(classify('run the lint checks').risk, 'medium');
  });

  it('"fix the CI job that is failing" → risk=medium', () => {
    assert.equal(classify('fix the CI job that is failing').risk, 'medium');
  });

  it('"update the build configuration" → risk=medium', () => {
    assert.equal(classify('update the build configuration').risk, 'medium');
  });

  it('"bump the dependency versions" → risk=medium', () => {
    assert.equal(classify('bump the dependency versions').risk, 'medium');
  });

  it('"audit the dependencies for vulnerabilities" → risk=medium (not high — dependency audit)', () => {
    // "audit" is a manager tier signal; "dependencies" is medium risk signal
    const result = classify('audit the dependencies for vulnerabilities');
    assert.equal(result.tier, 'manager');
    assert.equal(result.risk, 'medium');
  });
});

describe('classify — manager new signals (tradeoff, which approach, should we, strategy)', () => {
  it('"evaluate the tradeoffs between approach A and B" → manager', () => {
    assert.equal(classify('evaluate the tradeoffs between approach A and B').tier, 'manager');
  });

  it('"which approach should we take for state management" → manager', () => {
    assert.equal(classify('which approach should we take for state management').tier, 'manager');
  });

  it('"what strategy should we follow for versioning" → manager', () => {
    assert.equal(classify('what strategy should we follow for versioning').tier, 'manager');
  });

  it('"define the end-to-end testing strategy" → manager', () => {
    assert.equal(classify('define the end-to-end testing strategy').tier, 'manager');
  });
});

// ---------------------------------------------------------------------------
// Manager corroboration rule (anti-overtrigger): a lone soft keyword must NOT
// force the most expensive manager tier on a conversational message.
// ---------------------------------------------------------------------------

describe('classify — manager corroboration rule', () => {
  // --- The exact user-reported bug message: lone "plan" must NOT → manager. ---
  it('"let me know your plan before committing... research 2010 youtube" → ic (NOT manager)', () => {
    const result = classify(
      'let me know your plan before committing the change, then research 2010 youtube',
    );
    assert.equal(
      result.tier,
      'ic',
      `Lone soft signal "plan" must not force manager. rationale: ${result.rationale}`,
    );
    // "research" must NOT trip the worker "search" signal (word boundary).
    assert.notEqual(result.tier, 'worker', `rationale: ${result.rationale}`);
  });

  // --- Lone soft signals → ic ---
  const loneSoftConversational = [
    'can you review this for me',
    'let me know your plan before we start',
    'i think the design feels off, thoughts?',
    'this seems complex, can you help',
    'please assess this when you get a chance',
  ];
  for (const task of loneSoftConversational) {
    it(`lone soft signal: "${task}" → ic (not manager)`, () => {
      const result = classify(task);
      assert.equal(result.tier, 'ic', `rationale: ${result.rationale}`);
    });
  }

  // --- A single STRONG structural signal → manager ---
  const strongSingles = [
    'audit the codebase',
    'threat model this',
    'rethink the architecture',
    'should we migrate now',
    'what is the high-level strategy',
    'compare approaches for caching',
  ];
  for (const task of strongSingles) {
    it(`single strong signal: "${task}" → manager`, () => {
      const result = classify(task);
      assert.equal(result.tier, 'manager', `rationale: ${result.rationale}`);
    });
  }

  // --- Two DISTINCT soft signals → manager ---
  it('"review and design this module" → manager (2 distinct soft signals)', () => {
    assert.equal(classify('review and design this module').tier, 'manager');
  });

  it('"assess the complexity of this" → manager (assess + complex = 2 soft)', () => {
    assert.equal(classify('assess the complexity of this').tier, 'manager');
  });

  // --- Repeating ONE soft word must NOT fake corroboration (de-dup) ---
  it('"review the review of the review" → ic (one distinct soft signal, repeated)', () => {
    // scoreSignals counts each distinct pattern once, so repetition can't reach 2.
    const result = classify('review the review of the review');
    assert.equal(result.tier, 'ic', `rationale: ${result.rationale}`);
  });

  // --- A real architecture/audit request → manager (sanity) ---
  it('"audit the authentication architecture across the codebase" → manager', () => {
    const result = classify('audit the authentication architecture across the codebase');
    assert.equal(result.tier, 'manager', `rationale: ${result.rationale}`);
  });
});
