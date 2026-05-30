/**
 * Unit tests for src/infra/config.ts
 * Run with: node --import ./test/register.mjs --test "test/unit/config.test.ts"
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { loadConfig, saveConfig } from '../../src/infra/config.ts';
import type { AppConfig } from '../../src/infra/config.ts';

// ---------------------------------------------------------------------------
// loadConfig — defaults
// ---------------------------------------------------------------------------

describe('loadConfig — defaults', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `config-test-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns default config when file does not exist', async () => {
    const config = await loadConfig(homeDir);
    assert.deepEqual(config, { onboarded: false, setAsDefault: false });
  });

  it('onboarded defaults to false', async () => {
    const config = await loadConfig(homeDir);
    assert.equal(config.onboarded, false);
  });

  it('setAsDefault defaults to false', async () => {
    const config = await loadConfig(homeDir);
    assert.equal(config.setAsDefault, false);
  });
});

// ---------------------------------------------------------------------------
// saveConfig + loadConfig — round-trip
// ---------------------------------------------------------------------------

describe('saveConfig + loadConfig — round-trip', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `config-roundtrip-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('saves and reloads onboarded: true', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.onboarded, true);
    assert.equal(loaded.setAsDefault, false);
  });

  it('saves and reloads setAsDefault: true', async () => {
    const cfg: AppConfig = { onboarded: false, setAsDefault: true };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.onboarded, false);
    assert.equal(loaded.setAsDefault, true);
  });

  it('round-trips both fields true', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: true };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.deepEqual(loaded, { onboarded: true, setAsDefault: true });
  });

  it('saveConfig creates .myshell-tools dir if missing', async () => {
    const freshHome = await mkdtemp(join(tmpdir(), `config-dir-${randomUUID()}-`));
    try {
      // No .myshell-tools dir yet — saveConfig must create it
      await saveConfig({ onboarded: true, setAsDefault: false }, freshHome);
      const loaded = await loadConfig(freshHome);
      assert.equal(loaded.onboarded, true);
    } finally {
      await rm(freshHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig — resilience
// ---------------------------------------------------------------------------

describe('loadConfig — resilience', () => {
  it('returns defaults when config.json contains corrupt JSON (no throw)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `config-corrupt-${randomUUID()}-`));
    try {
      const configDir = join(home2, '.myshell-tools');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), 'CORRUPT JSON!!!', 'utf8');

      const config = await loadConfig(home2);
      assert.deepEqual(config, { onboarded: false, setAsDefault: false });
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('merges known fields from partial on-disk JSON over defaults', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `config-partial-${randomUUID()}-`));
    try {
      const configDir = join(home2, '.myshell-tools');
      await mkdir(configDir, { recursive: true });
      // Only onboarded is set on disk
      await writeFile(join(configDir, 'config.json'), JSON.stringify({ onboarded: true }), 'utf8');

      const config = await loadConfig(home2);
      // onboarded from disk, setAsDefault from defaults
      assert.equal(config.onboarded, true);
      assert.equal(config.setAsDefault, false);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});
