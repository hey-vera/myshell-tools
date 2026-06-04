/**
 * errors.ts — Error types, classification, backoff calculation, and message
 * formatting for provider CLI operations.
 *
 * Pure module: no child_process, no fs, no console.log. All functions return
 * data; callers decide how to display or act on it.
 */

// ---------------------------------------------------------------------------
// Error category discriminated union
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'model'
  | 'permission'
  | 'unknown';

export interface CliError {
  category: ErrorCategory;
  recoverable: boolean;
  message: string;
  suggestion: string;
}

// ---------------------------------------------------------------------------
// Backoff options and calculation
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Base delay in milliseconds for attempt 0. Defaults to 1000. */
  baseMs?: number;
  /** Multiplier applied each attempt. Defaults to 2. */
  multiplier?: number;
  /** Maximum delay in milliseconds. Defaults to 30_000. */
  maxMs?: number;
  /** Jitter fraction (0–1) applied as random ±fraction of the computed delay. Defaults to 0.15. */
  jitter?: number;
}

/**
 * Calculate how long to wait before the next retry attempt.
 *
 * Returns a value in milliseconds. With jitter the actual value will be within
 * `[(1 - jitter) * delay, (1 + jitter) * delay]` where `delay` is the pure
 * exponential value capped at `maxMs`.
 *
 * @param attempt - Zero-based attempt index (0 = first retry).
 */
export function calculateBackoff(attempt: number, opts?: BackoffOptions): number {
  const baseMs = opts?.baseMs ?? 1000;
  const multiplier = opts?.multiplier ?? 2;
  const maxMs = opts?.maxMs ?? 30_000;
  const jitter = opts?.jitter ?? 0.15;

  const exponential = Math.min(baseMs * multiplier ** attempt, maxMs);
  const spread = exponential * jitter;
  // Random value in [-spread, +spread]
  const noise = (Math.random() * 2 - 1) * spread;

  return Math.round(Math.max(0, exponential + noise));
}

// ---------------------------------------------------------------------------
// Internal pattern helpers
// ---------------------------------------------------------------------------

function includesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}

function isAuthStderr(lower: string): boolean {
  // token-related matches require a companion word to avoid false positives
  const tokenExpired =
    lower.includes('token') && (lower.includes('expired') || lower.includes('invalid'));
  const apiKeyProblem =
    lower.includes('api key') &&
    (lower.includes('missing') || lower.includes('required') || lower.includes('invalid'));
  return (
    tokenExpired ||
    apiKeyProblem ||
    includesAny(lower, [
      'authentication',
      'unauthorized',
      '401',
      'invalid credentials',
      'login required',
      'not logged in',
      'not authenticated',
      'please log in',
      'log in to',
    ])
  );
}

function isRateLimitStderr(lower: string): boolean {
  const quotaExceeded = lower.includes('quota') && lower.includes('exceeded');
  return (
    quotaExceeded || includesAny(lower, ['rate limit', '429', 'too many requests'])
  );
}

function isTimeoutStderr(lower: string): boolean {
  // Exclude HTTP gateway codes (502/503/504) — those are network errors even
  // though '504 Gateway Timeout' contains the word 'timeout'.
  if (includesAny(lower, ['502', '503', '504'])) return false;
  return includesAny(lower, ['timeout', 'timed out', 'deadline exceeded']);
}

function isNetworkStderr(lower: string): boolean {
  return includesAny(lower, [
    'network',
    'enotfound',
    'econnreset',
    'econnrefused',
    'enetunreach',
    '502',
    '503',
    '504',
    'internal server error',
  ]);
}

function isModelStderr(lower: string): boolean {
  return includesAny(lower, [
    'model not found',
    'model does not exist',
    'unsupported model',
    'invalid model',
    'context length',
    'context window',
  ]);
}

function isPermissionStderr(lower: string, exitCode: number): boolean {
  return (
    exitCode === 126 ||
    includesAny(lower, [
      'permission denied',
      'access denied',
      'forbidden',
      '403',
    ])
  );
}

// ---------------------------------------------------------------------------
// Per-category error descriptors
// ---------------------------------------------------------------------------

const CATEGORY_DESCRIPTORS: Record<
  ErrorCategory,
  { recoverable: boolean; message: string; suggestion: string }
> = {
  auth: {
    recoverable: false,
    message: 'Authentication failed.',
    suggestion:
      'Re-authenticate with the CLI (e.g. `claude auth login` or `codex login`) and try again.',
  },
  'rate-limit': {
    recoverable: true,
    message: 'Rate limit or quota exceeded.',
    suggestion:
      'Wait before retrying. Consider using a different model tier or reducing request frequency.',
  },
  timeout: {
    recoverable: true,
    message: 'The request timed out.',
    suggestion: 'Simplify the request or increase the timeout threshold and retry.',
  },
  network: {
    recoverable: true,
    message: 'A network or server connectivity error occurred.',
    suggestion: 'Check your internet connection. The server may be temporarily unavailable.',
  },
  model: {
    recoverable: false,
    message: 'The requested model is unavailable or the context limit was exceeded.',
    suggestion:
      'Verify the model name is correct, or shorten the input to fit within the context window.',
  },
  permission: {
    recoverable: false,
    message: 'Permission or access denied.',
    suggestion:
      'Verify your account has access to the requested resource or operation.',
  },
  unknown: {
    recoverable: false,
    message: 'An unexpected error occurred.',
    suggestion:
      'Review the stderr output for details. If the problem persists, report it with the full error text.',
  },
};

// ---------------------------------------------------------------------------
// Public classification function
// ---------------------------------------------------------------------------

/**
 * Classify a CLI failure into a structured {@link CliError}.
 *
 * @param stderr   - The stderr output from the CLI process (may be empty).
 * @param exitCode - The numeric exit code of the process.
 */
export function classifyError(stderr: string, exitCode: number): CliError {
  const lower = stderr.toLowerCase();

  let category: ErrorCategory;

  if (isAuthStderr(lower)) {
    category = 'auth';
  } else if (isRateLimitStderr(lower)) {
    category = 'rate-limit';
  } else if (isTimeoutStderr(lower)) {
    category = 'timeout';
  } else if (isNetworkStderr(lower)) {
    category = 'network';
  } else if (isModelStderr(lower)) {
    category = 'model';
  } else if (isPermissionStderr(lower, exitCode)) {
    category = 'permission';
  } else {
    category = 'unknown';
  }

  const descriptor = CATEGORY_DESCRIPTORS[category];

  return {
    category,
    recoverable: descriptor.recoverable,
    message: descriptor.message,
    suggestion: descriptor.suggestion,
  };
}

// ---------------------------------------------------------------------------
// Friendly message formatting
// ---------------------------------------------------------------------------

/**
 * Format a {@link CliError} into a human-readable string suitable for display.
 * Does not include ANSI codes so it works in any context.
 *
 * @param error    - A classified CLI error.
 * @param provider - Optional provider name for contextual detail (e.g. `'claude'`).
 */
export function formatErrorMessage(error: CliError, provider?: string): string {
  const label = provider ? provider.toUpperCase() : 'CLI';
  const lines: string[] = [`${label} Error [${error.category}]: ${error.message}`];

  lines.push(`Suggestion: ${error.suggestion}`);

  if (error.recoverable) {
    lines.push('This error may be transient. Retrying with backoff is appropriate.');
  }

  return lines.join('\n');
}
