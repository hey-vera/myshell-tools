/**
 * src/interface/meta-decision.ts — typed DecisionEngine for the conscious meta layer.
 *
 * The model IS the orchestrator: a single high-effort strong-model call parses
 * natural-language intent into a typed decision + action plan. This module is
 * PURE (no I/O, no time) — it only shapes the prompt and parses/validates the
 * JSON the strong model returns. Execution lives in menu.ts where the live
 * stores and scheduler are in scope.
 */

import type { GoalPatch } from '../infra/goal-store.js';

type MetaIntent =
  | 'accept_plan'
  | 'adjust_plan'
  | 'bg_directive'
  | 'new_plan'
  | 'pause_goal'
  | 'clarify'
  | 'normal_chat';

type MetaAction =
  | { readonly kind: 'accept'; readonly goalIds: readonly string[] }
  | { readonly kind: 'pause'; readonly goalId: string; readonly reason?: string }
  | { readonly kind: 'bg'; readonly goalIds: readonly string[] }
  | {
      readonly kind: 'adjust';
      readonly goalId: string;
      readonly patch: GoalPatch;
      readonly note?: string;
    }
  | { readonly kind: 'clarify'; readonly question: string }
  | { readonly kind: 'new_plan'; readonly title: string; readonly prompt: string };

export interface MetaDecision {
  readonly intent: MetaIntent;
  readonly confidence: number;
  readonly rationale: string;
  readonly details?: Record<string, unknown>;
  readonly actions?: readonly MetaAction[];
}

export interface DecisionEngineOptions {
  readonly userLine: string;
  readonly fullCtx: Record<string, unknown>;
  readonly callStrongMeta: (
    prompt: string,
    signal: AbortSignal,
    extra?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
  readonly signal: AbortSignal;
}

const VALID_INTENTS: ReadonlySet<string> = new Set<MetaIntent>([
  'accept_plan',
  'adjust_plan',
  'bg_directive',
  'new_plan',
  'pause_goal',
  'clarify',
  'normal_chat',
]);

const clampConfidence = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function parseAction(raw: unknown): MetaAction | null {
  if (!isPlainObject(raw)) return null;
  const kind = String(raw.kind ?? '');
  switch (kind) {
    case 'accept': {
      const goalIds = Array.isArray(raw.goalIds)
        ? raw.goalIds.filter((x): x is string => typeof x === 'string')
        : [];
      return goalIds.length > 0 ? { kind, goalIds } : null;
    }
    case 'pause': {
      const goalId = String(raw.goalId ?? '');
      return goalId.length > 0
        ? { kind, goalId, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}) }
        : null;
    }
    case 'bg': {
      const goalIds = Array.isArray(raw.goalIds)
        ? raw.goalIds.filter((x): x is string => typeof x === 'string')
        : [];
      return goalIds.length > 0 ? { kind, goalIds } : null;
    }
    case 'adjust': {
      const goalId = String(raw.goalId ?? '');
      if (goalId.length === 0) return null;
      const patch = raw.patch;
      if (!isPlainObject(patch)) return null;
      return { kind, goalId, patch: patch as GoalPatch, ...(typeof raw.note === 'string' ? { note: raw.note } : {}) };
    }
    case 'clarify': {
      const question = String(raw.question ?? '');
      return question.length > 0 ? { kind, question } : null;
    }
    case 'new_plan': {
      const title = String(raw.title ?? '');
      const prompt = String(raw.prompt ?? '');
      return title.length > 0 && prompt.length > 0 ? { kind, title, prompt } : null;
    }
    default:
      return null;
  }
}

/** Public parser so tests and the UI can inspect a raw model reply. */
function parseMetaDecision(raw: unknown): MetaDecision | null {
  if (!isPlainObject(raw)) return null;
  const intent = String(raw.intent ?? '');
  if (!VALID_INTENTS.has(intent)) return null;
  const actions: MetaAction[] = [];
  if (Array.isArray(raw.actions)) {
    for (const a of raw.actions) {
      const parsed = parseAction(a);
      if (parsed !== null) actions.push(parsed);
    }
  }
  return {
    intent: intent as MetaIntent,
    confidence: clampConfidence(raw.confidence),
    rationale: String(raw.rationale ?? ''),
    ...(isPlainObject(raw.details) ? { details: raw.details } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/**
 * Build the decision-engine prompt. The model receives the full picture context
 * and returns a single JSON object describing intent + actions.
 */
function buildDecisionPrompt(userLine: string, fullCtxJson: string): string {
  return `You are the high-intelligence meta-orchestrator for myshell-tools (conscious thinker, not dumb wiring).

FULL PICTURE CONTEXT (injected for you to see everything):
${fullCtxJson}

User natural language input: "${userLine}"

Your job: Parse the user's intent and emit a TYPED ACTION PLAN that the system will execute. You are the orchestrator — reason from the full picture, respect taste as a hard constraint, and choose wisely. Prefer concrete actions over chat when the input is clearly about goals/plans/execution.

Available intents:
- "accept_plan": user accepts the last proposed plan (e.g. "accept", "go", "looks good", "start all", "unblocked"). Action: { "kind": "accept", "goalIds": ["..."] }
- "adjust_plan": user changes a named goal/plan (e.g. "pause goal 3 and change to JWT", "drop the auth step", "add a test for X"). Action: { "kind": "adjust", "goalId": "...", "patch": { title?, state?, approach?, tags?, roadmapPatch?: { add?, edit?, remove?, reorder? } }, "note": "..." }
- "bg_directive": user wants work in the background (e.g. "bg the tests", "work on docs in background"). Action: { "kind": "bg", "goalIds": ["..."] }
- "pause_goal": user pauses a goal (e.g. "pause goal 3", "hold off on auth"). Action: { "kind": "pause", "goalId": "...", "reason": "..." }
- "new_plan": user asks for a plan for new work (e.g. "plan the auth project"). Action: { "kind": "new_plan", "title": "...", "prompt": "..." }
- "clarify": you need one sharp question before acting. Action: { "kind": "clarify", "question": "..." }
- "normal_chat": none of the above — fall through to normal chat.

Output ONLY valid JSON (no prose, no markdown):
{
  "intent": "accept_plan" | "adjust_plan" | "bg_directive" | "new_plan" | "pause_goal" | "clarify" | "normal_chat",
  "confidence": number 0-1,
  "rationale": "short why, citing the full picture",
  "details": { /* freeform extra context */ },
  "actions": [ /* one or more typed actions; empty for normal_chat */ ]
}

Rules:
- For adjust, resolve "goal 3" or "the auth goal" to the actual goalId from the full picture goals list. Preserve verified-done work; do not remove passing/reviewed items.
- For bg, only mark goals that are parked/queued; skip already-running goals.
- For accept, prefer all parked goals from the last plan when no specific goal is named.
- Hard taste constraints in the full picture MUST be respected; if the input conflicts with taste, note the tension in rationale.
- If uncertain, use "clarify" with a single sharp question.`;
}

export async function runDecisionEngine(opts: DecisionEngineOptions): Promise<MetaDecision | null> {
  const prompt = buildDecisionPrompt(opts.userLine, JSON.stringify(opts.fullCtx, null, 2));
  const raw = await opts.callStrongMeta(prompt, opts.signal, { task: 'decision_engine' });
  if (raw === null) return null;
  // callStrongMeta already returns parsed JSON, but providers sometimes wrap it
  // in markdown fences; re-stringify and clean just in case.
  const cleaned = JSON.stringify(raw)
    .replace(/```json\s*/g, '')
    .replace(/```\s*$/g, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  return parseMetaDecision(parsed);
}
