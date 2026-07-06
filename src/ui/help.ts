/**
 * src/ui/help.ts — per-command help text.
 *
 * The global `myshell-tools --help` lists all commands; this module provides
 * the focused, command-specific help shown for `myshell-tools <command> --help`
 * (e.g. `login --help` explains the sign-in methods instead of dumping the
 * generic command list).
 *
 * Pure string building — no I/O, trivially unit-testable.
 */

/**
 * Return focused help text for a known subcommand, or null when the command has
 * no dedicated help (callers fall back to the global help).
 *
 * @param command - The first CLI argument (e.g. "login", "cost").
 */
export function commandHelpText(command: string): string | null {
  switch (command) {
    case 'login':
      return [
        'myshell-tools login [provider] [--code | --browser]',
        '',
        'Sign in to a provider via its own OAuth. myshell-tools never handles',
        'your credentials — it drives each CLI\'s native sign-in.',
        '',
        'Arguments:',
        '  provider     claude | codex | opencode (omit to be prompted)',
        '',
        'Options:',
        '  --code       No-localhost flow — paste a code (claude) or use a device',
        '               code (codex). Best inside containers / over SSH.',
        '  --browser    Force the localhost browser flow (desktop).',
        '  (omitted)    Auto-detect: headless/SSH/cloud-IDE → code, desktop → browser.',
        '',
        'Examples:',
        '  myshell-tools login                 # prompt for provider, auto-detect method',
        '  myshell-tools login claude --code   # paste the code claude shows after you authorize',
        '  myshell-tools login codex --code    # device-code flow (no localhost)',
      ].join('\n') + '\n';

    case 'cost':
      return [
        'myshell-tools cost',
        '',
        'Show usage and routing efficiency from the local ledger.',
        '',
        'Leads with REAL, measured tokens (overall and per model) and a',
        'billing-agnostic routing-efficiency ratio (how many flagship tokens you',
        'avoided). Because this drives your SUBSCRIPTION CLIs — not metered API',
        'keys — any dollar figure is shown only as a clearly-labeled',
        'API-equivalent estimate, not your actual bill.',
      ].join('\n') + '\n';

    case 'run':
      return [
        'myshell-tools run <task...>',
        '',
        'Run a one-shot task and exit (non-interactive).',
        '',
        'The task is classified, routed to the cheapest capable tier, executed on',
        'your real working directory, and optionally reviewed by a different vendor.',
        '',
        'Example:',
        '  myshell-tools run "refactor the auth module and add tests"',
      ].join('\n') + '\n';

    case 'rollback':
      return [
        'myshell-tools rollback [off]',
        '',
        'Feature rollback only: disable verify, judgment, and trust.',
        'Governor, taste, and tribunal are not changed.',
        '',
        'Commands:',
        '  myshell-tools rollback       Persistently engage rollback.',
        '  myshell-tools rollback off   Remove the persisted override and restore defaults.',
        '',
        'MYSHELL_ROLLBACK=1 is the emergency no-write form and takes precedence.',
        'This does not revert files or undo workspace changes.',
      ].join('\n') + '\n';

    case 'status':
    case 'check':
    case 'doctor':
      // Slice 3: doctor kept for support/CI only (no user-facing menu/home advertising); self-heal in control panel (menu-build-spec-final.md:23,301,320-334 "Delete user-facing Doctor/Health" "Keep hidden `doctor/status/check`"; kern-spec.md)
      return [
        `myshell-tools ${command}`,
        '',
        'Print a full environment health report: platform, Node version, state-',
        'directory writability, pricing freshness, and per-provider install/auth.',
        '',
        'You normally never need this — the control panel surfaces any problem on',
        'its own. It exists for support threads and CI. (`status` and `check` are aliases.)',
        '',
        'Options:',
        '  --fix        Interactively install missing providers, sign in, and',
        '               refresh an expiring Claude token.',
      ].join('\n') + '\n';

    case 'install':
      return [
        'myshell-tools install',
        '',
        'Write a guarded startup hook to your shell rc file so new interactive',
        'shells launch myshell-tools automatically. Reports exactly what it wrote',
        'and how to reverse it. Use `myshell-tools uninstall` to remove it.',
      ].join('\n') + '\n';

    case 'uninstall':
      return [
        'myshell-tools uninstall',
        '',
        'Remove the guarded startup hook written by `myshell-tools install`.',
      ].join('\n') + '\n';

    case 'repl':
      return [
        'myshell-tools repl',
        '',
        'Start a plain line-based REPL (no control-panel menu). Each line you type',
        'is run as a task. Useful for scripting or minimal terminals.',
      ].join('\n') + '\n';

    default:
      return null;
  }
}
