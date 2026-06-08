/**
 * Unit tests for the "real chat" roadmap gaps #3 (/copy + /export), #4 (richer
 * resume picker), and #5 (semantic auto-naming).
 *
 * All seams are PURE or port-injected so these run hermetically (no real
 * clipboard, no real disk for the pure parts, an injected writer for /export):
 *   - #3 /copy : pickCopyText (pure pick of the last stripped answer) +
 *                runCopyCommand over an injected ClipboardPort (success +
 *                headless fallback + nothing-to-copy).
 *   - #3 /export: renderConversationMarkdown (pure transcript) + runExportCommand
 *                 writing through an injected fs writer (+ fail-soft on a write
 *                 error and an empty conversation).
 *   - #4 picker : renderConversationList shows "· N msgs", degrades under no-color.
 *   - #5 title  : deriveTitleFromRecap (recap → short title) vs first-words
 *                 fallback, bounded + fail-soft; isStubTitle gating.
 *
 * Run with: node --experimental-strip-types --test test/unit/real-chat-copy-export-title.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickCopyText,
  renderConversationMarkdown,
} from '../../src/interface/render.ts';
import { cleanAssistantText } from '../../src/interface/stream-filter.ts';
import {
  runCopyCommand,
  runExportCommand,
  exportFileSlug,
} from '../../src/interface/menu-io-commands.ts';
import { renderConversationList } from '../../src/interface/menu-display.ts';
import { deriveTitleFromRecap, isStubTitle } from '../../src/infra/conversations.ts';
import { systemClipboardPort } from '../../src/infra/clipboard.ts';
import type { SessionEntry } from '../../src/core/types.ts';
import type { OutputSink } from '../../src/interface/render.ts';
import type { ConversationMeta } from '../../src/infra/conversation-store.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function entry(
  role: SessionEntry['role'],
  content: string,
  timestamp = '2024-01-01T00:00:00.000Z',
): SessionEntry {
  return { timestamp, role, content };
}

function makeSink(color = false): OutputSink & { buf: string } {
  const sink = {
    buf: '',
    color,
    isTty: true,
    write(s: string): void {
      sink.buf += s;
    },
  };
  return sink;
}

function meta(partial: Partial<ConversationMeta>): ConversationMeta {
  return {
    id: 'id-1',
    title: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    messageCount: 0,
    pinned: false,
    category: null,
    ...partial,
  };
}

// A control-enveloped assistant turn, as stored on disk.
const ENVELOPED = 'Here is the real answer.\n{"confidence":0.9}';
const GOAL_MARKED = 'The migration is done.\nGOAL_COMPLETE';

// ---------------------------------------------------------------------------
// #3 /copy — pickCopyText (pure)
// ---------------------------------------------------------------------------

describe('#3 pickCopyText — picks the last assistant answer, stripped', () => {
  it('returns the last assistant body with the control envelope removed', () => {
    const got = pickCopyText([
      entry('user', 'do the thing'),
      entry('assistant', ENVELOPED),
    ]);
    assert.equal(got, 'Here is the real answer.');
  });

  it('strips a trailing goal marker', () => {
    const got = pickCopyText([entry('user', 'go'), entry('assistant', GOAL_MARKED)]);
    assert.equal(got, 'The migration is done.');
  });

  it('picks the LAST assistant answer when several exist', () => {
    const got = pickCopyText([
      entry('user', 'q1'),
      entry('assistant', 'first answer'),
      entry('user', 'q2'),
      entry('assistant', 'second answer'),
    ]);
    assert.equal(got, 'second answer');
  });

  it('skips a trailing user turn and finds the prior assistant answer', () => {
    const got = pickCopyText([
      entry('assistant', 'the answer'),
      entry('user', 'a follow-up I have not sent yet'),
    ]);
    assert.equal(got, 'the answer');
  });

  it('returns null when there is no assistant answer', () => {
    assert.equal(pickCopyText([entry('user', 'hi')]), null);
    assert.equal(pickCopyText([]), null);
  });

  it('returns null when every assistant body is blank after stripping', () => {
    assert.equal(
      pickCopyText([entry('user', 'hi'), entry('assistant', '{"confidence":0.1}')]),
      null,
    );
  });

  it('cleanAssistantText is the shared, fail-soft stripper', () => {
    assert.equal(cleanAssistantText(ENVELOPED).trim(), 'Here is the real answer.');
    assert.equal(cleanAssistantText('plain prose'), 'plain prose');
  });
});

// ---------------------------------------------------------------------------
// #3 /copy — runCopyCommand over an injected clipboard port
// ---------------------------------------------------------------------------

describe('#3 runCopyCommand — injected clipboard port', () => {
  it('passes the stripped last answer to the port and confirms on success', async () => {
    let copied: string | null = null;
    const out = makeSink();
    await runCopyCommand({
      entries: [entry('user', 'q'), entry('assistant', ENVELOPED)],
      out,
      clipboard: async (text) => {
        copied = text;
        return true;
      },
    });
    assert.equal(copied, 'Here is the real answer.');
    assert.match(out.buf, /Copied my last answer/i);
  });

  it('headless fallback: prints the text when the port returns false', async () => {
    const out = makeSink();
    await runCopyCommand({
      entries: [entry('user', 'q'), entry('assistant', 'the answer text')],
      out,
      clipboard: async () => false,
    });
    assert.match(out.buf, /Clipboard unavailable/i);
    assert.match(out.buf, /the answer text/);
  });

  it('fallback path is still reached when the port THROWS (never crashes)', async () => {
    const out = makeSink();
    await runCopyCommand({
      entries: [entry('assistant', 'resilient answer')],
      out,
      clipboard: async () => {
        throw new Error('port blew up');
      },
    });
    assert.match(out.buf, /Clipboard unavailable/i);
    assert.match(out.buf, /resilient answer/);
  });

  it('nothing-to-copy notice when there is no answer, and never calls the port', async () => {
    let called = false;
    const out = makeSink();
    await runCopyCommand({
      entries: [entry('user', 'hi')],
      out,
      clipboard: async () => {
        called = true;
        return true;
      },
    });
    assert.equal(called, false);
    assert.match(out.buf, /Nothing to copy/i);
  });
});

// ---------------------------------------------------------------------------
// #3 clipboard shim — the real port is fail-soft (no clipboard tool → false)
// ---------------------------------------------------------------------------

describe('#3 systemClipboardPort — fail-soft on a headless host', () => {
  it('resolves a boolean and never throws (returns false when no tool exists)', async () => {
    // On the CI/Replit host there is no clipboard tool, so this resolves false;
    // the contract under test is "never throws + always a boolean".
    const result = await systemClipboardPort('hello clipboard');
    assert.equal(typeof result, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// #3 /export — renderConversationMarkdown (pure)
// ---------------------------------------------------------------------------

describe('#3 renderConversationMarkdown — faithful transcript', () => {
  it('renders a title header and ## You / ## Assistant sections', () => {
    const md = renderConversationMarkdown({ title: 'JWT migration' }, [
      entry('user', 'How do I migrate?'),
      entry('assistant', ENVELOPED),
    ]);
    assert.match(md, /^# JWT migration/);
    assert.match(md, /## You\n\nHow do I migrate\?/);
    assert.match(md, /## Assistant\n\nHere is the real answer\./);
    // The control envelope must NOT leak into the exported transcript.
    assert.doesNotMatch(md, /confidence/);
  });

  it('falls back to a generic title when none is set', () => {
    const md = renderConversationMarkdown({}, [entry('user', 'hi')]);
    assert.match(md, /^# Conversation/);
  });

  it('drops system entries and blank turns', () => {
    const md = renderConversationMarkdown({ title: 't' }, [
      entry('system', 'internal control'),
      entry('user', 'real question'),
      entry('assistant', '{"confidence":0.2}'), // blank after stripping
    ]);
    assert.doesNotMatch(md, /internal control/);
    assert.match(md, /real question/);
    // The blank assistant turn produced no section.
    assert.equal((md.match(/## Assistant/g) ?? []).length, 0);
  });

  it('handles an empty conversation without throwing', () => {
    const md = renderConversationMarkdown({ title: 't' }, []);
    assert.match(md, /No messages yet/);
  });
});

// ---------------------------------------------------------------------------
// #3 /export — runExportCommand writes through the injected writer
// ---------------------------------------------------------------------------

describe('#3 runExportCommand — writes a file via the injected fs', () => {
  it('writes the rendered Markdown to the given path and prints it', async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const out = makeSink();
    await runExportCommand({
      meta: { title: 'My Thread' },
      entries: [entry('user', 'q'), entry('assistant', 'a clean answer')],
      out,
      path: '/tmp/some/export.md',
      writeFile: async (path, data) => {
        writes.push({ path, data });
      },
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.path, '/tmp/some/export.md');
    assert.match(writes[0]?.data ?? '', /# My Thread/);
    assert.match(writes[0]?.data ?? '', /a clean answer/);
    assert.match(out.buf, /Exported this conversation to \/tmp\/some\/export\.md/);
  });

  it('fail-soft: a writer error prints a gentle note, never throws', async () => {
    const out = makeSink();
    await assert.doesNotReject(
      runExportCommand({
        meta: { title: 't' },
        entries: [entry('user', 'q'), entry('assistant', 'a')],
        out,
        path: '/nope/export.md',
        writeFile: async () => {
          throw new Error('EACCES');
        },
      }),
    );
    assert.match(out.buf, /Couldn't write the export/i);
  });

  it('empty conversation: notice + never touches the writer', async () => {
    let called = false;
    const out = makeSink();
    await runExportCommand({
      meta: { title: 't' },
      entries: [],
      out,
      path: '/tmp/x.md',
      writeFile: async () => {
        called = true;
      },
    });
    assert.equal(called, false);
    assert.match(out.buf, /Nothing to export/i);
  });

  it('exportFileSlug makes a clean, bounded, fs-safe slug', () => {
    assert.equal(exportFileSlug('JWT Migration: step 2!'), 'jwt-migration-step-2');
    assert.equal(exportFileSlug(''), 'conversation');
    assert.equal(exportFileSlug(undefined), 'conversation');
    assert.ok(exportFileSlug('x'.repeat(200)).length <= 48);
  });
});

// ---------------------------------------------------------------------------
// #4 richer resume picker — "· N msgs"
// ---------------------------------------------------------------------------

describe('#4 renderConversationList — shows "· N msgs"', () => {
  const NOW = Date.parse('2024-01-01T01:00:00.000Z');

  it('appends the message count to each row', () => {
    const [row] = renderConversationList(
      [meta({ title: 'Hello', messageCount: 8, updatedAt: '2024-01-01T00:00:00.000Z' })],
      NOW,
      false,
    );
    assert.match(row ?? '', /· 8 msgs/);
    assert.match(row ?? '', /Hello/);
  });

  it('uses the singular "msg" for exactly one message', () => {
    const [row] = renderConversationList(
      [meta({ title: 'One', messageCount: 1 })],
      NOW,
      false,
    );
    assert.match(row ?? '', /· 1 msg\b/);
    assert.doesNotMatch(row ?? '', /· 1 msgs/);
  });

  it('omits the count for a zero-message conversation', () => {
    const [row] = renderConversationList([meta({ title: 'Empty', messageCount: 0 })], NOW, false);
    assert.doesNotMatch(row ?? '', /msg/);
  });

  it('degrades cleanly under no-color (no ANSI in the count)', () => {
    const [row] = renderConversationList([meta({ title: 'NC', messageCount: 3 })], NOW, false);
    // No ANSI CSI escape anywhere -> dim() emitted plain text under no-color.
    assert.ok(!(row ?? '').includes(String.fromCharCode(27)));
    assert.match(row ?? '', /· 3 msgs/);
  });

  it('still shows the count alongside an existing recap second line', () => {
    const [row] = renderConversationList(
      [meta({ title: 'R', messageCount: 5, recap: 'we wired up the auth flow' })],
      NOW,
      false,
    );
    assert.match(row ?? '', /· 5 msgs/);
    assert.match(row ?? '', /wired up the auth flow/);
  });
});

// ---------------------------------------------------------------------------
// #5 semantic auto-naming — deriveTitleFromRecap + isStubTitle
// ---------------------------------------------------------------------------

describe('#5 deriveTitleFromRecap — recap → short clean title', () => {
  it('distills the first clause of a recap into a topic title', () => {
    const title = deriveTitleFromRecap('We migrated the auth service to JWT. Next: rotate keys.');
    assert.equal(title, 'Migrated the auth service to JWT');
  });

  it('strips a leading conversational framing so the title reads as a topic', () => {
    const title = deriveTitleFromRecap("You asked about indexing the orders table");
    assert.equal(title, 'Asked about indexing the orders table');
  });

  it('bounds the title length and never cuts mid-word', () => {
    const long =
      'We are doing a very long and detailed exploration of the distributed consensus protocol implementation';
    const title = deriveTitleFromRecap(long);
    assert.ok(title !== null);
    assert.ok((title ?? '').length <= 56, `title too long: ${title}`);
    // No trailing partial word / dangling space.
    assert.doesNotMatch(title ?? '', /\s$/);
  });

  it('returns null for an absent / blank / too-short recap (caller keeps first-words)', () => {
    assert.equal(deriveTitleFromRecap(null), null);
    assert.equal(deriveTitleFromRecap(undefined), null);
    assert.equal(deriveTitleFromRecap('   '), null);
    assert.equal(deriveTitleFromRecap('ok'), null);
  });

  it('is fail-soft on a weird recap (strips the ※ glyph, never throws)', () => {
    const title = deriveTitleFromRecap('※ Debugging the flaky payment webhook');
    assert.equal(title, 'Debugging the flaky payment webhook');
  });

  it('does not crash if the framing strip would empty the string', () => {
    // "we" alone → reframed is empty → keep the original clause "We".
    const title = deriveTitleFromRecap('we');
    // Too short → null (length < 3 after the leading-frame guard keeps "we").
    assert.equal(title, null);
  });
});

describe('#5 isStubTitle — gates the recap re-title so deliberate names survive', () => {
  it('an empty title is a stub', () => {
    assert.equal(isStubTitle('', 'whatever the user typed'), true);
  });

  it("a title equal to the first-words of the opening message is a stub", () => {
    // deriveTitle is first-words truncation; a short opener IS its own title.
    assert.equal(isStubTitle('hey can you look at this', 'hey can you look at this'), true);
  });

  it('a deliberately-different title is NOT a stub (never clobbered)', () => {
    assert.equal(isStubTitle('JWT migration plan', 'hey can you look at this'), false);
  });

  it('with no first message, only an empty title counts as a stub', () => {
    assert.equal(isStubTitle('Some Title', null), false);
    assert.equal(isStubTitle('', null), true);
  });
});
