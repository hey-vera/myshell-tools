/**
 * test/unit/menu-settings-default-shell.test.ts — the DEFAULT-SHELL-TRANSACTION
 * invariant: a failed install/uninstall leaves BOTH shell preference fields
 * unchanged and performs ZERO saves.
 *
 * Run with: node --import ./test/register.mjs --test "test/unit/menu-settings-default-shell.test.ts"
 * Vitest: npx vitest run test/unit/menu-settings-default-shell.test.ts
 */

import { describe, it, vi, expect } from 'vitest';
import assert from 'node:assert/strict';

import { applyDefaultShellResult, toggleDefaultShell } from '../../src/interface/menu-settings.ts';
import type { AppConfig } from '../../src/infra/config.ts';
import type { OutputSink } from '../../src/interface/render.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshOn(): AppConfig {
  return {
    onboarded: true,
    setAsDefault: true,
    defaultShellOptOut: false,
  };
}

function freshOff(): AppConfig {
  return {
    onboarded: true,
    setAsDefault: false,
    defaultShellOptOut: true,
  };
}

function legacyNoOptOut(): AppConfig {
  return {
    onboarded: true,
    setAsDefault: false,
    // defaultShellOptOut absent — pre-migration legacy
  };
}

function richConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    onboarded: true,
    setAsDefault: true,
    defaultShellOptOut: false,
    colorTheme: 'light' as const,
    rollback: false,
    autoUpdate: true,
    ...overrides,
  };
}

function sink(): OutputSink {
  return { write: vi.fn() } as unknown as OutputSink;
}

// ---------------------------------------------------------------------------
// applyDefaultShellResult — pure helper
// ---------------------------------------------------------------------------

describe('applyDefaultShellResult', () => {
  it('failed enable (code=1) returns the exact same reference', () => {
    const config = freshOff();
    const result = applyDefaultShellResult(config, true, 1);
    assert.equal(result, config, 'must return the same object reference');
  });

  it('failed disable (code=1) returns the exact same reference', () => {
    const config = freshOn();
    const result = applyDefaultShellResult(config, false, 1);
    assert.equal(result, config, 'must return the same object reference');
  });

  it('successful enable (code=0, setAsDefault was false → true)', () => {
    const config = freshOff();
    const result = applyDefaultShellResult(config, true, 0);
    assert.notEqual(result, config, 'must return a new object');
    assert.equal(result.setAsDefault, true);
    assert.equal(result.defaultShellOptOut, false);
    assert.equal(result.onboarded, true, 'unrelated key preserved');
  });

  it('successful disable (code=0, setAsDefault was true → false)', () => {
    const config = freshOn();
    const result = applyDefaultShellResult(config, false, 0);
    assert.notEqual(result, config, 'must return a new object');
    assert.equal(result.setAsDefault, false);
    assert.equal(result.defaultShellOptOut, true);
    assert.equal(result.onboarded, true, 'unrelated key preserved');
  });

  it('unrelated-key preservation after successful change', () => {
    const config = richConfig({ experimentalFlag: true } as Partial<AppConfig>);
    const result = applyDefaultShellResult(config, false, 0);
    assert.equal(result.colorTheme, 'light');
    assert.equal(result.rollback, false);
    assert.equal(result.autoUpdate, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal((result as any).experimentalFlag, true);
  });

  it('legacy config missing defaultShellOptOut — enable succeeds', () => {
    const config = legacyNoOptOut();
    const result = applyDefaultShellResult(config, true, 0);
    assert.equal(result.setAsDefault, true);
    assert.equal(result.defaultShellOptOut, false);
    assert.equal(result.onboarded, true);
  });

  it('legacy config missing defaultShellOptOut — disable succeeds', () => {
    const config: AppConfig = { onboarded: true, setAsDefault: true };
    const result = applyDefaultShellResult(config, false, 0);
    assert.equal(result.setAsDefault, false);
    assert.equal(result.defaultShellOptOut, true);
  });

  it('legacy config missing defaultShellOptOut — failure is no-op', () => {
    const config = legacyNoOptOut();
    const result = applyDefaultShellResult(config, true, 1);
    assert.equal(result, config);
  });
});

// ---------------------------------------------------------------------------
// toggleDefaultShell — seam tests: zero saves on failure
// ---------------------------------------------------------------------------

describe('toggleDefaultShell', () => {
  it('failed enable performs ZERO saves', async () => {
    const out = sink();
    const runInstall = vi.fn().mockResolvedValue(1);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const config = freshOff();
    const result = await toggleDefaultShell(config, out, { runInstall, saveConfig });

    assert.equal(runInstall.mock.calls.length, 1);
    assert.equal(saveConfig.mock.calls.length, 0, 'saveConfig must not be called on failure');
    assert.equal(result, config, 'must return the input reference unchanged');
  });

  it('failed disable performs ZERO saves', async () => {
    const out = sink();
    const runInstall = vi.fn().mockResolvedValue(1);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const config = freshOn();
    const result = await toggleDefaultShell(config, out, { runInstall, saveConfig });

    assert.equal(runInstall.mock.calls.length, 1);
    assert.equal(saveConfig.mock.calls.length, 0, 'saveConfig must not be called on failure');
    assert.equal(result, config, 'must return the input reference unchanged');
  });

  it('successful enable saves the updated config', async () => {
    const out = sink();
    const runInstall = vi.fn().mockResolvedValue(0);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const config = freshOff();
    const result = await toggleDefaultShell(config, out, { runInstall, saveConfig });

    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledWith({
      ...config,
      setAsDefault: true,
      defaultShellOptOut: false,
    });
    assert.equal(result.setAsDefault, true);
    assert.equal(result.defaultShellOptOut, false);
    assert.notEqual(result, config);
  });

  it('successful disable saves the updated config', async () => {
    const out = sink();
    const runInstall = vi.fn().mockResolvedValue(0);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const config = freshOn();
    const result = await toggleDefaultShell(config, out, { runInstall, saveConfig });

    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledWith({
      ...config,
      setAsDefault: false,
      defaultShellOptOut: true,
    });
    assert.equal(result.setAsDefault, false);
    assert.equal(result.defaultShellOptOut, true);
    assert.notEqual(result, config);
  });

  it('successful enable preserves unrelated keys in saved config', async () => {
    const out = sink();
    const runInstall = vi.fn().mockResolvedValue(0);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const config = richConfig({ setAsDefault: false, defaultShellOptOut: true });
    const result = await toggleDefaultShell(config, out, { runInstall, saveConfig });

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const saved = saveConfig.mock.calls[0][0] as AppConfig;
    assert.equal(saved.colorTheme, 'light');
    assert.equal(saved.rollback, false);
    assert.equal(saved.autoUpdate, true);
    assert.equal(saved.setAsDefault, true);
    assert.equal(saved.defaultShellOptOut, false);
    assert.notEqual(result, config);
  });

  it('legacy config with missing defaultShellOptOut — successful enable', async () => {
    const out = sink();
    const runInstall = vi.fn().mockResolvedValue(0);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const config = legacyNoOptOut();
    const result = await toggleDefaultShell(config, out, { runInstall, saveConfig });

    expect(saveConfig).toHaveBeenCalledTimes(1);
    assert.equal(result.setAsDefault, true);
    assert.equal(result.defaultShellOptOut, false);
    assert.notEqual(result, config);
  });

  it('legacy config with missing defaultShellOptOut — failed enable ZERO saves', async () => {
    const out = sink();
    const runInstall = vi.fn().mockResolvedValue(1);
    const saveConfig = vi.fn().mockResolvedValue(undefined);

    const config = legacyNoOptOut();
    const result = await toggleDefaultShell(config, out, { runInstall, saveConfig });

    assert.equal(saveConfig.mock.calls.length, 0, 'saveConfig must not be called on failure');
    assert.equal(result, config, 'must return the input reference unchanged');
  });
});
