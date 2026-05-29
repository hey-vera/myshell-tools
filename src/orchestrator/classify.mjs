/**
 * classify.mjs — Simple task classification for hierarchical routing
 * Adapted from archive/dual-brain/hooks/vibe-router.mjs
 */

/**
 * Risk keyword patterns for escalation detection
 */
const RISK_KEYWORDS = [
  {
    level: 'critical',
    regex: /\b(auth|credential|secret|\.env|key[s]?|token[s]?|password|encrypt|certificate)\b/i,
    label: 'security-sensitive'
  },
  {
    level: 'high',
    regex: /\b(login|payment|billing|deploy|migration|ci[-/]?cd|permission|policy|schema|api[-_]?contract)\b/i,
    label: 'high-impact'
  },
  {
    level: 'medium',
    regex: /\b(test|spec|config|integration|shared|util|lib)\b/i,
    label: 'shared/tested code'
  },
  {
    level: 'low',
    regex: /\b(readme|docs?|comment|format|lint|style|typo|changelog|nav|ui|css|color|font|margin|padding)\b/i,
    label: 'docs/UI'
  }
];

const LEVEL_ORDER = { critical: 3, high: 2, medium: 1, low: 0 };

/**
 * Tier detection patterns
 */
const WORKER_WORDS = /\b(explore|search|find|grep|locate|where\s+is|list\s+files|read[-\s]?only|lookup|scan|check|look|where|what)\b/i;
const MANAGER_WORDS = /\b(review|plan|design|architect|decide|analyze|audit|security|code[-\s]?review|threat[-\s]?model|complex[-\s]?debug|evaluate|compare|assess)\b/i;

/**
 * Classify task risk level based on keywords
 */
function classifyKeywordRisk(text) {
  let highest = { level: 'low', reason: 'general task' };

  for (const pattern of RISK_KEYWORDS) {
    const match = text.match(pattern.regex);
    if (match && LEVEL_ORDER[pattern.level] > LEVEL_ORDER[highest.level]) {
      highest = { level: pattern.level, reason: `${pattern.label} (${match[0]})` };
      if (pattern.level === 'critical') return highest;
    }
  }

  return highest;
}

/**
 * Detect file paths in text and classify their risk
 */
function extractPaths(text) {
  const pathRegex = /(?:^|\s)([\w./\-_]+\/[\w./\-_]*\.[\w]+)(?:\s|$)/g;
  const paths = [];
  let match;

  while ((match = pathRegex.exec(text)) !== null) {
    paths.push(match[1]);
  }

  return paths;
}

function classifyPathRisk(paths) {
  if (paths.length === 0) return { level: 'low', reason: 'no files mentioned' };

  let highest = { level: 'low', reason: 'general files' };

  for (const path of paths) {
    const lowerPath = path.toLowerCase();

    if (lowerPath.includes('.env') ||
        lowerPath.includes('secret') ||
        lowerPath.includes('credential')) {
      return { level: 'critical', reason: `sensitive file (${path})` };
    }

    if (lowerPath.includes('auth') ||
        lowerPath.includes('security') ||
        lowerPath.includes('payment') ||
        lowerPath.includes('billing')) {
      highest = { level: 'high', reason: `sensitive directory (${path})` };
    } else if (lowerPath.includes('test') ||
               lowerPath.includes('spec') ||
               lowerPath.includes('config')) {
      if (LEVEL_ORDER['medium'] > LEVEL_ORDER[highest.level]) {
        highest = { level: 'medium', reason: `shared/test file (${path})` };
      }
    }
  }

  return highest;
}

/**
 * Determine the appropriate starting tier for a task
 */
function classifyTier(text) {
  if (MANAGER_WORDS.test(text)) return 'manager';
  if (WORKER_WORDS.test(text)) return 'worker';
  return 'ic'; // Default to IC tier
}

/**
 * Enhanced multi-signal classification function
 */
export function classifyTask(userMsg, fileContext) {
  const tier = classifyTier(userMsg);

  // Extract signals for classification
  const keywords = extractKeywords(userMsg);
  const paths = extractMentionedFiles(userMsg, fileContext);
  const complexity = assessComplexity(userMsg);

  // Multi-signal risk assessment
  const keywordRisk = classifyKeywordRisk(userMsg);
  const fileRisk = classifyFileRisk(paths);
  const complexityRisk = classifyComplexityRisk(complexity);

  // Take the highest risk level
  const risks = [keywordRisk, fileRisk, complexityRisk];
  const highestRisk = risks.reduce((max, current) =>
    LEVEL_ORDER[current.level] > LEVEL_ORDER[max.level] ? current : max
  );

  // Estimate confidence based on multiple signals
  const confidence = estimateTaskConfidence(keywords, complexity, paths, tier);

  return {
    task: userMsg.trim(),
    tier,
    risk: highestRisk.level,
    reason: highestRisk.reason,
    paths,
    keywords,
    complexity,
    confidence,
    signals: {
      keywordRisk,
      fileRisk,
      complexityRisk
    }
  };
}

/**
 * Legacy single-parameter version for backward compatibility
 */
export function classifyTaskLegacy(task) {
  return classifyTask(task, null);
}

/**
 * Determine if a task result should escalate based on confidence and risk
 */
export function shouldEscalate(result, classification) {
  // Always escalate if the model explicitly requests it
  if (result.escalate === true) {
    return true;
  }

  // Escalate low confidence results
  if (result.confidence !== null && result.confidence < 0.5) {
    return true;
  }

  // Escalate if task failed with errors
  if (!result.success) {
    return true;
  }

  // Escalate critical/high risk tasks with medium confidence
  if ((classification.risk === 'critical' || classification.risk === 'high') &&
      result.confidence !== null && result.confidence < 0.7) {
    return true;
  }

  // Look for uncertainty indicators in the output
  const uncertaintyWords = /\b(not sure|uncertain|don't know|unclear|confused|unsure|might|maybe|possibly)\b/i;
  if (uncertaintyWords.test(result.output)) {
    return true;
  }

  return false;
}

/**
 * Extract relevant keywords from task text
 */
function extractKeywords(text) {
  const words = text.toLowerCase().split(/\s+/);
  const relevantKeywords = [];

  for (const pattern of RISK_KEYWORDS) {
    const matches = text.match(pattern.regex);
    if (matches) {
      relevantKeywords.push(...matches.map(m => m.toLowerCase()));
    }
  }

  return [...new Set(relevantKeywords)]; // Remove duplicates
}

/**
 * Extract mentioned files, enhanced with context
 */
function extractMentionedFiles(text, fileContext) {
  const paths = extractPaths(text);

  // If fileContext is provided, add related files
  if (fileContext && fileContext.currentFiles) {
    // Add files from current git status or file list
    for (const file of fileContext.currentFiles) {
      if (text.toLowerCase().includes(file.toLowerCase())) {
        paths.push(file);
      }
    }
  }

  return [...new Set(paths)]; // Remove duplicates
}

/**
 * Assess task complexity based on multiple indicators
 */
function assessComplexity(text) {
  const lower = text.toLowerCase();
  let complexity = 0;

  // Length-based complexity
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 50) complexity += 2;
  else if (wordCount > 20) complexity += 1;

  // Multi-action complexity
  const actionWords = ['fix', 'add', 'remove', 'update', 'refactor', 'test', 'deploy'];
  const actionCount = actionWords.filter(action => lower.includes(action)).length;
  complexity += Math.min(actionCount, 3); // Cap at 3

  // Technical complexity indicators
  const complexPatterns = [
    /\b(integration|migration|refactor|architecture|database|performance|optimization)\b/i,
    /\b(concurrent|async|parallel|distributed|scalability)\b/i,
    /\b(security|encryption|authentication|authorization)\b/i
  ];

  complexity += complexPatterns.filter(pattern => pattern.test(text)).length;

  return Math.min(complexity, 10); // Cap at 10
}

/**
 * Classify risk based on task complexity
 */
function classifyComplexityRisk(complexity) {
  if (complexity >= 7) {
    return { level: 'high', reason: 'high complexity task' };
  } else if (complexity >= 4) {
    return { level: 'medium', reason: 'moderate complexity' };
  } else {
    return { level: 'low', reason: 'simple task' };
  }
}

/**
 * Estimate task confidence based on multiple signals
 */
function estimateTaskConfidence(keywords, complexity, paths, tier) {
  let confidence = 0.7; // Base confidence

  // Complexity penalty
  if (complexity > 6) confidence -= 0.3;
  else if (complexity > 3) confidence -= 0.1;

  // Risk keyword penalty
  const riskKeywords = keywords.filter(keyword =>
    RISK_KEYWORDS.some(pattern =>
      pattern.regex.test(keyword) && pattern.level !== 'low'
    )
  );
  confidence -= riskKeywords.length * 0.1;

  // Path-based adjustment
  const sensitivePaths = paths.filter(path =>
    path.includes('auth') ||
    path.includes('secret') ||
    path.includes('credential') ||
    path.includes('billing')
  );
  confidence -= sensitivePaths.length * 0.15;

  // Tier mismatch penalty
  if (tier === 'worker' && complexity > 3) confidence -= 0.2;
  if (tier === 'manager' && complexity < 2) confidence += 0.1;

  return Math.max(0.1, Math.min(1.0, confidence));
}

/**
 * Enhanced file risk classification
 */
function classifyFileRisk(paths) {
  if (paths.length === 0) return { level: 'low', reason: 'no files mentioned' };

  let highest = { level: 'low', reason: 'general files' };

  for (const path of paths) {
    const lowerPath = path.toLowerCase();

    // Critical patterns
    if (lowerPath.includes('.env') ||
        lowerPath.includes('secret') ||
        lowerPath.includes('credential') ||
        lowerPath.includes('private') ||
        lowerPath.includes('key')) {
      return { level: 'critical', reason: `sensitive file (${path})` };
    }

    // High risk patterns
    if (lowerPath.includes('auth') ||
        lowerPath.includes('security') ||
        lowerPath.includes('payment') ||
        lowerPath.includes('billing') ||
        lowerPath.includes('migration') ||
        lowerPath.includes('schema')) {
      highest = { level: 'high', reason: `sensitive directory (${path})` };
    }
    // Medium risk patterns
    else if (lowerPath.includes('test') ||
             lowerPath.includes('spec') ||
             lowerPath.includes('config') ||
             lowerPath.includes('api') ||
             lowerPath.includes('server')) {
      if (LEVEL_ORDER['medium'] > LEVEL_ORDER[highest.level]) {
        highest = { level: 'medium', reason: `shared/infrastructure file (${path})` };
      }
    }
  }

  return highest;
}

/**
 * Select the best available model for a given tier
 * Now with enhanced provider selection
 */
export function selectModel(tier, availableModels) {
  const tierModels = availableModels[tier] || [];

  if (tierModels.length === 0) {
    // Fallback: try to find any available model
    const allModels = [...(availableModels.worker || []),
                      ...(availableModels.ic || []),
                      ...(availableModels.manager || [])];
    return allModels[0] || null;
  }

  // Use intelligent provider selection if available
  if (typeof selectProvider !== 'undefined') {
    try {
      const selected = selectProvider(tier, { availableModels });
      if (selected) return selected;
    } catch (error) {
      console.warn('Provider selection failed, falling back to simple selection');
    }
  }

  // Fallback: prefer models with better tier alignment
  const tierPreferences = {
    worker: ['claude', 'codex'],
    ic: ['codex', 'claude'],
    manager: ['claude', 'codex']
  };

  const preferences = tierPreferences[tier] || [];
  for (const preferredProvider of preferences) {
    const model = tierModels.find(m => m.provider === preferredProvider);
    if (model) return model;
  }

  // Final fallback
  return tierModels[0];
}