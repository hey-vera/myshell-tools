# test-all-on.ps1 — launch myshell-tools with ALL new intelligence-layer flags ON (dogfooding).
# These flags are default-OFF in code (off = byte-identical). This script enables them for
# THIS run only via the environment, so the test suite / normal launches stay unaffected.
# Usage:  ./scripts/test-all-on.ps1 [any myshell args]

$env:MYSHELL_CACHE_ACCOUNTING_V2    = '1'  # honest cache-write + effective-$ accounting
$env:MYSHELL_ACCOUNT_AUX            = '1'  # ledger route/intent/auto-stage/etc. + intentVersionId stamping
$env:MYSHELL_INTENT_STORE_V1        = '1'  # append-only intent-version store (keystone)
$env:MYSHELL_CORRECTION_FORK_V1     = '1'  # reversible correction (needs INTENT_STORE on — it is)
$env:MYSHELL_BLOCKED_STATE_V1       = '1'  # honest BLOCKED terminals
$env:MYSHELL_EVIDENCE_RECEIPT_V2    = '1'  # proof-of-done receipts
$env:MYSHELL_NATIVE_SESSIONS_PROMOTE = '1' # promote native-session reuse + telemetry

Write-Host "[test-all-on] All 7 new flags enabled. Launching myshell-tools from source via tsx..." -ForegroundColor Cyan

# Run from source (no build needed). If you've built (npm run build), you can instead run: node dist/cli.js
node --import tsx/esm src/cli.ts @args
