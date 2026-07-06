# Partner Posture and User Memory Design 5.5

> # ⚠️ SUPERSEDED — READ THIS FIRST (binding)
>
> This is the **baseline** doc. Two halves of it are **superseded** and MUST NOT be
> implemented as written:
>
> 1. **The MEMORY sections (Theme 2: "User Memory", Storage Design, Retrieval/Injection,
>    Privacy/Safety, Control Envelope) are SUPERSEDED by
>    [`docs/memory-architecture-5.5.md`](./memory-architecture-5.5.md) (v1.2, RC-1..RC-6 folded
>    in).** Do **NOT** implement the schema (`confidence:'user_confirmed'`, `MemorySource`,
>    `memory:'on'|'off'`, free-text `subject`), the project-key derivation (cwd-basename), the
>    retrieval algorithm (the ≤5-prefs/≤8-project/12-cap shape — the cap math is broken, fixed
>    by RC-3), or the cap math below. The memory doc replaces ALL of it: trust tiers, closed
>    subject enum (RC-1), `(scope,kind,subject)` contradiction (RC-2), score-then-fill retrieval
>    (RC-3), whole-transaction lock + multi-field secret scrub (RC-4), decay-exemption (RC-5),
>    instruction-shape reject (RC-6), git-toplevel project keys.
> 2. **`partnerStyle` as a FIXED MODE is SUPERSEDED by
>    [`docs/adaptive-partner-engine-5.5.md`](./adaptive-partner-engine-5.5.md) (APE).**
>    `partnerStyle ∈ {direct,balanced,collaborative}` is **no longer a hard posture mode**; it
>    becomes a single **soft `engagementBias ∈ {-1,0,+1}`** that shifts the thresholds of APE's
>    per-turn adaptive `planEngagement` policy. The `/style` command and Settings row are kept
>    verbatim but now set the bias, not a mode.
>
> **What is STILL LIVE in this doc** (and folded into the master plan): the persona rewrite
> (domain-agnostic base + tier addenda), the `ASKING THE USER` "genuine fork" rewrite, the
> `BuildPromptOptions` extension shape (extended ONCE in Phase 2), the substantial-vs-small
> heuristic prose, the `remember_user`-inside-the-confidence-envelope wiring decision (the
> mechanism survives; the memory *schema/governance* it writes to is the memory doc's), and the
> `deriveInitialVision`/work-contract seeding idea (now realized via intent `seedFromIntent` +
> APE `seedFromIntentAndPlan`). The single source of truth for build order is
> [`docs/MASTER-PLAN-5.5.md`](./MASTER-PLAN-5.5.md).

Scope: design and investigation only. This document covers the chat intelligence/behavior layer for myshell-tools, an external end-user CLI that wraps Claude, Codex, and opencode for any kind of work. The design is domain-agnostic: coding, writing, research, operations, planning, personal workflows, and mixed work should all fit.

## Current State

### Prompt and Partner Behavior

- `src/core/prompt.ts:34-89`, `src/core/prompt.ts:91-160`, and `src/core/prompt.ts:162-228` define separate worker, IC, and manager personas. They already say "partner, not a robot" and "warmth is not length", but the behavioral loop is still generic and engineering-biased.
- `src/core/prompt.ts:50-61`, `src/core/prompt.ts:113-124`, and `src/core/prompt.ts:188-199` tell the model to ask when a request is "genuinely ambiguous" and to recommend a decision when possible.
- The structured question instruction is too timid: `src/core/prompt.ts:74-81`, `src/core/prompt.ts:144-151`, and `src/core/prompt.ts:213-220` say to use `ask_user` "Only when you genuinely cannot proceed without a user decision." This makes the model avoid asking at real forks until it is already acting on weak assumptions.
- `src/core/prompt.ts:281-300` builds a prompt from tier system text, optional compact history, the raw task, and optional reviewer feedback. There is no explicit slot for user preferences, selected memories, or an interaction-posture policy.
- Output verbosity is a TUI rendering choice, not a model behavior choice. `src/infra/config.ts:61-68` documents `verbosity` as affecting what the TUI prints, "never what the model is asked to do."
- The current persona is coding-centric. Worker says it handles "codebases" and "current project" at `src/core/prompt.ts:35-41`; IC says it implements/refactors/debugs code at `src/core/prompt.ts:91-100`; manager says staff-engineer reviewer/architect at `src/core/prompt.ts:162-170`. That is mismatched for a general-purpose user CLI.

### Structured Questions

- `src/core/questions.ts:1-26` documents the `ask_user` block as a trailing JSON object, and repeats the "ONLY when it genuinely cannot proceed" framing at `src/core/questions.ts:4-6`.
- The parser validates a bounded schema: 1-4 questions, 2-4 options each at `src/core/questions.ts:35-39`, parses question fields at `src/core/questions.ts:66-98`, and returns `QuestionSet | null` at `src/core/questions.ts:120-154`.
- `src/core/questions.ts:192-206` formats answers back into deterministic text such as `Answers: framework = vitest; coverage = yes`.
- The menu already renders `ask_user` as a selector and loops follow-up answers. `src/interface/menu.ts:2267-2319` renders options and free text, and `src/interface/menu.ts:2675-2720` resubmits up to three consecutive question turns.
- `src/interface/render.ts:127-141` strips `ask_user` from display, and `src/interface/render.ts:636-644` suppresses a misleading success line when a turn ends in questions.

### Work Contracts

- `src/core/work-contract.ts:33-40` already has `WorkContract` with `objective`, optional `vision`, roadmap, checkpoints, and verification.
- `src/core/work-contract.ts:84-170` caps contract fields defensively. `vision` is capped at 240 chars via `VISION_LIMIT` at `src/core/work-contract.ts:47`.
- `src/core/work-contract.ts:172-196` renders `OBJECTIVE`, `VISION`, `ROADMAP`, and recent steps for prompts.
- `src/core/orchestrate.ts:265-280` creates a minimal work trace for plan-like tasks or consumes an incoming contract, but it does not ask the model to capture/reflect the user's vision before acting.
- In `/goal`, `src/interface/menu.ts:2728-2736` creates `capContract({ version: 1, objective: goalText })`, but no vision is captured. The contract is more anti-drift trace than front-door understanding.

### Config and Modes

- `src/infra/config.ts:18-104` defines persisted `AppConfig`. It includes `mode`, `verbosity`, `smartRoute`, `learnRouting`, `autoGoal`, and other execution controls, but no preference for how much upfront discussion the user wants.
- `src/core/policy.ts:11-51` defines `DEFAULT_POLICY` and `src/core/policy.ts:235-280` defines presets. These control routing strength, escalation, review, and attempts. They should not directly stand for interaction style.
- The settings UI at `src/interface/menu.ts:1640-1695` exposes mode, output detail, smart routing, learned routing, panel, hedge, and auto-goal. There is no partner/autonomy posture setting.

### Persistence

- `src/infra/state-dir.ts:41-60` provides the important state-home seam: Replit uses the workspace/cwd so state survives restarts; elsewhere it uses the user's home dir.
- `src/infra/config.ts:120-163` persists config under `<stateHome>/.myshell-tools/config.json`.
- `src/infra/conversation-store.ts:1-12` defines conversations as global, persistent message logs.
- `src/infra/conversations.ts:4-9` stores conversations under `<stateHome>/.myshell-tools/conversations/` with an index plus per-conversation JSONL logs. `src/infra/conversations.ts:225-233` uses `defaultStateHome()`.
- `src/core/routing-memory.ts:1-29` is not user-fact memory. It is a local outcome learner for provider routing, based only on ledger success and duration.

## Design Goals

1. Make Vera behave like a real partner on substantial tasks:
   - understand the user's intent, vision, and constraints;
   - inspect relevant context before acting when context exists;
   - reflect the big picture briefly;
   - validate the vision or challenge it when reality conflicts;
   - ask crisp multiple-choice questions at genuine forks;
   - execute without turning small tasks into ceremonies.
2. Make this preference-aware:
   - some users want "just do it";
   - some want a short partner alignment pass;
   - some want discussion before execution.
3. Add durable user memory without junk:
   - remember stable, useful facts and preferences;
   - never store secrets, one-off task details, or transient chatter;
   - make memory transparent and controllable;
   - keep prompt injection small and relevant.

## Theme 1: Vision-First Partner Posture

> **⚠️ PARTIALLY SUPERSEDED.** The persona rewrite, `ASKING THE USER` rewrite,
> `BuildPromptOptions` extension, and vision/work-contract seeding below are **LIVE**. But
> `partnerStyle` as a **fixed three-way mode** is **superseded by
> [`docs/adaptive-partner-engine-5.5.md`](./adaptive-partner-engine-5.5.md)**: it becomes a
> soft `engagementBias ∈ {-1,0,+1}` that shifts APE's adaptive thresholds, not a hard posture.
> Read every "in `direct`/`balanced`/`collaborative` mode the model does X" statement below as
> "this bias nudges APE's thresholds toward X," never as a mode that overrides the turn's
> signals or APE's safety floor.

### Proposed Config Surface

Add a new lightweight preference separate from routing mode:

```ts
type PartnerStyle = 'direct' | 'balanced' | 'collaborative';

interface AppConfig {
  partnerStyle?: PartnerStyle;
}
```

Default behavior:

- If `partnerStyle` is absent, resolve a default from `mode`:
  - `cost-saver` -> `direct`
  - `balanced` or auto -> `balanced`
  - `quality-first` -> `collaborative`
- Let the user override it explicitly in Settings and via an in-chat `/style` command.
- Keep `verbosity` separate. `verbosity` controls status chrome; `partnerStyle` controls the model's conversational posture.

User-facing labels:

- `Direct`: act quickly, ask only at real blocking forks, keep reflection to one sentence on substantial tasks.
- `Balanced`: default. Briefly align on substantial or ambiguous tasks, ask at meaningful forks, then execute.
- `Collaborative`: discuss the approach before major work, surface tradeoffs earlier, ask for preference when multiple viable directions materially change the result.

This preserves the "just do it" path while making the heyvera.org failure less likely under the default.

### Prompt API Changes

Change `BuildPromptOptions` in `src/core/prompt.ts` to carry behavior context:

```ts
export type PartnerStyle = 'direct' | 'balanced' | 'collaborative';

export interface PromptMemory {
  readonly text: string;
}

export interface BuildPromptOptions {
  readonly goalTurn?: boolean;
  readonly partnerStyle?: PartnerStyle;
  readonly memoryContext?: string;
}
```

Recommended lower-risk implementation detail: keep `buildPrompt(tier, task, managerNotes, historyContext, opts)` signature and extend `opts`, rather than adding more positional parameters.

Prompt assembly order:

1. System/persona prompt.
2. `USER PREFERENCES AND MEMORY` when `memoryContext` is non-empty.
3. `CONVERSATION SO FAR`.
4. `Task`.
5. `REVIEWER FEEDBACK`.

Memory should come before conversation history because it is durable preference/context, not a summary of the current thread.

### Persona Rewrite

Replace tier-specific engineering framing with a shared domain-agnostic base plus tier addenda.

Core posture text:

```text
You are Vera, a sharp general-purpose working partner. You help with coding,
writing, research, operations, planning, analysis, and mixed real-world work.
Treat the user's request as an attempt to achieve an outcome, not as a ticket
to mechanically execute.

Be concise by default. Say the important thing, then move. Do not pad, narrate
obvious process, or ask questions whose answers are already implied by the
request or available context.
```

Substantial-task loop:

```text
For substantial, ambiguous, high-impact, or multi-step work:
1. Identify the user's intended outcome, style, constraints, and likely success criteria.
2. Check relevant available context before committing to an approach.
3. Briefly reflect the big picture in your own words so the user can tell you understood.
4. Validate the vision when it is sound, or challenge it when constraints, evidence, or reality conflict.
5. Ask structured multiple-choice questions only for genuine forks where the answer materially changes the result.
6. Then execute.

For small or clear tasks, skip the alignment ceremony and just answer or act.
```

Preference-aware posture block generated from `partnerStyle`:

- `direct`: "Keep any reflection to one short sentence on substantial tasks. Prefer a reasonable default and proceed unless a fork would materially change the user's outcome or risk wasting significant work."
- `balanced`: "On substantial or ambiguous tasks, give a short vision reflection plus your recommended approach. Ask at most 1-2 multiple-choice questions when genuine forks remain."
- `collaborative`: "On substantial tasks, spend a little more time aligning on the approach. Ask about genuine user-preference forks before heavy execution, but still avoid broad open-ended interviewing."

Concrete `ask_user` rewrite:

```text
ASKING THE USER: Use ask_user for genuine decision forks, not only when you are
blocked. A genuine fork is a choice where different answers would materially
change the plan, style, risk, cost, scope, destination, audience, or irreversible
action. Ask clean multiple-choice questions with a recommended option first when
there is a sensible default. Do not ask about facts you can inspect, infer, or
research. Do not ask on small clear tasks.
```

Keep the existing strict JSON schema and mutual exclusion with confidence envelopes. Update comments in `src/core/questions.ts` to match the new "genuine fork" policy so docs and prompt do not disagree.

### Vision Capture and Work Contract

Use the existing `WorkContract.vision` field, but do not force all tasks through a persisted contract.

Recommended behavior:

- For `/goal`, accepted `keep_going`, and auto-goal, create a richer initial contract:

```ts
capContract({
  version: 1,
  objective: goalText,
  vision: deriveInitialVision(goalText),
})
```

- `deriveInitialVision` should be a pure heuristic in `src/core/work-contract.ts`, not a model call. It can cap and normalize the user's task as a first approximation.
- The model prompt should instruct Vera to refine the working understanding in prose, not to emit a new contract JSON block in the first phase.
- Future enhancement: add a model-emitted `work_contract` block only if there is a real persistence/verification consumer. Do not add it now just to collect structured text.

Why build on work-contract:

- It already represents objective, vision, roadmap, checkpoints, and anti-drift state.
- It is persisted on accepted assistant entries via `SessionEntry.workTrace` at `src/core/types.ts:118-124` and `src/core/orchestrate.ts:110-127`.
- It is capped and prompt-renderable already.

Why not make it the whole solution:

- Work contracts are task-scoped. User memory is durable across sessions and must have explicit governance.
- Vision-first posture is mostly prompt behavior plus preference control, not just stored fields.

### Substantial vs Small Task Heuristic

The prompt should teach the model this heuristic. Do not add a hard runtime classifier yet.

Substantial tasks include:

- multi-step build, plan, migration, investigation, research synthesis, drafting a long document, trip planning, financial/legal/medical-adjacent advice, operational workflows, or anything likely to take several actions;
- ambiguous aesthetic or product requests where style/target audience matters;
- irreversible or high-risk actions;
- requests with an explicit vision phrase such as "as I envisioned", "old YouTube 2010 social area", "make this feel like", "I want it to behave like".

Small/clear tasks include:

- factual Q&A, command output, small edits, simple transformations, single-file changes, short summaries, and requests where the desired output format is explicit.

### Implementation Touch Points

Files to change:

- `src/core/prompt.ts`
  - Add `PartnerStyle` type and `partnerStyle`/`memoryContext` options.
  - Factor shared base prompt plus tier addenda.
  - Rewrite `ASKING THE USER` text around "genuine forks".
  - Add memory and partner-style prompt sections.
  - Tighten brevity: "No process narration unless it affects user decisions. No rambling. Prefer short paragraphs."
- `src/core/questions.ts`
  - Update top-level comment from "cannot proceed" to "genuine decision fork".
  - Parser likely unchanged.
- `src/core/types.ts`
  - Add optional `promptContext?: { partnerStyle?: PartnerStyle; memoryContext?: string }` or direct fields on `OrchestrateDeps`.
  - Prefer direct fields for simplicity: `partnerStyle?: PartnerStyle`, `memoryContext?: string`.
- `src/core/orchestrate.ts`
  - Pass `deps.partnerStyle` and `deps.memoryContext` into `buildPrompt`.
  - For panel/hedge paths, thread the same prompt context into those executors if they call `buildPrompt` internally.
- `src/interface/menu.ts`
  - Add Settings row for partner style.
  - Add `/style` command in chat.
  - Resolve default style from effective mode when config lacks `partnerStyle`.
  - Pass style into `buildDeps`.
- `src/cli.ts`
  - For `run`, load config, resolve effective mode, derive default style, and pass style into deps.
- `src/infra/config.ts`
  - Add optional `partnerStyle`.
  - Preserve it in every Settings-style config rebuild.

## Theme 2: User Memory

> **⚠️ SUPERSEDED — this entire Theme 2 (and all its subsections through "Control Envelope
> Interaction") is replaced by [`docs/memory-architecture-5.5.md`](./memory-architecture-5.5.md)
> v1.2. Do NOT implement the schema, project-key, retrieval, or cap math below. Kept only for
> historical rationale.** The `remember_user`-inside-the-confidence-envelope *wiring decision*
> survives (memory doc §8); everything about *what/how it stores* is the memory doc's.

### What To Remember

A memory is worth storing only when it is durable, user-specific, useful beyond the current turn, and safe to retain.

Store:

- Stable preferences: "Prefers concise answers", "Likes multiple-choice clarifying questions", "Wants direct execution unless high uncertainty."
- Work style: "Prefers implementation over long proposals", "Wants tests run before final summaries."
- Identity/role when user volunteered it and it affects assistance: "Works as a school administrator", "Maintains a small nonprofit website."
- Durable project facts/goals: "heyvera.org should feel like an old YouTube 2010 social area", when scoped to the project.
- Long-lived constraints: "Uses Node 22", "Avoids paid APIs", "Needs accessibility-first designs."
- Recurring corrections: "User has repeatedly said myshell-tools is a general-purpose CLI, not coding-specific."
- Communication/accessibility preferences: "Use plain English", "Avoid jargon", "Provide commands I can run."

Never store:

- Secrets, credentials, tokens, private keys, passwords, API keys, session cookies, recovery codes.
- Sensitive personal data not needed for future help, especially health, financial, legal, government ID, precise location, minors, or protected-class details.
- One-off task details: current bug symptoms, temporary file paths, today's meeting, an itinerary for one trip unless user explicitly says it is recurring.
- Transient context already in conversation history: "the test failed just now", "the current branch is dirty."
- Chit-chat, compliments, frustration, mood, jokes.
- Inferences about identity or preferences that the user did not state clearly.
- Large blobs, documents, code, logs, or conversation summaries.

Signal-vs-noise heuristic for the model:

```text
Remember only if the statement is likely to matter in a future session and can
be expressed as one short, non-secret fact. If it would be stale in a week,
belongs only to this task, or would surprise the user to see saved, do not save it.
When unsure, do not remember unless the user explicitly asked you to.
```

### Capture Mechanisms

Use both explicit commands and model-proposed memories.

#### Explicit User Commands

Add chat/menu commands:

- `/remember <fact>`: save a user-approved memory immediately after deterministic validation.
- `/memory`: list memories relevant to current scope plus global memories.
- `/forget`: open a selector to delete one or more memories.
- `/forget <id>`: delete by id.

For one-shot CLI:

- `myshell-tools memory list`
- `myshell-tools memory add "<fact>"`
- `myshell-tools memory forget <id>`

#### Model-Proposed Memories

Add a new structured trailing block, separate from `ask_user`:

```json
{"remember_user":{"facts":[{"scope":"global|project","kind":"preference|identity|project|constraint|correction","text":"<short fact>","reason":"<why this is durable>"}]}}
```

Bounds:

- 1-3 proposed facts.
- `text` max 180 chars.
- `reason` max 160 chars.
- Only accepted on normal successful turns.
- Mutually exclusive with `ask_user` as a final control block. If the model needs user input, ask first; memory can wait.

Approval default:

- Default should be transparent approval, not silent saving.
- When a model proposes memory, the UI should show a small selector:
  - `Save`
  - `Skip`
  - `Edit`
- In `direct` style, proposal frequency should be stricter and the UI can default to `Skip` on Enter.
- In `balanced` and `collaborative`, default to `Save` only for obvious preference statements or explicit "remember this" user phrasing.

Important anti-annoyance rule:

- Do not ask to save memory during every task. The prompt should say to propose memories only when there is a clear durable fact or an explicit user command.

Parser:

- Add `src/core/user-memory.ts` pure helpers:
  - `parseRememberUser(text: string): RememberProposal | null`
  - `capMemoryFact`
  - `isLikelySecret(text: string): boolean`
  - `isMemoryWorthyCandidate(text: string): boolean`
  - `renderMemoryContext(facts: readonly UserMemoryFact[]): string`
- Consider genericizing `CONTROL_ENVELOPE_KEYS` in render, or add `remember_user` to the list so raw JSON never leaks.

### Storage Design

Use a file-per-fact plus index design, adapted for this product.

Location:

```text
<defaultStateHome>/.myshell-tools/memory/
  index.json
  facts/
    <id>.json
```

This survives Replit because `defaultStateHome()` already maps Replit to cwd via `src/infra/state-dir.ts:41-60`.

Why file-per-fact fits:

- Individual facts are easy to list, edit, delete, and diff.
- Corruption is isolated to one fact.
- It avoids rewriting a large memory blob for every change.
- It matches the product need for transparency and control.

Why not copy a `MEMORY.md` index as the primary source:

- A Markdown index is good for human operators, but this CLI needs typed, bounded, machine-filterable facts.
- Markdown can still be generated for display/export later, but JSON should be authoritative.

Index format:

```json
{
  "version": 1,
  "facts": [
    {
      "id": "mem_01HX...",
      "scope": "global",
      "projectKey": null,
      "kind": "preference",
      "summary": "Prefers concise, direct answers.",
      "createdAt": "2026-06-05T00:00:00.000Z",
      "updatedAt": "2026-06-05T00:00:00.000Z",
      "lastUsedAt": null,
      "useCount": 0,
      "source": "user_explicit",
      "confidence": "user_confirmed",
      "archived": false
    }
  ]
}
```

Fact file format:

```json
{
  "version": 1,
  "id": "mem_01HX...",
  "scope": "global",
  "projectKey": null,
  "kind": "preference",
  "text": "User prefers concise, direct answers unless the task is complex.",
  "reason": "Durable communication preference.",
  "createdAt": "2026-06-05T00:00:00.000Z",
  "updatedAt": "2026-06-05T00:00:00.000Z",
  "lastUsedAt": null,
  "useCount": 0,
  "source": "user_explicit",
  "confidence": "user_confirmed",
  "tags": ["communication"],
  "archived": false
}
```

Types:

```ts
// ⚠️ SUPERSEDED schema — do NOT implement. `MemoryConfidence='user_confirmed'` and
// `MemorySource` are replaced by the memory doc's trust tiers (user_stated/agent_inferred/
// ingested) + closed-subject enum (RC-1). See memory-architecture-5.5.md §1/§2.
type MemoryScope = 'global' | 'project';
type MemoryKind = 'preference' | 'identity' | 'project' | 'constraint' | 'correction';
type MemorySource = 'user_explicit' | 'model_proposed';
type MemoryConfidence = 'user_confirmed';
```

Keep only confirmed facts in storage for v1. Do not persist rejected proposals.

Project scoping:

- Global facts apply everywhere.
- Project facts apply when the current cwd maps to the same project key.
- Project key should be deterministic and privacy-preserving:
  - Prefer nearest git root basename plus hash of absolute root path.
  - Fallback to cwd basename plus hash of absolute cwd.
  - Store the display name separately from the hash if needed.
- Do not store raw full paths in memory facts by default. Full paths can reveal private info.

Infra files:

- Add `src/infra/user-memory-store.ts` as the file-backed store.
- Reuse `atomicWrite`, `withLock`, and `defaultStateHome()`.
- Store under `<stateHome>/.myshell-tools/memory`.
- Add corrupt-index recovery similar to conversations if needed, but v1 can do simpler best-effort: missing/corrupt index returns empty and preserves corrupt file.

Port:

```ts
export interface UserMemoryStore {
  list(scope?: MemoryScopeFilter): Promise<UserMemoryFact[]>;
  add(input: NewUserMemoryFact): Promise<UserMemoryFact>;
  update(id: string, patch: MemoryPatch): Promise<UserMemoryFact | null>;
  forget(id: string): Promise<boolean>;
  selectRelevant(input: MemorySelectionInput): Promise<UserMemoryFact[]>;
  markUsed(ids: readonly string[]): Promise<void>;
}
```

### Retrieval and Prompt Injection

Selection should be deterministic in v1. Avoid a model call just to retrieve memory.

Inputs:

- current task text;
- current cwd/project key;
- conversation title/category if available;
- partner style;
- memory facts from global + current project.

Algorithm:

1. Exclude archived facts.
2. Include all global communication preferences and partner-style preferences, up to 5.
3. Include project-scoped facts matching current project, up to 8.
4. Score remaining facts by simple keyword overlap between task and fact text/tags/kind.
5. Prefer user-explicit facts over model-proposed facts if tied.
6. Prefer recently used/updated facts if tied.
7. Cap total injection to:
   - max 12 facts;
   - max 1,200 chars rendered;
   - each fact rendered as one bullet under a clear header.

Prompt format:

```text
USER PREFERENCES AND MEMORY (confirmed facts; use when relevant, do not repeat back):
- Prefers concise, direct answers unless the task is complex.
- For this project: heyvera.org should have an old-YouTube-2010 social area feel.

Memory rules: follow these when relevant, but the current user request overrides stale or conflicting memories. Never reveal or claim hidden memories; if asked, list them honestly through /memory.
```

Do not inject raw metadata unless needed. The model needs facts, not IDs.

Where to wire:

- In `src/interface/menu.ts`, before each turn after loading `priorHistory`, call `memoryStore.selectRelevant({ task: line, cwd, projectKey })`, render via pure helper, pass as `deps.memoryContext`.
- In `/goal`, retrieve memory for the goal text once per goal run and pass it into each goal deps build. If the user answers questions mid-goal, rebuild as normal.
- In `src/cli.ts run`, create the memory store, select relevant global/project facts for the one-shot task, and pass context into deps.

### Privacy and Safety

Rules:

- Never store secrets. Use deterministic secret detection before showing a proposal:
  - common key names: `api_key`, `token`, `password`, `secret`, `private_key`, `BEGIN ... PRIVATE KEY`;
  - high-entropy long strings;
  - provider tokens and OAuth-looking strings.
- Never store sensitive personal details unless the user explicitly commands `/remember` and confirms after a warning. For v1, prefer rejecting sensitive categories entirely.
- Never silently save model-inferred facts.
- The user can list and delete all memories.
- The assistant should be honest when asked "what do you remember about me?"
- Memory should be disabled by config if the user wants no durable memory:

```ts
memory?: 'on' | 'off';
```

Default: `on` for explicit `/remember`, `ask` for model-proposed saves. To avoid config complexity, v1 can use `memoryEnabled?: boolean` with default true, but still require approval for model proposals.

### Memory Approval UI

Menu chat:

1. Render model answer as normal.
2. If `remember_user` proposal parsed and passes filters:
   - print `Remember this for future chats?`
   - show numbered facts with `Save / Skip / Edit`.
3. On save/edit, write memory and print a terse confirmation: `Remembered: <summary>`.
4. On skip, print nothing or a dim `Skipped`.

One-shot `run`:

- Because one-shot commands may be scripted, do not prompt interactively unless stdin is a TTY.
- If TTY, show the same approval prompt after completion.
- If non-TTY, ignore model-proposed memory and rely on explicit `myshell-tools memory add`.

### Control Envelope Interaction

Currently display strips `confidence`, `ask_user`, and `verdict` at `src/interface/render.ts:127-141`.

Add `remember_user` to control envelope stripping. Then decide orchestration semantics:

- `ask_user` remains a final event with `questions`.
- `remember_user` should not prevent the normal final success.
- Extend `CoreEvent.final` with `memoryProposal?: RememberProposal`.
- In `orchestrate`, after success and before review/escalation decisions, parse `remember_user` from final text. Unlike `ask_user`, it should not short-circuit.
- Assessment parsing must still find confidence. Since only one trailing JSON block can be final today, a normal answer already needs confidence at the end. Options:
  - Preferred: extend the confidence envelope to include optional `remember_user`, e.g. `{"confidence":...,"remember_user":{...}}`. This avoids two trailing blocks and keeps assessment intact.
  - Alternative: allow two trailing control blocks, but this complicates stripping and parsing.

Recommendation: add optional `remember_user` inside the confidence envelope for normal completed turns, while keeping standalone `{"remember_user":...}` only for explicit memory command flows if needed. Update `assess()` to ignore extra keys.

## Implementation Sequence

1. Prompt and partner-style foundation
   - Files: `src/core/prompt.ts`, `src/core/questions.ts`, `src/infra/config.ts`, `src/core/types.ts`, `src/core/orchestrate.ts`, `src/interface/menu.ts`, `src/cli.ts`.
   - Add `PartnerStyle`, config field, default resolver, prompt options, Settings row, `/style`.
   - Update prompt tests first because current tests assert existing phrases.

2. Memory pure core
   - Files: new `src/core/user-memory.ts`, tests in `test/unit/user-memory.test.ts`.
   - Implement schemas, caps, parser, secret filter, render helper, deterministic selection scoring.

3. Memory storage
   - Files: new `src/infra/user-memory-store.ts`, tests in `test/unit/user-memory-store.test.ts`.
   - Use `defaultStateHome`, atomic writes, locks, file-per-fact plus index.

4. Memory commands and UI
   - Files: `src/interface/menu.ts`, `src/cli.ts`, maybe new `src/commands/memory.ts`.
   - Add `/remember`, `/memory`, `/forget`; add CLI `memory` subcommands.
   - Add Settings toggle for memory.

5. Memory prompt injection
   - Files: `src/interface/menu.ts`, `src/cli.ts`, `src/core/types.ts`, `src/core/orchestrate.ts`, `src/core/prompt.ts`, plus panel/hedge prompt call sites if needed.
   - Retrieve selected facts per turn and pass rendered context into `buildPrompt`.

6. Model-proposed memory
   - Files: `src/core/prompt.ts`, `src/core/assess.ts`, `src/core/user-memory.ts`, `src/interface/render.ts`, `src/core/orchestrate.ts`, `src/interface/menu.ts`.
   - Add optional `remember_user` inside the confidence envelope, parse it, approve in UI, save confirmed facts.

## Test Strategy

Pure/unit-testable:

- `buildPrompt` includes partner-style instructions, memory context, history ordering, and goal-turn confidence suppression still works.
- `questions.ts` continues parsing old `ask_user`; docs/comment expectations shift to genuine forks.
- Partner style resolver maps absent config + mode to the right default.
- Memory parser accepts bounded valid proposals and rejects malformed/oversized proposals.
- Secret filter rejects keys/tokens/private-key patterns.
- Memory scoring selects global preferences, project facts, and relevant keyword matches under caps.
- Memory context renderer caps fact count and characters.
- File-backed memory store add/list/update/forget survives corrupt/missing index and uses explicit `homeDir` for hermetic tests.
- Config load/save preserves `partnerStyle` and memory settings through settings-style rebuilds.
- Render strips `remember_user` control data and does not leak raw JSON.

Integration-ish seams:

- Menu `/remember`, `/memory`, `/forget` with injected `readLine`.
- Model-proposed memory approval flow with injected `readLine` and fake memory store.
- One-shot `run` injects memory but does not prompt for model-proposed memory on non-TTY stdin.
- Existing `ask_user` flow remains unaffected, including `keep_going`.

Not worth testing with live providers in v1:

- Whether a specific model always proposes memory at the right frequency. That is prompt-behavioral and should be monitored with transcript fixtures/manual evals.

Suggested behavioral eval fixtures:

- Small clear task: "What time is it?" should not reflect a vision or ask questions.
- Ambiguous substantial task: "Build the frontend as I envisioned, old YouTube 2010 social area" should inspect context, reflect the desired feel, validate/challenge, and ask only if there is a real fork.
- Direct style: same task should keep alignment short and move.
- Collaborative style: same task should ask about the most consequential style/scope fork before heavy work.
- Memory-worthy: "Remember that I prefer concise answers" should save after approval.
- Not memory-worthy: "For this one email, make it warmer" should not propose memory.
- Secret: "Remember my API key is ..." should be rejected.

## Risks and Open Questions

- Should model-proposed memories require approval every time, or can explicit "remember that..." save without a second confirmation? Recommendation: explicit `/remember` saves immediately; plain-language "remember that..." shows one confirmation in v1.
- Should `partnerStyle` be global only, or overridable per conversation? Recommendation: global first. Per-conversation can be added later if users ask.
- Should memory default on? Recommendation: yes for explicit commands and approved proposals; no silent saves.
- How should project scope be displayed to users without exposing private absolute paths? Recommendation: show cwd basename or git root basename plus "this project"; keep hash internal.
- Should sensitive memories ever be allowed with explicit confirmation? Recommendation: v1 rejects secrets always and avoids sensitive personal facts unless a later privacy design adds encrypted storage.
- Should memory retrieval ever use embeddings or model selection? Recommendation: no for v1. Deterministic retrieval is transparent, cheap, and testable.
- Should work-contract vision be model-generated and persisted? Recommendation: not yet. Use prompt reflection and task-scoped heuristic vision first; add structured model contract only when a verifier consumes it.

## Concise Summary

The current system has the right primitives but the wrong posture pressure. `ask_user` is framed as a last resort, personas are too coding-specific, and there is no durable user memory. The design adds a separate `partnerStyle` preference, rewrites prompts around a vision-first substantial-task loop, uses `ask_user` proactively for genuine forks, and keeps small tasks fast.

For memory, add a transparent, approved, file-per-fact subsystem under the existing persistent state home. Store only durable, safe, user-specific facts; reject secrets and transient noise; retrieve a small relevant set per turn; inject it into `buildPrompt` as confirmed memory.

Top decisions for the user:

1. Confirm the `partnerStyle` names/defaults: `direct`, `balanced`, `collaborative`.
2. Confirm model-proposed memory approval behavior: always ask before saving in v1.
3. Confirm memory scope: global plus current project, with project key derived from cwd/git root hash.
4. Confirm whether `/remember` should save immediately or still ask for confirmation.
