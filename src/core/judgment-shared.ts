import type { ProviderId } from '../providers/port.js';

export interface ParsedChoiceEnvelope {
  readonly vendor: ProviderId;
  readonly choice: string;
  readonly confidence?: number;
  readonly why?: string;
  readonly keyRisk?: string;
}

interface ChoiceTallyEntry {
  readonly optionId: string;
  readonly count: number;
  readonly vendors: readonly ProviderId[];
}

export interface ChoiceTally {
  readonly tally: readonly ChoiceTallyEntry[];
  readonly total: number;
  readonly distinctOptions: number;
  readonly top: ChoiceTallyEntry | undefined;
  readonly tiedAtTop: boolean;
  readonly strictMajority: boolean;
}

export function parseFinalLineChoiceEnvelope(
  vendor: ProviderId,
  text: string | undefined,
  optionIds: readonly string[],
): ParsedChoiceEnvelope | null {
  try {
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    const valid = new Set(optionIds);
    if (valid.size === 0) return null;

    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (line === undefined || line.length === 0) continue;
      if (!(line.startsWith('{') && line.endsWith('}'))) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj === null || typeof obj !== 'object') continue;
      const rec = obj as Record<string, unknown>;
      const choice = typeof rec['choice'] === 'string' ? rec['choice'].trim() : '';
      if (!valid.has(choice)) continue;
      const confidence =
        typeof rec['confidence'] === 'number' && Number.isFinite(rec['confidence'])
          ? Math.max(0, Math.min(1, rec['confidence']))
          : undefined;
      const why = typeof rec['why'] === 'string' ? rec['why'].trim() : '';
      const keyRisk = typeof rec['key_risk'] === 'string' ? rec['key_risk'].trim() : '';
      return {
        vendor,
        choice,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(why.length > 0 ? { why } : {}),
        ...(keyRisk.length > 0 ? { keyRisk } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function tallyChoiceEnvelopes(
  envelopes: readonly ParsedChoiceEnvelope[],
): ChoiceTally {
  const counted = (envelopes ?? []).filter(
    (v): v is ParsedChoiceEnvelope =>
      v !== null && typeof v === 'object' && typeof v.choice === 'string',
  );

  const order: string[] = [];
  const byOption = new Map<string, ProviderId[]>();
  for (const v of counted) {
    const arr = byOption.get(v.choice);
    if (arr === undefined) {
      order.push(v.choice);
      byOption.set(v.choice, [v.vendor]);
    } else {
      arr.push(v.vendor);
    }
  }
  const tally: ChoiceTallyEntry[] = order
    .map((optionId) => {
      const vendors = byOption.get(optionId) ?? [];
      return { optionId, count: vendors.length, vendors };
    })
    .sort((a, b) => b.count - a.count);

  const total = counted.length;
  const top = tally[0];
  const topCount = top?.count ?? 0;
  const tiedAtTop = tally.filter((t) => t.count === topCount).length > 1;
  const strictMajority = top !== undefined && topCount * 2 > total;
  return {
    tally,
    total,
    distinctOptions: tally.length,
    top,
    tiedAtTop,
    strictMajority,
  };
}
