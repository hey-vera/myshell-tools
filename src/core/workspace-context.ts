/**
 * src/core/workspace-context.ts — WORKSPACE FORGE CONTEXT (P0.19 pure half).
 *
 * Detects *which world* the chat is in (GitHub / GitLab / other forge / local-only)
 * from already-gathered facts: git root, remotes, and CLI tool presence. Pure
 * partner-vocabulary formatter (P0.20 light) so the model says PR vs MR, checks
 * vs pipelines, and never pretends GitHub when the remote is not GitHub.
 *
 * PURE: no I/O, no time, no randomness. Classification + rendering only.
 * Impure gather lives in `src/infra/workspace-context.ts`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Host class for the active workspace's primary remote. */
export type ForgeHostClass = 'github' | 'gitlab' | 'other' | 'none';

/** One line from `git remote -v` (name + URL + fetch/push). */
export interface GitRemote {
  readonly name: string;
  readonly url: string;
  readonly purpose: 'fetch' | 'push' | 'other';
}

/** Whether forge CLIs are present on PATH (already probed by infra). */
export interface ForgeTools {
  readonly gh: boolean;
  readonly glab: boolean;
}

/**
 * Distilled workspace forge facts. Built pure from port outputs so tests can
 * fixture every host class without real git.
 */
export interface WorkspaceContext {
  readonly cwd: string;
  /** Absolute git toplevel, or null when not a git repo / git missing. */
  readonly gitRoot: string | null;
  readonly remotes: readonly GitRemote[];
  readonly hostClass: ForgeHostClass;
  /** URL of the remote used for classification (origin preferred), or null. */
  readonly primaryRemoteUrl: string | null;
  readonly tools: ForgeTools;
}

/** Partner-facing vocabulary for the active forge class. */
export interface PartnerForgeVocabulary {
  /** Short label: PR / MR / change request. */
  readonly changeRequest: 'PR' | 'MR' | 'change request';
  readonly changeRequestLong: string;
  /** CI surface name. */
  readonly ciLabel: 'checks' | 'pipelines' | 'CI';
  /** Honest CLI hint, or null when no relevant forge CLI is present. */
  readonly cliHint: string | null;
  /** True when there is no remote forge (local git or pure files). */
  readonly localOnly: boolean;
}

/** Self-cap so forge orientation never crowds the ENVIRONMENT floor. */
export const FORGE_BLOCK_CHAR_CAP = 700;

// ---------------------------------------------------------------------------
// Parse — `git remote -v` stdout
// ---------------------------------------------------------------------------

/**
 * Parse `git remote -v` porcelain into remotes. Tolerant of blank lines and
 * Windows path-ish noise; never throws. PURE.
 *
 * Example line: `origin  git@github.com:acme/app.git (fetch)`
 */
export function parseGitRemoteV(stdout: string): readonly GitRemote[] {
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  const out: GitRemote[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // name <whitespace> url <optional (fetch|push)>
    const m = /^(\S+)\s+(\S+)(?:\s+\((\w+)\))?$/.exec(line);
    if (m === null) continue;
    const name = m[1] ?? '';
    const url = m[2] ?? '';
    const purposeRaw = (m[3] ?? '').toLowerCase();
    if (name.length === 0 || url.length === 0) continue;
    const purpose: GitRemote['purpose'] =
      purposeRaw === 'fetch' ? 'fetch' : purposeRaw === 'push' ? 'push' : 'other';
    out.push({ name, url, purpose });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classify host from a single remote URL
// ---------------------------------------------------------------------------

/**
 * Extract the hostname from a git remote URL (HTTPS, ssh://, or scp-like
 * `git@host:path`). Returns null when unparseable. PURE.
 */
export function extractRemoteHost(url: string): string | null {
  const u = url.trim();
  if (u.length === 0) return null;

  // scp-like: git@github.com:org/repo.git  (not a real URL)
  const scp = /^[^@\s/]+@([^:\s]+):/.exec(u);
  if (scp !== null) {
    const host = (scp[1] ?? '').toLowerCase();
    return host.length > 0 ? host : null;
  }

  // scheme://host/...  (https, ssh, git)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
    try {
      const parsed = new URL(u);
      const host = parsed.hostname.toLowerCase();
      return host.length > 0 ? host : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Classify a single remote URL into github | gitlab | other.
 * Unparseable / empty → null (caller decides). PURE.
 */
export function classifyRemoteUrl(url: string): Exclude<ForgeHostClass, 'none'> | null {
  const host = extractRemoteHost(url);
  if (host === null) return null;
  return classifyHostName(host);
}

/** Host-name classifier (after extraction). PURE. */
export function classifyHostName(host: string): Exclude<ForgeHostClass, 'none'> {
  const h = host.trim().toLowerCase();
  if (h.length === 0) return 'other';
  // GitHub.com + GHE-style github.company.com / *.github.com
  if (
    h === 'github.com' ||
    h.endsWith('.github.com') ||
    h.startsWith('github.')
  ) {
    return 'github';
  }
  // GitLab.com + self-managed gitlab.* / *.gitlab.com
  if (
    h === 'gitlab.com' ||
    h.endsWith('.gitlab.com') ||
    h.startsWith('gitlab.')
  ) {
    return 'gitlab';
  }
  return 'other';
}

/**
 * Pick the primary remote (prefer origin fetch) and classify the workspace.
 * Empty remotes → hostClass `none`. PURE.
 */
export function classifyForgeFromRemotes(remotes: readonly GitRemote[]): {
  readonly hostClass: ForgeHostClass;
  readonly primaryRemoteUrl: string | null;
} {
  if (remotes.length === 0) {
    return { hostClass: 'none', primaryRemoteUrl: null };
  }
  const primary =
    remotes.find((r) => r.name === 'origin' && r.purpose === 'fetch') ??
    remotes.find((r) => r.name === 'origin') ??
    remotes.find((r) => r.purpose === 'fetch') ??
    remotes[0]!;
  const url = primary.url;
  const cls = classifyRemoteUrl(url);
  return {
    hostClass: cls ?? 'other',
    primaryRemoteUrl: url,
  };
}

/**
 * Assemble a {@link WorkspaceContext} from already-probed facts. PURE.
 * When `gitRoot` is null, host is forced to `none` (no forge theater for non-git).
 */
export function buildWorkspaceContext(input: {
  readonly cwd: string;
  readonly gitRoot: string | null;
  readonly remotes: readonly GitRemote[];
  readonly tools: ForgeTools;
}): WorkspaceContext {
  if (input.gitRoot === null) {
    return {
      cwd: input.cwd,
      gitRoot: null,
      remotes: [],
      hostClass: 'none',
      primaryRemoteUrl: null,
      tools: input.tools,
    };
  }
  const { hostClass, primaryRemoteUrl } = classifyForgeFromRemotes(input.remotes);
  return {
    cwd: input.cwd,
    gitRoot: input.gitRoot,
    remotes: input.remotes,
    hostClass,
    primaryRemoteUrl,
    tools: input.tools,
  };
}

// ---------------------------------------------------------------------------
// Partner vocabulary (P0.20 light)
// ---------------------------------------------------------------------------

/**
 * Map host class + tools → partner vocabulary. PURE + deterministic.
 * Honesty: never invents a CLI that is not on PATH; local-only is explicit.
 */
export function partnerForgeVocabulary(
  ctx: Pick<WorkspaceContext, 'hostClass' | 'tools' | 'gitRoot'>,
): PartnerForgeVocabulary {
  switch (ctx.hostClass) {
    case 'github':
      return {
        changeRequest: 'PR',
        changeRequestLong: 'pull request (PR)',
        ciLabel: 'checks',
        cliHint: ctx.tools.gh
          ? 'gh is on PATH — prefer it for PRs, checks, reviews when useful'
          : 'gh not found on PATH — use local git; do not pretend gh is available',
        localOnly: false,
      };
    case 'gitlab':
      return {
        changeRequest: 'MR',
        changeRequestLong: 'merge request (MR)',
        ciLabel: 'pipelines',
        cliHint: ctx.tools.glab
          ? 'glab is on PATH — prefer it for MRs and pipelines when useful'
          : 'glab not found on PATH — use local git / honest GitLab fallback; do not assume gh',
        localOnly: false,
      };
    case 'other':
      return {
        changeRequest: 'change request',
        changeRequestLong: 'change request / merge flow (host-native terms)',
        ciLabel: 'CI',
        cliHint:
          ctx.tools.gh || ctx.tools.glab
            ? `forge is not GitHub/GitLab.com — do not assume gh/glab match this remote${
                ctx.tools.gh ? ' (gh present but may not apply)' : ''
              }${ctx.tools.glab ? ' (glab present but may not apply)' : ''}`
            : 'no gh/glab assumed for this forge — local git + honest limits',
        localOnly: false,
      };
    case 'none':
    default:
      return {
        changeRequest: 'change request',
        changeRequestLong: 'no remote change-request (local work only)',
        ciLabel: 'CI',
        cliHint: null,
        localOnly: true,
      };
  }
}

/**
 * Human host label for orientation lines (never fabricates a company name).
 * Uses primary remote host when available. PURE.
 */
export function forgeHostLabel(ctx: WorkspaceContext): string {
  switch (ctx.hostClass) {
    case 'github': {
      const host = ctx.primaryRemoteUrl ? extractRemoteHost(ctx.primaryRemoteUrl) : null;
      return host !== null ? `GitHub (${host})` : 'GitHub';
    }
    case 'gitlab': {
      const host = ctx.primaryRemoteUrl ? extractRemoteHost(ctx.primaryRemoteUrl) : null;
      return host !== null ? `GitLab (${host})` : 'GitLab';
    }
    case 'other': {
      const host = ctx.primaryRemoteUrl ? extractRemoteHost(ctx.primaryRemoteUrl) : null;
      return host !== null ? `other forge (${host})` : 'other forge';
    }
    case 'none':
      return ctx.gitRoot !== null ? 'local-only (git, no remote)' : 'local-only (no git repo)';
  }
}

/**
 * Prompt block: partner vocabulary + forge facts. Self-capped. Returns '' when
 * there is nothing useful to say (should not happen for a built context). PURE.
 *
 * Wired into ENVIRONMENT-adjacent context so the partner adapts language without
 * user re-explaining the forge each turn.
 */
export function formatPartnerForgeBlock(ctx: WorkspaceContext): string {
  const vocab = partnerForgeVocabulary(ctx);
  const host = forgeHostLabel(ctx);
  const toolBits: string[] = [];
  toolBits.push(ctx.tools.gh ? 'gh on PATH' : 'gh not found');
  toolBits.push(ctx.tools.glab ? 'glab on PATH' : 'glab not found');

  const lines: string[] = [
    'WORKSPACE FORGE (authoritative forge vocabulary — use THIS world\'s language; do NOT assume GitHub PR/checks UX when the host is not GitHub):',
    `- host: ${host}`,
  ];

  if (ctx.gitRoot !== null) {
    lines.push(`- git root: ${ctx.gitRoot}`);
  }
  if (ctx.primaryRemoteUrl !== null) {
    lines.push(`- primary remote: ${ctx.primaryRemoteUrl}`);
  }

  if (vocab.localOnly) {
    lines.push(
      '- vocabulary: local-only — no PR/MR theater; status/diff/edit/test/undo stay first-class without a forge',
    );
  } else {
    lines.push(
      `- vocabulary: ${vocab.changeRequestLong}; CI surface: ${vocab.ciLabel}`,
    );
  }

  lines.push(`- tools: ${toolBits.join('; ')}`);
  if (vocab.cliHint !== null) {
    lines.push(`- posture: ${vocab.cliHint}`);
  } else if (vocab.localOnly) {
    lines.push(
      '- posture: pure local / offline-friendly — never invent remote PRs, checks, or gh commands',
    );
  }

  const block = lines.join('\n');
  return block.length > FORGE_BLOCK_CHAR_CAP
    ? block.slice(0, FORGE_BLOCK_CHAR_CAP)
    : block;
}

/**
 * One quiet dim orientation line for chat open. Returns null when the workspace
 * is the GitHub default (no spam) or when there is nothing honest to surface.
 * PURE.
 */
export function formatForgeOrientationLine(ctx: WorkspaceContext): string | null {
  // GitHub is the historical default assumption — no orientation spam.
  if (ctx.hostClass === 'github') return null;

  const vocab = partnerForgeVocabulary(ctx);
  switch (ctx.hostClass) {
    case 'gitlab': {
      const tool = ctx.tools.glab ? 'glab ready' : 'glab not on PATH';
      return `Forge: GitLab · say ${vocab.changeRequest} / ${vocab.ciLabel} · ${tool}`;
    }
    case 'other': {
      const host = ctx.primaryRemoteUrl
        ? extractRemoteHost(ctx.primaryRemoteUrl) ?? 'remote'
        : 'remote';
      return `Forge: ${host} · not GitHub — no gh assumptions`;
    }
    case 'none':
      return ctx.gitRoot !== null
        ? 'Local-only workspace · no remote forge'
        : 'No git repo here · local file work';
    default:
      return null;
  }
}

/**
 * Append the forge partner block under an existing ENVIRONMENT string.
 * Empty forge → env unchanged. Both empty → ''. PURE.
 */
export function mergeEnvironmentWithForge(
  environmentContext: string,
  forge: WorkspaceContext | null | undefined,
): string {
  const env = environmentContext.trim();
  if (forge === null || forge === undefined) return env;
  const forgeBlock = formatPartnerForgeBlock(forge).trim();
  if (forgeBlock.length === 0) return env;
  if (env.length === 0) return forgeBlock;
  return `${env}\n\n${forgeBlock}`;
}
