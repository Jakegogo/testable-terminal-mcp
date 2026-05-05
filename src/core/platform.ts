/**
 * Platform detection / cross-platform constants.
 *
 * Single source of truth for "is this Windows / macOS / Linux" + "what's the
 * path separator / default shell". Keep platform branches confined to this
 * module + shell-wrap.ts + sandbox/env-injector.ts (the three places that
 * legitimately differ); other modules import from here, never inspect
 * `process.platform` directly.
 */

export type SupportedPlatform = "darwin" | "linux" | "win32";

export interface PlatformInfo {
  readonly os: SupportedPlatform;
  readonly arch: string;
  readonly isWindows: boolean;
  readonly isDarwin: boolean;
  readonly isLinux: boolean;
  readonly pathSep: ":" | ";";
  readonly fsSep: "/" | "\\";
  readonly lineEnding: "\n" | "\r\n";
}

/** Build a PlatformInfo from raw values. Pure — call with overrides for tests. */
export function inferPlatform(
  rawPlatform: NodeJS.Platform = process.platform,
  rawArch: string = process.arch,
): PlatformInfo {
  // Map any non-supported platform to a safe default so tests can probe via
  // explicit overrides, but fail fast if someone tries to actually use us on
  // an unsupported OS at runtime.
  let os: SupportedPlatform;
  switch (rawPlatform) {
    case "darwin": os = "darwin"; break;
    case "linux": os = "linux"; break;
    case "win32": os = "win32"; break;
    default:
      throw new Error(`unsupported platform: ${rawPlatform} (only darwin/linux/win32 supported in V1)`);
  }
  const isWindows = os === "win32";
  return {
    os,
    arch: rawArch,
    isWindows,
    isDarwin: os === "darwin",
    isLinux: os === "linux",
    pathSep: isWindows ? ";" : ":",
    fsSep: isWindows ? "\\" : "/",
    lineEnding: isWindows ? "\r\n" : "\n",
  };
}

/** Cached singleton based on actual process. Tests should call inferPlatform() with overrides instead. */
export const platform: PlatformInfo = inferPlatform();

/**
 * Default shell command name (not absolute path).
 *
 * On POSIX: respect `$SHELL`, fall back to `/bin/zsh` then `/bin/bash`.
 * On Windows: prefer pwsh 7+, fall back to powershell 5 (V2). cmd.exe is V2.
 *
 * `requested` lets a caller override, e.g. force "bash" for a test.
 */
export function defaultShell(
  requested?: string,
  envShell: string | undefined = process.env.SHELL,
  info: PlatformInfo = platform,
): string {
  if (requested) return requested;
  if (info.isWindows) {
    // pwsh is the default for V1. Detection of pwsh-vs-powershell binary
    // path lives in shell-wrap.ts at spawn time.
    return "pwsh";
  }
  if (envShell && envShell.length > 0) return envShell;
  // POSIX fallback chain.
  return "/bin/zsh";
}

/** True if `name` looks like a known shell (used by shell-wrap to decide -il vs -c). */
export function isKnownShell(commandPath: string): boolean {
  // Compare just the basename, lowercased — handles `/usr/local/bin/zsh`,
  // `pwsh.exe`, `C:\\Program Files\\PowerShell\\7\\pwsh.exe`.
  const base = (commandPath.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  return SHELL_BASENAMES.has(base);
}

const SHELL_BASENAMES = new Set([
  "bash", "zsh", "sh", "dash", "ksh", "fish",
  "pwsh", "powershell", "cmd",
]);
