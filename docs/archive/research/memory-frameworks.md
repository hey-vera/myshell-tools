# Memory Systems for AI Agents — Architecture & Hard-Won Lessons

Research date: 2026-06-05. Audience: design input for a memory subsystem in `myshell-tools`, an end-user CLI that wraps Claude/Codex/OpenCode for arbitrary work. Emphasis: what makes a memory system *smart* (not just "saves stuff") and the documented failure modes (drift, staleness, over-capture, context bloat, conflicting memories).

Each system below is broken down by the 7 dimensions: (1) memory types/tiers, (2) write path, (3) curation (dedup/merge/update/conflict/decay), (4) retrieval, (5) drift/staleness handling, (6) user control, (7) documented pitfalls. Sources cited inline.

---

## 1. MemGPT / Letta

**Sources:**
- https://www.lmatlas.com/building-blocks/memgpt-letta
- https://docs.letta.com/guides/agents/architectures/sleeptime/
- https://www.letta.com/blog/agent-memory
- https://github.com/letta-ai/letta/issues/3116 (archival dedup gap)
- MemGPT paper background: https://docs.letta.com/concepts/letta/

**(1) Types/tiers.** OS-virtual-memory analogy. Three tiers:
- **Core memory** — small, lives *in* the context window (like RAM), pinned to the system prompt. Holds persona + key user facts/preferences. Organized as editable **memory blocks** (strings); blocks can be **shared across multiple agents**.
- **Recall memory** — searchable log of past conversation history (like a disk cache), out of context.
- **Archival memory** — external vector/DB store for long-term facts (cold storage), queried via tools.

**(2) Write path.** *Model-decided.* The agent self-edits memory by calling functions during its own reasoning loop: `core_memory_append`, `core_memory_replace` (edit in-context blocks), `archival_memory_insert`/`archival_memory_search`, `conversation_search`. The LLM itself decides when to "page out" (context→archival) and "page in" (archival→context), and can even edit its own system prompt ("self-modifying instructions"). There is no separate heuristic extractor — write cost is folded into normal token spend (per the SurePrompts comparison below).

**(3) Curation.** Core memory has consolidation tools (`rethink_memory`/`core_memory_replace`) — updates happen *in place* on blocks. **Archival memory has NO native dedup/consolidation** (see pitfalls). **Sleeptime agents** are the consolidation mechanism: a background agent shares memory with the primary agent and runs during idle periods to "consolidate fragmented memories into coherent entries, identify patterns, reorganize and deduplicate memory blocks, and archive and prune outdated information." Primary and sleeptime agents can run different models (fast model for chat, larger/slower for reflection) and at configurable frequency (higher frequency = more tokens, better-revised context). This is the "sleep-time compute" idea: spend compute when idle to improve "learned context."

**(4) Retrieval.** Core memory is always in-context (no retrieval needed). Recall = conversation search; archival = embedding search via tool calls. Retrieval is agent-initiated, not automatic injection.

**(5) Drift/staleness.** Mainly handled by in-place editing (replace, not append, in core) + sleeptime pruning of outdated info. No strong temporal/provenance model in core — this is comparatively weak vs. Zep.

**(6) User control.** Memory blocks are inspectable/editable strings; the system is designed to be transparent (you can read the system prompt and blocks). Open-source.

**(7) Pitfalls (author/community-documented).**
- **Archival memory accumulates redundant passages** — GitHub issue #3116 shows 4 passages all storing "user likes blue" because archival has no consolidation. Consequences they call out: redundant passages, retrieval inefficiency (more passages = slower search), storage/embedding cost overhead. Proposed fix is embedding-similarity dedup + LLM merge via sleeptime/background tasks.
- In-loop self-editing **adds tokens to every turn**; misusing Letta for stateless tools wastes tokens — its model assumes "memory is load-bearing and write decisions are themselves reasoning."

---

## 2. mem0 (mem0.ai)

**Sources:**
- Paper: https://arxiv.org/html/2504.19413v1
- https://docs.mem0.ai/core-concepts/memory-operations/add
- Failure-mode issue: https://github.com/mem0ai/mem0/issues/4896

**(1) Types.** Flat "facts" (salient extracted statements). Two backends: **Mem0** (dense text + vector DB) and **Mem0g** (directed labeled knowledge graph — entities as nodes, relations as edges). Built-in scoping by user / session / agent.

**(2) Write path.** *LLM extraction on every `add`* — a two-phase streaming pipeline:
- **Extraction phase** processes message pair `(m_{t-1}, m_t)` using three context sources: a retrieved conversation summary `S`, a recent message window (m=10 in experiments), and the current exchange. An extraction prompt φ produces candidate facts Ω.
- **Update/consolidation phase** for each candidate fact retrieves top-s semantically similar existing memories (s=10) and an **LLM function-caller chooses one of ADD / UPDATE / DELETE / NOOP** based on the semantic relationship. This is the "is this worth keeping + does it conflict" gate.

**(3) Curation.** Decision logic: ADD (new), UPDATE (augment/replace existing when info content increases), DELETE (contradicted/obsolete), NOOP (nothing changes). **Hash (MD5) dedup catches exact duplicates only**; semantic merge is the LLM's job. Mem0g marks conflicting relationships **invalid rather than physically removing** them, to enable temporal reasoning. Efficiency claim: ~7k tokens/conversation (Mem0) and ~14k (Mem0g) vs. 26k raw and 600k for Zep's then-approach.

**(4) Retrieval.** Mem0: semantic similarity (top-K) over the vector store, injected into the answer prompt. Mem0g: dual strategy — entity-centric graph traversal (explore in/out edges of query entities) + semantic-triplet matching against relationship triplets with a relevance threshold.

**(5) Drift/staleness.** Relies on the UPDATE/DELETE path to overwrite stale facts at write time, plus Mem0g's invalidate-don't-delete for temporal reasoning. *In practice this is fragile* (see pitfalls).

**(6) User control.** API to add/get/get_all/search/delete; explicit user/session/agent scoping; you can enumerate everything stored for a user. `infer=False` does a raw insert (skips extraction/conflict resolution).

**(7) Pitfalls (documented).**
- **The conflict-resolution implementation does not match the docs** (issue #4896, closed "not planned"). Repro: `add('my name is LGY')` then `add('my name is LGS')` yields **two ADD events, not an UPDATE** — both contradictory facts persist. Root cause: dedup is MD5-only; "latest truth wins" was advertised but not wired up. *Lesson: an LLM ADD/UPDATE/DELETE classifier is only as good as the prompt + retrieval recall feeding it, and silently degrades to "ADD everything," reintroducing contradictions.*
- `infer=False` raw inserts skip conflict resolution, so a later `infer=True` add of the same content creates a duplicate.
- Mem0g's graph adds little for single-hop queries and, per the paper, "does not provide performance gains" on multi-hop tasks either — "potential inefficiencies or redundancies in structured graph representations." *Graph structure is not free lunch.*
- Per-turn LLM extraction cost scales with conversation chattiness.

---

## 3. Zep / Graphiti (temporal knowledge graph)

**Sources:**
- Paper: https://arxiv.org/html/2501.13956v1 (and PDF https://arxiv.org/pdf/2501.13956)
- https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
- https://github.com/getzep/graphiti

**(1) Types.** Three hierarchical subgraphs:
- **Episode subgraph (G_e)** — raw messages/text/JSON; a *non-lossy* store from which everything else is extracted.
- **Semantic entity subgraph (G_s)** — entities + relationship edges extracted from episodes.
- **Community subgraph (G_c)** — clusters of strongly connected entities with high-level summaries (highest abstraction).

**(2) Write path.** Incremental, continuous integration (no batch recompute). New episodes are ingested and entities/edges extracted by an LLM; the system "instantly updates entities, relationships, and communities without batch recomputation." Crucially it *also ingests structured business data*, not just chat.

**(3) Curation — the standout feature.** **Bi-temporal model with four timestamps per edge:**
- `t_valid` / `t_invalid` (event timeline T) — when the fact *held true in the world*.
- `t'_created` / `t'_expired` (transaction timeline T') — when the system *learned/forgot* it.

When a new edge arrives, an LLM compares it against semantically related existing edges to detect contradiction. On a temporally-overlapping contradiction, the affected edge is **invalidated by setting its `t_invalid` to the `t_valid` of the invalidating edge — facts are invalidated, NOT deleted.** This preserves history and supports retroactive corrections without large-scale recomputation.

**(4) Retrieval.** Hybrid, **no LLM calls at query time** (for speed): cosine similarity (semantic) + BM25 (keyword) + breadth-first graph traversal (n-hop neighborhood). Results reranked via Reciprocal Rank Fusion, Maximal Marginal Relevance, episode-mention frequency, or a cross-encoder. P95 latency ~300ms per the Neo4j blog.

**(5) Drift/staleness — best in class.** This is the whole point: every fact carries validity windows + provenance (which episode it came from). You can query "what was true as of date X" and distinguish "wrong" from "no longer true." Contradictions invalidate rather than corrupt.

**(6) User control.** Facts trace back to source episodes (auditability); the graph is inspectable. Managed (Zep) + OSS (Graphiti).

**(7) Pitfalls/lessons (author-documented).**
- Built "from the ground up as memory infrastructure for dynamic agentic systems" — they explicitly warn against retrofitting RAG/GraphRAG-style query-focused summarization, which "struggles when data is updated frequently" and whose multi-step summarization "makes retrieval slow, often taking tens of seconds."
- Paper reports a significant accuracy drop on single-session-assistant questions (9–18%), "further research and engineering work is needed" — i.e., graph memory shines for cross-session/temporal reasoning, less for single-session.
- Operational weight: requires a graph DB (Neo4j) + LLM extraction on ingest; heavier than a notes file.

---

## 4. LangGraph / LangMem

**Sources:**
- https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- https://www.langchain.com/blog/langmem-sdk-launch
- https://docs.langchain.com/oss/python/langchain/long-term-memory

**(1) Types — the cleanest taxonomy (borrowed from cognitive science):**
- **Semantic** — facts/knowledge grounding responses. Two *shapes*: **Collections** (unbounded append-many docs; must reconcile new vs. existing to avoid over/under-extraction) and **Profiles** (a single document with a strict schema, e.g. user preferences — *updated in place, not appended*).
- **Episodic** — past experiences as few-shot examples capturing situation + reasoning + what made it succeed (distinct from raw facts).
- **Procedural** — *how the agent should behave*; encoded in and evolved via **system-prompt refinement** (prompt optimization), driven by feedback.

**(2) Write path — explicit two-mode framing:**
- **Conscious / hot-path** — form memory *during* the conversation; immediate, but "adds perceptible latency."
- **Subconscious / background** — reflect on the conversation *after* it ends; no user-facing latency and "higher recall of extracted information."
Memory managers handle ADD/UPDATE/reconcile. Prompt optimizers handle procedural memory.

**(3) Curation.** Collections require reconciliation logic (avoid duplicate/contradictory facts); Profiles avoid the problem by enforcing a schema and updating in place. Procedural memory "curation" = rewriting the system prompt from accumulated feedback.

**(4) Retrieval.** Storage-agnostic over LangGraph's `BaseStore` (vector DB or KV). Hierarchical **namespaces** for multi-tenancy; retrieval by direct key access, semantic search, or metadata filtering.

**(5) Drift/staleness.** Profile shape (update-in-place) is their primary anti-drift tool; collections are explicitly flagged as needing reconciliation or they drift.

**(6) User control.** Namespaced, store-agnostic, inspectable; you choose the backend.

**(7) Pitfalls/lessons.** They name the core tension explicitly: **collections over/under-extract and accumulate contradictions; profiles are safe but lossy/rigid.** Choose shape per data type. Hot-path = latency; background = staleness window. Procedural prompt optimization can over-fit to recent feedback.

---

## 5. Anthropic memory tool + context engineering

**Sources:**
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://platform.claude.com/cookbook/tool-use-memory-cookbook
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://code.claude.com/docs/en/memory (Claude Code CLAUDE.md)

**(1) Types.** Files in a `/memories` directory. No imposed taxonomy — the *model* organizes files (e.g. `progress.md`, `customer_service_guidelines.xml`, `refund_policies.xml`). The recommended multi-session pattern uses a **progress log + feature checklist + startup-script reference**. (Claude Code's `CLAUDE.md` is a related but separate, always-loaded project-memory file.)

**(2) Write path.** *Model-decided via tool calls.* Commands: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. An auto-injected system prompt enforces a **MEMORY PROTOCOL**: "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE … As you make progress, record status/progress/thoughts … ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any progress not recorded in your memory directory." Operates **client-side** — your app executes the file ops, so you control storage entirely.

**(3) Curation.** No automatic dedup. Anthropic explicitly provides an optional prompt to fight clutter: *"keep its content up-to-date, coherent and organized. You can rename or delete files that are no longer relevant. Do not create new files unless necessary."* You can also scope writes: *"Only write down information relevant to <topic>."* Curation is the model's job, nudged by prompt.

**(4) Retrieval.** **Just-in-time** — the agent keeps lightweight references (file paths) and loads content on demand rather than preloading. Pairs with **context editing** (clear old tool results client-side) and **compaction** (server-side summarization near the context limit). The pattern: compaction keeps active context small; memory persists what matters across compaction boundaries.

**(5) Drift/staleness.** Mostly manual: "ASSUME INTERRUPTION" + the discipline to update the progress log at session end + only mark work complete after *end-to-end verification* (keeps the progress log trustworthy, prevents scope creep compounding). No timestamps/provenance built in.

**(6) User control — total.** It's literally files you own and can read/edit/delete. ZDR-eligible.

**(7) Pitfalls/lessons (Anthropic-documented).**
- **Context rot:** "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases" — context is a finite resource; aim for "the smallest possible set of high-signal tokens."
- Files read every session start should stay **under ~500 lines** to keep startup context small.
- The model produces **cluttered memory files** without explicit anti-clutter prompting.
- Security: **path traversal** is a real risk — MUST validate all paths stay under `/memories`, reject `../`, URL-encoded traversal, etc. Also: track/cap file sizes, paginate large reads, expire stale files, strip sensitive data (the model usually refuses to write secrets but don't rely on it).
- Memory must be **bootstrapped deliberately**, not written ad hoc, or sessions can't reliably recover state.

---

## 6. Others (briefer)

**A-MEM (Agentic Memory, Zettelkasten-inspired).** Sources: https://arxiv.org/html/2502.12110v1, https://github.com/agiresearch/a-mem.
Each memory note = original content, timestamp, **LLM-generated keywords + tags + a contextual description**, embedding, and **links to other memories**. On write, it cosine-matches top-k existing notes and an LLM decides meaningful *links* (richer than similarity). Distinctive **memory evolution**: a new memory can trigger *updates to existing notes'* descriptions/tags (strengthen/merge/prune), so the network self-refines. No fixed/predetermined memory operations. Pitfall: organization quality "is influenced by the inherent capabilities of the underlying language models"; text-only, no multimodal.

**Cognee.** Sources: https://github.com/topoteretes/cognee, https://docs.cognee.ai/core-concepts/main-operations/cognify.
**ECL pipeline (Extract → Cognify → Load).** Cognify turns raw data into a **knowledge graph** (entities + typed relations), optionally grounded by **ontologies**, and combines a graph DB (relationships) + vector DB (semantic search) for hybrid retrieval. Ingests 30+ source types. Positioning: structured, ontology-grounded memory vs. naive chunk-and-embed.

**Comparative tradeoffs (SurePrompts).** Source: https://sureprompts.com/blog/agent-memory-architectures-compared-2026.
Practical write-cost map: Letta folds write cost into per-turn tokens; mem0 invokes an LLM on every `add`; vector RAG writes are just an embedding call (but **no structured updates — old and new contradictory facts both live in the index**); custom-schema cost is engineering up front, cheap at runtime; provider memory cost is bundled but **opaque (can't answer "what do you store about user X?")**. Decision rule: no orchestration control → provider memory; memory is load-bearing → Letta or custom; need user-scoped persistence → mem0 to ship fast, custom for mature products. Named anti-patterns: the "rebuild trap" (reimplementing mem0 worse), and "mixing architectures unchecked" (two writers, both stale, no merge story, no single source of truth).

---

## Patterns worth stealing (ranked)

1. **Tiered memory: small always-in-context core + large retrieved-on-demand store.** (MemGPT core/archival; Anthropic just-in-time + compaction.) Keep a tiny high-signal "always loaded" layer; page the rest in only when relevant. Directly counters context rot.
2. **Write-time consolidation via an LLM ADD/UPDATE/DELETE/NOOP decision** against the top-K semantically similar existing memories. (mem0.) Forces "does this already exist / does it conflict?" *before* storing — the single biggest lever against duplication and contradiction.
3. **Update-in-place for stable facts (profile shape), append + reconcile only for open-ended knowledge (collection shape).** (LangMem.) Pick the shape per data type; profiles structurally prevent drift.
4. **Bi-temporal facts: invalidate, don't delete; carry validity + provenance.** (Zep/Graphiti.) Lets you answer "what was true when," correct retroactively, and never silently corrupt behavior with a stale fact.
5. **Background/sleeptime consolidation off the hot path.** (Letta sleeptime, LangMem subconscious.) Do dedup/merge/prune/summarize when idle, with a possibly-larger model, so writes don't add user-facing latency.
6. **Hybrid retrieval with no LLM at query time** (semantic + keyword/BM25 + graph/recency), then rerank (RRF/MMR/cross-encoder). (Zep.) Fast and higher-recall than embeddings alone.
7. **Explicit, model-readable scoping/namespaces** (user / session / project / agent). (mem0, LangMem.) Prevents cross-context bleed and makes "everything about X" answerable.
8. **Distinguish semantic / episodic / procedural memory.** (LangMem.) Procedural memory as *system-prompt refinement* is a clean way to "learn how to behave" without a separate store.
9. **Memory as plain files the user owns + the agent self-edits via tools.** (Anthropic.) Maximal transparency and user control; trivially auditable/editable.
10. **"Assume interruption" + a progress log updated at session end, marked done only after verification.** (Anthropic.) Makes long multi-session work recoverable and keeps the log trustworthy.

## Anti-patterns / failure modes to avoid (ranked)

1. **Append-only / "ADD everything" memory.** Old + new contradictory facts coexist; retrieval surfaces either at random. This is vector-RAG's default and mem0's *actual* behavior when its conflict-resolution prompt mis-fires (issue #4896: two names both stored). **#1 cause of drift.**
2. **Exact-hash dedup as your only dedup.** Catches nothing semantically similar; you get 4 passages for "user likes blue" (Letta archival #3116, mem0 #4896).
3. **Context bloat / context rot.** Loading everything upfront degrades recall as token count grows. Don't keep a giant always-in-context blob.
4. **No provenance/timestamps.** Can't tell "wrong" from "stale," can't audit, can't reconcile contradictions — silent behavioral corruption.
5. **Over-capture (low signal-to-noise).** LLM extraction on every turn without a worth-keeping gate stores trivia, inflates cost, and pollutes retrieval. Cluttered files without anti-clutter prompting (Anthropic).
6. **Trusting an LLM ADD/UPDATE/DELETE classifier blindly.** It degrades quietly (mem0 #4896) — validate, log decisions, and make them inspectable/reversible.
7. **Mixing memory backends with no single source of truth.** Two writers, both stale, no merge story (SurePrompts). Designate one authoritative store per memory type.
8. **Graph-everything by default.** Graph memory added little/no gain for single- and multi-hop in mem0g; it adds latency, cost, and complexity. Use it only where relationship traversal is actually needed.
9. **Path-traversal / sensitive-data leaks in file-backed memory.** Validate paths under the memory root; strip/refuse secrets (Anthropic security notes).
10. **Hot-path memory formation that adds latency to every turn** when the workload is mostly stateless (Letta misuse) — match write cost to whether memory is load-bearing.

## Tips & tricks (concrete tactics)

- **Signal/noise gate at write time.** Run a cheap LLM (or heuristic) classifier: "Is this a durable, reusable fact/preference/decision, or transient chatter? If transient → NOOP." Only persisting high-signal items keeps retrieval clean and cheap.
- **Consolidate on write, not just on read.** Before storing, fetch top-K (≈10) similar memories and decide ADD/UPDATE/DELETE/NOOP. UPDATE-in-place for preferences and config; this is what stops contradictions accumulating.
- **Use the profile-vs-collection split.** Stable, low-cardinality things (user prefs, project config, tool defaults) → a single schema'd profile doc updated in place. Open-ended learnings → a collection with reconciliation.
- **Time-aware facts.** Stamp every memory with created-at + (where it makes sense) valid-from/valid-to. On contradiction, invalidate the old (keep it, mark superseded) rather than deleting. Lets you show history and answer "as of when."
- **Provenance everywhere.** Store where each memory came from (session id, file, command, turn) so the user can audit and you can verify-before-use.
- **Cap context hard.** Keep always-loaded memory tiny (Anthropic's ~500-line rule for session-start files) and retrieve the rest just-in-time. Paginate large reads.
- **Background consolidation.** Run dedup/merge/prune/summarize during idle time (or end-of-session), ideally with a stronger model than the chat loop. Keeps the hot path fast.
- **Scope aggressively.** Namespace by project/user/session; never let one project's memory leak into another. Make "show everything stored for scope X" a first-class operation.
- **Make it inspectable and reversible.** Plain files or a queryable store the user can view/edit/delete; log every automatic ADD/UPDATE/DELETE so a bad write can be undone.
- **Verify-before-use for behavior-shaping memory.** Before acting on a stored "fact"/preference, confirm it's still current (timestamp/validity check), especially for anything that changes how the tool behaves — prevents a stale memory silently corrupting work.
- **"Assume interruption."** Persist progress continuously; bootstrap a progress log deliberately at task start; mark items done only after end-to-end verification.
- **Don't reach for a graph unless relationships are the query.** Start with embeddings + recency + keyword; add a graph only when multi-entity traversal demonstrably helps.

---

*Compiled from primary papers (mem0 arXiv 2504.19413, Zep arXiv 2501.13956, A-MEM arXiv 2502.12110), official docs (Anthropic memory tool & context-engineering, LangMem, Letta sleeptime), engineering blogs (Neo4j/Graphiti, SurePrompts comparison), and real GitHub failure reports (mem0 #4896, letta #3116).*
