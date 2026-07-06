import { describe, it, expect } from 'vitest';
import { buildEnvironmentContextFromRecon } from '../../src/core/durable-context.ts';
import type { ContextSnapshotV1 } from '../../src/core/durable-context.ts';

describe('durable-prompt-seam', () => {
  it('buildEnvironmentContextFromRecon returns non-empty for env snapshot', () => {
    const snap: ContextSnapshotV1 = {
      version: 1,
      snapshotId: 's1',
      logId: 'l',
      kind: 'environment',
      coversThrough: { logId: 'l', eventId: 'e', sequence: 0 },
      createdAt: '',
      sourceEventIds: [],
      state: { rankedFiles: [{ path: 'a.ts', score: 1 }] },
      stateHash: '',
      invalidatedBy: null,
      tokenEstimate: 10,
    } as any;
    const text = buildEnvironmentContextFromRecon(snap, []);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/ENVIRONMENT|durable map/);
  });
});
