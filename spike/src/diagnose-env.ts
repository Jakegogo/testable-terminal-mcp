/**
 * diagnose-env — verify that $SHELL -ilc loads ~/.zshrc / ~/.zprofile.
 *
 * Spawns the user's login shell and runs a small probe script, prints the
 * result to stdout. Compare these values to what `claude` / `kimi` see when
 * spawned via the same wrapper in spike.ts / ask-claude.ts.
 *
 * Why a dedicated script: stuffing complex shell expressions through npm
 * JSON quoting is fragile. A standalone TS file with the script as a
 * template literal sidesteps all of that.
 *
 * Why not via the PTY/headless path: this script verifies a shell-level
 * fact (env after rc-files are sourced). Using stdio.inherit gives clean,
 * raw output. The PTY path is verified separately by running the real
 * spike:claude / spike:kimi commands.
 */

import { spawn } from "node:child_process";

const shell = process.env.SHELL || "/bin/zsh";

// Probe deliberately uses portable POSIX syntax (no zsh-specific tricks)
// so the same string works under either zsh or bash login shells.
const probe = [
  'echo "==== shell ===="',
  'echo "SHELL_BIN=$0"',
  'echo "SHELL_VAR=$SHELL"',
  'echo "HOME=$HOME"',
  'echo "USER=$USER"',
  'echo "PWD=$PWD"',
  '[ -n "$ZSH_VERSION"  ] && echo "ZSH_VERSION=$ZSH_VERSION"',
  '[ -n "$BASH_VERSION" ] && echo "BASH_VERSION=$BASH_VERSION"',
  'echo "ZDOTDIR=${ZDOTDIR:-<unset>}"',
  '',
  'echo',
  'echo "==== PATH (first 30 entries) ===="',
  'echo "$PATH" | tr ":" "\\n" | nl -ba | head -30',
  '',
  'echo',
  'echo "==== command resolution ===="',
  'for c in claude kimi node npm git brew aikey bash zsh fish; do',
  '  p="$(command -v "$c" 2>/dev/null || echo NONE)"',
  '  printf "  %-10s -> %s\\n" "$c" "$p"',
  'done',
  '',
  'echo',
  'echo "==== aliases (first 10) ===="',
  'alias 2>/dev/null | head -10 || echo "(no aliases / not interactive)"',
  '',
  'echo',
  'echo "==== rc-only env hints ===="',
  'for v in EDITOR PAGER LESS LANG LC_ALL LC_CTYPE GOPATH PYENV_ROOT NVM_DIR CARGO_HOME RUSTUP_HOME HOMEBREW_PREFIX; do',
  '  val="$(eval "echo \\${$v:-<unset>}")"',
  '  printf "  %-18s = %s\\n" "$v" "$val"',
  'done',
  '',
  'echo',
  'echo "__DIAGNOSE_DONE__"',
].join('\n');

process.stderr.write(`[diagnose-env] running: ${shell} -ilc <probe>\n`);
process.stderr.write(`[diagnose-env] this matches the wrapper used by spike.ts / ask-claude.ts when --login-shell is set.\n\n`);

const child = spawn(shell, ["-ilc", probe], {
  stdio: ["ignore", "inherit", "inherit"],
});

child.on("error", (err) => {
  process.stderr.write(`[diagnose-env] spawn error: ${err.message}\n`);
  process.exit(2);
});

child.on("exit", (code, signal) => {
  process.stderr.write(`\n[diagnose-env] shell exited code=${code} signal=${signal ?? "none"}\n`);
  process.exit(code ?? 0);
});
