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
    assert.deepEqual(config, {
      onboarded: false,
      setAsDefault: true,
      autoUpdate: true,
      nativeSessions: true,
      smartRoute: true,
      learnRouting: true,
      intentEngine: true,
      experimentalVendorNeutralRouter: true,
    });
  });

  it('onboarded defaults to false', async () => {
    const config = await loadConfig(homeDir);
    assert.equal(config.onboarded, false);
  });

  it('setAsDefault defaults to true', async () => {
    const config = await loadConfig(homeDir);
    assert.equal(config.setAsDefault, true);
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
    // Migration flips old false → true unless defaultShellOptOut is set
    assert.equal(loaded.setAsDefault, true);
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

  it('round-trips the persistent rollback override', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false, rollback: true };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.rollback, true);
  });

  it('saves and reloads partnerStyle', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false, partnerStyle: 'collaborative' };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.partnerStyle, 'collaborative');
  });

  it('round-trips intensity', async () => {
    const cfg: AppConfig = { onboarded: true, setAsDefault: false, intensity: 4 };
    await saveConfig(cfg, homeDir);
    const loaded = await loadConfig(homeDir);
    assert.equal(loaded.intensity, 4);
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
      assert.deepEqual(config, {
        onboarded: false,
        setAsDefault: true,
        autoUpdate: true,
        nativeSessions: true,
        smartRoute: true,
        learnRouting: true,
        intentEngine: true,
        experimentalVendorNeutralRouter: true,
      });
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
      assert.equal(config.setAsDefault, true);
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
      const file = JSON.stringify({ onboarded: true, setAsDefault: false, autoUpdate: false });
      await writeFile(join(configDir, 'config.json'), file, 'utf8');

      const config = await loadConfig(home2);
      // setAsDefault:false without defaultShellOptOut → migration flips to true
      assert.equal(config.setAsDefault, true, 'migration must flip old false to true');
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
      await writeFile(join(configDir, 'config.json'), JSON.stringify({ onboarded: true, setAsDefault: false, defaultShellOptOut: true, autoUpdate: true }), 'utf8');

      const config = await loadConfig(home2);
      // defaultShellOptOut:true → migration leaves setAsDefault false
      assert.equal(config.setAsDefault, false, 'explicit defaultShellOptOut must preserve false');
      assert.equal(config.autoUpdate, true, 'explicit autoUpdate:true must be preserved');
    } finally {
      await rm(home2, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // setAsDefault migration (default-on)
  // -------------------------------------------------------------------------

  it('migration: old setAsDefault:false without defaultShellOptOut → flipped to true', async () => {
    const home = await mkdtemp(join(tmpdir(), `config-migrate-${randomUUID()}-`));
    try {
      const dir = join(home, '.myshell-tools');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'config.json'), JSON.stringify({ onboarded: true, setAsDefault: false }), 'utf8');

      const config = await loadConfig(home);
      assert.equal(config.setAsDefault, true, 'old false without opt-out must be migrated to true');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('migration: old setAsDefault:false with defaultShellOptOut:false still migrated', async () => {
    const home = await mkdtemp(join(tmpdir(), `config-migrate2-${randomUUID()}-`));
    try {
      const dir = join(home, '.myshell-tools');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'config.json'), JSON.stringify({ onboarded: true, setAsDefault: false, defaultShellOptOut: false }), 'utf8');

      const config = await loadConfig(home);
      assert.equal(config.setAsDefault, true, 'false opt-out + false setAsDefault still means no real opt-out');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('migration: setAsDefault:true is never touched regardless of defaultShellOptOut', async () => {
    const home = await mkdtemp(join(tmpdir(), `config-migrate3-${randomUUID()}-`));
    try {
      const dir = join(home, '.myshell-tools');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'config.json'), JSON.stringify({ onboarded: true, setAsDefault: true, defaultShellOptOut: true }), 'utf8');

      const config = await loadConfig(home);
      assert.equal(config.setAsDefault, true, 'already-true must stay true');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('migration: absent setAsDefault uses default (true)', async () => {
    const home = await mkdtemp(join(tmpdir(), `config-migrate4-${randomUUID()}-`));
    try {
      const dir = join(home, '.myshell-tools');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'config.json'), JSON.stringify({ onboarded: true }), 'utf8');

      const config = await loadConfig(home);
      assert.equal(config.setAsDefault, true, 'absent field must default to true');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Backward compat: removed-feature keys still parse from old config files
  // -------------------------------------------------------------------------

  it('old config with autoGoal, partnerStyle, and intensity still loads without error', async () => {
    const home = await mkdtemp(join(tmpdir(), `config-oldkeys-${randomUUID()}-`));
    try {
      const dir = join(home, '.myshell-tools');
      await mkdir(dir, { recursive: true });
      const oldConfig = JSON.stringify({
        onboarded: true,
        setAsDefault: false,
        defaultShellOptOut: true,
        mode: 'quality-first',
        intensity: 4,
        autoGoal: true,
        partnerStyle: 'collaborative',
        autoUpdate: false,
      });
      await writeFile(join(dir, 'config.json'), oldConfig, 'utf8');

      const config = await loadConfig(home);
      assert.equal(config.onboarded, true);
      assert.equal(config.mode, 'quality-first');
      assert.equal(config.intensity, 4);
      assert.equal(config.autoGoal, true);
      assert.equal(config.partnerStyle, 'collaborative');
      assert.equal(config.autoUpdate, false);
      // defaultShellOptOut preserves the explicit false
      assert.equal(config.setAsDefault, false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('old config with experimental* removed-feature keys still loads', async () => {
    const home = await mkdtemp(join(tmpdir(), `config-oldkeys2-${randomUUID()}-`));
    try {
      const dir = join(home, '.myshell-tools');
      await mkdir(dir, { recursive: true });
      const oldConfig = JSON.stringify({
        onboarded: true,
        setAsDefault: false,
        defaultShellOptOut: true,
        experimentalAutoGoal: true,
        experimentalLevelDial: true,
      });
      await writeFile(join(dir, 'config.json'), oldConfig, 'utf8');

      const config = await loadConfig(home);
      assert.equal(config.onboarded, true);
      assert.equal(config.experimentalAutoGoal, true);
      assert.equal(config.experimentalLevelDial, true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
