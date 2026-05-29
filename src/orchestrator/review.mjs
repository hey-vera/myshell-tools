/**
 * review.mjs — Manager review workflow and bounce-down pattern
 */

import { logBounce, logEscalation, logHandoff } from './handoffs.mjs';
import { parseConfidence } from './confidence.mjs';

/**
 * Run manager review of IC work and decide action
 * Implements the BOUNCE DOWN workflow from dual-brain
 */
export async function runManagerReview(task, icResult, context, runTierFn) {
  console.log(`  🔍 MANAGER REVIEW: Evaluating IC work...`);

  const reviewPrompt = buildManagerReviewPrompt(task, icResult, context);

  // Execute manager review
  const managerResult = await runTierFn('manager', reviewPrompt, {
    ...context,
    operation: 'review',
    reviewTarget: 'ic_output'
  });

  if (!managerResult.success) {
    console.log(`  ❌ Manager review failed: ${managerResult.error}`);
    return {
      verdict: 'error',
      action: 'approve', // Default to approving if review fails
      notes: `Manager review failed: ${managerResult.error}`,
      managerResult
    };
  }

  // Parse manager decision
  const decision = parseManagerReviewDecision(managerResult.output);

  console.log(`  📋 Manager decision: ${decision.verdict.toUpperCase()}`);
  if (decision.notes) {
    console.log(`  📝 Notes: ${decision.notes}`);
  }

  // Log the review handoff
  logHandoff('manager_review', 'ic', 'manager', {
    reason: 'post-execution review',
    confidenceIn: icResult.confidence,
    confidenceOut: managerResult.confidence,
    durationMs: managerResult.durationMs,
    sessionId: context.sessionId,
    notes: decision.notes,
    verdict: decision.verdict
  });

  return {
    verdict: decision.verdict,
    action: decision.action,
    notes: decision.notes,
    managerResult,
    icResult
  };
}

/**
 * Build the manager review prompt
 */
function buildManagerReviewPrompt(originalTask, icResult, context) {
  const prompt = `You are a MANAGER reviewing work completed by an IC (Individual Contributor).

ORIGINAL TASK: ${originalTask}

IC'S WORK RESULT:
─────────────────
${icResult.output}
─────────────────
IC Confidence: ${icResult.confidence || 'Not reported'}
Duration: ${icResult.durationMs || 'Unknown'}ms
Model: ${icResult.selectedModel?.model || 'Unknown'}

Your job is to review this work and decide:

REVIEW CRITERIA:
1. CORRECTNESS: Did the IC actually complete the task as requested?
2. QUALITY: Is the implementation solid, or are there obvious issues?
3. SECURITY: Any security concerns or risky patterns?
4. COMPLETENESS: Are there missing pieces or edge cases not handled?
5. EDGE CASES: What could break under unusual conditions?

POSSIBLE VERDICTS:
- APPROVE: Work is good, ship it
- BOUNCE: IC should fix issues and retry (provide specific feedback)
- ESCALATE: Manager should take over this task directly
- REFRAME: Task needs to be broken down or approached differently

Your response MUST end with structured output:
{"verdict": "approve|bounce|escalate|reframe", "notes": "specific feedback", "confidence": 0.0-1.0, "risk_level": "low|medium|high|critical"}

If bouncing, be specific about what needs to be fixed.
If approving, note any minor concerns for future reference.`;

  // Add context about previous attempts if this is a retry
  if (context.attempt && context.attempt > 1) {
    prompt += `\n\nNOTE: This is attempt #${context.attempt}. Previous manager feedback was addressed.`;
  }

  // Add manager notes from previous bounces
  if (context.managerNotes) {
    prompt += `\n\nPREVIOUS MANAGER FEEDBACK:\n${context.managerNotes}`;
  }

  return prompt;
}

/**
 * Parse manager's review decision from their response
 */
function parseManagerReviewDecision(managerOutput) {
  const confidence = parseConfidence(managerOutput);

  // Try to extract structured decision
  const structuredMatch = managerOutput.match(/\{[^{}]*"verdict"[^{}]*\}/);

  if (structuredMatch) {
    try {
      const data = JSON.parse(structuredMatch[0]);
      return {
        verdict: data.verdict || 'approve',
        notes: data.notes || '',
        confidence: data.confidence || confidence.confidence,
        riskLevel: data.risk_level || 'medium',
        action: mapVerdictToAction(data.verdict)
      };
    } catch (error) {
      console.warn(`Failed to parse manager decision JSON: ${error.message}`);
    }
  }

  // Fallback: try to parse from text patterns
  const text = managerOutput.toLowerCase();

  let verdict = 'approve'; // default
  let action = 'approve';

  if (text.includes('bounce') || text.includes('retry') || text.includes('fix')) {
    verdict = 'bounce';
    action = 'bounce';
  } else if (text.includes('escalate') || text.includes('take over') || text.includes('manager should')) {
    verdict = 'escalate';
    action = 'escalate';
  } else if (text.includes('reframe') || text.includes('break down') || text.includes('different approach')) {
    verdict = 'reframe';
    action = 'reframe';
  } else if (text.includes('approve') || text.includes('lgtm') || text.includes('ship it')) {
    verdict = 'approve';
    action = 'approve';
  }

  // Extract notes from the content (everything before structured output)
  const notes = structuredMatch
    ? managerOutput.substring(0, managerOutput.indexOf(structuredMatch[0])).trim()
    : managerOutput.substring(0, 300).trim(); // First 300 chars as fallback

  return {
    verdict,
    action,
    notes: notes || 'No specific notes provided',
    confidence: confidence.confidence,
    riskLevel: 'medium' // default when not specified
  };
}

/**
 * Map verdict to specific action
 */
function mapVerdictToAction(verdict) {
  const actionMap = {
    approve: 'approve',
    bounce: 'bounce',
    escalate: 'escalate',
    reframe: 'reframe'
  };

  return actionMap[verdict] || 'approve';
}

/**
 * Check if task qualifies for automatic manager review
 * Based on risk level and tier routing rules
 */
export function shouldTriggerManagerReview(task, classification, icResult) {
  // Always review critical risk tasks
  if (classification.risk === 'critical') {
    return { required: true, reason: 'critical risk level' };
  }

  // Review high risk tasks with medium or low confidence
  if (classification.risk === 'high' && icResult.confidence < 0.7) {
    return { required: true, reason: 'high risk with low confidence' };
  }

  // Review if IC explicitly requested it
  if (icResult.escalate === true) {
    return { required: true, reason: 'IC requested escalation' };
  }

  // Review auth/billing/security related changes
  if (classification.paths.some(path =>
    path.includes('auth') ||
    path.includes('credential') ||
    path.includes('billing') ||
    path.includes('payment')
  )) {
    return { required: true, reason: 'sensitive file paths' };
  }

  // Review if no tests were added for substantial changes
  if (!icResult.output.toLowerCase().includes('test') &&
      icResult.output.length > 500 &&
      classification.risk !== 'low') {
    return { required: true, reason: 'substantial change without tests' };
  }

  return { required: false, reason: 'standard IC work' };
}