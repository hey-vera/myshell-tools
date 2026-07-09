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
 *
 * Manager corroboration rule (anti-overtrigger): a *lone* soft manager keyword
 * (e.g. "plan", "review", "design") in an otherwise conversational message must
 * NOT force the most expensive manager tier. Manager is only chosen when there
 * is real structural evidence of high-level work:
 *   - a STRONG structural signal is present (audit / threat model / architecture
 *     / "across the codebase|system" / large migration / end-to-end / "high-level"
 *     / "compare approaches" / strategy), OR
 *   - at least TWO DISTINCT soft manager signals match (de-duplicated, so
 *     repeating one word can't fake corroboration).
 * A single soft manager signal alone routes to `ic`, not `manager`. This is the
 * fix for "let me know your plan ..." (lone "plan") landing on opus.
 *
 * Tie-break (after the manager gate above): manager > ic > worker.
 * Default when nothing matches: ic.
 *
 * # Risk model
 *
 * Priority cascade: critical > high > medium > low.
 * Word boundaries prevent false positives (e.g. "keyboard" does not match
 * the "key" critical signal).
 */

import type { Classification, Tier, Risk, CommandTier } from './types.js';

// ---------------------------------------------------------------------------
// Tier signal tables
// ---------------------------------------------------------------------------

/**
 * STRONG (structural) manager signals: each one on its own is strong evidence
 * of genuine high-level / cross-cutting work that warrants the manager tier.
 * A single strong signal is enough to select `manager`.
 */
const MANAGER_STRONG_SIGNALS: readonly RegExp[] = [
  /\barchitect(?:ure)?\b/i,
  /\baudit\b/i,
  /\bthreat\s+model\b/i,
  /\bcompare\s+approaches?\b/i,
  /\bwhich\s+approach\b/i,
  /\bshould\s+we\b/i,
  /\bstrategy\b/i,
  /\bhigh[-\s]level\b/i,
  /\bacross\s+the\s+(?:codebase|system)\b/i,
  /\bend[-\s]to[-\s]end\b/i,
  /\blarge\s+migration\b/i,
];

/**
 * SOFT manager signals: planning / review / evaluation words that often appear
 * in ordinary conversational messages ("let me know your plan", "can you review
 * this"). On their own these are NOT sufficient — a LONE soft signal routes to
 * `ic`. Manager requires ≥2 DISTINCT soft signals (de-duplicated) OR at least
 * one strong signal. This prevents a single word like "plan" from launching the
 * most expensive model on a low-risk chat message.
 */
const MANAGER_SOFT_SIGNALS: readonly RegExp[] = [
  /\breview\b/i,
  /\bplan\b/i,
  /\bdesign\b/i,
  /\bsecurity\b/i,
  /\bevaluate\b/i,
  /\bassess\b/i,
  /\btrade[-\s]?offs?\b/i,
  /\bcomplex(?:ity)?\b/i,
  /\bcomplicated\b/i,
];

/**
 * Union used only for rationale reporting (names every manager keyword matched).
 */
const MANAGER_SIGNALS: readonly RegExp[] = [
  ...MANAGER_STRONG_SIGNALS,
  ...MANAGER_SOFT_SIGNALS,
];

/**
 * Worker-tier signals: pure read-only lookups, searches, and explanations —
 * no file mutation implied.
 */
const WORKER_SIGNALS: readonly RegExp[] = [
  // Exact-output / reply-only prompts: a short, anchored format-only command that
  // asks the model to echo a specific string — no file mutation, no engineering work.
  // Conservative: the full prompt must match this anchored pattern start-to-end.
  /^\s*(?:please\s+)?(?:reply|respond|say|answer)\s+(?:(?:with\s+)?(?:exactly|just|only)|(?:exactly|just|only)\s+(?:with\s+)?)\s*:?\s*(?:"[^"\r\n]{1,120}"|'[^'\r\n]{1,120}'|`[^`\r\n]{1,120}`|[A-Za-z0-9_ .,:;!?-]{1,80})\s*$/i,
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
  /\bcredentials?\b/i,
  /\bsecrets?\b/i,
  /\bpasswords?\b/i,
  /\btokens?\b/i,
  /\bapi[-\s]?keys?\b/i,
  /\bprivate[-\s]?keys?\b/i,
  /\bencrypt(?:ion|ed)?\b/i,
  /\bcertificates?\b/i,
  /\boauth\b/i,
  /\bvaults?\b/i,
  /\bsessions?\b/i,
  /\bcookies?\b/i,
  /\bjwts?\b/i,
  /\.env\b/i,
];

/**
 * High: payments, deploys, migrations, CI/CD, permissions, schema changes,
 * production infrastructure.
 */
const HIGH_SIGNALS: readonly RegExp[] = [
  /\blogins?\b/i,
  /\bpayments?\b/i,
  /\bbilling\b/i,
  /\bdeploy(?:ments?)?\b/i,
  /\bmigrations?\b/i,
  /\bci\/cd\b/i,
  /\bpermissions?\b/i,
  /\bschemas?\b/i,
  /\bproduction\b/i,
  /\bprod\b/i,
  /\breleases?\b/i,
  /\brollbacks?\b/i,
  /\binfra(?:structure)?\b/i,
  /\bterraform\b/i,
  /\bkubernetes\b/i,
  /\bk8s\b/i,
  /\bdocker\b/i,
  /\bdb\s+migrations?\b/i,
  /\bdatabase\s+migrations?\b/i,
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

interface TierSignalScores {
  readonly managerStrongMatches: readonly string[];
  readonly managerSoftMatches: readonly string[];
  readonly managerMatches: readonly string[];
  readonly icMatches: readonly string[];
  readonly workerMatches: readonly string[];
  readonly managerQualifies: boolean;
}

function scoreTierSignals(task: string): TierSignalScores {
  const managerStrongMatches = scoreSignals(task, MANAGER_STRONG_SIGNALS);
  const managerSoftMatches = scoreSignals(task, MANAGER_SOFT_SIGNALS);
  return {
    managerStrongMatches,
    managerSoftMatches,
    managerMatches: scoreSignals(task, MANAGER_SIGNALS),
    icMatches: scoreSignals(task, IC_SIGNALS),
    workerMatches: scoreSignals(task, WORKER_SIGNALS),
    // Manager qualifies only with real evidence: any strong signal, or ≥2 distinct
    // soft signals. A single soft signal alone does NOT reach manager.
    managerQualifies:
      managerStrongMatches.length > 0 || managerSoftMatches.length >= 2,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True when {@link classify} had real keyword evidence for its tier choice —
 * i.e. a manager signal qualified under the same corroboration rule used by
 * classify(), or at least one ic/worker signal matched the task. False means the
 * classifier fell back to the `ic` default without a tier-determining signal.
 *
 * This is the seam the model-brained router uses (core/router.ts): a turn with
 * keyword evidence is routed deterministically (free, instant); a turn with no
 * evidence is the ambiguous case — a complex request phrased without a trigger
 * word — where consulting a cheap model adds real value. Pure, never throws.
 *
 * @param task - The raw task description from the user.
 */
export function hasTierEvidence(task: string): boolean {
  if (!task || task.trim().length === 0) return false;
  const signals = scoreTierSignals(task);
  return (
    signals.managerQualifies ||
    signals.icMatches.length > 0 ||
    signals.workerMatches.length > 0
  );
}

/**
 * True when a turn carries evidence of real WORK to plan — a manager (orchestration/
 * planning) or IC (implement/build/fix/wire-up) signal — as opposed to a pure
 * read-only LOOKUP (find/show/"what is"/"how does"/explain), which is worker-only.
 *
 * This is the gate for the auto-stage PLANNER: staging goals off a plain question
 * ("how does the router work?") is wrong AND wastes a background manager call on a
 * subscription's quota (the planner just returns judgment:none). A real build/plan
 * turn ("wire up auth", "refactor the store", "let's plan the migration") still has a
 * manager/IC signal and fires. Turns with NO keyword evidence never reach here. Pure.
 */
export function hasWorkIntent(task: string): boolean {
  if (!task || task.trim().length === 0) return false;
  const signals = scoreTierSignals(task);
  // Any manager signal (strong or soft like "plan", "design") or IC means real work
  // to plan/build — triggers smart digestion into goals, even single soft signals.
  // This makes normal chat auto-use the elite partner goal engine for planning queries.
  return signals.managerMatches.length > 0 || signals.icMatches.length > 0;
}

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
  // Manager requires corroboration (see header): a lone soft keyword (plan /
  // review / design / ...) is NOT enough. We split the manager signals into
  // STRONG (structural — one suffices) and SOFT (need ≥2 distinct). The
  // de-duplicated soft count means repeating one word can't fake corroboration,
  // because scoreSignals already counts each distinct pattern at most once.
  const {
    managerMatches,
    icMatches,
    workerMatches,
    managerQualifies,
  } = scoreTierSignals(task);

  const icScore = icMatches.length;
  const workerScore = workerMatches.length;

  let tier: Tier;
  let tierSignals: readonly string[];

  if (managerQualifies) {
    // Manager wins (highest priority) — corroborated by structural evidence.
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

// ---------------------------------------------------------------------------
// Command-tier classifier
// ---------------------------------------------------------------------------

interface CommandTierSignal {
  readonly tier: CommandTier;
  readonly label: string;
  readonly patterns: readonly RegExp[];
}

function firstCommandSignal(
  command: string,
  signals: readonly CommandTierSignal[],
): { readonly tier: CommandTier; readonly label: string } | null {
  for (const signal of signals) {
    for (const pattern of signal.patterns) {
      if (pattern.test(command)) {
        return { tier: signal.tier, label: signal.label };
      }
    }
  }
  return null;
}

const COMMAND_TIER_SIGNALS: readonly CommandTierSignal[] = [
  {
    tier: 'credential-sensitive',
    label: 'credential-sensitive secret/auth signal',
    patterns: [
      /(?:^|[\s"'=:/])\.env(?:$|[\s"';])/i,
      /(?:^|[\s"'=])~\/\.ssh(?:\/|\b)/i,
      /(?:^|[\s"'=])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:$|[\s"';])/i,
      /(?:^|[\s"'=])\S+\.pem(?:$|[\s"';])/i,
      /\b(?:TOKEN|SECRET|PASSWORD|API_KEY)\b/,
      /\$[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*/,
      /\bexport\s+[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*=/,
      /\b(?:cat|echo)\b[^\n;&|]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b/,
      /\bgh\s+auth\b/i,
      /\bnpm\s+publish\b/i,
      /\bgit\s+remote\s+set-url\b[^\n;&|]*(?:https?:\/\/[^/\s"'@]+:[^/\s"'@]+@|TOKEN|SECRET|PASSWORD|API_KEY)/i,
      /\b(?:curl|wget)\b[^\n;&|]*(?:Authorization:|-u\s+\S+:\S+|token=|TOKEN|SECRET|PASSWORD|API_KEY)/i,
      /\baws\b[^\n;&|]*(?:configure|sso|credentials?|access-key|secret-access-key|TOKEN|SECRET|PASSWORD|API_KEY)/i,
      /\bgcloud\b[^\n;&|]*(?:auth|credentials?|service-account|access-token|TOKEN|SECRET|PASSWORD|API_KEY)/i,
    ],
  },
  {
    tier: 'destructive-filesystem',
    label: 'destructive filesystem signal',
    patterns: [
      /:\s*\(\s*\)\s*\{[\s\S]*:\s*\|:\s*&[\s\S]*\}\s*;/,
      /\brm\b/i,
      /\brmdir\b/i,
      /\bgit\s+clean\b[^\n;&|]*-[^\n;&|]*[fd]/i,
      /\bgit\s+reset\b[^\n;&|]*--hard\b/i,
      /\bgit\s+push\b[^\n;&|]*(?:--force|-f\b)/i,
      /\btruncate\b/i,
      /\bdd\b/i,
      /\bmkfs(?:\.\w+)?\b/i,
      /\bshred\b/i,
      /\bfind\b[^\n;&|]*\s-delete\b/i,
      /\bfind\b[^\n;&|]*\s-exec\s+rm\b/i,
      /\b(?:mv|cp)\b[^\n;&|]*\s-[^\n;&|]*f\b/i,
      /\b(?:chmod|chown)\b[^\n;&|]*\s-R\b/i,
      /(?:^|[^>])>\s*(?:package(?:-lock)?\.json|tsconfig\.json|README\.md|src\/\S+|test\/\S+)/i,
    ],
  },
  {
    tier: 'dependency-install',
    label: 'dependency installation signal',
    patterns: [
      /\bnpm\s+(?:install|i|ci|add)\b/i,
      /\byarn\s+(?:add|install)\b/i,
      /\bpnpm\s+(?:add|install)\b/i,
      /\bpip(?:3)?\s+install\b/i,
      /\bapt(?:-get)?\s+install\b/i,
      /\bbrew\s+install\b/i,
      /\bcargo\s+add\b/i,
      /\bgo\s+get\b/i,
      /\bgem\s+install\b/i,
      /\bnpx\b/i,
    ],
  },
  {
    tier: 'local-write',
    label: 'local write signal',
    patterns: [
      /\btouch\b/i,
      /\bmkdir\b/i,
      /\bmv\b/i,
      /\bcp\b/i,
      /\bgit\s+(?:add|commit|checkout|switch|stash|tag)\b/i,
      /(?:^|[^>])>>?\s*\S+/,
      /\bsed\b[^\n;&|]*\s-i(?:\b|['"])/i,
      /\btee\b/i,
      /\bln\b/i,
      /\bchmod\b/i,
      /\bchown\b/i,
      /\benv\s+\w+=/,
      /\bexport\s+\w+=/,
    ],
  },
  {
    tier: 'test-build',
    label: 'test/build signal',
    patterns: [
      /\bnpm\s+test\b/i,
      /\bnpm\s+run\s+(?:build|lint|typecheck)\b/i,
      /\btsc\b/i,
      /\beslint\b/i,
      /\bjest\b/i,
      /\bvitest\b/i,
      /\bnode\s+--test\b/i,
      /\bmake\b/i,
      /\bcargo\s+(?:build|test)\b/i,
      /\bpytest\b/i,
      /\bgo\s+(?:build|test)\b/i,
    ],
  },
  {
    tier: 'read-only',
    label: 'read-only inspection signal',
    patterns: [
      /\bls\b/i,
      /\bcat\b/i,
      /\bhead\b/i,
      /\btail\b/i,
      /\bwc\b/i,
      /\bgrep\b/i,
      /\brg\b/i,
      /\bfind\b/i,
      /\becho\b/i,
      /\bpwd\b/i,
      /\bwhich\b/i,
      /\bgit\s+(?:status|log|diff|show|branch)\b/i,
      // GitHub CLI read-only PR inspection (P1.6 thin — status/list/view only).
      /\bgh\s+pr\s+(?:status|list|view|checks)\b/i,
      /\bstat\b/i,
      /\bfile\b/i,
      /\btree\b/i,
      /\benv\b/i,
    ],
  },
];

/**
 * Classify a shell command line into the most dangerous matching command tier.
 *
 * This is intentionally orthogonal to {@link classify}: it does not affect task
 * tier/risk routing and performs no enforcement. The whole command string is
 * scanned, so compound lines using pipes, `&&`, or `;` inherit the most severe
 * matching component. Empty or unrecognized commands default to `local-write`
 * because an unknown shell command may mutate local state even when it is not
 * known to be destructive.
 */
export function classifyCommand(command: string): {
  readonly commandTier: CommandTier;
  readonly rationale: string;
} {
  const normalized = command.trim();
  if (normalized.length === 0) {
    return {
      commandTier: 'local-write',
      rationale: 'command tier: local-write (empty command — defaulting conservatively because unknown commands may write local state)',
    };
  }

  const match = firstCommandSignal(normalized, COMMAND_TIER_SIGNALS);
  if (match !== null) {
    return {
      commandTier: match.tier,
      rationale: `command tier: ${match.tier} (matched ${match.label}; most dangerous matching tier wins)`,
    };
  }

  return {
    commandTier: 'local-write',
    rationale: 'command tier: local-write (no command-tier pattern matched — defaulting conservatively because unknown commands may write local state)',
  };
}
