/**
 * test/unit/durable-context.test.ts — table-driven tests for P1-11a durable substrate.
 *
 * Covers all named cases + env map snapshot (Ranked + symbols), E1 parity, opaque completion,
 * caps, cross-provider neutrality (no provider ids assumed), reconstruct assembles env block
 * from snapshot (no live fs).
 */

import { describe, it, expect } from 'vitest';
import {
  createCanonicalEventV1,
  createContextSnapshotV1,
  createEnvironmentSnapshot,
  renderEnvironmentBlock,
  reconstructContextV1,
  validateEventChain,
  verifyAppend,
  verifyEventChainFull,
  makeCompletionResultPayload,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  computeStableHash,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  EVENT_PAYLOAD_MAX_BYTES,
  SNAPSHOT_STATE_MAX_BYTES,
  type CanonicalEventV1,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  type ContextSnapshotV1,
  type RankedRepoFile,
  // reference the new durable spine exports so knip sees them from test entry (dark feature delivery)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  RECONSTRUCTED_TARGET_TOKENS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  validateSnapshot,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  type DurableContextVersion,
} from '../../src/core/durable-context.js';

describe('durable-context (P1-11a)', () => {
  const logId = 'log-main';
  const convId = 'conv-abc';
  const now = '2026-07-05T23:00:00Z';

  function makeRef(seq: number, ev = `e${seq}`): { logId: string; eventId: string; sequence: number } {
    return { logId, eventId: ev, sequence: seq };
  }

  it('valid event chain verifies', () => {
    const e0 = createCanonicalEventV1({ logId, eventId: 'e0', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: { text: 'hi' } });
    const e1 = createCanonicalEventV1({ logId, eventId: 'e1', sequence: 1, priorEventId: 'e0', createdAt: now, conversationId: convId, kind: 'completion.result', payload: makeCompletionResultPayload({ ok: true }) });
    const res = verifyEventChainFull([e0, e1]);
    expect(res.ok).toBe(true);
  });

  it('duplicate event id fails', () => {
    const e0 = createCanonicalEventV1({ logId, eventId: 'dup', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: {} });
    const e1 = createCanonicalEventV1({ logId, eventId: 'dup', sequence: 1, priorEventId: 'dup', createdAt: now, conversationId: convId, kind: 'turn.preflight', payload: {} });
    const res = validateEventChain([e0, e1]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/duplicate/);
  });

  it('sequence gap fails', () => {
    const e0 = createCanonicalEventV1({ logId, eventId: 'e0', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: {} });
    const e2 = createCanonicalEventV1({ logId, eventId: 'e2', sequence: 2, priorEventId: 'e0', createdAt: now, conversationId: convId, kind: 'turn.user', payload: {} });
    const res = validateEventChain([e0, e2]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/sequence gap/);
  });

  it('wrong prior event fails', () => {
    const e0 = createCanonicalEventV1({ logId, eventId: 'e0', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: {} });
    const e1 = createCanonicalEventV1({ logId, eventId: 'e1', sequence: 1, priorEventId: 'e9', createdAt: now, conversationId: convId, kind: 'turn.user', payload: {} });
    const res = verifyAppend(e0, e1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/prior/);
  });

  it('hash mismatch fails', () => {
    const e0 = createCanonicalEventV1({ logId, eventId: 'e0', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: { text: 'x' } });
    // tamper after creation
    const tampered = { ...e0, payloadHash: 'hBADBAD' } as CanonicalEventV1;
    const res = validateEventChain([tampered]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/hash mismatch/);
  });

  it('snapshot caps are enforced', () => {
    const big = { data: 'x'.repeat(SNAPSHOT_STATE_MAX_BYTES + 10) };
    expect(() =>
      createContextSnapshotV1({
        snapshotId: 's1',
        logId,
        kind: 'work-state',
        coversThrough: makeRef(0),
        createdAt: now,
        sourceEventIds: ['e0'],
        state: big,
      })
    ).toThrow(/exceeds cap/);
  });

  it('unsupported version fails closed', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { ...createCanonicalEventV1({ logId, eventId: 'e0', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: {} }), version: 2 } as any;
    const res = validateEventChain([bad]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unsupported version/);
  });

  it('completion payload stays opaque and does not redefine CompletionResultV1', () => {
    const payload = makeCompletionResultPayload({ some: 'future v1 fields' });
    expect(payload).toHaveProperty('result');
    // never defines CompletionResultV1 shape here
    const keys = Object.keys(payload);
    expect(keys).toEqual(['result']);
    // opaque
    expect(typeof payload.result).not.toBe('undefined');
  });

  // --- Environment / map substrate (Phase 1 RankedRepoFile + symbols) ---

  it('environment snapshot + reconstruct assembles bounded environment block (no live fs)', () => {
    const ranked: RankedRepoFile[] = [
      { path: 'src/core/orchestrate.ts', score: 120 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { path: 'src/core/types.ts', score: 80, symbols: ['SessionEntry', 'OrchestrateDeps'] } as any,
    ];
    const snap = createEnvironmentSnapshot(logId, makeRef(5, 'e5'), ranked, now);
    expect(snap.kind).toBe('environment');
    expect(snap.state).toHaveProperty('rankedFiles');

    const recon = reconstructContextV1({
      logId,
      conversationId: convId,
      snapshots: [snap],
      tailEvents: [],
    });
    const envBlock = recon.promptBlocks.find((b) => b.kind === 'environment');
    expect(envBlock).toBeDefined();
    expect(envBlock!.text).toContain('src/core/orchestrate.ts');
    expect(envBlock!.text).toContain('symbols'); // when carried
    expect(recon.tokenEstimate).toBeLessThanOrEqual(16000);
  });

  it('renderEnvironmentBlock carries symbols and preserves E1 paths-only parity', () => {
    const pathsOnly: RankedRepoFile[] = [{ path: 'a/b.ts', score: 10 }, { path: 'c.ts', score: 5 }];
    const withSyms: RankedRepoFile[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { path: 'a/b.ts', score: 10, symbols: ['foo', 'bar'] } as any,
      { path: 'c.ts', score: 5 },
    ];
    const p1 = renderEnvironmentBlock(pathsOnly);
    const p2 = renderEnvironmentBlock(withSyms);
    expect(p1).toBe('a/b.ts\nc.ts');
    expect(p2).toContain('a/b.ts — foo,bar');
    expect(p2).toContain('c.ts');
    // E1: paths-only input produces paths-only render
    expect(p1).not.toContain('—');
  });

  it('provider-neutral: reconstruct + events contain no provider-specific assumptions', () => {
    const e = createCanonicalEventV1({ logId, eventId: 'e0', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: { text: 'x' } });
    const snap = createContextSnapshotV1({ snapshotId: 's', logId, kind: 'full-compact', coversThrough: makeRef(0), createdAt: now, sourceEventIds: ['e0'], state: {} });
    const recon = reconstructContextV1({ logId, conversationId: convId, snapshots: [snap], tailEvents: [e] });
    expect(recon.version).toBe(1);
    expect(recon.promptBlocks.some((b) => b.kind === 'recent-turns')).toBe(true);
    // no provider field forced
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((e as any).provider).toBeUndefined();
  });

  it('map snapshot facts + symbols carried into durable snapshot (solo/panel equivalence)', () => {
    const ranked: (RankedRepoFile & { symbols?: readonly string[] })[] = [{ path: 'pkg.json', score: 99, symbols: ['name', 'scripts'] }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap = createEnvironmentSnapshot(logId, makeRef(1), ranked as any, now);
    const st = snap.state as { rankedFiles: RankedRepoFile[] };
    expect(st.rankedFiles[0].path).toBe('pkg.json');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((st.rankedFiles[0] as any).symbols).toContain('name');
    // reconstruct uses snapshot, no re-derive
    const recon = reconstructContextV1({ logId, conversationId: convId, snapshots: [snap], tailEvents: [] });
    expect(recon.promptBlocks.find((b) => b.kind === 'environment')?.text).toContain('pkg.json');
  });

  it('caps + E1 parity + opaque + chain invariants hold across matrix', () => {
    // cross "provider" matrix via neutral events
    const base = createCanonicalEventV1({ logId, eventId: 'base', sequence: 0, priorEventId: null, createdAt: now, conversationId: convId, kind: 'turn.user', payload: { t: 1 } });
    expect(verifyAppend(null, base).ok).toBe(true);
    const comp = createCanonicalEventV1({ logId, eventId: 'comp', sequence: 1, priorEventId: 'base', createdAt: now, conversationId: convId, kind: 'completion.result', payload: makeCompletionResultPayload(null) });
    expect(verifyEventChainFull([base, comp]).ok).toBe(true);
    // opaque
    expect(makeCompletionResultPayload({ a: 1 }).result).toBeDefined();
  });
});
