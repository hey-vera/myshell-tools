/**
 * chef.mjs — The three-tier hierarchical orchestration engine
 */

import { executeClaude, buildClaudePrompt } from './providers/claude.mjs';
import { executeCodex, buildCodexPrompt } from './providers/codex.mjs';
import { classifyTask, shouldEscalate, selectModel } from './orchestrator/classify.mjs';
import { addMessage, addHandoff } from './state/session.mjs';
import { parseConfidence, shouldEscalateOnConfidence } from './orchestrator/confidence.mjs';
import { logHandoff, logEscalation, logBounce, checkFailureLoop } from './orchestrator/handoffs.mjs';
import { runManagerReview, shouldTriggerManagerReview } from './orchestrator/review.mjs';
import { selectProvider, checkProviderHealth } from './providers/select.mjs';
import { balanceProviderLoad } from './providers/balance.mjs';
import { trackHandoff } from './monitor/performance.mjs';

/**
 * Execute a task at a specific tier with intelligent provider selection
 */
async function runTier(tier, task, context = {}) {
  const { availableModels, sessionId } = context;

  // Use intelligent provider selection with load balancing
  const model = selectProvider ?
    selectProvider(tier, { availableModels, sessionId }) :
    selectModel(tier, availableModels);

  if (!model) {
    return {
      success: false,
      error: `No available model for tier: ${tier}`,
      tier,
      model: null
    };
  }

  // Check provider health before executing
  if (checkProviderHealth) {
    const health = checkProviderHealth(model.provider);
    if (!health.available) {
      console.log(`  ⚠️  ${model.provider} is degraded (${health.failures} recent failures)`);
      // Try to find alternative provider
      const tierModels = availableModels[tier] || [];
      const alternative = tierModels.find(m => m.provider !== model.provider);
      if (alternative) {
        console.log(`  🔄 Switching to ${alternative.provider}/${alternative.model}`);
        return runTier(tier, task, { ...context, availableModels: { [tier]: [alternative] } });
      }
    }
  }

  console.log(`  ${tier.toUpperCase()} (${model.provider}/${model.model}): Working...`);

  const startTime = Date.now();
  let result;
  let prompt;

  try {
    // Build appropriate prompt for the provider and tier
    if (model.provider === 'claude') {
      prompt = buildClaudePrompt(tier, task, context);
      result = await executeClaude(model.bin, model.model, prompt, context.options);
    } else if (model.provider === 'codex') {
      prompt = buildCodexPrompt(tier, task, context);
      result = await executeCodex(model.bin, model.model, prompt, context.options);
    } else {
      return {
        success: false,
        error: `Unknown provider: ${model.provider}`,
        tier,
        model
      };
    }

    // Enhanced confidence parsing
    if (result.success && result.output) {
      const confidenceData = parseConfidence(result.output);
      result.confidence = confidenceData.confidence;
      result.escalate = confidenceData.escalate;
      result.reasoning = confidenceData.reason;
      result.needsReview = confidenceData.needsReview;
      result.structured = confidenceData.structured;
    }

    // Add metadata
    result.tier = tier;
    result.selectedModel = model;
    result.durationMs = Date.now() - startTime;

    // Log the handoff for audit trail
    if (logHandoff) {
      logHandoff('execute', 'user', tier, {
        providerfrom: 'user',
        providerTo: model.provider,
        confidenceOut: result.confidence,
        durationMs: result.durationMs,
        sessionId: context.sessionId,
        success: result.success
      });
    }

    // Track performance metrics
    trackHandoff({
      operation: 'execute',
      fromTier: 'user',
      toTier: tier,
      provider: model.provider,
      model: model.model,
      confidence: result.confidence,
      success: result.success,
      durationMs: result.durationMs,
      tokensUsed: result.usage?.total_tokens || null,
      prompt: task,
      output: result.output
    });

    return result;

  } catch (error) {
    const errorResult = {
      success: false,
      error: error.message,
      tier,
      model,
      output: '',
      durationMs: Date.now() - startTime
    };

    // Log failure for future routing decisions
    if (logHandoff) {
      logHandoff('execute_failed', 'user', tier, {
        providerFrom: 'user',
        providerTo: model.provider,
        durationMs: errorResult.durationMs,
        sessionId: context.sessionId,
        reason: error.message,
        success: false
      });
    }

    return errorResult;
  }
}

/**
 * The main orchestration function with Phase 2 smart routing enhancements
 */
export async function chef(userMessage, context = {}) {
  console.log(`\nCortex AI Org Chart Processing: "${userMessage}"`);

  // Generate session ID for tracking
  const sessionId = context.sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  context.sessionId = sessionId;

  // Step 1: Enhanced task classification
  const classification = classifyTask(userMessage, context.fileContext);
  console.log(`Task Classification: ${classification.tier} tier, ${classification.risk} risk`);
  console.log(`Reason: ${classification.reason}`);
  console.log(`Confidence Estimate: ${(classification.confidence * 100).toFixed(0)}%`);

  // Check for failure loops before starting
  const taskHash = createTaskHash(userMessage);
  const failureCheck = checkFailureLoop ? checkFailureLoop(taskHash) : { isLoop: false };

  if (failureCheck.isLoop) {
    console.log(`  ⚠️  Failure loop detected (${failureCheck.bounceCount} bounces, score: ${failureCheck.weightedScore.toFixed(1)})`);
    if (failureCheck.suggestion === 'escalate_to_manager') {
      classification.tier = 'manager';
      console.log(`  ↗️  Auto-escalating to MANAGER due to failure loop`);
    }
  }

  // Step 2: Start with the classified tier (or IC as default)
  let currentTier = classification.tier === 'manager' ? 'manager' : 'ic';
  let attempts = 0;
  const maxAttempts = 3;
  let lastResult = null;

  while (attempts < maxAttempts) {
    attempts++;
    console.log(`\nAttempt ${attempts}: Starting at ${currentTier.toUpperCase()} tier`);

    // Execute at current tier
    const result = await runTier(currentTier, userMessage, {
      ...context,
      attempt: attempts,
      taskHash,
      managerNotes: context.managerNotes
    });

    if (!result.success) {
      console.log(`  ❌ ${currentTier.toUpperCase()} failed: ${result.error}`);

      // Log escalation due to failure
      if (logEscalation && currentTier !== 'manager') {
        logEscalation(currentTier, 'manager', 'execution failure', {
          sessionId,
          attempt: attempts,
          taskHash,
          error: result.error
        });
      }

      if (currentTier !== 'manager') {
        console.log(`  ↗️  ESCALATE → MANAGER (execution failure)`);
        addHandoff('escalate', currentTier, 'manager', 'execution failure');
        currentTier = 'manager';
        context.previous = result;
        continue;
      } else {
        return {
          success: false,
          output: result.error,
          tier: 'manager',
          totalAttempts: attempts,
          finalResult: result,
          sessionId
        };
      }
    }

    lastResult = result;

    // Log successful completion
    console.log(`  ✓ ${currentTier.toUpperCase()} completed`);
    if (result.confidence !== null) {
      console.log(`    Confidence: ${(result.confidence * 100).toFixed(0)}%`);
    }

    // Phase 2 Enhancement: Manager Review Pattern for high-stakes work
    if (currentTier === 'ic' && shouldTriggerManagerReview) {
      const reviewCheck = shouldTriggerManagerReview(userMessage, classification, result);

      if (reviewCheck.required) {
        console.log(`  🔍 Triggering manager review: ${reviewCheck.reason}`);

        const review = await runManagerReview(userMessage, result, context, runTier);

        if (review.verdict === 'bounce' && attempts < maxAttempts) {
          console.log(`  ↩️  BOUNCE DOWN: Manager wants fixes (attempt ${attempts + 1})`);

          // Log bounce for audit trail
          if (logBounce) {
            logBounce('manager', 'ic', review.notes, attempts + 1, {
              sessionId,
              taskHash,
              originalConfidence: result.confidence,
              reviewConfidence: review.managerResult.confidence
            });
          }

          // Set up context for retry with manager feedback
          context.managerNotes = review.notes;
          context.attempt = attempts + 1;

          // Stay at IC tier but incorporate manager feedback
          continue; // This will increment attempts and retry
        } else if (review.verdict === 'escalate') {
          console.log(`  ↗️  ESCALATE: Manager taking over directly`);
          currentTier = 'manager';
          context.previous = result;
          continue;
        } else if (review.verdict === 'approve') {
          console.log(`  ✅ Manager approved IC work`);
          // Continue with approval
        }
      }
    }

    // Check if we should escalate based on confidence/risk
    const needsEscalation = shouldEscalate(result, classification) ||
                           shouldEscalateOnConfidence(result.confidence, classification.risk, currentTier);

    if (needsEscalation && currentTier !== 'manager') {
      console.log(`  ↗️  ESCALATE → MANAGER (${result.reasoning || 'low confidence'})`);

      if (logEscalation) {
        logEscalation(currentTier, 'manager', result.reasoning || 'low confidence', {
          sessionId,
          attempt: attempts,
          taskHash,
          confidence: result.confidence,
          riskLevel: classification.risk
        });
      }

      addHandoff('escalate', currentTier, 'manager', result.reasoning || 'low confidence', {
        confidence: result.confidence
      });

      currentTier = 'manager';
      context.previous = result;
      continue;
    }

    // Task completed successfully
    console.log(`  🎯 Task completed at ${currentTier.toUpperCase()} tier`);

    return {
      success: true,
      output: result.output,
      tier: currentTier,
      confidence: result.confidence,
      model: result.selectedModel,
      classification,
      totalAttempts: attempts,
      finalResult: result,
      sessionId,
      review: currentTier === 'ic' ? 'manager_approved' : 'direct_completion'
    };
  }

  return {
    success: false,
    output: 'Maximum escalation attempts reached',
    tier: currentTier,
    totalAttempts: attempts,
    error: 'Max attempts exceeded',
    sessionId,
    lastResult
  };
}

/**
 * Create a hash for task tracking across attempts
 */
function createTaskHash(task) {
  // Simple hash for tracking related attempts
  return `task_${Buffer.from(task.slice(0, 100)).toString('base64').slice(0, 8)}`;
}

/**
 * Handle delegation to worker tier for simple tasks
 */
export async function delegateToWorker(task, context = {}) {
  console.log(`  ↘️  DELEGATE → WORKER`);
  addHandoff('delegate', 'ic', 'worker', 'simple task delegation');

  const result = await runTier('worker', task, context);

  if (!result.success || shouldEscalate(result, classifyTask(task))) {
    console.log(`  ↗️  WORKER → IC (delegation failed or escalation needed)`);
    addHandoff('escalate', 'worker', 'ic', result.reasoning || 'worker task failed');
    return null; // Signal to retry at IC level
  }

  console.log(`  ✓ WORKER completed delegation`);
  return result;
}