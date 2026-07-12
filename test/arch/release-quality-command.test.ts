import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('release quality command', () => {
  it('runs every deterministic gate in dependency-safe order and prepublish delegates after clean', () => {
    const scripts = packageJson.scripts ?? {};
    assert.equal(
      scripts.quality,
      'npm run typecheck && npm run lint && npm run knip && npm run build && npm test && npm run test:ui && npm run test:contract && npm run test:integration',
    );
    assert.equal(scripts.prepublishOnly, 'npm run clean && npm run quality');
  });
});
