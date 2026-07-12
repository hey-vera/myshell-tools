/* global process */
const VERSION = 1;
for await (const chunk of process.stdin) { void chunk; }
process.stdout.write(`${JSON.stringify({ type: 'text', sessionID: 'fake-open-session', part: { type: 'text', text: `hello v${VERSION}` } })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'step_finish', sessionID: 'fake-open-session', part: { type: 'step-finish', tokens: { input: 2, output: 1 }, cost: 0 } })}\n`);
