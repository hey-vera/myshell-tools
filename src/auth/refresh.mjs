/**
 * refresh.mjs — OAuth token refresh system for Claude and Codex
 * Adapted from archive/dual-brain/install.mjs
 */

import https from 'https';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { atomicWriteJSON } from '../state/atomic.mjs';

/**
 * HTTP POST form helper
 */
function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(new URLSearchParams(body).toString(), 'utf8');
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': payload.length,
      },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode || 0}: ${raw}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Safe JSON parsing with fallback
 */
function safeParseJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Decode JWT payload without verification
 */
function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    return null;
  }
}

/**
 * Compute expiration time in hours
 */
function computeExpiresInHours(expiresAtMs) {
  if (!Number.isFinite(expiresAtMs)) return null;
  return Math.round(((expiresAtMs - Date.now()) / 3_600_000) * 10) / 10;
}

/**
 * Get potential Claude credential file paths
 */
function getClaudeCredentialPaths(workspace = process.cwd()) {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const home = process.env.HOME || '';
  return [
    configDir ? join(configDir, '.credentials.json') : null,
    join(home, '.claude', '.credentials.json'),
    join(home, '.claude', 'credentials.json'),
    resolve(workspace, '.replit-tools', '.claude-persistent', '.credentials.json'),
  ].filter(Boolean);
}

/**
 * Get Codex auth file path
 */
function getCodexAuthPath() {
  const home = process.env.HOME || '';
  return join(home, '.codex', 'auth.json');
}

/**
 * Refresh Claude OAuth token
 */
async function refreshClaudeToken() {
  const credPaths = getClaudeCredentialPaths();

  for (const credPath of credPaths) {
    if (!existsSync(credPath)) continue;

    try {
      const cred = safeParseJson(credPath);
      const oauth = cred?.claudeAiOauth;
      if (!oauth?.refreshToken) continue;

      const refreshed = await postForm('https://console.anthropic.com/v1/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      });

      const nextOauth = {
        ...oauth,
        accessToken: refreshed.access_token || oauth.accessToken,
        refreshToken: refreshed.refresh_token || oauth.refreshToken,
        tokenType: refreshed.token_type || oauth.tokenType,
        scopes: refreshed.scope || oauth.scopes,
        expiresAt: Date.now() + ((refreshed.expires_in || 0) * 1000),
      };

      const updated = { ...cred, claudeAiOauth: nextOauth };
      atomicWriteJSON(credPath, updated);

      return {
        success: true,
        provider: 'claude',
        expiresInHours: computeExpiresInHours(nextOauth.expiresAt),
        refreshed: true
      };
    } catch (error) {
      return {
        success: false,
        provider: 'claude',
        action: 'reauth_required',
        error: error.message
      };
    }
  }

  return {
    success: false,
    provider: 'claude',
    action: 'no_credentials',
    error: 'No Claude credentials found'
  };
}

/**
 * Refresh OpenAI/Codex token
 */
async function refreshOpenAIToken() {
  const authPath = getCodexAuthPath();

  if (!existsSync(authPath)) {
    return {
      success: false,
      provider: 'openai',
      action: 'no_credentials',
      error: 'No Codex auth file found'
    };
  }

  try {
    const auth = safeParseJson(authPath);
    const tokens = auth?.tokens || auth;
    const refreshToken = tokens?.refresh_token;

    if (!refreshToken) {
      return {
        success: false,
        provider: 'openai',
        action: 'no_refresh_token',
        error: 'No refresh token available'
      };
    }

    const refreshed = await postForm('https://auth.openai.com/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });

    const updatedTokens = {
      ...tokens,
      access_token: refreshed.access_token || tokens.access_token,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
      id_token: refreshed.id_token || tokens.id_token,
      token_type: refreshed.token_type || tokens.token_type,
      scope: refreshed.scope || tokens.scope,
    };

    const updated = auth?.tokens ? { ...auth, tokens: updatedTokens } : updatedTokens;
    atomicWriteJSON(authPath, updated);

    const payload = decodeJwtPayload(updatedTokens.access_token);
    return {
      success: true,
      provider: 'openai',
      expiresInHours: payload?.exp ? computeExpiresInHours(payload.exp * 1000) : null,
      refreshed: true
    };
  } catch (error) {
    return {
      success: false,
      provider: 'openai',
      action: 'reauth_required',
      error: error.message
    };
  }
}

/**
 * Refresh all available tokens
 */
export async function refreshTokens() {
  const results = [];

  try {
    const claudeResult = await refreshClaudeToken();
    results.push(claudeResult);
  } catch (error) {
    results.push({
      success: false,
      provider: 'claude',
      error: error.message,
      action: 'reauth_required'
    });
  }

  try {
    const openaiResult = await refreshOpenAIToken();
    results.push(openaiResult);
  } catch (error) {
    results.push({
      success: false,
      provider: 'openai',
      error: error.message,
      action: 'reauth_required'
    });
  }

  const successful = results.filter(r => r.success);
  const needReauth = results.filter(r => r.action === 'reauth_required');

  return {
    success: successful.length > 0,
    results,
    refreshed: successful.filter(r => r.refreshed),
    needReauth: needReauth,
    hasValidAuth: successful.length > 0
  };
}

/**
 * Get refresh state file path
 */
function getRefreshStatePath() {
  const home = process.env.HOME || '';
  const dir = join(home, '.cortex', 'auth');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'refresh-state.json');
}

/**
 * Save refresh state for background processing
 */
export function saveRefreshState(results) {
  const statePath = getRefreshStatePath();
  const state = {
    lastRefresh: new Date().toISOString(),
    results,
    nextRefreshDue: new Date(Date.now() + (23 * 60 * 60 * 1000)).toISOString() // 23 hours
  };

  try {
    atomicWriteJSON(statePath, state);
  } catch (error) {
    console.warn('Failed to save refresh state:', error.message);
  }
}

/**
 * Load refresh state
 */
export function loadRefreshState() {
  const statePath = getRefreshStatePath();

  if (!existsSync(statePath)) {
    return null;
  }

  try {
    return safeParseJson(statePath);
  } catch {
    return null;
  }
}

/**
 * Check if refresh is due (run every 24 hours)
 */
export function isRefreshDue() {
  const state = loadRefreshState();
  if (!state?.nextRefreshDue) return true;

  return new Date() >= new Date(state.nextRefreshDue);
}

/**
 * Background token refresh with error handling
 */
export async function backgroundRefresh() {
  if (!isRefreshDue()) {
    return { skipped: true, reason: 'Not due for refresh' };
  }

  try {
    const results = await refreshTokens();
    saveRefreshState(results.results);

    return {
      success: true,
      hasValidAuth: results.hasValidAuth,
      refreshed: results.refreshed.map(r => r.provider),
      needReauth: results.needReauth.map(r => r.provider)
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Display refresh status to user
 */
export function displayRefreshStatus(refreshResult) {
  if (refreshResult.skipped) {
    return; // Silent when not due
  }

  if (refreshResult.success) {
    if (refreshResult.refreshed.length > 0) {
      console.log(`🔄 Refreshed tokens: ${refreshResult.refreshed.join(', ')}`);
    }

    if (refreshResult.needReauth.length > 0) {
      console.log(`\n⚠️  Re-authentication required for: ${refreshResult.needReauth.join(', ')}`);
      for (const provider of refreshResult.needReauth) {
        if (provider === 'claude') {
          console.log('  Run: claude auth login');
        } else if (provider === 'openai') {
          console.log('  Run: codex login');
        }
      }
    }
  } else if (refreshResult.error) {
    console.log(`⚠️  Token refresh failed: ${refreshResult.error}`);
  }
}