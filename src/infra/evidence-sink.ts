import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  buildSnapshotFromVerify,
  type EvidenceFileWriteV2,
  type EvidenceSnapshotV2,
} from '../core/evidence.js';
import type { OrchestrateDeps } from '../core/types.js';
import type { VerifyOutcome } from '../core/verify.js';
import { appendEvidenceV2 } from './evidence-store.js';

function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function hashFileAfter(cwd: string, filePath: string): Promise<string | undefined> {
  try {
    const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
    const root = resolve(cwd);
    if (absolute !== root && !absolute.startsWith(`${root}/`)) return undefined;
    return hashBytes(await readFile(absolute));
  } catch {
    return undefined;
  }
}

async function filesWrittenFromOutcome(
  cwd: string,
  outcome: VerifyOutcome,
): Promise<readonly EvidenceFileWriteV2[]> {
  const paths = outcome.changedPaths ?? [];
  const files = await Promise.all(
    paths.map(async (path): Promise<EvidenceFileWriteV2> => {
      const hashAfter = await hashFileAfter(cwd, path);
      if (hashAfter !== undefined) return { path, hashAfter };
      return { path };
    }),
  );
  return files;
}

function commandsRunFromOutcome(outcome: VerifyOutcome): EvidenceSnapshotV2['commandsRun'] {
  if (outcome.testCommand === undefined || outcome.testRun === undefined) return [];
  return [{
    command: outcome.testCommand,
    tier: 'test-build',
    confirmed: true,
    outcome: outcome.testRun.outcome === 'green' ? 'success' : 'failed',
  }];
}

export function createEvidenceSink(options: {
  readonly cwd: string;
}): NonNullable<OrchestrateDeps['evidenceSink']> {
  return async (snapshot) => {
    await appendEvidenceV2(options.cwd, snapshot);
  };
}

export function createEvidenceSnapshotBuilder(options: {
  readonly cwd: string;
  readonly now: () => number;
}): NonNullable<OrchestrateDeps['evidenceSnapshotBuilder']> {
  return async (input) => {
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
      providersSucceeded,
      filesWritten: await filesWrittenFromOutcome(options.cwd, input.verifyOutcome),
      commandsRun: commandsRunFromOutcome(input.verifyOutcome),
      conclusionsReached: input.conclusionsReached,
      timestamp: options.now(),
    });

    return snapshot;
  };
}
