import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  buildSnapshotFromVerify,
  type EvidenceSnapshot,
} from '../core/evidence.js';
import type { OrchestrateDeps } from '../core/types.js';
import type { VerifyOutcome } from '../core/verify.js';
import type { ProviderId } from '../providers/port.js';
import { appendEvidence } from './evidence-store.js';

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function hashFileAfter(cwd: string, filePath: string): Promise<string> {
  try {
    const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    const root = resolve(cwd);
    if (absolute !== root && !absolute.startsWith(`${root}/`)) return '';
    return hashBytes(await readFile(absolute));
  } catch {
    return '';
  }
}

async function filesWrittenFromOutcome(
  cwd: string,
  outcome: VerifyOutcome,
): Promise<EvidenceSnapshot['filesWritten']> {
  const paths = outcome.changedPaths ?? [];
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      // No pre-turn hash is captured yet. Keep the placeholder explicit rather
      // than inventing a before-state.
      hashBefore: '',
      hashAfter: await hashFileAfter(cwd, path),
    })),
  );
  return files;
}

function commandsRunFromOutcome(outcome: VerifyOutcome): EvidenceSnapshot['commandsRun'] {
  if (outcome.testCommand === undefined || outcome.testRun === undefined) return [];
  return [{
    command: outcome.testCommand,
    tier: 'test-build',
    confirmed: true,
    outcome: outcome.testRun.outcome === 'green' ? 'success' : 'failed',
  }];
}

function providerModeFromAvailable(
  availableProviders: readonly ProviderId[],
): EvidenceSnapshot['providerMode'] {
  if (availableProviders.length === 0) return 'zero';
  if (availableProviders.length === 1) return 'solo';
  return 'multi';
}

export function createEvidenceSink(options: {
  readonly evidenceHomeDir: string;
}): NonNullable<OrchestrateDeps['evidenceSink']> {
  return async (snapshot) => {
    await appendEvidence(options.evidenceHomeDir, snapshot);
  };
}

export function createEvidenceSnapshotBuilder(options: {
  readonly cwd: string;
  readonly now: () => number;
}): NonNullable<OrchestrateDeps['evidenceSnapshotBuilder']> {
  return async (input) => {
    const providerSet = new Set<string>(input.availableProviders);
    providerSet.add(input.provider);
    if (input.verifyOutcome.critic?.vendor !== undefined) {
      providerSet.add(input.verifyOutcome.critic.vendor);
    }

    const providersAttempted = [...providerSet];
    const providersSucceeded = [
      input.provider,
      ...(input.verifyOutcome.critic?.vendor !== undefined
        ? [input.verifyOutcome.critic.vendor]
        : []),
    ];

    const snapshot = buildSnapshotFromVerify({
      taskId: input.taskId,
      turnNumber: input.turnNumber,
      verifyOutcome: input.verifyOutcome,
      providerMode: providerModeFromAvailable(input.availableProviders),
      providersAttempted,
      providersSucceeded,
      providersFailed: [],
      // Future improvement: capture pre-turn read/file hashes from the command
      // audit stream. For now, only post-verify changed-file hashes are grounded.
      filesReadPre: [],
      filesWritten: await filesWrittenFromOutcome(options.cwd, input.verifyOutcome),
      commandsRun: commandsRunFromOutcome(input.verifyOutcome),
      conclusionsReached: input.conclusionsReached,
      timestamp: options.now(),
    });

    return snapshot;
  };
}
