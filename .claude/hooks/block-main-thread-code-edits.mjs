// PreToolUse hook — enforces the orchestrator "bright line".
//
// The main Claude Code thread is an ORCHESTRATOR ONLY. It must never edit
// production code directly; code changes go to a worker. This hook DENIES
// Edit/Write whenever the target file_path is under src/ or test/ — UNLESS the
// caller is an explicitly-authorized Claude Agent subagent.
//
// Subagent discrimination: Claude Code's PreToolUse payload includes `agent_id`
// ONLY when the hook fires inside a subagent call (per the hooks docs), so it is
// the reliable "is this a subagent?" signal. `agent_type` names WHICH subagent.
// We allow src/test edits only when BOTH: (a) agent_id is present (a real
// subagent, not the main thread or a top-level --agent session), AND (b)
// agent_type is in the MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES allowlist. Fails
// CLOSED: if uncertain, block.
//
// Fails open on parse error: a malformed payload stays silent so it can never
// wedge the session. opencode/codex workers run as separate processes outside
// this tool path, so they are unaffected either way.

const AUTHORIZED_SRC_EDIT_SUBAGENT_TYPES = new Set(
  String(process.env.MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

let data = '';
process.stdin.on('data', (chunk) => (data += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data || '{}');
    const raw = (input.tool_input && input.tool_input.file_path) || '';
    const norm = String(raw).replace(/\\/g, '/');
    const agentId = typeof input.agent_id === 'string' ? input.agent_id.trim() : '';
    const agentType = typeof input.agent_type === 'string' ? input.agent_type.trim() : '';
    const isProtectedPath = /(^|\/)(src|test)\//i.test(norm);
    const isSubagentCall = agentId !== '';
    const isAuthorizedSubagent =
      isSubagentCall && agentType !== '' && AUTHORIZED_SRC_EDIT_SUBAGENT_TYPES.has(agentType);

    if (isProtectedPath && !isAuthorizedSubagent) {
      const reason = !isSubagentCall
        ? 'BRIGHT LINE (orchestrator discipline): the main Claude thread must not Edit/Write files under src/ or test/. Dispatch an authorized worker instead.'
        : `BRIGHT LINE: subagent "${agentType || '<unknown>'}" is not authorized to Edit/Write files under src/ or test/ (set its type in MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES to allow).`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
      );
    }
  } catch {
    // fail open — never block on a malformed payload
  }
});
