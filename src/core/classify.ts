/**
 * src/core/classify.ts — pure task classification.
 *
 * Determines the orchestration tier and security risk level from a free-text
 * task description using a multi-signal scoring approach. No I/O, no time,
 * no randomness — pure function.
 *
 * Honesty Contract: no fabricated confidence numbers are produced here.
 * The rationale field names the matched signals so callers can audit decisions.
 *
 * # Tier scoring model
 *
 * Each tier has a list of keyword patterns. The text is matched against all
 * three lists and a score (count of matches) is accumulated per tier.
 * Tie-break is deterministic: manager > ic > worker.
 * Default when nothing matches: ic.
 *
 * # Risk model
 *
 * Priority cascade: critical > high > medium > low.
 * Word boundaries prevent false positives (e.g. "keyboard" does not match
 * the "key" critical signal).
 */

import type { Classification, Tier, Risk } from './types.js';

// ---------------------------------------------------------------------------
// Tier signal tables
// ---------------------------------------------------------------------------

/**
 * Manager-tier signals: review/planning/architecture/audit tasks that require
 * high-level judgment across the codebase or system.
 */
const MANAGER_SIGNALS: readonly RegExp[] = [
  /\breview\b/i,
  /\bplan\b/i,
  /\bdesign\b/i,
  /\barchitect(?:ure)?\b/i,
  /\baudit\b/i,
  /\bsecurity\b/i,
  /\bthreat\s+model\b/i,
  /\bevaluate\b/i,
  /\bassess\b/i,
  /\bcompare\s+approaches?\b/i,
  /\btrade[-\s]?offs?\b/i,
  /\bwhich\s+approach\b/i,
  /\bshould\s+we\b/i,
  /\bstrategy\b/i,
  /\bhigh[-\s]level\b/i,
  /\bacross\s+the\s+(?:codebase|system)\b/i,
  /\bend[-\s]to[-\s]end\b/i,
  /\blarge\s+migration\b/i,
  /\bcomplex(?:ity)?\b/i,
  /\bcomplicated\b/i,
];

/**
 * Worker-tier signals: pure read-only lookups, searches, and explanations —
 * no file mutation implied.
 */
const WORKER_SIGNALS: readonly RegExp[] = [
  /\bfind\b/i,
  /\bsearch\b/i,
  /\bgrep\b/i,
  /\blocate\b/i,
  /\blist\b/i,
  /\bread[-\s]?only\b/i,
  /\blookup\b/i,
  /\bscan\b/i,
  /\bshow\b/i,
  /\bdisplay\b/i,
  /\bprint\b/i,
  /\bcount\b/i,
  /\bwhat\s+(?:is|are)\b/i,
  /\bwhere\s+(?:is|are)\b/i,
  /\bwhich\s+(?:is|are)\b/i,
  /\bwho\s+(?:is|are)\b/i,
  /\bhow\s+does\b/i,
  /\bexplain\b/i,
  /\bdescribe\b/i,
  /\bsummariz(?:e|ise)\b/i,
  /\bwhat\s+does\b/i,
];

/**
 * IC-tier signals: implementation and hands-on editing tasks.
 * (Used for tie-breaking and direct scoring; ic is the default tier.)
 */
const IC_SIGNALS: readonly RegExp[] = [
  /\bimplement\b/i,
  /\bwrite\b/i,
  /\badd\b/i,
  /\bcreate\b/i,
  /\bbuild\b/i,
  /\bfix\b/i,
  /\bdebug\b/i,
  /\brefactor\b/i,
  /\bupdate\b/i,
  /\bmodify\b/i,
  /\bchange\b/i,
  /\brename\b/i,
  /\bremove\b/i,
  /\bdelete\b/i,
  /\bmove\b/i,
  /\brewrite\b/i,
  /\boptimize\b/i,
  /\bformat\b/i,
  /\bwire\s+up\b/i,
  /\bhook\s+up\b/i,
  /\badd\s+tests?\b/i,
];

// ---------------------------------------------------------------------------
// Risk signal tables — highest priority wins (critical > high > medium > low)
// ---------------------------------------------------------------------------

/**
 * Critical: auth / secrets / credentials / encryption artefacts.
 * Conservative: a security subject immediately elevates to critical.
 */
const CRITICAL_SIGNALS: readonly RegExp[] = [
  /\bauth(?:entication|orization)?\b/i,
  /\bcredential\b/i,
  /\bsecret\b/i,
  /\bpassword\b/i,
  /\btoken\b/i,
  /\bapi[-\s]?key\b/i,
  /\bprivate[-\s]?key\b/i,
  /\bencrypt(?:ion|ed)?\b/i,
  /\bcertificate\b/i,
  /\boauth\b/i,
  /\bvault\b/i,
  /\bsession\b/i,
  /\bcookie\b/i,
  /\bjwt\b/i,
  /\.env\b/i,
];

/**
 * High: payments, deploys, migrations, CI/CD, permissions, schema changes,
 * production infrastructure.
 */
const HIGH_SIGNALS: readonly RegExp[] = [
  /\blogin\b/i,
  /\bpayment\b/i,
  /\bbilling\b/i,
  /\bdeploy(?:ment)?\b/i,
  /\bmigration\b/i,
  /\bci\/cd\b/i,
  /\bpermission\b/i,
  /\bschema\b/i,
  /\bproduction\b/i,
  /\bprod\b/i,
  /\brelease\b/i,
  /\brollback\b/i,
  /\binfra(?:structure)?\b/i,
  /\bterraform\b/i,
  /\bkubernetes\b/i,
  /\bk8s\b/i,
  /\bdocker\b/i,
  /\bdb\s+migration\b/i,
  /\bdatabase\s+migration\b/i,
];

/**
 * Medium: tests, configs, shared utilities, integrations, build/CI signals.
 */
const MEDIUM_SIGNALS: readonly RegExp[] = [
  /\btests?\b/i,
  /\bspecs?\b/i,
  /\bconfig(?:uration)?\b/i,
  /\bintegration\b/i,
  /\bshared\b/i,
  /\butil(?:ity|ities)?\b/i,
  /\blib\b/i,
  /\blint\b/i,
  /\bci\b/i,
  /\bbuild\b/i,
  /\bdependenc(?:y|ies)\b/i,
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Count how many patterns in `signals` match `text` (each pattern counts once).
 * Returns matched signal labels (the matching portion of the first match) for
 * rationale generation.
 */
function scoreSignals(text: string, signals: readonly RegExp[]): readonly string[] {
  const matched: string[] = [];
  for (const re of signals) {
    const m = re.exec(text);
    if (m !== null) {
      matched.push(m[0].toLowerCase());
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a free-text `task` string into a {@link Classification}.
 *
 * Tier: multi-signal scoring; tie-break manager > ic > worker; default ic.
 * Risk: priority cascade critical > high > medium > low; default low.
 *
 * Never throws — empty or whitespace input returns a safe default.
 *
 * @param task - The raw task description from the user.
 */
export function classify(task: string): Classification {
  // Treat empty / whitespace as ic + low with a clear rationale.
  if (!task || task.trim().length === 0) {
    return {
      tier: 'ic',
      risk: 'low',
      rationale: 'tier: ic (empty input — defaulting to ic); risk: low (no risk signals — defaulting to low)',
    };
  }

  // --- Tier scoring ---
  const managerMatches = scoreSignals(task, MANAGER_SIGNALS);
  const icMatches = scoreSignals(task, IC_SIGNALS);
  const workerMatches = scoreSignals(task, WORKER_SIGNALS);

  const managerScore = managerMatches.length;
  const icScore = icMatches.length;
  const workerScore = workerMatches.length;

  let tier: Tier;
  let tierSignals: readonly string[];

  if (managerScore > 0 && managerScore >= icScore && managerScore >= workerScore) {
    // Manager wins (or ties with any other tier — manager has highest priority)
    tier = 'manager';
    tierSignals = managerMatches;
  } else if (icScore > 0 && icScore >= workerScore) {
    // IC wins over worker (ic has higher priority on tie)
    tier = 'ic';
    tierSignals = icMatches;
  } else if (workerScore > 0) {
    tier = 'worker';
    tierSignals = workerMatches;
  } else {
    // Nothing matched — default to ic
    tier = 'ic';
    tierSignals = [];
  }

  const tierRationale =
    tierSignals.length > 0
      ? `tier: ${tier} (matched: ${tierSignals.join(', ')})`
      : `tier: ${tier} (no tier keyword matched — defaulting to ic)`;

  // --- Risk cascade (critical > high > medium > low) ---
  let risk: Risk;
  let riskSignals: readonly string[];

  const criticalMatches = scoreSignals(task, CRITICAL_SIGNALS);
  if (criticalMatches.length > 0) {
    risk = 'critical';
    riskSignals = criticalMatches;
  } else {
    const highMatches = scoreSignals(task, HIGH_SIGNALS);
    if (highMatches.length > 0) {
      risk = 'high';
      riskSignals = highMatches;
    } else {
      const mediumMatches = scoreSignals(task, MEDIUM_SIGNALS);
      if (mediumMatches.length > 0) {
        risk = 'medium';
        riskSignals = mediumMatches;
      } else {
        risk = 'low';
        riskSignals = [];
      }
    }
  }

  const riskRationale =
    riskSignals.length > 0
      ? `risk: ${risk} (matched: ${riskSignals.join(', ')})`
      : `risk: ${risk} (no risk keyword matched — defaulting to low)`;

  return {
    tier,
    risk,
    rationale: `${tierRationale}; ${riskRationale}`,
  };
}
