/**
 * Resolve the provider sandbox for the current host environment.
 *
 * Replit's container is already the isolation boundary, while Codex's nested
 * bubblewrap sandbox is broken there and cannot start. Full access is therefore
 * required and safe inside that boundary; all other hosts retain the requested
 * sandbox unchanged.
 */

import type { SandboxLevel } from '../providers/port.js';
import { isReplit } from './state-dir.js';

export function sandboxForEnvironment(
  requested: SandboxLevel,
  env: NodeJS.ProcessEnv = process.env,
): SandboxLevel {
  return isReplit(env) ? 'full-access' : requested;
}

/** Preserve read-only helper passes unless the parent environment needs full access. */
export function helperSandbox(parent: SandboxLevel): SandboxLevel {
  return parent === 'full-access' ? 'full-access' : 'read-only';
}
