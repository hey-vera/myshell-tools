/* global process, setInterval */

/**
 * Deterministic fake Grok CLI for built-adapter integration tests.
 *
 * Accepts the argv shape production `createGrokProvider` builds
 * (`--output-format streaming-json -m … [--prompt-file <path>] …`).
 * Prompt-file path is acknowledged only (never echoed). Scenarios via
 * MYSHELL_FAKE_SCENARIO: happy (default), error, cancel, timeout.
 * Optional MYSHELL_FAKE_SENTINEL writes the child PID for cancel/timeout proofs.
 */

import { writeFileSync } from 'node:fs';

const scenario = process.env.MYSHELL_FAKE_SCENARIO;
const sentinel = process.env.MYSHELL_FAKE_SENTINEL;
const FIXTURE_PROTOCOL_VERSION = 1;

/** Locate --prompt-file value if present; do not read or leak contents. */
function promptFilePathFromArgv(argv) {
  const i = argv.indexOf('--prompt-file');
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

// Acknowledge prompt-file without loading or printing its contents.
void promptFilePathFromArgv(process.argv);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (scenario === 'cancel') {
  if (sentinel) writeFileSync(sentinel, String(process.pid), 'utf8');
  setInterval(() => {}, 1_000);
} else if (scenario === 'timeout') {
  if (sentinel) writeFileSync(sentinel, String(process.pid), 'utf8');
  setInterval(() => {}, 1_000);
} else if (scenario === 'error') {
  process.stderr.write(
    `synthetic Grok authentication failure v${FIXTURE_PROTOCOL_VERSION}\n`,
  );
  process.exitCode = 17;
} else {
  // happy (default): minimal streaming-json the production parser turns into
  // text + done (see createGrokParser in src/providers/grok-parse.ts).
  emit({ type: 'thought', data: 'fake thought ' });
  emit({ type: 'text', data: `hello v${FIXTURE_PROTOCOL_VERSION}` });
  emit({
    type: 'end',
    stopReason: 'EndTurn',
    sessionId: 'fake-grok-session-001',
    requestId: 'fake-req-001',
  });
}
