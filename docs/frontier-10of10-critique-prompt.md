# Frontier "True 10/10" Critique + Plan Prompt

Reusable prompt for the **frontier tier** (per `opencode-plan-execute-tiering`). Fire it with a
strong model so it thinks once, hard, and leaves a plan doc the worker tier executes.

**How to run** (from repo root):
```bash
opencode run -m opencode/claude-opus-4-8 "$(cat docs/frontier-10of10-critique-prompt.md)"
# or a second opinion for diversity:
opencode run -m opencode/gpt-5.5 "$(cat docs/frontier-10of10-critique-prompt.md)"
```

---

## PROMPT (everything below this line is the message)

You are a frontier-tier architect-critic for the **myshell-tools** project. Your job is NOT to write
feature code. Your job is to THINK HARD ONCE and leave behind a single, brutally honest plan document
that a cheaper "worker" model tier can then execute slice-by-slice.

### Ground rules
- **Brutal honesty over politeness.** No flattery, no hedging, no "great work so far." If the vision is
  wrong, the architecture is over-engineered, or a decision is a dead end, say so plainly and say why.
- **Evidence, not vibes.** Back every major claim with a specific file/line or an external source.
- **Challenge the premises**, including ones treated as locked. If "Auto mode", "byproduct intent",
  "one chat to rule them all", or the 5-level dial are the wrong abstractions, argue it.
- **Anti-loop:** if a command/tool is blocked or unavailable, stop after ≤2 attempts and note it in the
  doc — never loop or burn tokens retrying.

### What to read first (in this order, don't dump them back to me)
1. `docs/HANDOFF.md` — current state, merged PRs, the OpenCode rules, the known critical gap.
2. `docs/one-chat-redesign-plan.md` — design source of truth + locked decisions.
3. `docs/auto-mode-design.md` — Auto architecture rationale.
4. Skim the real code to verify the docs match reality: `src/core/auto-brain.ts`,
   `src/core/mode-levels.ts`, `src/core/intent.ts`, `src/core/draft-goal.ts`,
   `src/interface/menu.ts`, `src/core/types.ts`, `src/providers/detect.ts`.
   Note every place the docs and the code disagree.

### External research (do it, cite it)
- How the best-in-class shells/agents actually handle: single-chat context that never bloats,
  intent routing without a separate classifier call, just-in-time task decomposition, ghost-text
  autocomplete, and multi-model cost routing. Compare our approach to Claude Code, Cursor, Codex,
  Aider, Warp, etc. Be specific about what they do better and what we'd be foolish to copy.

### Deliverable — write this file: `docs/10of10-plan.md`
Structure it exactly:
1. **What "true 10/10" means for THIS product** — a concrete, testable definition. Not adjectives;
   observable behaviors a user would feel. Include 5–10 acceptance criteria.
2. **Honest scorecard** — where we actually are vs that bar, per dimension (context architecture,
   intent/routing, goal-completion, UX surfaces, cost efficiency, reliability/Windows health).
   Give each a score /10 with one-line justification + file evidence.
3. **The gap** — the 5–8 things that most stand between us and 10/10, ranked by leverage
   (impact ÷ effort). For each: what's wrong now, what 10/10 looks like, rough size.
4. **What to KILL** — over-engineering, dead flags, abstractions that aren't earning their weight.
5. **Sequenced plan** — an ordered backlog of worker-sized slices (each: goal, files likely touched,
   default-off flag name, "done" test, est. size). This is the contract the worker tier executes from.
6. **Open questions for the user** — anything genuinely ambiguous that needs a human decision.

Keep it tight and skimmable. Tables over prose where it helps. End with the single highest-leverage
next slice, named explicitly.
