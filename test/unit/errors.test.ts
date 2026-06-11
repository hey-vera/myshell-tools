/**
 * Unit tests for src/providers/errors.ts
 * Run with: node --test (Node >= 20 required)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  calculateBackoff,
  formatErrorMessage,
  type ErrorCategory,
  type CliError,
} from '../../src/providers/errors.ts';

// ---------------------------------------------------------------------------
// classifyError — table-driven tests
// ---------------------------------------------------------------------------

interface ClassifyCase {
  desc: string;
  stderr: string;
  exitCode: number;
  expectedCategory: ErrorCategory;
  expectedRecoverable: boolean;
}

const classifyCases: ClassifyCase[] = [
  // Auth
  {
    desc: 'HTTP 401 in stderr',
    stderr: 'Error: 401 Unauthorized',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'authentication keyword',
    stderr: 'Authentication failed: bad credentials',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'invalid credentials phrase',
    stderr: 'Invalid credentials provided',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'login required',
    stderr: 'Login required to continue',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'not logged in',
    stderr: 'Not logged in.',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'not authenticated',
    stderr: 'Request failed: not authenticated',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'please log in',
    stderr: 'Please log in to continue',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'log in to',
    stderr: 'Log in to use this provider',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'api key missing',
    stderr: 'API key missing for selected provider',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'api key required',
    stderr: 'API key is required',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'api key invalid',
    stderr: 'API key invalid',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'token expired',
    stderr: 'Your token has expired, please refresh',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  {
    desc: 'token invalid',
    stderr: 'Provided token is invalid',
    exitCode: 1,
    expectedCategory: 'auth',
    expectedRecoverable: false,
  },
  // Rate limit
  {
    desc: 'rate limit phrase',
    stderr: 'Rate limit exceeded for this API key',
    exitCode: 1,
    expectedCategory: 'rate-limit',
    expectedRecoverable: true,
  },
  {
    desc: 'HTTP 429',
    stderr: 'HTTP 429 Too Many Requests',
    exitCode: 1,
    expectedCategory: 'rate-limit',
    expectedRecoverable: true,
  },
  {
    desc: 'quota exceeded',
    stderr: 'Monthly quota exceeded',
    exitCode: 1,
    expectedCategory: 'rate-limit',
    expectedRecoverable: true,
  },
  {
    desc: 'too many requests phrase',
    stderr: 'Too many requests. Slow down.',
    exitCode: 1,
    expectedCategory: 'rate-limit',
    expectedRecoverable: true,
  },
  // Timeout
  {
    desc: 'timeout keyword',
    stderr: 'Request timeout after 30s',
    exitCode: 1,
    expectedCategory: 'timeout',
    expectedRecoverable: true,
  },
  {
    desc: 'timed out phrase',
    stderr: 'The operation timed out',
    exitCode: 1,
    expectedCategory: 'timeout',
    expectedRecoverable: true,
  },
  {
    desc: 'deadline exceeded',
    stderr: 'Deadline exceeded for stream',
    exitCode: 1,
    expectedCategory: 'timeout',
    expectedRecoverable: true,
  },
  // Network
  {
    desc: 'network keyword',
    stderr: 'Network error: connection lost',
    exitCode: 1,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  {
    desc: 'ENOTFOUND',
    stderr: 'getaddrinfo ENOTFOUND api.example.com',
    exitCode: 1,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  {
    desc: 'ECONNRESET',
    stderr: 'read ECONNRESET',
    exitCode: 1,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  {
    desc: 'ECONNREFUSED',
    stderr: 'connect ECONNREFUSED 127.0.0.1:443',
    exitCode: 1,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  {
    desc: 'HTTP 503',
    stderr: '503 Service Unavailable',
    exitCode: 1,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  {
    desc: 'HTTP 502',
    stderr: 'Bad Gateway 502',
    exitCode: 1,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  {
    desc: 'HTTP 504',
    stderr: '504 Gateway Timeout',
    exitCode: 1,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  {
    desc: 'internal server error',
    stderr: 'Internal Server Error',
    exitCode: 500,
    expectedCategory: 'network',
    expectedRecoverable: true,
  },
  // Model
  {
    desc: 'model not found',
    stderr: 'Model not found: claude-99',
    exitCode: 1,
    expectedCategory: 'model',
    expectedRecoverable: false,
  },
  {
    desc: 'unsupported model',
    stderr: 'Unsupported model requested',
    exitCode: 1,
    expectedCategory: 'model',
    expectedRecoverable: false,
  },
  {
    desc: 'context length exceeded',
    stderr: 'This model has a context length of 8192 tokens',
    exitCode: 1,
    expectedCategory: 'model',
    expectedRecoverable: false,
  },
  {
    desc: 'context window exceeded',
    stderr: 'Exceeded context window limit',
    exitCode: 1,
    expectedCategory: 'model',
    expectedRecoverable: false,
  },
  // Permission
  {
    desc: 'permission denied keyword',
    stderr: 'Permission denied',
    exitCode: 1,
    expectedCategory: 'permission',
    expectedRecoverable: false,
  },
  {
    desc: 'access denied keyword',
    stderr: 'Access denied to resource',
    exitCode: 1,
    expectedCategory: 'permission',
    expectedRecoverable: false,
  },
  {
    desc: 'HTTP 403',
    stderr: '403 Forbidden',
    exitCode: 1,
    expectedCategory: 'permission',
    expectedRecoverable: false,
  },
  {
    desc: 'exit code 126 (not executable)',
    stderr: '',
    exitCode: 126,
    expectedCategory: 'permission',
    expectedRecoverable: false,
  },
  // Sandbox environment
  {
    desc: 'bubblewrap capability startup failure',
    stderr: 'bwrap: Unexpected capabilities but not setuid, old file caps config?',
    exitCode: 1,
    expectedCategory: 'sandbox-environment',
    expectedRecoverable: false,
  },
  {
    desc: 'general bubblewrap startup failure',
    stderr: 'bwrap: Creating new namespace failed: Operation not permitted',
    exitCode: 1,
    expectedCategory: 'sandbox-environment',
    expectedRecoverable: false,
  },
  // Unknown / fallback
  {
    desc: 'empty stderr, exit 1',
    stderr: '',
    exitCode: 1,
    expectedCategory: 'unknown',
    expectedRecoverable: false,
  },
  {
    desc: 'unrecognised stderr text',
    stderr: 'Something went terribly sideways',
    exitCode: 1,
    expectedCategory: 'unknown',
    expectedRecoverable: false,
  },
  {
    desc: 'api key mention without auth-state failure',
    stderr: 'Using API key from environment',
    exitCode: 1,
    expectedCategory: 'unknown',
    expectedRecoverable: false,
  },
];

describe('classifyError', () => {
  for (const tc of classifyCases) {
    it(tc.desc, () => {
      const result = classifyError(tc.stderr, tc.exitCode);
      assert.equal(result.category, tc.expectedCategory, 'category mismatch');
      assert.equal(result.recoverable, tc.expectedRecoverable, 'recoverable mismatch');
    });
  }

  it('returns a non-empty message for every case', () => {
    for (const tc of classifyCases) {
      const result = classifyError(tc.stderr, tc.exitCode);
      assert.ok(result.message.length > 0, `empty message for: ${tc.desc}`);
    }
  });

  it('returns a non-empty suggestion for every case', () => {
    for (const tc of classifyCases) {
      const result = classifyError(tc.stderr, tc.exitCode);
      assert.ok(result.suggestion.length > 0, `empty suggestion for: ${tc.desc}`);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyError — every category has a non-empty suggestion
// ---------------------------------------------------------------------------

describe('classifyError — every ErrorCategory produces a non-empty suggestion', () => {
  // Map each category to a representative stderr / exitCode pair
  const categoryProbes: Record<ErrorCategory, { stderr: string; exitCode: number }> = {
    auth: { stderr: '401 Unauthorized', exitCode: 1 },
    'rate-limit': { stderr: 'Rate limit exceeded', exitCode: 1 },
    timeout: { stderr: 'Request timeout', exitCode: 1 },
    network: { stderr: 'ECONNRESET', exitCode: 1 },
    model: { stderr: 'Model not found', exitCode: 1 },
    permission: { stderr: 'Permission denied', exitCode: 1 },
    'sandbox-environment': { stderr: 'bwrap: sandbox startup failed', exitCode: 1 },
    unknown: { stderr: 'completely unrecognised gibberish xyz123', exitCode: 1 },
  };

  for (const [category, probe] of Object.entries(categoryProbes) as [
    ErrorCategory,
    { stderr: string; exitCode: number },
  ][]) {
    it(`category '${category}' has a non-empty suggestion`, () => {
      const result = classifyError(probe.stderr, probe.exitCode);
      assert.equal(result.category, category);
      assert.ok(result.suggestion.trim().length > 0);
    });
  }
});

// ---------------------------------------------------------------------------
// calculateBackoff — range and bounds tests
// ---------------------------------------------------------------------------

describe('calculateBackoff', () => {
  it('attempt 0 with defaults stays near 1000ms', () => {
    // With default jitter=0.15 the value is in [850, 1150]
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoff(0);
      assert.ok(ms >= 850 && ms <= 1150, `attempt 0 out of range: ${ms}`);
    }
  });

  it('attempt 1 with defaults stays near 2000ms', () => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoff(1);
      assert.ok(ms >= 1700 && ms <= 2300, `attempt 1 out of range: ${ms}`);
    }
  });

  it('attempt 2 with defaults stays near 4000ms', () => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoff(2);
      assert.ok(ms >= 3400 && ms <= 4600, `attempt 2 out of range: ${ms}`);
    }
  });

  it('respects maxMs cap', () => {
    for (let i = 0; i < 50; i++) {
      // attempt 100 would be astronomically large without cap
      const ms = calculateBackoff(100, { maxMs: 5000 });
      assert.ok(
        ms <= 5000 * 1.15 + 1,
        `exceeded maxMs at attempt 100: ${ms}`,
      );
    }
  });

  it('returns 0 or positive values only', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const ms = calculateBackoff(attempt);
      assert.ok(ms >= 0, `negative backoff at attempt ${attempt}: ${ms}`);
    }
  });

  it('custom baseMs and multiplier are respected', () => {
    // baseMs=500, multiplier=3, attempt=1 => 1500ms ± 15%
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoff(1, { baseMs: 500, multiplier: 3, jitter: 0.15 });
      assert.ok(ms >= 1275 && ms <= 1725, `custom opts out of range: ${ms}`);
    }
  });

  it('zero jitter returns exact exponential value', () => {
    const ms = calculateBackoff(2, { baseMs: 1000, multiplier: 2, maxMs: 30_000, jitter: 0 });
    assert.equal(ms, 4000);
  });
});

// ---------------------------------------------------------------------------
// formatErrorMessage
// ---------------------------------------------------------------------------

describe('formatErrorMessage', () => {
  it('includes category in output', () => {
    const error: CliError = classifyError('Rate limit exceeded', 1);
    const msg = formatErrorMessage(error);
    assert.ok(msg.includes('rate-limit'), 'expected category in output');
  });

  it('includes provider label when provided', () => {
    const error: CliError = classifyError('401 Unauthorized', 1);
    const msg = formatErrorMessage(error, 'claude');
    assert.ok(msg.includes('CLAUDE'), 'expected provider label in output');
  });

  it('includes suggestion text', () => {
    const error: CliError = classifyError('timeout', 1);
    const msg = formatErrorMessage(error);
    assert.ok(msg.includes(error.suggestion), 'expected suggestion in output');
  });

  it('mentions retrying for recoverable errors', () => {
    const error: CliError = classifyError('Rate limit exceeded', 1);
    assert.ok(error.recoverable, 'precondition: rate-limit should be recoverable');
    const msg = formatErrorMessage(error);
    assert.ok(
      msg.toLowerCase().includes('retry') || msg.toLowerCase().includes('retrying'),
      'expected retry mention for recoverable error',
    );
  });

  it('does not mention retrying for non-recoverable errors', () => {
    const error: CliError = classifyError('401 Unauthorized', 1);
    assert.ok(!error.recoverable, 'precondition: auth should not be recoverable');
    const msg = formatErrorMessage(error);
    assert.ok(
      !msg.toLowerCase().includes('retrying'),
      'unexpected retry mention for non-recoverable error',
    );
  });
});
