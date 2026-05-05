/**
 * viewer-bridge — resolve display mode and (optionally) open the viewer.
 *
 * Pulled out of the Session constructor so the Session itself stays focused
 * on PTY/lifecycle. Logic:
 *
 *   1. Resolve display mode: "auto" → headless or open-terminal based on env
 *   2. Resolve historyLogPath: caller-explicit always wins; if display=
 *      open-terminal and no caller path, mkdtemp one
 *   3. If display=open-terminal, attempt to spawn the viewer
 *      - viewer failure does NOT fail session creation (warn + continue)
 */

import * as os from "node:os";
import * as path from "node:path";
import { logger } from "../../utils/logger.js";
import { openLiveViewer, type ViewerHandle } from "../viewer.js";
import type { DisplayMode, ResolvedDisplayMode } from "../types.js";

export interface ViewerBridgeInput {
  command: string;            // for default title / log filename
  pid?: number;               // optional, if known at this time
  display: DisplayMode | undefined;     // caller-requested
  historyLogPath: string | undefined;   // caller-explicit path
  viewerWindowTitle: string | undefined;
}

export interface ViewerBridgeOutput {
  display: ResolvedDisplayMode;
  /** Final history log path. Null when display=headless and caller didn't set one. */
  historyLogPath: string | null;
  viewerWindowTitle: string;
  /** Null when display=headless or viewer launch failed. */
  viewer: ViewerHandle | null;
}

/**
 * Resolve display mode, history log path, and (if applicable) launch viewer.
 *
 * Note: if caller passes `historyLogPath` but display=headless, we still
 * mirror to disk (caller-explicit always wins over display mode for log
 * path — the user explicitly asked for disk artifact).
 */
export function setupDisplay(input: ViewerBridgeInput): ViewerBridgeOutput {
  const display = resolveDisplay(input.display);

  // historyLogPath: caller-explicit wins; auto-create only if needed for viewer.
  let historyLogPath: string | null = input.historyLogPath ?? null;
  let viewer: ViewerHandle | null = null;

  if (display === "open-terminal") {
    if (!historyLogPath) historyLogPath = defaultHistoryLogPath(input.command);
    const title = input.viewerWindowTitle ?? defaultTitle(input.command, input.pid);
    viewer = openLiveViewer({ logPath: historyLogPath, title });
    if (!viewer) {
      // Viewer can't open (no DISPLAY / unsupported platform). The log file
      // is still useful — caller can `tail -f` it manually. Continue headless.
      logger.warn("viewer.unavailable_continuing_headless", { logPath: historyLogPath });
    }
  }

  return {
    display,
    historyLogPath,
    viewerWindowTitle: input.viewerWindowTitle ?? defaultTitle(input.command, input.pid),
    viewer,
  };
}

/** Map "auto" → headless or open-terminal based on env signals. */
export function resolveDisplay(req: DisplayMode | undefined): ResolvedDisplayMode {
  if (req === "headless" || req === undefined) return "headless";
  if (req === "open-terminal") return "open-terminal";
  // "auto":
  if (process.env.CI === "true") return "headless";
  if (process.env.GITHUB_ACTIONS) return "headless";
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT) return "headless";
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return "headless";
  return "open-terminal";
}

function defaultHistoryLogPath(command: string): string {
  const base = `ttm-${path.basename(command)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
  return path.join(os.tmpdir(), base);
}

function defaultTitle(command: string, pid: number | undefined): string {
  const base = path.basename(command);
  return pid ? `ttm: ${base} pid=${pid}` : `ttm: ${base}`;
}
