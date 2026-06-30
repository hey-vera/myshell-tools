/**
 * src/infra/command-audit.ts - append-only command execution audit recorder.
 *
 * This is intentionally separate from the model-cost ledger: command safety events
 * are operational audit data, not provider spend.
 */

import { mkdir } from 'node:fs/promises';
import type { CommandAuditEvent } from '../core/command-gate.js';
import { atomicAppendJSONL } from './atomic.js';
import { defaultStateLayout, projectStateDirs } from './state-layout.js';

interface CommandAuditRecorder {
  record(event: CommandAuditEvent): Promise<void>;
}

export function createCommandAuditRecorder(opts: { readonly cwd: string }): CommandAuditRecorder {
  const { cwd } = opts;
  const file = projectStateDirs(defaultStateLayout(), cwd).commandAuditFile;

  return {
    async record(event: CommandAuditEvent): Promise<void> {
      await mkdir(projectStateDirs(defaultStateLayout(), cwd).root, { recursive: true });
      await atomicAppendJSONL(file, event);
    },
  };
}
