/**
 * src/core/discovery.ts — Discovery-driven escalation signals (AP2-D, Stage 4).
 *
 * adaptive-partner-v2-5.6.md §2.5 D. When a provider INVESTIGATES a surface task
 * and discovers the real work is bigger or riskier than the prompt implied — a
 * larger bug, a cross-cutting blast radius, the wrong repo, a high-stakes surface
 * (auth/secrets/payments/deployment/data/security), or low self-confidence — the
 * engine should deliberately change scope/agents (escalate / review / panel) under
 * the EXISTING policy gates, instead of silently shipping a narrow fix or asking
 * the user a generic menu.
 *
 * This module is PURE (test/arch/guards.ts): no I/O, no time, no randomness, no
 * provider imports. It does NOT orchestrate, run a model, or add an always-on
 * pass. It only READS the provider's final OUTPUT TEXT plus the already-parsed
 * confidence envelope ({@link Assessment} from assess.ts) and extracts a
 * conservative set of {@link DiscoverySignal}s. orchestrate.ts feeds those signals
 * into its existing escalation/review/panel/hedge gates — discovery can never
 * bypass `authorizeTier` / `panelPolicy` / `policy.maxAttempts`.
 *
 * HONESTY / NO-FABRICATION CONTRACT:
 *  - Signals come only from explicit phrases the model wrote or from the parsed
 *    envelope — never guessed from tone or task category.
 *  - Conservative: a clean, confident answer with no scope-widening language yields
 *    ZERO signals (no false positives), so a normal turn is unaffected.
 *  - Fail-soft: any malformed input degrades to `[]`; this function never throws.
 */

import type { Assessment } from './types.js';

// ---------------------------------------------------------------------------
// Shapes (§2.5 D)
// ---------------------------------------------------------------------------

/** The high-stakes surfaces a discovery may implicate (§2.5 D). */
type HighStakesArea =
  | 'auth'
  | 'secrets'
  | 'payments'
  | 'deployment'
  | 'data'
  | 'security';

/**
 * A discovery the provider surfaced from WITHIN the turn (output text) or that the
 * confidence envelope revealed. Each kind carries the minimal evidence the
 * orchestrator's existing gates need — never a fabricated value.
 */
export type DiscoverySignal =
  | {
      /** The real bug is bigger than the surface task (root cause elsewhere, etc.). */
      readonly kind: 'larger_bug';
      /** The exact phrases (trimmed) that evidenced it. Non-empty. */
      readonly evidence: readonly string[];
      readonly confidence: 'medium' | 'high';
    }
  | {
      /** The fix spreads across multiple files/areas (cross-cutting blast radius). */
      readonly kind: 'cross_cutting_change';
      /** The files/areas the model named, or a generic marker when it only claimed spread. */
      readonly filesOrAreas: readonly string[];
    }
  | {
      /** The requested project/context is not visible here (wrong repo / missing context). */
      readonly kind: 'wrong_repo_or_missing_context';
      /** The project/repo the model said it expected, when it named one. */
      readonly expected?: string;
    }
  | {
      /** The change touches a high-stakes surface (auth/secrets/payments/...). */
      readonly kind: 'high_stakes_surface';
      readonly area: HighStakesArea;
    }
  | {
      /** The provider self-reported low confidence / needs review via the envelope. */
      readonly kind: 'provider_low_confidence';
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Phrase lexicons (output-text validator, §2.5 D "Sources")
// ---------------------------------------------------------------------------

/**
 * "The real bug is bigger / elsewhere" language. A model that INVESTIGATED and
 * found the surface symptom is not the root cause writes this kind of sentence.
 * Conservative: each pattern is an explicit scope-widening claim, not a casual
 * mention of the word "bug".
 */
const LARGER_BUG_PATTERNS: readonly RegExp[] = [
  /\b(the )?(larger|bigger|deeper|underlying|wider|broader) (bug|issue|problem|root cause)\b/i,
  /\broot cause (is|lies|appears to be|seems to be) (elsewhere|actually|deeper|in )\b/i,
  /\bthe (actual|real|underlying) (bug|cause|problem|issue) is (actually )?in\b/i,
  /\bthis is (a symptom|only a symptom|just a symptom) of\b/i,
  /\bthe (real|actual) problem is (not|bigger|deeper)\b/i,
  /\bgoes deeper than (the|this) (page|surface|symptom)\b/i,
];

/**
 * High-confidence escalators (vs the medium-confidence default above). When the
 * model states it VERIFIED the wider root cause, the discovery is high-confidence.
 */
const LARGER_BUG_HIGH_CONFIDENCE_PATTERNS: readonly RegExp[] = [
  /\bi (confirmed|verified|traced|reproduced)\b.*\b(root cause|underlying|elsewhere)\b/i,
  /\bafter (investigating|inspecting|tracing)\b.*\b(root cause|the real (bug|cause|problem))\b/i,
];

/**
 * Cross-cutting / migration spread language. The fix is not local — it touches
 * several files or requires a migration / schema / interface change.
 */
const CROSS_CUTTING_PATTERNS: readonly RegExp[] = [
  /\brequires? (a |an )?(\w+ )?(migration|schema change|backfill)\b/i,
  /\bcross-cutting\b/i,
  /\b(touches|spans|affects|spread across|changes? across) (multiple|several|many) (files|modules|places|areas|components)\b/i,
  /\b(this|the) change (is not local|spans|spreads|cascades)\b/i,
  /\bshared (state|module|code|utility|helper)\b.*\b(root cause|breaks|affects|used by)\b/i,
  /\b(breaking|interface|contract|api) change\b.*\b(consumers|callers|downstream)\b/i,
];

/**
 * Named-file spread: when the model lists ≥2 concrete file paths it must change,
 * that is itself cross-cutting evidence. Matches path-like tokens (a/b/c.ext).
 */
const FILE_PATH_PATTERN = /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|sql|json|yaml|yml|css|scss|html|vue|svelte)\b/gi;

/** Wrong-repo / missing-context language (mirrors the prompt's wrong-repo guard). */
const WRONG_REPO_PATTERNS: readonly RegExp[] = [
  /\b(i (do not|don'?t) see|cannot find|can'?t find|there is no|no sign of) .*\b(project|repo|repository|directory|codebase)\b/i,
  /\bnot (visible|present|found) in (the )?(current )?(working directory|cwd|this repo|this directory)\b/i,
  /\b(this|the current) (repo|directory|cwd) (does not|doesn'?t) (contain|have|look like)\b/i,
  /\b(requested|referenced) (project|repo|repository) is (not|missing|absent)\b/i,
  /\bmissing context\b/i,
];

/**
 * When the model names the project/repo it EXPECTED but couldn't find. Captures a
 * quoted or back-ticked name following an "expected"/"looking for" lead-in.
 */
const EXPECTED_REPO_PATTERN =
  /\b(?:expected|looking for|referenced|requested)\b[^."`'\n]*?[`"']([\w.@/-]{2,60})[`"']/i;

/**
 * Intrinsically-alarming high-stakes patterns — these phrases ARE the discovery
 * (a vulnerability, data loss, a destructive migration), so they fire on their own
 * without needing extra scope framing.
 */
const HIGH_STAKES_INTRINSIC_PATTERNS: ReadonlyArray<{ readonly area: HighStakesArea; readonly re: RegExp }> = [
  { area: 'security', re: /\b(security (issue|vulnerability|flaw|hole)|vulnerability|exploit|injection|xss|csrf|insecure)\b/i },
  { area: 'data', re: /\b(data (loss|corruption|integrity)|drop (table|column)|destructive (migration|change))\b/i },
];

/**
 * High-stakes TOPIC surfaces, keyed by area. A bare topic mention is NOT a
 * discovery — a model asked to "implement a payment handler" will naturally say
 * "payment", and that is routine work, not a surprise. So these fire ONLY when the
 * text ALSO carries discovery/scope framing ({@link DISCOVERY_CONTEXT_PATTERNS}):
 * the model INVESTIGATED and found the change unexpectedly touches this surface.
 * This is the "conservative, no false positives" guard from §2.5 D.
 */
const HIGH_STAKES_TOPIC_PATTERNS: ReadonlyArray<{ readonly area: HighStakesArea; readonly re: RegExp }> = [
  { area: 'auth', re: /\b(auth(entication|orization)?|login|session token|access control|permission check|rbac)\b/i },
  { area: 'secrets', re: /\b(secret|api key|credential|private key|password hash|env (var|variable) .*(key|secret|token))\b/i },
  { area: 'payments', re: /\b(payment|billing|charge|stripe|checkout|invoice|refund)\b/i },
  { area: 'deployment', re: /\b(deployment|deploy pipeline|ci\/cd|production config|infra(structure)? change|rollout)\b/i },
  { area: 'data', re: /\b(database (schema|migration)|data migration)\b/i },
];

/**
 * Discovery/scope framing — the language a model uses when INVESTIGATION revealed
 * something it (or the user) did not start out targeting. A high-stakes TOPIC
 * surface counts as a discovery only when one of these co-occurs, so routine work
 * that merely names the surface is not a false positive.
 */
const DISCOVERY_CONTEXT_PATTERNS: readonly RegExp[] = [
  /\broot cause\b/i,
  /\b(the )?(real|actual|underlying|deeper|wider|broader|larger|bigger) (bug|issue|problem|cause)\b/i,
  /\b(turns out|it turns out|i (found|discovered|noticed|realized)|after (investigating|tracing|inspecting))\b/i,
  /\b(touches|spans|affects|spread across|cascades into|lives in|is in the) (the )?(shared|underlying|core)?\b/i,
  /\b(is actually|are actually) (in|caused by|rooted in)\b/i,
  /\b(symptom|side effect) of\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique, trimmed, non-empty strings preserving first-seen order. PURE. */
function uniqNonEmpty(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Collect the (trimmed) sentence-ish snippets matching any pattern. PURE. */
function matchedPhrases(text: string, patterns: readonly RegExp[]): readonly string[] {
  const hits: string[] = [];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m !== null && typeof m[0] === 'string') hits.push(m[0]);
  }
  return uniqNonEmpty(hits);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract discovery signals from a provider's final OUTPUT TEXT plus the
 * already-parsed confidence envelope ({@link Assessment}). PURE; never throws.
 *
 * Phrase rules (output-text validator):
 *  - `larger_bug` ............ matches {@link LARGER_BUG_PATTERNS} ("the larger
 *    bug…", "root cause is elsewhere/actually in…", "this is a symptom of…").
 *    confidence is `'high'` when a verified/traced phrasing also matches, else
 *    `'medium'`. evidence carries the matched phrases.
 *  - `cross_cutting_change` .. matches {@link CROSS_CUTTING_PATTERNS} ("requires a
 *    migration", "cross-cutting", "touches multiple files", breaking/interface
 *    change affecting consumers, shared-state root cause) OR the text names ≥2
 *    distinct concrete file paths. filesOrAreas carries the named paths when ≥2,
 *    otherwise a single generic marker so the gate still sees the spread.
 *  - `wrong_repo_or_missing_context` matches {@link WRONG_REPO_PATTERNS}; `expected`
 *    is set only when the model named the project it was looking for.
 *  - `high_stakes_surface` ... one signal per distinct area whose
 *    {@link HIGH_STAKES_PATTERNS} pattern matches (auth/secrets/payments/
 *    deployment/data/security). De-duplicated by area.
 *
 * Envelope rule:
 *  - `provider_low_confidence` when the envelope set `escalate` or `needs_review`,
 *    OR confidence is parsed and strictly below `lowConfidenceThreshold` (the
 *    risk-indexed escalate threshold the caller passes — defaults to 0.5 when
 *    omitted). reason is the envelope reason (or a stable fallback). A null/absent
 *    confidence with no escalate/needs_review is NOT a signal (we never second-
 *    guess silence — that is assess.ts's Honesty Contract).
 *
 * Conservative: a clean, confident, local answer yields `[]`.
 *
 * @param text        - The provider's final output text.
 * @param assessment  - The parsed confidence envelope from {@link assess}.
 * @param lowConfidenceThreshold - Optional risk-indexed escalate threshold; a
 *                                 confidence strictly below it is low. Default 0.5.
 */
export function extractDiscoverySignals(
  text: string,
  assessment: Assessment,
  lowConfidenceThreshold = 0.5,
): readonly DiscoverySignal[] {
  const signals: DiscoverySignal[] = [];

  const safeText = typeof text === 'string' ? text : '';

  // --- larger_bug (output text) ---
  if (safeText.length > 0) {
    const evidence = matchedPhrases(safeText, LARGER_BUG_PATTERNS);
    if (evidence.length > 0) {
      const high = LARGER_BUG_HIGH_CONFIDENCE_PATTERNS.some((re) => re.test(safeText));
      signals.push({ kind: 'larger_bug', evidence, confidence: high ? 'high' : 'medium' });
    }
  }

  // --- cross_cutting_change (output text) ---
  if (safeText.length > 0) {
    const claimed = CROSS_CUTTING_PATTERNS.some((re) => re.test(safeText));
    const paths = uniqNonEmpty(safeText.match(FILE_PATH_PATTERN) ?? []);
    const namedSpread = paths.length >= 2;
    if (claimed || namedSpread) {
      const filesOrAreas = namedSpread ? paths : ['multiple files or areas'];
      signals.push({ kind: 'cross_cutting_change', filesOrAreas });
    }
  }

  // --- wrong_repo_or_missing_context (output text) ---
  if (safeText.length > 0 && WRONG_REPO_PATTERNS.some((re) => re.test(safeText))) {
    const m = EXPECTED_REPO_PATTERN.exec(safeText);
    const expected = m !== null && typeof m[1] === 'string' ? m[1].trim() : undefined;
    signals.push(
      expected !== undefined && expected.length > 0
        ? { kind: 'wrong_repo_or_missing_context', expected }
        : { kind: 'wrong_repo_or_missing_context' },
    );
  }

  // --- high_stakes_surface (output text) — one signal per distinct area ---
  // Intrinsically-alarming phrases (a vulnerability, data loss) fire on their own;
  // bare TOPIC surfaces (auth/payments/...) fire ONLY when discovery/scope framing
  // co-occurs, so routine work that merely names the surface is not a false
  // positive (the §2.5 D conservative guard).
  if (safeText.length > 0) {
    const seen = new Set<HighStakesArea>();
    const pushArea = (area: HighStakesArea): void => {
      if (seen.has(area)) return;
      seen.add(area);
      signals.push({ kind: 'high_stakes_surface', area });
    };
    for (const { area, re } of HIGH_STAKES_INTRINSIC_PATTERNS) {
      if (re.test(safeText)) pushArea(area);
    }
    const hasDiscoveryContext = DISCOVERY_CONTEXT_PATTERNS.some((re) => re.test(safeText));
    if (hasDiscoveryContext) {
      for (const { area, re } of HIGH_STAKES_TOPIC_PATTERNS) {
        if (re.test(safeText)) pushArea(area);
      }
    }
  }

  // --- provider_low_confidence (envelope) ---
  if (assessment !== null && typeof assessment === 'object') {
    const lowConf =
      assessment.confidence !== null &&
      typeof assessment.confidence === 'number' &&
      assessment.confidence < lowConfidenceThreshold;
    if (assessment.escalate === true || assessment.needsReview === true || lowConf) {
      const reason =
        typeof assessment.reason === 'string' && assessment.reason.trim().length > 0
          ? assessment.reason.trim()
          : 'provider reported low confidence';
      signals.push({ kind: 'provider_low_confidence', reason });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Gate predicates (PURE) — how signals map to the EXISTING escalation gates.
// These NEVER open a tier or form a panel themselves; they only say WHETHER the
// discovery is a strong-enough reason to ASK the existing gate. The actual
// admission stays with authorizeTier / panelPolicy / maxAttempts in orchestrate.
// ---------------------------------------------------------------------------

/**
 * True when the discovery is high-risk or cross-cutting blast radius — the §2.5 D
 * condition for REQUESTING a manager escalation. (Whether manager actually opens
 * is still decided by `authorizeTier`/`admitManager`.)
 *
 * A `larger_bug` with `high` confidence, any `cross_cutting_change`, or any
 * `high_stakes_surface` qualifies. A medium-confidence larger bug alone does not
 * force escalation (it may be local) — it rides the normal confidence gate.
 */
export function discoveryWarrantsManager(signals: readonly DiscoverySignal[]): boolean {
  if (!Array.isArray(signals)) return false;
  return signals.some(
    (s) =>
      s.kind === 'cross_cutting_change' ||
      s.kind === 'high_stakes_surface' ||
      (s.kind === 'larger_bug' && s.confidence === 'high'),
  );
}

/**
 * True when the discovery warrants a cross-vendor REVIEW under §2.5 D — a
 * high-stakes surface or a cross-cutting change is worth a second vendor's eyes.
 * Used to ADD a review trigger to the existing `shouldReview` decision; it never
 * forces review past the user's `reviewPolicy === 'off'` (the caller AND-gates it).
 */
export function discoveryWarrantsReview(signals: readonly DiscoverySignal[]): boolean {
  if (!Array.isArray(signals)) return false;
  return signals.some(
    (s) =>
      s.kind === 'high_stakes_surface' ||
      s.kind === 'cross_cutting_change' ||
      (s.kind === 'larger_bug' && s.confidence === 'high'),
  );
}

/**
 * True when the discovery makes the work LARGER but it is plausibly LOCAL,
 * REVERSIBLE, and resolvable WITHOUT widening scope or asking the user — the
 * §2.5 D "just do the larger fix" case. A medium-confidence larger bug with NO
 * cross-cutting / high-stakes / wrong-repo signal is the canonical example: keep
 * going at the current tier rather than escalating or interrogating.
 */
export function discoveryIsLocalLargerFix(signals: readonly DiscoverySignal[]): boolean {
  if (!Array.isArray(signals) || signals.length === 0) return false;
  const hasLargerBug = signals.some((s) => s.kind === 'larger_bug');
  if (!hasLargerBug) return false;
  return !discoveryWarrantsManager(signals) &&
    !signals.some((s) => s.kind === 'wrong_repo_or_missing_context');
}

/**
 * A concise human-readable reason string for the escalate/notice events, built
 * from the strongest signal present. PURE. Returns undefined when no signal is
 * escalation-worthy (the caller falls back to its own reason).
 */
export function discoveryEscalationReason(signals: readonly DiscoverySignal[]): string | undefined {
  if (!Array.isArray(signals)) return undefined;
  const crossCutting = signals.find((s) => s.kind === 'cross_cutting_change');
  if (crossCutting !== undefined) return 'discovery: cross-cutting change';
  const highStakes = signals.find(
    (s): s is Extract<DiscoverySignal, { kind: 'high_stakes_surface' }> =>
      s.kind === 'high_stakes_surface',
  );
  if (highStakes !== undefined) return `discovery: high-stakes surface (${highStakes.area})`;
  const largerBug = signals.find(
    (s): s is Extract<DiscoverySignal, { kind: 'larger_bug' }> => s.kind === 'larger_bug',
  );
  if (largerBug !== undefined && largerBug.confidence === 'high') {
    return 'discovery: wider root cause found';
  }
  return undefined;
}
