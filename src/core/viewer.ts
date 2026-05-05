/**
 * viewer — open a real Terminal window that mirrors a session's PTY output.
 *
 * Mechanism: session writes raw PTY bytes to <log-path> as they arrive.
 * Viewer is a detached subprocess that runs `cat <log>; tail -f <log>` in a
 * real GUI terminal emulator. The user's actual terminal renders the ANSI
 * stream and they see exactly what the headless PTY is rendering.
 *
 * Why a file (not fifo / pipe / pty pair):
 *   - Cross-platform (Windows has no fifo)
 *   - Survives session close — user can scroll back / re-open
 *   - Late-attach safe: viewer can start after session began,
 *     `cat <log>; tail -f` replays from beginning
 *
 * Round 10 fix(es) baked in:
 *   - macOS: use AppleScript `set custom title of newTab` instead of printf
 *     OSC sequence — AppleScript strings only support `\"` and `\\` escapes,
 *     `\033` etc are syntax errors (-2741).
 *   - stderr is piped + observed, NOT "ignore" — silent osascript failures
 *     are how round 9 missed this for so long.
 *
 * V1 platform support: macOS via osascript+Terminal.app (primary). Linux
 * (gnome-terminal/konsole/xterm fallback chain) and Windows (wt.exe +
 * PowerShell `Get-Content -Wait`) are best-effort — failure returns null
 * and the caller continues headless.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../utils/logger.js";

export interface ViewerHandle {
  pid: number | null;
  logPath: string;
  /** Manually close the viewer window (best-effort, user usually closes themselves). */
  kill(): void;
}

export interface OpenViewerOptions {
  logPath: string;
  /** Title shown in the viewer window. */
  title?: string;
  /** Override platform detection (mostly for testing). */
  platform?: NodeJS.Platform;
}

/**
 * Open a viewer window. Returns null on platforms / environments where
 * unsupported — the caller's session continues headless. Failures NEVER
 * throw (viewer is opt-in eye-candy; session correctness mustn't depend
 * on it).
 */
export function openLiveViewer(opts: OpenViewerOptions): ViewerHandle | null {
  const platform = opts.platform ?? process.platform;
  const title = opts.title ?? path.basename(opts.logPath);

  // Make sure the log file exists so `tail -f` doesn't error before the
  // session writes its first byte.
  ensureFile(opts.logPath);

  switch (platform) {
    case "darwin": return openOnMacOS(opts.logPath, title);
    case "linux":  return openOnLinux(opts.logPath, title);
    case "win32":  return openOnWindows(opts.logPath, title);
    default:
      logger.warn("viewer.unsupported_platform", { platform, fallback: "headless" });
      return null;
  }
}

function ensureFile(p: string): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, "");
  } catch (err) {
    logger.warn("viewer.create_log_failed", { path: p, error: (err as Error).message });
  }
}

function openOnMacOS(logPath: string, title: string): ViewerHandle | null {
  // Round 10 fix: use AppleScript native `set custom title of newTab`
  // instead of `printf '\033]0;...\007'` OSC sequence. AppleScript string
  // literals only support `\"` and `\\` — `\033` is a syntax error.
  const escapedPath = logPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = [
    `tell application "Terminal"`,
    `  activate`,
    `  set newTab to do script "cat \\"${escapedPath}\\"; tail -f \\"${escapedPath}\\""`,
    `  set custom title of newTab to "${escapedTitle}"`,
    `end tell`,
  ].join("\n");

  try {
    // Round 10 fix: stderr piped + observed (was "ignore", which silently
    // swallowed all osascript failures).
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    let stderrBuf = "";
    if (child.stderr) child.stderr.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
    child.on("exit", (code: number | null) => {
      if (code !== 0 && stderrBuf.trim()) {
        logger.warn("viewer.osascript_nonzero", { code, stderr: stderrBuf.trim() });
      }
    });
    child.unref();
    return {
      pid: child.pid ?? null,
      logPath,
      kill: () => { try { child.kill(); } catch { /* ignore */ } },
    };
  } catch (err) {
    logger.warn("viewer.osascript_spawn_failed", { error: (err as Error).message });
    return null;
  }
}

function openOnLinux(logPath: string, _title: string): ViewerHandle | null {
  // Best-effort fallback chain: gnome-terminal → konsole → xterm.
  // Linux GUI Terminal landscape is too fragmented to commit to one.
  const candidates: Array<[string, string[]]> = [
    ["gnome-terminal", ["--", "bash", "-lc", `cat "${logPath}"; tail -f "${logPath}"`]],
    ["konsole",        ["-e", "bash", "-lc", `cat "${logPath}"; tail -f "${logPath}"`]],
    ["xterm",          ["-e", `bash -lc 'cat "${logPath}"; tail -f "${logPath}"'`]],
  ];
  for (const [cmd, args] of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.unref();
      return { pid: child.pid ?? null, logPath, kill: () => { try { child.kill(); } catch { /* ignore */ } } };
    } catch { /* try next */ }
  }
  logger.warn("viewer.linux_no_emulator", {
    tried: ["gnome-terminal", "konsole", "xterm"],
    fallback: "headless",
  });
  return null;
}

function openOnWindows(logPath: string, title: string): ViewerHandle | null {
  // Windows Terminal (wt.exe) running PowerShell `Get-Content -Wait`.
  // M0.5 维度 "viewer fallback" 还没实测过这条路径,标 best-effort。
  const psCmd = `$Host.UI.RawUI.WindowTitle='${title}'; Get-Content -LiteralPath '${logPath}' -Wait`;
  try {
    const child = spawn("wt.exe", ["powershell", "-NoLogo", "-Command", psCmd], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return { pid: child.pid ?? null, logPath, kill: () => { try { child.kill(); } catch { /* ignore */ } } };
  } catch (err) {
    logger.warn("viewer.windows_terminal_failed", { error: (err as Error).message });
    return null;
  }
}
