/**
 * recovery.mjs — State recovery and interrupted work resumption
 */

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { atomicWriteJSON, lockedReadModifyWrite } from './atomic.mjs';
import { loadSession, addMessage } from './session.mjs';

/**
 * Plan state management
 */
const PLAN_STATES = {
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted'
};

/**
 * Get plans directory for the workspace
 */
function getPlansDir(workspace = process.cwd()) {
  return join(workspace, '.cortex', 'plans');
}

/**
 * Get work state directory
 */
function getWorkStateDir(workspace = process.cwd()) {
  return join(workspace, '.cortex', 'work-state');
}

/**
 * Create a plan file for tracking work
 */
export function createPlan(planId, description, tasks = [], metadata = {}) {
  const plansDir = getPlansDir();
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }

  const plan = {
    id: planId,
    description,
    tasks,
    state: PLAN_STATES.PENDING,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    progress: {
      completed: 0,
      total: tasks.length,
      currentTask: null
    },
    metadata
  };

  const planPath = join(plansDir, `${planId}.json`);
  atomicWriteJSON(planPath, plan);

  return plan;
}

/**
 * Update plan state atomically
 */
export function updatePlan(planId, updates, workspace = process.cwd()) {
  const plansDir = getPlansDir(workspace);
  const planPath = join(plansDir, `${planId}.json`);

  if (!existsSync(planPath)) {
    throw new Error(`Plan ${planId} not found`);
  }

  return lockedReadModifyWrite(planPath, (current) => {
    return {
      ...current,
      ...updates,
      updated: new Date().toISOString()
    };
  });
}

/**
 * Get all plans with optional state filter
 */
export function getPlans(state = null, workspace = process.cwd()) {
  const plansDir = getPlansDir(workspace);

  if (!existsSync(plansDir)) {
    return [];
  }

  try {
    const planFiles = readdirSync(plansDir)
      .filter(f => f.endsWith('.json'))
      .map(f => join(plansDir, f));

    const plans = planFiles.map(file => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean);

    return state ? plans.filter(p => p.state === state) : plans;
  } catch {
    return [];
  }
}

/**
 * Find interrupted plans
 */
export function findInterruptedPlans(workspace = process.cwd()) {
  return getPlans(PLAN_STATES.IN_FLIGHT, workspace)
    .concat(getPlans(PLAN_STATES.INTERRUPTED, workspace))
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

/**
 * Mark plan as interrupted (called on process exit)
 */
export function markPlanInterrupted(planId, currentTask = null, workspace = process.cwd()) {
  try {
    updatePlan(planId, {
      state: PLAN_STATES.INTERRUPTED,
      progress: {
        ...getPlans().find(p => p.id === planId)?.progress,
        currentTask
      }
    }, workspace);
  } catch (error) {
    console.warn(`Failed to mark plan ${planId} as interrupted:`, error.message);
  }
}

/**
 * Archive completed or failed plans
 */
export function archivePlans(planIds, workspace = process.cwd()) {
  const plansDir = getPlansDir(workspace);
  const archiveDir = join(plansDir, 'archive');

  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  const archived = [];

  for (const planId of planIds) {
    const planPath = join(plansDir, `${planId}.json`);
    const archivePath = join(archiveDir, `${planId}-${Date.now()}.json`);

    try {
      if (existsSync(planPath)) {
        const plan = JSON.parse(readFileSync(planPath, 'utf8'));
        plan.archived = new Date().toISOString();
        atomicWriteJSON(archivePath, plan);
        unlinkSync(planPath);
        archived.push(planId);
      }
    } catch (error) {
      console.warn(`Failed to archive plan ${planId}:`, error.message);
    }
  }

  return archived;
}

/**
 * Clean up stale lock files
 */
export function cleanupStaleLocks(workspace = process.cwd()) {
  const staleThresholdMs = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();
  const cleaned = [];

  function findAndCleanLocks(dir) {
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const path = join(dir, entry);
        const stat = statSync(path);

        if (stat.isDirectory()) {
          findAndCleanLocks(path);
        } else if (entry.endsWith('.lock')) {
          const age = now - stat.mtimeMs;
          if (age > staleThresholdMs) {
            try {
              unlinkSync(path);
              cleaned.push(path);
            } catch {
              // Lock might be in use, skip
            }
          }
        }
      }
    } catch {
      // Directory access error, skip
    }
  }

  findAndCleanLocks(join(workspace, '.cortex'));
  return cleaned;
}

/**
 * Recover interrupted work with user interaction
 */
export async function recoverInterruptedWork(workspace = process.cwd()) {
  const interrupted = findInterruptedPlans(workspace);

  if (interrupted.length === 0) {
    return { hasInterrupted: false, recovered: [], archived: [] };
  }

  console.log(`\n🔄 Found ${interrupted.length} interrupted work session(s):`);

  for (const [index, plan] of interrupted.entries()) {
    const age = Math.round((Date.now() - new Date(plan.updated)) / 1000 / 60);
    const progress = plan.progress ? `${plan.progress.completed}/${plan.progress.total}` : 'unknown';
    console.log(`  ${index + 1}. ${plan.description} (${age}m ago, progress: ${progress})`);
  }

  // For now, provide manual recovery options
  console.log('\nRecovery options:');
  console.log('1. Resume the most recent session');
  console.log('2. Archive all interrupted sessions and start fresh');
  console.log('3. Show detailed recovery information');

  // In a full implementation, you'd use readline for user input
  // For now, auto-archive old sessions (>24h) and show info for recent ones
  const oldSessions = interrupted.filter(p =>
    Date.now() - new Date(p.updated) > 24 * 60 * 60 * 1000
  );

  const recentSessions = interrupted.filter(p =>
    Date.now() - new Date(p.updated) <= 24 * 60 * 60 * 1000
  );

  let archived = [];
  if (oldSessions.length > 0) {
    console.log(`\n🗄️  Auto-archiving ${oldSessions.length} old session(s)...`);
    archived = archivePlans(oldSessions.map(p => p.id), workspace);
  }

  if (recentSessions.length > 0) {
    console.log('\n💡 Recent sessions available for manual recovery:');
    console.log('   Use --resume <plan-id> to resume a specific session');
    console.log('   Use --archive-all to archive all interrupted sessions');

    for (const plan of recentSessions) {
      console.log(`   Plan: ${plan.id}`);
      console.log(`   Description: ${plan.description}`);
      if (plan.progress?.currentTask) {
        console.log(`   Last task: ${plan.progress.currentTask}`);
      }
      console.log('');
    }
  }

  return {
    hasInterrupted: true,
    interrupted: recentSessions,
    recovered: [],
    archived: archived
  };
}

/**
 * Resume a specific plan
 */
export function resumePlan(planId, workspace = process.cwd()) {
  const plans = getPlans(null, workspace);
  const plan = plans.find(p => p.id === planId);

  if (!plan) {
    throw new Error(`Plan ${planId} not found`);
  }

  if (plan.state !== PLAN_STATES.INTERRUPTED) {
    throw new Error(`Plan ${planId} is not in interrupted state (current: ${plan.state})`);
  }

  // Update plan to in-flight
  updatePlan(planId, { state: PLAN_STATES.IN_FLIGHT }, workspace);

  addMessage('system', `Resuming interrupted work: ${plan.description}`, {
    type: 'recovery',
    planId: plan.id,
    progress: plan.progress
  });

  return plan;
}

/**
 * Validate session integrity and repair if possible
 */
export function validateSessionIntegrity(workspace = process.cwd()) {
  const issues = [];
  const repairs = [];

  try {
    // Check session file integrity
    const messages = loadSession(workspace);
    let hasCorruption = false;

    // Look for parsing errors or malformed entries
    const sessionPath = join(workspace, '.cortex', 'sessions', 'current.jsonl');
    if (existsSync(sessionPath)) {
      const content = readFileSync(sessionPath, 'utf8');
      const lines = content.trim().split('\n');

      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line);
          if (!message.timestamp || !message.role || message.content === undefined) {
            issues.push(`Invalid message format at line ${index + 1}`);
            hasCorruption = true;
          }
        } catch {
          issues.push(`JSON parsing error at line ${index + 1}`);
          hasCorruption = true;
        }
      }
    }

    // Check for orphaned lock files
    const staleLocks = cleanupStaleLocks(workspace);
    if (staleLocks.length > 0) {
      repairs.push(`Cleaned ${staleLocks.length} stale lock file(s)`);
    }

    // Check for corrupted state files
    const stateDir = join(workspace, '.cortex');
    if (existsSync(stateDir)) {
      const stateFiles = readdirSync(stateDir)
        .filter(f => f.endsWith('.json'))
        .map(f => join(stateDir, f));

      for (const file of stateFiles) {
        try {
          JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          issues.push(`Corrupted state file: ${basename(file)}`);
        }
      }
    }

  } catch (error) {
    issues.push(`Session validation failed: ${error.message}`);
  }

  return {
    valid: issues.length === 0,
    issues,
    repairs,
    canRecover: issues.length > 0 && issues.every(issue =>
      issue.includes('stale lock') || issue.includes('orphaned')
    )
  };
}

/**
 * Create checkpoint for current state
 */
export function createCheckpoint(description, metadata = {}, workspace = process.cwd()) {
  const checkpointDir = join(workspace, '.cortex', 'checkpoints');
  if (!existsSync(checkpointDir)) {
    mkdirSync(checkpointDir, { recursive: true });
  }

  const checkpoint = {
    id: `checkpoint-${Date.now()}`,
    description,
    timestamp: new Date().toISOString(),
    session: loadSession(workspace),
    plans: getPlans(null, workspace),
    metadata
  };

  const checkpointPath = join(checkpointDir, `${checkpoint.id}.json`);
  atomicWriteJSON(checkpointPath, checkpoint);

  return checkpoint;
}

/**
 * Setup graceful shutdown handlers
 */
export function setupGracefulShutdown(currentPlanId = null) {
  const handleShutdown = (signal) => {
    console.log(`\n🛑 Received ${signal}, saving state...`);

    if (currentPlanId) {
      markPlanInterrupted(currentPlanId);
    }

    // Create emergency checkpoint
    try {
      createCheckpoint(`Emergency checkpoint on ${signal}`, { signal, emergency: true });
      console.log('✅ State saved successfully');
    } catch (error) {
      console.warn('⚠️  Failed to save state:', error.message);
    }

    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('\n💥 Uncaught exception:', error);

    if (currentPlanId) {
      markPlanInterrupted(currentPlanId);
    }

    try {
      createCheckpoint(`Emergency checkpoint on uncaught exception`, {
        error: error.message,
        stack: error.stack,
        emergency: true
      });
      console.log('✅ Emergency state saved');
    } catch {
      console.warn('⚠️  Failed to save emergency state');
    }

    process.exit(1);
  });
}

/**
 * Recovery status summary
 */
export function getRecoveryStatus(workspace = process.cwd()) {
  const interrupted = findInterruptedPlans(workspace);
  const integrity = validateSessionIntegrity(workspace);

  return {
    hasInterruptedWork: interrupted.length > 0,
    interruptedCount: interrupted.length,
    sessionIntegrity: integrity.valid,
    issues: integrity.issues,
    lastInterrupted: interrupted[0]?.updated || null,
    canAutoRecover: integrity.canRecover && interrupted.length === 0
  };
}