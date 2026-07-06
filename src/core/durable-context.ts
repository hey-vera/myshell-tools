/**
 * src/core/durable-context.ts — P1-11a DURABLE-CONTEXT-DOMAIN (pure substrate per r7-item11).
 *
 * Canonical, versioned, hashable, append-only events + snapshots for provider-neutral
 * context. Fail-closed on gaps/dups/versions/hashes/prior. No storage, no runtime callers.
 * Environment/orientation support: ContextSnapshotKind extended with 'environment';
 * Reconstructed promptBlocks supports 'environment' assembled from snapshot's ranked
 * (RankedRepoFile + symbols carried when present; E1 paths-only parity preserved).
 * completion.result payload is opaque (Item 17 owns CompletionResultV1; see r7-item17).
 *
 * Caps, stable hashing, validators, ctors, and minimal reconstruction stub here.
 * Follows pure/core split (cf. repo-map.ts, work-state.ts, history.ts).
 */

import type { RankedRepoFile } from './repo-map.js';

// ---------------------------------------------------------------------------
// Versions, Kinds, Caps (contract §3)
// ---------------------------------------------------------------------------

export type DurableContextVersion = 1;

export type CanonicalEventKind =
  | 'turn.user'
  | 'turn.preflight'
  | 'work-unit.planned'
  | 'work-unit.state'
  | 'provider.native-session'
  | 'provider.observation'
  | 'completion.result'
  | 'goal.node'
  | 'goal.edge'
  | 'context.snapshot'
  | 'context.invalidation';

export type ContextSnapshotKind =
  | 'turn-window'
  | 'work-state'
  | 'goal-dag'
  | 'resume-index'
  | 'full-compact'
  | 'environment'; // extended for durable orientation substrate (P1-11a)

export const EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;
export const SNAPSHOT_STATE_MAX_BYTES = 96 * 1024;
export const RECONSTRUCTED_TARGET_TOKENS = 12000;
export const RECONSTRUCTED_HARD_MAX_TOKENS = 16000;
export const ENV_BLOCK_TOKEN_EST = 800; // bounded share of env facts

// ---------------------------------------------------------------------------
// Refs, Events, Snapshots, Reconstructed (exact per r7-item11 §3)
// ---------------------------------------------------------------------------

export interface CanonicalEventRefV1 {
  readonly logId: string;
  readonly eventId: string;
  readonly sequence: number;
}

export interface CanonicalEventV1 {
  readonly version: 1;
  readonly logId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly priorEventId: string | null;
  readonly createdAt: string;
  readonly conversationId: string;
  readonly turnId?: string;
  readonly workUnitId?: string;
  readonly goalId?: string;
  readonly provider?: import('../providers/port.js').ProviderId;
  readonly kind: CanonicalEventKind;
  readonly invalidates?: readonly string[];
  readonly payload: unknown;
  readonly payloadHash: string;
}

export interface ContextSnapshotV1 {
  readonly version: 1;
  readonly snapshotId: string;
  readonly logId: string;
  readonly kind: ContextSnapshotKind;
  readonly coversThrough: CanonicalEventRefV1;
  readonly createdAt: string;
  readonly sourceEventIds: readonly string[];
  readonly invalidatedBy: string | null;
  readonly state: unknown;
  readonly stateHash: string;
  readonly tokenEstimate: number;
}

export interface ReconstructedContextV1 {
  readonly version: 1;
  readonly logId: string;
  readonly conversationId: string;
  readonly baseSnapshotId: string | null;
  readonly replayedEvents: readonly CanonicalEventRefV1[];
  readonly promptBlocks: readonly {
    readonly id: string;
    readonly kind: 'objective' | 'work-state' | 'goal-state' | 'recent-turns' | 'completion-tail' | 'resume-policy' | 'environment';
    readonly text: string;
    readonly tokenEstimate: number;
    readonly sourceEventIds: readonly string[];
  }[];
  readonly openLoops: readonly {
    readonly id: string;
    readonly kind: 'turn' | 'work-unit' | 'completion-obligation' | 'goal';
    readonly state: 'open' | 'blocked' | 'needs-user' | 'settled';
    readonly sourceEventId: string;
  }[];
  readonly tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// ID + Hash (fail-closed helpers; pure)
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidId(id: string): boolean {
  return typeof id === 'string' && ID_RE.test(id);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(rec[k])).join(',') + '}';
}

export function computeStableHash(value: unknown): string {
  const s = stableStringify(value);
  // djb2-ish 32-bit, deterministic, no deps
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return 'h' + hex;
}

function estimateTokens(text: string): number {
  // rough 1 token ~4 chars conservative for estimate
  return Math.ceil(text.length / 3.5);
}

function capBytes(obj: unknown, max: number): boolean {
  try {
    const s = stableStringify(obj);
    return Buffer.byteLength(s, 'utf8') <= max;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ctors + Validators (fail-closed on gaps/dups/hashes/versions)
// ---------------------------------------------------------------------------

export interface CreateEventArgs {
  readonly logId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly priorEventId: string | null;
  readonly createdAt: string;
  readonly conversationId: string;
  readonly turnId?: string;
  readonly workUnitId?: string;
  readonly goalId?: string;
  readonly provider?: import('../providers/port.js').ProviderId;
  readonly kind: CanonicalEventKind;
  readonly invalidates?: readonly string[];
  readonly payload: unknown;
}

export function createCanonicalEventV1(args: CreateEventArgs): CanonicalEventV1 {
  if (!isValidId(args.logId)) throw new Error('invalid logId');
  if (!isValidId(args.eventId)) throw new Error('invalid eventId');
  if (!isValidId(args.conversationId)) throw new Error('invalid conversationId');
  if (args.turnId !== undefined && !isValidId(args.turnId)) throw new Error('invalid turnId');
  if (args.workUnitId !== undefined && !isValidId(args.workUnitId)) throw new Error('invalid workUnitId');
  if (args.goalId !== undefined && !isValidId(args.goalId)) throw new Error('invalid goalId');
  if (typeof args.sequence !== 'number' || !Number.isInteger(args.sequence) || args.sequence < 0) {
    throw new Error('invalid sequence');
  }
  if (args.priorEventId !== null && !isValidId(args.priorEventId)) {
    throw new Error('invalid priorEventId');
  }
  if (typeof args.createdAt !== 'string' || args.createdAt.length === 0) {
    throw new Error('invalid createdAt');
  }
  if (!args.kind) throw new Error('invalid kind');

  const payloadHash = computeStableHash(args.payload);
  if (!capBytes(args.payload, EVENT_PAYLOAD_MAX_BYTES)) {
    throw new Error('payload exceeds cap');
  }

  return {
    version: 1,
    logId: args.logId,
    eventId: args.eventId,
    sequence: args.sequence,
    priorEventId: args.priorEventId,
    createdAt: args.createdAt,
    conversationId: args.conversationId,
    ...(args.turnId ? { turnId: args.turnId } : {}),
    ...(args.workUnitId ? { workUnitId: args.workUnitId } : {}),
    ...(args.goalId ? { goalId: args.goalId } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
    kind: args.kind,
    ...(args.invalidates ? { invalidates: args.invalidates } : {}),
    payload: args.payload,
    payloadHash,
  };
}

export function validateEventChain(events: readonly CanonicalEventV1[]): { ok: true } | { ok: false; reason: string } {
  if (events.length === 0) return { ok: true };
  let prevSeq = -1;
  const seen = new Set<string>();
  for (const e of events) {
    if (e.version !== 1) return { ok: false, reason: 'unsupported version' };
    if (!isValidId(e.eventId)) return { ok: false, reason: 'invalid eventId' };
    if (seen.has(e.eventId)) return { ok: false, reason: 'duplicate event id' };
    seen.add(e.eventId);
    if (e.sequence !== prevSeq + 1) return { ok: false, reason: 'sequence gap' };
    prevSeq = e.sequence;
    if (e.priorEventId !== null) {
      // prior must be previous in chain for simple linear
      if (events.length > 1 && e.priorEventId !== events[events.indexOf(e) - 1]?.eventId) {
        // allow loose for tail; strict in full verify below
      }
    }
    const recomputed = computeStableHash(e.payload);
    if (recomputed !== e.payloadHash) return { ok: false, reason: 'hash mismatch' };
    if (!capBytes(e.payload, EVENT_PAYLOAD_MAX_BYTES)) return { ok: false, reason: 'payload exceeds cap' };
  }
  return { ok: true };
}

export function verifyAppend(prev: CanonicalEventV1 | null, next: CanonicalEventV1): { ok: true } | { ok: false; reason: string } {
  if (next.version !== 1) return { ok: false, reason: 'unsupported version' };
  if (prev) {
    if (next.priorEventId !== prev.eventId) return { ok: false, reason: 'wrong prior event' };
    if (next.sequence !== prev.sequence + 1) return { ok: false, reason: 'sequence gap' };
    if (next.logId !== prev.logId) return { ok: false, reason: 'logId mismatch' };
  } else {
    if (next.priorEventId !== null) return { ok: false, reason: 'wrong prior event' };
    if (next.sequence !== 0) return { ok: false, reason: 'sequence gap' };
  }
  const recomputed = computeStableHash(next.payload);
  if (recomputed !== next.payloadHash) return { ok: false, reason: 'hash mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Snapshot ctors + validators
// ---------------------------------------------------------------------------

export interface CreateSnapshotArgs {
  readonly snapshotId: string;
  readonly logId: string;
  readonly kind: ContextSnapshotKind;
  readonly coversThrough: CanonicalEventRefV1;
  readonly createdAt: string;
  readonly sourceEventIds: readonly string[];
  readonly state: unknown;
  readonly tokenEstimate?: number;
}

export function createContextSnapshotV1(args: CreateSnapshotArgs): ContextSnapshotV1 {
  if (!isValidId(args.snapshotId)) throw new Error('invalid snapshotId');
  if (!isValidId(args.logId)) throw new Error('invalid logId');
  if (!args.kind) throw new Error('invalid snapshot kind');
  if (!isValidId(args.coversThrough.logId) || !isValidId(args.coversThrough.eventId)) {
    throw new Error('invalid coversThrough');
  }
  if (typeof args.coversThrough.sequence !== 'number') throw new Error('invalid coversThrough sequence');
  if (typeof args.createdAt !== 'string' || args.createdAt.length === 0) throw new Error('invalid createdAt');

  const stateHash = computeStableHash(args.state);
  if (!capBytes(args.state, SNAPSHOT_STATE_MAX_BYTES)) {
    throw new Error('snapshot state exceeds cap');
  }
  const tokenEstimate = args.tokenEstimate ?? estimateTokens(stableStringify(args.state));

  return {
    version: 1,
    snapshotId: args.snapshotId,
    logId: args.logId,
    kind: args.kind,
    coversThrough: args.coversThrough,
    createdAt: args.createdAt,
    sourceEventIds: args.sourceEventIds,
    invalidatedBy: null,
    state: args.state,
    stateHash,
    tokenEstimate,
  };
}

export function validateSnapshot(snapshot: ContextSnapshotV1, coveredChainValid: boolean): { ok: true } | { ok: false; reason: string } {
  if (snapshot.version !== 1) return { ok: false, reason: 'unsupported version' };
  if (snapshot.invalidatedBy !== null) return { ok: false, reason: 'snapshot invalidated' };
  if (!coveredChainValid) return { ok: false, reason: 'corrupt covered event' };
  if (!capBytes(snapshot.state, SNAPSHOT_STATE_MAX_BYTES)) return { ok: false, reason: 'snapshot state exceeds cap' };
  const recomputed = computeStableHash(snapshot.state);
  if (recomputed !== snapshot.stateHash) return { ok: false, reason: 'hash mismatch' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Environment substrate: ranked map facts (Phase 1 RankedRepoFile + symbols)
// reconstruction assembles bounded block from snapshot (no live re-derive)
// ---------------------------------------------------------------------------

export interface EnvironmentSnapshotState {
  readonly rankedFiles: readonly RankedRepoFile[];
  readonly rendered?: string; // fallback for string-only envContext
}

export function renderEnvironmentBlock(ranked: readonly RankedRepoFile[]): string {
  // Phase 1 pattern: "path — sym1,sym2" when symbols present; E1 paths-only identical
  return ranked
    .slice(0, 20)
    .map((r) => {
      const symPart = (r as any).symbols && Array.isArray((r as any).symbols) && (r as any).symbols.length > 0
        ? ` — ${(r as any).symbols.slice(0, 3).join(',')}`
        : '';
      return `${r.path}${symPart}`;
    })
    .join('\n');
}

export function createEnvironmentSnapshot(
  logId: string,
  coversThrough: CanonicalEventRefV1,
  rankedFiles: readonly RankedRepoFile[],
  createdAt: string,
): ContextSnapshotV1 {
  const state: EnvironmentSnapshotState = { rankedFiles };
  return createContextSnapshotV1({
    snapshotId: `snap-env-${coversThrough.eventId}`,
    logId,
    kind: 'environment',
    coversThrough,
    createdAt,
    sourceEventIds: [coversThrough.eventId],
    state,
    tokenEstimate: ENV_BLOCK_TOKEN_EST,
  });
}

// ---------------------------------------------------------------------------
// Opaque completion.result (per 11a; do not redefine CompletionResultV1)
// ---------------------------------------------------------------------------

// Payload for 'completion.result' kind is opaque until Item 17 binds.
// Use unknown + note; import would be from accept-stage once landed.
export type OpaqueCompletionResult = unknown; // Opaque per r7-11a; CompletionResultV1 owned by 17, referenced in types/accept

export function makeCompletionResultPayload(result: OpaqueCompletionResult): { result: OpaqueCompletionResult } {
  return { result };
}

// ---------------------------------------------------------------------------
// Reconstruction (full support for env + basic blocks from durable snapshots + tail)
// Pure, uses snapshot + tail, no live fs, bounded. Carries Phase1 map + symbols.
// ---------------------------------------------------------------------------

export interface ReconstructArgs {
  readonly logId: string;
  readonly conversationId: string;
  readonly snapshots: readonly ContextSnapshotV1[];
  readonly tailEvents: readonly CanonicalEventV1[];
}

export function reconstructContextV1(args: ReconstructArgs): ReconstructedContextV1 {
  const { logId, conversationId, snapshots, tailEvents } = args;

  // Newest valid snapshot (env or other)
  const validSnapshots = snapshots.filter((s) => s.version === 1 && s.invalidatedBy === null);
  const base = validSnapshots.length > 0 ? validSnapshots[validSnapshots.length - 1] : null;

  const replayed: CanonicalEventRefV1[] = tailEvents.map((e) => ({
    logId: e.logId,
    eventId: e.eventId,
    sequence: e.sequence,
  }));

  const promptBlocks: Array<{
    readonly id: string;
    readonly kind: 'objective' | 'work-state' | 'goal-state' | 'recent-turns' | 'completion-tail' | 'resume-policy' | 'environment';
    readonly text: string;
    readonly tokenEstimate: number;
    readonly sourceEventIds: readonly string[];
  }> = [];

  // Assemble environment block from snapshot if present (no re-derive live) - carries Ranked + symbols
  const envSnap = validSnapshots.find((s) => s.kind === 'environment');
  if (envSnap) {
    const st = envSnap.state as EnvironmentSnapshotState | undefined;
    const ranked = st?.rankedFiles ?? [];
    const text = (st as any)?.rendered ?? renderEnvironmentBlock(ranked as any);
    const symCount = ranked.reduce((n: number, r: any) => n + (r.symbols?.length || 0), 0);
    promptBlocks.push({
      id: `env-${envSnap.snapshotId}`,
      kind: 'environment',
      text: `--- ENVIRONMENT (durable map snapshot, ${ranked.length} files, ${symCount} symbols) ---\n${text}`.slice(0, 2000),
      tokenEstimate: envSnap.tokenEstimate || ENV_BLOCK_TOKEN_EST,
      sourceEventIds: envSnap.sourceEventIds,
    });
  }

  // Basic other blocks (enhanced stub; real reducers in later)
  promptBlocks.push({
    id: 'recent-tail',
    kind: 'recent-turns',
    text: '(tail events folded; full prose in transcript; symbols in durable env block)',
    tokenEstimate: Math.min(200, tailEvents.length * 20),
    sourceEventIds: tailEvents.slice(0, 3).map((e) => e.eventId),
  });

  // Add goal/work stubs if snapshots present (for completeness)
  if (validSnapshots.some(s => s.kind === 'goal-dag')) {
    promptBlocks.push({ id: 'goal-stub', kind: 'goal-state', text: '(goal dag from durable snapshot)', tokenEstimate: 50, sourceEventIds: [] });
  }

  const totalTokens = promptBlocks.reduce((sum, b) => sum + b.tokenEstimate, 0);

  return {
    version: 1,
    logId,
    conversationId,
    baseSnapshotId: base?.snapshotId ?? null,
    replayedEvents: replayed,
    promptBlocks: promptBlocks as any,
    openLoops: [],
    tokenEstimate: Math.min(totalTokens, RECONSTRUCTED_HARD_MAX_TOKENS),
  };
}

/**
 * Pure builder to unify durable recon into the environmentContext seam used by assembleContextBlocks.
 * Calls reconstructContextV1 and extracts/ renders the env block text.
 */
export function buildEnvironmentContextFromRecon(
  snapshot: ContextSnapshotV1 | null,
  events: readonly CanonicalEventV1[] = [],
): string {
  if (!snapshot) return '';
  try {
    const recon = reconstructContextV1({
      logId: snapshot.logId,
      conversationId: 'current',
      snapshots: [snapshot],
      tailEvents: events,
    });
    const envBlock = recon.promptBlocks.find(b => b.kind === 'environment');
    return envBlock ? envBlock.text : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Chain verify helper (for tests + future append)
// ---------------------------------------------------------------------------

export function verifyEventChainFull(events: readonly CanonicalEventV1[]): { ok: true } | { ok: false; reason: string } {
  const chainRes = validateEventChain(events);
  if (!chainRes.ok) return chainRes;
  for (let i = 1; i < events.length; i++) {
    const v = verifyAppend(events[i - 1]!, events[i]!);
    if (!v.ok) return v;
  }
  return { ok: true };
}

// Stub for orchestrate hook (completion binding); real event construction via accept-stage + durable append in full impl.
export function makeCompletionResultEvent(_params: any): any {
  return { type: 'event', kind: 'completion.result' };
}
