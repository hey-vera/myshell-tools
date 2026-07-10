/**
 * Pure natural-language repo operation intent detection.
 *
 * This is not a slash-command parser. It is the typed seam Auto Smart can use
 * when a user says ordinary things like "undo that", "what changed?", or
 * "run the relevant tests". Impure git/test/checkpoint execution belongs in
 * interface/infra layers; this module only classifies intent and constraints.
 */

export type RepoOperationIntent =
  | 'none'
  | 'edit_and_verify'
  | 'verify_only'
  | 'summarize_diff'
  | 'undo_last_ai_change'
  | 'commit_current_ai_change'
  | 'plan_only'
  | 'provider_steering'
  | 'status'
  /** NL GitHub PR status (P1.6 thin): "pr status" / "github status" — not local git status. */
  | 'github_pr_status'
  /**
   * NL GitHub PR create (P1.6 thin extension): "create a pr" / "open a pull request"
   * / "gh pr create" — explicit create only; never steals plain "pr status".
   */
  | 'github_pr_create'
  /** NL GitLab MR status (P1.7 thin): "mr status" / "gitlab status" — not local git status. */
  | 'gitlab_mr_status';

export interface RepoIntentConstraint {
  readonly kind:
    | 'no_new_dependencies'
    | 'small_patch'
    | 'exclude_ui'
    | 'exclude_tests'
    | 'show_diff_before_applying'
    | 'do_not_commit'
    | 'provider_steering'
    | 'test_scope';
  readonly text: string;
}

export interface RepoIntent {
  readonly version: 1;
  readonly operation: RepoOperationIntent;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly mutatesWorkspace: boolean;
  readonly needsVerification: boolean;
  readonly constraints: readonly RepoIntentConstraint[];
  readonly rationale: string;
}

const TEXT_LIMIT = 160;
const MAX_CONSTRAINTS = 6;

function norm(input: string): string {
  return input
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function capText(input: string, limit = TEXT_LIMIT): string {
  return input.trim().slice(0, limit);
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function addConstraint(
  constraints: RepoIntentConstraint[],
  kind: RepoIntentConstraint['kind'],
  text: string,
): void {
  if (constraints.length >= MAX_CONSTRAINTS) return;
  if (constraints.some((c) => c.kind === kind && c.text === capText(text))) return;
  constraints.push({ kind, text: capText(text) });
}

const UNDO_RE: readonly RegExp[] = [
  /\bundo\b.*\b(that|this|last|change|edit|patch|thing)?\b/,
  /\brevert\b.*\b(that|this|last|change|edit|patch|thing)?\b/,
  /\broll\s*back\b.*\b(that|this|last|change|edit|patch|thing)?\b/,
  /\bback\s+out\b.*\b(change|edit|patch)?\b/,
  /\bgo\s+back\b.*\b(before|previous|last|one step)?\b/,
  /\bput\s+it\s+back\b/,
  /\brestore\b.*\b(previous|before|last)\b/,
];

const DIFF_RE: readonly RegExp[] = [
  /\bwhat\s+changed\b/,
  /\bwhat\s+did\s+you\s+change\b/,
  /\bshow\b.*\bdiff\b/,
  /\bdiff\s*(please|me|this)?\b/,
  /\bshow\b.*\bchanges\b/,
  /\bsummar(y|ize)\b.*\b(diff|changes?)\b/,
  /\bchange\s+summary\b/,
];

const COMMIT_RE: readonly RegExp[] = [
  /\bcommit\b.*\b(this|that|changes?|it|work)?\b/,
  /\bmake\s+a\s+commit\b/,
  /\bcreate\s+a\s+commit\b/,
  /\bgit\s+commit\b/,
  /\bsave\s+this\s+change\b/,
  /\bcheckpoint\s+this\b/,
];

const VERIFY_RE: readonly RegExp[] = [
  /\brun\b.*\b(tests?|checks?|typecheck|lint|suite)\b/,
  /\btest\b.*\b(this|it|change|changes|repo|work)?\b/,
  /\bverify\b.*\b(this|it|change|changes|repo|work)?\b/,
  /\btypecheck\b/,
  /\blint\b/,
  /\bmake\s+sure\b.*\b(passes|green|works)\b/,
  /\bget\b.*\b(tests?|suite|checks?)\b.*\b(green|passing)\b/,
];

/**
 * GitHub PR create phrases (P1.6 thin extension). Explicit create/open only —
 * must not match "pr status" / "current pr" / plain status language.
 * Checked before edit verbs so "create a pr for the fix" is not stealable by edit.
 */
const GITHUB_PR_CREATE_RE: readonly RegExp[] = [
  /\bcreate\s+(a\s+|an\s+|the\s+)?(pr|pull[\s-]?request)\b/,
  /\bopen\s+(a\s+|an\s+|the\s+)?(pr|pull[\s-]?request)\b/,
  /\bmake\s+(a\s+|an\s+|the\s+)?(pr|pull[\s-]?request)\b/,
  /\bsubmit\s+(a\s+|an\s+|the\s+)?(pr|pull[\s-]?request)\b/,
  /\bnew\s+(pr|pull[\s-]?request)\b/,
  /\bgh\s+pr\s+create\b/,
  /\bpr\s+create\b/,
  /\bpull[\s-]?request\s+create\b/,
];

/**
 * GitHub PR status phrases (P1.6 thin). Checked before generic STATUS_RE so
 * "pr status" / "github status" never collapse to local `git status`.
 */
const GITHUB_PR_STATUS_RE: readonly RegExp[] = [
  /\bpr\s+status\b/,
  /\bpull[\s-]?request\s+status\b/,
  /\bwhat'?s\s+the\s+(pr|pull[\s-]?request)\s+status\b/,
  /\bwhat\s+is\s+the\s+(pr|pull[\s-]?request)\s+status\b/,
  /\bgithub\s+(pr\s+)?status\b/,
  /\bstatus\s+of\s+(the\s+)?(pr|pull[\s-]?request)\b/,
  /\b(show|check|get)\s+(me\s+)?(the\s+)?(pr|pull[\s-]?request)\s+status\b/,
  /\bhow'?s\s+(the\s+)?pr\b/,
  /\bhow\s+is\s+(the\s+)?pr\b/,
  /\bcurrent\s+pr\b/,
];

/**
 * GitLab MR status phrases (P1.7 thin). Checked before generic STATUS_RE so
 * "mr status" / "gitlab status" never collapse to local `git status`.
 */
const GITLAB_MR_STATUS_RE: readonly RegExp[] = [
  /\bmr\s+status\b/,
  /\bmerge[\s-]?request\s+status\b/,
  /\bwhat'?s\s+the\s+(mr|merge[\s-]?request)\s+status\b/,
  /\bwhat\s+is\s+the\s+(mr|merge[\s-]?request)\s+status\b/,
  /\bgitlab\s+(mr\s+)?status\b/,
  /\bstatus\s+of\s+(the\s+)?(mr|merge[\s-]?request)\b/,
  /\b(show|check|get)\s+(me\s+)?(the\s+)?(mr|merge[\s-]?request)\s+status\b/,
  /\bhow'?s\s+(the\s+)?mr\b/,
  /\bhow\s+is\s+(the\s+)?mr\b/,
  /\bcurrent\s+mr\b/,
  /\blist\s+(the\s+)?(mrs|merge[\s-]?requests)\b/,
];

const STATUS_RE: readonly RegExp[] = [
  /\bstatus\b/,
  /\bwhere\s+are\s+we\b/,
  /\bwhat'?s\s+left\b/,
  /\bcurrent\s+state\b/,
  /\bis\s+the\s+repo\s+clean\b/,
  /\bdirty\s+state\b/,
];

const PLAN_RE: readonly RegExp[] = [
  /\bplan\b/,
  /\bdesign\b/,
  /\bthink\s+through\b/,
  /\bapproach\b/,
  /\bstrategy\b/,
];

const PROVIDER_RE: readonly RegExp[] = [
  /\b(use|ask|route\s+to|with)\s+(claude|codex|grok|opencode|deepseek)\b/,
  /\b(claude|codex|grok|opencode|deepseek)\s+(for|to)\b/,
  /\bsecond\s+opinion\b/,
  /\banother\s+model\b/,
];

const EDIT_RE: readonly RegExp[] = [
  /\bfix\b/,
  /\brepair\b/,
  /\bimplement\b/,
  /\bactuali[sz]e\b/,
  /\bwire\b/,
  /\bbuild\b/,
  /\bchange\b/,
  /\bupdate\b/,
  /\brefactor\b/,
  /\bcleanup\b/,
  /\badd\b/,
  /\bremove\b/,
  /\bmake\b.*\b(work|pass|green|default|better)\b/,
];

function extractConstraints(original: string, text: string): readonly RepoIntentConstraint[] {
  const constraints: RepoIntentConstraint[] = [];

  if (/\b(no|don't|do not|without)\s+(new\s+)?(deps|dependenc(y|ies)|packages?)\b/.test(text)) {
    addConstraint(constraints, 'no_new_dependencies', 'no new dependencies');
  }
  if (/\b(small|minimal|tiny|surgical)\s+(patch|diff|change|edit)?\b/.test(text)) {
    addConstraint(constraints, 'small_patch', 'small patch');
  }
  if (/\b(don't|do not|no|avoid)\s+(touch|change|edit|modify)[^,.]*\b(ui|frontend|front-end|css|styles?)\b/.test(text)) {
    addConstraint(constraints, 'exclude_ui', 'do not touch UI');
  }
  if (/\b(don't|do not|no|avoid)\s+(touch|change|edit|update|modify)[^,.]*\b(tests?|specs?)\b/.test(text)) {
    addConstraint(constraints, 'exclude_tests', 'do not touch tests');
  }
  if (/\b(show|review).*\bdiff\b.*\bbefore\b.*\b(apply|applying|change|changing)\b/.test(text)) {
    addConstraint(constraints, 'show_diff_before_applying', 'show diff before applying');
  }
  if (/\b(don't|do not|no)\s+commit\b/.test(text)) {
    addConstraint(constraints, 'do_not_commit', 'do not commit');
  }

  const provider = text.match(/\b(?:use|ask|route\s+to|with)\s+(claude|codex|grok|opencode|deepseek)\b/);
  if (provider?.[1] !== undefined) {
    addConstraint(constraints, 'provider_steering', provider[1]);
  } else if (/\bsecond\s+opinion\b|\banother\s+model\b/.test(text)) {
    addConstraint(constraints, 'provider_steering', capText(original));
  }

  if (/\bunit\s+tests?\b/.test(text) || /\bjust\s+unit\b/.test(text)) addConstraint(constraints, 'test_scope', 'unit');
  if (/\bintegration\s+tests?\b/.test(text) || /\bjust\s+integration\b/.test(text)) addConstraint(constraints, 'test_scope', 'integration');
  if (/\be2e\b/.test(text)) addConstraint(constraints, 'test_scope', 'e2e');
  if (/\btypecheck\b/.test(text)) addConstraint(constraints, 'test_scope', 'typecheck');
  if (/\blint\b/.test(text)) addConstraint(constraints, 'test_scope', 'lint');
  if (/\bfull\s+test\s+suite\b|\ball\s+tests?\b/.test(text)) addConstraint(constraints, 'test_scope', 'full');

  return constraints;
}

export function inferRepoIntent(task: string): RepoIntent {
  const text = norm(task);
  const constraints = extractConstraints(task, text);

  if (text.length === 0) {
    return {
      version: 1,
      operation: 'none',
      confidence: 'high',
      mutatesWorkspace: false,
      needsVerification: false,
      constraints,
      rationale: 'empty turn has no repo operation intent',
    };
  }

  const verify = hasAny(text, VERIFY_RE);
  const edit = hasAny(text, EDIT_RE);
  const plan = hasAny(text, PLAN_RE);
  const provider = hasAny(text, PROVIDER_RE);
  const doNotCommit = constraints.some((c) => c.kind === 'do_not_commit');
  const undo = hasAny(text, UNDO_RE) && !/\b(actuali[sz]e|design|plan|strategy)\b.*\bundo\b/.test(text);

  if (plan && !edit && !verify) {
    return {
      version: 1,
      operation: 'plan_only',
      confidence: 'medium',
      mutatesWorkspace: false,
      needsVerification: false,
      constraints,
      rationale: 'natural-language planning request without edit verb',
    };
  }

  if (undo) {
    return {
      version: 1,
      operation: 'undo_last_ai_change',
      confidence: 'high',
      mutatesWorkspace: true,
      needsVerification: false,
      constraints,
      rationale: 'natural-language undo/revert request',
    };
  }

  if (hasAny(text, DIFF_RE)) {
    return {
      version: 1,
      operation: 'summarize_diff',
      confidence: 'high',
      mutatesWorkspace: false,
      needsVerification: false,
      constraints,
      rationale: 'natural-language diff/change-summary request',
    };
  }

  if (!doNotCommit && hasAny(text, COMMIT_RE)) {
    return {
      version: 1,
      operation: 'commit_current_ai_change',
      confidence: 'high',
      mutatesWorkspace: true,
      needsVerification: false,
      constraints,
      rationale: 'natural-language commit request',
    };
  }

  // Explicit PR create before edit verbs ("create a pr for the fix") and before
  // PR status ("pr status" must remain status-only — create patterns exclude it).
  if (hasAny(text, GITHUB_PR_CREATE_RE)) {
    return {
      version: 1,
      operation: 'github_pr_create',
      confidence: 'high',
      mutatesWorkspace: true,
      needsVerification: false,
      constraints,
      rationale: 'natural-language GitHub PR create request',
    };
  }

  if (edit) {
    return {
      version: 1,
      operation: 'edit_and_verify',
      confidence: verify ? 'high' : 'medium',
      mutatesWorkspace: true,
      needsVerification: true,
      constraints,
      rationale: verify
        ? 'natural-language edit request with explicit verification'
        : 'natural-language repo edit request',
    };
  }

  if (verify) {
    return {
      version: 1,
      operation: 'verify_only',
      confidence: 'high',
      mutatesWorkspace: false,
      needsVerification: true,
      constraints,
      rationale: 'natural-language verification request',
    };
  }

  if (provider) {
    return {
      version: 1,
      operation: 'provider_steering',
      confidence: 'medium',
      mutatesWorkspace: false,
      needsVerification: false,
      constraints,
      rationale: 'natural-language provider steering request',
    };
  }

  // PR/MR/forge status before generic "status" (which would also match "pr status").
  if (hasAny(text, GITHUB_PR_STATUS_RE)) {
    return {
      version: 1,
      operation: 'github_pr_status',
      confidence: 'high',
      mutatesWorkspace: false,
      needsVerification: false,
      constraints,
      rationale: 'natural-language GitHub PR status request',
    };
  }

  if (hasAny(text, GITLAB_MR_STATUS_RE)) {
    return {
      version: 1,
      operation: 'gitlab_mr_status',
      confidence: 'high',
      mutatesWorkspace: false,
      needsVerification: false,
      constraints,
      rationale: 'natural-language GitLab MR status request',
    };
  }

  if (hasAny(text, STATUS_RE)) {
    return {
      version: 1,
      operation: 'status',
      confidence: 'medium',
      mutatesWorkspace: false,
      needsVerification: false,
      constraints,
      rationale: 'natural-language repo status request',
    };
  }

  return {
    version: 1,
    operation: 'none',
    confidence: 'low',
    mutatesWorkspace: false,
    needsVerification: false,
    constraints,
    rationale: 'no repo operation intent detected',
  };
}



