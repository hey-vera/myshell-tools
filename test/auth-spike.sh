#!/usr/bin/env bash
#
# test/auth-spike.sh — auth-state smoke test for the 6 core provider flows.
#
# Validates sign-in state WITHOUT exfiltrating tokens:
#   - Claude/Codex/Grok: OAuth subscription auth only (no API-key path).
#   - OpenCode: accepts either OAuth or a gateway/API key (the sole exception).
#
# Each flow is fail-soft: a missing binary or failed probe is reported honestly
# as "not authed / not installed" rather than failing the whole script. Tokens
# are never echoed; only boolean state + public plan/tier labels are printed.
#
# Linux primary. macOS differences noted inline (Keychain-backed CLIs, different
# opencode config path). Refresh-in-place only: this script reads already-stored
# credential state and may trigger an in-place refresh via the provider's own
# CLI, but it never copies a token out of the machine.

set -u

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

QUIET="${QUIET:-0}"

say() {
  if [[ "$QUIET" != "1" ]]; then
    printf '%s\n' "$*"
  fi
}

err() {
  printf 'ERR: %s\n' "$*" >&2
}

has_bin() {
  command -v "$1" >/dev/null 2>&1
}

# Parse Claude's `auth status` JSON without exposing secrets.
# Output: "authenticated=true|false plan=..."
probe_claude() {
  if ! has_bin claude; then
    say "claude: not installed"
    return 0
  fi

  local version
  version=$(claude --version 2>/dev/null | head -n1)
  say "claude: installed ($version)"

  local out
  if ! out=$(claude auth status 2>/dev/null); then
    say "claude: auth check failed (not authenticated)"
    return 0
  fi

  # The CLI prints JSON on success. We only read loggedIn + subscriptionType.
  local logged_in plan
  logged_in=$(printf '%s' "$out" | sed -n 's/.*"loggedIn"[: ]*\(true\|false\).*/\1/p' | head -n1)
  plan=$(printf '%s' "$out" | sed -n 's/.*"subscriptionType"[: ]*"\([^"]*\)".*/\1/p' | head -n1)

  if [[ "$logged_in" == "true" ]]; then
    if [[ -n "$plan" ]]; then
      say "claude: authenticated (plan: $plan)"
    else
      say "claude: authenticated (plan unknown)"
    fi
  else
    say "claude: not authenticated"
  fi
}

# Parse Codex's `login status` text output. No API-key path is used.
probe_codex() {
  if ! has_bin codex; then
    say "codex: not installed"
    return 0
  fi

  local version
  version=$(codex --version 2>/dev/null | head -n1)
  say "codex: installed ($version)"

  local out
  # codex login status writes to stderr in some versions; merge both.
  if ! out=$(codex login status 2>&1); then
    say "codex: auth check failed (not authenticated)"
    return 0
  fi

  if printf '%s' "$out" | grep -qi "logged in"; then
    say "codex: authenticated"
  else
    say "codex: not authenticated"
  fi
}

# Parse Grok's `models` output.
probe_grok() {
  if ! has_bin grok; then
    say "grok: not installed"
    return 0
  fi

  local version
  version=$(grok --version 2>/dev/null | head -n1)
  say "grok: installed ($version)"

  local out
  if ! out=$(grok models 2>/dev/null); then
    say "grok: auth check failed (not authenticated)"
    return 0
  fi

  if printf '%s' "$out" | grep -qi "not authenticated"; then
    say "grok: not authenticated"
  else
    say "grok: authenticated"
  fi
}

# Resolve opencode's auth.json path. Linux uses XDG_DATA_HOME or ~/.local/share.
# macOS note: opencode stores config under ~/Library/Application Support/opencode.
resolve_opencode_auth_path() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    printf '%s/Library/Application Support/opencode/auth.json' "$HOME"
  else
    local base
    if [[ -n "${XDG_DATA_HOME:-}" ]]; then
      base="$XDG_DATA_HOME"
    else
      base="$HOME/.local/share"
    fi
    printf '%s/opencode/auth.json' "$base"
  fi
}

# Probe OpenCode: installed check + credential classification.
# Reads auth.json to see whether there is an oauth credential and/or an api key.
# The secret value is never printed.
probe_opencode() {
  if ! has_bin opencode; then
    say "opencode: not installed"
    return 0
  fi

  local version
  version=$(opencode --version 2>/dev/null | head -n1)
  say "opencode: installed ($version)"

  local auth_path
  auth_path=$(resolve_opencode_auth_path)
  if [[ ! -f "$auth_path" ]]; then
    say "opencode: no auth.json found at $auth_path (not authenticated)"
    return 0
  fi

  local raw
  raw=$(cat "$auth_path")

  local oauth_count api_count
  oauth_count=$(printf '%s' "$raw" | grep -c '"type"[[:space:]]*:[[:space:]]*"oauth"' || true)
  api_count=$(printf '%s' "$raw" | grep -c '"type"[[:space:]]*:[[:space:]]*"api"' || true)

  if [[ "$oauth_count" -gt 0 && "$api_count" -gt 0 ]]; then
    say "opencode: authenticated (oauth + api key)"
  elif [[ "$oauth_count" -gt 0 ]]; then
    say "opencode: authenticated (oauth)"
  elif [[ "$api_count" -gt 0 ]]; then
    say "opencode: authenticated (api key)"
  else
    say "opencode: not authenticated (no recognized credentials)"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  say "auth-spike: provider sign-in state (no token exfiltration)"
  say ""

  # The 6 core auth flows:
  #   1. Claude OAuth subscription (claude auth status)
  #   2. Codex OAuth subscription (codex login status)
  #   3. Grok OAuth subscription (grok models)
  #   4. OpenCode install check (opencode --version)
  #   5. OpenCode OAuth credential (auth.json type=oauth)
  #   6. OpenCode API key credential (auth.json type=api)
  probe_claude
  probe_codex
  probe_grok
  probe_opencode

  say ""
  say "auth-spike complete."
}

main "$@"
