/**
 * test/unit/provider-home.test.ts — unit tests for src/providers/provider-home.ts
 *
 * Covers:
 *  - explicit vendor env wins (step 1)
 *  - providerHomesDir used when it exists (step 2) incl. account-scoped subdir
 *  - .replit-tools used when only it exists (step 3)
 *  - ~/.X final fallback (step 4)
 *  - precedence order among them
 *  - preferredProviderHome returns myshell path without existence check
 *
 * Hermetic: injected env, layout (with controlled paths), temp dirs.
 * Never touches real filesystem outside the temp root.
 */

import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { resolveProviderHome, preferredProviderHome } from '../../src/providers/provider-home.ts';
import type { ProviderHomeId, ProviderHomeOpts } from '../../src/providers/provider-home.ts';
import type { AppStateLayout } from '../../src/infra/state-layout.ts';

function makeLayout(opts: {
  providerHomesDir: string;
  stateRoot?: string;
  configRoot?: string;
  cacheRoot?: string;
  legacyRoot?: string;
}): AppStateLayout {
  const root = opts.stateRoot ?? opts.providerHomesDir;
  return {
    kind: 'legacy-posix',
    appName: 'myshell-tools',
    configRoot: opts.configRoot ?? root,
    stateRoot: root,
    cacheRoot: opts.cacheRoot ?? root,
    legacyRoot: opts.legacyRoot ?? root,
    cloud: null,
    paths: {
      configFile: join(root, 'config.json'),
      credentialsFile: join(root, 'credentials.json'),
      conversationsDir: join(root, 'conversations'),
      conversationArchiveDir: join(root, '.session-archive'),
      goalsDir: join(root, 'goals'),
      memoryDir: join(root, 'memory'),
      rulesDir: join(root, 'rules'),
      subscriptionsFile: join(root, 'subscriptions.json'),
      providerHomesDir: opts.providerHomesDir,
      updateCacheFile: join(root, 'update-check.json'),
      migrationDir: join(root, 'migration'),
    },
  };
}

describe('resolveProviderHome — precedence', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `phome-${randomUUID()}-`));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function opts(overrides: Partial<ProviderHomeOpts> = {}): ProviderHomeOpts {
    const providerHomesDir = join(root, 'state', 'provider-homes');
    return {
      env: {},
      layout: makeLayout({ providerHomesDir, stateRoot: join(root, 'state') }),
      cwd: root,
      home: join(root, 'home'),
      ...overrides,
    };
  }

  // ── Step 4 final fallback ───────────────────────────────────────────────

  describe('final fallback when nothing exists', () => {
    it('claude → <home>/.claude', () => {
      assert.equal(
        resolveProviderHome('claude', opts()),
        join(root, 'home', '.claude'),
      );
    });

    it('codex → <home>/.codex', () => {
      assert.equal(
        resolveProviderHome('codex', opts()),
        join(root, 'home', '.codex'),
      );
    });

    it('opencode → <home>/.local/share/opencode', () => {
      assert.equal(
        resolveProviderHome('opencode', opts()),
        join(root, 'home', '.local', 'share', 'opencode'),
      );
    });

    it('grok → <home>/.grok', () => {
      assert.equal(
        resolveProviderHome('grok', opts()),
        join(root, 'home', '.grok'),
      );
    });
  });

  // ── Step 1 explicit vendor env wins ─────────────────────────────────────

  describe('explicit vendor env always wins (step 1)', () => {
    it('CLAUDE_CONFIG_DIR overrides everything', async () => {
      const override = join(root, 'my-claude-dir');
      await mkdir(override, { recursive: true });
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const claudeDir = join(providerHomesDir, 'claude');
      await mkdir(claudeDir, { recursive: true });
      const result = resolveProviderHome('claude', opts({
        env: { CLAUDE_CONFIG_DIR: override },
      }));
      assert.equal(result, override);
    });

    it('CODEX_HOME overrides everything', async () => {
      const override = join(root, 'my-codex-dir');
      await mkdir(override, { recursive: true });
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const codexDir = join(providerHomesDir, 'codex');
      await mkdir(codexDir, { recursive: true });
      const result = resolveProviderHome('codex', opts({
        env: { CODEX_HOME: override },
      }));
      assert.equal(result, override);
    });

    it('XDG_DATA_HOME → join(xdg, opencode) overrides everything', async () => {
      const override = join(root, 'xdg-data');
      await mkdir(join(override, 'opencode'), { recursive: true });
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const opencodeDir = join(providerHomesDir, 'opencode');
      await mkdir(opencodeDir, { recursive: true });
      const result = resolveProviderHome('opencode', opts({
        env: { XDG_DATA_HOME: override },
      }));
      assert.equal(result, join(override, 'opencode'));
    });

    it('GROK_HOME overrides everything', async () => {
      const override = join(root, 'my-grok-dir');
      await mkdir(override, { recursive: true });
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const grokDir = join(providerHomesDir, 'grok');
      await mkdir(grokDir, { recursive: true });
      const result = resolveProviderHome('grok', opts({
        env: { GROK_HOME: override },
      }));
      assert.equal(result, override);
    });

    it('explicit env wins even when providerHomesDir exists', async () => {
      const override = join(root, 'explicit-claude');
      await mkdir(override, { recursive: true });
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const claudeDir = join(providerHomesDir, 'claude');
      await mkdir(claudeDir, { recursive: true });
      const result = resolveProviderHome('claude', opts({
        env: { CLAUDE_CONFIG_DIR: override },
      }));
      assert.equal(result, override);
    });
  });

  // ── Step 2 myshell-managed providerHomesDir ─────────────────────────────

  describe('myshell-managed providerHomesDir (step 2)', () => {
    it('uses providerHomesDir when it exists and no explicit env', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const claudeDir = join(providerHomesDir, 'claude');
      await mkdir(claudeDir, { recursive: true });
      const result = resolveProviderHome('claude', opts());
      assert.equal(result, claudeDir);
    });

    it('works for codex', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const codexDir = join(providerHomesDir, 'codex');
      await mkdir(codexDir, { recursive: true });
      const result = resolveProviderHome('codex', opts());
      assert.equal(result, codexDir);
    });

    it('works for opencode', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const opencodeDir = join(providerHomesDir, 'opencode');
      await mkdir(opencodeDir, { recursive: true });
      const result = resolveProviderHome('opencode', opts());
      assert.equal(result, opencodeDir);
    });

    it('works for grok', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const grokDir = join(providerHomesDir, 'grok');
      await mkdir(grokDir, { recursive: true });
      const result = resolveProviderHome('grok', opts());
      assert.equal(result, grokDir);
    });

    it('account-scoped subdir when account is set', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const accountDir = join(providerHomesDir, 'acct-123', 'claude');
      await mkdir(accountDir, { recursive: true });
      const result = resolveProviderHome('claude', opts({ account: 'acct-123' }));
      assert.equal(result, accountDir);
    });

    it('account-scoped subdir: scoped falls back to step 3/4 when scoped dir does not exist', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      // Only create unscoped dir — scoped dir does not exist
      const unscopedDir = join(providerHomesDir, 'claude');
      await mkdir(unscopedDir, { recursive: true });
      const result = resolveProviderHome('claude', opts({ account: 'acct-123' }));
      // With account set, step 2 checks only the scoped dir which doesn't exist → falls through
      assert.equal(result, join(root, 'home', '.claude'));
    });

    it('unscoped dir returned when account is not set', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const unscopedDir = join(providerHomesDir, 'claude');
      await mkdir(unscopedDir, { recursive: true });
      const result = resolveProviderHome('claude', opts());
      assert.equal(result, unscopedDir);
    });

    it('falls through to step 3/4 when providerHomesDir does not exist', async () => {
      const result = resolveProviderHome('claude', opts());
      assert.equal(result, join(root, 'home', '.claude'));
    });
  });

  // ── Step 3 .replit-tools back-compat ────────────────────────────────────

  describe('.replit-tools back-compat (step 3)', () => {
    it('uses .replit-tools when providerHomesDir does not exist', async () => {
      const replitDir = join(root, '.replit-tools', '.claude-persistent');
      await mkdir(replitDir, { recursive: true });
      const result = resolveProviderHome('claude', opts());
      assert.equal(result, replitDir);
    });

    it('providerHomesDir beats .replit-tools when both exist', async () => {
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const claudeDir = join(providerHomesDir, 'claude');
      await mkdir(claudeDir, { recursive: true });
      const replitDir = join(root, '.replit-tools', '.claude-persistent');
      await mkdir(replitDir, { recursive: true });
      const result = resolveProviderHome('claude', opts());
      assert.equal(result, claudeDir);
    });

    it('.replit-tools works for codex', async () => {
      const replitDir = join(root, '.replit-tools', '.codex-persistent');
      await mkdir(replitDir, { recursive: true });
      const result = resolveProviderHome('codex', opts());
      assert.equal(result, replitDir);
    });

    it('.replit-tools works for grok', async () => {
      const replitDir = join(root, '.replit-tools', '.grok-persistent');
      await mkdir(replitDir, { recursive: true });
      const result = resolveProviderHome('grok', opts());
      assert.equal(result, replitDir);
    });

    it('.replit-tools works for opencode', async () => {
      const replitDir = join(root, '.replit-tools', '.opencode-persistent');
      await mkdir(replitDir, { recursive: true });
      const result = resolveProviderHome('opencode', opts());
      assert.equal(result, replitDir);
    });
  });

  // ── Full precedence ordering ────────────────────────────────────────────

  describe('full precedence order', () => {
    it('step 1 > step 2 > step 3 > step 4', async () => {
      // Set up all levels
      const override = join(root, 'override');
      await mkdir(override, { recursive: true });
      const providerHomesDir = join(root, 'state', 'provider-homes');
      const claudeDir = join(providerHomesDir, 'claude');
      await mkdir(claudeDir, { recursive: true });
      const replitDir = join(root, '.replit-tools', '.claude-persistent');
      await mkdir(replitDir, { recursive: true });

      // Step 1 wins
      assert.equal(
        resolveProviderHome('claude', opts({ env: { CLAUDE_CONFIG_DIR: override } })),
        override,
      );

      // Step 2 wins (no explicit env)
      assert.equal(
        resolveProviderHome('claude', opts()),
        claudeDir,
      );

      // Step 3 wins (no providerHomesDir, but .replit-tools exists)
      const opts2 = opts();
      // Delete the provider-homes/claude dir to force step 3
      await rm(claudeDir, { recursive: true, force: true });
      assert.equal(
        resolveProviderHome('claude', opts2),
        replitDir,
      );

      // Step 4 wins (nothing else exists)
      await rm(replitDir, { recursive: true, force: true });
      assert.equal(
        resolveProviderHome('claude', opts2),
        join(root, 'home', '.claude'),
      );
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('empty env string is treated as unset', () => {
      const result = resolveProviderHome('claude', opts({
        env: { CLAUDE_CONFIG_DIR: '' },
      }));
      assert.equal(result, join(root, 'home', '.claude'));
    });

    it('never throws on any provider', () => {
      for (const p of ['claude', 'codex', 'opencode', 'grok'] as ProviderHomeId[]) {
        assert.doesNotThrow(() => resolveProviderHome(p, opts()));
      }
    });
  });
});

describe('preferredProviderHome', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `phome-pref-${randomUUID()}-`));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function popts(overrides: Partial<ProviderHomeOpts> = {}): ProviderHomeOpts {
    const providerHomesDir = join(root, 'state', 'provider-homes');
    return {
      env: {},
      layout: makeLayout({ providerHomesDir, stateRoot: join(root, 'state') }),
      cwd: root,
      home: join(root, 'home'),
      ...overrides,
    };
  }

  it('returns myshell path without existence check', () => {
    const result = preferredProviderHome('claude', popts());
    assert.equal(result, join(root, 'state', 'provider-homes', 'claude'));
  });

  it('does not check existence (dir does not exist, still returns it)', () => {
    const result = preferredProviderHome('codex', popts());
    assert.equal(result, join(root, 'state', 'provider-homes', 'codex'));
  });

  it('account-scoped path', () => {
    const result = preferredProviderHome('claude', popts({ account: 'acct-42' }));
    assert.equal(result, join(root, 'state', 'provider-homes', 'acct-42', 'claude'));
  });

  it('always ignores explicit env (for new-writes intent)', () => {
    const override = join(root, 'override');
    const result = preferredProviderHome('claude', popts({
      env: { CLAUDE_CONFIG_DIR: override },
    }));
    assert.equal(result, join(root, 'state', 'provider-homes', 'claude'));
  });
});
