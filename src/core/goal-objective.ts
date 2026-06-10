/**
 * src/core/goal-objective.ts — the pure core for SMART goal-objective formation.
 *
 * When a goal STARTS (explicit `/goal <text>`, auto-engage, timeout-chunk, the
 * model's keep-going offer), the user's raw text must be turned into a CRISP,
 * PROFESSIONAL objective — the way a senior engineer or PM would name the goal —
 * NOT an echo of whatever the user typed. That objective becomes the visible
 * `goal: <…>` progress line, the anti-drift contract OBJECTIVE, and the
 * conversation title, so it is the most-seen string in an autonomous run.
 *
 * This module is the PURE half (no fs/path/child_process/Date/Math.random),
 * exactly like `recap.ts`: it builds the one-shot prompt (read by a MANAGER-tier
 * model, given the product-vision / quality-bar persona first) and parses the
 * reply into a clean objective. The model touch itself lives behind the injected
 * generator realised in `goal-objective-generator.ts` (a near-twin of
 * `recap-generator.ts`). Fail-soft contract: the generator returns `null` on ANY
 * failure so goal-start NEVER blocks and the caller degrades to the deterministic
 * `formConciseGoalLabel(deriveGoal(raw))` shaper.
 */

import { ELITE_VOICE_PREAMBLE } from './prompt.js';

/** Hard cap on the formed objective — a crisp label, not a sentence. Mirrors the
 * recap TITLE bound so the visible goal line and the conversation title match. */
export const GOAL_OBJECTIVE_MAX_CHARS = 72;

/**
 * Build the one-shot goal-objective prompt. Read by a CAPABLE (manager-tier)
 * model, so it is given the product-vision / quality bar persona first (the reused
 * {@link ELITE_VOICE_PREAMBLE}), then asked to name the objective the way a senior
 * engineer or PM would — NEVER an echo of the user's phrasing, NEVER a
 * "we/this/the user" preamble. Returns '' for empty input so the caller skips the
 * model touch. PURE; never throws.
 */
export function buildGoalObjectivePrompt(rawText: string): string {
  const text = (rawText ?? '').trim();
  if (text.length === 0) return '';
  return [
    ELITE_VOICE_PREAMBLE,
    '',
    'Using that bar, you are naming a single autonomous work GOAL for the user so',
    "the run reads like a senior engineer or PM set the objective. Read the user's",
    'raw request below and figure out what they are REALLY trying to achieve, then',
    'return EXACTLY one line and nothing else:',
    '',
    'OBJECTIVE: <a crisp, professional objective that names the actual goal>',
    '',
    'Hard rules:',
    `  - ≤${GOAL_OBJECTIVE_MAX_CHARS} characters. Name the OBJECTIVE (e.g.`,
    '    "heyvera — YouTube-scale video platform in Rust"), not a topic-less',
    "    restatement of what the user typed. NEVER echo the user's phrasing or",
    '    parrot their words back.',
    '  - NO leading "we"/"this"/"the user"/"I"/"let\'s" preamble, NO filler like',
    '    "the goal is" — start with the objective itself. No trailing punctuation.',
    '  - Distil rambling into the real intent: drop hedges ("so yea i think",',
    '    "like", "maybe"), keep the concrete target and any load-bearing constraint',
    '    (the stack, the scale, the product).',
    '  - Do NOT do the work, ask questions, or add any explanation. Reply with ONLY',
    '    the single tagged OBJECTIVE line.',
    '',
    'RAW REQUEST:',
    text,
  ].join('\n');
}

/**
 * Normalise the model-written objective into a clean goal label, or `null` when
 * unusable so the caller falls back to the deterministic shaper. Strips a leading
 * "OBJECTIVE:" label / marker glyph, collapses whitespace, drops a
 * "we/you/i/this/the user/let's/the goal is" preamble (so it reads as an
 * objective, not a narration), removes wrapping quotes + trailing sentence
 * punctuation, and bounds to {@link GOAL_OBJECTIVE_MAX_CHARS} on a word boundary.
 * Mirrors recap's `parseRecapTitle`. PURE; never throws.
 */
export function parseGoalObjective(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[※⏺*\-•]\s*/u, '');
  s = s.replace(/^objective\s*[:\-—]\s*/i, '').trim();
  // Strip surrounding quotes the model sometimes wraps a label in.
  s = s.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim();
  if (s.length === 0) return null;
  // Drop a leading conversational framing / filler so the label is an objective,
  // not a narration — only when it leaves a usable remainder.
  const reframed = s.replace(
    /^(?:we(?:'ve| have| are| were)?|you(?:'ve| have| are| were)?|i(?:'ve| have| am| was)?|let'?s|this(?: is| was)?|the (?:user|thread|goal(?: is| was)?|objective(?: is| was)?))\b[\s:,-]*/i,
    '',
  );
  if (reframed.trim().length >= 3) s = reframed.trim();
  // Strip trailing sentence punctuation AND any closing quote — a label is not a
  // sentence, and the model sometimes appends punctuation AFTER a closing quote
  // (e.g. `"Migrate auth";`), so peel both together until neither remains.
  s = s.replace(/["'“”.;,]+$/, '').trim();
  if (s.length < 3) return null;
  if (s.length > GOAL_OBJECTIVE_MAX_CHARS) {
    s = s.slice(0, GOAL_OBJECTIVE_MAX_CHARS).replace(/\s+\S*$/, '').trim();
    if (s.length === 0) return null;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}
