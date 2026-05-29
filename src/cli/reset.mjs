/**
 * reset.mjs — Clean slate reset functionality
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { resetAllState, performStateCleanup } from '../state/cleanup.mjs';
import { createSessionArchive } from '../state/archive.mjs';
import { getSessionSummary } from '../state/session.mjs';

/**
 * Colors for terminal output
 */
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

/**
 * Reset options and their descriptions
 */
const RESET_OPTIONS = {
  sessions: {
    name: 'Sessions Only',
    description: 'Clear current session but keep archives and auth',
    dangerous: false
  },
  state: {
    name: 'State Files',
    description: 'Clear all state files but keep auth and archives',
    dangerous: false
  },
  all: {
    name: 'Full Reset',
    description: 'Clear everything except authentication',
    dangerous: true
  },
  nuclear: {
    name: 'Nuclear Reset',
    description: 'Clear absolutely everything including authentication',
    dangerous: true
  }
};

/**
 * Perform reset based on specified level
 */
export async function performReset(level = 'sessions', options = {}) {
  const {
    workspace = process.cwd(),
    force = false,
    archive = true,
    verbose = false
  } = options;

  console.log(`${colors.bold}${colors.blue}🔄 Cortex Reset Tool${colors.reset}\n`);

  if (!RESET_OPTIONS[level]) {
    throw new Error(`Unknown reset level: ${level}. Available: ${Object.keys(RESET_OPTIONS).join(', ')}`);
  }

  const resetConfig = RESET_OPTIONS[level];
  const cortexDir = join(workspace, '.cortex');

  // Check if there's anything to reset
  if (!existsSync(cortexDir)) {
    console.log(`${colors.yellow}⚠️  No .cortex directory found in workspace.${colors.reset}`);
    console.log(`${colors.dim}Nothing to reset.${colors.reset}\n`);
    return { reset: false, reason: 'No Cortex data found' };
  }

  // Show what will be reset
  console.log(`${colors.bold}Reset Level: ${resetConfig.name}${colors.reset}`);
  console.log(`${colors.dim}${resetConfig.description}${colors.reset}\n`);

  // Archive current session if requested and data exists
  let archiveResult = null;
  if (archive && level !== 'sessions') {
    const sessionSummary = getSessionSummary(workspace);
    if (sessionSummary.messageCount > 0) {
      console.log('📦 Archiving current session...');
      archiveResult = createSessionArchive('pre-reset', { resetLevel: level }, workspace);

      if (archiveResult.archived) {
        console.log(`${colors.green}✅ Session archived: ${archiveResult.archiveId}${colors.reset}`);
      } else {
        console.log(`${colors.yellow}⚠️  Archive failed: ${archiveResult.reason}${colors.reset}`);
      }
      console.log();
    }
  }

  // Safety confirmation for dangerous operations
  if (resetConfig.dangerous && !force) {
    console.log(`${colors.red}${colors.bold}⚠️  WARNING: This is a destructive operation!${colors.reset}`);
    console.log(`${colors.red}This will permanently delete Cortex data.${colors.reset}\n`);

    // In a real implementation, you'd prompt for confirmation
    // For now, require explicit --force flag for dangerous operations
    console.log(`${colors.yellow}To proceed, use --force flag:${colors.reset}`);
    console.log(`${colors.cyan}  cortex --reset ${level} --force${colors.reset}\n`);

    return { reset: false, reason: 'Confirmation required (use --force)' };
  }

  // Perform the reset
  console.log('🧹 Performing reset...\n');

  const results = {
    startTime: new Date().toISOString(),
    level,
    workspace,
    operations: [],
    archive: archiveResult,
    errors: []
  };

  try {
    switch (level) {
      case 'sessions':
        await resetSessions(workspace, results, verbose);
        break;

      case 'state':
        await resetState(workspace, results, verbose);
        break;

      case 'all':
        await resetAll(workspace, results, verbose);
        break;

      case 'nuclear':
        await resetNuclear(workspace, results, verbose);
        break;
    }

    // Final cleanup
    const cleanupResults = performStateCleanup({
      workspace,
      verbose: false,
      cleanLocks: true,
      cleanTemps: true
    });

    results.operations.push({
      operation: 'cleanup',
      details: cleanupResults,
      timestamp: new Date().toISOString()
    });

    if (verbose) {
      console.log(`🧹 Cleaned up ${cleanupResults.operations.length} items`);
    }

  } catch (error) {
    results.errors.push({
      operation: 'reset',
      error: error.message,
      timestamp: new Date().toISOString()
    });

    console.log(`${colors.red}❌ Reset failed: ${error.message}${colors.reset}\n`);
    return { reset: false, error: error.message, results };
  }

  results.endTime = new Date().toISOString();

  // Display results
  displayResetResults(results);

  return { reset: true, results };
}

/**
 * Reset sessions only
 */
async function resetSessions(workspace, results, verbose) {
  const sessionDir = join(workspace, '.cortex', 'sessions');

  if (existsSync(sessionDir)) {
    try {
      require('fs').rmSync(sessionDir, { recursive: true, force: true });
      require('fs').mkdirSync(sessionDir, { recursive: true });

      results.operations.push({
        operation: 'reset_sessions',
        message: 'Cleared session directory',
        timestamp: new Date().toISOString()
      });

      if (verbose) {
        console.log('✅ Sessions cleared');
      }

    } catch (error) {
      results.errors.push({
        operation: 'reset_sessions',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
}

/**
 * Reset state files
 */
async function resetState(workspace, results, verbose) {
  const stateItems = ['sessions', 'plans', 'work-state', 'checkpoints'];

  for (const item of stateItems) {
    const itemPath = join(workspace, '.cortex', item);

    if (existsSync(itemPath)) {
      try {
        require('fs').rmSync(itemPath, { recursive: true, force: true });

        results.operations.push({
          operation: 'reset_state',
          item,
          message: `Cleared ${item} directory`,
          timestamp: new Date().toISOString()
        });

        if (verbose) {
          console.log(`✅ ${item} cleared`);
        }

      } catch (error) {
        results.errors.push({
          operation: 'reset_state',
          item,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }
  }
}

/**
 * Reset all except auth
 */
async function resetAll(workspace, results, verbose) {
  const resetResult = resetAllState(workspace, true); // Preserve auth

  results.operations.push({
    operation: 'reset_all',
    message: 'Performed full reset (preserved auth)',
    details: resetResult,
    timestamp: new Date().toISOString()
  });

  if (resetResult.errors.length > 0) {
    results.errors.push(...resetResult.errors.map(err => ({
      operation: 'reset_all',
      error: err,
      timestamp: new Date().toISOString()
    })));
  }

  if (verbose) {
    console.log(`✅ Reset completed`);
    console.log(`   Removed: ${resetResult.removedDirs.join(', ')}`);
    console.log(`   Preserved: ${resetResult.preservedDirs.join(', ')}`);
  }
}

/**
 * Nuclear reset (everything)
 */
async function resetNuclear(workspace, results, verbose) {
  const resetResult = resetAllState(workspace, false); // Don't preserve auth

  results.operations.push({
    operation: 'reset_nuclear',
    message: 'Performed nuclear reset (including auth)',
    details: resetResult,
    timestamp: new Date().toISOString()
  });

  if (resetResult.errors.length > 0) {
    results.errors.push(...resetResult.errors.map(err => ({
      operation: 'reset_nuclear',
      error: err,
      timestamp: new Date().toISOString()
    })));
  }

  if (verbose) {
    console.log(`✅ Nuclear reset completed`);
    console.log(`   Removed: ${resetResult.removedDirs.join(', ')}`);

    if (resetResult.preservedDirs.length > 0) {
      console.log(`   Preserved: ${resetResult.preservedDirs.join(', ')}`);
    }
  }

  console.log(`${colors.yellow}⚠️  Authentication cleared - you'll need to re-authenticate CLIs${colors.reset}`);
}

/**
 * Display reset results
 */
function displayResetResults(results) {
  console.log(`${colors.bold}${colors.green}✅ Reset Completed${colors.reset}\n`);

  console.log(`${colors.bold}Summary:${colors.reset}`);
  console.log(`  Level: ${RESET_OPTIONS[results.level].name}`);
  console.log(`  Operations: ${results.operations.length}`);
  console.log(`  Errors: ${results.errors.length}`);

  if (results.archive?.archived) {
    console.log(`  Archive: ${results.archive.archiveId}`);
  }

  console.log();

  // Show operations if there were any
  if (results.operations.length > 0) {
    console.log(`${colors.bold}Operations Performed:${colors.reset}`);
    results.operations.forEach((op, index) => {
      console.log(`  ${index + 1}. ${op.message || op.operation}`);
    });
    console.log();
  }

  // Show errors if any
  if (results.errors.length > 0) {
    console.log(`${colors.bold}${colors.red}Errors:${colors.reset}`);
    results.errors.forEach((err, index) => {
      console.log(`  ${index + 1}. ${err.operation}: ${err.error}`);
    });
    console.log();
  }

  // Next steps
  console.log(`${colors.bold}Next Steps:${colors.reset}`);

  if (results.level === 'nuclear') {
    console.log(`  1. Re-authenticate CLIs:`);
    console.log(`     ${colors.cyan}claude auth login${colors.reset}`);
    console.log(`     ${colors.cyan}codex login${colors.reset}`);
    console.log(`  2. Start fresh: ${colors.cyan}cortex${colors.reset}`);
  } else if (results.level === 'all') {
    console.log(`  1. Start fresh: ${colors.cyan}cortex${colors.reset}`);
    console.log(`  2. Your authentication is preserved`);
  } else {
    console.log(`  1. Continue working: ${colors.cyan}cortex${colors.reset}`);
    console.log(`  2. Your settings and auth are preserved`);
  }

  console.log();
  console.log(`${colors.dim}Reset completed: ${new Date().toLocaleString()}${colors.reset}`);
}

/**
 * List what would be reset (dry run)
 */
export function previewReset(level = 'sessions', workspace = process.cwd()) {
  console.log(`${colors.bold}${colors.blue}🔍 Reset Preview${colors.reset}\n`);

  const resetConfig = RESET_OPTIONS[level];
  const cortexDir = join(workspace, '.cortex');

  console.log(`${colors.bold}Reset Level: ${resetConfig.name}${colors.reset}`);
  console.log(`${colors.dim}${resetConfig.description}${colors.reset}\n`);

  if (!existsSync(cortexDir)) {
    console.log(`${colors.yellow}⚠️  No .cortex directory found - nothing to reset${colors.reset}\n`);
    return { hasData: false };
  }

  console.log(`${colors.bold}Items that would be affected:${colors.reset}`);

  const items = [];

  try {
    const entries = require('fs').readdirSync(cortexDir);

    entries.forEach(entry => {
      const fullPath = join(cortexDir, entry);
      const stat = require('fs').statSync(fullPath);

      if (stat.isDirectory()) {
        const shouldAffect = wouldAffectItem(entry, level);
        const status = shouldAffect ? '❌ Will be removed' : '✅ Will be preserved';
        const color = shouldAffect ? colors.red : colors.green;

        console.log(`  ${color}${entry}/${colors.reset} - ${color}${status}${colors.reset}`);
        items.push({ name: entry, affected: shouldAffect });
      }
    });

  } catch (error) {
    console.log(`${colors.red}❌ Error reading directory: ${error.message}${colors.reset}`);
  }

  if (resetConfig.dangerous) {
    console.log(`\n${colors.red}${colors.bold}⚠️  WARNING: This is a destructive operation!${colors.reset}`);
    console.log(`${colors.red}Use --force to proceed with this reset level.${colors.reset}`);
  }

  console.log();
  return { hasData: true, items };
}

/**
 * Check if an item would be affected by reset level
 */
function wouldAffectItem(item, level) {
  switch (level) {
    case 'sessions':
      return item === 'sessions';

    case 'state':
      return ['sessions', 'plans', 'work-state', 'checkpoints'].includes(item);

    case 'all':
      return item !== 'auth';

    case 'nuclear':
      return true;

    default:
      return false;
  }
}

/**
 * Get available reset levels
 */
export function getResetLevels() {
  return Object.entries(RESET_OPTIONS).map(([key, config]) => ({
    level: key,
    name: config.name,
    description: config.description,
    dangerous: config.dangerous
  }));
}