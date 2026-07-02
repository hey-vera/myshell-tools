// PreToolUse hook — enforces the orchestrator "bright line".
//
// The main Claude Code thread is an ORCHESTRATOR ONLY. It must never edit
// production code directly; code changes go to an opencode-go worker. This hook
// DENIES Edit/Write whenever the target file_path is under src/ or test/.
//
// Fails open: any parse error stays silent so it can never wedge the session.
// Note: opencode/codex workers run as separate processes outside this tool
// path, so they are unaffected.

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data || '{}');
    const raw = (input.tool_input && input.tool_input.file_path) || '';
    const norm = String(raw).replace(/\\/g, '/');
    if (/(^|\/)(src|test)\//i.test(norm)) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'BRIGHT LINE (orchestrator discipline): the main Claude thread must not Edit/Write files under src/ or test/. Dispatch an opencode-go worker to make the code change instead (gpt-5.5 plans, opencode executes).',
          },
        }),
      );
    }
  } catch {
    // fail open — never block on a malformed payload
  }
});
