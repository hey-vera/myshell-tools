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

import { loadConfig, saveConfig, resolvePartnerStyle } from '../../src/infra/config.ts';
import type { AppConfig } from '../../src/infra/config.ts';

// ---------------------------------------------------------------------------
// resolvePartnerStyle — explicit wins, else derived from effective mode
// ---------------------------------------------------------------------------

describe('resolvePartnerStyle', () => {
  it('returns the explicit config.partnerStyle regardless of mode', () => {
    assert.equal(resolvePartnerStyle({ partnerStyle: 'collaborative' }, 'cost-saver'), 'collaborative');
    assert.equal(resolvePartnerStyle({ partnerStyle: 'direct' }, 'quality-first'), 'direct');
    assert.equal(resolvePartnerStyle({ partnerStyle: 'balanced' }, 'balanced'), 'balanced');
  });

  it('derives the default from the effective mode when unset', () => {
    assert.equal(resolvePartnerStyle({}, 'cost-saver'), 'direct');
    assert.equal(resolvePartnerStyle({}, 'balanced'), 'balanced');
    assert.equal(resolvePartnerStyle({}, 'quality-first'), 'collaborative');
  });
});

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
    assert.deepEqual(config, { onboarded: false, setAsDefault: false, autoUpdate: true });
  });

  it('onboarded defaults to false', async () => {
    const config = await loadConfig(homeDir);
    assert.equal(config.onboarded, false);
  });

  it('setAsDefault defaults to false', async () => {
    const config = await loadConfig(homeDir);
    assert.equal(config.setAsDefault, false);
  });

  it('autoUpdate defaults to true', async () => {
    const config = await loadConfig(homeDir);
    assert.equal(config.autoUpdate, true);
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
    // autoUpdate defaults to true so it is present in the loaded config
    assert.equal(loaded.onboarded, true);
    assert.equal(loaded.setAsDefault, true);
    assert.equal(loaded.autoUpdate, true);
  });

  it('saves and reloads autoGoal: true', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false, autoGoal: true };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.autoGoal, true);
  });

  it('saves and reloads partnerStyle', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false, partnerStyle: 'collaborative' };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.partnerStyle, 'collaborative');
  });

  it('round-trips the memory kill-switch (memory:false)', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false, memory: false };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.memory, false);
  });

  it('round-trips all advanced memory keys (§9)', async () => {
    const cfg: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      memory: true,
      memoryDefaultScope: 'global',
      memoryApproval: 'auto-save-explicit',
      memoryDecayDays: 45,
      memoryMaxFactsPerScope: 120,
    };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.memory, true);
    assert.equal(loaded.memoryDefaultScope, 'global');
    assert.equal(loaded.memoryApproval, 'auto-save-explicit');
    assert.equal(loaded.memoryDecayDays, 45);
    assert.equal(loaded.memoryMaxFactsPerScope, 120);
  });

  it('memory defaults to on when absent (no key written)', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    // Absent → memory on; the kill-switch is only an explicit false.
    assert.notEqual(loaded.memory, false);
  });

  it('preserves autoGoal across a Settings-style config rebuild', () => {
    const config: AppConfig = {
      onboarded: true,
      setAsDefault: false,
      mode: 'quality-first',
      smartRoute: false,
      panel: true,
      learnRouting: true,
      hedge: true,
      autoGoal: true,
    };

    const rebuilt: AppConfig = {
      onboarded: config.onboarded,
      setAsDefault: config.setAsDefault,
      ...(config.mode !== undefined ? { mode: config.mode } : {}),
      ...(config.autoUpdate === false ? { autoUpdate: false } : {}),
      ...(config.nativeSessions === true ? { nativeSessions: true } : {}),
      ...(config.verbosity !== undefined ? { verbosity: config.verbosity } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.smartRoute === false ? { smartRoute: false } : {}),
      ...(config.panel === true ? { panel: true } : {}),
      ...(config.learnRouting === true ? { learnRouting: true } : {}),
      ...(config.hedge === true ? { hedge: true } : {}),
      ...(config.autoGoal === true ? { autoGoal: true } : {}),
    };

    assert.equal(rebuilt.autoGoal, true);
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
      assert.deepEqual(config, { onboarded: false, setAsDefault: false, autoUpdate: true });
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
      // onboarded from disk, setAsDefault + autoUpdate from defaults
      assert.equal(config.onboarded, true);
      assert.equal(config.setAsDefault, false);
      assert.equal(config.autoUpdate, true);
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('on-disk autoUpdate:false is preserved (user opt-out is kept)', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `config-autoupdate-false-${randomUUID()}-`));
    try {
      const configDir = join(home2, '.myshell-tools');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), JSON.stringify({ onboarded: true, setAsDefault: false, autoUpdate: false }), 'utf8');

      const config = await loadConfig(home2);
      assert.equal(config.autoUpdate, false, 'explicit autoUpdate:false must not be overridden by defaults');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  it('on-disk autoUpdate:true is preserved', async () => {
    const home2 = await mkdtemp(join(tmpdir(), `config-autoupdate-true-${randomUUID()}-`));
    try {
      const configDir = join(home2, '.myshell-tools');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), JSON.stringify({ onboarded: true, setAsDefault: false, autoUpdate: true }), 'utf8');

      const config = await loadConfig(home2);
      assert.equal(config.autoUpdate, true, 'explicit autoUpdate:true must be preserved');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });
});
