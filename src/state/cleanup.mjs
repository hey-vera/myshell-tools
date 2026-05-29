/**
 * cleanup.mjs — State maintenance and cleanup operations
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { cleanupOldArchives } from './archive.mjs';

// Temporary mock for getStorageStats until it's implemented
function getStorageStats(workspace) {
  return {
    totalSize: 0,
    fileCount: 0,
    sessionCount: 0,
    archiveCount: 0
  };
}

export { getStorageStats };
import { cleanupStaleLocks, validateSessionIntegrity } from './recovery.mjs';

/**
 * Comprehensive state cleanup
 */
export function performStateCleanup(options = {}) {
  const {
    workspace = process.cwd(),
    maxArchiveAge = 30, // days
    cleanLocks = true,
    cleanTemps = true,
    validateSessions = true,
    verbose = false
  } = options;

  const results = {
    startTime: new Date().toISOString(),
    workspace,
    operations: [],
    errors: [],
    beforeStats: getStorageStats(workspace),
    afterStats: null
  };

  function log(operation, details) {
    results.operations.push({ operation, ...details, timestamp: new Date().toISOString() });
    if (verbose) {
      console.log(`🧹 ${operation}: ${details.message || 'completed'}`);
    }
  }

  function error(operation, err) {
    const errorMsg = err.message || err.toString();
    results.errors.push({ operation, error: errorMsg, timestamp: new Date().toISOString() });
    if (verbose) {
      console.warn(`❌ ${operation}: ${errorMsg}`);
    }
  }

  try {
    // Clean up stale locks
    if (cleanLocks) {
      try {
        const staleLocks = cleanupStaleLocks(workspace);
        log('Lock Cleanup', {
          message: `Removed ${staleLocks.length} stale lock files`,
          count: staleLocks.length,
          files: staleLocks
        });
      } catch (err) {
        error('Lock Cleanup', err);
      }
    }

    // Clean up temporary files
    if (cleanTemps) {
      try {
        const tempCount = cleanupTempFiles(workspace);
        log('Temp File Cleanup', {
          message: `Removed ${tempCount} temporary files`,
          count: tempCount
        });
      } catch (err) {
        error('Temp File Cleanup', err);
      }
    }

    // Clean old archives
    try {
      const archiveCleanup = cleanupOldArchives(maxArchiveAge, workspace);
      log('Archive Cleanup', {
        message: `Deleted ${archiveCleanup.deleted} old archives, preserved ${archiveCleanup.preserved}`,
        deleted: archiveCleanup.deleted,
        preserved: archiveCleanup.preserved,
        errors: archiveCleanup.errors
      });

      if (archiveCleanup.errors.length > 0) {
        for (const err of archiveCleanup.errors) {
          error('Archive Cleanup', { message: err });
        }
      }
    } catch (err) {
      error('Archive Cleanup', err);
    }

    // Validate session integrity
    if (validateSessions) {
      try {
        const integrity = validateSessionIntegrity(workspace);
        log('Session Validation', {
          message: `Session validation ${integrity.valid ? 'passed' : 'failed'}`,
          valid: integrity.valid,
          issues: integrity.issues,
          repairs: integrity.repairs
        });

        if (!integrity.valid) {
          for (const issue of integrity.issues) {
            error('Session Validation', { message: issue });
          }
        }
      } catch (err) {
        error('Session Validation', err);
      }
    }

    // Clean up orphaned plan files
    try {
      const orphanCount = cleanupOrphanedPlans(workspace);
      log('Plan Cleanup', {
        message: `Removed ${orphanCount} orphaned plan files`,
        count: orphanCount
      });
    } catch (err) {
      error('Plan Cleanup', err);
    }

    // Final storage stats
    results.afterStats = getStorageStats(workspace);
    results.spaceSaved = results.beforeStats.totalSize - results.afterStats.totalSize;

    log('Cleanup Complete', {
      message: `Cleanup completed, saved ${formatBytes(results.spaceSaved)}`,
      spaceSaved: results.spaceSaved,
      operationCount: results.operations.length,
      errorCount: results.errors.length
    });

  } catch (globalError) {
    error('Global Cleanup', globalError);
  }

  results.endTime = new Date().toISOString();
  results.duration = new Date(results.endTime) - new Date(results.startTime);

  return results;
}

/**
 * Clean up temporary files (.tmp, .lock, etc.)
 */
function cleanupTempFiles(workspace) {
  const cortexDir = join(workspace, '.cortex');
  if (!existsSync(cortexDir)) return 0;

  let count = 0;

  function cleanDir(dir) {
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          cleanDir(fullPath);
        } else if (isTempFile(entry)) {
          try {
            unlinkSync(fullPath);
            count++;
          } catch {
            // File might be in use
          }
        }
      }
    } catch {
      // Directory access error
    }
  }

  cleanDir(cortexDir);
  return count;
}

/**
 * Check if file is temporary
 */
function isTempFile(filename) {
  return filename.endsWith('.tmp') ||
         filename.includes('.tmp.') ||
         filename.endsWith('.bak') ||
         filename.endsWith('~') ||
         filename.startsWith('.#');
}

/**
 * Clean up orphaned plan files
 */
function cleanupOrphanedPlans(workspace) {
  const plansDir = join(workspace, '.cortex', 'plans');
  if (!existsSync(plansDir)) return 0;

  let count = 0;
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

  try {
    const planFiles = readdirSync(plansDir)
      .filter(f => f.endsWith('.json'))
      .map(f => join(plansDir, f));

    for (const file of planFiles) {
      try {
        const plan = JSON.parse(readFileSync(file, 'utf8'));
        const updated = new Date(plan.updated || plan.created).getTime();

        // Remove plans that are old and completed/failed
        if (updated < oneWeekAgo && (plan.state === 'completed' || plan.state === 'failed')) {
          unlinkSync(file);
          count++;
        }
      } catch {
        // Invalid plan file, remove it
        try {
          unlinkSync(file);
          count++;
        } catch {
          // Can't remove, skip
        }
      }
    }
  } catch {
    // Directory access error
  }

  return count;
}

/**
 * Reset all state (nuclear option)
 */
export function resetAllState(workspace = process.cwd(), preserveAuth = true) {
  const cortexDir = join(workspace, '.cortex');

  if (!existsSync(cortexDir)) {
    return { reset: false, reason: 'No .cortex directory found' };
  }

  const results = {
    reset: true,
    preservedAuth: preserveAuth,
    removedDirs: [],
    preservedDirs: [],
    errors: []
  };

  try {
    const entries = readdirSync(cortexDir);

    for (const entry of entries) {
      const fullPath = join(cortexDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (preserveAuth && entry === 'auth') {
          results.preservedDirs.push(entry);
        } else {
          try {
            rmSync(fullPath, { recursive: true, force: true });
            results.removedDirs.push(entry);
          } catch (error) {
            results.errors.push(`Failed to remove ${entry}: ${error.message}`);
          }
        }
      } else {
        // Remove loose files
        try {
          unlinkSync(fullPath);
        } catch (error) {
          results.errors.push(`Failed to remove file ${entry}: ${error.message}`);
        }
      }
    }

  } catch (error) {
    results.errors.push(`Failed to read .cortex directory: ${error.message}`);
  }

  return results;
}

/**
 * Get detailed cleanup status and recommendations
 */
export function getCleanupStatus(workspace = process.cwd()) {
  const stats = getStorageStats(workspace);
  const cortexDir = join(workspace, '.cortex');

  const status = {
    totalSize: stats.totalSize,
    breakdown: stats.breakdown,
    recommendations: [],
    issues: []
  };

  // Check for large archive directories
  if (stats.breakdown.archives > 10 * 1024 * 1024) { // > 10MB
    status.recommendations.push({
      type: 'cleanup',
      priority: 'medium',
      message: `Archive directory is ${formatBytes(stats.breakdown.archives)}. Consider cleaning old archives.`,
      action: 'Run cleanup with archive age limit'
    });
  }

  // Check for many session files
  const sessionDir = join(cortexDir, 'sessions');
  if (existsSync(sessionDir)) {
    try {
      const sessionFiles = readdirSync(sessionDir).length;
      if (sessionFiles > 50) {
        status.recommendations.push({
          type: 'archive',
          priority: 'low',
          message: `${sessionFiles} session files found. Consider archiving old sessions.`,
          action: 'Archive completed sessions'
        });
      }
    } catch {}
  }

  // Check for stale locks
  const staleLocks = findStaleLocks(workspace);
  if (staleLocks.length > 0) {
    status.issues.push({
      type: 'locks',
      severity: 'warning',
      message: `${staleLocks.length} stale lock files found`,
      action: 'Run cleanup to remove stale locks'
    });
  }

  // Check session integrity
  try {
    const integrity = validateSessionIntegrity(workspace);
    if (!integrity.valid) {
      status.issues.push({
        type: 'integrity',
        severity: 'error',
        message: `Session integrity issues: ${integrity.issues.join(', ')}`,
        action: 'Run cleanup with session validation'
      });
    }
  } catch {}

  return status;
}

/**
 * Find stale lock files
 */
function findStaleLocks(workspace) {
  const staleLocks = [];
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();

  function findLocks(dir) {
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          findLocks(fullPath);
        } else if (entry.endsWith('.lock')) {
          const age = now - stat.mtimeMs;
          if (age > staleThreshold) {
            staleLocks.push(fullPath);
          }
        }
      }
    } catch {}
  }

  findLocks(join(workspace, '.cortex'));
  return staleLocks;
}

/**
 * Format bytes for human-readable display
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Schedule automatic cleanup
 */
export function scheduleAutoCleanup(interval = 24 * 60 * 60 * 1000, options = {}) {
  const cleanup = () => {
    console.log('🧹 Running automatic state cleanup...');
    const results = performStateCleanup({ ...options, verbose: false });

    if (results.errors.length > 0) {
      console.warn(`⚠️  Cleanup completed with ${results.errors.length} errors`);
    } else {
      console.log(`✅ Cleanup completed, saved ${formatBytes(results.spaceSaved)}`);
    }
  };

  // Run cleanup on interval
  const intervalId = setInterval(cleanup, interval);

  // Also run cleanup on process exit
  process.on('exit', () => {
    clearInterval(intervalId);
  });

  return intervalId;
}