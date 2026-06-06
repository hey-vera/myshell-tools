/**
 * src/providers/port.ts — the Provider port (the keystone interface).
 *
 * The orchestration core talks to this interface and nothing vendor-specific.
 * Claude and Codex each ship an adapter that implements `Provider`.
 *
 * Design contract:
 *  - `run()` returns an AsyncIterable so the UI can stream real tokens/tools as
 *    they arrive and the core can compute real cost from the `usage` event.
 *  - The prompt in `ProviderRequest` is delivered to the child process via STDIN
 *    (never as a shell argument) — see spawn.ts.
 *  - `model` is always a concrete model id (resolved from an alias before this
 *    layer), never a tier name or alias.
 */

import type { CliError } from './errors.js';
import type { ProviderStatus } from './detect.js';

// Re-export the error type that appears in ProviderEvent so consumers of the
// port (e.g. the core orchestrator) can name it without reaching into errors.ts.
export type { CliError } from './errors.js';

/** Privilege ladder mapped onto each CLI's sandbox flags. Default is workspace-write. */
export type SandboxLevel = 'read-only' | 'workspace-write' | 'full-access';

export type ProviderId = 'claude' | 'codex' | 'opencode';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export interface ProviderRequest {
  /** Concrete model id, e.g. 'claude-sonnet-4-6' (never an alias at this layer). */
  readonly model: string;
  /** The full prompt; delivered via STDIN, not argv. */
  readonly prompt: string;
  /** Working directory the model operates in. */
  readonly cwd: string;
  /** Privilege level for model-initiated actions. */
  readonly sandbox: SandboxLevel;
  /** Hard wall-clock timeout for the run. */
  readonly timeoutMs: number;
  /**
   * EXPERIMENTAL native session continuity (opt-in). When set, the adapter uses
   * the provider's native session so prior context is carried server-side
   * instead of replayed in the prompt. Claude: `--session-id <id>` to establish,
   * `--resume <id>` to continue. Omitted → stateless one-shot (the default).
   */
  readonly sessionId?: string;
  /** With sessionId: true continues an existing session, false establishes it. */
  readonly resume?: boolean;
  /**
   * The selected reasoning-effort knob for this run (capability registry §3/§5).
   * Set ONLY when the chosen model's ModelCapability declares it supports the
   * effort (selectReasoningEffort returns a supported effort, or undefined). When
   * absent → no effort flag is threaded (byte-for-byte unchanged behaviour). Today
   * only the Codex adapter maps this to a CLI flag (`-c model_reasoning_effort=…`);
   * Claude/OpenCode ignore it (no stable per-model effort flag). Type-only import
   * to keep port.ts a leaf module.
   */
  readonly reasoningEffort?: import('../core/model-capabilities.js').ReasoningEffort;
  /**
   * Request the provider's NATIVE web-search tool for this run (provider-capability
   * audit opportunity #3). Set by the orchestrator ONLY when the turn genuinely
   * needs external/current facts — derived from the EXISTING engagement
   * WEB_RESEARCH determination (the knowledge-boundary predicate), so it never
   * fires on ordinary coding/local turns. When absent/false the adapter args are
   * byte-for-byte unchanged. TODAY only the Codex adapter honours this (appends
   * `-c tools.web_search=true` when the chosen codex model supportsSearchTool);
   * Claude/OpenCode ignore it (their CLI web-search invocation is unverified).
   */
  readonly webSearch?: boolean;
}

/**
 * Streaming events emitted by a provider run. Discriminated on `type`.
 * The terminal event is exactly one of `done` or `error`.
 */
export type ProviderEvent =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'reasoning'; readonly delta: string }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly phase: 'start' | 'end';
      readonly detail?: string;
    }
  | { readonly type: 'usage'; readonly usage: Usage }
  | {
      readonly type: 'done';
      readonly text: string;
      readonly usage?: Usage;
      /** Cost in USD as reported by the provider CLI, when available (preferred
       *  over estimating from the pricing table — it accounts for caching etc.). */
      readonly costUsd?: number;
      /**
       * Provider-assigned session/thread id, when the CLI reports one (e.g. Codex
       * `thread.started.thread_id`). Captured so a later turn can resume the
       * native session. Absent when the provider does not surface an id.
       */
      readonly sessionId?: string;
      readonly raw: unknown;
    }
  | { readonly type: 'error'; readonly error: CliError };

export interface Provider {
  readonly id: ProviderId;
  /** Probe install/auth/version/models. Cheap and cached by the adapter. */
  detect(): Promise<ProviderStatus>;
  /** Execute one request, streaming events until a terminal `done`/`error`. */
  run(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
