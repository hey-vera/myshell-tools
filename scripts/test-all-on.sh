#!/usr/bin/env bash
# test-all-on.sh — launch myshell-tools with ALL new intelligence-layer flags ON (dogfooding).
# These flags are default-OFF in code (off = byte-identical). This enables them for THIS run only
# via the environment, so the test suite / normal launches stay unaffected.
# Usage:  ./scripts/test-all-on.sh [any myshell args]
set -euo pipefail

export MYSHELL_CACHE_ACCOUNTING_V2=1     # honest cache-write + effective-$ accounting
export MYSHELL_ACCOUNT_AUX=1             # ledger route/intent/auto-stage/etc. + intentVersionId stamping
export MYSHELL_INTENT_STORE_V1=1         # append-only intent-version store (keystone)
export MYSHELL_CORRECTION_FORK_V1=1      # reversible correction (needs INTENT_STORE on — it is)
export MYSHELL_BLOCKED_STATE_V1=1        # honest BLOCKED terminals
export MYSHELL_EVIDENCE_RECEIPT_V2=1     # proof-of-done receipts
export MYSHELL_NATIVE_SESSIONS_PROMOTE=1 # promote native-session reuse + telemetry

echo "[test-all-on] All 7 new flags enabled. Launching myshell-tools from source via tsx..."
# Run from source (no build needed). If built (npm run build), you can instead run: node dist/cli.js
exec node --import tsx/esm src/cli.ts "$@"
