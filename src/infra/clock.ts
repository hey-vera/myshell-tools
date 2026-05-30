/**
 * src/infra/clock.ts — System clock implementation of the Clock port.
 *
 * This is the SINGLE place in the codebase where impure time/random globals
 * (Date, Math.random, randomUUID) are allowed. All other modules receive a
 * Clock via injection, keeping them pure and testable.
 */

import type { Clock } from '../core/types.js';
import { randomUUID } from 'node:crypto';

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
  uuid: () => randomUUID(),
  random: () => Math.random(),
};
