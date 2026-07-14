/* global process, setInterval */

/**
 * Deterministic fake Claude CLI for built-adapter integration tests.
 * Selected only via MYSHELL_FAKE_SCENARIO — no credentials, no network.
 * Emits minimal stream-json JSONL compatible with parseClaudeLine.
 */

import { writeFileSync } from 'node:fs';

const scenario = process.env.MYSHELL_FAKE_SCENARIO;
const sentinel = process.env.MYSHELL_FAKE_SENTINEL;
const FIXTURE_PROTOCOL_VERSION = 1;
const SESSION_ID = 'fake-claude-session-001';
const RESULT_TEXT = `pong v${FIXTURE_PROTOCOL_VERSION}`;

async function readStdin() {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += String(chunk);
  return prompt;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function hangWithOptionalSentinel() {
  if (sentinel) writeFileSync(sentinel, String(process.pid), 'utf8');
  setInterval(() => {}, 1_000);
}

if (scenario === 'cancel') {
  hangWithOptionalSentinel();
} else {
  // Claude delivers the prompt on stdin; consume and ignore (may be empty on hang paths).
  const prompt = await readStdin();

  if (scenario === 'error') {
    process.stderr.write(
      `synthetic authentication failure for ${prompt.length} bytes (fake claude v${FIXTURE_PROTOCOL_VERSION})\n`,
    );
    process.exitCode = 17;
  } else if (scenario === 'timeout') {
    hangWithOptionalSentinel();
  } else {
    // Happy path: stream-json frames that yield text → tool → usage → done.
    emit({
      type: 'system',
      subtype: 'init',
      session_id: SESSION_ID,
      model: 'claude-sonnet-fake',
    });
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: RESULT_TEXT },
      },
      session_id: SESSION_ID,
    });
    // Optional tool_use on the assistant message (tools only; text is owned by deltas).
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/tmp/fake-claude-fixture.txt' },
          },
        ],
      },
      session_id: SESSION_ID,
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: RESULT_TEXT,
      session_id: SESSION_ID,
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  }
}
