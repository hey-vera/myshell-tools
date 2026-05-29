/**
 * confidence.mjs — Parse model confidence output and handle structured responses
 */

/**
 * Extract confidence data from model response
 * Handles both structured JSON at the end and inline patterns
 */
export function parseConfidence(output) {
  if (!output || typeof output !== 'string') {
    return {
      confidence: null,
      escalate: false,
      reason: 'no output',
      needsReview: false,
      structured: false
    };
  }

  // Try to extract structured JSON from end of response
  const jsonMatch = output.match(/\{[^{}]*"confidence"[^{}]*\}(?:\s*$)/);

  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      return {
        confidence: parseFloat(data.confidence) || 0,
        escalate: data.escalate === true || data.escalate === 'true',
        reason: data.reason || 'structured response',
        needsReview: data.needs_review === true || data.needs_review === 'true',
        structured: true,
        rawData: data
      };
    } catch (error) {
      // Fall through to pattern-based parsing
    }
  }

  // Fallback: estimate confidence from response patterns
  return estimateConfidenceFromText(output);
}

/**
 * Estimate confidence from text patterns when structured output is missing
 */
function estimateConfidenceFromText(text) {
  const lower = text.toLowerCase();

  // High confidence indicators
  const highConfidence = [
    'definitely', 'certain', 'sure', 'confident', 'obviously',
    'clearly', 'exactly', 'precisely', 'completed successfully'
  ];

  // Medium confidence indicators
  const mediumConfidence = [
    'likely', 'probably', 'should work', 'appears to', 'seems like',
    'generally', 'typically', 'usually'
  ];

  // Low confidence / uncertainty indicators
  const lowConfidence = [
    'not sure', 'uncertain', "don't know", 'unclear', 'confused',
    'unsure', 'might', 'maybe', 'possibly', 'perhaps', 'could be',
    'need to check', 'requires investigation', 'hard to tell'
  ];

  // Escalation indicators
  const escalationWords = [
    'complex', 'complicated', 'difficult', 'needs review',
    'architecture decision', 'security concern', 'not my area',
    'beyond my scope', 'manager should', 'escalate'
  ];

  let confidence = 0.6; // default neutral
  let escalate = false;
  let reason = 'text analysis';

  // Check for explicit escalation requests
  if (escalationWords.some(word => lower.includes(word))) {
    escalate = true;
    confidence = Math.min(confidence, 0.4);
    reason = 'explicit escalation request';
  }

  // Adjust based on confidence indicators
  if (lowConfidence.some(word => lower.includes(word))) {
    confidence = Math.min(confidence, 0.3);
    escalate = true;
    reason = 'uncertainty indicators';
  } else if (highConfidence.some(word => lower.includes(word))) {
    confidence = Math.max(confidence, 0.8);
    reason = 'high confidence indicators';
  } else if (mediumConfidence.some(word => lower.includes(word))) {
    confidence = 0.6;
    reason = 'medium confidence indicators';
  }

  // Check for error patterns
  const errorPatterns = [
    /error/i, /failed/i, /couldn't/i, /unable to/i, /permission denied/i
  ];

  if (errorPatterns.some(pattern => pattern.test(text))) {
    confidence = 0.2;
    escalate = true;
    reason = 'error detected';
  }

  return {
    confidence,
    escalate,
    reason,
    needsReview: confidence < 0.5,
    structured: false
  };
}

/**
 * Validate confidence score is within expected range
 */
export function validateConfidence(confidence) {
  if (confidence === null || confidence === undefined) return null;

  const parsed = parseFloat(confidence);
  if (isNaN(parsed)) return null;

  // Clamp to valid range
  return Math.max(0, Math.min(1, parsed));
}

/**
 * Determine if a task result should escalate based on confidence and context
 */
export function shouldEscalateOnConfidence(confidence, riskLevel, tier) {
  if (confidence === null) return false;

  // Always escalate very low confidence
  if (confidence < 0.3) return true;

  // Risk-based thresholds
  const thresholds = {
    critical: 0.8,
    high: 0.7,
    medium: 0.5,
    low: 0.4
  };

  const threshold = thresholds[riskLevel] || thresholds.medium;
  return confidence < threshold;
}