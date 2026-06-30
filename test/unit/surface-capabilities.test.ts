/**
 * test/unit/surface-capabilities.test.ts — the two-chat-surfaces capability
 * matrix + divergence guard (whole-tool-finish-5.5.md §4, §4.4).
 *
 * The REPL is the lean SUBSET of the menu chat: it still gets memory injection +
 * the intent frame "for free" (deps/prompt concerns) but NOT the interactive
 * write/visible affordances. The divergence guard asserts the REPL's wired
 * capabilities are a documented subset of the menu's — so adding a menu-only
 * feature without deciding its REPL status fails the test.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  SURFACE_MATRIX,
  menuCapabilities,
  replCapabilities,
  replDivergence,
  type SurfaceCapability,
} from '../../src/core/surface-capabilities.ts';

const ALL_CAPABILITIES: readonly SurfaceCapability[] = [
  'coreAnswer',
  'memoryInjection',
  'memoryApproval',
  'intentFrame',
  'intentReflection',
  'recap',
  'writeApproval',
  'queueAndEsc',
  'slashCommands',
];

describe('SURFACE_MATRIX — shape', () => {
  it('lists every capability exactly once with a rationale', () => {
    const seen = new Set<string>();
    for (const row of SURFACE_MATRIX) {
      assert.ok(!seen.has(row.capability), `${row.capability} appears once`);
      seen.add(row.capability);
      assert.ok(row.why.length > 0, `${row.capability} has a rationale`);
    }
    assert.equal(seen.size, ALL_CAPABILITIES.length, 'covers every capability');
    for (const c of ALL_CAPABILITIES) assert.ok(seen.has(c), `${c} is in the matrix`);
  });
});

describe('REPL = lean subset (§4.2)', () => {
  it('gets the core answer (shared core)', () => {
    assert.ok(replCapabilities().includes('coreAnswer'));
  });

  it('gets memory INJECTION + the intent FRAME for free (deps/prompt, not UI)', () => {
    const repl = new Set(replCapabilities());
    assert.ok(repl.has('memoryInjection'), 'memory injection rides the shared deps');
    assert.ok(repl.has('intentFrame'), 'intent frame rides the shared deps');
  });

  it('does NOT get the interactive write / visible TUI affordances', () => {
    const repl = new Set(replCapabilities());
    assert.ok(!repl.has('memoryApproval'), 'no Save/Skip selector in a pipe');
    assert.ok(!repl.has('intentReflection'), 'no visible reflection line');
    assert.ok(!repl.has('recap'), 'no resume/recap model');
    assert.ok(!repl.has('writeApproval'), 'no blocking approval in a pipe');
    assert.ok(!repl.has('queueAndEsc'), 'no queue/ESC by construction');
    assert.ok(!repl.has('slashCommands'), 'minimal command set only');
  });
});

describe('menu = superset (§4.2)', () => {
  it('the menu carries every capability', () => {
    const menu = new Set(menuCapabilities());
    for (const c of ALL_CAPABILITIES) assert.ok(menu.has(c), `menu has ${c}`);
  });
});

describe('divergence guard (§4.4)', () => {
  it('the REPL is a documented SUBSET of the menu — no REPL-only capability', () => {
    assert.deepEqual(
      replDivergence(),
      [],
      'a menu-only feature added without deciding its REPL status (or a REPL capability the menu lacks) fails here',
    );
  });

  it('every REPL capability is also a menu capability', () => {
    const menu = new Set(menuCapabilities());
    for (const c of replCapabilities()) {
      assert.ok(menu.has(c), `REPL capability ${c} must also be a menu capability`);
    }
  });
});
