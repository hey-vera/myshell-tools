/**
 * src/core/classify.ts — pure task classification.
 *
 * Determines the orchestration tier and security risk level from a free-text
 * task description using keyword/regex signals. No I/O, no time, no randomness.
 *
 * Honesty Contract: no fabricated confidence numbers are produced here.
 * The rationale field names the matched signal so callers can audit decisions.
 */

import type { Classification, Tier, Risk } from './types.js';

// ---------------------------------------------------------------------------
// Tier signal tables
// ---------------------------------------------------------------------------

/** Words that signal a manager-tier task (review, planning, architecture, security). */
const MANAGER_WORDS =
  /\b(review|plan|design|architect|audit|security|threat|evaluate|assess|complex)\b/i;

/** Words that signal a worker-tier task (read-only lookups, searches). */
const WORKER_WORDS =
  /\b(find|search|grep|locate|list|read[-\s]only|lookup|scan|what\s+is)\b/i;

// ---------------------------------------------------------------------------
// Risk signal tables — highest match wins
// ---------------------------------------------------------------------------

/** Critical: auth / secrets / credentials / encryption artefacts. */
const CRITICAL_RE =
  /\b(auth|credential|secret|password|token|key|encrypt|certificate)\b|\.env\b/i;

/** High: payments, deploys, migrations, CI/CD, permissions, schema changes. */
const HIGH_RE =
  /\b(login|payment|billing|deploy|migration|ci\/cd|permission|schema)\b/i;

/** Medium: tests, configs, shared utilities, integrations. */
const MEDIUM_RE =
  /\b(test|spec|config|integration|shared|util|lib)\b/i;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a free-text `task` string into a {@link Classification}.
 *
 * Tier priority: manager > worker > ic (ic is the default).
 * Risk priority: critical > high > medium > low (low is the default).
 *
 * @param task - The raw task description from the user.
 */
export function classify(task: string): Classification {
  // --- Tier ---
  let tier: Tier;
  let tierSignal: string;

  if (MANAGER_WORDS.test(task)) {
    tier = 'manager';
    const m = task.match(MANAGER_WORDS);
    tierSignal = m ? `manager keyword '${m[0].toLowerCase()}'` : 'manager keyword';
  } else if (WORKER_WORDS.test(task)) {
    tier = 'worker';
    const m = task.match(WORKER_WORDS);
    tierSignal = m ? `worker keyword '${m[0].toLowerCase()}'` : 'worker keyword';
  } else {
    tier = 'ic';
    tierSignal = 'no tier keyword matched — defaulting to ic';
  }

  // --- Risk ---
  let risk: Risk;
  let riskSignal: string;

  if (CRITICAL_RE.test(task)) {
    risk = 'critical';
    const m = task.match(CRITICAL_RE);
    riskSignal = `critical keyword '${m ? m[0].toLowerCase() : 'unknown'}'`;
  } else if (HIGH_RE.test(task)) {
    risk = 'high';
    const m = task.match(HIGH_RE);
    riskSignal = `high keyword '${m ? m[0].toLowerCase() : 'unknown'}'`;
  } else if (MEDIUM_RE.test(task)) {
    risk = 'medium';
    const m = task.match(MEDIUM_RE);
    riskSignal = `medium keyword '${m ? m[0].toLowerCase() : 'unknown'}'`;
  } else {
    risk = 'low';
    riskSignal = 'no risk keyword matched — defaulting to low';
  }

  const rationale = `tier: ${tierSignal}; risk: ${riskSignal}`;

  return { tier, risk, rationale };
}
