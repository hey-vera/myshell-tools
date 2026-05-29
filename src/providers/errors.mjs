/**
 * errors.mjs — Comprehensive error handling and recovery for provider operations
 */

import { spawnSync } from 'child_process';
import { handleAuthFailure, getRecoverySuggestions } from '../auth/recovery.mjs';

/**
 * Custom error class for CLI operations
 */
export class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CliError';
    this.details = details;
    this.isRecoverable = details.isRecoverable || false;
    this.provider = details.provider;
    this.command = details.command;
    this.args = details.args;
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
    this.originalError = details.originalError;
  }
}

/**
 * Detailed error for subprocess failures
 */
export class DetailedCliError extends CliError {
  constructor(error, command, args, provider) {
    const details = {
      command,
      args: args?.slice() || [],
      provider,
      originalError: error,
      isRecoverable: isRecoverableError(error),
      exitCode: error.status || error.code || -1,
      stderr: error.stderr || error.message || ''
    };

    let message = `${provider?.toUpperCase() || 'CLI'} command failed`;

    if (command && args) {
      message += `: ${command} ${args.join(' ')}`;
    }

    if (error.message) {
      message += ` - ${error.message}`;
    }

    super(message, details);
  }
}

/**
 * Check if an error is recoverable with retries
 */
export function isRecoverableError(error) {
  if (!error) return false;

  const errorString = error.toString().toLowerCase();
  const stderr = error.stderr?.toLowerCase() || '';
  const combined = errorString + ' ' + stderr;

  // Network-related errors (recoverable)
  if (combined.includes('timeout') ||
      combined.includes('network') ||
      combined.includes('enotfound') ||
      combined.includes('econnreset') ||
      combined.includes('econnrefused')) {
    return true;
  }

  // Temporary server issues (recoverable)
  if (combined.includes('502') ||
      combined.includes('503') ||
      combined.includes('504') ||
      combined.includes('internal server error')) {
    return true;
  }

  // Rate limiting (recoverable with delay)
  if (combined.includes('rate limit') ||
      combined.includes('429') ||
      combined.includes('too many requests')) {
    return true;
  }

  // Temporary auth token issues (recoverable with refresh)
  if (combined.includes('token expired') ||
      combined.includes('invalid token') ||
      combined.includes('token not found')) {
    return true;
  }

  // Process spawning issues (sometimes recoverable)
  if (error.code === 'EAGAIN' || error.code === 'EMFILE') {
    return true;
  }

  return false;
}

/**
 * Sleep with jitter for backoff
 */
function sleep(ms) {
  const jitter = Math.floor(Math.random() * (ms * 0.1)); // 10% jitter
  return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

/**
 * Robust subprocess execution with retry and recovery
 */
export async function executeWithRecovery(command, args, options = {}) {
  const {
    provider,
    maxRetries = 3,
    timeoutMs = 120000,
    backoffMs = [1000, 2000, 4000],
    cwd = process.cwd(),
    onRetry
  } = options;

  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const proc = spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
        cwd,
      });

      // Success case
      if (proc.status === 0) {
        return proc;
      }

      // Create detailed error for failed command
      const error = new Error(`Process exited with code ${proc.status}`);
      error.status = proc.status;
      error.stderr = proc.stderr;
      lastError = new DetailedCliError(error, command, args, provider);

      // Check if this is an auth error
      if (isAuthError(proc.stderr)) {
        const recovery = await handleAuthFailure(provider, proc.stderr);
        if (recovery.recovered) {
          continue; // Retry after successful recovery
        }
      }

      // Check if recoverable
      if (!isRecoverableError(lastError)) {
        throw lastError;
      }

      // Backoff before retry
      if (attempt < maxRetries - 1) {
        const backoff = backoffMs[Math.min(attempt, backoffMs.length - 1)];
        if (onRetry) {
          onRetry(attempt + 1, lastError, backoff);
        }
        await sleep(backoff);
      }

    } catch (spawnError) {
      lastError = new DetailedCliError(spawnError, command, args, provider);

      // Handle specific spawn errors
      if (spawnError.code === 'ENOENT') {
        // CLI not found - not recoverable with retries
        throw lastError;
      }

      if (!isRecoverableError(spawnError) || attempt === maxRetries - 1) {
        throw lastError;
      }

      // Retry for recoverable spawn errors
      if (attempt < maxRetries - 1) {
        const backoff = backoffMs[Math.min(attempt, backoffMs.length - 1)];
        if (onRetry) {
          onRetry(attempt + 1, lastError, backoff);
        }
        await sleep(backoff);
      }
    }
  }

  throw lastError;
}

/**
 * Check if error is authentication-related
 */
function isAuthError(stderr) {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();

  return lower.includes('authentication') ||
         lower.includes('unauthorized') ||
         lower.includes('401') ||
         lower.includes('invalid credentials') ||
         lower.includes('login required') ||
         lower.includes('access denied') ||
         lower.includes('forbidden') ||
         lower.includes('token') && (lower.includes('expired') || lower.includes('invalid'));
}

/**
 * Check if error is a rate limit
 */
function isRateLimitError(stderr) {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();

  return lower.includes('rate limit') ||
         lower.includes('429') ||
         lower.includes('too many requests') ||
         lower.includes('quota') && lower.includes('exceeded');
}

/**
 * Parse and classify CLI output for better error handling
 */
export function parseCliOutput(stdout, stderr, exitCode) {
  const result = {
    success: exitCode === 0,
    output: stdout || '',
    stderr: stderr || '',
    exitCode,
    error: null,
    errorType: null,
    isRecoverable: false,
    suggestions: []
  };

  if (exitCode !== 0 || stderr) {
    const errorText = stderr || 'Process failed';
    result.error = errorText;
    result.isRecoverable = isRecoverableError({ stderr, status: exitCode });

    // Classify error type
    if (isAuthError(stderr)) {
      result.errorType = 'auth';
      result.suggestions.push('Re-authenticate with the CLI');
    } else if (isRateLimitError(stderr)) {
      result.errorType = 'rate_limit';
      result.suggestions.push('Wait before retrying');
      result.suggestions.push('Consider using a different model tier');
    } else if (stderr.toLowerCase().includes('timeout')) {
      result.errorType = 'timeout';
      result.suggestions.push('Increase timeout or simplify the request');
    } else if (stderr.toLowerCase().includes('network')) {
      result.errorType = 'network';
      result.suggestions.push('Check internet connection');
    } else if (exitCode === 127 || stderr.toLowerCase().includes('command not found')) {
      result.errorType = 'cli_missing';
      result.suggestions.push('Install the required CLI tool');
    } else {
      result.errorType = 'unknown';
      result.suggestions = getRecoverySuggestions(stderr);
    }
  }

  return result;
}

/**
 * Create user-friendly error message
 */
export function createFriendlyErrorMessage(error, provider) {
  let message = `❌ ${provider?.toUpperCase() || 'CLI'} Error`;

  if (error instanceof CliError) {
    switch (error.details.errorType || 'unknown') {
      case 'cli_missing':
        message += '\n\n📦 CLI not installed or not found in PATH';
        if (provider === 'claude') {
          message += '\n   Install: pip install anthropic-cli';
          message += '\n   Then: claude auth login';
        } else if (provider === 'codex') {
          message += '\n   Install: npm install -g @openai/codex';
          message += '\n   Then: codex login';
        }
        break;

      case 'auth':
        message += '\n\n🔐 Authentication failed';
        message += `\n   Run: ${provider === 'claude' ? 'claude auth login' : 'codex login'}`;
        break;

      case 'rate_limit':
        message += '\n\n⏱️  Rate limit exceeded';
        message += '\n   Wait a few minutes before retrying';
        message += '\n   Consider using a different model tier';
        break;

      case 'timeout':
        message += '\n\n⏰ Request timed out';
        message += '\n   Try simplifying your request or increasing timeout';
        break;

      case 'network':
        message += '\n\n🌐 Network connectivity issue';
        message += '\n   Check your internet connection and try again';
        break;

      default:
        message += '\n\n💥 Unexpected error occurred';
        if (error.message) {
          message += `\n   ${error.message}`;
        }
    }

    if (error.details.suggestions?.length > 0) {
      message += '\n\n💡 Suggestions:';
      for (const suggestion of error.details.suggestions) {
        message += `\n   • ${suggestion}`;
      }
    }

    if (error.details.isRecoverable) {
      message += '\n\n🔄 This error might be temporary. Cortex will retry automatically.';
    }

  } else {
    message += `\n   ${error.message || 'Unknown error occurred'}`;
  }

  return message;
}

/**
 * Graceful error handling wrapper for provider functions
 */
export function withErrorHandling(fn, provider) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof CliError) {
        throw error; // Already handled
      }

      // Convert generic errors to CLI errors
      const cliError = new CliError(error.message || 'Operation failed', {
        provider,
        originalError: error,
        isRecoverable: isRecoverableError(error)
      });

      throw cliError;
    }
  };
}

/**
 * Progress callback for retries
 */
export function defaultRetryCallback(attempt, error, backoffMs) {
  const provider = error.provider?.toUpperCase() || 'CLI';
  console.log(`⚠️  ${provider} attempt ${attempt} failed, retrying in ${backoffMs}ms...`);

  if (error.details?.errorType === 'rate_limit') {
    console.log('   Rate limit detected, backing off...');
  } else if (error.details?.errorType === 'network') {
    console.log('   Network issue detected, retrying...');
  }
}