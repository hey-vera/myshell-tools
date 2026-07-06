# AI Memory: How Shipping Products & Academic Work Handle the Hard Problems

**Scope:** Research feeding the `myshell-tools` memory subsystem (a CLI wrapping Claude / Codex / OpenCode for *any* kind of work, not just coding). Focus on the hard problems: signal vs noise, forgetting/decay, drift prevention, conflict resolution, capture UX, and user control.

**Date:** 2026-06-05. All claims cited inline with source URLs.

---

## Part 1 — Products (how they actually behave for users)

### 1.1 ChatGPT Memory

ChatGPT runs **three distinct memory layers**, which is itself an important design lesson (separate explicit vs inferred memory):

1. **Saved Memories ("Bio" tool)** — user-instructed facts, written to a `Model Set Context` block, **timestamped** e.g. `[2025-05-02]. The user likes ice cream and cookies.` User-manageable in the UI. Still vulnerable to indirect prompt injection.
2. **Reference Chat History** — keeps roughly the **last ~40 conversations**: timestamps, conversation summaries, and the user's typed messages (notably *not* ChatGPT's own responses), used to learn interests/preferences.
3. **Derived user profile (automatic profiling)** — generated out-of-band on a cadence; four sections: Assistant Response Preferences, Notable Past Conversation Topics, Helpful User Insights (location/profession/expertise), and User Interaction Metadata (device, usage). **Users cannot inspect, edit, or delete this layer** — the author argues this opacity is likely why the feature shipped late in the EU (GDPR).
   - Source: Embrace The Red technical breakdown — https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/

- **What it decides to save:** how recent a detail is and how often a topic recurs; it does *not* store full chat logs. Two save types: explicit ("remember that…") and inferred patterns across sessions.
  - https://openai.com/index/memory-and-new-controls-for-chatgpt/ , https://help.openai.com/en/articles/8590148-memory-faq
- **What it steers away from:** OpenAI says it steers ChatGPT away from *proactively* remembering sensitive info (e.g. health) unless explicitly asked.
- **User control:** delete individual memories or whole conversations; **Temporary Chat** writes nothing; **Project-only memory** (shipped 2025) scopes context to a single project to stop cross-project bleed.
  - https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-project-only-memory-is-live-and-it-might-change-how-you-work-with-ai

**User complaints (the gold):**
- **Identity confusion / cross-project bleed:** memory pulled a *client's* project detail and asserted *the user* was writing that book. https://chatgptexperiment.com/what-chatgpt-remembers-about-you-and-how-to-take-control-of-it/
- **"Context rot":** slow buildup of stale preferences, errors, and contradictions; e.g. BBQ-rib advice keyed to an old Hoboken zip code rather than good cooking advice. The system "blurs relevance with continuity, treating *related* as *relevant* and *previously true* as *still true*." https://seo.software/blog/chatgpt-past-conversation-memory-problem-workflows , https://unmarkdown.com/blog/stop-chatgpt-losing-context
- **Overconfident wrong recall** dragging old topics/tone into unrelated new tasks; power users say it tanks workflow reliability.
- **Privacy surprise:** centralizing personal info raises breach/unauthorized-access fears. https://community.openai.com/t/privacy-concerns-in-chatgpts-memory-system/982636

### 1.2 Claude Code — CLAUDE.md & the Anthropic Memory Tool

**CLAUDE.md (project memory, human-authored):**
- Read at the start of every session; the place for project info, conventions, and frequently used commands.
- **Best practice = ruthless concision:** keep load-bearing rules to ~15 max; files read every session should stay under ~500 lines for context efficiency. "It should contain information that materially changes Claude's decisions, not information Claude can easily infer from reading the code." Imperative phrasing ("never use inline mocks — use src/test/factories/*") beats observations; reserve `IMPORTANT`/`YOU MUST` for the one or two genuinely critical rules.
  - https://code.claude.com/docs/en/best-practices , https://www.datastudios.org/post/claude-code-memory-claude-md-persistent-instructions-and-project-context-how-anthropic-s-coding
- **Conditional rules** (`.claude/rules/`) load only when files matching a path pattern are touched — i.e. *just-in-time* scoping instead of one giant always-on payload.
- Split of duties: CLAUDE.md = "your requirements"; auto-memory (MEMORY.md) = "what the agent observed about you" — if auto-memory is wrong, edit the file directly.

**Anthropic Memory Tool (API, beta `memory_20250818`):**
- A client-side file store under `/memories`; commands: `view, create, str_replace, insert, delete, rename`. The app executes ops locally, so the developer owns storage and can encrypt/validate.
- **Auto-check protocol** injected into the system prompt: "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE… ASSUME INTERRUPTION: your context window might be reset at any moment, so you risk losing any progress not recorded in memory."
- **Anti-clutter prompt** (use if files get messy): "always try to keep its content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. Do not create new files unless necessary."
- **Scoping the content:** "Only write down information relevant to <topic> in your memory system."
- **Security guidance (directly relevant):**
  - *Sensitive info:* "Claude will usually refuse to write down sensitive information… you may want to implement stricter validation that strips out potentially sensitive information."
  - *Size limits:* track file sizes, cap read-command return size, paginate.
  - *Expiration:* "Consider clearing out memory files periodically that haven't been accessed in an extended time."
  - *Path-traversal:* MUST validate every path stays within `/memories` (reject `../`, URL-encoded traversal, etc.).
  - Pairs with **compaction** (server-side summarization) and **context editing**; memory persists what matters across compaction boundaries.
  - **Multi-session pattern:** an initializer session bootstraps a *progress log* + *feature checklist*; each session reads them first and updates the progress log last; only mark a feature done **after end-to-end verification**, keeping the log trustworthy.
  - Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool

### 1.3 Cursor — Rules + auto-generated Memories

- **Memories** are auto-generated rules derived from chat, scoped to the project, persisting across sessions.
- **Complaints:** users report rules "never followed" and auto-memories "immediately ignored." A **stale rules file is worse than none** — it actively pushes the AI toward outdated patterns; treat rules as living documentation and update on every architecture/convention change. A 3.0.16 bug silently downgraded `alwaysApply: true` rules to "requestable," so they stopped being injected — a reminder that *silent* scoping/activation failures erode trust.
  - https://forum.cursor.com/t/rules-vs-memories-and-global-vs-project/137149 , https://forum.cursor.com/t/memories-and-rules/121348 , https://dev.to/pockit_tools/mastering-cursor-rules-the-ultimate-guide-to-cursorrules-and-memory-bank-for-10x-developer-alm

### 1.4 Windsurf — Cascade Memories vs Rules

- **Memories** auto-generated by Cascade when it judges context useful (or via "create a memory of…"); stored **locally** in `~/.codeium/windsurf/memories/`, **workspace-scoped**, not committed to the repo, free (no credits). Viewable/editable in the Customizations UI.
- **Explicit "what NOT to rely on" guidance:** "For knowledge you want Cascade to *reliably* reuse, write it as a **Rule** or add it to `AGENTS.md`… rather than relying on auto-generated Memories." I.e. auto-memory = best-effort, hand-authored rules = durable contract. Clean separation of trust tiers.
  - https://docs.windsurf.com/windsurf/cascade/memories

### 1.5 GitHub Copilot — Custom Instructions + Copilot Memory (best drift design seen)

- **Custom instructions:** `.github/copilot-instructions.md` (repo-wide) + path-specific `*.instructions.md` under `.github/instructions/`. Human-authored, version-controlled.
  - https://docs.github.com/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot
- **Copilot Memory (Agentic Memory)** — two tiers:
  - **Repository facts** stored **with citations to the code that supports them**. **Verify-before-trust:** before applying a fact, Copilot "checks those citations against the current branch to confirm the information is still accurate. Only validated facts are used." Repo-scoped for privacy.
  - **User preferences** stored per-user across repos; uses "best judgment to confirm the preference still applies."
  - **Decay:** "Any stored fact or preference that goes unused is **automatically deleted after 28 days**. The 28-day timer may reset whenever Copilot successfully validates and uses an entry." (Use-it-or-lose-it.)
  - **Control:** users view/delete own preferences; repo owners review/delete repo facts; Business/Enterprise admins can export or bulk-delete.
  - Source: https://docs.github.com/en/copilot/concepts/agents/copilot-memory

### 1.6 Replit Agent

- No native persistent memory — each session starts fresh; persistence requires external memory frameworks that capture design/architecture decisions and corrections. Relevant because `myshell-tools` runs on Replit and would be *adding* the layer Replit Agent lacks.
  - https://memu.pro/blog/replit-agent-ai-app-builder-memory

### 1.7 Security cross-cutting — Memory Poisoning (Palo Alto Unit 42)

Indirect prompt injection from ingested web/doc content can survive **session summarization** and become persistent memory, then enter the orchestration prompt for **all future sessions** → silent data exfiltration, behavioral drift across days. Mitigations: treat all tool output / external content as adversarial; content filtering & sanitization on the write path; **provenance** controls (allowlist sources); **per-user scope isolation**; logging/anomaly detection.
- https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/

---

## Part 2 — Academic techniques

### 2.1 Generative Agents (Park et al., 2023) — the canonical retrieval triad

Memory is a **memory stream** (natural-language event log). Retrieval scores each memory as a weighted, min-max-normalized sum of three signals:
- **Recency** — exponential decay over time since last access.
- **Importance ("poignancy")** — LLM rates 1–10 at write time (1 = brushing teeth, 10 = a breakup; "ask crush on a date" ≈ 8).
- **Relevance** — cosine similarity of memory embedding vs query embedding.

**Reflection:** periodically synthesizes higher-level inferences; triggered when summed importance of recent events crosses a threshold (~150 in the paper; agents reflect ~2–3×/day). This is how raw observations become durable insights.
- https://ar5iv.labs.arxiv.org/html/2304.03442 , https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763

### 2.2 Reflexion (Shinn et al., 2023) — self-reflective episodic memory

Agent verbally reflects on task feedback (success/failure) and stores that reflection in an **episodic memory buffer** to improve next attempt — no weight updates, just linguistic feedback. Lesson for us: *outcome-tagged* memories (what worked / what failed) are high-value and cheap to capture.
- https://arxiv.org/abs/2303.11366

### 2.3 MemoryBank (Zhong et al., 2023) — Ebbinghaus time-decay (the only deployed decay math)

- **Retention `R = e^(-t/S)`**: `t` = time since last recall, `S` = memory strength (discrete, init 1).
- On recall: `S += 1` and `t` resets to 0 → reinforced memories forget more slowly; neglected ones fade. Use-it-or-lose-it, as a continuous curve.
- Hierarchical summarization: dialogues → daily event summaries → global summary; plus daily → global personality profile. Authors call it "exploratory and highly simplified."
- https://ar5iv.labs.arxiv.org/html/2305.10250 , https://arxiv.org/abs/2305.10250

### 2.4 A-MEM (2025) — Zettelkasten linked notes + memory evolution

Each new memory becomes an **atomic note** with structured attributes (contextual description, keywords, tags) and **links** to similar past notes. Adding a memory can **trigger updates to existing notes' attributes** ("memory evolution") — the network self-refines instead of being a flat append log.
- https://arxiv.org/abs/2502.12110 , https://github.com/agiresearch/a-mem

### 2.5 Mem0 (2025) — production extract → consolidate with explicit conflict resolution

- **Extraction:** LLM turns conversation turns into salient facts (and, in Mem0g, entity/relation triples).
- **Consolidation (Updater):** for each new fact, retrieve similar existing memories by vector similarity and have an LLM decide **ADD / UPDATE / DELETE / NOOP**.
- **Conflict resolution:** on contradiction, an LLM resolver marks the old relationship **obsolete/invalid** rather than hard-deleting (Mem0g keeps it for temporal reasoning). Note: an open issue flags that the simpler ADD-only path *doesn't* dedup semantically similar memories — i.e. consolidation must be deliberate or junk accumulates.
- https://arxiv.org/html/2504.19413v1 , https://github.com/mem0ai/mem0/issues/4896

### 2.6 Survey — "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, Frontiers" (2026)

- Memory as a **write–manage–read** loop; **write is not append** — it "summarizes, deduplicates, scores priority, resolves contradictions, and deletes." "Manage" (what gets stored/retrieved) is the least-studied dimension. Control policies: heuristic / prompted-self / learned.
- **Forgetting is "severely underexplored"** — current options are crude: time-cutoff, capacity eviction, Ebbinghaus (MemoryBank only). "The inability to discard outdated information gradually poisons retrieval precision."
- **Conflict resolution** recommended write-path mechanisms: **temporal versioning (prefer newest)**, **source attribution (user statement >> agent inference)**, **contradiction detection (flag for resolution)**. No deployed system does automated contradiction resolution well; most fall back to heuristic source ranking. Core problem: stores can't distinguish "the 2024 address from the 2022 one" without explicit mechanisms.
- **Named failure modes:** *summarization drift* (each compression pass discards low-frequency detail → a sanitized generic memory); *self-reinforcing error* (one wrong conclusion like "API X always errors" → avoided forever); *silent orchestration failures* (slightly-worse answers, no log); *attentional dilution* (more injected memory → worse focus on any one item).
- https://arxiv.org/html/2603.07670v1

Supporting taxonomies: https://arxiv.org/html/2605.06716v1 , https://arxiv.org/html/2602.05665v1 (graph-based), https://arxiv.org/html/2604.16548v1 (security/"mnemonic sovereignty").

---

## Part 3 — Ranked heuristic: WHAT to remember vs NEVER remember

Ranked by value-to-cost. "Cost" = risk of causing drift, privacy harm, or context bloat.

| Rank | REMEMBER (high signal) | Why | NEVER store (noise/hazard) | Why |
|------|------------------------|-----|----------------------------|-----|
| 1 | **Explicit user instructions/preferences** ("always X", "never Y") | Highest-trust source; user statement >> inference | **Secrets / credentials / tokens / keys** | Breach blast radius; Anthropic tool refuses + strip on write |
| 2 | **Durable project facts with provenance** (build cmds, conventions, architecture decisions) | Stable, reusable; cite the supporting file | **Transient task state** (the specific bug being fixed right now, scratch values) | Goes stale instantly → context rot |
| 3 | **Corrections / outcomes** ("that approach failed because…", Reflexion-style) | Prevents repeating mistakes; cheap, high-payoff | **Raw chat transcripts / verbatim logs** | Bloat + attentional dilution; summarize instead |
| 4 | **Stable identity/role context** (the user's role, tech stack, domain) | Reused across sessions | **Sensitive personal data** (health, finances, protected attrs) unless explicitly asked | Privacy surprise; ChatGPT steers away by default |
| 5 | **Recurring patterns confirmed ≥2×** | Repetition = signal, not one-off | **One-off / low-importance events** (chit-chat, mundane acks) | Low poignancy; pure noise |
| 6 | **Cross-session progress log + checklist** (verified-done only) | Resume after interruption (Anthropic pattern) | **Agent's own unverified inferences as fact** | Self-reinforcing error; tag as inference, low trust |
| 7 | **Links/relations between facts** (A-MEM style) | Enables consolidation & retrieval | **Anything ingested from untrusted external content, unsanitized** | Memory-poisoning vector (Unit 42) |

**Crisp signal-vs-noise heuristic:** *Store a memory only if it is (a) likely true beyond this single task, (b) likely to change a future decision, and (c) not re-derivable cheaply from the workspace/code itself.* If a fact fails any of the three, don't store it. (Mirrors Anthropic's "materially changes decisions, not what it can infer" + the survey's "manage" discipline.)

---

## Part 4 — Ranked failure modes users actually hit (with the fix each implies)

1. **Context rot / stale-fact bleed** — old preferences leak into unrelated work (ChatGPT BBQ-zip-code). **Fix:** time-decay + use-it-or-lose-it expiry (Copilot 28-day), project/workspace scoping, "true-when-written" timestamps.
2. **"Related ≠ relevant, previously-true ≠ still-true"** — the core drift bug. **Fix:** verify-before-trust (Copilot citation re-check), temporal versioning preferring newest, invalidate on contradiction.
3. **Identity/cross-project confusion** — client's fact attributed to the user. **Fix:** strict scoping (global vs project vs session) + source attribution on every memory.
4. **Self-reinforcing error** — one wrong conclusion avoided forever. **Fix:** tag agent inferences as low-trust; require external re-validation before acting on a stored belief; let users correct.
5. **Junk accumulation / no dedup** — ADD-only stores bloat (Mem0 issue #4896). **Fix:** consolidation sweep with ADD/UPDATE/DELETE/NOOP; importance scoring at write; size caps.
6. **Summarization drift** — repeated compression sands off specifics into generic mush. **Fix:** preserve high-importance raw facts across compaction; don't re-summarize already-summarized memory repeatedly.
7. **Stale rules worse than none** — outdated `.cursorrules` actively misleads. **Fix:** treat rules as living docs; surface age; prompt update on convention change.
8. **Silent scoping/activation failure** — rules silently not injected (Cursor 3.0.16). **Fix:** make what's-loaded *visible*; transparency over magic.
9. **Privacy surprise / un-inspectable memory** — ChatGPT's derived profile can't be viewed or deleted; blocked in EU. **Fix:** every stored item must be viewable, editable, deletable, exportable.
10. **Memory poisoning via ingested content** — injected instructions persist across sessions. **Fix:** sanitize/validate on write, allowlist sources, never store raw untrusted tool output as trusted memory.

---

## Part 5 — Forgetting & drift-prevention toolkit (concrete mechanisms)

**Forgetting / decay**
- **Use-it-or-lose-it TTL** — delete unused entries after N days; reset the timer each time the entry is validated and used (Copilot: 28 days). Simplest mechanism with a real shipped track record.
- **Ebbinghaus continuous decay** — `R = e^(-t/S)`; `S += 1` and reset `t` on each recall (MemoryBank). Use a decay-weighted retrieval score rather than hard deletion when you want graceful fade.
- **Importance scoring at write** — LLM rates 1–10 (Generative Agents); low scores expire first, high scores survive.
- **Capacity eviction + size caps** — cap per-file size, cap read-return size, paginate (Anthropic). Evict lowest importance×recency when over budget.
- **Consolidation sweeps** — periodic ADD/UPDATE/DELETE/NOOP pass to merge duplicates and retire stale entries (Mem0; survey "recommended but unimplemented").

**Drift prevention**
- **Timestamp + "true-when-written"** — every memory carries write date (ChatGPT bio format `[2025-05-02]…`); display age so stale info is visibly stale.
- **Provenance / source attribution** — record where it came from; rank **user statement >> agent inference >> ingested content**; store agent inferences as explicitly low-trust.
- **Verify-before-trust** — re-check the supporting citation against current state before applying (Copilot); for code, confirm the cited file still supports the fact.
- **Contradiction handling** — on a new fact conflicting with old, **prefer newest (temporal versioning)** and mark the old one obsolete/invalid rather than silently overwriting (Mem0g keeps it for temporal reasoning); when ambiguous, **flag for the user** instead of guessing.
- **Reflection with external validation** — synthesize higher-level insights (Generative Agents/Reflexion) but validate beliefs externally before they become trusted (survey: "trustworthy reflection").
- **Scope isolation** — global vs project vs session tiers; never let project facts cross into other projects (ChatGPT Project-only memory; Windsurf workspace scoping).
- **Trust tiers by capture method** — durable = hand-authored rules / `AGENTS.md`; best-effort = auto-generated memory (Windsurf's explicit split). Don't let auto-memory masquerade as a contract.

**Capture UX & user control (cross-product consensus)**
- **Transparency:** show what's stored and what's loaded each session; the #1 complaint against ChatGPT's derived profile is that it's invisible.
- **Reversibility:** view / edit / delete / export every entry; Temporary/no-memory mode for sensitive work.
- **Confirmation for inferred saves:** explicit instructions can auto-save; *inferred* facts should be surfaced and easily corrected (CLAUDE.md "edit MEMORY.md directly").
- **Concision discipline:** load-bearing facts only; "materially changes decisions, not re-derivable from the workspace" (Anthropic ≤~15 rules / ≤500 lines).

---

## Executive summary — 10 most actionable findings

1. **Separate trust tiers explicitly.** Hand-authored rules/`AGENTS.md` = durable contract; auto-generated memory = best-effort. Windsurf and Claude Code both draw this line; never let auto-memory pose as a contract. Tag every memory with its source: user-stated >> agent-inferred >> ingested-content.
2. **Ship a decay mechanism on day one — it's the single biggest gap in academia and the biggest payoff in products.** Copilot's use-it-or-lose-it (delete after 28 days unused, timer resets on validated use) is the proven, simple win. MemoryBank's `R=e^(-t/S)` is the option if you want graceful fade in scoring.
3. **Drift's root cause is "related≠relevant, previously-true≠still-true."** Counter it with timestamps ("true-when-written"), verify-before-trust (re-check the citation before applying — Copilot), and temporal versioning (prefer newest, mark old obsolete — Mem0g).
4. **Signal-vs-noise rule:** store only if (a) true beyond this task, (b) likely to change a future decision, (c) not cheaply re-derivable from the workspace. Fail any → don't store. This kills transient task state, chit-chat, and re-derivable facts.
5. **Never store secrets, credentials, or sensitive personal data** (health/finance) unless explicitly asked; strip on the write path — don't trust the model to always refuse (Anthropic warns it only "usually" refuses).
6. **Write is not append.** Run a consolidation pass (ADD/UPDATE/DELETE/NOOP — Mem0) with importance scoring and dedup; otherwise you get the ADD-only junk-accumulation bug and retrieval precision rots.
7. **Scope hard: global / project / session.** Cross-project bleed is ChatGPT's most cited failure (client fact attributed to user). ChatGPT had to ship Project-only memory; design it in from the start.
8. **Make memory fully inspectable, editable, deletable, exportable.** ChatGPT's invisible derived profile is its top trust/privacy complaint and got it blocked in the EU. Also show *what loaded this session* — silent scoping failures (Cursor) destroy trust.
9. **Capture corrections and outcomes, not transcripts.** Reflexion-style "this failed because…" memories are cheap and high-value; but tag agent inferences as low-trust to avoid self-reinforcing error ("API X always errors → avoided forever").
10. **Treat ingested/tool content as adversarial.** Indirect prompt injection survives summarization into persistent memory and corrupts all future sessions (Unit 42). Sanitize on write, allowlist sources, isolate per-scope, and never promote raw untrusted output to trusted memory.

---
*Sources are linked inline throughout. Primary docs and papers preferred: OpenAI Help Center/blog, Anthropic platform docs, GitHub & Windsurf official docs, Palo Alto Unit 42, and arXiv (Park 2023, Shinn 2023, MemoryBank 2023, A-MEM 2025, Mem0 2025, and the 2026 agent-memory survey).*
