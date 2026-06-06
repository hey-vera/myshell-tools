/**
 * test/unit/attachments.test.ts — unit tests for the PURE image-path extractor
 * (src/core/attachments.ts) and the IMPURE existence resolver
 * (src/infra/attachments.ts, with an injected fileExists port — no real fs).
 *
 * Image-attachment channel, provider-capability audit opportunity #4 (image scope).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
  const deps = (existing: readonly string[], cwd = '/work', home = '/home/u'): {
    fileExists: (p: string) => boolean;
    cwd: string;
    home: string;
  } => ({
    fileExists: (p: string): boolean => existing.includes(p),
    cwd,
    home,
  });

  it('keeps only image paths that exist on disk (resolved to absolute)', () => {
    const out = resolveImageAttachments('see real.png and gone.jpg', deps(['/work/real.png']));
    assert.deepEqual(out, [{ path: '/work/real.png', kind: 'image' }]);
  });

  it('resolves a relative path against cwd', () => {
    const out = resolveImageAttachments('@assets/logo.png', deps(['/work/assets/logo.png']));
    assert.deepEqual(out, [{ path: '/work/assets/logo.png', kind: 'image' }]);
  });

  it('expands a leading ~ against home', () => {
    const out = resolveImageAttachments('open ~/pics/y.bmp', deps(['/home/u/pics/y.bmp']));
    assert.deepEqual(out, [{ path: '/home/u/pics/y.bmp', kind: 'image' }]);
  });

  it('passes through an absolute path', () => {
    const out = resolveImageAttachments('open /tmp/x.webp', deps(['/tmp/x.webp']));
    assert.deepEqual(out, [{ path: '/tmp/x.webp', kind: 'image' }]);
  });

  it('drops non-existent files (conservative)', () => {
    assert.deepEqual(resolveImageAttachments('see nope.png', deps([])), []);
  });

  it('collapses ./a.png and a.png to one absolute attachment', () => {
    const out = resolveImageAttachments('a.png and ./a.png', deps(['/work/a.png']));
    assert.deepEqual(out, [{ path: '/work/a.png', kind: 'image' }]);
  });

  it('returns [] when the message references no image (unchanged behaviour)', () => {
    assert.deepEqual(resolveImageAttachments('refactor index.ts', deps(['/work/index.ts'])), []);
  });
});
