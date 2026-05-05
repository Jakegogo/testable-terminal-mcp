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
 * V1: macOS only via osascript. Linux / Windows are stubbed and fall back to
 * a warning. Real implementations to be added when needed.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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

/** Returns null on platforms / environments where opening a viewer is unsupported. */
export function openLiveViewer(opts: OpenViewerOptions): ViewerHandle | null {
  const platform = opts.platform ?? process.platform;
  const title = opts.title ?? path.basename(opts.logPath);

  // Make sure the log file exists so `tail -f` doesn't error before the
  // session writes its first byte.
  ensureFile(opts.logPath);

  switch (platform) {
    case "darwin":  return openOnMacOS(opts.logPath, title);
    case "linux":   return openOnLinux(opts.logPath, title);
    case "win32":   return openOnWindows(opts.logPath, title);
    default:
      process.stderr.write(`[viewer] unsupported platform: ${platform}, falling back to headless\n`);
      return null;
  }
}

function ensureFile(p: string): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, "");
  } catch (err) {
    process.stderr.write(`[viewer] failed to create log file ${p}: ${(err as Error).message}\n`);
  }
}

function openOnMacOS(logPath: string, title: string): ViewerHandle | null {
  // AppleScript runs in Terminal.app:
  //   1. cat existing log (so user sees backstory)
  //   2. tail -f to follow new bytes
  //   3. set the tab's custom title via AppleScript (avoids fragile printf
  //      OSC backslash-escape across JS-template / AppleScript / bash layers)
  //
  // Why three layers of escape avoidance:
  //   - Inside AppleScript "..." strings, only `\"` and `\\` are valid escapes.
  //     Sequences like `\033` are syntax errors (-2741).
  //   - Inside bash command, we only need `"` quoting around the path.
  //
  // We capture stderr (not "ignore") so failures surface to the host stderr.
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
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    let stderrBuf = "";
    if (child.stderr) child.stderr.on("data", (d: Buffer) => { stderrBuf += d.toString(); });
    child.on("exit", (code: number | null) => {
      if (code !== 0 && stderrBuf.trim()) {
        process.stderr.write(`[viewer] osascript exit=${code}: ${stderrBuf.trim()}\n`);
      }
    });
    child.unref();
    return {
      pid: child.pid ?? null,
      logPath,
      kill: () => { try { child.kill(); } catch { /* ignore */ } },
    };
  } catch (err) {
    process.stderr.write(`[viewer] osascript spawn failed: ${(err as Error).message}\n`);
    return null;
  }
}

function openOnLinux(logPath: string, _title: string): ViewerHandle | null {
  // V1 stub: try gnome-terminal / konsole / xterm in order. Document as
  // "best-effort" — Linux Terminal emulator landscape is too fragmented
  // for a robust default in the spike phase.
  const candidates: Array<[string, string[]]> = [
    ["gnome-terminal", ["--", "bash", "-lc", `cat "${logPath}"; tail -f "${logPath}"`]],
    ["konsole", ["-e", "bash", "-lc", `cat "${logPath}"; tail -f "${logPath}"`]],
    ["xterm", ["-e", `bash -lc 'cat "${logPath}"; tail -f "${logPath}"'`]],
  ];
  for (const [cmd, args] of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.unref();
      return { pid: child.pid ?? null, logPath, kill: () => { try { child.kill(); } catch { /* ignore */ } } };
    } catch { /* try next */ }
  }
  process.stderr.write(`[viewer] no supported Linux terminal emulator found (tried gnome-terminal/konsole/xterm)\n`);
  return null;
}

function openOnWindows(logPath: string, title: string): ViewerHandle | null {
  // V1: use Windows Terminal (`wt.exe`) running PowerShell `Get-Content -Wait`.
  // PowerShell tail equivalent: Get-Content path -Wait -Tail 0
  const psCmd = `$Host.UI.RawUI.WindowTitle='${title}'; Get-Content -LiteralPath '${logPath}' -Wait`;
  try {
    const child = spawn("wt.exe", ["powershell", "-NoLogo", "-Command", psCmd], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return { pid: child.pid ?? null, logPath, kill: () => { try { child.kill(); } catch { /* ignore */ } } };
  } catch (err) {
    process.stderr.write(`[viewer] Windows Terminal launch failed: ${(err as Error).message}\n`);
    return null;
  }
}
