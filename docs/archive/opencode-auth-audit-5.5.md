# OpenCode Auth Audit 5.5

Date: 2026-06-05

## Finding

The friction came from running bare `opencode auth login`. In opencode 1.15.12,
that command starts the multi-provider credential flow and can show the full
models.dev provider list before the user ever reaches the OpenCode account
gateway. That is not the default myshell should expose.

`opencode auth login --help` confirms two useful selectors:

- `-p, --provider`: provider id or name, skips provider selection.
- `-m, --method`: login method label, skips method selection.

The OpenCode gateway provider id is `opencode`. `opencode models` on a clean
machine with zero credentials lists `opencode/*` models:

- `opencode/big-pickle`
- `opencode/deepseek-v4-flash-free`
- `opencode/mimo-v2.5-free`
- `opencode/minimax-m3-free`
- `opencode/nemotron-3-ultra-free`

`opencode auth list` reported `0 credentials` in this environment, so these are
visible before auth.

## Gateway Behavior

I probed the installed opencode 1.15.12 CLI with bounded TTY runs:

- `timeout 5s ... opencode auth login -p opencode`
- `timeout 5s ... opencode auth login -p opencode -m "API Key"`
- `timeout 5s ... opencode auth login -p opencode -m definitely-not-a-real-method`

All three went directly to the OpenCode gateway credential screen:

- Header: `Add credential`
- Instruction: `Create an api key at https://opencode.ai/auth`
- Prompt: `Enter your API key`

No provider list, OAuth/device flow, or Go-vs-Zen method selector appeared. The
`-m` value was not needed for this provider in 1.15.12; provider preselection is
the important part. Since invalid `-m` did not change the observed prompt, myshell
does not pass `-m`.

## Go vs Zen

In the installed CLI, OpenCode Go and OpenCode Zen do not appear as separate auth
providers or separate login methods. The credential flow for `-p opencode` asks
for one API key from `opencode.ai/auth`. The practical conclusion is that Go and
Zen are account tiers behind the same OpenCode gateway credential. After auth,
myshell should rely on `opencode models` and opencode itself to expose whichever
models that account unlocks.

Residual limitation: this environment has no OpenCode account credentials, so I
verified the unauthenticated gateway prompt and provider/method behavior, not a
post-login paid Go or Zen model roster.

## Changes

- `src/commands/login.ts:27` documents that opencode login now connects the
  OpenCode account gateway directly.
- `src/commands/login.ts:56` changes the default/browser opencode command to
  `opencode auth login -p opencode`.
- `src/commands/login.ts:96` changes the code/headless opencode command to the
  same preselected provider flow.
- `src/commands/login.ts:98` rewrites the opencode guidance around the one-step
  account key flow and Go/Zen account tiers.
- `src/commands/login.ts:106` adds `getLoginCommand()` so tests can assert the
  exact command without spawning interactive auth.
- `src/interface/menu.ts:1359` updates onboarding language from provider-picking
  to connecting an OpenCode account. The `[o]` handler still calls `runLogin`
  for `opencode`, so it inherits the gateway-preselected command.
- `test/unit/login.test.ts:124` adds hermetic coverage that both opencode login
  methods use `auth login -p opencode` and that Claude/Codex commands are
  unchanged.

## Residual Risk

`opencode auth login -p opencode` still asks the user to create and paste an API
key into opencode. myshell does not see or store the key; opencode owns credential
storage. If future opencode versions add a true OAuth/device method for the
OpenCode provider, myshell can add `-m <label>` after verifying the exact label.
