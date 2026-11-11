// ---------------------------------------------------------------------------
// terminal.ts — "Open terminal interface" on every desktop platform.
//
// A PURE list of spawn attempts (file, args, cwd?) that index.ts walks in
// order: the first terminal that actually SPAWNS wins, an 'error' event
// (binary not installed) falls through to the next attempt, and if every
// attempt fails the user gets one actionable message instead of a silent
// no-op.
//   win32  : Windows Terminal (system theme, maximized) → plain cmd.exe /k
//   darwin : Terminal.app via osascript (runs node inside the new window)
//   linux  : x-terminal-emulator → gnome-terminal → konsole →
//            xfce4-terminal → xterm
// Paths are joined with the TARGET platform's separator so the plan is
// deterministic no matter where it is inspected (batch37 unit-tests every
// platform from Windows). Pure → no Electron import → bundle-testable.
// ---------------------------------------------------------------------------

/** One spawn attempt against a terminal emulator. */
export interface TerminalAttempt {
  file: string
  args: string[]
  cwd?: string
}

/** What runs INSIDE the terminal. */
export interface TerminalCommand {
  file: string
  args: string[]
}

/** AppleScript string-literal escaping (the command runs inside `do script`). */
function applescriptQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** POSIX shell quoting (for the linux/mac command line). */
function shellQuote(s: string): string {
  return /[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s
}

/**
 * The ordered terminal attempts for `platform`, rooted at `root`.
 *
 * `cmd` is what runs inside the terminal. It defaults to the sibling CLI
 * (`node <root>/../codezy-cli/codezy.mjs`) — what a dev checkout has. The
 * INSTALLED app passes the CLI bundled in resources/cli, then a global
 * install, then `npx -y -p codezy-cli codezy`.
 */
export function terminalPlan(
  platform: string,
  root: string,
  cmd?: TerminalCommand
): TerminalAttempt[] {
  const sep = platform === 'win32' ? '\\' : '/'
  const join = (...parts: string[]): string => parts.join(sep)
  // 3.2.0: index.mjs is the unified REPL (nanospinner chrome). Older bundles
  // only shipped codezy.mjs; the resolver in index.ts still falls back to it.
  const cliAbs = join(root, '..', 'codezy-cli', 'index.mjs')
  const cliRel = join('..', 'codezy-cli', 'index.mjs')

  // what runs: the bundled CLI unless the caller says otherwise
  const run = cmd ?? { file: 'node', args: [cliAbs] }
  // wt does its own cd (-d root), so it wants a path relative to root —
  // which only the bundled CLI has.
  const runRel = cmd ? run : { file: 'node', args: [cliRel] }

  if (platform === 'win32') {
    return [
      // Windows Terminal first: it inherits the system theme (acrylic, colors)
      // the same way opencode opens. `-M` = maximized (fills the screen, the
      // taskbar stays). Relative cli + `-d root` because wt does its own cd.
      {
        file: 'wt.exe',
        args: ['-M', '-w', 'new', '--title', 'CODEZY', '-d', root, 'cmd', '/k', runRel.file, ...runRel.args]
      },
      // plain console window: /k keeps it open so output never flashes by
      { file: 'cmd.exe', args: ['/k', run.file, ...run.args], cwd: root }
    ]
  }

  if (platform === 'darwin') {
    const command = cmd
      ? `${run.file} ${run.args.map(shellQuote).join(' ')}`
      : `node "${applescriptQuote(cliAbs)}"`
    const script = `cd "${applescriptQuote(root)}" && ${command}`
    return [
      {
        file: 'osascript',
        args: ['-e', `tell application "Terminal"\n  do script "${applescriptQuote(script)}"\n  activate\nend tell`]
      },
      // last resort: at least a shell sitting in the project folder
      { file: 'open', args: ['-a', 'Terminal', root] }
    ]
  }

  // linux + the rest of unix: the Debian generic first (it is a symlink to
  // whatever terminal is installed), then the common emulators by name.
  // argv arrays — spaces in the project path need no quoting anywhere.
  const emulators: [string, string[]][] = [
    ['x-terminal-emulator', ['-e']],
    ['gnome-terminal', ['--']],
    ['konsole', ['-e']],
    ['xfce4-terminal', ['-x']],
    ['xterm', ['-e']]
  ]
  return emulators.map(([file, pre]) => ({ file, args: [...pre, run.file, ...run.args], cwd: root }))
}
