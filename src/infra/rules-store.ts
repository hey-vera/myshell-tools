/**
 * src/infra/rules-store.ts — the I/O layer for STANDING RULES (Phase 4).
 *
 * Cloned EXACTLY from src/infra/goal-store.ts (which itself mirrors
 * user-memory-store.ts) — the codebase has built this persistence shape three
 * times; this is the fourth, reusing the same primitives VERBATIM:
 *   - atomicWrite / withLock (atomic.ts) — the whole-transaction advisory lock
 *   - defaultStateHome() (state-dir.ts) — persistent dir (Replit-aware)
 *   - read-INSIDE-the-lock (RC-4) so two writers can't double-add
 *   - corrupt-index recovery: the per-rule files are authoritative, the index is
 *     a rebuildable cache; on corruption the index is preserved + rebuilt
 *   - the injected Clock (no wall-clock — hermetic tests)
 *   - two-scope deriveProjectKey / resolveProjectKey (re-exported from the memory
 *     store so this store shares ONE definition — not a copy)
 *
 * Storage layout under <homeDir>/.myshell-tools/rules/:
 *   index.json          — array of Rule facets (cache; rule files are authoritative)
 *   index.json.lock     — withLock advisory lock over the whole write transaction
 *   index.json.corrupt  — last corrupt index preserved on recovery
 *   items/<id>.json     — the full Rule, one file per rule, mode 0o600
 *
 * Security: rule files are 0o600; ids are validated against /^rule_[A-Za-z0-9]+$/
 * before ANY fs op (path-traversal reject); the project key is the
 * privacy-preserving basename#shorthash (never the raw path).
 *
 * THE BOUNDARY (owner): a Rule is EXPLICIT user policy, authored via `/rule add`.
 * It is trusted by construction and deliberately does NOT pass through
 * user-memory's `isInstructionShaped` gate — that gate is for *ingested facts*.
 */

import { mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Clock } from '../core/types.js';
import { atomicWrite, withLock } from './atomic.js';
import { defaultStateLayout, resolveStateLayout, type AppStateLayout } from './state-layout.js';
import { deriveProjectKey } from './user-memory-store.js';
import { capRule, type Rule, type RuleKind, type RuleScope, type RuleTrigger } from '../core/rules.js';

// Re-export the project-key deriver so a caller/test shares ONE definition with the
// goal / memory stores (the "reuse verbatim" discipline — not a second copy). The
// resolver lives on the memory store; the chat loop already resolves the key there.
export { deriveProjectKey };

// ---------------------------------------------------------------------------
// Layout resolution (homeDir compat bridge)
// ---------------------------------------------------------------------------

function resolveLayout(homeDir?: string, layout?: AppStateLayout): AppStateLayout {
  if (layout) return layout;
  if (homeDir !== undefined) {
    return resolveStateLayout({
      env: {},
      platform: 'linux',
      cwd: homeDir,
      homeDir,
    });
  }
  return defaultStateLayout();
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getRulesDir(l: AppStateLayout): string {
  return l.paths.rulesDir;
}
function getItemsDir(l: AppStateLayout): string {
  return join(getRulesDir(l), 'items');
}
function getIndexPath(l: AppStateLayout): string {
  return join(getRulesDir(l), 'index.json');
}
function getCorruptIndexPath(l: AppStateLayout): string {
  return join(getRulesDir(l), 'index.json.corrupt');
}
function getIndexLockPath(l: AppStateLayout): string {
  return join(getRulesDir(l), 'index.json.lock');
}

/** Path-traversal guard: only `rule_<alnum>` ids ever touch the filesystem. */
const VALID_ID_RE = /^rule_[A-Za-z0-9]+$/;
function isValidId(id: string): boolean {
  return typeof id === 'string' && VALID_ID_RE.test(id);
}

export class InvalidRuleIdError extends Error {
  constructor(id: string) {
    super(`Invalid rule id (path-traversal reject): ${JSON.stringify(id)}`);
    this.name = 'InvalidRuleIdError';
  }
}

function getItemPath(l: AppStateLayout, id: string): string {
  if (!isValidId(id)) {
    throw new InvalidRuleIdError(id);
  }
  return join(getItemsDir(l), `${id}.json`);
}

// ---------------------------------------------------------------------------
// Index + recovery (the per-rule files are authoritative; index is a cache)
// ---------------------------------------------------------------------------

interface RuleIndex {
  readonly version: 1;
  readonly rules: Rule[];
}

type StoreWarning = (message: string) => void;

type IndexReadResult =
  | { readonly kind: 'ok'; readonly rules: Rule[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly reason: string };

async function ensureDirs(l: AppStateLayout): Promise<void> {
  await mkdir(getItemsDir(l), { recursive: true });
}

async function readIndexFile(l: AppStateLayout): Promise<IndexReadResult> {
  try {
    const raw = await readFile(getIndexPath(l), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as RuleIndex).rules)) {
      return { kind: 'corrupt', reason: 'index.json missing rules array' };
    }
    // Defensive: cap every row so a hand-edited/partial index can't crash a caller.
    return { kind: 'ok', rules: (parsed as RuleIndex).rules.map(capRule) };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'corrupt',
      reason: err instanceof SyntaxError ? 'index.json is invalid JSON' : 'index.json is unreadable',
    };
  }
}

/** Newest-first (the canonical display order; ties keep insertion order). */
function sortNewestFirst(rules: Rule[]): Rule[] {
  return [...rules].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

async function writeIndex(l: AppStateLayout, rules: Rule[]): Promise<void> {
  const index: RuleIndex = { version: 1, rules: sortNewestFirst(rules) };
  await atomicWrite(getIndexPath(l), JSON.stringify(index, null, 2), 0o600);
}

async function persistRule(l: AppStateLayout, rule: Rule): Promise<void> {
  await atomicWrite(getItemPath(l, rule.id), JSON.stringify(rule, null, 2), 0o600);
}

async function preserveCorruptIndex(l: AppStateLayout): Promise<string> {
  const corruptPath = getCorruptIndexPath(l);
  try {
    await rename(getIndexPath(l), corruptPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
  }
  return corruptPath;
}

/** Rebuild the index from items/*.json (the rule files are authoritative). */
async function rebuildIndexFromItems(l: AppStateLayout): Promise<Rule[]> {
  const dir = getItemsDir(l);
  let files: string[] = [];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const rules: Rule[] = [];
  for (const name of files) {
    const id = name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const rule = capRule(JSON.parse(raw) as Rule);
      if (rule.id.length > 0) rules.push(rule);
    } catch {
      // Best-effort: one corrupt rule file must not block the rest.
    }
  }
  return sortNewestFirst(rules);
}

async function recoverIndex(l: AppStateLayout, reason: string, onWarning?: StoreWarning): Promise<Rule[]> {
  const corruptPath = await preserveCorruptIndex(l);
  const rebuilt = await rebuildIndexFromItems(l);
  await writeIndex(l, rebuilt);
  onWarning?.(
    `Recovered rules index (${reason}); rebuilt ${rebuilt.length} rule(s), preserved original at ${corruptPath}.`,
  );
  return rebuilt;
}

/** Read the index INSIDE the lock (RC-4). Recovers a missing/corrupt index. */
async function readIndexLocked(l: AppStateLayout, onWarning?: StoreWarning): Promise<Rule[]> {
  const result = await readIndexFile(l);
  if (result.kind === 'ok') return result.rules;
  if (result.kind === 'absent') return [];
  return recoverIndex(l, result.reason, onWarning);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A request to create a new standing rule (the store mints id + createdAt). */
export interface CreateRuleInput {
  readonly kind: RuleKind;
  readonly trigger: RuleTrigger;
  readonly text: string;
  readonly scope?: RuleScope;
  readonly projectKey?: string | null;
}

export interface RulesStore {
  /** Rules, newest-first, optionally filtered by scope/projectKey. */
  list(filter?: {
    readonly scope?: RuleScope;
    readonly projectKey?: string | null;
  }): Promise<Rule[]>;
  /** Load one full rule by id (null if missing/invalid). */
  get(id: string): Promise<Rule | null>;
  /** Create a new standing rule. Returns the persisted rule. */
  create(input: CreateRuleInput): Promise<Rule>;
  /** Hard-remove a rule by id (never silent — the caller surfaces it). */
  remove(id: string): Promise<boolean>;
}

export function createFileRulesStore(opts: {
  homeDir?: string;
  layout?: AppStateLayout;
  clock: Clock;
  onWarning?: StoreWarning;
}): RulesStore {
  const l = resolveLayout(opts.homeDir, opts.layout);
  const { clock } = opts;
  const onWarning = opts.onWarning;

  function mintId(): string {
    const raw = clock.uuid().replace(/[^A-Za-z0-9]/g, '');
    return `rule_${raw.length > 0 ? raw : '0'}`;
  }

  return {
    async list(filter): Promise<Rule[]> {
      await ensureDirs(l);
      const rules = await withLock(getIndexLockPath(l), async () => readIndexLocked(l, onWarning));
      return rules.filter((r) => {
        if (filter?.scope !== undefined && r.scope !== filter.scope) return false;
        if (filter?.projectKey !== undefined && r.projectKey !== filter.projectKey) return false;
        return true;
      });
    },

    async get(id): Promise<Rule | null> {
      if (!isValidId(id)) return null;
      try {
        const raw = await readFile(getItemPath(l, id), 'utf8');
        return capRule(JSON.parse(raw) as Rule);
      } catch {
        return null;
      }
    },

    async create(input): Promise<Rule> {
      await ensureDirs(l);
      const scope: RuleScope = input.scope ?? 'project';
      return withLock(getIndexLockPath(l), async () => {
        const rules = await readIndexLocked(l, onWarning);
        const rule: Rule = capRule({
          version: 1,
          id: mintId(),
          kind: input.kind,
          trigger: input.trigger,
          text: input.text,
          scope,
          projectKey: scope === 'project' ? (input.projectKey ?? null) : null,
          createdAt: clock.isoNow(),
        });
        await persistRule(l, rule);
        await writeIndex(l, [...rules, rule]);
        return rule;
      });
    },

    async remove(id): Promise<boolean> {
      if (!isValidId(id)) return false;
      await ensureDirs(l);
      return withLock(getIndexLockPath(l), async () => {
        const rules = await readIndexLocked(l, onWarning);
        const present = rules.some((r) => r.id === id);
        try {
          await unlink(getItemPath(l, id));
        } catch {
          // already gone — still purge from the index below
        }
        const next = rules.filter((r) => r.id !== id);
        if (next.length === rules.length && !present) return false;
        await writeIndex(l, next);
        return true;
      });
    },
  };
}
