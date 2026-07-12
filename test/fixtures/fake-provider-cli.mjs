/* global process, setInterval */

import { writeFileSync } from 'node:fs';

const scenario = process.env.MYSHELL_FAKE_SCENARIO;
const sentinel = process.env.MYSHELL_FAKE_SENTINEL;
const FIXTURE_PROTOCOL_VERSION = 1;

async function readStdin() {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += String(chunk);
  return prompt;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (scenario === 'cancel') {
  if (sentinel) writeFileSync(sentinel, String(process.pid), 'utf8');
  setInterval(() => {}, 1_000);
} else {
  const prompt = await readStdin();
  if (scenario === 'error') {
    process.stderr.write(`synthetic authentication failure for ${prompt.length} bytes\n`);
    process.exitCode = 17;
  } else if (scenario === 'protocol-error') {
    emit({ type: 'error', message: `synthetic protocol failure v${FIXTURE_PROTOCOL_VERSION}` });
  } else if (scenario === 'timeout') {
    if (sentinel) writeFileSync(sentinel, String(process.pid), 'utf8');
    setInterval(() => {}, 1_000);
  } else {
    emit({ type: 'thread.started', thread_id: 'fake-thread-001' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'partial ' } });
    emit({ type: 'item.completed', item: { type: 'command_execution', detail: 'fake tool finished' } });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } });
  }
}
