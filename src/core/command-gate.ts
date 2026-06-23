/**
 * src/core/command-gate.ts - pure command enforcement policy.
 *
 * Turns the command classifier's tier into an enforcement decision. This module
 * performs no I/O and makes no time/random decisions; wiring into exec sites is
 * intentionally left to the impure ports.
 */

import { classifyCommand } from './classify.js';
import type { CommandTier } from './types.js';

export interface CommandGateDecision {
  readonly commandTier: CommandTier;
  readonly allowed: boolean;
  readonly requireConfirmation: boolean;
  readonly forbidBackground: boolean;
  readonly mustRecord: boolean;
  readonly rationale: string;
}

interface CommandGatePolicy {
  readonly requireConfirmation: boolean;
  readonly forbidBackground: boolean;
  readonly mustRecord: boolean;
  readonly rationale: string;
}

function policyForTier(tier: CommandTier): CommandGatePolicy {
  switch (tier) {
    case 'credential-sensitive':
    case 'destructive-filesystem':
      return {
        requireConfirmation: true,
        forbidBackground: true,
        mustRecord: true,
        rationale: `${tier}: high-risk command; always confirm, run in foreground, and record.`,
      };

    case 'dependency-install':
      return {
        requireConfirmation: true,
        forbidBackground: false,
        mustRecord: true,
        rationale: `${tier}: state-changing dependency operation; confirm and record.`,
      };

    case 'local-write':
      return {
        requireConfirmation: false,
        forbidBackground: false,
        mustRecord: true,
        rationale: `${tier}: mutates local files; record for the audit trail.`,
      };

    case 'test-build':
      return {
        requireConfirmation: false,
        forbidBackground: false,
        mustRecord: false,
        rationale: `${tier}: test/build command; no confirmation or audit record required.`,
      };

    case 'read-only':
      return {
        requireConfirmation: false,
        forbidBackground: false,
        mustRecord: false,
        rationale: `${tier}: read-only command; no confirmation or audit record required.`,
      };
  }
}

export function gateCommand(
  command: string,
  opts?: { readonly requestedBackground?: boolean },
): CommandGateDecision {
  const { commandTier } = classifyCommand(command);
  const policy = policyForTier(commandTier);
  const backgroundNote = opts?.requestedBackground === true && policy.forbidBackground
    ? ' Background execution was requested but is forbidden for this tier.'
    : '';

  return {
    commandTier,
    allowed: true,
    requireConfirmation: policy.requireConfirmation,
    forbidBackground: policy.forbidBackground,
    mustRecord: policy.mustRecord,
    rationale: `${policy.rationale}${backgroundNote}`,
  };
}
