/**
 * src/core/rules.ts — the PURE shaping/matching core for STANDING RULES (Phase 4):
 * user-authored policy the partner REMEMBERS and ENFORCES forever ("always use
 * automerge", "never touch file X", "pause before any security-type goal").
 *
 * THE BOUNDARY (owner, non-negotiable): a Rule is EXPLICIT user policy, NOT an
 * ingested fact. It deliberately does NOT route through user-memory's
 * `isInstructionShaped` prompt-injection gate — that gate (correctly) REJECTS
 * instruction-shaped text for *learned* facts, which is exactly why a rule could
 * never be stored before. A rule is authored by the user via `/rule add`, so it
 * is trusted by construction; this module shapes + matches it, and the I/O lives
 * in src/infra/rules-store.ts (mirrors goal-store.ts).
 *
 * This module is PURE: no I/O, no time, no randomness, never throws. Anything
 * that shapes/parses/matches a rule lives HERE so it is table-testable; the store
 * supplies ids + timestamps + persistence.
 */

// ---------------------------------------------------------------------------
// The Rule type
// ---------------------------------------------------------------------------

/**
 * What a rule DOES when it matches an action the partner is about to take:
 *   - 'pause' → stop and ask for explicit confirmation before proceeding.
 *   - 'block' → refuse the action and explain why (the rule forbids it).
 *   - 'prefer' → surface the user's standing preference (e.g. "use automerge")
 *                so the action honours it; never blocks, just informs.
 */
export type RuleKind = 'pause' | 'block' | 'prefer';

/** A goal category the gate can key a rule on (deterministic classification). */
export type RuleCategory =
  | 'security'
  | 'infra'
  | 'data'
  | 'release'
  | 'docs'
  | 'test'
  | 'refactor'
  | 'general';

/**
 * What an action must match for a rule to fire. ALL present fields must match
 * (AND), so a rule can be as broad as a single category or as narrow as a
 * category + path. An empty trigger (no fields) matches NOTHING — a rule with no
 * trigger is inert by design (it can never silently gate everything).
 *
 *   - category → the action's classified category (security/infra/…)
 *   - pathGlob → a simple glob over the action's touched paths (`*`/`**`/`?`)
 *   - keyword  → a case-insensitive substring of the action's text
 */
export interface RuleTrigger {
  readonly category?: RuleCategory;
  readonly pathGlob?: string;
  readonly keyword?: string;
}

/** A rule's scope — mirrors goal/memory's two-scope model exactly. */
export type RuleScope = 'global' | 'project';

/** A standing rule: explicit user policy the partner remembers + enforces. */
export interface Rule {
  readonly version: 1;
  readonly id: string;
  readonly kind: RuleKind;
  readonly trigger: RuleTrigger;
  /** The user's own words (the policy text), for display + the gate explanation. */
  readonly text: string;
  readonly scope: RuleScope;
  /** Privacy-preserving `basename#shorthash` (never the raw path); null = global. */
  readonly projectKey: string | null;
  readonly createdAt: string; // ISO — supplied by the store (pure core never reads a clock)
}

// ---------------------------------------------------------------------------
// Defensive shaping (mirrors goal-todo.capGoal — never throws)
// ---------------------------------------------------------------------------

const TEXT_LIMIT = 400;
const TRIGGER_FIELD_LIMIT = 200;

const VALID_KINDS: ReadonlySet<string> = new Set<RuleKind>(['pause', 'block', 'prefer']);
const VALID_SCOPES: ReadonlySet<string> = new Set<RuleScope>(['global', 'project']);
const VALID_CATEGORIES: ReadonlySet<string> = new Set<RuleCategory>([
  'security',
  'infra',
  'data',
  'release',
  'docs',
  'test',
  'refactor',
  'general',
]);

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function capText(value: unknown, limit: number): string {
  return safeString(value).slice(0, limit);
}

function capKind(value: unknown): RuleKind {
  return typeof value === 'string' && VALID_KINDS.has(value) ? (value as RuleKind) : 'pause';
}

function capScope(value: unknown): RuleScope {
  return typeof value === 'string' && VALID_SCOPES.has(value) ? (value as RuleScope) : 'project';
}

export function capCategory(value: unknown): RuleCategory | undefined {
  return typeof value === 'string' && VALID_CATEGORIES.has(value)
    ? (value as RuleCategory)
    : undefined;
}

/** Cap a trigger defensively: each present field is length-capped; an invalid
 *  category is dropped. An object with no usable fields → `{}` (inert). Pure. */
function capTrigger(value: unknown): RuleTrigger {
  if (value === null || typeof value !== 'object') return {};
  const t = value as Record<string, unknown>;
  const category = capCategory(t['category']);
  const pathGlob = t['pathGlob'] !== undefined ? capText(t['pathGlob'], TRIGGER_FIELD_LIMIT) : '';
  const keyword = t['keyword'] !== undefined ? capText(t['keyword'], TRIGGER_FIELD_LIMIT) : '';
  return {
    ...(category !== undefined ? { category } : {}),
    ...(pathGlob.length > 0 ? { pathGlob } : {}),
    ...(keyword.length > 0 ? { keyword } : {}),
  };
}

/**
 * Return a deterministic, capped copy of a rule. Defensive at runtime: any
 * malformed field falls back to a safe default (kind→pause, scope→project) rather
 * than throwing. Used by the store on every read so a hand-edited or partially
 * written index can never crash a caller. Pure, never throws.
 */
export function capRule(r: Rule): Rule {
  const raw = r as unknown;
  const o =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const scope = capScope(o['scope']);
  return {
    version: 1,
    id: safeString(o['id']),
    kind: capKind(o['kind']),
    trigger: capTrigger(o['trigger']),
    text: capText(o['text'], TEXT_LIMIT),
    scope,
    projectKey:
      scope === 'project' ? (typeof o['projectKey'] === 'string' ? o['projectKey'] : null) : null,
    createdAt: safeString(o['createdAt']),
  };
}

// ---------------------------------------------------------------------------
// The /rule text parser — deterministic, NO model call
// ---------------------------------------------------------------------------

/** The parsed shape of `/rule add <text>` BEFORE the store mints id/createdAt. */
export interface ParsedRule {
  readonly kind: RuleKind;
  readonly trigger: RuleTrigger;
  readonly text: string;
}

/** Phrases that, present anywhere, classify a rule's category. Order = priority. */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [RuleCategory, readonly string[]]> = [
  ['security', ['security', 'auth', 'credential', 'secret', 'token', 'password', 'vuln', 'crypto']],
  ['release', ['release', 'publish', 'deploy', 'ship', 'version bump', 'npm publish', 'tag']],
  ['infra', ['infra', 'ci', 'pipeline', 'workflow', 'docker', 'deploy', 'config', 'env var']],
  ['data', ['migration', 'database', 'schema', 'data ', 'sql', 'backup']],
  ['test', ['test', 'spec', 'coverage']],
  ['docs', ['docs', 'documentation', 'readme', 'changelog']],
  ['refactor', ['refactor', 'rename', 'cleanup', 'restructure']],
];

/** A path looks like a path when it carries a slash, a dot-extension, or a glob. */
const PATH_LIKE_RE = /(^|\s)([\w./*-]*[/.][\w./*-]+)/;

/**
 * Classify free text into a {@link RuleCategory} by keyword. Deterministic, total;
 * 'general' when nothing matches. Used by the /rule parser to set a category
 * trigger AND by the gate to classify a goal's text — ONE source of truth so a
 * "security" rule and a "security" goal agree on what "security" means.
 */
export function classifyCategory(text: string): RuleCategory {
  const t = safeString(text).toLowerCase();
  if (t.length === 0) return 'general';
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    for (const kw of kws) {
      if (t.includes(kw)) return cat;
    }
  }
  return 'general';
}

/** Extract the first path-like token from text (for a `never touch X` rule). */
function extractPathLike(text: string): string | undefined {
  const m = PATH_LIKE_RE.exec(text);
  const candidate = m?.[2]?.trim();
  if (candidate === undefined || candidate.length === 0) return undefined;
  // Reject a bare word that merely contains a dot at the end of a sentence.
  if (!/[/*]/.test(candidate) && !/\.\w{1,6}$/.test(candidate)) return undefined;
  return candidate;
}

/**
 * Parse `/rule add <text>` into a structured {@link ParsedRule}. Deterministic —
 * NO model call (the owner constraint). The simple, predictable grammar:
 *
 *   - leads with "pause" / "ask" / "confirm" / "check with me"  → kind 'pause'
 *   - leads with "never" / "don't" / "do not" / "block"          → kind 'block'
 *   - "always" / "prefer" / "use"                                → kind 'prefer'
 *   - otherwise                                                  → kind 'pause'
 *     (the safe default — a rule the parser can't classify pauses, never silently
 *      blocks or silently prefers).
 *
 * The TRIGGER is derived from the same text:
 *   - a path-like token (`src/foo.ts`, `**\/*.lock`)  → pathGlob
 *   - a "<kind>-type" / category keyword               → category
 *   - else a salient keyword fallback so the rule still fires on its own topic.
 *
 * Returns null only on empty text. Pure, never throws.
 */
export function parseRule(input: string): ParsedRule | null {
  const text = safeString(input).trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();

  // ---- kind ----
  let kind: RuleKind;
  if (/^(pause|ask|confirm|check with me|stop)\b/.test(lower) || /\bpause (before|on)\b/.test(lower)) {
    kind = 'pause';
  } else if (/^(never|don'?t|do not|block|forbid|refuse)\b/.test(lower) || /\bnever\b/.test(lower)) {
    kind = 'block';
  } else if (/^(always|prefer|use)\b/.test(lower) || /\b(always use|prefer)\b/.test(lower)) {
    kind = 'prefer';
  } else {
    kind = 'pause';
  }

  // ---- trigger ----
  const pathGlob = extractPathLike(text);
  const category = classifyCategory(text);
  const trigger: RuleTrigger = {
    ...(pathGlob !== undefined ? { pathGlob } : {}),
    ...(category !== 'general' ? { category } : {}),
  };
  // Keyword fallback: if neither a path nor a real category was found, key the
  // rule on a salient word so it still fires on its own topic rather than nothing.
  if (Object.keys(trigger).length === 0) {
    const kw = salientKeyword(text);
    if (kw !== undefined) (trigger as { keyword?: string }).keyword = kw;
  }

  return { kind, trigger, text };
}

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'on', 'in', 'at', 'by', 'with', 'use',
  'always', 'never', 'pause', 'before', 'after', 'any', 'all', 'my', 'me', 'i', 'we', 'do',
  "don't", 'dont', 'not', 'this', 'that', 'when', 'goal', 'type', 'touch', 'change', 'file',
]);

/** The first content word (≥3 chars, not a stopword) — the keyword fallback. Pure. */
function salientKeyword(text: string): string | undefined {
  for (const raw of safeString(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) return raw;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Matching — the pure gate predicate
// ---------------------------------------------------------------------------

/** What an action carries, for the matcher to test rules against. */
export interface RuleMatchInput {
  /** The action's classified category (security/infra/…), when known. */
  readonly category?: RuleCategory;
  /** The paths the action would touch (goal/to-do changedPaths or planned paths). */
  readonly paths?: readonly string[];
  /** The action's free text (the goal title / to-do text), for keyword triggers. */
  readonly text?: string;
}

/**
 * Translate a simple glob (`*`, `**`, `?`) into a RegExp. `**` matches across
 * path separators; `*` matches within a segment; `?` one char. Anchored. Pure.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when ANY of the action's paths matches the glob (substring-or-glob). Pure. */
function pathMatches(glob: string, paths: readonly string[]): boolean {
  const g = glob.trim();
  if (g.length === 0) return false;
  const re = globToRegExp(g);
  for (const p of paths) {
    const path = safeString(p);
    if (re.test(path)) return true;
    // A bare filename / fragment with no glob meta also matches as a substring,
    // so `never touch package-lock.json` fires on `a/b/package-lock.json`.
    if (!/[*?]/.test(g) && path.includes(g)) return true;
  }
  return false;
}

/**
 * Does this rule fire on the given action? ALL present trigger fields must match
 * (AND). A trigger with NO fields never matches (an inert rule can't gate
 * everything). Pure, total, never throws.
 */
export function ruleMatches(rule: Rule, input: RuleMatchInput): boolean {
  const trg = rule.trigger;
  const hasCategory = trg.category !== undefined;
  const hasPath = trg.pathGlob !== undefined && trg.pathGlob.length > 0;
  const hasKeyword = trg.keyword !== undefined && trg.keyword.length > 0;
  if (!hasCategory && !hasPath && !hasKeyword) return false;

  if (hasCategory) {
    if (input.category === undefined || input.category !== trg.category) return false;
  }
  if (hasPath) {
    if (input.paths === undefined || !pathMatches(trg.pathGlob as string, input.paths)) return false;
  }
  if (hasKeyword) {
    const text = safeString(input.text).toLowerCase();
    if (!text.includes((trg.keyword as string).toLowerCase())) return false;
  }
  return true;
}

/**
 * The matcher: the rules that fire on this action, in PRECEDENCE order so the
 * caller can act on the strongest first — 'block' (refuse) before 'pause' (ask)
 * before 'prefer' (inform). Returns [] when nothing matches (the gate then does
 * NOTHING → byte-identical to no rules). Pure, total, never throws.
 */
export function matchRules(rules: readonly Rule[], input: RuleMatchInput): Rule[] {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const fired: Rule[] = rules.filter((r) => ruleMatches(r, input));
  const rank: Record<RuleKind, number> = { block: 0, pause: 1, prefer: 2 };
  return fired
    .map((r: Rule, i: number) => ({ r, i }))
    .sort((a, b) => rank[a.r.kind] - rank[b.r.kind] || a.i - b.i)
    .map((x) => x.r);
}

// ---------------------------------------------------------------------------
// CURRENT RULES — the compact prompt-context render (the partner's policy)
// ---------------------------------------------------------------------------

const RULES_CONTEXT_CAP = 12;

/** A short kind word for the context block. Pure, total. */
function kindWord(kind: RuleKind): string {
  switch (kind) {
    case 'block':
      return 'NEVER';
    case 'prefer':
      return 'PREFER';
    case 'pause':
    default:
      return 'PAUSE';
  }
}

/** A short, human description of what a rule's trigger applies to. Pure, total. */
function triggerWord(trigger: RuleTrigger): string {
  const parts: string[] = [];
  if (trigger.category !== undefined) parts.push(`${trigger.category} work`);
  if (trigger.pathGlob !== undefined && trigger.pathGlob.length > 0) parts.push(`path ${trigger.pathGlob}`);
  if (trigger.keyword !== undefined && trigger.keyword.length > 0) parts.push(`"${trigger.keyword}"`);
  return parts.length > 0 ? parts.join(', ') : 'any action';
}

/**
 * Render a COMPACT, plain-text CURRENT RULES block for the chat prompt context so
 * the partner KNOWS the standing rules it must follow — each rule's kind, what it
 * applies to, and the user's own words. This is half the "remember + enforce"
 * mechanism: the gate enforces at launch, this makes the conversational partner
 * aware of the policy every turn.
 *
 * Empty list ⇒ '' (NO block — the assembled prompt stays byte-identical to today).
 * PURE: no I/O, no time, no randomness; never throws.
 */
export function formatRulesForContext(rules: readonly Rule[]): string {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const shown = rules.slice(0, RULES_CONTEXT_CAP);
  const lines = shown.map((r) => `- [${kindWord(r.kind)} · ${triggerWord(r.trigger)}] ${r.text}`);
  const more = rules.length - shown.length;
  if (more > 0) lines.push(`- (+${String(more)} more rules)`);
  return (
    'STANDING RULES (the user set these — you MUST honour them: NEVER = refuse + explain, ' +
    'PAUSE = stop and confirm first, PREFER = follow this preference):\n' +
    lines.join('\n')
  );
}

/**
 * Filter rules for a scope: in-scope = global rules PLUS project rules whose
 * projectKey matches (or is null). Pure — the SAME two-scope filter the goal
 * board/context uses, so the prompt and the gate agree on what's in scope.
 */
export function selectRulesForScope(
  rules: readonly Rule[],
  projectKey: string | null,
): Rule[] {
  return rules.filter(
    (r) => r.scope === 'global' || r.projectKey === null || r.projectKey === projectKey,
  );
}
