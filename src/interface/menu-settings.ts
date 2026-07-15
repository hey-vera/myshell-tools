/**
 * src/interface/menu-settings.ts — Extracted from menu.ts — behavior-preserving.
 *
 * The simplified Settings screen: Effort, Speed, oversight, verbosity, appearance,
 * and a Privacy & memory subpage (Memory, Learned preferences, Codebase awareness).
 * Internal implementation toggles (routing, panel, hedge, intent engine, etc.)
 * are now automated default-on and hidden from the user-facing UI. Auto-goal and
 * Partner style are removed from settings (superseded by Auto/Goal Steward).
 *
 * Storage keys remain `mode` (Effort) and `intensity` (Speed). D1 product labels
 * only — Speed is multi-goal concurrency (crossGoalCap), not topology fantasy.
 *
 * Each dialog reads a single key via {@link readMenuKey}, then builds the next
 * AppConfig by spreading the FULL prior config and changing only the field it
 * owns (via {@link withOptional}), persists via {@link saveConfig}, and returns
 * the updated config. Spreading the whole config is load-bearing: a setter must
 * never drop a key it doesn't know about (e.g. the codebaseAwareness privacy
 * kill-switch, `seen` first-touch flags, or the experimental* flags) — doing so
 * would silently erase it on the next toggle. No shared module state — every
 * call is isolated.
 */

import type { AppConfig } from '../infra/config.js';
import { saveConfig, resolvePartnerStyle } from '../infra/config.js';
import type { PartnerStyle } from '../core/prompt-context.js';
import type { Oversight } from './ui/oversight.js';
import { resolveOversight } from './ui/oversight.js';
import type { Mode } from '../core/policy.js';
import type { Intensity } from '../core/capacity-allocator.js';
import {
  levelLabel,
  LEVEL_DESC,
  migrateMode,
  ALL_LEVELS,
  levelToMode,
  ALL_SPEEDS,
  speedLabel,
  SPEED_DESC,
  type SpeedLevel,
} from '../core/mode-levels.js';
import type { Level } from '../core/mode-levels.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { runInstall } from '../commands/install.js';
import { box } from '../ui/tui.js';
import { dim, bold } from '../ui/theme.js';
import { navFooterText } from './ui/nav-footer.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import { resolveAutoMode } from './menu-auto-mode.js';
import { readSubscriptions } from '../infra/subscriptions.js';
import { readMenuKey, NAV_ESC, getMenuStack } from './menu-key-confirm.js';

/**
 * Set an OPTIONAL config field while preserving every other key.
 *
 * The bug this guards against (HIGH severity, silent data loss): the old setters
 * rebuilt `AppConfig` from a hand-listed allow-list, so any key NOT in the list
 * (`codebaseAwareness` — the privacy kill-switch — `seen`, and all nine
 * `experimental*` flags) was permanently erased on the next toggle. The fix is to
 * spread the FULL prior `config` as the base so nothing is ever dropped.
 *
 * For default-having optional fields, `value === undefined` means "fall back to
 * the default", which must be persisted as the ABSENCE of the key — not as
 * `key: undefined` (that would violate `exactOptionalPropertyTypes` and write a
 * meaningless null-ish key). So when clearing, we rebuild the object from the
 * prior config's entries MINUS this key, yielding an object where the key is
 * genuinely omitted (no `delete`, no `key: undefined`).
 */
export function withOptional<K extends keyof AppConfig>(
  config: AppConfig,
  key: K,
  value: AppConfig[K] | undefined,
): AppConfig {
  if (value === undefined) {
    // Clearing → omit the key entirely (default applies on next load). Rebuild
    // from entries so every OTHER key (codebaseAwareness, seen, experimental*)
    // is preserved while this one is dropped.
    const entries = Object.entries(config).filter(([k]) => k !== key);
    return Object.fromEntries(entries) as AppConfig;
  }
  // Setting → spread the full prior config (preserving every other key) and
  // overwrite only this field.
  return { ...config, [key]: value };
}

export async function runModeSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  _autoMode: Mode = 'balanced',
  _env?: EnvironmentStatus,
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  // Map the persisted config.mode (legacy 3-stop dial) to a Level so the picker
  // always shows the 5-choice labels. Unset → 'auto'.
  const currentLevel: Level = migrateMode(config.mode);
  const mark = (l: Level): string =>
    l === currentLevel && config.mode !== undefined ? '  ‹active›' : '';
  const autoActive = config.mode === undefined;

  // D1: Effort dial (lane + verification). Storage key remains `mode`.
  const lines = [
    '',
    bold('New conversation Effort — default for future conversations', out.color),
    dim('Effort sets model lane + verification. Speed (multi-goal concurrency / crossGoalCap) is separate and derives from Effort when unset. Existing conversations keep their own Effort.', out.color),
    dim('Claude/Grok provider-native --effort is experimental and OFF by default (MYSHELL_PROVIDER_EFFORT=1).', out.color),
    '',
  ];

  for (const level of ALL_LEVELS) {
    const label = levelLabel(level);
    const desc = LEVEL_DESC[level];
    // Deliberately keep High shown but call out "(future)" since no separate preset exists yet.
    const suffix = level === 'high' ? ' (future)' : '';
    const active = level === currentLevel && config.mode !== undefined ? '  ‹active›' : '';
    const idx = ALL_LEVELS.indexOf(level) + 1;
    if (level === 'auto') {
      const autoLine = autoActive
        ? `  [${idx}] ${bold(label, out.color)} (smart) — ${desc}${suffix}  ‹active›`
        : `  [${idx}] ${bold(label, out.color)} (smart) — ${desc}${suffix}`;
      lines.push(autoActive ? autoLine : dim(autoLine, out.color));
    } else {
      const line = `  [${idx}] ${bold(label, out.color)} — ${desc}${suffix}${active}`;
      lines.push(mark(level) !== '' ? line : dim(line, out.color));
    }
  }

  // Auto-detected block intentionally omitted — Accounts inventory is the source
  // of truth for Auto defaults (see actualization checklist P0.3 / P1.2).

  out.write('\n' + lines.filter((l) => l !== '').join('\n') + '\n\n');

  out.write('[1-5 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); }

  // Map keypress via ALL_LEVELS index → levelToMode (Budget=1 … Auto=5).
  // High and Max both project to quality-first until a separate High preset exists.
  let newMode: AppConfig['mode'];
  const keyIdx = key !== null && key.length === 1 ? key.charCodeAt(0) - '1'.charCodeAt(0) : -1;
  if (keyIdx >= 0 && keyIdx < ALL_LEVELS.length) {
    const level = ALL_LEVELS[keyIdx] as Level;
    newMode = levelToMode(level);
  } else {
    newMode = config.mode; // Enter / EOF / unknown — keep current
  }

  const updated: AppConfig = withOptional(config, 'mode', newMode);
  await saveConfig(updated);
  // No redundant "Effort: …" confirmation — the live home/new-conv box is truth.
  return updated;
}

/**
 * Choose the global **Speed** dial (storage key `intensity`) and persist it.
 *
 * Speed = multi-goal concurrency regime (feeds `crossGoalCap` via capacity-
 * allocator). Honest product truth: not topology, worker fan-out, or early
 * termination. Auto (absent) lets Effort-derived / per-turn heuristics decide.
 */
export async function runSpeedSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  const current: SpeedLevel =
    config.intensity === 1 ||
    config.intensity === 2 ||
    config.intensity === 3 ||
    config.intensity === 4 ||
    config.intensity === 5
      ? config.intensity
      : 'auto';

  const lines = [
    '',
    bold('New conversation Speed — multi-goal concurrency default', out.color),
    dim('Speed sets the multi-goal concurrency ceiling (crossGoalCap). It is NOT topology, worker count, or fan-out fantasy. Storage key: intensity.', out.color),
    dim('When Auto/unset, Speed derives from Effort (or per-turn Auto). Existing conversations may keep their own Speed override.', out.color),
    '',
  ];

  for (const speed of ALL_SPEEDS) {
    const label = speedLabel(speed);
    const desc = SPEED_DESC[String(speed)] ?? '';
    const idx = ALL_SPEEDS.indexOf(speed) + 1;
    const active = speed === current ? '  ‹active›' : '';
    const line =
      speed === 'auto'
        ? `  [${idx}] ${bold(label, out.color)} (smart) — ${desc}${active}`
        : `  [${idx}] ${bold(label, out.color)} — ${desc}${active}`;
    lines.push(speed === current ? line : dim(line, out.color));
  }

  out.write('\n' + lines.filter((l) => l !== '').join('\n') + '\n\n');
  out.write('[1-6 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) {
    getMenuStack().requestExit();
  }

  let newIntensity: Intensity | undefined;
  const keyIdx = key !== null && key.length === 1 ? key.charCodeAt(0) - '1'.charCodeAt(0) : -1;
  if (keyIdx >= 0 && keyIdx < ALL_SPEEDS.length) {
    const picked = ALL_SPEEDS[keyIdx] as SpeedLevel;
    newIntensity = picked === 'auto' ? undefined : picked;
  } else {
    newIntensity = config.intensity;
  }

  const updated: AppConfig = withOptional(config, 'intensity', newIntensity);
  await saveConfig(updated);
  return updated;
}

/**
 * Choose the output-detail (verbosity) level and persist it.
 *
 *   quiet   → model prose + errors only (no status line)
 *   normal  → clean conversation: prose, errors, one minimal completion line
 *   verbose → everything (tool/reasoning lines + per-tier telemetry)
 *
 * Default is 'normal' (undefined counts as normal). Preserves all other config
 * fields via conditional spread so changing detail doesn't reset other prefs.
 */
export async function runVerbositySelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  // Single-key reader for the Ink path (see runModeSelect). Absent → legacy path.
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  const current = config.verbosity ?? 'normal';
  const settingsLines = [
    '',
    'Output detail:',
    `  [1] quiet${current === 'quiet' ? ' (active)' : ''}`,
    `  [2] normal${current === 'normal' ? ' (active)' : ''}`,
    `  [3] verbose${current === 'verbose' ? ' (active)' : ''}`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('[1/2/3 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); }

  // EOF / Enter → keep current
  let newVerbosity = config.verbosity;
  if (key === '1') newVerbosity = 'quiet';
  else if (key === '2') newVerbosity = 'normal';
  else if (key === '3') newVerbosity = 'verbose';

  const updated: AppConfig = withOptional(config, 'verbosity', newVerbosity);

  await saveConfig(updated);
  out.write(`Output detail set to: ${newVerbosity ?? 'normal'}\n`);
  return updated;
}

/**
 * Choose the partner posture (soft bias) and persist it.
 *
 *   direct        → lean toward executing on a reasonable default
 *   balanced      → reflect briefly on substantial work, ask at genuine forks
 *   collaborative → align on the approach before heavy execution
 *
 * It is a SOFT BIAS, not a hard mode (APE §2): it nudges the engagement
 * thresholds and never forces an action the turn's signals contradict. Absent →
 * resolved from the effective mode (`resolvePartnerStyle`). "Auto" clears the
 * explicit override so the style follows the mode again. Preserves all other
 * config fields via conditional spread.
 */
export async function runStyleSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  autoMode: Mode,
  // Single-key reader for the Ink path (see runModeSelect). Absent → legacy path.
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  const effMode = config.mode ?? autoMode;
  const resolved = resolvePartnerStyle(config, effMode);
  const isAuto = config.partnerStyle === undefined;
  const settingsLines = [
    '',
    'Partner style (how I engage — a soft bias, not a hard mode):',
    `  [1] direct${resolved === 'direct' ? ' (active)' : ''} — prefer a sensible default and proceed`,
    `  [2] balanced${resolved === 'balanced' ? ' (active)' : ''} — reflect briefly, ask at genuine forks`,
    `  [3] collaborative${resolved === 'collaborative' ? ' (active)' : ''} — align on the approach first`,
    `  [4] auto${isAuto ? ' (active)' : ''} — follow the Mode dial (${resolved})`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('[1/2/3/4 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); }

  // EOF / Enter → keep current.
  let newStyle: PartnerStyle | undefined = config.partnerStyle;
  if (key === '1') newStyle = 'direct';
  else if (key === '2') newStyle = 'balanced';
  else if (key === '3') newStyle = 'collaborative';
  else if (key === '4') newStyle = undefined; // clear explicit override → auto

  const updated: AppConfig = withOptional(config, 'partnerStyle', newStyle);

  await saveConfig(updated);
  out.write(
    `Partner style set to: ${newStyle ?? `auto (${resolvePartnerStyle(updated, effMode)})`}\n`,
  );
  return updated;
}

/**
 * Choose the OVERSIGHT level (execution autonomy) and persist it — the per-user
 * "how much do I review vs. let you run" dial, DISTINCT from partner style (a soft
 * conversational bias). Modelled on Claude Code's permission modes:
 *
 *   review-all → confirm before launch AND pause on each to-do's diff
 *   checkpoint → propose-then-one-tap-go, then run (DEFAULT, the safe middle)
 *   autonomous → just do it; report when done (the mid-run safety floor stays)
 *
 * Absent → 'checkpoint' (resolveOversight). Persists the EXPLICIT level (there is no
 * "auto" clear-to-default here: the default IS checkpoint, so picking checkpoint
 * just writes checkpoint). Preserves every other config key via withOptional.
 */
export async function runOversightSelect(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  // Single-key reader for the Ink path (see runModeSelect). Absent → legacy path.
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  const current: Oversight = resolveOversight(config);
  const settingsLines = [
    '',
    'Oversight (how much you review vs. let me run — separate from partner style):',
    `  [1] review-all${current === 'review-all' ? ' (active)' : ''} — tell me every change; I pause on each diff for your OK`,
    `  [2] checkpoint${current === 'checkpoint' ? ' (active)' : ''} — I propose the plan, you tap go, then I run (default)`,
    `  [3] autonomous${current === 'autonomous' ? ' (active)' : ''} — just do it; I report when it's done`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('[1/2/3 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); }

  // EOF / Enter → keep current.
  let newLevel: Oversight = current;
  if (key === '1') newLevel = 'review-all';
  else if (key === '2') newLevel = 'checkpoint';
  else if (key === '3') newLevel = 'autonomous';

  const updated: AppConfig = withOptional(config, 'oversight', newLevel);

  await saveConfig(updated);
  out.write(`Oversight set to: ${newLevel}\n`);
  return updated;
}

/**
 * Pure helper: given the install/uninstall result code, produce the next
 * AppConfig. Returns the input reference unchanged on failure (code !== 0).
 *
 * Successful enable  → setAsDefault:true,  defaultShellOptOut:false.
 * Successful disable → setAsDefault:false, defaultShellOptOut:true.
 */
export function applyDefaultShellResult(
  config: AppConfig,
  enable: boolean,
  code: number,
): AppConfig {
  if (code !== 0) return config;
  return { ...config, setAsDefault: enable, defaultShellOptOut: !enable };
}

/**
 * Toggle the "set as default shell" preference and actually install/uninstall
 * the shell startup hook to match. The config is only mutated when the hook
 * write succeeds, so the stored values never lie about the real state.
 *
 * Accepts an optional deps bag ({runInstall, saveConfig}) so tests can inject
 * spies and assert the zero-save invariant on failure.
 */
export async function toggleDefaultShell(
  config: AppConfig,
  out: OutputSink,
  deps: {
    runInstall: (out: OutputSink, opts?: { uninstall?: boolean }) => Promise<number>;
    saveConfig: (config: AppConfig) => Promise<void>;
  } = { runInstall, saveConfig },
): Promise<AppConfig> {
  const enable = !config.setAsDefault;
  const code = await deps.runInstall(out, enable ? undefined : { uninstall: true });
  const updated = applyDefaultShellResult(config, enable, code);
  if (updated !== config) {
    await deps.saveConfig(updated);
  }
  return updated;
}

/**
 * Toggle the CODEBASE AWARENESS master switch and persist it.
 *
 * Default-on: absent/true means the chat gathers repo-map orientation context
 * once per session. `false` is the kill-switch: no scan, no block. Toggling
 * when on writes `codebaseAwareness:false`; toggling when off removes the flag
 * (restores default-on). Preserves all other keys.
 */
export async function toggleCodebaseAwareness(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currentlyEnabled = config.codebaseAwareness !== false;
  const enable = !currentlyEnabled;
  const updated: AppConfig = withOptional(config, 'codebaseAwareness', enable ? undefined : false);
  await saveConfig(updated);
  out.write(`Codebase awareness: ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Privacy & memory subpage. Groups the three privacy-related toggles.
 */
async function runPrivacyMemory(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  const lines = [
    '',
    `  [1] Memory: ${config.memory !== false ? 'on' : 'off'}`,
    `  [2] Learned preferences: on`,
    `  [3] Codebase awareness: ${config.codebaseAwareness !== false ? 'on' : 'off'}`,
    '',
    '  [Enter] Back',
    '',
  ];
  out.write('\n' + box('Privacy & memory', lines) + '\n\n');

  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); }

  if (key === null || key.length === 0) return config;

  if (key === '1') return toggleMemory(config, out);
  if (key === '2') {
    out.write(`Learned preferences: always on (shipped-on feature).\n`);
    return config;
  }
  if (key === '3') return toggleCodebaseAwareness(config, out);

  return config;
}

/**
 * Setup subpage. Contains install/integration actions, not daily tuning.
 */
async function runSetup(
  config: AppConfig,
  out: OutputSink,
  readLine: () => Promise<string | null>,
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  const lines = [
    '',
    `  [1] Set as default shell: ${config.setAsDefault ? 'on' : 'off'}`,
    '',
    '  [Enter] Back',
    '',
  ];
  out.write('\n' + box('Setup', lines) + '\n\n');

  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); }

  if (key === null || key.length === 0) return config;

  if (key === '1') return toggleDefaultShell(config, out);

  return config;
}

export async function runSettings(
  _ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  out: OutputSink,
  readLine: () => Promise<string | null>,
  // Single-key reader for the Ink path. Threaded into the top-level Settings menu
  // read AND into every sub-dialog (mode/verbosity/privacy) so ALL menu navigation is
  // single-key under Ink. Absent → legacy path is byte-identical.
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  const cfg = mutableCtx.config;
  const accounts = await readSubscriptions()
    .then((s) => s.accounts)
    .catch(() => [] as const);
  const autoMode = resolveAutoMode(mutableCtx.env, accounts);
  const settingsLines = [
    '',
    `  [1] New conversation Effort: ${cfg.mode === undefined ? 'Auto (smart)' : levelLabel(migrateMode(cfg.mode))}`,
    `  [2] New conversation Speed: ${speedLabel(cfg.intensity)}`,
    `  [3] Oversight: ${resolveOversight(cfg)}`,
    `  [4] Output detail: ${cfg.verbosity ?? 'normal'}`,
    `  [5] Appearance: ${cfg.colorTheme ?? 'dark'}`,
    `  [6] Privacy & memory`,
    `  [7] Setup`,
    '',
    '  [Enter] Back · ' + navFooterText('exit-only', out.color),
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);
  if (key === NAV_ESC) { getMenuStack().requestExit(); }

  // EOF or Enter → back, no change
  if (key === null || key.length === 0) return;

  if (key === '1') {
    mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode, mutableCtx.env, inkReadKey);
  } else if (key === '2') {
    mutableCtx.config = await runSpeedSelect(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '3') {
    mutableCtx.config = await runOversightSelect(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '4') {
    mutableCtx.config = await runVerbositySelect(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '5') {
    mutableCtx.config = await toggleColorTheme(mutableCtx.config, out);
  } else if (key === '6') {
    mutableCtx.config = await runPrivacyMemory(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '7') {
    mutableCtx.config = await runSetup(mutableCtx.config, out, readLine, inkReadKey);
  }
  // anything else → back
}

/**
 * Toggle the USER MEMORY master switch (memory-architecture §9) and persist it.
 *
 * Default-on: memory is enabled unless `memory` is explicitly false. Toggling
 * when on writes `memory:false` (the privacy kill-switch — no retrieval, no
 * injection, no proposals); toggling when off removes the flag (restores
 * default-on). The advanced memory keys are config-file-only and preserved.
 */
export async function toggleMemory(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currentlyEnabled = config.memory !== false;
  const enable = !currentlyEnabled;
  // Persist only the explicit-OFF; absent means default-on. Spreading the full
  // prior config preserves every other key (including the advanced memory* keys).
  const updated: AppConfig = withOptional(config, 'memory', enable ? undefined : false);
  await saveConfig(updated);
  out.write(`Memory: ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the terminal COLOR THEME and persist it.
 *
 * 'dark' (default, absent) → keep ANSI faint (dim) for muted secondary text on
 * dark terminal backgrounds. 'light' → skip ANSI faint (SGR 2), which is
 * near-invisible on white/light terminals, so secondary text stays readable.
 * Takes effect on the next launch (the CLI sets MYSHELL_THEME from this at
 * startup). Toggling writes the explicit value; toggling back to 'dark' removes
 * the key (restores default).
 */
export async function toggleColorTheme(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currentlyLight = config.colorTheme === 'light';
  const newTheme: 'dark' | 'light' | undefined = currentlyLight ? undefined : 'light';
  const updated: AppConfig = withOptional(config, 'colorTheme', newTheme);
  await saveConfig(updated);
  out.write(`Theme: ${newTheme ?? 'dark'}${newTheme === undefined ? ' (default)' : ''} — takes effect on next launch\n`);
  return updated;
}
