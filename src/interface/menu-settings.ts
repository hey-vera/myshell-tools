/**
 * src/interface/menu-settings.ts — Extracted from menu.ts — behavior-preserving.
 *
 * The simplified Settings screen: mode, oversight, verbosity, appearance, and a
 * Privacy & memory subpage (Memory, Learned preferences, Codebase awareness).
 * Internal implementation toggles (routing, panel, hedge, intent engine, etc.)
 * are now automated default-on and hidden from the user-facing UI. Auto-goal and
 * Partner style are removed from settings (superseded by Auto/Goal Steward).
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
import { levelLabel, LEVEL_DESC, migrateMode, ALL_LEVELS } from '../core/mode-levels.js';
import type { Level } from '../core/mode-levels.js';
import type { EnvironmentStatus } from '../providers/detect.js';
import { runInstall } from '../commands/install.js';
import { box } from '../ui/tui.js';
import { dim, bold } from '../ui/theme.js';
import type { OutputSink } from './render.js';
import type { MenuContext } from './menu.js';
import { resolveAutoMode, renderAutoDetected } from './menu-auto-mode.js';
import { readMenuKey } from './menu-key-confirm.js';
import { tasteEnabled } from '../core/taste-flag.js';

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
function withOptional<K extends keyof AppConfig>(
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
  env?: EnvironmentStatus,
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  // Map the persisted config.mode (legacy 3-stop dial) to a Level so the picker
  // always shows the 5-choice labels. Unset → 'auto'.
  const currentLevel: Level = migrateMode(config.mode);
  const mark = (l: Level): string =>
    l === currentLevel && config.mode !== undefined ? '  ‹active›' : '';
  const autoActive = config.mode === undefined;

  // Build the display lines with the redesigned labels.
  const lines = [
    '',
    bold('New conversation mode — default for future conversations', out.color),
    dim('This is the default new conversations start with. Existing conversations keep their own mode.', out.color),
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

  // Honest per-provider breakdown of what Auto detected.
  if (env !== undefined) {
    lines.push('', ...renderAutoDetected(env, out.color));
  }

  out.write('\n' + lines.filter((l) => l !== '').join('\n') + '\n\n');

  out.write('[1-5 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  // Map keypress to the legacy config.mode value (or clear for Auto).
  // High aliases Max (quality-first) until a separate High preset exists.
  let newMode: AppConfig['mode'];
  if (key === '1') newMode = undefined;        // Auto — clear pin
  else if (key === '2') newMode = 'cost-saver'; // Budget
  else if (key === '3') newMode = 'balanced';   // Balanced
  else if (key === '4') newMode = 'quality-first'; // High (alias Max)
  else if (key === '5') newMode = 'quality-first'; // Max
  else newMode = config.mode; // Enter / EOF — keep current

  const updated: AppConfig = withOptional(config, 'mode', newMode);
  await saveConfig(updated);
  const displayLabel = newMode === undefined ? 'Auto (smart)' : levelLabel(migrateMode(newMode));
  out.write(`New conversation default: ${displayLabel}\n`);
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
async function runVerbositySelect(
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
    `  [4] auto${isAuto ? ' (active)' : ''} — follow the mode (${resolved})`,
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('[1/2/3/4 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

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
 * Toggle the "set as default shell" preference and actually install/uninstall
 * the shell startup hook to match. The config flag is only flipped when the
 * hook write succeeds, so the stored value never lies about the real state.
 */
async function toggleDefaultShell(
  config: AppConfig,
  out: OutputSink,
): Promise<AppConfig> {
  const enable = !config.setAsDefault;
  // runInstall reports exactly what it wrote (or removed) and how to reverse.
  const code = await runInstall(out, enable ? undefined : { uninstall: true });

  // Only adopt the new state if the hook write succeeded; otherwise keep the old.
  const setAsDefault = code === 0 ? enable : config.setAsDefault;

  // Persist defaultShellOptOut so future loadConfig migrations can distinguish
  // a deliberate toggle-off from an old inherited false.
  const updated: AppConfig = { ...config, setAsDefault, defaultShellOptOut: !enable };
  await saveConfig(updated);
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
async function toggleCodebaseAwareness(config: AppConfig, out: OutputSink): Promise<AppConfig> {
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
    `  [2] Learned preferences: ${tasteEnabled(process.env, config) ? 'on' : 'off'}`,
    `  [3] Codebase awareness: ${config.codebaseAwareness !== false ? 'on' : 'off'}`,
    '',
    '  [Enter] Back',
    '',
  ];
  out.write('\n' + box('Privacy & memory', lines) + '\n\n');

  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  if (key === null || key.length === 0) return config;

  if (key === '1') return toggleMemory(config, out);
  if (key === '2') return toggleLearnedTaste(config, out);
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
  const autoMode = resolveAutoMode(mutableCtx.env);
  const settingsLines = [
    '',
    `  [1] New conversation mode: ${cfg.mode === undefined ? 'Auto (smart)' : levelLabel(migrateMode(cfg.mode))}`,
    `  [2] Oversight: ${resolveOversight(cfg)}`,
    `  [3] Output detail: ${cfg.verbosity ?? 'normal'}`,
    `  [4] Appearance: ${cfg.colorTheme ?? 'dark'}`,
    `  [5] Privacy & memory`,
    `  [6] Setup`,
    '',
    '  [Enter] Back',
    '',
  ];
  out.write('\n' + box('Settings', settingsLines) + '\n\n');

  out.write('> ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  // EOF or Enter → back, no change
  if (key === null || key.length === 0) return;

  if (key === '1') {
    mutableCtx.config = await runModeSelect(mutableCtx.config, out, readLine, autoMode, mutableCtx.env, inkReadKey);
  } else if (key === '2') {
    mutableCtx.config = await runOversightSelect(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '3') {
    mutableCtx.config = await runVerbositySelect(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '4') {
    mutableCtx.config = await toggleColorTheme(mutableCtx.config, out);
  } else if (key === '5') {
    mutableCtx.config = await runPrivacyMemory(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '6') {
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
async function toggleMemory(config: AppConfig, out: OutputSink): Promise<AppConfig> {
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
 * Toggle the LEARNED-TASTE / PREFERENCE ledger (free observed layer).
 * Default ON (max intelligence). Records only real user signals (edits, rephrases,
 * fork choices, push-back outcomes). Distills to playbook + ask-vs-proceed bias
 * for prompts/engagement. No quota fiction — pure preference + observed outcomes.
 * Opt-out via explicit false (for compat with experimentalTaste).
 */
async function toggleLearnedTaste(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currently = tasteEnabled(process.env, config);
  const enable = !currently;
  // Persist explicit false only when off (absent or true = on). Spread full config.
  const updated: AppConfig = withOptional(config, 'experimentalTaste', enable ? undefined : false);
  await saveConfig(updated);
  out.write(`Learned taste / prefs (free layer): ${enable ? 'on' : 'off'}\n`);
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
async function toggleColorTheme(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currentlyLight = config.colorTheme === 'light';
  const newTheme: 'dark' | 'light' | undefined = currentlyLight ? undefined : 'light';
  const updated: AppConfig = withOptional(config, 'colorTheme', newTheme);
  await saveConfig(updated);
  out.write(`Theme: ${newTheme ?? 'dark'}${newTheme === undefined ? ' (default)' : ''} — takes effect on next launch\n`);
  return updated;
}

