/**
 * test/unit/attachments.test.ts — unit tests for the PURE image-path extractor
 * (src/core/attachments.ts) and the IMPURE existence resolver
 * (src/infra/attachments.ts, with an injected fileExists port — no real fs).
 *
 * Image-attachment channel, provider-capability audit opportunity #4 (image scope).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { extractImagePaths, IMAGE_EXTENSIONS } from '../../src/core/attachments.ts';
import { resolveImageAttachments } from '../../src/infra/attachments.ts';

describe('extractImagePaths (pure)', () => {
  it('finds a bare image path', () => {
    assert.deepEqual(extractImagePaths('please look at ./shot.png'), ['./shot.png']);
  });

  it('finds an @-mentioned image path and strips the leading @', () => {
    assert.deepEqual(extractImagePaths('describe @assets/logo.png for me'), ['assets/logo.png']);
  });

  it('finds every supported image extension', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      const path = `pic${ext}`;
      assert.deepEqual(extractImagePaths(`here ${path}`), [path], `extension ${ext}`);
    }
  });

  it('is case-insensitive on the extension', () => {
    assert.deepEqual(extractImagePaths('see SHOT.PNG'), ['SHOT.PNG']);
    assert.deepEqual(extractImagePaths('see Diagram.JPEG'), ['Diagram.JPEG']);
  });

  it('finds multiple distinct image paths in order', () => {
    assert.deepEqual(extractImagePaths('compare a.png and b.jpg please'), ['a.png', 'b.jpg']);
  });

  it('de-dupes repeated paths (first-seen order)', () => {
    assert.deepEqual(extractImagePaths('a.png again a.png and b.gif a.png'), ['a.png', 'b.gif']);
  });

  it('handles absolute and ~ paths', () => {
    assert.deepEqual(extractImagePaths('open /tmp/x.webp'), ['/tmp/x.webp']);
    assert.deepEqual(extractImagePaths('open ~/Pictures/y.bmp'), ['~/Pictures/y.bmp']);
  });

  it('trims trailing prose punctuation', () => {
    assert.deepEqual(extractImagePaths('look at shot.png.'), ['shot.png']);
    assert.deepEqual(extractImagePaths('(see @a.jpg) thanks'), ['a.jpg']);
    assert.deepEqual(extractImagePaths('the file is "logo.svg"'), ['logo.svg']);
  });

  it('ignores non-image paths and ordinary prose', () => {
    assert.deepEqual(extractImagePaths('refactor src/index.ts and update README.md'), []);
    assert.deepEqual(extractImagePaths('what is the weather today'), []);
    assert.deepEqual(extractImagePaths('run ./build.sh now'), []);
  });

  it('does not match a bare extension with no basename (".png")', () => {
    assert.deepEqual(extractImagePaths('the .png format is lossless'), []);
  });

  it('does not match an extension that is merely a substring of a word', () => {
    // "weapon" ends in "pon", not an extension; "champion" etc. — no dot-extension.
    assert.deepEqual(extractImagePaths('the champion won'), []);
  });

  it('ignores a directory whose name contains a dot but whose basename is not an image', () => {
    assert.deepEqual(extractImagePaths('open my.assets/notes.txt'), []);
  });

  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(extractImagePaths(''), []);
    // @ts-expect-error — exercising the runtime guard
    assert.deepEqual(extractImagePaths(undefined), []);
  });
});

describe('resolveImageAttachments (impure, injected fileExists)', () => {
  // Platform-agnostic bases: resolve() normalizes to the host OS's separators
  // (POSIX `/work/x`, Windows `C:\work\x`), so the test passes on Linux, macOS,
  // AND Windows (the CI matrix). Both the injected `existing` set and the
  // expected output paths are built with the SAME node:path resolution the source
  // uses — so we assert against whatever the running platform actually produces,
  // never a hardcoded forward-slash literal.
  const CWD = resolve('/work');
  const HOME = resolve('/home/u');
  /** Mirror src toAbsolute(): relative→resolve(cwd), `~/`→resolve(home), absolute→as-is. */
  const abs = (relUnderCwd: string): string => resolve(CWD, relUnderCwd);
  const absHome = (relUnderHome: string): string => resolve(HOME, relUnderHome);

  const deps = (existing: readonly string[]): {
    fileExists: (p: string) => boolean;
    cwd: string;
    home: string;
  } => ({
    fileExists: (p: string): boolean => existing.includes(p),
    cwd: CWD,
    home: HOME,
  });

  it('keeps only image paths that exist on disk (resolved to absolute)', () => {
    const out = resolveImageAttachments('see real.png and gone.jpg', deps([abs('real.png')]));
    assert.deepEqual(out, [{ path: abs('real.png'), kind: 'image' }]);
  });

  it('resolves a relative path against cwd', () => {
    const out = resolveImageAttachments('@assets/logo.png', deps([abs('assets/logo.png')]));
    assert.deepEqual(out, [{ path: abs('assets/logo.png'), kind: 'image' }]);
  });

  it('expands a leading ~ against home', () => {
    const out = resolveImageAttachments('open ~/pics/y.bmp', deps([absHome('pics/y.bmp')]));
    assert.deepEqual(out, [{ path: absHome('pics/y.bmp'), kind: 'image' }]);
  });

  it('passes through an absolute path', () => {
    // A leading-slash path is absolute on POSIX and Windows alike; the source
    // returns it unchanged (no re-resolution), so assert it verbatim.
    const out = resolveImageAttachments('open /tmp/x.webp', deps(['/tmp/x.webp']));
    assert.deepEqual(out, [{ path: '/tmp/x.webp', kind: 'image' }]);
  });

  it('drops non-existent files (conservative)', () => {
    assert.deepEqual(resolveImageAttachments('see nope.png', deps([])), []);
  });

  it('collapses ./a.png and a.png to one absolute attachment', () => {
    const out = resolveImageAttachments('a.png and ./a.png', deps([abs('a.png')]));
    assert.deepEqual(out, [{ path: abs('a.png'), kind: 'image' }]);
  });

  it('returns [] when the message references no image (unchanged behaviour)', () => {
    assert.deepEqual(resolveImageAttachments('refactor index.ts', deps([abs('index.ts')])), []);
  });
});
