# R-1 authority reconciliation receipt

Date: 2026-07-12

Scope: documentation authority only. Runtime behavior, source, tests, package metadata, credentials, provider accounts, and the preserved 13-commit feature branch are unchanged.

## Changes

- Added the user-approved `CLAUDEPLAN.md` as the active implementation plan.
- Updated `CLAUDE.md` to name `CLAUDEPLAN.md` and the compact roadmap as current authority.
- Replaced stale release instructions with the R9/packed-artifact/manual-publish release boundary.
- Replaced the stale roadmap with a compact audited baseline and ordered R-1 through R9 sequence.
- Removed the accidental read-only-workspace preamble from the vendor-neutral routing spec.
- Restored the missing capability-registry path as an explicit historical pointer to the archived design.

## Windows Unicode patch transport

Windows PowerShell 5.1 corrupts some multiline UTF-8 patch arguments. The confirmed transport is to Base64-encode the patch inside PowerShell, pass only ASCII across the shell boundary, decode in Node, and invoke the required patch engine with a native argument array:

```powershell
$patch = @'
*** Begin Patch
*** Update File: path/to/file.md
@@
-old text
+new text
*** End Patch
'@

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($patch))
node -e "const {spawnSync}=require('child_process'); const p=Buffer.from(process.argv[1],'base64').toString('utf8'); const r=spawnSync(process.execPath,['C:/Users/Josh/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js','--codex-run-as-apply-patch',p],{stdio:'inherit'}); process.exit(r.status ?? 1)" $b64
```

This remains an `apply_patch` operation; Base64 is transport encoding only.

## Validation

Record final command evidence before the R-1 commit/PR:

- `npx prettier --check CLAUDEPLAN.md CLAUDE.md RELEASE.md docs/ROADMAP-STATUS.md docs/model-capability-registry-5.6.md docs/receipts/r-minus-1-authority-reconciliation.md`
- focused assertion that the accidental preamble is absent from `docs/vendor-neutral-routing-spec.md` (the legacy spec is pre-existing Prettier-nonconformant; whole-file reformat is deliberately out of scope)
- `git diff --check`
- link/reference checks for the active plan, roadmap, release file, vendor spec, and capability-registry pointer
- confirm no `src/`, `test/`, package, credential, or old feature-branch changes
