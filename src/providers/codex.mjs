/**
 * codex.mjs — Codex CLI subprocess wrapper with robust error handling
 * Adapted from archive/dual-brain/hooks/gpt-work-dispatcher.mjs
 */

import { spawnSync } from 'child_process';
import {
  executeWithRecovery,
  parseCliOutput,
  createFriendlyErrorMessage,
  CliError,
  defaultRetryCallback
} from './errors.mjs';

/**
 * Execute a Codex command with the specified model and prompt
 */
export async function executeCodex(codexBin, model, prompt, options = {}) {
  const startTime = Date.now();

  const args = [
    'exec', '--json', '--ephemeral',
    '-m', model,
    '-s', 'danger-full-access',
    prompt
  ];

  let proc;
  try {
    proc = await executeWithRecovery(codexBin, args, {
      provider: 'codex',
      timeoutMs: options.timeoutMs || 120000,
      cwd: options.cwd || process.cwd(),
      onRetry: options.onRetry || defaultRetryCallback
    });
  } catch (error) {
    // Return error result in expected format
    return {
      success: false,
      output: '',
      confidence: null,
      escalate: false,
      reasoning: 'CLI execution failed',
      durationMs: Date.now() - startTime,
      model,
      provider: 'codex',
      usage: null,
      errors: [error.message],
      exitCode: error.details?.exitCode || -1,
      stderr: error.details?.stderr || error.message,
      error: createFriendlyErrorMessage(error, 'codex')
    };
  }

  const durationMs = Date.now() - startTime;

  // Parse JSONL output (each line is a JSON object)
  let output = '';
  let confidence = null;
  let escalate = false;
  let reasoning = '';
  let usage = null;
  const errors = [];

  try {
    const messages = (proc.stdout || '')
      .split('\n')
      .filter(l => l.trim())
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Extract agent messages (the actual AI response)
    const agentMessages = messages
      .filter(m => m.type === 'item.completed' && m.item?.type === 'agent_message')
      .map(m => m.item.text);

    output = agentMessages.join('\n\n');

    // Get usage statistics
    const turnCompleted = messages.find(m => m.type === 'turn.completed');
    if (turnCompleted) {
      usage = turnCompleted.usage;
    }

    // Collect errors
    messages
      .filter(m => m.type === 'error' || m.type === 'turn.failed')
      .forEach(m => errors.push(m.message || m.error?.message || 'unknown error'));

    // Try to extract confidence and escalation info from the last agent message
    if (output) {
      const confidenceMatch = output.match(/"confidence":\s*([0-9.]+)/);
      const escalateMatch = output.match(/"escalate":\s*(true|false)/);
      const reasonMatch = output.match(/"reason":\s*"([^"]+)"/);

      if (confidenceMatch) confidence = parseFloat(confidenceMatch[1]);
      if (escalateMatch) escalate = escalateMatch[1] === 'true';
      if (reasonMatch) reasoning = reasonMatch[1];
    }

  } catch (err) {
    errors.push(`Parse error: ${err.message}`);
    output = proc.stdout || '';
  }

  // Parse CLI output for better error handling
  const parsedOutput = parseCliOutput(proc.stdout, proc.stderr, proc.status);

  return {
    success: parsedOutput.success && errors.length === 0,
    output: output.trim(),
    confidence,
    escalate,
    reasoning,
    durationMs,
    model,
    provider: 'codex',
    usage,
    errors,
    exitCode: proc.status,
    stderr: proc.stderr || '',
    error: (parsedOutput.success && errors.length === 0) ? null :
           createFriendlyErrorMessage({
             message: errors.length > 0 ? errors.join('; ') : parsedOutput.error,
             details: {
               errorType: parsedOutput.errorType,
               suggestions: parsedOutput.suggestions,
               isRecoverable: parsedOutput.isRecoverable
             }
           }, 'codex')
  };
}

/**
 * Build a hierarchical prompt for Codex based on tier and context
 */
export function buildCodexPrompt(tier, task, context = {}) {
  let prompt = '';

  // Enhanced prompts with manager feedback support
  switch (tier) {
    case 'worker':
      prompt = `You are a WORKER in an AI organization hierarchy. Handle this specific, simple task efficiently:

TASK: ${task}

You are the cheapest, fastest model in the org chart. Focus on:
- File lookups, grep operations, simple reads
- Quick information gathering
- Basic operations that don't require complex reasoning

Work efficiently and honestly. If the task is more complex than you can handle confidently, be honest about it.

When complete, output a summary and end with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
      break;

    case 'ic':
      // Check if this is a retry with manager feedback
      if (context.managerNotes) {
        prompt = `You are an IC (Individual Contributor) in an AI organization. You handle most implementation work:

TASK: ${task}

MANAGER FEEDBACK (from previous attempt):
═══════════════════════════════════════
${context.managerNotes}
═══════════════════════════════════════

Your manager has reviewed your previous work and wants you to address the above issues.
Focus on fixing exactly what they pointed out.

${context.attempt ? `This is attempt #${context.attempt}. Apply the manager's feedback carefully.` : ''}

Own this task completely. Edit files directly. Run tests to verify your changes.

When complete, output:
1. What you changed (files and behavior)
2. How you addressed the manager's feedback
3. Tests run and results (if applicable)
4. Remaining risks or edge cases
5. End with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
      } else {
        prompt = `You are an IC (Individual Contributor) in an AI organization. You handle most implementation work:

TASK: ${task}

You are the primary workhorse - most tasks should be completed at your level. Focus on:
- Code implementation and editing
- Refactoring and improvements
- Running tests and debugging
- Git operations and file management

Own this task completely. Edit files directly. Run tests to verify your changes.

If you encounter something requiring architectural decisions, security review, or complex debugging, escalate to your manager.

When complete, output:
1. What you changed (files and behavior)
2. Tests run and results (if applicable)
3. Remaining risks or edge cases
4. End with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
      }
      break;

    case 'manager':
      // Check if this is a manager review operation
      if (context.operation === 'review') {
        prompt = task; // task already contains the full review prompt
      } else {
        prompt = `You are a MANAGER in an AI organization. Handle high-level decisions and review complex problems:

TASK: ${task}

You handle:
- Architecture decisions
- Security reviews
- Complex debugging that requires deep reasoning
- Code reviews and quality decisions
- Escalated issues from ICs

Either solve the problem completely or provide specific guidance for your team to implement.

When complete, output your decision/solution and end with: {"confidence": 0.0-1.0, "escalate": false, "reason": "solution approach", "needs_review": false}`;
      }
      break;

    default:
      prompt = `Handle this task: ${task}

End with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
  }

  // Add context if available (skip for review operations)
  if (context.operation !== 'review') {
    if (context.files && context.files.length > 0) {
      prompt += `\n\nRelevant files:\n${context.files.map(f => `- ${f}`).join('\n')}`;
    }

    if (context.constraints && context.constraints.length > 0) {
      prompt += `\n\nConstraints:\n${context.constraints.map(c => `- ${c}`).join('\n')}`;
    }

    if (context.previous && tier === 'manager' && !context.managerNotes) {
      prompt += `\n\nPREVIOUS ATTEMPT (escalated to you):\nOutput: ${context.previous.output}\nConfidence: ${context.previous.confidence}\nEscalation reason: ${context.previous.reasoning}`;
    }
  }

  return prompt;
}