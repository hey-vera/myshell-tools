/**
 * claude.mjs — Claude CLI subprocess wrapper with robust error handling
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
 * Execute a Claude command with the specified model and prompt
 */
export async function executeClaude(claudeBin, model, prompt, options = {}) {
  const startTime = Date.now();

  const args = [
    '-p',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose'
  ];

  // Add the prompt as the final argument
  args.push(prompt);

  let proc;
  try {
    proc = await executeWithRecovery(claudeBin, args, {
      provider: 'claude',
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
      provider: 'claude',
      exitCode: error.details?.exitCode || -1,
      stderr: error.details?.stderr || error.message,
      error: createFriendlyErrorMessage(error, 'claude')
    };
  }

  const durationMs = Date.now() - startTime;

  // Parse streaming JSON output
  let output = '';
  let confidence = null;
  let escalate = false;
  let reasoning = '';

  try {
    if (proc.stdout) {
      // Claude streams JSON objects, one per line
      const lines = proc.stdout.trim().split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);

          // Look for assistant messages with content
          if (data.type === 'assistant' && data.message && data.message.content) {
            for (const content of data.message.content) {
              if (content.type === 'text' && content.text) {
                output += content.text;
              }
            }
          }
        } catch {
          // If not JSON, treat as plain text (fallback)
          output += line + '\n';
        }
      }
    }

    // Try to extract confidence and escalation info from output
    const confidenceMatch = output.match(/"confidence":\s*([0-9.]+)/);
    const escalateMatch = output.match(/"escalate":\s*(true|false)/);
    const reasonMatch = output.match(/"reason":\s*"([^"]+)"/);

    if (confidenceMatch) confidence = parseFloat(confidenceMatch[1]);
    if (escalateMatch) escalate = escalateMatch[1] === 'true';
    if (reasonMatch) reasoning = reasonMatch[1];

  } catch (err) {
    // Fallback to plain text if JSON parsing fails
    output = proc.stdout || '';
  }

  // Parse CLI output for better error handling
  const parsedOutput = parseCliOutput(proc.stdout, proc.stderr, proc.status);

  return {
    success: parsedOutput.success,
    output: output.trim(),
    confidence,
    escalate,
    reasoning,
    durationMs,
    model,
    provider: 'claude',
    exitCode: proc.status,
    stderr: proc.stderr || '',
    error: parsedOutput.success ? null : createFriendlyErrorMessage({
      message: parsedOutput.error,
      details: {
        errorType: parsedOutput.errorType,
        suggestions: parsedOutput.suggestions,
        isRecoverable: parsedOutput.isRecoverable
      }
    }, 'claude')
  };
}

/**
 * Build a hierarchical prompt for Claude based on tier and context
 */
export function buildClaudePrompt(tier, task, context = {}) {
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

End your response with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
      break;

    case 'ic':
      // Check if this is a retry with manager feedback
      if (context.managerNotes) {
        prompt = `You are an IC (Individual Contributor) in an AI organization. You handle most of the implementation work:

TASK: ${task}

MANAGER FEEDBACK (from previous attempt):
═══════════════════════════════════════
${context.managerNotes}
═══════════════════════════════════════

Your manager has reviewed your previous work and wants you to address the above issues.
Focus on fixing exactly what they pointed out.

${context.attempt ? `This is attempt #${context.attempt}. Apply the manager's feedback carefully.` : ''}

You are the primary workhorse - most tasks should be completed at your level. Focus on:
- Code implementation and editing
- Refactoring and improvements
- Running tests and debugging
- Git operations and file management

If you encounter something that needs architectural decisions, security review, or complex debugging, escalate to your manager.

End your response with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
      } else {
        prompt = `You are an IC (Individual Contributor) in an AI organization. You handle most of the implementation work:

TASK: ${task}

You are the primary workhorse - most tasks should be completed at your level. Focus on:
- Code implementation and editing
- Refactoring and improvements
- Running tests and debugging
- Git operations and file management

If you encounter something that needs architectural decisions, security review, or complex debugging, escalate to your manager.

End your response with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
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

End your response with: {"confidence": 0.0-1.0, "escalate": false, "reason": "solution approach", "needs_review": false}`;
      }
      break;

    default:
      prompt = `Handle this task: ${task}

End your response with: {"confidence": 0.0-1.0, "escalate": true|false, "reason": "brief explanation", "needs_review": true|false}`;
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
      prompt += `\n\nPREVIOUS ATTEMPT (escalated to you):\n${context.previous.output}\n\nConfidence was: ${context.previous.confidence}\nReason for escalation: ${context.previous.reasoning}`;
    }
  }

  return prompt;
}