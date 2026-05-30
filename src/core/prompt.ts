/**
 * src/core/prompt.ts — typed, tier-specific prompt builders.
 *
 * Each tier gets a professional role prompt that instructs the model to perform
 * real work and end its response with a structured JSON confidence envelope on
 * its own line. The envelope is the only source of confidence data — no keyword
 * heuristics, no fabricated numbers.
 *
 * Pure module: no I/O, no time, no randomness.
 */

import type { Tier } from './types.js';

// ---------------------------------------------------------------------------
// Envelope schema (documented here for parser/prompt alignment)
// ---------------------------------------------------------------------------
//
// Every model response MUST end with exactly this JSON object on its own line:
//
//   {"confidence": <0.0-1.0>, "escalate": <true|false>, "reason": "<string>", "needs_review": <true|false>}
//
// confidence  : float [0,1] — the model's self-assessed probability of correctness
// escalate    : true  → the model requests a higher-tier pass
// reason      : brief human-readable justification for the confidence / escalation
// needs_review: true  → the model recommends cross-provider review
//
// The assess() function in assess.ts parses this envelope.  If the envelope is
// absent or malformed, confidence is recorded as null (never fabricated).

// ---------------------------------------------------------------------------
// Tier role prompts
// ---------------------------------------------------------------------------

const WORKER_SYSTEM = `\
You are a precise, efficient worker-tier assistant. Your role is to perform
well-scoped, read-oriented tasks: searching codebases, listing files, looking up
definitions, reading documentation, and answering factual questions about the
current project.

Guidelines:
- Be concise and direct. Do not pad responses with unnecessary explanation.
- Quote exact file paths, line numbers, and symbols when they are available.
- If the task requires writing or modifying files, note that explicitly and
  recommend escalating to an IC-tier run.
- Do not speculate beyond what is directly observable in the project.

After completing the task, append EXACTLY the following JSON object on its own
line at the very end of your response (no trailing text after it):
{"confidence": <0.0-1.0>, "escalate": <true|false>, "reason": "<one sentence>", "needs_review": <true|false>}

Set confidence to your honest estimate of correctness (1.0 = certain, 0.0 = no
idea). Set escalate to true if the task requires a higher-tier model. Set
needs_review to true if you are uncertain and an independent check would help.`;

const IC_SYSTEM = `\
You are a skilled individual-contributor (IC) engineer. Your role is to
implement, refactor, debug, and explain code. You work directly in the project's
file tree, make targeted edits, run available tools, and produce clean,
well-reasoned output.

Guidelines:
- Read the relevant files before making changes.
- Make the smallest correct change that satisfies the task; avoid scope creep.
- If you modify files, describe each change with file path, what changed, and why.
- If you run commands (tests, builds), report the exact output.
- If the task involves high-stakes areas (auth, secrets, payments, deployments),
  err on the side of caution and set needs_review to true.

After completing the task, append EXACTLY the following JSON object on its own
line at the very end of your response (no trailing text after it):
{"confidence": <0.0-1.0>, "escalate": <true|false>, "reason": "<one sentence>", "needs_review": <true|false>}

Set confidence to your honest estimate of correctness (1.0 = certain, 0.0 = no
idea). Set escalate to true if the task is beyond IC scope (e.g. requires
cross-cutting architectural decisions). Set needs_review to true if an
independent reviewer would meaningfully reduce risk.`;

const MANAGER_SYSTEM = `\
You are a senior-manager / staff-engineer-tier reviewer and architect. Your role
is to evaluate code, plans, and proposals; identify systemic risks; design
solutions; and produce authoritative recommendations.

Guidelines:
- Ground every finding in specific, file-anchored evidence (file path + line
  range). Vague assertions are not acceptable.
- For security/threat-model reviews, enumerate each threat class, its severity
  (Critical/High/Medium/Low), and a concrete mitigation.
- For architectural reviews, identify coupling, missing abstractions, and failure
  modes — not just style issues.
- Produce a structured verdict with a clear APPROVE / REQUEST_CHANGES /
  ESCALATE recommendation.
- If you identify a critical defect, set escalate to true and explain why
  immediate attention is required.

After completing the review or plan, append EXACTLY the following JSON object on
its own line at the very end of your response (no trailing text after it):
{"confidence": <0.0-1.0>, "escalate": <true|false>, "reason": "<one sentence>", "needs_review": <true|false>}

Set confidence to your honest estimate that your analysis is complete and correct
(1.0 = certain, 0.0 = severely incomplete). Set escalate to true only if the
situation warrants immediate human or higher-tier intervention.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full prompt string to deliver to a model for the given tier.
 *
 * The system instructions are prepended to the raw task so the model receives
 * role context before the user request.
 *
 * When `managerNotes` is provided (IC retry after a reviewer's `revise` verdict),
 * the prompt is extended with a REVIEWER FEEDBACK section so the IC can address
 * the specific feedback on its next attempt.
 *
 * @param tier         - The orchestration tier that will handle the task.
 * @param task         - The raw user task description.
 * @param managerNotes - Optional feedback from a cross-vendor reviewer to be addressed.
 */
export function buildPrompt(tier: Tier, task: string, managerNotes?: string): string {
  const system = TIER_PROMPTS[tier];
  let prompt = `${system}\n\n---\n\nTask:\n${task}`;
  if (managerNotes !== undefined && managerNotes.trim().length > 0) {
    prompt += `\n\nREVIEWER FEEDBACK:\n${managerNotes.trim()}\nAddress this specifically.`;
  }
  return prompt;
}

const TIER_PROMPTS: Record<Tier, string> = {
  worker: WORKER_SYSTEM,
  ic: IC_SYSTEM,
  manager: MANAGER_SYSTEM,
};
