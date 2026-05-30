/**
 * src/providers/detect.ts
 *
 * Provider-detection logic.
 *
 * Claude detection is REAL: spawns `claude --version` to probe installation.
 * Codex detection is REAL: spawns `codex --version` to probe installation.
 * Authentication is OPTIMISTIC for both — we cannot cheaply probe auth state
 * without spending API quota. The real auth state surfaces at run time and is
 * classified by errors.ts (category 'auth').
 */

import { execa } from 'execa';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  readonly id: 'claude' | 'codex';
  readonly installed: boolean;
  readonly version: string | null;
  readonly authenticated: boolean;
  readonly binaryPath: string | null;
  readonly availableModels: readonly string[];
}

export interface EnvironmentStatus {
  readonly claude: ProviderStatus;
  readonly codex: ProviderStatus;
  readonly hasAnyProvider: boolean;
  readonly platform: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Internal factory
// ---------------------------------------------------------------------------

function notDetected(id: 'claude' | 'codex'): ProviderStatus {
  return {
    id,
    installed: false,
    version: null,
    authenticated: false,
    binaryPath: null,
    availableModels: [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether a provider CLI is installed and (optimistically) usable.
 *
 * For 'claude': runs `claude --version` to confirm the binary is present and
 * executable. Authentication is reported as `true` optimistically — we cannot
 * cheaply probe auth state without spending API quota. If the user is not
 * authenticated, the real auth failure surfaces at run time via classifyError()
 * (category 'auth').
 *
 * For 'codex': runs `codex --version` to confirm the binary is present and
 * executable. Authentication is reported as `true` optimistically for the same
 * reason — real auth failures surface at run time via classifyError().
 */
export async function detectProvider(
  id: 'claude' | 'codex',
): Promise<ProviderStatus> {
  if (id === 'claude') {
    try {
      const result = await execa('claude', ['--version'], {
        reject: false,
        timeout: 10_000,
      });

      if (result.exitCode === 0) {
        return {
          id: 'claude',
          installed: true,
          version: (result.stdout as string).trim(),
          binaryPath: 'claude',
          availableModels: ['opus', 'sonnet', 'haiku'],
          /**
           * Authentication is OPTIMISTIC: we assume the user is authenticated
           * if the binary is installed. The real auth state surfaces at run
           * time when classifyError() maps an auth-related stderr to 'auth'.
           */
          authenticated: true,
        };
      }
    } catch {
      // Binary not found or spawn error — fall through to notDetected
    }

    return notDetected('claude');
  }

  // codex: run `codex --version` to probe installation
  try {
    const result = await execa('codex', ['--version'], {
      reject: false,
      timeout: 10_000,
    });

    if (result.exitCode === 0) {
      return {
        id: 'codex',
        installed: true,
        version: (result.stdout as string).trim(),
        binaryPath: 'codex',
        availableModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
        /**
         * Authentication is OPTIMISTIC: we assume the user is authenticated
         * if the binary is installed. The real auth state surfaces at run
         * time when classifyError() maps an auth-related stderr to 'auth'.
         */
        authenticated: true,
      };
    }
  } catch {
    // Binary not found or spawn error — fall through to notDetected
  }

  return notDetected('codex');
}

/**
 * Detect the full environment — both providers — in parallel.
 *
 * Stub: delegates to detectProvider for each provider ID.
 */
export async function detectEnvironment(): Promise<EnvironmentStatus> {
  const [claude, codex] = await Promise.all([
    detectProvider('claude'),
    detectProvider('codex'),
  ]);

  return {
    claude,
    codex,
    hasAnyProvider: claude.installed || codex.installed,
    platform: process.platform,
  };
}

/**
 * Return the shell command a user should run to install the given provider.
 */
export function getInstallCommand(id: 'claude' | 'codex'): string {
  switch (id) {
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code';
    case 'codex':
      return 'npm install -g @openai/codex';
  }
}
