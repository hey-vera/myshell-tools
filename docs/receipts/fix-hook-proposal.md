# FIX #2 Hook Proposal: Allow Authorized Claude Subagents, Still Block Main Thread

Date: 2026-07-05

## Scope

This is a read-only investigation of `.claude/hooks/block-main-thread-code-edits.mjs` and Claude Code's documented `PreToolUse` hook payload.

Primary question: can the hook reliably distinguish a Claude subagent tool call from a main-thread tool call, so it can keep the orchestrator bright line while allowing explicitly authorized Claude Agent workers to edit `src/` and `test/`?

## Current Hook: Exact Behavior

Relevant files:

- Hook: `.claude/hooks/block-main-thread-code-edits.mjs:1-33`
- Hook wiring: `.claude/settings.json:9-22`
- Local policy: `CLAUDE.md:19`, `CLAUDE.md:41`, `CLAUDE.md:84`

What the hook currently does:

1. It is only invoked for `Edit|Write` because `.claude/settings.json` registers it under a `PreToolUse` matcher of `Edit|Write`.
2. It reads stdin as a JSON string and parses it.
3. It reads exactly one field from the parsed JSON payload: `input.tool_input.file_path`.
4. It normalizes backslashes to forward slashes.
5. It denies the tool call if the normalized path matches `/(^|\/)(src|test)\//i`.
6. On deny, it prints a `PreToolUse` permission decision JSON object to stdout.
7. On JSON parse failure, it does nothing and exits silently. That is fail-open behavior.

JSON fields the current hook actually reads:

- `tool_input.file_path`

JSON fields present in stdin that the current hook does not read:

- It does not inspect `tool_name`, `session_id`, `transcript_path`, `cwd`, `permission_mode`, `agent_id`, `agent_type`, or any environment variables.

Operational consequences of the current implementation:

- It blocks all `Edit`/`Write` attempts under `src/` or `test/`, regardless of whether the caller is the orchestrator main thread or a Claude subagent.
- It does not distinguish top-level `--agent` sessions from subagents.
- It does not authorize any Claude Agent worker tier, even when local policy allows that execution route.

## Claude Code `PreToolUse` Input Schema: What Matters Here

Official docs consulted on 2026-07-05:

- Hooks reference: https://code.claude.com/docs/en/hooks
- Hooks guide: https://code.claude.com/docs/en/hooks-guide

The hooks reference documents these common stdin fields for hook events:

- `session_id`
- `prompt_id`
- `transcript_path`
- `cwd`
- `permission_mode`
- `effort`
- `hook_event_name`

For `PreToolUse`, the payload also includes:

- `tool_name`
- `tool_input`

Critically, the docs also state:

- `agent_id`: present only when the hook fires inside a subagent call. The docs explicitly say to use this to distinguish subagent hook calls from main-thread calls.
- `agent_type`: present when the session uses `--agent` or when the hook fires inside a subagent. For subagents, it is the subagent's type/name.

That means:

- `agent_id` is the reliable subagent-vs-main-thread discriminator.
- `agent_type` is not a reliable discriminator by itself, because it can also appear on a top-level `--agent` session.
- `session_id`, `transcript_path`, `cwd`, and `permission_mode` are not documented as subagent-only signals.
- No documented subagent-specific environment variable was found for command hooks. The docs only say hook commands inherit the parent process environment.

## Reliability Assessment

Yes: `agent_id`.

Why it is reliable:

- The official hooks reference says it is present only when the hook fires inside a subagent call.
- The same docs explicitly say to use it to distinguish subagent hook calls from main-thread calls.

Why the other obvious candidates are not reliable:

- `agent_type`: not reliable alone, because top-level `--agent` also sets it.
- `session_id`: common field, not documented as changing for subagents.
- `transcript_path`: common field, not documented as unique per subagent.
- `cwd`: common field, not documented as unique per subagent.
- Env vars: no documented subagent marker.

Conclusion:

- A hook-only fix is technically possible.
- The correct design is not "allow when `agent_type` exists".
- The correct design is "allow only when `agent_id` exists and `agent_type` is explicitly allowlisted".

## Recommendation A

Use `agent_id` as the subagent discriminator and pair it with an explicit `agent_type` allowlist. That preserves the bright line and fails closed when the caller is uncertain or unauthorized.

### Why this is the right shape

- `agent_id` answers "is this a subagent?"
- `agent_type` answers "which subagent is it?"
- Combining them lets the hook:
  - deny the main thread
  - deny top-level `--agent` sessions
  - deny unknown or unauthorized subagents
  - allow only named, authorized subagents

### Proposed exact diff

This diff does not modify the matcher in `.claude/settings.json`. It only changes the hook logic.

```diff
diff --git a/.claude/hooks/block-main-thread-code-edits.mjs b/.claude/hooks/block-main-thread-code-edits.mjs
--- a/.claude/hooks/block-main-thread-code-edits.mjs
+++ b/.claude/hooks/block-main-thread-code-edits.mjs
@@
 // Fails open: any parse error stays silent so it can never wedge the session.
 // Note: opencode/codex workers run as separate processes outside this tool
 // path, so they are unaffected.
 
+const AUTHORIZED_SRC_EDIT_SUBAGENT_TYPES = new Set(
+  String(process.env.MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES || '')
+    .split(',')
+    .map((value) => value.trim())
+    .filter(Boolean),
+);
+
 let data = '';
 process.stdin.on('data', (chunk) => (data += chunk));
 process.stdin.on('end', () => {
   try {
     const input = JSON.parse(data || '{}');
     const raw = (input.tool_input && input.tool_input.file_path) || '';
     const norm = String(raw).replace(/\\/g, '/');
-    if (/(^|\/)(src|test)\//i.test(norm)) {
+    const agentId =
+      typeof input.agent_id === 'string' ? input.agent_id.trim() : '';
+    const agentType =
+      typeof input.agent_type === 'string' ? input.agent_type.trim() : '';
+    const isProtectedPath = /(^|\/)(src|test)\//i.test(norm);
+    const isSubagentCall = agentId !== '';
+    const isAuthorizedSubagent =
+      isSubagentCall &&
+      agentType !== '' &&
+      AUTHORIZED_SRC_EDIT_SUBAGENT_TYPES.has(agentType);
+
+    if (isProtectedPath && !isAuthorizedSubagent) {
+      const reason = !isSubagentCall
+        ? 'BRIGHT LINE (orchestrator discipline): the main Claude thread must not Edit/Write files under src/ or test/. Dispatch an authorized worker instead.'
+        : `BRIGHT LINE: subagent "${agentType || '<unknown>'}" is not authorized to Edit/Write files under src/ or test/.`;
       process.stdout.write(
         JSON.stringify({
           hookSpecificOutput: {
             hookEventName: 'PreToolUse',
             permissionDecision: 'deny',
-            permissionDecisionReason:
-              'BRIGHT LINE (orchestrator discipline): the main Claude thread must not Edit/Write files under src/ or test/. Dispatch an opencode-go worker to make the code change instead (gpt-5.5 plans, opencode executes).',
+            permissionDecisionReason: reason,
           },
         }),
       );
     }
   } catch {
     // fail open — never block on a malformed payload
   }
 });
```

### Notes on the proposed diff

- It is fail-closed for authorization:
  - no `agent_id` -> deny
  - `agent_id` present but no `agent_type` -> deny
  - `agent_id` present but `agent_type` not allowlisted -> deny
  - only `agent_id` + allowlisted `agent_type` -> allow
- It still preserves the current "malformed JSON does not wedge the session" behavior.
- It uses an env var for the allowlist because this repo does not currently define a stable in-repo list of authorized Claude subagent names.

### Required env contract for Recommendation A

Set this only in the environment where you intentionally want specific Claude subagent types to be able to edit `src/`/`test/`:

```text
MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES=agent-type-1,agent-type-2
```

If you prefer hardcoded policy, replace the env-backed set with a literal set in the hook.

### Test JSON: main thread should deny

```json
{
  "session_id": "sess-main",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/tmp/transcript.jsonl",
  "cwd": "/repo",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "src/core/orchestrate.ts"
  }
}
```

Expected result:

- Deny, because `agent_id` is absent.

### Test JSON: authorized subagent should allow

Assume:

```text
MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES=code-worker
```

Payload:

```json
{
  "session_id": "sess-main",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/tmp/transcript.jsonl",
  "cwd": "/repo",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "agent_id": "subagent-123",
  "agent_type": "code-worker",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "test/unit/example.test.ts"
  }
}
```

Expected result:

- Allow, because `agent_id` proves this is a subagent call and `agent_type` is explicitly authorized.

### Test JSON: unauthorized subagent should deny

Assume:

```text
MYSHELL_ALLOWED_SRC_EDIT_AGENT_TYPES=code-worker
```

Payload:

```json
{
  "session_id": "sess-main",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/tmp/transcript.jsonl",
  "cwd": "/repo",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "agent_id": "subagent-456",
  "agent_type": "Explore",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "src/cli.ts"
  }
}
```

Expected result:

- Deny, because this is a subagent but not an authorized one.

## Recommendation B

Not the primary recommendation, because a reliable hook-input signal does exist.

If you cannot depend on `agent_id` being present in the Claude Code version you actually run, then the next safest fallback is a coarse env gate that disables the block only for a deliberately prepared delegation environment. That is weaker than Recommendation A because it authorizes by ambient process state rather than by the actual hook payload.

Exact diff for that weaker fallback:

```diff
diff --git a/.claude/hooks/block-main-thread-code-edits.mjs b/.claude/hooks/block-main-thread-code-edits.mjs
--- a/.claude/hooks/block-main-thread-code-edits.mjs
+++ b/.claude/hooks/block-main-thread-code-edits.mjs
@@
 let data = '';
 process.stdin.on('data', (chunk) => (data += chunk));
 process.stdin.on('end', () => {
   try {
     const input = JSON.parse(data || '{}');
     const raw = (input.tool_input && input.tool_input.file_path) || '';
     const norm = String(raw).replace(/\\/g, '/');
-    if (/(^|\/)(src|test)\//i.test(norm)) {
+    const allowAgentSrcEdits =
+      String(process.env.MYSHELL_ALLOW_AGENT_SRC_EDITS || '') === '1';
+    if (/(^|\/)(src|test)\//i.test(norm) && !allowAgentSrcEdits) {
       process.stdout.write(
         JSON.stringify({
           hookSpecificOutput: {
             hookEventName: 'PreToolUse',
             permissionDecision: 'deny',
@@
```

This fallback is operationally simple, but it cannot prove the caller is a subagent. It only proves that the surrounding shell chose to disable the guard.

## One-Line Recommendation

Safest and best: implement Recommendation A using `agent_id` as the subagent-only discriminator and an explicit `agent_type` allowlist; use Recommendation B only if your installed Claude Code build does not actually supply `agent_id` in `PreToolUse`.
