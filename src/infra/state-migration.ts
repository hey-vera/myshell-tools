/**
 * src/infra/state-migration.ts — copy-only, fail-soft, idempotent migration
 * from legacy .myshell-tools locations to the new cross-platform layout.
 *
 * Design rules:
 *  - Copy, NEVER move. NEVER delete old files.
 *  - runStateMigration NEVER throws (catch-all → report with errors list).
 *  - Idempotent: re-running with the same FS state produces 'complete' /
 *    'already-present' with no duplicate work.
 *  - Migration reports list paths + status only; token CONTENTS are never logged.
 */

import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { AppStateLayout, StateContext } from './state-layout.js';
import { projectStateDirs } from './state-layout.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type MigrationActionType =
  | 'copy'
  | 'already-present'
  | 'conflict'
  | 'jsonl-merge'
  | 'skip';

export interface MigrationAction {
  readonly type: MigrationActionType;
  readonly sourceRoot: string;
  readonly relativePath: string;
  readonly sourcePath: string;
  readonly destPath: string;
}

export interface MigrationPlan {
  readonly fromRoots: readonly string[];
  readonly to: AppStateLayout;
  readonly actions: readonly MigrationAction[];
}

export type MigrationStatus = 'complete' | 'partial' | 'conflicts';

export interface MigrationReport {
  status: MigrationStatus;
  copied: string[];
  alreadyPresent: string[];
  conflicts: string[];
  merged: string[];
  errors: string[];
  manifestPath: string;
}

interface ManifestEntry {
  readonly relativePath: string;
  readonly sourceRoot: string;
  readonly status: string;
}

interface MigrationManifest {
  readonly timestamp: string;
  readonly sourceRoots: readonly string[];
  readonly destRoots: { readonly config: string; readonly state: string; readonly cache: string };
  readonly entries: readonly ManifestEntry[];
  readonly status: MigrationStatus;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Top-level names recognised in an old .myshell-tools root. Anything else is skipped. */
const KNOWN_TOP_LEVEL = new Set([
  'config.json',
  'credentials.json',
  'subscriptions.json',
  'update-check.json',
  'ledger.jsonl',
  'command-audit.jsonl',
  'intent-versions.jsonl',
  'eval-results.jsonl',
  'conversations',
  '.session-archive',
  'goals',
  'memory',
  'rules',
  'provider-homes',
  'sessions',
  'evidence',
]);

/** Files that should be merged by exact-line dedupe rather than overwritten. */
const JSONL_MERGE_PATHS = new Set([
  'ledger.jsonl',
  'command-audit.jsonl',
  'intent-versions.jsonl',
  'eval-results.jsonl',
  join('memory', 'taste.jsonl'),
]);

/** Files that carry tokens / secrets — mode 0o600 is best-effort on copy. */
const PRIVATE_FILES = new Set([
  'credentials.json',
  'subscriptions.json',
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function stamp(): string {
  return Date.now().toString(36) + '.' + randomBytes(3).toString('hex');
}

function platformSep(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

/**
 * True when `root` matches any of the layout's new roots.
 * Normalises trailing separators for comparison.
 */
function isNewRoot(root: string, layout: AppStateLayout): boolean {
  const norm = (s: string) => s.replace(/[/\\]+$/, '');
  const n = norm(root);
  return (
    n === norm(layout.configRoot) ||
    n === norm(layout.stateRoot) ||
    n === norm(layout.cacheRoot)
  );
}

/** Map an old relative path (posix-slash) to its corresponding new destination. */
function mapDest(
  relPath: string,
  layout: AppStateLayout,
  projectDirs: ReturnType<typeof projectStateDirs>,
): string | null {
  const p = layout.paths;

  // relPath always uses '/' from walkDir — normalise for consistent prefix matching
  const r = relPath.replace(/\\/g, '/');

  switch (r) {
    case 'config.json':
      return p.configFile;
    case 'credentials.json':
      return p.credentialsFile;
    case 'subscriptions.json':
      return p.subscriptionsFile;
    case 'update-check.json':
      return p.updateCacheFile;
    case 'ledger.jsonl':
      return projectDirs.ledgerFile;
    case 'command-audit.jsonl':
      return projectDirs.commandAuditFile;
    case 'intent-versions.jsonl':
      return projectDirs.intentVersionsFile;
    case 'eval-results.jsonl':
      return projectDirs.evalResultsFile;
  }

  if (r.startsWith('conversations/'))
    return join(p.conversationsDir, r.slice('conversations/'.length));
  if (r.startsWith('.session-archive/'))
    return join(p.conversationArchiveDir, r.slice('.session-archive/'.length));
  if (r.startsWith('goals/'))
    return join(p.goalsDir, r.slice('goals/'.length));
  if (r.startsWith('memory/'))
    return join(p.memoryDir, r.slice('memory/'.length));
  if (r.startsWith('rules/'))
    return join(p.rulesDir, r.slice('rules/'.length));
  if (r.startsWith('provider-homes/'))
    return join(p.providerHomesDir, r.slice('provider-homes/'.length));
  if (r.startsWith('sessions/'))
    return join(projectDirs.sessionsDir, r.slice('sessions/'.length));
  if (r.startsWith('evidence/'))
    return join(projectDirs.evidenceDir, r.slice('evidence/'.length));

  return null;
}

function isPrivate(relPath: string): boolean {
  return PRIVATE_FILES.has(relPath);
}

function isJSONLMerge(relPath: string): boolean {
  return JSONL_MERGE_PATHS.has(relPath.replace(/\\/g, '/'));
}

/** Check that the top-level component of `relPath` is a known myshell entry. */
function isKnownTopLevel(relPosix: string): boolean {
  const top = relPosix.split('/')[0] ?? '';
  return KNOWN_TOP_LEVEL.has(top) || top === '.migrated-to';
}

// ── FS walker (scanning only — no writes) ───────────────────────────────────

async function walkDir(root: string, dir: string = root): Promise<string[]> {
  const results: string[] = [];
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = (await readdir(dir, {
      withFileTypes: true,
    })) as unknown as typeof entries;
  } catch {
    return results; // directory missing or unreadable → skip
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relPosix = relative(root, full).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      const top = relPosix.split('/')[0] ?? '';
      if (KNOWN_TOP_LEVEL.has(top)) {
        results.push(...(await walkDir(root, full)));
      }
      // unknown dirs (e.g. .ssh, .config) are silently skipped
    } else if (entry.isFile()) {
      if (isKnownTopLevel(relPosix) && relPosix !== '.migrated-to') {
        results.push(relPosix);
      }
    }
    // symlinks etc. are ignored
  }

  return results;
}

// ── Candidate old roots ─────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

function resolveCandidateRoots(layout: AppStateLayout, ctx: StateContext): string[] {
  const homeDir = normalizePath(ctx.homeDir);
  const cwd = normalizePath(ctx.cwd);
  const roots: string[] = [];
  const sep = platformSep(layout.paths.configFile);
  const added = new Set<string>();

  const addRoot = (candidate: string) => {
    if (added.has(candidate)) return;
    if (isNewRoot(candidate, layout)) return;
    added.add(candidate);
    roots.push(candidate);
  };

  // Always: <homeDir>/.myshell-tools
  const homeRoot = homeDir + sep + '.myshell-tools';
  addRoot(homeRoot);

  // Always: <cwd>/.myshell-tools
  const cwdRoot = cwd + sep + '.myshell-tools';
  addRoot(cwdRoot);

  // Windows: HOME/.myshell-tools if HOME is set and differs from USERPROFILE
  if (ctx.platform === 'win32') {
    const homeEnv = ctx.env['HOME'];
    const userProfile = ctx.env['USERPROFILE'];
    if (
      homeEnv &&
      userProfile &&
      normalizePath(homeEnv) !== normalizePath(userProfile)
    ) {
      addRoot(normalizePath(homeEnv) + '/.myshell-tools');
    }
  }

  return roots;
}

// ── Plan (read-only) ────────────────────────────────────────────────────────

/**
 * Scan candidate old roots and build a migration plan with per-file actions.
 * Read-only — never writes to the filesystem.
 */
export async function planStateMigration(
  layout: AppStateLayout,
  ctx: StateContext,
): Promise<MigrationPlan> {
  const fromRoots = resolveCandidateRoots(layout, ctx);
  const projDirs = projectStateDirs(layout, ctx.cwd);
  const actions: MigrationAction[] = [];

  for (const root of fromRoots) {
    let files: string[];
    try {
      files = await walkDir(root);
    } catch {
      continue; // root doesn't exist or can't be read
    }

    for (const relPosix of files) {
      const sourcePath = join(root, relPosix);
      const destPath = mapDest(relPosix, layout, projDirs);
      if (destPath === null) {
        actions.push({
          type: 'skip',
          sourceRoot: root,
          relativePath: relPosix,
          sourcePath,
          destPath: '',
        });
        continue;
      }

      // Check destination state
      let destExists = false;
      let bytesIdentical = false;
      try {
        const [srcBuf, destBuf] = await Promise.all([
          readFile(sourcePath),
          readFile(destPath).catch(() => null),
        ]);
        if (destBuf !== null) {
          destExists = true;
          bytesIdentical = srcBuf.equals(destBuf);
        }
      } catch {
        // Source read failed — skip this file
        actions.push({
          type: 'skip',
          sourceRoot: root,
          relativePath: relPosix,
          sourcePath,
          destPath,
        });
        continue;
      }

      if (!destExists) {
        // Special: sessions/current.jsonl → imported-<stamp>.jsonl
        // Handled at execution time; plan just says 'copy'
        actions.push({
          type: 'copy',
          sourceRoot: root,
          relativePath: relPosix,
          sourcePath,
          destPath,
        });
      } else if (bytesIdentical) {
        actions.push({
          type: 'already-present',
          sourceRoot: root,
          relativePath: relPosix,
          sourcePath,
          destPath,
        });
      } else if (relPosix === 'credentials.json') {
        // Credentials conflict → NEVER merge
        actions.push({
          type: 'conflict',
          sourceRoot: root,
          relativePath: relPosix,
          sourcePath,
          destPath,
        });
      } else if (isJSONLMerge(relPosix)) {
        actions.push({
          type: 'jsonl-merge',
          sourceRoot: root,
          relativePath: relPosix,
          sourcePath,
          destPath,
        });
      } else {
        actions.push({
          type: 'conflict',
          sourceRoot: root,
          relativePath: relPosix,
          sourcePath,
          destPath,
        });
      }
    }
  }

  return { fromRoots, to: layout, actions };
}

// ── Atomic copy helper ──────────────────────────────────────────────────────

async function atomicCopyWithMode(
  srcPath: string,
  destPath: string,
  mode?: number,
): Promise<void> {
  const tmp = `${destPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    const data = await readFile(srcPath);
    const writeMode = mode !== undefined ? { mode } : undefined;
    await writeFile(tmp, data, writeMode);
    await rename(tmp, destPath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

// ── JSONL merge ─────────────────────────────────────────────────────────────

async function mergeJSONL(srcPath: string, destPath: string): Promise<boolean> {
  const [srcContent, destContent] = await Promise.all([
    readFile(srcPath, 'utf8'),
    readFile(destPath, 'utf8'),
  ]);

  const srcLines = srcContent.split('\n').filter((l) => l.trim() !== '');
  const destLines = destContent.split('\n').filter((l) => l.trim() !== '');

  const seen = new Set<string>();
  const merged: string[] = [];

  for (const line of destLines) {
    seen.add(line);
    merged.push(line);
  }

  let added = 0;
  for (const line of srcLines) {
    if (!seen.has(line)) {
      seen.add(line);
      merged.push(line);
      added++;
    }
  }

  if (added === 0) return false; // no new lines
  await writeFile(destPath, merged.join('\n') + '\n', 'utf8');
  return true;
}

// ── Best-effort chmod ──────────────────────────────────────────────────────

async function bestEffortChmod(filePath: string, mode: number): Promise<void> {
  try {
    const { chmod } = await import('node:fs/promises');
    await chmod(filePath, mode);
  } catch {
    // EPERM on Windows, or file missing already — ignore
  }
}

// ── Manifest ────────────────────────────────────────────────────────────────

async function writeManifest(
  layout: AppStateLayout,
  fromRoots: readonly string[],
  entries: ManifestEntry[],
  status: MigrationStatus,
): Promise<string> {
  try {
    await mkdir(layout.paths.migrationDir, { recursive: true, mode: 0o700 });
  } catch {
    // dir may already exist with different perms — best-effort
  }

  const manifest: MigrationManifest = {
    timestamp: new Date().toISOString(),
    sourceRoots: fromRoots,
    destRoots: {
      config: layout.configRoot,
      state: layout.stateRoot,
      cache: layout.cacheRoot,
    },
    entries,
    status,
  };

  const manifestPath = join(layout.paths.migrationDir, 'manifest.json');
  const tmp = `${manifestPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    await rename(tmp, manifestPath);
  } catch {
    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch {
      /* best-effort */
    }
  }

  return manifestPath;
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * Execute a migration plan. NEVER throws — always returns a MigrationReport.
 */
export async function runStateMigration(
  plan: MigrationPlan,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    status: 'complete',
    copied: [],
    alreadyPresent: [],
    conflicts: [],
    merged: [],
    errors: [],
    manifestPath: '',
  };

  const manifestEntries: ManifestEntry[] = [];

  const record = (action: MigrationAction, status: string) => {
    manifestEntries.push({
      relativePath: action.relativePath,
      sourceRoot: action.sourceRoot,
      status,
    });
  };

  // Ensure migration dir exists
  try {
    await mkdir(plan.to.paths.migrationDir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }

  for (const action of plan.actions) {
    try {
      switch (action.type) {
        case 'copy': {
          let destPath = action.destPath;

          // Special: sessions/current.jsonl → imported-<stamp>.jsonl
          if (
            action.relativePath.replace(/\\/g, '/') === 'sessions/current.jsonl'
          ) {
            const projDirs = projectStateDirs(plan.to, ''); // cwd unused for sessionsDir
            const sessionsDir = projDirs.sessionsDir;
            await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
            destPath = join(sessionsDir, `imported-${stamp()}.jsonl`);
          }

          // Ensure destination directory exists
          await mkdir(dirname(destPath), {
            recursive: true,
            mode: 0o700,
          });

          const mode = isPrivate(action.relativePath) ? 0o600 : undefined;
          await atomicCopyWithMode(action.sourcePath, destPath, mode);

          if (mode !== undefined) {
            await bestEffortChmod(destPath, 0o600);
          }

          report.copied.push(action.relativePath);
          record(action, 'copied');
          break;
        }

        case 'already-present': {
          report.alreadyPresent.push(action.relativePath);
          record(action, 'already-present');
          break;
        }

        case 'conflict': {
          // Keep destination unchanged; copy source to conflicts
          const conflictsDir = join(
            plan.to.paths.migrationDir,
            'conflicts',
          );
          await mkdir(conflictsDir, { recursive: true, mode: 0o700 });

          const conflictPath = join(
            conflictsDir,
            `${action.relativePath.replace(/[/\\]/g, '-')}.${stamp()}`,
          );

          const mode = isPrivate(action.relativePath) ? 0o600 : undefined;
          await atomicCopyWithMode(action.sourcePath, conflictPath, mode);

          if (mode !== undefined) {
            await bestEffortChmod(conflictPath, 0o600);
          }

          report.conflicts.push(action.relativePath);
          record(action, 'conflict');
          break;
        }

        case 'jsonl-merge': {
          // Ensure destination directory exists before merge
          await mkdir(dirname(action.destPath), {
            recursive: true,
            mode: 0o700,
          });

          // If dest doesn't exist, copy first then merge
          let destExists = true;
          try {
            await stat(action.destPath);
          } catch {
            destExists = false;
            await atomicCopyWithMode(action.sourcePath, action.destPath);
          }

          if (destExists) {
            const mergedOk = await mergeJSONL(
              action.sourcePath,
              action.destPath,
            );
            if (mergedOk) {
              report.merged.push(action.relativePath);
              record(action, 'merged');
            } else {
              report.alreadyPresent.push(action.relativePath);
              record(action, 'already-present');
            }
          } else {
            report.copied.push(action.relativePath);
            record(action, 'copied');
          }
          break;
        }

        case 'skip': {
          record(action, 'skipped');
          break;
        }
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      report.errors.push(`${action.relativePath}: ${msg}`);
      record(action, `error: ${msg}`);
    }
  }

  // Determine final status
  if (report.errors.length > 0 || report.conflicts.length > 0) {
    if (report.errors.length > 0) report.status = 'partial';
    if (report.conflicts.length > 0) report.status = 'conflicts';
  }

  // Write manifest
  try {
    report.manifestPath = await writeManifest(
      plan.to,
      plan.fromRoots,
      manifestEntries,
      report.status,
    );
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : String(err);
    report.errors.push(`manifest: ${msg}`);
    if (report.status === 'complete') report.status = 'partial';
  }

  return report;
}
