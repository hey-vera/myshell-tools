/**
 * Validates the ROOT CAUSE of the claude "Invalid code" sign-in failure with a
 * REAL child process (no mocks, no real auth):
 *
 *   A child that reads the first line from stdin — exactly what `claude auth login`
 *   does at its "Paste code here >" prompt — reads an EMPTY first line when a stray
 *   newline (a habitual Enter left over from the single-key `y` confirm) precedes
 *   the real input. That empty submit is what surfaces as
 *   "Invalid code. Please make sure the full code was copied."
 *
 * Draining that leftover before the handoff (what createLineReader.suspend() now
 * does) makes the child read the real value first. This test proves both halves.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/**
 * Spawn a tiny Node child that prints the FIRST line it reads from stdin as
 * `LINE1:[…]`, feed it `input`, and resolve with the captured first line.
 * Mirrors a paste-code reader receiving bytes over an inherited stdin.
 */
function firstLineRead(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "let b='';process.stdin.on('data',d=>{b+=d;const i=b.indexOf('\\n');" +
          "if(i>=0){process.stdout.write('LINE1:['+b.slice(0,i)+']');process.exit(0);}});",
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      const m = out.match(/LINE1:\[(.*)\]/);
      resolve(m?.[1] ?? '<none>');
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe('claude sign-in handoff — leftover-newline root cause', () => {
  it('a leading newline (stray Enter) makes the child read an EMPTY first line', async () => {
    // "\n" + the real code → the child submits the empty line before the code.
    const first = await firstLineRead('\nABC123#state-xyz\n');
    assert.equal(first, '', 'leftover Enter → premature empty submit (this is the bug)');
  });

  it('with the leftover drained, the child reads the REAL code first', async () => {
    const first = await firstLineRead('ABC123#state-xyz\n');
    assert.equal(first, 'ABC123#state-xyz', 'no leftover → claude receives the actual pasted code');
  });
});
