/**
 * archive.mjs — Session archiving and long-term state management
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteJSON } from './atomic.mjs';
import { loadSession, getSessionSummary } from './session.mjs';

/**
 * Get archive directory
 */
function getArchiveDir(workspace = process.cwd()) {
  const archiveDir = join(workspace, '.cortex', 'archive');
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
  return archiveDir;
}

/**
 * Create a comprehensive session archive
 */
export function createSessionArchive(reason = 'manual', metadata = {}, workspace = process.cwd()) {
  const summary = getSessionSummary(workspace);

  if (summary.messageCount === 0) {
    return { archived: false, reason: 'No session data to archive' };
  }

  const archiveId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
  const archiveDir = getArchiveDir(workspace);

  const archive = {
    id: archiveId,
    timestamp: new Date().toISOString(),
    reason,
    summary,
    messages: loadSession(workspace),
    workspace: workspace,
    metadata: {
      ...metadata,
      cortexVersion: '1.0.0',
      nodeVersion: process.version,
      platform: process.platform
    }
  };

  // Add performance metrics if available
  if (summary.duration) {
    archive.performance = {
      totalDuration: summary.duration,
      avgResponseTime: summary.duration / Math.max(summary.assistantMessageCount, 1),
      messagesPerMinute: (summary.messageCount / (summary.duration / 60000)).toFixed(2)
    };
  }

  const archivePath = join(archiveDir, `${archiveId}.json`);
  atomicWriteJSON(archivePath, archive);

  // Create human-readable summary
  const summaryPath = join(archiveDir, `${archiveId}-summary.md`);
  const summaryContent = createMarkdownSummary(archive);
  writeFileSync(summaryPath, summaryContent);

  return {
    archived: true,
    archiveId,
    archivePath,
    summaryPath,
    messageCount: summary.messageCount,
    duration: summary.duration
  };
}

/**
 * Create markdown summary of the session
 */
function createMarkdownSummary(archive) {
  const { summary, messages, performance, reason, timestamp } = archive;

  let content = `# Cortex Session Archive\n\n`;
  content += `**Archive ID:** ${archive.id}\n`;
  content += `**Created:** ${new Date(timestamp).toLocaleString()}\n`;
  content += `**Reason:** ${reason}\n`;
  content += `**Workspace:** ${archive.workspace}\n\n`;

  content += `## Summary\n\n`;
  content += `- **Total Messages:** ${summary.messageCount}\n`;
  content += `- **User Messages:** ${summary.userMessageCount}\n`;
  content += `- **Assistant Messages:** ${summary.assistantMessageCount}\n`;

  if (summary.duration) {
    const durationMin = Math.round(summary.duration / 60000);
    content += `- **Duration:** ${durationMin} minutes\n`;
  }

  if (performance) {
    content += `\n## Performance\n\n`;
    content += `- **Average Response Time:** ${Math.round(performance.avgResponseTime / 1000)}s\n`;
    content += `- **Messages Per Minute:** ${performance.messagesPerMinute}\n`;
  }

  // Add sample of conversations
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length > 0) {
    content += `\n## Conversation Topics\n\n`;
    const sampleSize = Math.min(5, userMessages.length);
    const samples = userMessages.slice(0, sampleSize);

    for (const [index, msg] of samples.entries()) {
      const preview = msg.content.length > 80 ?
        msg.content.substring(0, 80) + '...' :
        msg.content;
      content += `${index + 1}. ${preview}\n`;
    }

    if (userMessages.length > sampleSize) {
      content += `\n_(${userMessages.length - sampleSize} more messages not shown)_\n`;
    }
  }

  // Add handoff statistics if available
  const handoffMessages = messages.filter(m => m.type === 'handoff');
  if (handoffMessages.length > 0) {
    content += `\n## Hierarchy Activity\n\n`;
    content += `- **Total Handoffs:** ${handoffMessages.length}\n`;

    const escalations = handoffMessages.filter(m => m.operation === 'escalate').length;
    const delegations = handoffMessages.filter(m => m.operation === 'delegate').length;
    const bounces = handoffMessages.filter(m => m.operation === 'bounce').length;

    if (escalations > 0) content += `- **Escalations:** ${escalations}\n`;
    if (delegations > 0) content += `- **Delegations:** ${delegations}\n`;
    if (bounces > 0) content += `- **Bounces:** ${bounces}\n`;
  }

  content += `\n## Archive Details\n\n`;
  content += `Full conversation data is available in: \`${archive.id}.json\`\n`;

  return content;
}

/**
 * List available archives with metadata
 */
export function listArchives(workspace = process.cwd()) {
  const archiveDir = getArchiveDir(workspace);

  if (!existsSync(archiveDir)) {
    return [];
  }

  try {
    const archiveFiles = readdirSync(archiveDir)
      .filter(f => f.endsWith('.json') && f.startsWith('session-'))
      .map(f => join(archiveDir, f))
      .map(filePath => {
        try {
          const archive = JSON.parse(readFileSync(filePath, 'utf8'));
          const stat = statSync(filePath);

          return {
            id: archive.id,
            timestamp: archive.timestamp,
            reason: archive.reason,
            messageCount: archive.summary.messageCount,
            duration: archive.summary.duration,
            fileSize: stat.size,
            filePath
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return archiveFiles;
  } catch {
    return [];
  }
}

/**
 * Get archive by ID
 */
export function getArchive(archiveId, workspace = process.cwd()) {
  const archiveDir = getArchiveDir(workspace);
  const archivePath = join(archiveDir, `${archiveId}.json`);

  if (!existsSync(archivePath)) {
    throw new Error(`Archive ${archiveId} not found`);
  }

  try {
    return JSON.parse(readFileSync(archivePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to load archive ${archiveId}: ${error.message}`);
  }
}

/**
 * Delete old archives to manage storage
 */
export function cleanupOldArchives(maxAge = 30, workspace = process.cwd()) {
  const archiveDir = getArchiveDir(workspace);
  const maxAgeMs = maxAge * 24 * 60 * 60 * 1000; // Convert days to ms
  const cutoff = Date.now() - maxAgeMs;

  if (!existsSync(archiveDir)) {
    return { deleted: 0, preserved: 0, errors: [] };
  }

  const archives = listArchives(workspace);
  let deleted = 0;
  let preserved = 0;
  const errors = [];

  for (const archive of archives) {
    const archiveDate = new Date(archive.timestamp).getTime();

    if (archiveDate < cutoff) {
      try {
        const archivePath = archive.filePath;
        const summaryPath = archivePath.replace('.json', '-summary.md');

        // Delete both files
        if (existsSync(archivePath)) {
          require('fs').unlinkSync(archivePath);
        }
        if (existsSync(summaryPath)) {
          require('fs').unlinkSync(summaryPath);
        }

        deleted++;
      } catch (error) {
        errors.push(`Failed to delete ${archive.id}: ${error.message}`);
      }
    } else {
      preserved++;
    }
  }

  return { deleted, preserved, errors };
}

/**
 * Export archives to external format
 */
export function exportArchives(format = 'json', outputPath = null, workspace = process.cwd()) {
  const archives = listArchives(workspace);

  if (archives.length === 0) {
    return { exported: false, reason: 'No archives to export' };
  }

  const exportData = {
    exported: new Date().toISOString(),
    cortexVersion: '1.0.0',
    workspace: workspace,
    archiveCount: archives.length,
    archives: archives.map(meta => {
      try {
        return getArchive(meta.id, workspace);
      } catch (error) {
        return { error: error.message, id: meta.id };
      }
    })
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = outputPath || join(workspace, `.cortex-export-${timestamp}.${format}`);

  try {
    if (format === 'json') {
      writeFileSync(filename, JSON.stringify(exportData, null, 2));
    } else {
      throw new Error(`Unsupported export format: ${format}`);
    }

    return {
      exported: true,
      filename,
      archiveCount: archives.length,
      fileSize: require('fs').statSync(filename).size
    };
  } catch (error) {
    return {
      exported: false,
      error: error.message
    };
  }
}

/**
 * Get storage usage statistics
 */
export function getStorageStats(workspace = process.cwd()) {
  const cortexDir = join(workspace, '.cortex');

  if (!existsSync(cortexDir)) {
    return { totalSize: 0, breakdown: {} };
  }

  const stats = {
    totalSize: 0,
    breakdown: {
      sessions: 0,
      archives: 0,
      plans: 0,
      auth: 0,
      other: 0
    }
  };

  function calculateDirSize(dir, category = 'other') {
    if (!existsSync(dir)) return 0;

    let size = 0;
    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          size += calculateDirSize(fullPath, category);
        } else {
          size += stat.size;
        }
      }
    } catch {
      // Permission or access error
    }

    stats.breakdown[category] += size;
    return size;
  }

  // Calculate sizes by category
  calculateDirSize(join(cortexDir, 'sessions'), 'sessions');
  calculateDirSize(join(cortexDir, 'archive'), 'archives');
  calculateDirSize(join(cortexDir, 'plans'), 'plans');
  calculateDirSize(join(cortexDir, 'auth'), 'auth');

  // Calculate other files
  try {
    const cortexEntries = readdirSync(cortexDir);
    for (const entry of cortexEntries) {
      const fullPath = join(cortexDir, entry);
      const stat = statSync(fullPath);

      if (stat.isFile()) {
        stats.breakdown.other += stat.size;
      }
    }
  } catch {
    // Access error
  }

  stats.totalSize = Object.values(stats.breakdown).reduce((sum, size) => sum + size, 0);

  return stats;
}