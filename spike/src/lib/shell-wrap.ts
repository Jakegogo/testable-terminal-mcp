/**
 * shell-wrap — wrap a command so it runs under the user's login+interactive
 * shell, sourcing ~/.zprofile + ~/.zshrc (or bash equivalents).
 *
 * Why: when running a TUI agent through node-pty, by default the child
 * process inherits npm's environment, NOT the user's shell-customized
 * environment. That means PATH extensions, aliases, and rc-only env vars
 * are missing. To simulate a real macOS user running `claude` in Terminal.app,
 * we wrap the command in `$SHELL -ilc 'exec <command> <args>'`.
 *
 * `exec` matters: without it, the inner command runs as a child of the
 * wrapper shell, which means the PTY's foreground process is the shell.
 * With exec, the shell process is replaced by the inner command. Killing
 * the PTY leader cleanly kills the agent.
 */

import * as path from "node:path";

const SHELL_BASENAMES = new Set(["zsh", "bash", "sh", "fish", "ksh", "dash"]);

export interface ShellWrapOptions {
  command: string;
  args: string[];
  loginShell: boolean;
  shellPath?: string;
}

export interface ShellWrapResult {
  command: string;
  args: string[];
  description: string;
}

export function wrapWithLoginShell(opts: ShellWrapOptions): ShellWrapResult {
  if (!opts.loginShell) {
    return {
      command: opts.command,
      args: opts.args,
      description: `direct: ${opts.command} ${opts.args.join(" ")}`.trim(),
    };
  }

  const baseCmd = path.basename(opts.command);

  // If the user is already invoking a shell, prepend -il so the shell
  // itself sources rc files. Avoids the "shell calls shell" double process.
  // (zsh/bash both accept -i (interactive) + -l (login).)
  if (SHELL_BASENAMES.has(baseCmd)) {
    const flagged = ["-il", ...opts.args];
    return {
      command: opts.command,
      args: flagged,
      description: `shell-with-rc: ${opts.command} ${flagged.join(" ")}`,
    };
  }

  const shell = opts.shellPath || process.env.SHELL || "/bin/zsh";
  const inner = [opts.command, ...opts.args].map(shellQuote).join(" ");
  return {
    command: shell,
    args: ["-ilc", `exec ${inner}`],
    description: `wrapped: ${shell} -ilc 'exec ${inner}'`,
  };
}

/** Single-quote-escape a token for embedding in a shell -ilc command. */
function shellQuote(s: string): string {
  if (s === "") return "''";
  // Safe to leave unquoted: alphanumeric and a few common punctuation chars.
  if (/^[A-Za-z0-9_.\/:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
