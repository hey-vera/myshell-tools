/**
 * src/infra/command-audit.ts - append-only command execution audit recorder.
 *
 * This is intentionally separate from the model-cost ledger: command safety events
 * are operational audit data, not provider spend.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandAuditEvent } from '../core/command-gate.js';
import { atomicAppendJSONL } from './atomic.js';
import { getStateDir } from './paths.js';

interface CommandAuditRecorder {
  record(event: CommandAuditEvent): Promise<void>;
}

function getCommandAuditFile(cwd: string): string {
  return join(getStateDir(cwd), 'command-audit.jsonl');
}

export function createCommandAuditRecorder(opts: { readonly cwd: string }): CommandAuditRecorder {
  const { cwd } = opts;

  return {
    async record(event: CommandAuditEvent): Promise<void> {
      await mkdir(getStateDir(cwd), { recursive: true });
      await atomicAppendJSONL(getCommandAuditFile(cwd), event);
    },
  };
}
