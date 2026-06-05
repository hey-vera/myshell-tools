/**
 * src/core/surface-capabilities.ts — the two-chat-surfaces capability matrix
 * (whole-tool-finish-5.5.md §4), as DATA + a divergence guard.
 *
 * The menu chat is the FULL experience; `repl.ts` is the lean, scriptable subset
 * — and that asymmetry is intentional, named, and bounded. This module commits
 * the matrix to code so a feature that wants to appear in the REPL must add a row
 * (forcing an explicit decision), and a divergence-guard test asserts the REPL's
 * wired capabilities are a documented SUBSET of the menu's — so adding a
 * menu-only feature without deciding its REPL status fails the test.
 *
 * The load-bearing design (§4.3): memory INJECTION and the intent FRAME are
 * "deps/prompt" concerns, not UI — so the SHARED core delivers them to both
 * surfaces automatically. The REPL gets sharper, memory-aware answers for free;
 * only the interactive WRITE/visible affordances are absent.
 *
 * This module is PURE: no I/O, no time, no randomness (`test/arch/guards.ts`).
 */

/** The capabilities a chat surface may carry. */
export type SurfaceCapability =
  | 'coreAnswer' // routing/panel/hedge — the shared core (runTask→orchestrate)
  | 'memoryInjection' // read-only memory in the prompt (deps concern, not UI)
  | 'memoryApproval' // interactive Save/Skip selector (write) — TUI only
  | 'intentFrame' // internal intent sharpening of the prompt (deps concern)
  | 'intentReflection' // the visible "what I understood" line — TUI only
  | 'recap' // ※ recap on resume / /recap — needs a resume/session model
  | 'writeApproval' // any blocking interactive approval selector
  | 'queueAndEsc' // typed-ahead queue + ESC interrupt — TUI only
  | 'slashCommands'; // /style /mode /memory /goal — the rich command set

/** Which surface a capability matrix row describes. */
export interface SurfaceMatrixRow {
  readonly capability: SurfaceCapability;
  /** Present in the menu chat (the full experience)? */
  readonly menu: boolean;
  /** Present in the REPL v1 (the lean subset)? */
  readonly repl: boolean;
  /** One-line rationale (why the REPL diverges, or why it shares). */
  readonly why: string;
}

/**
 * The capability matrix (§4.2), as enforced data. Every capability appears
 * exactly once. The invariant the divergence guard checks: every `repl:true`
 * capability is also `menu:true` (the REPL is a SUBSET — never has a capability
 * the menu lacks). Frozen so a test mutation can't accidentally pass.
 */
export const SURFACE_MATRIX: readonly SurfaceMatrixRow[] = [
  {
    capability: 'coreAnswer',
    menu: true,
    repl: true,
    why: 'shared core (runTask→orchestrate) — identical on both surfaces',
  },
  {
    capability: 'memoryInjection',
    menu: true,
    repl: true,
    why: 'a deps/prompt concern threaded through assembleContextBlocks — both build the same deps, so the REPL gets memory-aware answers for free (read-only, no approval UI)',
  },
  {
    capability: 'memoryApproval',
    menu: true,
    repl: false,
    why: 'requires an interactive Save/Skip selector, meaningless/blocking in a pipe — proposals are simply not surfaced in the REPL (dropped, not queued)',
  },
  {
    capability: 'intentFrame',
    menu: true,
    repl: true,
    why: 'a deps/prompt concern, not UI — the REPL benefits from sharper prompts with no visible reflection line',
  },
  {
    capability: 'intentReflection',
    menu: true,
    repl: false,
    why: 'a TUI affordance; the REPL stays terse',
  },
  {
    capability: 'recap',
    menu: true,
    repl: false,
    why: 'the REPL has no resume/session-list model; it is stateless-per-line',
  },
  {
    capability: 'writeApproval',
    menu: true,
    repl: false,
    why: 'a blocking selector would hang a non-TTY pipe — wrong for a scriptable REPL by construction',
  },
  {
    capability: 'queueAndEsc',
    menu: true,
    repl: false,
    why: 'by construction (rl.pause()) — Ctrl+C aborts the in-flight AbortController, the correct REPL idiom',
  },
  {
    capability: 'slashCommands',
    menu: true,
    repl: false,
    why: 'the REPL keeps its minimal /help /exit /quit set; the rich commands live in the menu chat',
  },
] as const;

/**
 * The capabilities the REPL is wired to carry — derived from the matrix so the
 * single source of truth is the data above. Returns the `repl:true` rows.
 */
export function replCapabilities(): readonly SurfaceCapability[] {
  return SURFACE_MATRIX.filter((r) => r.repl).map((r) => r.capability);
}

/** The capabilities the menu chat carries (the superset). */
export function menuCapabilities(): readonly SurfaceCapability[] {
  return SURFACE_MATRIX.filter((r) => r.menu).map((r) => r.capability);
}

/**
 * The divergence invariant (§4.4): every REPL capability is ALSO a menu
 * capability (the REPL is a documented subset, never a superset). Returns the
 * list of violating capabilities (REPL-only) — empty when the invariant holds.
 * A guard test asserts this is empty. PURE.
 */
export function replDivergence(): readonly SurfaceCapability[] {
  const menu = new Set(menuCapabilities());
  return replCapabilities().filter((c) => !menu.has(c));
}
