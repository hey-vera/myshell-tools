/**
 * src/core/work-contract.ts — pure work-contract helpers.
 *
 * Stage 1 keeps contracts ephemeral: they are rendered into verifier prompts
 * only, never persisted and never parsed from model output.
 */

import type { Classification } from './types.js';
import type { ReviewVerdict } from './review.js';

export type RoadmapStatus = 'pending' | 'active' | 'done' | 'blocked';

export interface RoadmapItem {
  readonly id: string;
  readonly text: string;
  readonly status: RoadmapStatus;
}

export interface Checkpoint {
  readonly id: string;
  readonly summary: string;
  readonly roadmapId?: string;
  readonly evidence?: string;
}

export interface ContractVerification {
  readonly verdict: ReviewVerdict['verdict'];
  readonly notes?: string;
  readonly failedCheckpointIds?: readonly string[];
}

export interface WorkContract {
  readonly version: 1;
  readonly objective: string;
  readonly vision?: string;
  readonly roadmap?: readonly RoadmapItem[];
  readonly checkpoints?: readonly Checkpoint[];
  readonly verification?: ContractVerification;
}

type MaterializeContext = 'goal' | 'keep_going' | 'normal';

const ROADMAP_LIMIT = 8;
const CHECKPOINT_LIMIT = 6;
const OBJECTIVE_LIMIT = 240;
const VISION_LIMIT = 240;
const NOTES_LIMIT = 240;
const ROADMAP_TEXT_LIMIT = 160;
const CHECKPOINT_SUMMARY_LIMIT = 160;
const EVIDENCE_LIMIT = 120;

const VALID_STATUSES: ReadonlySet<string> = new Set<RoadmapStatus>([
  'pending',
  'active',
  'done',
  'blocked',
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

function capStatus(value: unknown): RoadmapStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value)
    ? (value as RoadmapStatus)
    : 'pending';
}

/**
 * Return a deterministic, capped copy of a contract. This function is defensive
 * at runtime and never throws on malformed values.
 */
export function capContract(c: WorkContract): WorkContract {
  const rawValue = c as unknown;
  const raw =
    rawValue !== null && typeof rawValue === 'object'
      ? (rawValue as {
          readonly objective?: unknown;
          readonly vision?: unknown;
          readonly roadmap?: unknown;
          readonly checkpoints?: unknown;
          readonly verification?: unknown;
        })
      : {};

  const roadmap = Array.isArray(raw.roadmap)
    ? raw.roadmap.slice(0, ROADMAP_LIMIT).map((item) => {
        const r =
          item !== null && typeof item === 'object'
            ? (item as {
                readonly id?: unknown;
                readonly text?: unknown;
                readonly status?: unknown;
              })
            : {};
        return {
          id: safeString(r.id),
          text: capText(r.text, ROADMAP_TEXT_LIMIT),
          status: capStatus(r.status),
        };
      })
    : undefined;

  const checkpoints = Array.isArray(raw.checkpoints)
    ? raw.checkpoints.slice(0, CHECKPOINT_LIMIT).map((checkpoint) => {
        const cp =
          checkpoint !== null && typeof checkpoint === 'object'
            ? (checkpoint as {
                readonly id?: unknown;
                readonly summary?: unknown;
                readonly roadmapId?: unknown;
                readonly evidence?: unknown;
              })
            : {};
        return {
          id: safeString(cp.id),
          summary: capText(cp.summary, CHECKPOINT_SUMMARY_LIMIT),
          ...(cp.roadmapId !== undefined ? { roadmapId: safeString(cp.roadmapId) } : {}),
          ...(cp.evidence !== undefined ? { evidence: capText(cp.evidence, EVIDENCE_LIMIT) } : {}),
        };
      })
    : undefined;

  const verification =
    raw.verification !== undefined && raw.verification !== null
      ? (raw.verification as {
          readonly verdict?: unknown;
          readonly notes?: unknown;
          readonly failedCheckpointIds?: unknown;
        })
      : undefined;

  const verdict =
    verification?.verdict === 'revise' || verification?.verdict === 'escalate'
      ? verification.verdict
      : 'approve';
  const failedCheckpointIds = Array.isArray(verification?.failedCheckpointIds)
    ? verification.failedCheckpointIds.map(safeString)
    : undefined;

  return {
    version: 1,
    objective: capText(raw.objective, OBJECTIVE_LIMIT),
    ...(raw.vision !== undefined ? { vision: capText(raw.vision, VISION_LIMIT) } : {}),
    ...(roadmap !== undefined ? { roadmap } : {}),
    ...(checkpoints !== undefined ? { checkpoints } : {}),
    ...(verification !== undefined
      ? {
          verification: {
            verdict,
            ...(verification.notes !== undefined
              ? { notes: capText(verification.notes, NOTES_LIMIT) }
              : {}),
            ...(failedCheckpointIds !== undefined ? { failedCheckpointIds } : {}),
          },
        }
      : {}),
  };
}

export function renderContractForPrompt(c: WorkContract): string {
  const lines = [`OBJECTIVE: ${c.objective}`];

  if (c.vision !== undefined && c.vision.length > 0) {
    lines.push(`VISION: ${c.vision}`);
  }

  if (c.roadmap !== undefined && c.roadmap.length > 0) {
    lines.push('ROADMAP:');
    for (const item of c.roadmap) {
      lines.push(`- [${item.status}] ${item.id}: ${item.text}`);
    }
  }

  if (c.checkpoints !== undefined && c.checkpoints.length > 0) {
    lines.push('CHECKPOINTS SO FAR:');
    for (const checkpoint of c.checkpoints) {
      const roadmap = checkpoint.roadmapId !== undefined ? ` (${checkpoint.roadmapId})` : '';
      const evidence = checkpoint.evidence !== undefined ? ` — evidence: ${checkpoint.evidence}` : '';
      lines.push(`- ${checkpoint.id}${roadmap}: ${checkpoint.summary}${evidence}`);
    }
  }

  return lines.join('\n');
}

export function shouldMaterializeContract(opts: {
  readonly classification: Classification;
  readonly routePlan: boolean;
  readonly context: MaterializeContext;
  readonly reviewWillRun: boolean;
}): { readonly criteria: boolean; readonly roadmap: boolean } {
  return {
    criteria: opts.reviewWillRun,
    roadmap:
      opts.context !== 'normal' ||
      opts.routePlan === true ||
      opts.classification.tier === 'manager',
  };
}
