# Direction Audit — myshell-tools

> Directional, not a backlog. One question: **is myshell-tools going in the right direction
> relative to its own "one chat to rule them all" vision, or has it drifted into building the
> wrong thing?** Verified on `docs/commit-auto-mode-design` = `origin/main` + 1 docs commit
> (`git rev-list --left-right --count origin/main...HEAD` → `0  1`). Claims are file-referenced.

## 1. One-line verdict

**Right vision, wrong execution.** The north star is sound and unusually well-reasoned
(`docs/auto-mode-design.md` is a genuinely strong piece of product thinking). The *execution* has
drifted into a substrate-building loop that, after 123 redesign-adjacent commits, leaves the
**shipped** product (all flags off) byte-for-byte a plain chat. The risk is not a bad idea — it is
**never proving the idea against reality**.

## 2. What the vision actually demands (the non-negotiables)

These are the few things that, if missing, mean the vision failed — independent of how much code exists:

1. **A single chat where the user never picks a model and never feels it.** Intent + routing are a
   free byproduct of the paid turn (no router call). — `IntentFrame.routeTier/routePlan/operationRisk`
   in `src/core/intent.ts:45-90`; emitted in the same prompt via `buildIntentPrompt` (`intent.ts:361`).
2. **Auto predicts-and-commits the rung once, escalates only on objective evidence.** Layer A
   (`fuseRung`, `src/core/auto-brain.ts:328`) + Layer B (`shouldEscalate`/`shouldDeEscalate`, `:543/:586`).
3. **Build requests draft *inactive* goals; confirm before spend; JIT decomposition.**
   `src/core/draft-goal.ts`, wired in `src/interface/menu.ts`.
4. **Provider-agnostic, works on a 1-model setup** (effort becomes the lever). `src/core/roles.ts`,
   `src/core/mode-levels.ts`, `adaptForSingleModel` (`auto-brain.ts:627`).
5. **Quota saved by think-once + cache + gate + decompose, never by dumber models.**
6. **The user can SEE it isn't burning quota** (trust/legibility) — receipts + live spend.
7. **One 5-level dial spanning vibe-coder → senior-dev.** `Level` in `src/core/mode-levels.ts`.

The honest test of "right direction": **how many of these does the user actually experience today?**
Answer: **roughly zero**, because every one of them is behind a default-OFF flag (§3).

## 3. Where reality SERVES vs BETRAYS the vision

| Area | Verdict | Evidence |
|---|---|---|
| Byproduct intent (no router call) | **SERVES** | `intent.ts:45-90,361` — intent/route/risk in one paid call. The architectural keystone is real and correct. |
| Auto Layer A fusion | **SERVES** (better than prior audit claimed) | `fuseRung` `auto-brain.ts:328` is now **consumed live inside `orchestrate.ts:898-918`** and overrides the routed tier at `:1808` — not "menu-only." When the flag is on, Auto genuinely drives routing. |
| 1-model degradation designed-in | **SERVES** | `adaptForSingleModel` `auto-brain.ts:627`; role collapse spec'd + tested. The hardest "any provider" case is treated as first-class, not an afterthought. |
| Pure, tested, flag-disciplined substrate | **SERVES** (engineering) | 209 test files; off-guarantee spreads (`orchestrate.ts:887-893`); rollback kill-switch. This is high-quality plumbing. |
| **Everything dark by default** | **BETRAYS** | 25+ `experimental*` flags (`config.ts:219-555`), all default-OFF incl. `AUTO_BRAIN/LEVEL_DIAL/DRAFT_GOALS/GOVERNOR/VERIFY/TRIBUNAL/MANAGER`. Shipped UX = unchanged chat. The vision is **unfalsified**. |
| Layer B (objective-evidence escalation) | **BETRAYS** (the spine's other half) | `auto-brain.ts:492-540` — "STUBBED — specced, not yet wired." Predict-and-commit without evidence-escalation is half the thesis. The *differentiating* half is missing. |
| Live in-chat cost meter | **BETRAYS** | No per-turn spend surface in `menu.ts`; ledger is read only for taste/routing memory (`menu.ts:121,1281`). `src/commands/cost.ts` is an out-of-band report. Non-negotiable #6 unmet. |
| Two overlapping architectures | **BETRAYS** | v9 (`governor.ts` 886 / `tribunal.ts` 799 / `flagship.ts` / `verify.ts`) **and** v-redesign (`auto-brain.ts` / `draft-goal.ts` / `mode-levels.ts`) both landed, both flagged off. Convergence is asserted in docs, not in code. |
| `menu.ts` = **7,037 lines** | **BETRAYS** | The "lean orchestrator = deterministic plumbing" principle (`one-chat-redesign-plan.md:25`) is contradicted by a 7k-line UI/wiring monolith where all the new seams are hand-spread. This is where integration debt is accreting. |

## 4. The biggest strategic wrong-turn / risk

**Flag-gated perfectionism is now the product's primary failure mode.** The "byte-identical when
off" discipline (`orchestrate.ts:887-893`) is excellent for safety and *fatal* for learning. It
guarantees neutrality by guaranteeing the vision is never road-tested. Consequence:

- 123 commits of substrate; the user's experience is unchanged. There is **no feedback loop** telling
  the team whether byproduct routing, Auto rung-fusion, or draft-goals actually feel like "magic" or
  like noise — because nobody has lived in them.
- Two full architectures were built before either was proven against a user. That is sprawl
  *caused by* the dark-default habit: with no integration forcing function, every good idea gets its
  own pure module and flag instead of being reconciled.
- The eval harness exists (`core/eval/`) but Layer B's hysteresis constants are explicitly
  "tune on the eval harness" (`auto-brain.ts:526-530`) — i.e. the part that needs real data is
  deferred precisely because real data isn't flowing.

This is the classic trap: **building the substrate forever, never the product.** The code quality is
not the risk. The risk is that "always green, always off" becomes a way to avoid the one hard,
scary, irreversible act — turning it on for yourself and finding out it isn't magic yet.

## 5. Architecture KEEP / COURSE-CORRECT / KILL

| Component | Call | Why |
|---|---|---|
| `intent.ts` byproduct frame | **KEEP** | The keystone. Everything correct hangs off it. |
| `auto-brain.ts` (Layer A + B) | **KEEP & FINISH** | Right primitive (predict-and-commit), already orchestrate-wired. Finishing Layer B is the highest-leverage work in the repo. |
| `roles.ts` / `mode-levels.ts` | **KEEP** | Clean, pure, the provider-agnostic + 5-level dial substrate. Needs *consumption*, not more building. |
| `draft-goal.ts` | **KEEP** | Directly serves "talk → plan you approve appears." |
| **`governor.ts` (886 lines)** | **COURSE-CORRECT toward KILL** | An 886-line policy engine is the antithesis of "the user never thinks about models." If `fuseRung` is the per-turn decision (and it is), most of Governor is a second brain competing with it. Pick one. Auto-brain should win. |
| `tribunal.ts` (799) + `verify.ts` | **COURSE-CORRECT** | Cross-vendor deliberation is justified ONLY on high/critical turns (`auto-mode-design.md:251-257`). As a default-off 1,200-line subsystem it reads as over-engineering. Demote to a *verification depth* that Auto reaches for — not a standalone architecture. |
| `menu.ts` (7,037 lines) | **COURSE-CORRECT (urgent)** | Violates the lean-orchestrator principle. The new seams should move into a thin composition root; the monolith is where the two architectures secretly fight. |
| Dark-by-default for the *core spine* | **KILL (for the spine only)** | Keep flags for Tribunal/Governor/panels. The spine — byproduct → Auto Layer A/B → draft-goals → receipt — must be turned **ON by default for the author** to generate the missing feedback. |

## 6. The single most important decision — stated as a choice

**Turn the spine ON for yourself, or keep shipping dark substrate.**

> **Option A (recommended): Dogfood the spine.** Promote `AUTO_BRAIN + LEVEL_DIAL + DRAFT_GOALS` to
> default-on *for the author's own daily use*, **finish Layer B** (`auto-brain.ts` stub → live
> escalation), and **add the per-turn cost receipt to the chat** (non-negotiable #6). Accept that it
> will feel rough. The point is the feedback loop, not perfection. This is the only path that
> converts "right vision" into "right direction."

> **Option B: Keep the discipline, lose the proof.** Continue building pure, green, flagged-off
> modules. Each ships safely; none ships *value*; the two architectures keep diverging; the vision
> stays unfalsified indefinitely.

A senior skeptic's blunt framing: *"You have written the smartest router design I've read and zero
users have felt it. The next commit should not be a new module — it should be you, using your own
product with the flags on, and writing down what hurt."*

— Stop building the substrate. Start living in it.
