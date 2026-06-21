/**
 * src/interface/menu-settings.ts — Extracted from menu.ts — behavior-preserving.
 *
 * The Settings screen: the mode/verbosity/partner-style selectors and the
 * feature toggles (default-shell, auto-update, native sessions, smart routing,
 * panel, hedge, learned routing, auto-goal, memory, intent engine). Each
 * dialog reads a single key via {@link readMenuKey}, then builds the next
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
import { modeLabel, MODE_DESC } from '../core/policy.js';
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
  autoMode: Mode = 'balanced',
  env?: EnvironmentStatus,
  // Single-key reader for the Ink path. When provided, the menu choice resolves on
  // a SINGLE keypress through Ink's own input pipeline (matching the legacy raw
  // single-key feel) instead of a line read. Absent → legacy path is byte-identical.
  inkReadKey?: () => Promise<string>,
): Promise<AppConfig> {
  // Effective mode = explicit choice, else the subscription-derived auto default.
  const effective = config.mode ?? autoMode;
  const mark = (m: Mode): string => (effective === m && config.mode !== undefined ? '  ‹active›' : '');
  const autoActive = config.mode === undefined;
  const autoEntry = autoActive
    ? `  [4] Auto — picks from your subscriptions (now: ${modeLabel(autoMode)})  ‹active›`
    : `  [4] Auto — picks from your subscriptions`;
  // Plain lines (NOT box()) — the descriptions are long and would overflow a
  // fixed-width box border.
  const lines = [
    '',
    bold('Mode — how readily routing reaches the strongest model', out.color),
    dim('Efficient never auto-opens it; Balanced earns one pass when a turn proves it needs it; Max opens it whenever asked.', out.color),
    '',
    `  [1] ${bold(modeLabel('cost-saver'), out.color)} — ${MODE_DESC['cost-saver']}${mark('cost-saver')}`,
    `  [2] ${bold(modeLabel('balanced'), out.color)} — ${MODE_DESC['balanced']}${mark('balanced')}`,
    `  [3] ${bold(modeLabel('quality-first'), out.color)} — ${MODE_DESC['quality-first']}${mark('quality-first')}`,
    autoActive ? autoEntry : dim(autoEntry, out.color),
    // Honest per-provider breakdown of what Auto saw and why it decided.
    ...(env !== undefined ? ['', ...renderAutoDetected(env, out.color)] : []),
  ];
  out.write('\n' + lines.filter((l) => l !== '').join('\n') + '\n\n');

  out.write('[1/2/3/4 to change, Enter to keep] ');
  const key = await readMenuKey(out, readLine, undefined, false, inkReadKey);

  // EOF / Enter → keep current mode
  let newMode = config.mode;
  if (key === '1') newMode = 'cost-saver';
  else if (key === '2') newMode = 'balanced';
  else if (key === '3') newMode = 'quality-first';
  else if (key === '4') newMode = undefined; // clear pin → auto

  // Spread the FULL prior config so no key is ever dropped, then set only the
  // field this dialog owns. `mode === undefined` means "Auto" → omit the key
  // entirely (don't write `mode: undefined`, which violates
  // exactOptionalPropertyTypes and would be a meaningless on-disk key).
  const updated: AppConfig = withOptional(config, 'mode', newMode);

  await saveConfig(updated);
  out.write(`Mode: ${modeLabel(newMode ?? autoMode)}${newMode === undefined ? ' (auto)' : ''}\n`);
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

  // Spread the full prior config so no key is dropped; set only setAsDefault.
  const updated: AppConfig = { ...config, setAsDefault };
  await saveConfig(updated);
  return updated;
}

export async function runSettings(
  _ctx: MenuContext,
  mutableCtx: { config: AppConfig; env: EnvironmentStatus },
  out: OutputSink,
  readLine: () => Promise<string | null>,
  // Single-key reader for the Ink path. Threaded into the top-level Settings menu
  // read AND into every sub-dialog (mode/verbosity/style) so ALL menu navigation is
  // single-key under Ink. Absent → legacy path is byte-identical.
  inkReadKey?: () => Promise<string>,
): Promise<void> {
  const cfg = mutableCtx.config;
  const autoMode = resolveAutoMode(mutableCtx.env);
  const effMode = cfg.mode ?? autoMode;
  const settingsLines = [
    '',
    `  [1] Mode: ${modeLabel(effMode)}${cfg.mode === undefined ? ' (auto)' : ''}`,
    `  [2] Set as default shell: ${cfg.setAsDefault ? 'on' : 'off'}`,
    `  [3] Update on launch: ${cfg.autoUpdate !== false ? 'on' : 'off'}`,
    `  [4] Native sessions (experimental): ${cfg.nativeSessions === true ? 'on' : 'off'}`,
    `  [5] Output detail: ${cfg.verbosity ?? 'normal'}`,
    `  [6] Smart routing: ${cfg.smartRoute !== false ? 'on' : 'off'}`,
    `  [7] Panel (experimental): ${cfg.panel === true ? 'on' : 'off'}`,
    `  [8] Learned routing (experimental): ${cfg.learnRouting === true ? 'on' : 'off'}`,
    `  [9] Hedged escalation (experimental): ${cfg.hedge === true ? 'on' : 'off'}`,
    `  [t] Learned taste / prefs (free layer): ${tasteEnabled(process.env, cfg) ? 'on' : 'off'}`,
    `  [a] Auto-goal (quality-first): ${cfg.autoGoal === true ? 'on' : 'off'} — only takes effect under quality-first mode`,
    `  [b] Partner style: ${resolvePartnerStyle(cfg, effMode)}${cfg.partnerStyle === undefined ? ' (auto)' : ''}`,
    `  [c] Memory: ${cfg.memory !== false ? 'on' : 'off'}`,
    `  [d] Intent engine: ${cfg.intentEngine !== false ? 'on' : 'off'}`,
    `  [e] Oversight: ${resolveOversight(cfg)}`,
    `  [f] Theme: ${cfg.colorTheme ?? 'dark'}`,
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
    mutableCtx.config = await toggleDefaultShell(mutableCtx.config, out);
  } else if (key === '3') {
    mutableCtx.config = await toggleAutoUpdate(mutableCtx.config, out);
  } else if (key === '4') {
    mutableCtx.config = await toggleNativeSessions(mutableCtx.config, out);
  } else if (key === '5') {
    mutableCtx.config = await runVerbositySelect(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === '6') {
    mutableCtx.config = await toggleSmartRoute(mutableCtx.config, out);
  } else if (key === '7') {
    mutableCtx.config = await togglePanel(mutableCtx.config, out);
  } else if (key === '8') {
    mutableCtx.config = await toggleLearnRouting(mutableCtx.config, out);
  } else if (key === '9') {
    mutableCtx.config = await toggleHedge(mutableCtx.config, out);
  } else if (key === 't') {
    mutableCtx.config = await toggleLearnedTaste(mutableCtx.config, out);
  } else if (key === 'a') {
    mutableCtx.config = await toggleAutoGoal(mutableCtx.config, out);
  } else if (key === 'b') {
    mutableCtx.config = await runStyleSelect(mutableCtx.config, out, readLine, autoMode, inkReadKey);
  } else if (key === 'c') {
    mutableCtx.config = await toggleMemory(mutableCtx.config, out);
  } else if (key === 'd') {
    mutableCtx.config = await toggleIntentEngine(mutableCtx.config, out);
  } else if (key === 'e') {
    mutableCtx.config = await runOversightSelect(mutableCtx.config, out, readLine, inkReadKey);
  } else if (key === 'f') {
    mutableCtx.config = await toggleColorTheme(mutableCtx.config, out);
  }
  // anything else → back
}

/**
 * Toggle the INTENT ENGINE master switch (intent-engine §4) and persist it.
 *
 * Default-on but GATED: when enabled, orchestrate runs ONE cheap, read-only,
 * short-timeout extractor pass ONLY on substantial/ambiguous turns; trivial turns
 * skip it (zero overhead). Toggling when on writes `intentEngine:false` (no
 * extractor wired — orchestrate uses the deterministic rules frame, and the
 * engagement policy still runs from {tier,risk}/route.plan); toggling when off
 * removes the flag (restores default-on). Preserves all other keys.
 */
async function toggleIntentEngine(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const currentlyEnabled = config.intentEngine !== false;
  const enable = !currentlyEnabled;
  // Persist only the explicit-OFF; absent means default-on. Spreading the full
  // prior config preserves every other key.
  const updated: AppConfig = withOptional(config, 'intentEngine', enable ? undefined : false);
  await saveConfig(updated);
  out.write(`Intent engine: ${enable ? 'on' : 'off'}\n`);
  return updated;
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
 * Toggle smart routing and persist it.
 *
 * When on (the DEFAULT), turns the keyword classifier can't route (no tier
 * keyword matched) are handed to a cheap model that picks the tier; clear keyword
 * turns still route instantly with no model call. It adds ~5-10s on those
 * ambiguous turns only (a worker-tier classification spawn), so it can be turned
 * off here. See core/router.ts + core/route-classifier.ts.
 */
async function toggleSmartRoute(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  // Default-on: enabled unless explicitly false (mirrors auto-update).
  const currentlyEnabled = config.smartRoute !== false;
  const enable = !currentlyEnabled;
  // Persist only the explicit-OFF; absent means default-on. Full-config spread
  // preserves every other key.
  const updated: AppConfig = withOptional(config, 'smartRoute', enable ? undefined : false);
  await saveConfig(updated);
  out.write(`Smart routing: ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the auto-update preference and persist the updated config.
 * Reports the new state so the user knows what changed.
 *
 * Since auto-update now defaults to ON (undefined → enabled), toggling when
 * currently enabled (true or undefined) sets it explicitly to false; toggling
 * when currently disabled (false) removes the explicit flag (restores default-on).
 */
async function toggleAutoUpdate(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  // Currently enabled when autoUpdate !== false (undefined counts as on)
  const currentlyEnabled = config.autoUpdate !== false;
  const enable = !currentlyEnabled;
  // Persist only the explicit-OFF; absent means default-on. Full-config spread
  // preserves every other key.
  const updated: AppConfig = withOptional(config, 'autoUpdate', enable ? undefined : false);
  await saveConfig(updated);
  out.write(`Update on launch: ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL native-session preference and persist it.
 *
 * When on, conversations that stay on the same provider reuse that provider's
 * native session (Claude `--session-id`/`--resume`) instead of replaying a
 * compacted history block — better context fidelity and less re-sent context.
 * Default OFF; live behavior should be verified with the gated integration test
 * (`npm run test:integration`) before relying on it.
 */
async function toggleNativeSessions(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.nativeSessions !== true;
  // Default-off: persist only the explicit-ON; absent means off. Full-config
  // spread preserves every other key.
  const updated: AppConfig = withOptional(config, 'nativeSessions', enable ? true : undefined);
  await saveConfig(updated);
  out.write(`Native sessions (experimental): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL Parallel Subscription Panel and persist it.
 *
 * When on, high/critical-risk turns run as a CONCURRENT panel of your signed-in
 * providers, then a cross-vendor synthesizer reconciles their answers into one.
 * Flat-rate makes the extra concurrent runs free in dollars — the cost is quota
 * + latency. Needs ≥2 signed-in providers to do anything. Default OFF.
 */
async function togglePanel(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.panel !== true;
  // Default-off: persist only the explicit-ON. Full-config spread preserves
  // every other key.
  const updated: AppConfig = withOptional(config, 'panel', enable ? true : undefined);
  await saveConfig(updated);
  out.write(`Panel (experimental): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL Latency-Hedged Escalation and persist it.
 *
 * When on, high/critical-risk turns hedge against latency: if the cheap primary
 * attempt is slow, a flagship attempt is started IN PARALLEL and whichever
 * finishes first with adequate confidence wins (the slower branch is cancelled).
 * Flat-rate makes the cancelled branch free in dollars — it spends quota to buy
 * wall-clock. Needs ≥1 signed-in provider. Default OFF.
 */
async function toggleHedge(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.hedge !== true;
  // Default-off: persist only the explicit-ON. Full-config spread preserves
  // every other key.
  const updated: AppConfig = withOptional(config, 'hedge', enable ? true : undefined);
  await saveConfig(updated);
  out.write(`Hedged escalation (experimental): ${enable ? 'on' : 'off'}\n`);
  return updated;
}

/**
 * Toggle the EXPERIMENTAL Local Outcome Learner and persist it.
 *
 * When on, routing learns from YOUR ledger which provider finishes your work
 * best per tier (observed success rate, tie-broken by latency) and prefers it.
 * Observed-only; needs real history before it changes anything. Default OFF.
 */
async function toggleLearnRouting(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.learnRouting !== true;
  // Default-off: persist only the explicit-ON. Full-config spread preserves
  // every other key.
  const updated: AppConfig = withOptional(config, 'learnRouting', enable ? true : undefined);
  await saveConfig(updated);
  out.write(`Learned routing (experimental): ${enable ? 'on' : 'off'}\n`);
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

/**
 * Toggle opt-in auto-goal and persist it.
 *
 * When on, quality-first mode may automatically enter the existing /goal loop
 * for conservatively detected multi-step work. Other modes ignore it. Default
 * OFF; absent/false means unchanged single-turn dispatch.
 */
async function toggleAutoGoal(config: AppConfig, out: OutputSink): Promise<AppConfig> {
  const enable = config.autoGoal !== true;
  // Default-off: persist only the explicit-ON. Full-config spread preserves
  // every other key.
  const updated: AppConfig = withOptional(config, 'autoGoal', enable ? true : undefined);
  await saveConfig(updated);
  out.write(`Auto-goal (quality-first): ${enable ? 'on' : 'off'}\n`);
  return updated;
}
