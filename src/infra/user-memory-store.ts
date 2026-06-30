/**
 * src/infra/user-memory-store.ts — the I/O layer for the durable user-memory
 * subsystem (Phase 3 / memory doc §2 + RC-4).
 *
 * Storage layout under <homeDir>/.myshell-tools/memory/:
 *   index.json            — compact facets of every fact (incl. superseded), the
 *                           rebuildable retrieval cache
 *   index.json.corrupt    — last corrupt index preserved on recovery
 *   index.json.lock       — advisory lock (withLock) for the WHOLE write transaction
 *   facts/<id>.json       — the full fact, one file per fact, mode 0o600
 *   audit.jsonl           — append-only ADD/UPDATE/SUPERSEDE/FORGET decision log
 *                           (capped/rotated — it is a log, not a source of truth)
 *
 * RC-4 (the load-bearing concurrency fix): a write is a read-decide-write
 * *transaction*. `readIndex → decideConsolidation → mutate index + fact write →
 * audit append` ALL run inside ONE `withLock`, reading the index INSIDE the lock.
 * This module deliberately does NOT copy `conversations.ts`'s read-outside-the-lock
 * pattern (a TOCTOU window that would let two concurrent writers each decide ADD
 * against a stale snapshot and produce two copies, defeating consolidation).
 *
 * Security (memory doc §10): fact files are `0o600`; ids are validated against
 * `/^mem_[A-Za-z0-9]+$/` before ANY fs op (path-traversal reject); the project key
 * is a privacy-preserving `basename#shorthash` that NEVER stores the raw path; the
 * `Clock` is injected (no wall-clock) and `homeDir` is explicit for hermetic tests.
 */

import { mkdir, readFile, readdir, rename, unlink, appendFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Clock } from '../core/types.js';
import { atomicWrite, withLock } from './atomic.js';
import { defaultStateLayout, resolveStateLayout, type AppStateLayout } from './state-layout.js';
import {
  decideConsolidation,
  importanceFor,
  capacityEvictions,
  shouldArchive,
  type Candidate,
  type ConsolidationDecision,
  type UserMemoryFact,
  type MemoryScope,
} from '../core/user-memory.js';

const execFileAsync = promisify(execFile);

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

function getMemoryDir(l: AppStateLayout): string {
  return l.paths.memoryDir;
}
function getFactsDir(l: AppStateLayout): string {
  return join(getMemoryDir(l), 'facts');
}
function getIndexPath(l: AppStateLayout): string {
  return join(getMemoryDir(l), 'index.json');
}
function getCorruptIndexPath(l: AppStateLayout): string {
  return join(getMemoryDir(l), 'index.json.corrupt');
}
function getIndexLockPath(l: AppStateLayout): string {
  return join(getMemoryDir(l), 'index.json.lock');
}
function getAuditPath(l: AppStateLayout): string {
  return join(getMemoryDir(l), 'audit.jsonl');
}

/** Path-traversal guard (§10): only `mem_<alnum>` ids ever touch the filesystem. */
const VALID_ID_RE = /^mem_[A-Za-z0-9]+$/;
function isValidId(id: string): boolean {
  return typeof id === 'string' && VALID_ID_RE.test(id);
}
function getFactPath(l: AppStateLayout, id: string): string {
  if (!isValidId(id)) {
    throw new InvalidFactIdError(id);
  }
  return join(getFactsDir(l), `${id}.json`);
}

export class InvalidFactIdError extends Error {
  constructor(id: string) {
    super(`Invalid memory fact id (path-traversal reject): ${JSON.stringify(id)}`);
    this.name = 'InvalidFactIdError';
  }
}

// ---------------------------------------------------------------------------
// Audit log (append-only, rotated)
// ---------------------------------------------------------------------------

interface AuditEntry {
  readonly ts: string;
  readonly op: ConsolidationDecision['op'] | 'FORGET';
  readonly id: string;
  readonly scope: MemoryScope;
  readonly kind: string;
  readonly subject: string;
  readonly priorText?: string;
  readonly text?: string;
}

const AUDIT_MAX_LINES = 5000;

async function appendAudit(l: AppStateLayout, entry: AuditEntry): Promise<void> {
  // Caller MUST hold the index lock for ordered appends (RC-4 — audit is inside
  // the critical section). Rotation: when the log exceeds the line cap, keep the
  // newest half (it is a log, not a source of truth).
  const path = getAuditPath(l);
  await rotateAuditIfNeeded(l, path);
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
}

async function rotateAuditIfNeeded(l: AppStateLayout, path: string): Promise<void> {
  try {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < AUDIT_MAX_LINES) return;
    const kept = lines.slice(Math.floor(lines.length / 2));
    await atomicWrite(path, kept.join('\n') + '\n');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return; // no log yet — nothing to rotate
    // Best-effort: a rotation failure must not block a write.
  }
}

// ---------------------------------------------------------------------------
// Index (compact facets) + recovery
// ---------------------------------------------------------------------------

/** The retrieval facet — the subset of a fact retrieval needs (memory doc §2). */
interface FactFacet {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly projectKey: string | null;
  readonly shape: UserMemoryFact['shape'];
  readonly kind: UserMemoryFact['kind'];
  readonly subject: string;
  readonly text: string;
  readonly trust: UserMemoryFact['trust'];
  readonly validTo: string | null;
  readonly supersededBy: string | null;
  readonly lastUsedAt: string | null;
  readonly useCount: number;
  readonly importance: 1 | 2 | 3;
  readonly tags: readonly string[];
  readonly archived: boolean;
}

interface MemoryIndex {
  readonly version: 1;
  readonly facts: FactFacet[];
}

type StoreWarning = (message: string) => void;

type IndexReadResult =
  | { readonly kind: 'ok'; readonly index: FactFacet[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly reason: string };

function facetOf(f: UserMemoryFact): FactFacet {
  return {
    id: f.id,
    scope: f.scope,
    projectKey: f.projectKey,
    shape: f.shape,
    kind: f.kind,
    subject: f.subject,
    text: f.text,
    trust: f.trust,
    validTo: f.validTo,
    supersededBy: f.supersededBy,
    lastUsedAt: f.lastUsedAt,
    useCount: f.useCount,
    importance: f.importance,
    tags: f.tags,
    archived: f.archived,
  };
}

async function ensureDirs(l: AppStateLayout): Promise<void> {
  await mkdir(getFactsDir(l), { recursive: true });
}

async function readIndexFile(l: AppStateLayout): Promise<IndexReadResult> {
  try {
    const raw = await readFile(getIndexPath(l), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as MemoryIndex).facts)) {
      return { kind: 'corrupt', reason: 'index.json missing facts array' };
    }
    return { kind: 'ok', index: (parsed as MemoryIndex).facts };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'corrupt',
      reason: err instanceof SyntaxError ? 'index.json is invalid JSON' : 'index.json is unreadable',
    };
  }
}

async function writeIndex(l: AppStateLayout, facets: FactFacet[]): Promise<void> {
  const index: MemoryIndex = { version: 1, facts: facets };
  await atomicWrite(getIndexPath(l), JSON.stringify(index, null, 2), 0o600);
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

async function readFactFile(l: AppStateLayout, id: string): Promise<UserMemoryFact | null> {
  try {
    const raw = await readFile(getFactPath(l, id), 'utf8');
    const parsed = JSON.parse(raw) as UserMemoryFact;
    return parsed;
  } catch {
    return null;
  }
}

/** Rebuild the index from `facts/*.json` (the facts are authoritative, §2). */
async function rebuildIndexFromFacts(l: AppStateLayout): Promise<FactFacet[]> {
  const dir = getFactsDir(l);
  let files: string[] = [];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const facets: FactFacet[] = [];
  for (const name of files) {
    const id = name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const fact = JSON.parse(raw) as UserMemoryFact;
      if (fact && typeof fact.id === 'string') facets.push(facetOf(fact));
    } catch {
      // Best-effort: one corrupt fact file must not block the rest.
    }
  }
  return facets;
}

async function recoverIndex(l: AppStateLayout, reason: string, onWarning?: StoreWarning): Promise<FactFacet[]> {
  const corruptPath = await preserveCorruptIndex(l);
  const rebuilt = await rebuildIndexFromFacts(l);
  await writeIndex(l, rebuilt);
  onWarning?.(
    `Recovered memory index (${reason}); rebuilt ${rebuilt.length} fact(s), preserved original at ${corruptPath}.`,
  );
  return rebuilt;
}

/** Read the index INSIDE the lock (RC-4). Recovers a missing/corrupt index. */
async function readIndexLocked(l: AppStateLayout, onWarning?: StoreWarning): Promise<FactFacet[]> {
  const result = await readIndexFile(l);
  if (result.kind === 'ok') return result.index;
  if (result.kind === 'absent') return [];
  return recoverIndex(l, result.reason, onWarning);
}

// ---------------------------------------------------------------------------
// Project key derivation (§10 — privacy-preserving, never the raw path)
// ---------------------------------------------------------------------------

/**
 * Derive a privacy-preserving project key from an absolute root path:
 * `${basename}#${first8hex(sha256(absRoot))}`. We store the hash, NEVER the raw
 * path. Pure (given the path). Exported for hermetic testing.
 */
export function deriveProjectKey(absRootPath: string): string {
  const abs = resolve(absRootPath);
  const base = basename(abs) || 'project';
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8);
  return `${base}#${hash}`;
}

/**
 * Resolve the current project key from the git toplevel (so a `cd` into a
 * subdirectory is stable), falling back to the cwd basename when there is no git
 * root. Returns null on any failure (caller treats as global-only). The git
 * resolver is injectable for hermetic tests.
 */
export async function resolveProjectKey(
  cwd: string,
  gitToplevel: (cwd: string) => Promise<string | null> = defaultGitToplevel,
): Promise<string | null> {
  try {
    const root = (await gitToplevel(cwd)) ?? resolve(cwd);
    return deriveProjectKey(root);
  } catch {
    return null;
  }
}

async function defaultGitToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    const top = stdout.trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fact construction from a candidate + decision
// ---------------------------------------------------------------------------

function commandFor(source: Candidate['source']): '/remember' | 'remember_user' | null {
  return source === 'user_explicit' ? '/remember' : source === 'model_proposed' ? 'remember_user' : null;
}

function newFactFromCandidate(c: Candidate, subject: string, id: string, now: string): UserMemoryFact {
  return {
    version: 1,
    id,
    scope: c.scope,
    projectKey: c.scope === 'project' ? (c.projectKey ?? null) : null,
    shape: c.shape,
    kind: c.kind,
    subject,
    text: c.text,
    value: c.value ?? null,
    reason: c.reason ?? '',
    trust: c.trust,
    source: c.source,
    provenance: {
      conversationId: null,
      capturedFromTurn: null,
      command: commandFor(c.source),
    },
    createdAt: now,
    updatedAt: now,
    validFrom: now,
    validTo: null,
    supersededBy: null,
    lastUsedAt: null,
    useCount: 0,
    importance: importanceFor(c.trust, c.source),
    tags: c.tags ?? [],
    archived: false,
  };
}

// ---------------------------------------------------------------------------
// Public store API
// ---------------------------------------------------------------------------

export interface CommitResult {
  readonly op: ConsolidationDecision['op'];
  readonly fact: UserMemoryFact | null;
  readonly flagForUser?: boolean;
}

export interface UserMemoryStore {
  /** All facts (incl. superseded/archived) — for `/memory --all` + audit. */
  listAll(scope?: { scope: MemoryScope; projectKey?: string | null }): Promise<UserMemoryFact[]>;
  /** Retrieval-eligible facets (non-archived, non-superseded). */
  listFacets(): Promise<FactFacet[]>;
  /** Load one full fact by id (null if missing/invalid). */
  get(id: string): Promise<UserMemoryFact | null>;
  /**
   * Run the whole write transaction (gate is the CALLER's job; this runs
   * consolidation + persistence) for a candidate. RC-4: reads the index, decides,
   * mutates fact files + index, and appends the audit row ALL inside ONE lock.
   */
  commit(c: Candidate, opts?: { projectKey?: string | null }): Promise<CommitResult>;
  /** Hard-delete a fact by id (+ audit). */
  forget(id: string): Promise<boolean>;
  /** Mark facts used (decay-reset) — relevance-selected ids only (RC-5). */
  markUsed(ids: readonly string[]): Promise<void>;
  /** Lazy decay sweep on open: archive past-window facts + capacity cap (§6). */
  sweepDecay(opts?: { base?: number; max?: number }): Promise<string[]>;
}

export function createFileUserMemoryStore(opts: {
  homeDir?: string;
  layout?: AppStateLayout;
  clock: Clock;
  onWarning?: StoreWarning;
}): UserMemoryStore {
  const l = resolveLayout(opts.homeDir, opts.layout);
  const { clock } = opts;
  const onWarning = opts.onWarning;

  async function persistFact(fact: UserMemoryFact): Promise<void> {
    await atomicWrite(getFactPath(l, fact.id), JSON.stringify(fact, null, 2), 0o600);
  }

  return {
    async listFacets(): Promise<FactFacet[]> {
      await ensureDirs(l);
      return withLock(getIndexLockPath(l), async () => {
        const index = await readIndexLocked(l, onWarning);
        return index.filter((f) => !f.archived && f.validTo === null && f.supersededBy === null);
      });
    },

    async listAll(scope): Promise<UserMemoryFact[]> {
      await ensureDirs(l);
      const facets = await withLock(getIndexLockPath(l), async () => readIndexLocked(l, onWarning));
      const facts: UserMemoryFact[] = [];
      for (const facet of facets) {
        if (scope !== undefined) {
          if (facet.scope !== scope.scope) continue;
          if (scope.scope === 'project' && scope.projectKey !== undefined && facet.projectKey !== scope.projectKey)
            continue;
        }
        const f = await readFactFile(l, facet.id);
        if (f !== null) facts.push(f);
      }
      return facts;
    },

    async get(id): Promise<UserMemoryFact | null> {
      if (!isValidId(id)) return null;
      return readFactFile(l, id);
    },

    async commit(c, commitOpts): Promise<CommitResult> {
      await ensureDirs(l);
      const projectKey = commitOpts?.projectKey ?? c.projectKey ?? null;
      const cand: Candidate = { ...c, projectKey: c.scope === 'project' ? projectKey : null };

      return withLock(getIndexLockPath(l), async () => {
        // RC-4: read the index INSIDE the lock, then load the FULL facts the
        // decision needs, decide, write, and append the audit — all here.
        const facets = await readIndexLocked(l, onWarning);
        const existing: UserMemoryFact[] = [];
        for (const facet of facets) {
          const f = await readFactFile(l, facet.id);
          if (f !== null) existing.push(f);
        }

        const decision = decideConsolidation(cand, existing);
        const now = clock.isoNow();

        switch (decision.op) {
          case 'ADD': {
            const id = mintId(clock);
            const subject = cand.subject ?? facetSubject(cand);
            const fact = newFactFromCandidate(cand, subject, id, now);
            await persistFact(fact);
            const next = [...facets, facetOf(fact)];
            await writeIndex(l, next);
            await appendAudit(l, auditRow('ADD', fact));
            return { op: 'ADD', fact };
          }
          case 'UPDATE': {
            const target = existing.find((f) => f.id === decision.targetId);
            if (target === undefined) return { op: 'NOOP', fact: null };
            const importance = decision.recomputeImportance
              ? importanceFor(cand.trust, cand.source)
              : target.importance;
            const mergedTags =
              decision.merge === 'tags-only'
                ? Array.from(new Set([...(target.tags ?? []), ...(cand.tags ?? [])]))
                : decision.merge === undefined
                  ? Array.from(new Set([...(target.tags ?? []), ...(cand.tags ?? [])]))
                  : target.tags;
            // tags-only near-dup merge keeps the EXISTING text/value verbatim;
            // a same-subject profile refresh overwrites text/value in place.
            const isTagsOnly = decision.merge === 'tags-only';
            const updated: UserMemoryFact = {
              ...target,
              text: isTagsOnly ? target.text : cand.text,
              value: isTagsOnly ? target.value : (cand.value ?? null),
              reason: isTagsOnly ? target.reason : (cand.reason ?? target.reason),
              trust: isTagsOnly ? target.trust : cand.trust,
              source: isTagsOnly ? target.source : cand.source,
              tags: mergedTags,
              importance,
              updatedAt: now,
            };
            await persistFact(updated);
            const next = facets.map((f) => (f.id === updated.id ? facetOf(updated) : f));
            await writeIndex(l, next);
            await appendAudit(l, {
              ...auditRow('UPDATE', updated),
              ...(decision.snapshotPrior ? { priorText: target.text } : {}),
            });
            return { op: 'UPDATE', fact: updated };
          }
          case 'SUPERSEDE': {
            const target = existing.find((f) => f.id === decision.targetId);
            if (target === undefined) return { op: 'NOOP', fact: null };
            const newId = mintId(clock);
            const subject = cand.subject ?? facetSubject(cand);
            const replacement = newFactFromCandidate(cand, subject, newId, now);
            const invalidated: UserMemoryFact = {
              ...target,
              validTo: now,
              supersededBy: newId,
              updatedAt: now,
            };
            await persistFact(invalidated);
            await persistFact(replacement);
            const next = facets
              .map((f) => (f.id === invalidated.id ? facetOf(invalidated) : f))
              .concat(facetOf(replacement));
            await writeIndex(l, next);
            await appendAudit(l, { ...auditRow('SUPERSEDE', replacement), priorText: target.text });
            return { op: 'SUPERSEDE', fact: replacement };
          }
          case 'NOOP':
          default: {
            // Exact-dup touch: bump useCount/lastUsedAt on the existing fact.
            if (decision.touch && decision.targetId !== undefined) {
              const target = existing.find((f) => f.id === decision.targetId);
              if (target !== undefined) {
                const touched: UserMemoryFact = {
                  ...target,
                  useCount: target.useCount + 1,
                  lastUsedAt: now,
                  updatedAt: now,
                };
                await persistFact(touched);
                const next = facets.map((f) => (f.id === touched.id ? facetOf(touched) : f));
                await writeIndex(l, next);
                return { op: 'NOOP', fact: touched };
              }
            }
            return { op: 'NOOP', fact: null, ...(decision.flagForUser ? { flagForUser: true } : {}) };
          }
        }
      });
    },

    async forget(id): Promise<boolean> {
      if (!isValidId(id)) return false;
      await ensureDirs(l);
      return withLock(getIndexLockPath(l), async () => {
        const facets = await readIndexLocked(l, onWarning);
        const facet = facets.find((f) => f.id === id);
        try {
          await unlink(getFactPath(l, id));
        } catch {
          // already gone — still purge from the index below
        }
        const next = facets.filter((f) => f.id !== id);
        if (next.length === facets.length && facet === undefined) return false;
        await writeIndex(l, next);
        if (facet !== undefined) {
          await appendAudit(l, {
            ts: clock.isoNow(),
            op: 'FORGET',
            id,
            scope: facet.scope,
            kind: facet.kind,
            subject: facet.subject,
            text: facet.text,
          });
        }
        return true;
      });
    },

    async markUsed(ids): Promise<void> {
      if (ids.length === 0) return;
      await ensureDirs(l);
      const idSet = new Set(ids.filter(isValidId));
      if (idSet.size === 0) return;
      await withLock(getIndexLockPath(l), async () => {
        const facets = await readIndexLocked(l, onWarning);
        const now = clock.isoNow();
        let changed = false;
        const nextFacets = [...facets];
        for (let i = 0; i < nextFacets.length; i++) {
          const facet = nextFacets[i];
          if (facet === undefined || !idSet.has(facet.id)) continue;
          const fact = await readFactFile(l, facet.id);
          if (fact === null) continue;
          const touched: UserMemoryFact = {
            ...fact,
            useCount: fact.useCount + 1,
            lastUsedAt: now,
          };
          await persistFact(touched);
          nextFacets[i] = facetOf(touched);
          changed = true;
        }
        if (changed) await writeIndex(l, nextFacets);
      });
    },

    async sweepDecay(sweepOpts): Promise<string[]> {
      await ensureDirs(l);
      const base = sweepOpts?.base ?? 90;
      const max = sweepOpts?.max ?? 200;
      const now = clock.isoNow();
      return withLock(getIndexLockPath(l), async () => {
        const facets = await readIndexLocked(l, onWarning);
        const facts: UserMemoryFact[] = [];
        for (const facet of facets) {
          const f = await readFactFile(l, facet.id);
          if (f !== null) facts.push(f);
        }
        const toArchive = new Set<string>();
        for (const f of facts) {
          if (shouldArchive(f, now, base)) toArchive.add(f.id);
        }
        // Capacity cap over the facts that survive the window sweep.
        const survivors = facts.filter((f) => !toArchive.has(f.id));
        for (const id of capacityEvictions(survivors, max)) toArchive.add(id);

        if (toArchive.size === 0) return [];
        const nextFacets: FactFacet[] = [];
        for (const f of facts) {
          if (toArchive.has(f.id)) {
            const archived: UserMemoryFact = { ...f, archived: true, updatedAt: now };
            await persistFact(archived);
            nextFacets.push(facetOf(archived));
          } else {
            nextFacets.push(facetOf(f));
          }
        }
        await writeIndex(l, nextFacets);
        return [...toArchive];
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A sortable, valid `mem_<alnum>` id derived from the injected clock. */
function mintId(clock: Clock): string {
  const raw = clock.uuid().replace(/[^A-Za-z0-9]/g, '');
  return `mem_${raw.length > 0 ? raw : '0'}`;
}

function facetSubject(c: Candidate): string {
  return c.subject ?? 'other';
}

function auditRow(op: ConsolidationDecision['op'], f: UserMemoryFact): AuditEntry {
  return {
    ts: f.updatedAt,
    op,
    id: f.id,
    scope: f.scope,
    kind: f.kind,
    subject: f.subject,
    text: f.text,
  };
}
