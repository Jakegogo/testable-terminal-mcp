/**
 * shell-wrap — wrap a command so it runs under the user's login+interactive
 * shell, sourcing ~/.zprofile + ~/.zshrc / bash / pwsh profiles.
 *
 * Why: when running a TUI agent through node-pty, by default the child
 * inherits npm's environment, NOT the user's shell-customized env. That
 * means PATH extensions, aliases, and rc-only env vars are missing. To
 * simulate a real user running `claude` in Terminal.app, we wrap with
 * `$SHELL -ilc 'exec <cmd>'` (POSIX) or `pwsh -NoLogo -Command "..."`
 * (Windows).
 *
 * Why `exec`: without it, the inner command runs as a child of the wrapper
 * shell, so the PTY's foreground process is the shell. With exec, the shell
 * process is replaced by the inner command — killing the PTY cleanly kills
 * the agent (no stranded shell).
 *
 * Windows: per round 7 P0-3 decision, V1 supports pwsh 7+ only. ps5 / cmd
 * are V2. M0.5 is the gate that confirms pwsh wrap actually works on
 * windows-latest CI runner.
 */

import { isKnownShell, platform as defaultPlatform, type PlatformInfo } from "./platform.js";

export interface ShellWrapOptions {
  command: string;
  args: string[];
  loginShell: boolean;
  /** Override for shell binary path. Defaults to `$SHELL` on POSIX, `pwsh` on Windows. */
  shellPath?: string;
  /**
   * Files to `source` (POSIX) / dot-source (pwsh) before exec'ing the
   * inner command. Useful for tools whose env is set by an interactive
   * `precmd`/prompt hook that doesn't fire in `-ilc 'cmd'` runs (aikey's
   * `~/.aikey/active.env`, nvm/direnv state files, etc).
   *
   * Each path is sourced silently — missing or unreadable files are
   * skipped without failing. Tilde (`~`) is expanded against `$HOME`.
   * Only meaningful when `loginShell: true`.
   *
   * When you don't know the right path, prefer `simulatePrecmdHooks: true`
   * which triggers the shell's actual hook chain (zero config).
   */
  preSourceFiles?: ReadonlyArray<string>;
  /**
   * Manually invoke the shell's precmd / PROMPT_COMMAND hook chain before
   * exec. zsh's `precmd_functions` array (and bash's `PROMPT_COMMAND`)
   * normally only fire before each interactive prompt. In `-ilc 'cmd'`
   * mode the prompt cycle never happens, so hook-based tools (aikey,
   * nvm, direnv, pyenv, atuin, ...) miss their chance to inject env.
   *
   * Setting this to true triggers every registered hook function once
   * before exec, which is functionally equivalent to running the hooks
   * as if a prompt had just been drawn. Errors in individual hooks are
   * swallowed (don't fail the spawn).
   *
   * Auto-detects zsh vs bash by the shell binary's basename. Other shells
   * (fish, dash, ...) silently no-op.
   *
   * Only meaningful when `loginShell: true`. Cheap (~1ms) — safe to leave
   * on by default for tools-aware sessions.
   */
  simulatePrecmdHooks?: boolean;
  /** Override platform detection (test-only). */
  platform?: PlatformInfo;
}

export interface ShellWrapResult {
  command: string;
  args: string[];
  description: string;
}

/**
 * Wrap a command per platform conventions.
 *
 * Decision tree:
 *   loginShell=false           → direct spawn, no wrap
 *   command is a shell binary  → just add the right flags (-il / -NoLogo) — avoid shell-in-shell
 *   POSIX                      → `$SHELL -ilc 'exec <cmd>'`
 *   Windows                    → `pwsh -NoLogo -Command "& <cmd>"`
 */
export function wrapWithLoginShell(opts: ShellWrapOptions): ShellWrapResult {
  if (!opts.loginShell) {
    return {
      command: opts.command,
      args: opts.args,
      description: `direct: ${opts.command} ${opts.args.join(" ")}`.trim(),
    };
  }

  const platform = opts.platform ?? defaultPlatform;

  // Special-case: caller is invoking a shell directly. Don't wrap with
  // another shell — just attach the right flags so the inner shell sources
  // its own rc files.
  if (isKnownShell(opts.command)) {
    if (platform.isWindows) {
      // pwsh's `-Command` plus interactive options. We default to non-profile
      // off (i.e. profile loaded) since the whole point is rc-loading.
      const flagged = ["-NoLogo", ...opts.args];
      return {
        command: opts.command,
        args: flagged,
        description: `pwsh-with-profile: ${opts.command} ${flagged.join(" ")}`,
      };
    }
    const flagged = ["-il", ...opts.args];
    return {
      command: opts.command,
      args: flagged,
      description: `shell-with-rc: ${opts.command} ${flagged.join(" ")}`,
    };
  }

  if (platform.isWindows) {
    return wrapWindows(opts);
  }
  return wrapPosix(opts);
}

function wrapPosix(opts: ShellWrapOptions): ShellWrapResult {
  const shell = opts.shellPath || process.env.SHELL || "/bin/zsh";
  const inner = [opts.command, ...opts.args].map(shellQuotePosix).join(" ");
  const sourcePrefix = posixSourcePrefix(opts.preSourceFiles);
  const precmdPrefix = opts.simulatePrecmdHooks ? posixPrecmdTrigger(shell) : "";
  // Order matters: source files first (set up state), then trigger hooks
  // (they may read that state), then exec the real command.
  const cmd = `${sourcePrefix}${precmdPrefix}exec ${inner}`;
  return {
    command: shell,
    args: ["-ilc", cmd],
    description: `wrapped: ${shell} -ilc '${cmd}'`,
  };
}

function wrapWindows(opts: ShellWrapOptions): ShellWrapResult {
  const shell = opts.shellPath || "pwsh";
  // pwsh `& <command> <args...>` invokes via call operator, supports paths
  // with spaces, and respects $env updates done by profile.
  const inner = [opts.command, ...opts.args].map(shellQuotePwsh).join(" ");
  const sourcePrefix = pwshSourcePrefix(opts.preSourceFiles);
  // We wrap the whole inner expression in double quotes (pwsh's `-Command`
  // accepts a single string). Inside, we use `&` (call operator) so even
  // command paths with spaces work.
  const cmd = `${sourcePrefix}& ${inner}`;
  return {
    command: shell,
    args: ["-NoLogo", "-Command", cmd],
    description: `pwsh: ${shell} -NoLogo -Command '${cmd}'`,
  };
}

/**
 * Build a `. file 2>/dev/null; ` prefix for each file. Tilde-expanded.
 * Empty when no files. The `2>/dev/null` + `|| true` form is intentional —
 * we silently skip missing/unreadable sources rather than fail the spawn.
 */
function posixSourcePrefix(files?: ReadonlyArray<string>): string {
  if (!files || files.length === 0) return "";
  const parts: string[] = [];
  for (const raw of files) {
    const expanded = expandTilde(raw);
    const quoted = shellQuotePosix(expanded);
    parts.push(`[ -f ${quoted} ] && . ${quoted} 2>/dev/null`);
  }
  return parts.join("; ") + "; ";
}

function pwshSourcePrefix(files?: ReadonlyArray<string>): string {
  if (!files || files.length === 0) return "";
  const parts: string[] = [];
  for (const raw of files) {
    const expanded = expandTilde(raw);
    const quoted = shellQuotePwsh(expanded);
    // pwsh dot-source: `. <path>`. SilentlyContinue on missing.
    parts.push(`if (Test-Path ${quoted}) { . ${quoted} }`);
  }
  return parts.join("; ") + "; ";
}

/**
 * Build the precmd-trigger snippet for the given POSIX shell.
 *
 * zsh: iterate `precmd_functions` array, call each. zsh-specific syntax
 *      using `"${array[@]}"` for proper word-splitting.
 * bash: eval `$PROMPT_COMMAND` if set. Bash 5.1+ allows array form;
 *       `eval` works for both string and `${arr[*]}` joined string. We
 *       fall back to single-string semantics for portability with bash
 *       3.2 (still shipped on macOS).
 * other (sh, dash, fish, ...): no precmd concept → empty trigger.
 *
 * Errors are swallowed per-hook so a flaky hook doesn't kill the spawn.
 */
function posixPrecmdTrigger(shellPath: string): string {
  const base = (shellPath.split("/").pop() ?? "").toLowerCase();
  if (base === "zsh") {
    // The temp var name is intentionally unusual to avoid shadowing
    // anything the user's hooks themselves might use.
    return 'for __ttm_precmd_fn in "${precmd_functions[@]:-}"; do "$__ttm_precmd_fn" 2>/dev/null || true; done; unset __ttm_precmd_fn; ';
  }
  if (base === "bash") {
    return 'if [ -n "${PROMPT_COMMAND-}" ]; then eval "${PROMPT_COMMAND}" 2>/dev/null || true; fi; ';
  }
  return "";
}

/** Expand a leading `~` to `$HOME` (env, not /home/...). */
function expandTilde(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) return (process.env.HOME ?? "~") + p.slice(1);
  return p;
}

/** Single-quote-escape a token for POSIX `sh -c`. */
export function shellQuotePosix(s: string): string {
  if (s === "") return "''";
  // Safe to leave unquoted: alphanumeric and a few common punctuation chars.
  if (/^[A-Za-z0-9_.\/:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a token for pwsh -Command. PowerShell uses backtick (`) as escape
 * char inside double-quoted strings; single-quoted strings are literal.
 *
 * Strategy: prefer single-quoted (literal) form. If the token contains a
 * single quote, escape via doubled `''`.
 */
export function shellQuotePwsh(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_.\/:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `''`)}'`;
}
