# Releasing myshell-tools

The implementation for **3.3.0** is complete and green on the
`feat/opencode-efficiency-v2.6.0` branch. The steps below are the only ones that
require a real environment (authenticated provider CLIs, your npm account) and so
must be run from your local clone — not the build sandbox.

Run them in order. Each is independent and safe to stop after.

---

## 0. Get the branch locally

```bash
git fetch && git checkout feat/opencode-efficiency-v2.6.0
npm ci
```

Requires **Node ≥ 22** for the test suite (the compiled `dist/` runs on Node ≥ 20).

## 1. Confirm the suite is green

```bash
npm run typecheck && npm run lint && npm run knip
npm test            # unit + architecture guards
npm run test:contract
npm run build
```

All should pass with zero failures (expected: ~1780 unit/arch + ~65 contract).

## 2. Verify the experimental native-session feature (needs authenticated claude + codex)

Native sessions ship **default-off** because only a live CLI can prove that
resuming a session actually carries context. This gated test proves it on *your*
setup, for both providers:

```bash
MYSHELL_NATIVE_SESSION_E2E=1 npm run test:integration
```

- **Green** → it works on your CLIs. Enable it: launch `myshell-tools`, then
  Settings → `[4] Native sessions`, or set `"nativeSessions": true` in
  `~/.myshell-tools/config.json`.
- **Red / skipped** → leave it off; the default history-replay path is used and
  nothing is degraded. Report which provider failed and the output.

## 3. Publish to npm (your account)

```bash
npm login            # if not already authenticated
npm publish          # prepublishOnly re-runs clean+typecheck+lint+build
```

`npm publish` will refuse if the version already exists, so bump
`package.json`'s `version` first if 3.3.0 is ever taken. After publishing, the
`latest` tag moves to 3.3.0 and the in-tool auto-update can reach
existing users.

## 4. Push the branch / open a PR

```bash
git push origin feat/opencode-efficiency-v2.6.0
# then open a PR into main, or merge per your workflow
```

## 5. Update your own install

```bash
npm install -g myshell-tools@latest
myshell-tools --version   # expect 3.3.0
```

If you had ever run it via `npx`, clear the stale cache so npx stops serving an
old version: `rm -rf ~/.npm/_npx`.

---

## Optional — demonstrate the cross-vendor review end-to-end

The headline differentiator (a *different vendor* reviews high-risk output) is
implemented and unit-tested, but only fires live with **two** authenticated
vendors. To see it:

```bash
myshell-tools login claude   # if not already
myshell-tools login codex    # the second vendor unlocks cross-vendor review
myshell-tools run "review this change for security issues: <a real high-risk task>"
```

Watch for a `Review by <other-vendor> (cross-vendor)` line in the output.

---

## What's intentionally not done

- **opencode native sessions** — opencode has no documented session-resume flag;
  it stays on the (correct) history-replay path. Revisit if/when one appears.
- These items live in `CHANGELOG.md` under *Unreleased → Pending* so they aren't lost.
