/**
 * detect.mjs — CLI detection and auth status checking for Claude and Codex
 * Adapted from archive/dual-brain/install.mjs
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const IS_WINDOWS = process.platform === 'win32';
const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';

function run(cmd, args = [], options = {}) {
  try {
    return spawnSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      shell: IS_WINDOWS,
      ...options
    });
  } catch (err) {
    return { status: -1, stdout: '', stderr: err.message };
  }
}

/**
 * Detect Claude CLI installation and authentication status
 */
export function detectClaude() {
  const result = {
    installed: false,
    version: null,
    authed: false,
    models: [],
    bin: 'claude'
  };

  // Try to get version
  const ver = run('claude', ['--version']);
  if (ver.status === 0 && ver.stdout.trim()) {
    result.installed = true;
    result.version = ver.stdout.trim().split('\n')[0];
  }

  // Fallback: check if claude exists in PATH
  if (!result.installed) {
    const which = run(WHICH_CMD, ['claude']);
    if (which.status === 0 && which.stdout.trim()) {
      result.installed = true;
      result.bin = which.stdout.trim();
    }
  }

  // Check authentication via credential files
  const credPaths = [
    join(process.env.HOME || process.env.USERPROFILE || '', '.claude', '.credentials.json'),
    join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'credentials.json'),
    resolve(process.cwd(), '.replit-tools', '.claude-persistent', '.credentials.json'),
  ];

  for (const p of credPaths) {
    try {
      const cred = JSON.parse(readFileSync(p, 'utf8'));
      if (cred.claudeAiOauth || cred.apiKey || cred.oauth_token) {
        result.authed = true;
        break;
      }
    } catch {}
  }

  // Fallback: check auth status command
  if (!result.authed && result.installed) {
    const auth = run('claude', ['auth', 'status']);
    const out = ((auth.stdout || '') + (auth.stderr || '')).toLowerCase();
    if (out.includes('logged in') || out.includes('authenticated') || out.includes('valid')) {
      result.authed = true;
    }
  }

  // If installed and authed, assume standard models are available
  if (result.installed && result.authed) {
    result.models = ['opus', 'sonnet', 'haiku'];
  }

  return result;
}

/**
 * Detect Codex CLI installation and authentication status
 */
export function detectCodex() {
  const result = {
    installed: false,
    version: null,
    authed: false,
    path: null,
    models: []
  };

  // Try which first
  const which = run(WHICH_CMD, ['codex']);
  if (which.status === 0 && which.stdout.trim()) {
    result.path = which.stdout.trim();
    result.installed = true;
  }

  // Try common fallback locations
  if (!result.installed) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const fallbacks = [
      join(home, '.local', 'bin', 'codex'),
      join(home, 'bin', 'codex'),
      '/usr/local/bin/codex',
    ];
    for (const p of fallbacks) {
      if (existsSync(p)) {
        result.path = p;
        result.installed = true;
        break;
      }
    }
  }

  if (result.installed && result.path) {
    // Get version
    const ver = run(result.path, ['--version']);
    if (ver.status === 0) {
      result.version = ver.stdout.trim().split('\n')[0];
    }

    // Check login status
    const login = run(result.path, ['login', 'status']);
    const out = ((login.stdout || '') + (login.stderr || '')).toLowerCase();
    if (login.status === 0 || out.includes('logged in') || out.includes('authenticated')) {
      result.authed = true;
    }

    // If installed and authed, assume standard models
    if (result.authed) {
      result.models = ['gpt-5.5', 'gpt-5.4', 'gpt-4.1-mini'];
    }
  }

  return result;
}

/**
 * Detect all available providers and their capabilities
 */
export function detectEnvironment() {
  const claude = detectClaude();
  const codex = detectCodex();

  return {
    claude,
    codex,
    hasProviders: (claude.installed && claude.authed) || (codex.installed && codex.authed),
    workspace: resolve(process.cwd())
  };
}

/**
 * Get available models organized by tier
 */
export function getAvailableModels(env) {
  const models = {
    worker: [],
    ic: [],
    manager: []
  };

  if (env.claude.installed && env.claude.authed) {
    models.worker.push({ provider: 'claude', model: 'haiku', bin: env.claude.bin });
    models.ic.push({ provider: 'claude', model: 'sonnet', bin: env.claude.bin });
    models.manager.push({ provider: 'claude', model: 'opus', bin: env.claude.bin });
  }

  if (env.codex.installed && env.codex.authed) {
    models.worker.push({ provider: 'codex', model: 'gpt-4.1-mini', bin: env.codex.path });
    models.ic.push({ provider: 'codex', model: 'gpt-5.4', bin: env.codex.path });
    models.manager.push({ provider: 'codex', model: 'gpt-5.5', bin: env.codex.path });
  }

  return models;
}