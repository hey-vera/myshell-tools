# myshell-tools — Go-Live Plan (flags ON, external-user ready)

**Goal:** the frictionless "one chat to rule them all" — Auto on by default, coherent, clean, and
genuinely ready for real external users. End state = flags **on by default**, not dark.

**Honest gate (from `docs/direction-audit.md`):** "external-ready" ≠ "all 25 `experimental*` flags
on." Flipping everything at once is the *riskiest* move because of three real blockers — two
competing decision brains, a stubbed Auto Layer B, and no cost/trust surface. The sequence below
turns the product on while staying coherent. Each step ships green; the destination is on-by-default.

---

## Step 0 — Dogfood baseline (immediate, ~0 build)
Flip `AUTO_BRAIN + LEVEL_DIAL + DRAFT_GOALS` on **for our own config** and live in it. Fastest way to
falsify the vision and capture real friction. (Audit's #1 recommendation.) Not external yet — this is
the feedback loop that's been missing for 123 commits.

## Step 1 — Resolve the two-brain conflict (BLOCKER for everything)
`governor.ts` vs `auto-brain.ts`/`fuseRung` are both per-turn decision systems. Decide the single
brain before anything goes on by default. **Recommendation (audit-backed): `auto-brain` is THE brain;**
demote `governor` to an input (budget/capacity signal) or remove it; demote `tribunal.ts`+`verify.ts`
to a verification *depth* Auto reaches for, not a standalone subsystem. Output: one coherent decision
path, no competing routers. Needs a focused architecture pass (not a blind flag flip).

## Step 2 — Finish Auto Layer B (the differentiating half)
Build objective-evidence escalation (`auto-brain.ts:492-540` is currently a STUB): triggers = failed
test/typecheck/lint, scope growth, explicit pushback, stall — **never** model self-confidence.
Hysteresis (clear a margin to move), bounded by `policy.maxAttempts`, de-escalate on sustained clean
runs. The receipt cites the objective signal. This is what makes "Auto" actually auto.

## Step 3 — In-chat cost receipt (trust requirement)
Per-turn one-line receipt in the chat: chosen rung · effort · verify depth · ~tokens/cost. Wire the
existing `ledger.ts` to a live surface (today `cost.ts` is out-of-band). Non-negotiable for external
users to trust the spend.

## Step 4 — Frictionless UX pass
Neat one-line goal section (kill the chunky block), clean hierarchical board, draft-goal confirm gate
that feels effortless. Ghost-text autocomplete is a later add, not a launch blocker.

## Step 5 — Flip the coherent stack ON by default (the integration test)
Promote the resolved, finished stack to default-on in one controlled step. Full green: typecheck,
lint, knip, arch guards, tests. Fix flag-interaction bugs. This is the moment the product changes for
real users.

## Step 6 — External-readiness gate
Windows test-suite green (cred 0o600 / symlink / path-separator fixes), honest failure messages
("here's exactly what happened"), basic cost guardrails. Only after this is it real-external-user ready.

---

**Reality check:** Steps 1–6 are days of focused work, not one session — but every step is shippable
and moves the *real* product forward instead of adding more dark substrate. The next commit is either
Step 0 (dogfood-on) or Step 1 (pick the brain), not a new module.
