/**
 * test/unit/menu-completion.test.ts — pure contract tests for the chat Tab
 * completion engine (src/interface/menu-completion.ts). Filesystem-free: only the
 * pure slash-name / classification seams are exercised here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeSlash,
  classifyCompletion,
  CHAT_SLASH_COMMANDS,
} from '../../src/interface/menu-completion.ts';

test("completeSlash('/go') offers /goal and /goals", () => {
  const [hits] = completeSlash('/go');
  assert.ok(hits.includes('/goal'), `expected /goal, got: ${hits.join(', ')}`);
  assert.ok(hits.includes('/goals'), `expected /goals, got: ${hits.join(', ')}`);
});

test("completeSlash('/') lists ALL commands", () => {
  const [hits] = completeSlash('/');
  assert.deepEqual([...hits].sort(), [...CHAT_SLASH_COMMANDS].sort());
});

test("completeSlash('/zzz') matches nothing", () => {
  const [hits] = completeSlash('/zzz');
  assert.deepEqual(hits, []);
});

test("classifyCompletion('/goal text') is a free-text arg (NOT a name completion)", () => {
  const c = classifyCompletion('/goal text');
  assert.notEqual(c.kind, 'slash-name', `should not complete a name mid-arg, got: ${c.kind}`);
  // /goal takes free text → no arg candidate set → kind 'none' (strict no-op).
  assert.equal(c.kind, 'none', `/goal arg should be a no-op, got: ${c.kind}`);
});

test('/oversight and /rule are present in CHAT_SLASH_COMMANDS', () => {
  assert.ok(CHAT_SLASH_COMMANDS.includes('/oversight'), 'missing /oversight');
  assert.ok(CHAT_SLASH_COMMANDS.includes('/rule'), 'missing /rule');
});
