/**
 * session.mjs — Session persistence and management
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { atomicAppendJSONL, atomicWriteJSON } from './atomic.mjs';

/**
 * Get the session directory for the current working directory
 */
function getSessionDir(cwd = process.cwd()) {
  return join(cwd, '.cortex', 'sessions');
}

/**
 * Get the current session file path
 */
function getCurrentSessionPath(cwd = process.cwd()) {
  const sessionDir = getSessionDir(cwd);
  return join(sessionDir, 'current.jsonl');
}

/**
 * Ensure session directory exists
 */
function ensureSessionDir(cwd = process.cwd()) {
  const sessionDir = getSessionDir(cwd);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Add a message to the current session
 */
export function addMessage(role, content, metadata = {}) {
  ensureSessionDir();
  const sessionPath = getCurrentSessionPath();

  const message = {
    timestamp: new Date().toISOString(),
    role, // 'user', 'assistant', or 'system'
    content,
    ...metadata
  };

  atomicAppendJSONL(sessionPath, message);
}

/**
 * Load the current session messages
 */
export function loadSession(cwd = process.cwd()) {
  const sessionPath = getCurrentSessionPath(cwd);

  if (!existsSync(sessionPath)) {
    return [];
  }

  try {
    const content = readFileSync(sessionPath, 'utf8');
    return content
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch (err) {
    console.warn(`Failed to load session: ${err.message}`);
    return [];
  }
}

/**
 * Archive the current session and start a new one
 */
export function archiveSession(cwd = process.cwd()) {
  const sessionDir = ensureSessionDir(cwd);
  const currentPath = getCurrentSessionPath(cwd);

  if (!existsSync(currentPath)) {
    return null; // No current session to archive
  }

  // Create archive filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(sessionDir, 'archive');
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  const archivePath = join(archiveDir, `session-${timestamp}.jsonl`);

  try {
    // Move current session to archive
    const content = readFileSync(currentPath, 'utf8');
    writeFileSync(archivePath, content);

    // Remove current session file
    writeFileSync(currentPath, '');

    return archivePath;
  } catch (err) {
    console.warn(`Failed to archive session: ${err.message}`);
    return null;
  }
}

/**
 * Get session summary for display
 */
export function getSessionSummary(cwd = process.cwd()) {
  const messages = loadSession(cwd);

  if (messages.length === 0) {
    return { messageCount: 0, firstMessage: null, lastMessage: null };
  }

  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  return {
    messageCount: messages.length,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length,
    firstMessage: messages[0],
    lastMessage: messages[messages.length - 1],
    duration: messages.length > 1 ?
      new Date(messages[messages.length - 1].timestamp).getTime() -
      new Date(messages[0].timestamp).getTime() : 0
  };
}

/**
 * Add a handoff event to the session for transparency
 */
export function addHandoff(operation, fromTier, toTier, reason, metadata = {}) {
  addMessage('system', `HANDOFF: ${operation} from ${fromTier} to ${toTier}`, {
    type: 'handoff',
    operation, // 'delegate', 'escalate', 'bounce'
    fromTier,
    toTier,
    reason,
    ...metadata
  });
}