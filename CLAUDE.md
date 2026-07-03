# myshell-tools — operating rules

## ORCHESTRATOR DISCIPLINE (read first — violating this bloats the main context)
The main Claude Code conversation is an **orchestrator only**. It must NOT do the deep work itself.
- **NEVER do inline in the main thread:** reading many files to understand a subsystem, writing/refining a plan or design doc, implementing code, doing the audit/research. All of this belongs in a spawned agent whose own context absorbs the bloat and returns only a short conclusion + a doc path.
- **The orchestrator MAY do directly:** dispatch agents, edit rules/memory/CLAUDE.md, run verification (`tsc --noEmit`, tests, name-diff), git ops, and report results. A *quick* (≤~2 files) spot-check to ground a dispatch is fine; anything more = delegate.
- **Planning/design/audit ⇒ a FRONTIER agent** (gpt-5.5 via codex, or a Claude Opus agent when challenging/diversity is wanted). **Execution ⇒ opencode-go workers.** The orchestrator never writes the plan doc itself.
- **Design before doing:** get the plan right the first time via an adversarial round (one frontier model challenges another's plan, with online research) rather than shipping a weak plan and patching it. A superior plan doc is cheaper than rework.
- Agents must write full output to a repo doc and return only a short executive summary + the path, to keep the orchestrator lean.
- Resuming a frontier session is allowed: `codex exec resume <session-id> "..." </dev/null` continues the same gpt-5.5 context (cheaper than a cold agent for a follow-up round).

## Frontier / worker model split (this project's standing policy)
- **Frontier (think / audit / plan):** `codex exec -m gpt-5.5 -c model_reasoning_effort=high` (ChatGPT-authed). Use for audits, architecture, root-causing, "what does 10/10 look like." Output = a plan/findings doc.
- **Workers (execute the plan):** `opencode run -m opencode-go/<model>` on the OpenCode **Go** sub. Cheapest capable: `deepseek-v4-flash`, `glm-5.1`. Strongest worker reasoner: `deepseek-v4-pro`, `glm-5.2`.
- **Claude `Agent` subagents:** last resort only, and only with the user's explicit permission.
- Full model catalog + the Zen-unfunded gotcha: see memory `opencode-provider-access`.

## CRITICAL: how to invoke codex / opencode from the Claude Code harness
Both `codex exec` and `opencode run` **HANG FOREVER** if stdin is left open — the harness pipes stdin (no TTY) and both block reading it even when the prompt is passed as an argument. (codex's tell: `Reading additional input from stdin...`.)

**Always invoke via the Bash tool with stdin closed and the sandbox disabled (network):**
```bash
# Frontier audit / plan (codex's OWN sandbox is broken in the Linux cloud container — see below):
codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  -C <repo-root> -m gpt-5.5 -c model_reasoning_effort=high "<prompt>" </dev/null

# Worker execution:
opencode run -m opencode-go/deepseek-v4-pro "<prompt>" </dev/null
```
- `</dev/null` is mandatory. `dangerouslyDisableSandbox: true` on the Bash call (for network).
- **ENV-AWARE:** `<repo-root>` = the actual repo dir for wherever you're running — in the Linux cloud container that's `/home/runner/workspace`; on the Windows dev box (verified 2026-07-03) both CLIs are installed (`codex`/`opencode` in `AppData\Roaming\npm`) and you invoke them through the **Bash tool** (git-bash) so the mandatory `</dev/null` still closes stdin. The bwrap-sandbox breakage below is Linux-container-only; it does not apply on Windows.
- **CODEX'S `-s` SANDBOX MODES DO NOT WORK IN THIS CONTAINER (verified 2026-06-30).** `-s read-only` / `-s workspace-write` invoke codex's internal bwrap sandbox, which fails before running anything: `bwrap: Unexpected capabilities but not setuid, old file caps config?` — it can neither read files nor write its output doc. The ONLY working invocation here is `--dangerously-bypass-approvals-and-sandbox` (codex then uses the host shell; the Bash tool is itself the security boundary). This contradicts the earlier "use `-s read-only`" guidance — reality wins. (Pass `-C <trusted-dir>` so it can write plan docs.)
- Do NOT run `Get-Process node | Stop-Process` while a codex/opencode run is in flight — it kills your own run.
- Auth is fine (codex=ChatGPT, opencode=Zen+Go). If a run hangs, it's stdin, not auth — don't re-debug auth.

Details + verification log: memory `opencode-codex-cli-stdin-hang`.
